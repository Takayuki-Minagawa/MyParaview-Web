from __future__ import annotations

import asyncio
import threading
from contextlib import contextmanager, suppress
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app import main as main_module
from app.db import SessionLocal, init_db
from app.jobs import drain_object_deletions, enqueue_object_deletion
from app.main import _drain_object_deletions_periodically
from app.models import Dataset, Job, ObjectDeletionOutbox, Project
from app.storage import store


def _pending(object_key: str) -> ObjectDeletionOutbox | None:
    with SessionLocal() as db:
        return db.scalar(
            select(ObjectDeletionOutbox).where(
                ObjectDeletionOutbox.object_key == object_key
            )
        )


def test_local_lease_defers_outbox_ack_until_release():
    init_db()
    object_key = store.new_key(".bin")
    store.save_bytes(object_key, b"leased")
    leased_path = store.acquire_path(object_key)
    try:
        with SessionLocal() as db:
            db.add(ObjectDeletionOutbox(object_key=object_key))
            db.commit()

        assert drain_object_deletions(object_keys={object_key}) == 0
        assert _pending(object_key) is not None
        assert leased_path.exists()
    finally:
        store.release_path(object_key)

    assert not leased_path.exists()
    assert _pending(object_key) is not None
    assert drain_object_deletions(object_keys={object_key}) == 1
    assert _pending(object_key) is None


def test_commit_hook_never_runs_object_store_io(monkeypatch):
    init_db()
    object_key = store.new_key(".bin")
    store.save_bytes(object_key, b"deferred")
    attempts: list[str] = []
    real_delete = store.delete

    def record_delete(key: str) -> bool:
        attempts.append(key)
        return True

    monkeypatch.setattr(store, "delete", record_delete)
    with SessionLocal() as db:
        enqueue_object_deletion(db, object_key)
        db.commit()

    assert attempts == []
    assert _pending(object_key) is not None
    monkeypatch.setattr(store, "delete", real_delete)
    assert drain_object_deletions(object_keys={object_key}) == 1


def test_job_execution_barrier_is_released_before_store_io(monkeypatch):
    init_db()
    object_key = store.new_key(".bin")
    store.save_bytes(object_key, b"terminal")
    with SessionLocal() as db:
        db.add(ObjectDeletionOutbox(object_key=object_key, job_id="missing-job"))
        db.commit()

    barrier_held = False
    real_delete = store.delete

    @contextmanager
    def barrier(job_id: str, *, blocking: bool):
        nonlocal barrier_held
        assert job_id == "missing-job"
        assert blocking is False
        barrier_held = True
        try:
            yield True
        finally:
            barrier_held = False

    def delete_after_barrier(key: str) -> bool:
        assert barrier_held is False
        return real_delete(key)

    monkeypatch.setattr("app.jobs.job_execution_lock", barrier)
    monkeypatch.setattr(store, "delete", delete_after_barrier)

    assert drain_object_deletions(object_keys={object_key}) == 1
    assert not store.exists(object_key)


def test_periodic_drain_retries_failure_without_restart(monkeypatch):
    init_db()
    object_key = store.new_key(".bin")
    store.save_bytes(object_key, b"retry")
    with SessionLocal() as db:
        db.add(ObjectDeletionOutbox(object_key=object_key))
        db.commit()

    real_delete = store.delete
    attempts = 0

    def flaky_delete(key: str) -> bool:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise OSError("temporary object-store outage")
        return real_delete(key)

    monkeypatch.setattr(store, "delete", flaky_delete)

    async def scenario() -> None:
        drainer = asyncio.create_task(
            _drain_object_deletions_periodically(
                interval_seconds=0.01,
                batch_size=1,
            )
        )
        try:
            for _ in range(100):
                if _pending(object_key) is None:
                    break
                await asyncio.sleep(0.01)
            else:
                raise AssertionError("periodic drainer did not retry the outbox row")
        finally:
            drainer.cancel()
            with suppress(asyncio.CancelledError):
                await drainer

    asyncio.run(scenario())
    assert attempts >= 2
    assert not store.exists(object_key)


def test_store_outage_stops_the_bounded_batch_after_one_timeout(monkeypatch):
    init_db()
    object_keys = [store.new_key(".bin") for _ in range(3)]
    for object_key in object_keys:
        store.save_bytes(object_key, b"pending")
    with SessionLocal() as db:
        db.add_all(
            ObjectDeletionOutbox(object_key=object_key)
            for object_key in object_keys
        )
        db.commit()

    attempts: list[str] = []
    real_delete = store.delete

    def unavailable(key: str) -> bool:
        attempts.append(key)
        raise TimeoutError("shared object store unavailable")

    monkeypatch.setattr(store, "delete", unavailable)

    assert drain_object_deletions(object_keys=set(object_keys), batch_size=3) == 0
    assert len(attempts) == 1
    assert all(_pending(object_key) is not None for object_key in object_keys)
    monkeypatch.setattr(store, "delete", real_delete)
    assert drain_object_deletions(object_keys=set(object_keys), batch_size=3) == 3


