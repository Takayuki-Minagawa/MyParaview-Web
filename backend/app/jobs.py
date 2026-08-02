"""Durable job execution with local and optional RQ queue backends.

The API persists every job before submitting it.  The default ``local``
backend keeps the original thread-pool behaviour for development and tests.
The optional ``rq`` backend enqueues only the persisted job id; an independent
worker reconstructs the job body from ``kind``, ``target_id`` and ``params``.
That makes the queue payload serializable and lets jobs survive API process
restarts without changing the public jobs API.
"""

from __future__ import annotations

import fcntl
import hashlib
import logging
import threading
import traceback
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
from typing import Any, Iterator

from sqlalchemy import delete, event, or_, select, text, update
from sqlalchemy.orm import Session

from .config import settings
from .db import SessionLocal, engine
from .models import Artifact, Dataset, Job, ObjectDeletionOutbox
from .storage import store

logger = logging.getLogger(__name__)

_ACTIVE_STATUSES = ("queued", "running")
_PENDING_OBJECT_DELETES = "pvweb_pending_object_deletes"
_IN_PROCESS_EXECUTION_LOCKS = tuple(threading.Lock() for _ in range(128))
_EXECUTION_LOCK_STATE = threading.local()


@event.listens_for(Session, "after_commit")
def _clear_committed_object_delete_deduplication(session: Session) -> None:
    """Release transaction-local state without opening a nested DB connection.

    SQLAlchemy keeps the committing Session's connection checked out until
    this hook returns. External deletion therefore runs only from the periodic,
    startup, or worker-finally drains after the original Session is released.
    """

    session.info.pop(_PENDING_OBJECT_DELETES, None)


@event.listens_for(Session, "after_rollback")
def _discard_rolled_back_object_deletes(session: Session) -> None:
    """Never apply an irreversible object delete for a rolled-back DB change."""

    session.info.pop(_PENDING_OBJECT_DELETES, None)


def enqueue_object_deletion(
    session: Session,
    object_key: str,
    *,
    job_id: str | None = None,
) -> None:
    """Persist deletion intent in the caller's DB transaction.

    ``session.info`` only deduplicates requests inside the current transaction.
    The outbox row is the source of truth across process crashes and
    object-store errors.
    """

    pending: dict[str, tuple[str | None, ObjectDeletionOutbox]] = session.info.setdefault(
        _PENDING_OBJECT_DELETES, {}
    )
    if object_key in pending:
        previous_job_id, entry = pending[object_key]
        if previous_job_id is None and job_id is not None:
            entry.job_id = job_id
            pending[object_key] = (job_id, entry)
        return
    entry = ObjectDeletionOutbox(object_key=object_key, job_id=job_id)
    session.add(entry)
    pending[object_key] = (job_id, entry)


def stable_job_object_key(job_id: str, output_ext: str) -> str:
    """Return the sole object key for one job/output-extension pair."""

    if not output_ext.startswith(".") or not output_ext[1:].isalnum():
        raise ValueError(f"invalid artifact output extension: {output_ext!r}")
    digest = hashlib.sha256(job_id.encode("utf-8")).hexdigest()
    return f"job-{digest}{output_ext.lower()}"


@contextmanager
def locked_job(session: Session, job_id: str) -> Iterator[Job | None]:
    """Lock one job before a terminal/checkpoint decision.

    PostgreSQL uses ``FOR UPDATE``. A fresh SQLite session upgrades to an
    immediate transaction before reading so its otherwise ignored row-lock
    clause cannot reintroduce the same TOCTOU race in local deployments.
    """

    if session.get_bind().dialect.name == "sqlite" and not session.in_transaction():
        session.connection().exec_driver_sql("BEGIN IMMEDIATE")
    yield session.scalar(select(Job).where(Job.id == job_id).with_for_update())


def _job_object_suffixes(session: Session, job: Job) -> set[str]:
    if job.kind in {"convert", "filter", "pipeline"}:
        return {".vtp"}
    if job.kind == "render":
        return {".png"}
    if job.kind == "stats":
        return {".json"}
    if job.kind == "movie":
        output_format = str((job.params or {}).get("format", "zip")).lower()
        return {f".{output_format}"} if output_format in {"zip", "mp4", "webm"} else set()
    if job.kind == "export":
        dataset = session.get(Dataset, job.target_id) if job.target_id else None
        return ({dataset.ext} if dataset is not None else set()) | {".zip"}
    return set()


