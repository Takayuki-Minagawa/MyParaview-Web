from __future__ import annotations

import os
import subprocess
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from rq.exceptions import DuplicateJobError
from sqlalchemy import select

from app import rq_worker
from app.config import Settings
from app.db import SessionLocal, init_db
from app.jobs import (
    JobContext,
    JobQueueUnavailable,
    RQJobManager,
    recover_interrupted_jobs,
)
from app.models import Job
from app.rq_worker import handle_terminal_failure
from conftest import wait_for_job


class _RecordingQueue:
    def __init__(self) -> None:
        self.calls: list[tuple[tuple, dict]] = []
        self.connection = object()

    def enqueue(self, *args, **kwargs):
        self.calls.append((args, kwargs))


def _job(*, kind: str = "export", status: str = "queued", target_id: str = "dataset") -> str:
    init_db()
    with SessionLocal() as db:
        job = Job(kind=kind, status=status, target_id=target_id, params={})
        db.add(job)
        db.commit()
        return job.id


def test_settings_validate_external_queue_contract(monkeypatch):
    monkeypatch.setenv("PVWEB_JOB_QUEUE_BACKEND", "rq")
    monkeypatch.setenv("PVWEB_REDIS_URL", "redis://queue.internal:6379/4")
    monkeypatch.setenv("PVWEB_JOB_QUEUE_NAME", "analysis")
    configured = Settings()
    assert configured.job_queue_backend == "rq"
    assert configured.redis_url == "redis://queue.internal:6379/4"
    assert configured.job_queue_name == "analysis"

    monkeypatch.setenv("PVWEB_JOB_QUEUE_BACKEND", "unknown")
    with pytest.raises(ValueError, match="PVWEB_JOB_QUEUE_BACKEND"):
        Settings()


def test_rq_submission_contains_only_stable_persisted_job_id():
    queue = _RecordingQueue()
    manager = RQJobManager(queue_provider=lambda: queue)
    job_id = _job()

    manager.submit(job_id, lambda _ctx: {"closure": "must-not-be-serialized"})

    assert len(queue.calls) == 1
    args, options = queue.calls[0]
    assert args == ("app.rq_worker.execute_job", job_id)
    assert options["job_id"] == f"pvweb-{job_id}"
    assert options["retry"].max == 3
    assert options["on_failure"].name == "app.rq_worker.handle_terminal_failure"
    assert options["unique"] is True
    assert "closure" not in repr(queue.calls)


def test_rq_worker_embeds_scheduler_for_delayed_retries(monkeypatch):
    calls: list[dict] = []

    class Connection:
        def ping(self):
            return True

    queue = SimpleNamespace(connection=Connection())

    class RecordingWorker:
        def __init__(self, queues, *, connection):
            assert queues == [queue]
            assert connection is queue.connection

        def work(self, **kwargs):
            calls.append(kwargs)

    monkeypatch.setattr(rq_worker, "settings", SimpleNamespace(
        job_queue_backend="rq",
        job_queue_name="analysis",
    ))
    monkeypatch.setattr(rq_worker, "init_db", lambda: None)
    monkeypatch.setattr(rq_worker.RQJobManager, "_default_queue", lambda: queue)
    monkeypatch.setattr(rq_worker.RQJobManager, "reconcile_queued_jobs", lambda self: 0)
    monkeypatch.setattr("rq.Worker", RecordingWorker)

    assert rq_worker.main(["--burst"]) == 0
    assert calls == [{"burst": True, "with_scheduler": True}]


def test_duplicate_rq_id_is_treated_as_already_submitted():
    job_id = _job()

    class DuplicateQueue:
        def enqueue(self, *_args, **_kwargs):
            raise DuplicateJobError("already queued")

    manager = RQJobManager(queue_provider=DuplicateQueue)
    manager.submit(job_id, lambda _ctx: {})
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        assert job is not None and job.status == "queued"


def test_rq_reconciles_queued_db_outbox_rows_but_not_running_jobs():
    queued_id = _job(status="queued")
    running_id = _job(status="running")
    queue = _RecordingQueue()
    manager = RQJobManager(queue_provider=lambda: queue)

    reconciled = manager.reconcile_queued_jobs()

    enqueued_ids = {args[1] for args, _options in queue.calls}
    assert reconciled == len(queue.calls)
    assert queued_id in enqueued_ids
    assert running_id not in enqueued_ids


