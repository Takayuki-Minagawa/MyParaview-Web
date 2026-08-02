from __future__ import annotations

import threading
import uuid

import pytest
from sqlalchemy import select

from app import jobs as jobs_module
from app.db import SessionLocal, init_db
from app.jobs import (
    JobContext,
    JobManager,
    _claim_job,
    _cleanup_result,
    _publish_success,
    _run_job,
    fail_persisted_job,
    run_persisted_job,
    stable_job_object_key,
)
from app.models import Artifact, Dataset, Job, Project
from app.services import (
    _ArtifactSpec,
    _run_artifact_job,
    persist_job_artifact,
    rollback_job_artifact,
)
from app.storage import store


def _records(kind: str) -> tuple[str, str, str]:
    init_db()
    source_key = store.new_key(".vtp")
    store.save_bytes(source_key, b"source")
    with SessionLocal() as db:
        project = Project(name=f"idempotency-{kind}-{uuid.uuid4().hex[:8]}")
        db.add(project)
        db.flush()
        dataset = Dataset(
            project_id=project.id,
            filename="source.vtp",
            ext=".vtp",
            size_bytes=6,
            object_key=source_key,
            status="ready",
        )
        db.add(dataset)
        db.flush()
        job = Job(
            project_id=project.id,
            kind=kind,
            status="running",
            target_id=dataset.id,
            params={},
        )
        db.add(job)
        db.commit()
        return job.id, dataset.id, source_key


def _body(
    dataset_id: str,
    kind: str,
    produced_keys: list[str],
    *,
    extra: dict | None = None,
):
    def body(ctx: JobContext) -> dict:
        def plan(_source):
            spec = _ArtifactSpec(
                filename=f"source-{kind}.bin",
                output_ext=".bin",
                kind=f"{kind}_artifact",
                content_type="application/octet-stream",
            )

            def produce(_source_path, object_key: str):
                produced_keys.append(object_key)
                size = store.save_bytes(object_key, f"result-{kind}".encode())
                return size, dict(extra or {})

            return spec, produce

        return _run_artifact_job(
            ctx,
            dataset_id,
            start_log=f"{kind} start",
            needs_source_path=False,
            plan=plan,
        )

    return body


@pytest.mark.parametrize(
    "kind",
    ["filter", "convert", "render", "export", "stats", "movie", "pipeline"],
)
def test_rq_retry_reuses_artifact_checkpoint_for_every_artifact_job(kind: str):
    """A retry after artifact commit must not invoke any producer again."""
    job_id, dataset_id, _source_key = _records(kind)
    produced_keys: list[str] = []
    body = _body(
        dataset_id,
        kind,
        produced_keys,
        extra={"operation": kind, "frame_count": 3} if kind == "movie" else {},
    )

    # Calling only the body simulates a workhorse dying after its recovery
    # checkpoint commits but before _run_job publishes status=succeeded.
    staged = body(JobContext(job_id))
    with SessionLocal() as db:
        checkpointed = db.get(Job, job_id)
        artifacts = list(db.scalars(select(Artifact).where(Artifact.job_id == job_id)))
        assert checkpointed is not None
        assert checkpointed.status == "running"
        assert checkpointed.result == staged
        assert len(artifacts) == 1
        artifact_id = artifacts[0].id
        object_key = artifacts[0].object_key

    _run_job(job_id, body)

    with SessionLocal() as db:
        finished = db.get(Job, job_id)
        artifacts = list(db.scalars(select(Artifact).where(Artifact.job_id == job_id)))
        assert finished is not None
        assert finished.status == "succeeded"
        assert finished.result == staged
        assert [artifact.id for artifact in artifacts] == [artifact_id]
        assert artifacts[0].object_key == object_key
    assert produced_keys == [object_key]
    assert store.exists(object_key)