def _delete_job_artifacts(session: Session, job: Job) -> None:
    """Delete every DB artifact for ``job`` and defer its object cleanup."""

    artifacts = list(session.scalars(select(Artifact).where(Artifact.job_id == job.id)))
    for artifact in artifacts:
        session.delete(artifact)
        enqueue_object_deletion(session, artifact.object_key, job_id=job.id)
    # A workhorse can die after writing its stable object but before committing
    # an Artifact row. Deleting every job-scoped candidate is safe because the
    # hash namespace cannot overlap another job, and closes that final orphan
    # window when cancel/failure wins.
    for suffix in _job_object_suffixes(session, job):
        enqueue_object_deletion(
            session,
            stable_job_object_key(job.id, suffix),
            job_id=job.id,
        )


def _reset_interrupted_ingest(session: Session, job: Job) -> None:
    """Release an ingest reservation when its job terminates prematurely."""

    if job.kind != "ingest" or not job.target_id:
        return
    dataset = session.get(Dataset, job.target_id)
    if dataset is None or dataset.status != "ingesting":
        return
    dataset.status = "registered"
    dataset.error = None
    session.add(dataset)


class JobCancelled(Exception):
    """Raised inside a job body when cancellation was requested."""


class JobQueueUnavailable(RuntimeError):
    """Raised when a configured external queue cannot accept a job."""


@contextmanager
def _record_execution_lock(job_id: str) -> Iterator[None]:
    held_job_ids: set[str] = getattr(_EXECUTION_LOCK_STATE, "job_ids", set())
    if not hasattr(_EXECUTION_LOCK_STATE, "job_ids"):
        _EXECUTION_LOCK_STATE.job_ids = held_job_ids
    held_job_ids.add(job_id)
    try:
        yield
    finally:
        held_job_ids.discard(job_id)


def _execution_lock_is_held(job_id: str | None) -> bool:
    if job_id is None:
        return False
    return job_id in getattr(_EXECUTION_LOCK_STATE, "job_ids", set())


@contextmanager
def job_execution_lock(job_id: str, *, blocking: bool = True) -> Iterator[bool]:
    """Serialize duplicate deliveries for one persisted job across processes.

    PostgreSQL advisory locks are connection-scoped and therefore disappear if
    a workhorse crashes. SQLite/local deployments use an OS ``flock`` under the
    shared data root with the same crash-release property. Nonblocking callers
    receive ``False`` instead of waiting for an active producer.
    """

    if engine.dialect.name == "postgresql":
        with engine.connect() as connection:
            try:
                lock_function = "pg_advisory_lock" if blocking else "pg_try_advisory_lock"
                result = connection.execute(
                    text(f"SELECT {lock_function}(hashtextextended(:job_id, 0))"),
                    {"job_id": job_id},
                )
                acquired = True if blocking else bool(result.scalar())
                # The advisory lock is session-scoped, so end the implicit
                # SELECT transaction immediately. Holding it open for a long
                # ParaView job would otherwise leave an idle-in-transaction
                # connection.
                connection.commit()
            except Exception:
                # The server may have received the lock request even if the
                # client observed an error. Never return that DBAPI session to
                # the pool where its session-scoped lock could survive.
                connection.invalidate()
                raise
            if acquired:
                try:
                    with _record_execution_lock(job_id):
                        yield True
                finally:
                    try:
                        connection.execute(
                            text("SELECT pg_advisory_unlock(hashtextextended(:job_id, 0))"),
                            {"job_id": job_id},
                        )
                        connection.commit()
                    except Exception:  # noqa: BLE001 - never pool a locked connection
                        try:
                            connection.rollback()
                        except Exception:  # noqa: BLE001 - invalidation is the fallback
                            pass
                        connection.invalidate()
                        logger.exception("could not release execution lock for job %s", job_id)
        if not acquired:
            # Yield only after the unsuccessful advisory-lock connection has
            # returned to the pool. The caller may open a Session to defer its
            # outbox row and must not need a second connection concurrently.
            yield False
        return

    lock_root = settings.data_root / "job-locks"
    lock_root.mkdir(parents=True, exist_ok=True)
    lock_name = hashlib.sha256(job_id.encode("utf-8")).hexdigest()
    stripe = _IN_PROCESS_EXECUTION_LOCKS[int(lock_name[:8], 16) % len(_IN_PROCESS_EXECUTION_LOCKS)]
    stripe_acquired = stripe.acquire(blocking=blocking)
    if not stripe_acquired:
        yield False
        return
    file_lock_acquired = False
    try:
        with (lock_root / f"{lock_name}.lock").open("a+b") as lock_file:
            flags = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
            try:
                fcntl.flock(lock_file.fileno(), flags)
            except BlockingIOError:
                pass
            else:
                file_lock_acquired = True
                try:
                    with _record_execution_lock(job_id):
                        yield True
                finally:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    finally:
        stripe.release()
    if not file_lock_acquired:
        yield False


