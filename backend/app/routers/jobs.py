from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import Principal, get_principal, require_project_role
from ..db import get_db
from ..jobs import manager
from ..models import Dataset, Job, Project
from ..project_locks import locked_project
from ..schemas import JobCreate, JobOut
from ..services import run_dataset_operation

router = APIRouter(prefix="/jobs", tags=["jobs"])


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
    manager.submit(job.id, run_dataset_operation(dataset.id, payload.kind, payload.params))
    return job


@router.get("", response_model=list[JobOut])
def list_jobs(
    project_id: Optional[str] = None,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    if project_id:
        if db.get(Project, project_id) is None:
            raise HTTPException(404, "project not found")
        require_project_role(db, project_id, principal)
    else:
        raise HTTPException(422, "project_id is required")
    stmt = select(Job).order_by(Job.created_at.desc())
    if project_id:
        stmt = stmt.where(Job.project_id == project_id)
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