def test_retry_overwrites_same_object_after_crash_before_artifact_commit(monkeypatch):
    job_id, dataset_id, _source_key = _records("export")
    produced_keys: list[str] = []
    body = _body(dataset_id, "export", produced_keys)

    def hard_crash(*_args, **_kwargs):
        raise SystemExit("workhorse died before artifact commit")

    with monkeypatch.context() as crash:
        crash.setattr("app.services.persist_job_artifact", hard_crash)
        with pytest.raises(SystemExit, match="workhorse died"):
            body(JobContext(job_id))

    orphan_key = produced_keys[0]
    assert store.exists(orphan_key)
    with SessionLocal() as db:
        assert db.scalar(
            select(Artifact).where(Artifact.job_id == job_id)
        ) is None

    _run_job(job_id, body)

    with SessionLocal() as db:
        artifact = db.scalar(select(Artifact).where(Artifact.job_id == job_id))
        assert artifact is not None
        assert artifact.object_key == orphan_key
        assert db.get(Job, job_id).status == "succeeded"  # type: ignore[union-attr]
    assert produced_keys == [orphan_key, orphan_key]


def test_cancel_cleans_a_checkpoint_left_by_dead_workhorse():
    job_id, dataset_id, _source_key = _records("movie")
    produced_keys: list[str] = []
    staged = _body(
        dataset_id,
        "movie",
        produced_keys,
        extra={"frame_count": 4, "format": "mp4", "fps": 24},
    )(JobContext(job_id))
    object_key = produced_keys[0]
    assert staged["artifact_id"]

    assert JobManager._mark_canceled(job_id, db=None) is True

    with SessionLocal() as db:
        canceled = db.get(Job, job_id)
        assert canceled is not None
        assert canceled.status == "canceled"
        assert canceled.result is None
        assert db.scalar(select(Artifact).where(Artifact.job_id == job_id)) is None
    assert not store.exists(object_key)


def test_cancel_rollback_preserves_checkpoint_object():
    job_id, dataset_id, _source_key = _records("movie")
    produced_keys: list[str] = []
    staged = _body(dataset_id, "movie", produced_keys)(JobContext(job_id))
    object_key = produced_keys[0]

    with SessionLocal() as db:
        assert JobManager._mark_canceled(job_id, db=db) is True
        db.rollback()

    with SessionLocal() as db:
        restored = db.get(Job, job_id)
        artifact = db.get(Artifact, staged["artifact_id"])
        assert restored is not None
        assert restored.status == "running"
        assert restored.result == staged
        assert artifact is not None
        assert artifact.object_key == object_key
    assert store.exists(object_key)


def test_losing_duplicate_never_deletes_successful_artifact():
    job_id, dataset_id, _source_key = _records("movie")
    produced_keys: list[str] = []
    winner = _body(
        dataset_id,
        "movie",
        produced_keys,
        extra={"frame_count": 4},
    )(JobContext(job_id))
    assert _publish_success(job_id, winner) is True
    loser = {**winner, "frame_count": 5}

    _cleanup_result(loser, job_id=job_id)
    rollback_job_artifact(job_id, winner["artifact_id"], produced_keys[0])

    with SessionLocal() as db:
        succeeded = db.get(Job, job_id)
        artifact = db.get(Artifact, winner["artifact_id"])
        assert succeeded is not None
        assert succeeded.status == "succeeded"
        assert succeeded.result == winner
        assert artifact is not None
    assert store.exists(produced_keys[0])