def drain_object_deletions(
    *,
    job_id: str | None = None,
    object_keys: set[str] | None = None,
    batch_size: int | None = None,
) -> int:
    """Apply durable deletion intents at least once, then acknowledge them.

    Job-scoped rows first cross the same execution lease as their producer.
    Once that barrier is acquired, every earlier writer has stopped and the
    terminal job contract prevents a later delivery from writing. The lease is
    released before DB/object-store I/O so each drain uses at most one pooled
    connection at a time. External delete still happens before the outbox ACK;
    a crash between those steps safely repeats an idempotent delete.
    """

    selected_batch_size = (
        settings.object_delete_batch_size if batch_size is None else batch_size
    )
    if selected_batch_size <= 0:
        raise ValueError("object deletion batch size must be positive")

    try:
        with SessionLocal() as db:
            stmt = select(
                ObjectDeletionOutbox.id,
                ObjectDeletionOutbox.object_key,
                ObjectDeletionOutbox.job_id,
            ).outerjoin(Job, ObjectDeletionOutbox.job_id == Job.id)
            stmt = stmt.where(
                or_(
                    ObjectDeletionOutbox.job_id.is_(None),
                    Job.id.is_(None),
                    Job.status.not_in(_ACTIVE_STATUSES),
                )
            ).order_by(ObjectDeletionOutbox.created_at, ObjectDeletionOutbox.id)
            if job_id is not None:
                stmt = stmt.where(ObjectDeletionOutbox.job_id == job_id)
            if object_keys is not None:
                if not object_keys:
                    return 0
                stmt = stmt.where(ObjectDeletionOutbox.object_key.in_(object_keys))
            entries = list(db.execute(stmt.limit(selected_batch_size)))
    except Exception:  # noqa: BLE001 - job execution must not be masked by cleanup
        logger.exception("could not read object-deletion outbox")
        return 0

    acknowledged = 0
    for entry_id, _object_key, entry_job_id in entries:
        lock_context = (
            job_execution_lock(entry_job_id, blocking=False)
            if entry_job_id is not None
            else nullcontext(True)
        )
        try:
            with lock_context as acquired:
                pass
            if not acquired:
                _defer_object_deletion(entry_id)
                continue
            # Re-read after crossing and releasing the execution barrier:
            # another replica may have ACKed the stale snapshot, while a job
            # manually returned to an active state must not be cleaned.
            with SessionLocal() as db:
                entry = db.get(ObjectDeletionOutbox, entry_id)
                if entry is None:
                    continue
                if entry.job_id is not None:
                    job = db.get(Job, entry.job_id)
                    if job is not None and job.status in _ACTIVE_STATUSES:
                        continue
                object_key = entry.object_key
            try:
                deletion_complete = store.delete(object_key)
            except Exception:  # noqa: BLE001 - the durable row is the retry
                logger.exception("could not delete outbox object %s", object_key)
                _defer_object_deletion(entry_id)
                # A shared S3 endpoint outage would otherwise multiply one
                # client timeout by every row in the startup/periodic batch.
                # Rotation lets the next interval start with later work.
                break
            if not deletion_complete:
                # Local stores defer removal while a download/path lease is
                # active. Keep the row so a later periodic pass can ACK it.
                _defer_object_deletion(entry_id)
                continue
            with SessionLocal() as db:
                db.execute(
                    delete(ObjectDeletionOutbox).where(
                        ObjectDeletionOutbox.id == entry_id
                    )
                )
                db.commit()
            acknowledged += 1
        except Exception:  # noqa: BLE001 - leave the durable row for retry
            logger.exception("could not process object-deletion outbox row %s", entry_id)
            _defer_object_deletion(entry_id)
            break
    return acknowledged