def test_rq_enqueue_failure_fails_job_instead_of_fake_queued_success():
    job_id = _job()

    def unavailable():
        raise ConnectionError("redis offline")

    manager = RQJobManager(queue_provider=unavailable)
    with pytest.raises(JobQueueUnavailable, match="external job queue unavailable"):
        manager.submit(job_id, lambda _ctx: {})

    with SessionLocal() as db:
        job = db.get(Job, job_id)
        assert job is not None
        assert job.status == "failed"
        assert "external job queue unavailable" in job.log


def test_job_api_returns_503_when_configured_queue_cannot_accept_work(
    client, data_dir, monkeypatch
):
    project_name = f"rq-unavailable-{uuid.uuid4().hex[:8]}"
    project_id = client.post("/projects", json={"name": project_name}).json()["id"]
    with open(data_dir / "sample_surface.vtp", "rb") as handle:
        uploaded = client.post(
            f"/projects/{project_id}/datasets",
            files={"file": ("sample_surface.vtp", handle, "application/octet-stream")},
        )
    dataset_id = uploaded.json()["id"]
    ingest = client.post(f"/datasets/{dataset_id}/ingest")
    assert wait_for_job(client, ingest.json()["id"])["status"] == "succeeded"

    def unavailable():
        raise ConnectionError("redis offline")

    monkeypatch.setattr(
        "app.routers.jobs.manager",
        RQJobManager(queue_provider=unavailable),
    )
    response = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "export",
            "target_id": dataset_id,
            "params": {"output_format": "source"},
        },
    )
    assert response.status_code == 503
    assert "external job queue unavailable" in response.text
    with SessionLocal() as db:
        failed = db.scalar(
            select(Job)
            .where(Job.project_id == project_id, Job.kind == "export")
            .order_by(Job.created_at.desc())
        )
        assert failed is not None and failed.status == "failed"


def test_rq_cancel_is_persisted_and_visible_to_another_process_context():
    job_id = _job(status="running")

    def unavailable():
        raise ConnectionError("redis unavailable during best-effort removal")

    manager = RQJobManager(queue_provider=unavailable)
    assert manager.cancel(job_id) is True
    assert JobContext(job_id).cancelled is True
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        assert job is not None and job.status == "canceled"


def test_rq_terminal_failure_is_persisted_only_after_retries_are_exhausted():
    job_id = _job(status="running")

    class QueueRecord:
        id = f"pvweb-{job_id}"
        args = (job_id,)
        retries_left = 1

    handle_terminal_failure(QueueRecord(), None, RuntimeError, RuntimeError(), None)
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        assert job is not None and job.status == "running"

    QueueRecord.retries_left = 0
    handle_terminal_failure(QueueRecord(), None, RuntimeError, RuntimeError(), None)
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        assert job is not None and job.status == "failed"
        assert "after all retries" in job.log


def test_rq_job_survives_api_restart_and_worker_reconstructs_body(client, data_dir):
    project_name = f"rq-restart-{uuid.uuid4().hex[:8]}"
    project_id = client.post("/projects", json={"name": project_name}).json()["id"]
    with open(data_dir / "sample_surface.vtp", "rb") as handle:
        uploaded = client.post(
            f"/projects/{project_id}/datasets",
            files={"file": ("sample_surface.vtp", handle, "application/octet-stream")},
        )
    assert uploaded.status_code == 201
    dataset_id = uploaded.json()["id"]
    ingest = client.post(f"/datasets/{dataset_id}/ingest")
    assert wait_for_job(client, ingest.json()["id"])["status"] == "succeeded"

    # A running record represents work owned by Redis/RQ while the API process
    # restarts. External recovery must preserve it, and a worker can resume the
    # operation using only the persisted row.
    with SessionLocal() as db:
        job = Job(
            project_id=project_id,
            kind="export",
            status="running",
            target_id=dataset_id,
            params={"output_format": "source"},
        )
        db.add(job)
        db.commit()
        job_id = job.id

    assert recover_interrupted_jobs(backend="rq") == 0
    with SessionLocal() as db:
        assert db.get(Job, job_id).status == "running"  # type: ignore[union-attr]

    backend_root = Path(__file__).resolve().parents[1]
    child_env = os.environ.copy()
    child_env["PYTHONPATH"] = str(backend_root)
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            "from app.jobs import run_persisted_job; run_persisted_job(" + repr(job_id) + ")",
        ],
        cwd=backend_root,
        env=child_env,
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert completed.returncode == 0, completed.stderr

    with SessionLocal() as db:
        finished = db.get(Job, job_id)
        assert finished is not None
        assert finished.status == "succeeded"
        assert finished.progress == 1.0
        assert finished.result and finished.result.get("artifact_id")
