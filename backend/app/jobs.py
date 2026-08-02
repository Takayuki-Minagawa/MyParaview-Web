"""Durable job execution with local and optional RQ queue backends.

The API persists every job before submitting it.  The default ``local``
backend keeps the original thread-pool behaviour for development and tests.
The optional ``rq`` backend enqueues only the persisted job id; an independent
worker reconstructs the job body from ``kind``, ``target_id`` and ``params``.
That makes the queue payload serializable and lets jobs survive API process
restarts without changing the public jobs API.
"""

from __future__ import annotations

import logging
import threading
import traceback
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .config import settings
from .db import SessionLocal
from .models import Artifact, Dataset, Job
from .storage import store

logger = logging.getLogger(__name__)

_ACTIVE_STATUSES = ("queued", "running")


class JobCancelled(Exception):
    """Raised inside a job body when cancellation was requested."""


class JobQueueUnavailable(RuntimeError):
    """Raised when a configured external queue cannot accept a job."""


def recover_interrupted_jobs(*, backend: str | None = None) -> int:
    """Recover active jobs according to the configured execution backend.

    Local thread-pool work disappears with the API process, so its active rows
    are failed explicitly.  RQ owns active work outside the API process and its
    Redis queue is durable; those rows must remain active across API restarts.
    """

    selected_backend = backend or settings.job_queue_backend
    if selected_backend != "local":
        return 0

    with SessionLocal() as db:
        interrupted = list(db.scalars(select(Job).where(Job.status.in_(_ACTIVE_STATUSES))))
        for job in interrupted:
            previous = job.status
            job.status = "failed"
            job.log = (job.log or "") + (
                f"ERROR: {previous} in-process job was interrupted by service restart; "
                "retry required\n"
            )
            if job.kind == "ingest" and job.target_id:
                dataset = db.get(Dataset, job.target_id)
                if dataset is not None and dataset.status == "ingesting":
                    dataset.status = "registered"
                    dataset.error = None
                    db.add(dataset)
            db.add(job)
        if interrupted:
            db.commit()
        return len(interrupted)


class JobContext:
    """Handed to a job body to report progress and observe cancellation.

    The event provides the low-latency local path.  The persisted status is the
    cross-process cancellation signal used by RQ workers and also closes races
    between API and worker processes.
    """

    def __init__(self, job_id: str, cancel_event: threading.Event | None = None) -> None:
        self.job_id = job_id
        self._cancel = cancel_event

    @property
    def cancelled(self) -> bool:
        if self._cancel is not None and self._cancel.is_set():
            return True
        with SessionLocal() as db:
            job = db.get(Job, self.job_id)
            return job is not None and job.status == "canceled"

    def check_cancelled(self) -> None:
        if self.cancelled:
            raise JobCancelled()

    def update(self, *, progress: float | None = None, log_line: str | None = None) -> None:
        with SessionLocal() as db:
            job = db.get(Job, self.job_id)
            if job is None or job.status not in _ACTIVE_STATUSES:
                return
            if progress is not None:
                job.progress = max(0.0, min(1.0, progress))
            if log_line is not None:
                job.log = (job.log or "") + log_line.rstrip("\n") + "\n"
            db.add(job)
            db.commit()


JobBody = Callable[[JobContext], dict]


def _cleanup_result(result: dict) -> None:
    artifact_id = result.get("artifact_id")
    if not artifact_id:
        return
    with SessionLocal() as db:
        artifact = db.get(Artifact, artifact_id)
        if artifact is None:
            return
        object_key = artifact.object_key
        db.delete(artifact)
        db.commit()
    store.delete(object_key)


def _claim_job(job_id: str) -> bool:
    """Claim queued work, accepting ``running`` for RQ crash recovery."""

    with SessionLocal() as db:
        job = db.get(Job, job_id)
        if job is None or job.status not in _ACTIVE_STATUSES:
            return False
        job.status = "running"
        db.add(job)
        db.commit()
        return True


def _publish_success(job_id: str, result: dict) -> bool:
    """Publish success only if cancellation has not won the DB race."""

    with SessionLocal() as db:
        published = db.execute(
            update(Job)
            .where(Job.id == job_id, Job.status.in_(_ACTIVE_STATUSES))
            .values(status="succeeded", progress=1.0, result=result)
        )
        db.commit()
        return published.rowcount == 1


def _publish_canceled(job_id: str) -> None:
    with SessionLocal() as db:
        db.execute(
            update(Job)
            .where(Job.id == job_id, Job.status.in_(_ACTIVE_STATUSES))
            .values(status="canceled")
        )
        db.commit()