def _defer_object_deletion(entry_id: str) -> None:
    """Move one failed/busy row behind older work to prevent starvation."""

    try:
        with SessionLocal() as db:
            db.execute(
                update(ObjectDeletionOutbox)
                .where(ObjectDeletionOutbox.id == entry_id)
                .values(created_at=datetime.now(timezone.utc))
            )
            db.commit()
    except Exception:  # noqa: BLE001 - the original durable row remains
        logger.exception("could not defer object-deletion outbox row %s", entry_id)


def _drain_after_session_release(
    *,
    job_id: str | None = None,
    object_keys: set[str] | None = None,
) -> int:
    """Drain unless this thread still owns the producer execution lease.

    Terminal publication often runs inside ``job_execution_lock``. The outer
    local/RQ ``finally`` drains immediately after releasing that lease, avoiding
    nested advisory-lock and connection-pool acquisition here.
    """

    if _execution_lock_is_held(job_id):
        return 0
    return drain_object_deletions(job_id=job_id, object_keys=object_keys)


def recover_interrupted_jobs(
    *,
    backend: str | None = None,
    drain_objects: bool = True,
) -> int:
    """Recover active jobs according to the configured execution backend.

    Local thread-pool work disappears with the API process, so its active rows
    are failed explicitly.  RQ owns active work outside the API process and its
    Redis queue is durable; those rows must remain active across API restarts.
    """

    selected_backend = backend or settings.job_queue_backend
    if selected_backend != "local":
        return 0

    with SessionLocal() as db:
        interrupted_ids = list(
            db.scalars(select(Job.id).where(Job.status.in_(_ACTIVE_STATUSES)))
        )
    recovered = 0
    for job_id in interrupted_ids:
        recovered_job = False
        with SessionLocal() as db, locked_job(db, job_id) as job:
            if job is None or job.status not in _ACTIVE_STATUSES:
                continue
            previous = job.status
            job.status = "failed"
            job.result = None
            job.log = (job.log or "") + (
                f"ERROR: {previous} in-process job was interrupted by service restart; "
                "retry required\n"
            )
            _reset_interrupted_ingest(db, job)
            _delete_job_artifacts(db, job)
            db.add(job)
            db.commit()
            recovered += 1
            recovered_job = True
        if recovered_job and drain_objects:
            _drain_after_session_release(job_id=job_id)
    return recovered


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


def _cleanup_result(result: dict, *, job_id: str | None = None) -> None:
    artifact_id = result.get("artifact_id")
    if not artifact_id:
        return
    queued_object_key: str | None = None
    queued_job_id: str | None = None
    with SessionLocal() as db:
        lock_context = locked_job(db, job_id) if job_id is not None else nullcontext(None)
        with lock_context as job:
            if job is not None and job.status in {*_ACTIVE_STATUSES, "succeeded"}:
                # Active work may still publish this shared checkpoint, and a
                # succeeded job already owns it. Only terminal losers may clean.
                return
            artifact = db.get(Artifact, artifact_id)
            if artifact is None or (job_id is not None and artifact.job_id != job_id):
                return
            db.delete(artifact)
            if (
                job is not None
                and isinstance(job.result, dict)
                and job.result.get("artifact_id") == artifact_id
            ):
                job.result = None
                db.add(job)
            enqueue_object_deletion(
                db,
                artifact.object_key,
                job_id=job_id or artifact.job_id,
            )
            queued_object_key = artifact.object_key
            queued_job_id = job_id or artifact.job_id
            db.commit()
    if queued_object_key is not None:
        _drain_after_session_release(
            job_id=queued_job_id,
            object_keys={queued_object_key},
        )


def _claim_job(job_id: str) -> bool:
    """Claim queued work, accepting ``running`` for RQ crash recovery."""

    with SessionLocal() as db:
        with locked_job(db, job_id) as job:
            if job is None or job.status not in _ACTIVE_STATUSES:
                return False
            job.status = "running"
            db.add(job)
            db.commit()
            return True