def test_periodic_drainer_cancels_without_waiting_for_blocked_delete(monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def blocked_drain(*, batch_size: int) -> int:
        assert batch_size == 1
        started.set()
        release.wait(3)
        return 0

    monkeypatch.setattr(main_module, "drain_object_deletions", blocked_drain)

    async def scenario() -> None:
        drainer = asyncio.create_task(
            main_module._drain_object_deletions_periodically(
                interval_seconds=0.001,
                batch_size=1,
            )
        )
        try:
            assert await asyncio.to_thread(started.wait, 1)
            drainer.cancel()
            with suppress(asyncio.CancelledError):
                await asyncio.wait_for(drainer, 0.1)
        finally:
            release.set()

    asyncio.run(scenario())


def test_bounded_drain_does_not_starve_behind_active_job():
    init_db()
    active_key = store.new_key(".bin")
    ready_key = store.new_key(".bin")
    store.save_bytes(active_key, b"active")
    store.save_bytes(ready_key, b"ready")
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        job = Job(kind="export", status="running", params={})
        db.add(job)
        db.flush()
        db.add_all(
            [
                ObjectDeletionOutbox(
                    object_key=active_key,
                    job_id=job.id,
                    created_at=now,
                ),
                ObjectDeletionOutbox(
                    object_key=ready_key,
                    created_at=now + timedelta(seconds=1),
                ),
            ]
        )
        db.commit()
        job_id = job.id

    assert drain_object_deletions(
        object_keys={active_key, ready_key},
        batch_size=1,
    ) == 1
    assert _pending(active_key) is not None
    assert _pending(ready_key) is None
    assert store.exists(active_key)
    assert not store.exists(ready_key)

    with SessionLocal() as db:
        job = db.get(Job, job_id)
        assert job is not None
        job.status = "failed"
        db.commit()
    assert drain_object_deletions(object_keys={active_key}) == 1


def test_failed_oldest_row_rotates_behind_later_work(monkeypatch):
    init_db()
    blocked_key = store.new_key(".bin")
    ready_key = store.new_key(".bin")
    store.save_bytes(blocked_key, b"blocked")
    store.save_bytes(ready_key, b"ready")
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        db.add_all(
            [
                ObjectDeletionOutbox(object_key=blocked_key, created_at=now),
                ObjectDeletionOutbox(
                    object_key=ready_key,
                    created_at=now + timedelta(microseconds=1),
                ),
            ]
        )
        db.commit()

    real_delete = store.delete

    def block_oldest(key: str) -> bool:
        return False if key == blocked_key else real_delete(key)

    monkeypatch.setattr(store, "delete", block_oldest)
    assert drain_object_deletions(batch_size=1) == 0
    assert drain_object_deletions(batch_size=1) == 1
    assert _pending(blocked_key) is not None
    assert _pending(ready_key) is None

    monkeypatch.setattr(store, "delete", real_delete)
    assert drain_object_deletions(object_keys={blocked_key}) == 1


def test_drain_rejects_nonpositive_explicit_batch_size():
    with pytest.raises(ValueError, match="batch size"):
        drain_object_deletions(batch_size=0)


def test_project_delete_outboxes_objects_for_retry(client, data_dir, monkeypatch):
    project_id = client.post("/projects", json={"name": "outbox-project"}).json()["id"]
    with open(data_dir / "sample_surface.vtp", "rb") as source:
        uploaded = client.post(
            f"/projects/{project_id}/datasets",
            files={"file": ("sample_surface.vtp", source, "application/octet-stream")},
    )
    assert uploaded.status_code == 201
    with SessionLocal() as db:
        dataset = db.get(Dataset, uploaded.json()["id"])
        assert dataset is not None
        object_key = dataset.object_key
    real_delete = store.delete

    def unavailable(_object_key: str) -> bool:
        raise OSError("object store unavailable")

    monkeypatch.setattr(store, "delete", unavailable)
    assert client.delete(f"/projects/{project_id}").status_code == 204
    with SessionLocal() as db:
        assert db.get(Project, project_id) is None
        pending = db.scalar(
            select(ObjectDeletionOutbox).where(
                ObjectDeletionOutbox.object_key == object_key
            )
        )
        assert pending is not None and pending.job_id is None
    assert store.exists(object_key)

    monkeypatch.setattr(store, "delete", real_delete)
    assert drain_object_deletions(object_keys={object_key}) == 1
    assert _pending(object_key) is None
    assert not store.exists(object_key)
