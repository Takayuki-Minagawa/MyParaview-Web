"""FastAPI application entry point.

Wires the M1 API surface (work_plan 7.2):
  projects / datasets (upload, ingest, metadata, download) / pipelines /
  jobs (status, cancel) / artifacts.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from urllib.parse import urlsplit, urlunsplit

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .access import artifact_project_id
from .config import settings
from .db import SessionLocal, init_db
from .jobs import (
    JobQueueUnavailable,
    drain_object_deletions,
    manager,
    recover_interrupted_jobs,
)
from .models import Artifact, AuditEvent, Dataset, Job, Pipeline, RenderSession
from .routers import artifacts, assist, datasets, jobs, pipelines, projects, sessions
from .worker import ffmpeg_available

logger = logging.getLogger(__name__)


async def _drain_object_deletions_periodically(
    *,
    interval_seconds: float,
    batch_size: int,
) -> None:
    """Retry one bounded outbox batch immediately and then once per interval."""

    while True:
        try:
            deleted = await asyncio.to_thread(
                drain_object_deletions,
                batch_size=batch_size,
            )
        except Exception:  # noqa: BLE001 - the next interval is the retry
            logger.exception("periodic object-deletion drain failed")
        else:
            if deleted:
                logger.info("acknowledged %d pending object deletions", deleted)
        await asyncio.sleep(interval_seconds)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    if settings.job_queue_backend == "rq":
        try:
            reconciled = manager.reconcile_queued_jobs()
        except JobQueueUnavailable:
            logger.exception("could not reconcile queued DB jobs with RQ")
        else:
            if reconciled:
                logger.info("re-enqueued %d persisted jobs after API restart", reconciled)
    else:
        # The periodic task below handles durable cleanup without delaying API
        # readiness on an unavailable object store.
        recovered = recover_interrupted_jobs(drain_objects=False)
        if recovered:
            logger.warning("marked %d interrupted in-process jobs as failed", recovered)
    logger.info("job queue backend=%s", settings.job_queue_backend)
    drainer = asyncio.create_task(
        _drain_object_deletions_periodically(
            interval_seconds=settings.object_delete_interval_seconds,
            batch_size=settings.object_delete_batch_size,
        ),
        name="object-deletion-outbox",
    )
    try:
        yield
    finally:
        drainer.cancel()
        with suppress(asyncio.CancelledError):
            await drainer


app = FastAPI(
    title="ParaView-like Web App API",
    version="0.2.0",
    summary="Hybrid scientific visualization, pipelines, jobs, and production adapters.",
    root_path=settings.root_path,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Lets the browser client read download filenames from blob responses.
    expose_headers=["Content-Disposition"],
)


_AUDIT_RESOURCE_TYPES = ("dataset", "pipeline", "job", "artifact", "project")


def _prefix_same_origin_redirect(request: Request, response: Response) -> None:
    """Keep Starlette slash redirects inside a stripped reverse-proxy prefix.

    Starlette's automatic slash redirect builds ``Location`` from ``scope.path``
    and does not include ``scope.root_path``. Only rewrite relative or same-origin
    redirects; presigned S3 and identity-provider redirects must stay untouched.
    """

    root_path = str(request.scope.get("root_path") or "")
    location = response.headers.get("location")
    if not root_path or not location or not 300 <= response.status_code < 400:
        return
    parsed = urlsplit(location)
    if not parsed.path.startswith("/"):
        return
    if parsed.path == root_path or parsed.path.startswith(f"{root_path}/"):
        return
    request_path = str(request.scope.get("path") or "")
    is_slash_redirect = (
        request_path.endswith("/") and parsed.path == request_path.rstrip("/")
    ) or (
        not request_path.endswith("/") and parsed.path == f"{request_path}/"
    )
    if not is_slash_redirect:
        return
    request_host = request.headers.get("host", "").lower()
    is_relative = not parsed.scheme and not parsed.netloc
    is_same_origin = (
        parsed.scheme.lower() == request.url.scheme.lower()
        and parsed.netloc.lower() == request_host
    )
    if not (is_relative or is_same_origin):
        return
    response.headers["location"] = urlunsplit(
        parsed._replace(path=f"{root_path}{parsed.path}")
    )


def _resolve_audit_project_id(
    db: Session, path_params: dict, dataset_id: str | None
) -> str | None:
    """Walk the resource referenced by the path back to its owning project."""
    if dataset_id:
        dataset = db.get(Dataset, dataset_id)
        if dataset:
            return dataset.project_id
    if path_params.get("pipeline_id"):
        pipeline = db.get(Pipeline, path_params["pipeline_id"])
        if pipeline:
            return pipeline.project_id
    if path_params.get("job_id"):
        job = db.get(Job, path_params["job_id"])
        if job:
            return job.project_id
    if path_params.get("artifact_id"):
        artifact = db.get(Artifact, path_params["artifact_id"])
        if artifact:
            resolved = artifact_project_id(db, artifact)
            if resolved:
                return resolved
    if path_params.get("session_id"):
        render_session = db.get(RenderSession, path_params["session_id"])
        if render_session:
            return render_session.project_id
    return None


def _persist_audit_event(
    *,
    actor_id: str | None,
    known_project_id: str | None,
    path_params: dict,
    dataset_id: str | None,
    method: str,
    resource_type: str,
    resource_id: str | None,
    status_code: int,
    path: str,
    extra_detail: dict | None,
) -> None:
    with SessionLocal() as db:
        project_id = known_project_id or _resolve_audit_project_id(db, path_params, dataset_id)
        detail = dict(extra_detail or {})
        detail["path"] = path
        db.add(
            AuditEvent(
                actor_id=actor_id,
                project_id=project_id,
                action=method.lower(),
                resource_type=resource_type,
                resource_id=resource_id,
                status_code=status_code,
                detail=detail,
            )
        )
        db.commit()


@app.middleware("http")
async def record_audit_event(request: Request, call_next):
    response = await call_next(request)
    _prefix_same_origin_redirect(request, response)
    path = request.url.path
    is_timestep_frame = (
        request.method == "GET" and "/timesteps/" in path and path.endswith("/download")
    )
    is_download = request.method == "GET" and (
        "/download" in path or (path.startswith("/artifacts/") and path.count("/") == 2)
    ) and not is_timestep_frame
    if request.method in {"POST", "PUT", "PATCH", "DELETE"} or is_download:
        path_params = request.scope.get("path_params", {})
        principal = getattr(request.state, "principal", None)
        resource_type = getattr(request.state, "audit_resource_type", None) or next(
            (name for name in _AUDIT_RESOURCE_TYPES if f"{name}_id" in path_params),
            request.url.path.strip("/").split("/", 1)[0] or "api",
        )
        resource_id = getattr(request.state, "audit_resource_id", None) or path_params.get(
            f"{resource_type}_id"
        )
        try:
            # The synchronous DB write must not run on the event loop: it would
            # serialize every mutating request behind audit storage.
            await run_in_threadpool(
                _persist_audit_event,
                actor_id=getattr(principal, "id", None),
                known_project_id=(
                    getattr(request.state, "audit_project_id", None)
                    or path_params.get("project_id")
                ),
                path_params=path_params,
                dataset_id=(
                    path_params.get("dataset_id") or request.query_params.get("dataset_id")
                ),
                method=request.method,
                resource_type=resource_type,
                resource_id=resource_id,
                status_code=response.status_code,
                path=path,
                extra_detail=getattr(request.state, "audit_detail", None),
            )
        except Exception:
            # Audit storage must not replace the original API response. Operators
            # can detect and alert on database failures from this log.
            logger.exception("failed to persist audit event for %s %s", request.method, path)
    return response


@app.get("/health", tags=["meta"])
def health() -> dict:
    return {"status": "ok", "service": "pvweb-api", "version": app.version}


@app.get("/capabilities", tags=["meta"])
def capabilities() -> dict:
    return {
        "database": "postgresql" if settings.database_url.startswith("postgresql") else "sqlite",
        "object_store": settings.object_store,
        "oidc": bool(
            settings.auth_mode == "oidc"
            and settings.oidc_issuer
            and settings.oidc_audience
            and settings.oidc_jwks_url
        ),
        "paraview_worker": bool(settings.worker_command),
        "video_export": bool(settings.worker_command) and ffmpeg_available(),
        "job_queue": settings.job_queue_backend,
        "trame_sessions": bool(settings.trame_broker_url),
    }


app.include_router(projects.router)
app.include_router(datasets.router)
app.include_router(pipelines.router)
app.include_router(jobs.router)
app.include_router(artifacts.router)
app.include_router(sessions.router)
app.include_router(assist.router)