def _publish_failure(job_id: str, exc: Exception, trace: str) -> None:
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        if job is None or job.status not in _ACTIVE_STATUSES:
            return
        job.status = "failed"
        job.log = (job.log or "") + f"ERROR: {exc}\n{trace}\n"
        db.add(job)
        db.commit()


def _run_job(
    job_id: str,
    body: JobBody,
    cancel_event: threading.Event | None = None,
    *,
    before_terminal: Callable[[], bool] | None = None,
) -> None:
    """Execute one persisted job and arbitrate cancel/success atomically."""

    if not _claim_job(job_id):
        return
    ctx = JobContext(job_id, cancel_event)
    try:
        result = body(ctx)
        canceled = before_terminal() if before_terminal is not None else ctx.cancelled
        if canceled:
            _publish_canceled(job_id)
            _cleanup_result(result)
        elif not _publish_success(job_id, result):
            # A cross-process cancel committed after the body returned.
            _cleanup_result(result)
    except JobCancelled:
        _publish_canceled(job_id)
    except Exception as exc:  # noqa: BLE001 - persist all job failures
        _publish_failure(job_id, exc, traceback.format_exc())


def _job_body_from_record(job: Job) -> JobBody:
    """Rebuild an executable body from a persisted, validated job record."""

    # Imported lazily because services imports JobContext/JobCancelled from
    # this module.  RQ serializes only ``job_id``, never these closures.
    from .services import (
        run_dataset_operation,
        run_ingest,
        run_movie_export,
        run_pipeline_execution,
        run_stats_operation,
    )

    target_id = job.target_id
    params = dict(job.params or {})
    if not target_id:
        raise ValueError(f"job {job.id} has no target dataset")
    if job.kind == "ingest":
        return run_ingest(target_id)
    if job.kind == "pipeline":
        pipeline_id = params.get("pipeline_id")
        filters = params.get("filters")
        if not isinstance(pipeline_id, str) or not isinstance(filters, list):
            raise ValueError(f"pipeline job {job.id} has invalid persisted parameters")
        return run_pipeline_execution(pipeline_id, target_id, filters)
    if job.kind == "stats":
        return run_stats_operation(target_id, params)
    if job.kind == "movie":
        return run_movie_export(target_id, params)
    if job.kind in {"convert", "filter", "export", "render"}:
        return run_dataset_operation(target_id, job.kind, params)
    raise ValueError(f"unsupported persisted job kind: {job.kind}")


def run_persisted_job(job_id: str) -> None:
    """RQ entry contract: load, reconstruct and execute a persisted job."""

    with SessionLocal() as db:
        job = db.get(Job, job_id)
        if job is None or job.status not in _ACTIVE_STATUSES:
            return
        try:
            body = _job_body_from_record(job)
        except Exception as exc:  # noqa: BLE001 - malformed records fail honestly
            _publish_failure(job_id, exc, traceback.format_exc())
            return
    _run_job(job_id, body)


class JobManager:
    """Original local thread-pool backend."""

    backend_name = "local"

    def __init__(self, max_workers: int = 4) -> None:
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="pvjob")
        self._cancels: dict[str, threading.Event] = {}
        self._lock = threading.Lock()

    def submit(self, job_id: str, body: JobBody) -> None:
        event = threading.Event()
        with self._lock:
            self._cancels[job_id] = event
        self._pool.submit(self._run, job_id, body, event)

    def shutdown(self, *, wait: bool = True) -> None:
        self._pool.shutdown(wait=wait)

    def cancel(self, job_id: str, *, db: Session | None = None) -> bool:
        """Request cancellation. Returns True if the job was cancellable."""

        with self._lock:
            event = self._cancels.get(job_id)
            if event is None:
                return False
            event.set()
        self._mark_canceled(job_id, db=db)
        return True

    @staticmethod
    def _mark_canceled(job_id: str, *, db: Session | None) -> bool:
        def mark(session: Session, *, commit: bool) -> bool:
            job = session.get(Job, job_id)
            if job is None or job.status not in _ACTIVE_STATUSES:
                return False
            job.status = "canceled"
            session.add(job)
            if commit:
                session.commit()
            else:
                session.flush()
            return True

        if db is not None:
            return mark(db, commit=False)
        with SessionLocal() as session:
            return mark(session, commit=True)

    def _run(self, job_id: str, body: JobBody, event: threading.Event) -> None:
        def before_terminal() -> bool:
            # The same lock serializes cancellation with terminal publication.
            with self._lock:
                self._cancels.pop(job_id, None)
                return event.is_set()

        try:
            _run_job(job_id, body, event, before_terminal=before_terminal)
        finally:
            with self._lock:
                self._cancels.pop(job_id, None)

    @staticmethod
    def _cleanup_result(result: dict) -> None:
        # Kept for compatibility with callers/tests that exercise this helper.
        _cleanup_result(result)


