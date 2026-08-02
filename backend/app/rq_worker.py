"""RQ worker entrypoint for persisted MyParaView jobs.

Run with ``python -m app.rq_worker`` in the same image/environment as the API.
The Redis queue contains only database job ids; the worker reconstructs the
validated operation from the corresponding SQL row.
"""

from __future__ import annotations

import argparse
import logging

from .config import settings
from .db import SessionLocal, init_db
from .jobs import RQJobManager, run_persisted_job
from .models import Job

logger = logging.getLogger(__name__)


def execute_job(job_id: str) -> None:
    """Stable import target serialized into RQ messages."""

    run_persisted_job(job_id)


def handle_terminal_failure(rq_job, _connection, exc_type, _exc_value, _traceback) -> None:
    """Fail the SQL job only after RQ has exhausted crash retries."""

    if rq_job.retries_left is not None and rq_job.retries_left > 0:
        return
    args = tuple(rq_job.args or ())
    if not args or not isinstance(args[0], str):
        logger.error("RQ job %s has no persisted job id", rq_job.id)
        return
    job_id = args[0]
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        if job is None or job.status not in {"queued", "running"}:
            return
        job.status = "failed"
        job.log = (job.log or "") + (
            f"ERROR: RQ worker failed after all retries ({exc_type.__name__}); retry required\n"
        )
        db.add(job)
        db.commit()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the MyParaView RQ job worker")
    parser.add_argument(
        "--burst",
        action="store_true",
        help="exit when the queue becomes empty (useful for smoke tests)",
    )
    args = parser.parse_args(argv)
    if settings.job_queue_backend != "rq":
        parser.error("PVWEB_JOB_QUEUE_BACKEND=rq is required")

    from rq import Worker

    init_db()
    queue = RQJobManager._default_queue()
    queue.connection.ping()
    reconciled = RQJobManager(queue_provider=lambda: queue).reconcile_queued_jobs()
    if reconciled:
        logger.info("re-enqueued %d persisted jobs before worker startup", reconciled)
    logger.info("starting RQ worker queue=%s", settings.job_queue_name)
    worker = Worker([queue], connection=queue.connection)
    worker.work(burst=args.burst, with_scheduler=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
