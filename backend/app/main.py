"""FastAPI application entry point.

Wires the M1 API surface (work_plan 7.2):
  projects / datasets (upload, ingest, metadata, download) / pipelines /
  jobs (status, cancel) / artifacts.
"""

from __future__ import annotations

import os
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .db import init_db
from .db import SessionLocal
from .jobs import recover_interrupted_jobs
from .models import Artifact, AuditEvent, Dataset, Job, Pipeline, RenderSession
from .routers import artifacts, assist, datasets, jobs, pipelines, projects, sessions

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    recovered = recover_interrupted_jobs()
    if recovered:
        logger.warning("marked %d interrupted in-process jobs as failed", recovered)
    yield


app = FastAPI(
    title="ParaView-like Web App API",
    version="0.2.0",
    summary="Hybrid scientific visualization, pipelines, jobs, and production adapters.",
    lifespan=lifespan,
)

_origins = os.environ.get("PVWEB_CORS_ORIGINS", "http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _origins if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def record_audit_event(request: Request, call_next):
    response = await call_next(request)
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
            (name for name in ("dataset", "pipeline", "job", "artifact", "project") if f"{name}_id" in path_params),
            request.url.path.strip("/").split("/", 1)[0] or "api",
        )
        resource_id = getattr(request.state, "audit_resource_id", None) or path_params.get(
            f"{resource_type}_id"
        )
        try:
            with SessionLocal() as db:
                project_id = (
                    getattr(request.state, "audit_project_id", None)
                    or path_params.get("project_id")
                )
                dataset_id = path_params.get("dataset_id") or request.query_params.get("dataset_id")
                if not project_id and dataset_id:
                    dataset = db.get(Dataset, dataset_id)
                    project_id = dataset.project_id if dataset else None
                if not project_id and path_params.get("pipeline_id"):
                    pipeline = db.get(Pipeline, path_params["pipeline_id"])
                    project_id = pipeline.project_id if pipeline else None
                if not project_id and path_params.get("job_id"):
                    job = db.get(Job, path_params["job_id"])
                    project_id = job.project_id if job else None
                if not project_id and path_params.get("artifact_id"):
                    artifact = db.get(Artifact, path_params["artifact_id"])
                    dataset = db.get(Dataset, artifact.dataset_id) if artifact and artifact.dataset_id else None
                    job = db.get(Job, artifact.job_id) if artifact and artifact.job_id else None
                    project_id = dataset.project_id if dataset else (job.project_id if job else None)
                if not project_id and path_params.get("session_id"):
                    render_session = db.get(RenderSession, path_params["session_id"])
                    project_id = render_session.project_id if render_session else None
                db.add(
                    AuditEvent(
                        actor_id=getattr(principal, "id", None),
                        project_id=project_id,
                        action=request.method.lower(),
                        resource_type=resource_type,
                        resource_id=resource_id,
                        status_code=response.status_code,
                        detail={"path": path},
                    )
                )
                db.commit()
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
        "trame_sessions": bool(settings.trame_broker_url),
    }


app.include_router(projects.router)
app.include_router(datasets.router)
app.include_router(pipelines.router)
app.include_router(jobs.router)
app.include_router(artifacts.router)
app.include_router(sessions.router)
app.include_router(assist.router)