class RQJobManager:
    """Redis Queue adapter; the API never executes submitted bodies itself."""

    backend_name = "rq"

    def __init__(self, queue_provider: Callable[[], Any] | None = None) -> None:
        self._queue_provider = queue_provider or self._default_queue

    @staticmethod
    def _default_queue():
        from redis import Redis
        from rq import Queue

        connection = Redis.from_url(settings.redis_url)
        return Queue(
            settings.job_queue_name,
            connection=connection,
            default_timeout=settings.job_queue_timeout_seconds,
        )

    @staticmethod
    def rq_job_id(job_id: str) -> str:
        return f"pvweb-{job_id}"

    @staticmethod
    def _enqueue(queue, job_id: str) -> None:
        from rq import Callback, Retry

        queue.enqueue(
            "app.rq_worker.execute_job",
            job_id,
            job_id=RQJobManager.rq_job_id(job_id),
            job_timeout=settings.job_queue_timeout_seconds,
            result_ttl=settings.job_queue_result_ttl_seconds,
            failure_ttl=settings.job_queue_failure_ttl_seconds,
            retry=Retry(
                max=settings.job_queue_max_retries,
                interval=settings.job_queue_retry_interval_seconds,
            ),
            on_failure=Callback("app.rq_worker.handle_terminal_failure"),
            # Multiple API replicas may reconcile the same DB outbox row at
            # startup. RQ's Lua-backed unique enqueue closes that race.
            unique=True,
        )

    def submit(self, job_id: str, _body: JobBody) -> None:
        from rq.exceptions import DuplicateJobError

        try:
            queue = self._queue_provider()
            self._enqueue(queue, job_id)
        except DuplicateJobError:
            # The deterministic RQ id means another API replica already
            # submitted the same persisted job. That is a successful outcome.
            logger.info("persisted job %s is already present in RQ", job_id)
            return
        except Exception as exc:  # noqa: BLE001 - normalize Redis/RQ failures
            logger.exception("failed to enqueue persisted job %s", job_id)
            with SessionLocal() as db:
                job = db.get(Job, job_id)
                if job is not None and job.status in _ACTIVE_STATUSES:
                    job.status = "failed"
                    job.log = (job.log or "") + (
                        "ERROR: external job queue unavailable; retry required\n"
                    )
                    db.add(job)
                    db.commit()
            raise JobQueueUnavailable("external job queue unavailable") from exc

    def reconcile_queued_jobs(self) -> int:
        """Enqueue DB outbox rows missed by an API crash before Redis submit."""

        from rq.exceptions import DuplicateJobError

        with SessionLocal() as db:
            job_ids = list(db.scalars(select(Job.id).where(Job.status == "queued")))
        if not job_ids:
            return 0
        try:
            queue = self._queue_provider()
            enqueued = 0
            for job_id in job_ids:
                try:
                    self._enqueue(queue, job_id)
                    enqueued += 1
                except DuplicateJobError:
                    continue
            return enqueued
        except JobQueueUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 - normalize Redis/RQ failures
            raise JobQueueUnavailable("external job queue unavailable") from exc

    def cancel(self, job_id: str, *, db: Session | None = None) -> bool:
        # The DB state is authoritative and is observed cooperatively by a
        # running worker.  Redis cancellation below is a best-effort fast path
        # for a job that has not started yet.
        if not JobManager._mark_canceled(job_id, db=db):
            return False
        try:
            queue = self._queue_provider()
            from rq.exceptions import NoSuchJobError
            from rq.job import Job as RQJob

            try:
                rq_job = RQJob.fetch(self.rq_job_id(job_id), connection=queue.connection)
            except NoSuchJobError:
                return True
            rq_job.cancel()
        except Exception:  # noqa: BLE001 - persisted cancel still succeeds
            logger.warning("could not remove canceled job %s from RQ", job_id, exc_info=True)
        return True

    def shutdown(self, *, wait: bool = True) -> None:
        del wait


manager: JobManager | RQJobManager
if settings.job_queue_backend == "rq":
    manager = RQJobManager()
else:
    manager = JobManager()
