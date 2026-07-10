from __future__ import annotations

import asyncio
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from ..auth import Principal, get_principal, require_project_role
from ..config import settings
from ..db import SessionLocal, get_db
from ..jobs import manager
from ..models import Dataset, Job, Project
from ..project_locks import locked_project
from ..schemas import JobCreate, JobOut
from ..services import run_dataset_operation, run_movie_export, run_stats_operation

router = APIRouter(prefix="/jobs", tags=["jobs"])


def _job_body_for(kind: str, dataset_id: str, params: dict):
    if kind == "stats":
        return run_stats_operation(dataset_id, params)
    if kind == "movie":
        return run_movie_export(dataset_id, params)
    return run_dataset_operation(dataset_id, kind, params)


@router.post("", response_model=JobOut, status_code=202)
def create_job(
    payload: JobCreate,
    request: Request,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    with locked_project(db, payload.project_id, principal, "editor"):
        dataset = db.get(Dataset, payload.target_id)
        if dataset is None:
            raise HTTPException(404, "target dataset not found")
        if dataset.project_id != payload.project_id:
            raise HTTPException(422, "target dataset belongs to a different project")
        if payload.kind == "filter" and payload.params.get("filter") in {"contour", "threshold"}:
            expected_association = (
                "cell" if payload.params.get("association") == "CELLS" else "point"
            )
            selected_array = next(
                (
                    array
                    for array in (dataset.arrays or [])
                    if array.get("name") == payload.params.get("array")
                    and array.get("association") == expected_association
                    and int(array.get("num_components", 1)) == 1
                ),
                None,
            )
            if selected_array is None:
                raise HTTPException(
                    422,
                    "filter array must match an ingested scalar array and association",
                )
        job = Job(
            project_id=payload.project_id,
            kind=payload.kind,
            status="queued",
            target_id=dataset.id,
            params=payload.params,
        )
        db.add(job)
        db.flush()
    request.state.audit_project_id = payload.project_id
    request.state.audit_resource_type = "job"
    request.state.audit_resource_id = job.id
    manager.submit(job.id, _job_body_for(payload.kind, dataset.id, payload.params))
    return job


@router.get("/stream")
async def stream_jobs(
    project_id: str = Query(min_length=1),
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    """Server-sent events with job snapshots for a project.

    Emits every job whose ``updated_at`` advanced since the last poll tick, plus
    heartbeat comments. Connections close after PVWEB_JOB_STREAM_MAX_SECONDS
    (default 5 minutes); clients reconnect.
    """
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "project not found")
    require_project_role(db, project_id, principal)

    def snapshot(after) -> list[tuple[dict, object]]:
        with SessionLocal() as session:
            stmt = (
                select(Job)
                .where(Job.project_id == project_id)
                .order_by(Job.updated_at.asc())
            )
            if after is not None:
                stmt = stmt.where(Job.updated_at > after)
            return [
                (JobOut.model_validate(job).model_dump(mode="json"), job.updated_at)
                for job in session.scalars(stmt)
            ]

    async def event_stream():
        cursor = None
        for _ in range(max(1, settings.job_stream_max_seconds)):
            jobs = await run_in_threadpool(snapshot, cursor)
            for payload, updated_at in jobs:
                cursor = updated_at if cursor is None else max(cursor, updated_at)
                yield f"data: {json.dumps(payload)}\n\n"
            if not jobs:
                yield ": heartbeat\n\n"
            await asyncio.sleep(1.0)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("", response_model=list[JobOut])
def list_jobs(
    project_id: str = Query(min_length=1),
    status: Optional[str] = Query(default=None, pattern="^(queued|running|succeeded|failed|canceled)$"),
    kind: Optional[str] = Query(default=None, max_length=40),
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "project not found")
    require_project_role(db, project_id, principal)
    stmt = (
        select(Job)
        .where(Job.project_id == project_id)
        .order_by(Job.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    if status:
        stmt = stmt.where(Job.status == status)
    if kind:
        stmt = stmt.where(Job.kind == kind)
    return list(db.scalars(stmt))


@router.get("/{job_id}", response_model=JobOut)
def get_job(
    job_id: str,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if not job.project_id:
        raise HTTPException(403, "unscoped job access is forbidden")
    require_project_role(db, job.project_id, principal)
    return job


@router.post("/{job_id}/cancel", response_model=JobOut)
def cancel_job(
    job_id: str,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if not job.project_id:
        raise HTTPException(403, "unscoped job access is forbidden")
    project_id = job.project_id
    with locked_project(db, project_id, principal, "editor"):
        job = db.get(Job, job_id)
        if job is None:
            raise HTTPException(404, "job not found")
        if job.status in ("succeeded", "failed", "canceled"):
            raise HTTPException(409, f"job already {job.status}")
        cancelled = manager.cancel(job_id, db=db)
        # The manager remains in-process; a job owned by another worker cannot
        # be canceled here, but the database mutation is still serialized.
        if not cancelled and job.status not in ("succeeded", "failed", "canceled"):
            raise HTTPException(409, "job is not cancellable on this instance")
        return job