def _publish_success(job_id: str, result: dict) -> bool:
    """Publish success only if cancellation has not won the DB race.

    A duplicate delivery may observe success already published by another
    workhorse. Treat the terminal winner as success regardless of supplemental
    producer metadata so the loser never compensates away its artifact.
    """

    with SessionLocal() as db:
        with locked_job(db, job_id) as job:
            if job is None:
                return False
            if job.status == "succeeded":
                return True
            if job.status not in _ACTIVE_STATUSES:
                return False
            job.status = "succeeded"
            job.progress = 1.0
            job.result = result
            db.add(job)
            db.commit()
            return True


def _publish_canceled(job_id: str) -> bool:
    canceled = False
    with SessionLocal() as db:
        with locked_job(db, job_id) as job:
            if job is None:
                return False
            if job.status == "canceled":
                canceled = True
            elif job.status not in _ACTIVE_STATUSES:
                return False
            else:
                job.status = "canceled"
                job.result = None
                _reset_interrupted_ingest(db, job)
                _delete_job_artifacts(db, job)
                db.add(job)
                db.commit()
                canceled = True
    if canceled:
        _drain_after_session_release(job_id=job_id)
    return canceled


def _publish_failure(job_id: str, exc: Exception, trace: str) -> None:
    _fail_persisted_job(job_id, f"ERROR: {exc}\n{trace}\n")


def fail_persisted_job(job_id: str, log_line: str) -> bool:
    """Fail active work and compensate any artifact recovery checkpoint."""

    return _fail_persisted_job(job_id, log_line.rstrip("\n") + "\n")


def _fail_persisted_job(job_id: str, log_entry: str) -> bool:
    failed = False
    with SessionLocal() as db:
        with locked_job(db, job_id) as job:
            if job is None or job.status not in _ACTIVE_STATUSES:
                return False
            job.status = "failed"
            job.result = None
            job.log = (job.log or "") + log_entry
            _reset_interrupted_ingest(db, job)
            _delete_job_artifacts(db, job)
            db.add(job)
            db.commit()
            failed = True
    if failed:
        _drain_after_session_release(job_id=job_id)
    return failed


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
            _cleanup_result(result, job_id=job_id)
        elif not _publish_success(job_id, result):
            # A cross-process cancel committed after the body returned.
            _cleanup_result(result, job_id=job_id)
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

    try:
        with job_execution_lock(job_id):
            # Re-read only after acquiring the cross-process lease: a prior
            # delivery may have completed while this one was waiting.
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
    finally:
        # Reacquire nonblocking after the producer lease is released. Terminal
        # cleanup that lost the earlier race can now safely delete late bytes.
        drain_object_deletions(job_id=job_id)


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
        marked = self._mark_canceled(job_id, db=db)
        if not marked:
            # Success won the persisted race; do not let the transient event
            # compensate away the already-published artifact.
            event.clear()
        return marked

    @staticmethod
    def _mark_canceled(job_id: str, *, db: Session | None) -> bool:
        def mark(session: Session, *, commit: bool) -> bool:
            with locked_job(session, job_id) as job:
                if job is None or job.status not in _ACTIVE_STATUSES:
                    return False
                job.status = "canceled"
                job.result = None
                _reset_interrupted_ingest(session, job)
                _delete_job_artifacts(session, job)
                session.add(job)
                if commit:
                    session.commit()
                else:
                    session.flush()
                return True

        if db is not None:
            return mark(db, commit=False)
        with SessionLocal() as session:
            marked = mark(session, commit=True)
        if marked:
            _drain_after_session_release(job_id=job_id)
        return marked

    def _run(self, job_id: str, body: JobBody, event: threading.Event) -> None:
        def before_terminal() -> bool:
            # The same lock serializes cancellation with terminal publication.
            with self._lock:
                self._cancels.pop(job_id, None)
                return event.is_set()

        try:
            with job_execution_lock(job_id):
                _run_job(job_id, body, event, before_terminal=before_terminal)
        finally:
            drain_object_deletions(job_id=job_id)
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
            fail_persisted_job(
                job_id,
                "ERROR: external job queue unavailable; retry required",
            )
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
