"""In-process job executor with cancellable jobs (work_plan M1-C / 8.2).

A lightweight stand-in for a Celery/RQ worker fleet: jobs run on a thread pool,
persist status/progress/log to the DB, and honour cooperative cancellation via a
per-job ``threading.Event``. The public surface (submit/cancel/status via DB)
matches what a distributed queue would expose, so swapping the backend later
leaves routers untouched.
"""

from __future__ import annotations

import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from .db import SessionLocal
from .models import Artifact, Job
from .storage import store


class JobCancelled(Exception):
    """Raised inside a job body when cancellation was requested."""


class JobContext:
    """Handed to a job body so it can report progress and observe cancellation."""

    def __init__(self, job_id: str, cancel_event: threading.Event) -> None:
        self.job_id = job_id
        self._cancel = cancel_event

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def check_cancelled(self) -> None:
        if self._cancel.is_set():
            raise JobCancelled()

    def update(self, *, progress: float | None = None, log_line: str | None = None) -> None:
        with SessionLocal() as db:
            job = db.get(Job, self.job_id)
            if job is None:
                return
            if progress is not None:
                job.progress = max(0.0, min(1.0, progress))
            if log_line is not None:
                job.log = (job.log or "") + log_line.rstrip("\n") + "\n"
            db.add(job)
            db.commit()


JobBody = Callable[[JobContext], dict]


class JobManager:
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

    def cancel(self, job_id: str) -> bool:
        """Request cancellation. Returns True if the job was cancellable."""
        with self._lock:
            event = self._cancels.get(job_id)
            if event is None:
                return False
            # Set while holding the same lock used by the worker's terminal
            # pop/is_set pair. A successful cancel can no longer be overtaken
            # by publication of a succeeded result.
            event.set()
        # if still queued/running, mark canceled promptly
        with SessionLocal() as db:
            job = db.get(Job, job_id)
            if job and job.status in ("queued", "running"):
                job.status = "canceled"
                db.add(job)
                db.commit()
        return True

    def _run(self, job_id: str, body: JobBody, event: threading.Event) -> None:
        ctx = JobContext(job_id, event)
        with SessionLocal() as db:
            job = db.get(Job, job_id)
            if job is None:
                return
            if event.is_set():  # cancelled before it started
                job.status = "canceled"
                db.add(job)
                db.commit()
                return
            job.status = "running"
            db.add(job)
            db.commit()
        try:
            result = body(ctx)
            # Close the cancellation window before publishing the terminal
            # state. A cancel that arrived before this lock is honored; later
            # callers see an untracked/terminal job instead of racing success.
            with self._lock:
                self._cancels.pop(job_id, None)
                canceled = event.is_set()
            if canceled:
                self._cleanup_result(result)
            with SessionLocal() as db:
                job = db.get(Job, job_id)
                if job is None:
                    return
                if canceled:
                    job.status = "canceled"
                else:
                    job.status = "succeeded"
                    job.progress = 1.0
                    job.result = result
                db.add(job)
                db.commit()
        except JobCancelled:
            with SessionLocal() as db:
                job = db.get(Job, job_id)
                if job:
                    job.status = "canceled"
                    db.add(job)
                    db.commit()
        except Exception as exc:  # noqa: BLE001 - record any failure on the job
            tb = traceback.format_exc()
            with SessionLocal() as db:
                job = db.get(Job, job_id)
                if job:
                    job.status = "failed"
                    job.log = (job.log or "") + f"ERROR: {exc}\n{tb}\n"
                    db.add(job)
                    db.commit()
        finally:
            with self._lock:
                self._cancels.pop(job_id, None)

    @staticmethod
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


manager = JobManager()