def test_parallel_cleanup_and_success_never_publish_a_missing_artifact():
    job_id, dataset_id, _source_key = _records("movie")
    produced_keys: list[str] = []
    winner = _body(
        dataset_id,
        "movie",
        produced_keys,
        extra={"frame_count": 4},
    )(JobContext(job_id))
    loser = {**winner, "frame_count": 5}
    barrier = threading.Barrier(2)
    errors: list[BaseException] = []

    def publish():
        try:
            barrier.wait()
            assert _publish_success(job_id, winner) is True
        except BaseException as exc:  # noqa: BLE001 - surface thread failures
            errors.append(exc)

    def cleanup():
        try:
            barrier.wait()
            _cleanup_result(loser, job_id=job_id)
        except BaseException as exc:  # noqa: BLE001 - surface thread failures
            errors.append(exc)

    threads = [threading.Thread(target=publish), threading.Thread(target=cleanup)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(3)

    assert not errors
    assert all(not thread.is_alive() for thread in threads)
    with SessionLocal() as db:
        succeeded = db.get(Job, job_id)
        artifact = db.get(Artifact, winner["artifact_id"])
        assert succeeded is not None
        assert succeeded.status == "succeeded"
        assert succeeded.result == winner
        assert artifact is not None
    assert store.exists(produced_keys[0])


def test_parallel_claim_and_cancel_never_resurrect_canceled_job():
    job_id, _dataset_id, _source_key = _records("export")
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        assert job is not None
        job.status = "queued"
        db.commit()
    barrier = threading.Barrier(2)
    errors: list[BaseException] = []

    def claim():
        try:
            barrier.wait()
            _claim_job(job_id)
        except BaseException as exc:  # noqa: BLE001 - surface thread failures
            errors.append(exc)

    def cancel():
        try:
            barrier.wait()
            assert JobManager._mark_canceled(job_id, db=None) is True
        except BaseException as exc:  # noqa: BLE001 - surface thread failures
            errors.append(exc)

    threads = [threading.Thread(target=claim), threading.Thread(target=cancel)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(3)

    assert not errors
    assert all(not thread.is_alive() for thread in threads)
    with SessionLocal() as db:
        canceled = db.get(Job, job_id)
        assert canceled is not None
        assert canceled.status == "canceled"


def test_parallel_persisted_deliveries_execute_producer_once(monkeypatch):
    job_id, _dataset_id, _source_key = _records("export")
    producer_entered = threading.Event()
    duplicate_entered = threading.Event()
    release_producer = threading.Event()
    calls: list[str] = []
    calls_lock = threading.Lock()
    errors: list[BaseException] = []

    def controlled_producer(
        _ctx, _kind, _params, _source, _plan, object_key, _source_path
    ):
        with calls_lock:
            calls.append(object_key)
            if len(calls) == 1:
                producer_entered.set()
            else:
                duplicate_entered.set()
        assert release_producer.wait(3)
        return store.save_bytes(object_key, b"serialized-result")

    monkeypatch.setattr("app.services._produce_object", controlled_producer)

    def execute():
        try:
            run_persisted_job(job_id)
        except BaseException as exc:  # noqa: BLE001 - surface thread failures
            errors.append(exc)

    first = threading.Thread(target=execute)
    second = threading.Thread(target=execute)
    first.start()
    assert producer_entered.wait(2)
    second.start()
    try:
        assert not duplicate_entered.wait(0.2)
    finally:
        release_producer.set()
    first.join(3)
    second.join(3)

    assert not errors
    assert not first.is_alive() and not second.is_alive()
    assert len(calls) == 1
    with SessionLocal() as db:
        finished = db.get(Job, job_id)
        artifacts = list(db.scalars(select(Artifact).where(Artifact.job_id == job_id)))
        assert finished is not None
        assert finished.status == "succeeded"
        assert len(artifacts) == 1
        assert artifacts[0].object_key == calls[0]
        object_key = artifacts[0].object_key
    with store.open(object_key) as artifact_file:
        assert artifact_file.read() == b"serialized-result"


def test_postgres_advisory_lock_commits_before_body_and_after_unlock(monkeypatch):
    events: list[str] = []

    class Connection:
        in_transaction = False

        def __enter__(self):
            return self

        def __exit__(self, _exc_type, _exc_value, _traceback):
            return False

        def execute(self, statement, params):
            assert params == {"job_id": "job-1"}
            sql = str(statement)
            events.append("unlock" if "advisory_unlock" in sql else "lock")
            self.in_transaction = True

        def commit(self):
            assert self.in_transaction
            events.append("commit")
            self.in_transaction = False

        def rollback(self):
            events.append("rollback")
            self.in_transaction = False

        def invalidate(self):
            events.append("invalidate")

    connection = Connection()

    class Engine:
        dialect = type("Dialect", (), {"name": "postgresql"})()

        def connect(self):
            return connection

    monkeypatch.setattr(jobs_module, "engine", Engine())

    with jobs_module.job_execution_lock("job-1"):
        assert not connection.in_transaction
        events.append("body")

    assert events == ["lock", "commit", "body", "unlock", "commit"]


def test_terminal_failure_lock_excludes_late_checkpoint(monkeypatch):
    job_id, dataset_id, _source_key = _records("export")
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        assert job is not None and job.project_id is not None
        project_id = job.project_id
    object_key = stable_job_object_key(job_id, ".vtp")
    store.save_bytes(object_key, b"uncheckpointed")
    failure_holds_lock = threading.Event()
    release_failure = threading.Event()
    checkpoint_started = threading.Event()
    checkpoint_finished = threading.Event()
    errors: list[BaseException] = []

    real_delete = jobs_module._delete_job_artifacts

    def blocked_delete(session, job):
        failure_holds_lock.set()
        assert release_failure.wait(3)
        real_delete(session, job)

    monkeypatch.setattr(jobs_module, "_delete_job_artifacts", blocked_delete)

    def fail():
        try:
            assert fail_persisted_job(job_id, "ERROR: exhausted") is True
        except BaseException as exc:  # noqa: BLE001 - surface thread failures
            errors.append(exc)

    def checkpoint():
        checkpoint_started.set()
        try:
            persist_job_artifact(
                JobContext(job_id),
                project_id=project_id,
                dataset_id=dataset_id,
                kind="export",
                filename="source-export.vtp",
                size=14,
                object_key=object_key,
                content_type="application/octet-stream",
                extra_result={},
            )
        except RuntimeError as exc:
            assert "became failed" in str(exc)
        except BaseException as exc:  # noqa: BLE001 - surface thread failures
            errors.append(exc)
        finally:
            checkpoint_finished.set()

    failure_thread = threading.Thread(target=fail)
    checkpoint_thread = threading.Thread(target=checkpoint)
    failure_thread.start()
    assert failure_holds_lock.wait(2)
    checkpoint_thread.start()
    assert checkpoint_started.wait(2)
    try:
        assert not checkpoint_finished.wait(0.2)
    finally:
        release_failure.set()
    failure_thread.join(3)
    checkpoint_thread.join(3)

    assert not errors
    assert not failure_thread.is_alive() and not checkpoint_thread.is_alive()
    with SessionLocal() as db:
        failed = db.get(Job, job_id)
        assert failed is not None
        assert failed.status == "failed"
        assert failed.result is None
        assert db.scalar(select(Artifact).where(Artifact.job_id == job_id)) is None
    assert not store.exists(object_key)


def test_terminal_rq_failure_cleans_a_checkpoint_fail_closed():
    job_id, dataset_id, _source_key = _records("pipeline")
    produced_keys: list[str] = []
    _body(
        dataset_id,
        "pipeline",
        produced_keys,
        extra={"pipeline_id": "pipeline-1"},
    )(JobContext(job_id))
    object_key = produced_keys[0]

    assert fail_persisted_job(job_id, "ERROR: retries exhausted") is True

    with SessionLocal() as db:
        failed = db.get(Job, job_id)
        assert failed is not None
        assert failed.status == "failed"
        assert failed.result is None
        assert "retries exhausted" in failed.log
        assert db.scalar(select(Artifact).where(Artifact.job_id == job_id)) is None
    assert not store.exists(object_key)


def test_retry_fails_closed_when_existing_artifact_contract_differs():
    job_id, dataset_id, _source_key = _records("export")
    wrong_key = store.new_key(".bin")
    store.save_bytes(wrong_key, b"unrelated")
    with SessionLocal() as db:
        db.add(
            Artifact(
                dataset_id=dataset_id,
                job_id=job_id,
                kind="wrong_kind",
                filename="wrong.bin",
                size_bytes=9,
                object_key=wrong_key,
                content_type="application/octet-stream",
            )
        )
        db.commit()

    produced_keys: list[str] = []
    _run_job(job_id, _body(dataset_id, "export", produced_keys))

    with SessionLocal() as db:
        failed = db.get(Job, job_id)
        artifacts = list(db.scalars(select(Artifact).where(Artifact.job_id == job_id)))
        assert failed is not None
        assert failed.status == "failed"
        assert "does not match its output contract" in failed.log
        assert artifacts == []
    assert produced_keys == []
    assert not store.exists(wrong_key)
