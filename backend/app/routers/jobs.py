from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..jobs import manager
from ..models import Job
from ..schemas import JobOut

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("", response_model=list[JobOut])
def list_jobs(project_id: Optional[str] = None, db: Session = Depends(get_db)):
    stmt = select(Job).order_by(Job.created_at.desc())
    if project_id:
        stmt = stmt.where(Job.project_id == project_id)
    return list(db.scalars(stmt))


@router.get("/{job_id}", response_model=JobOut)
def get_job(job_id: str, db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return job


@router.post("/{job_id}/cancel", response_model=JobOut)
def cancel_job(job_id: str, db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if job.status in ("succeeded", "failed", "canceled"):
        raise HTTPException(409, f"job already {job.status}")
    cancelled = manager.cancel(job_id)
    db.refresh(job)
    # manager is an in-process singleton (single-worker MVP assumption). If the
    # job is not tracked here yet still non-terminal, we cannot cancel it.
    if not cancelled and job.status not in ("succeeded", "failed", "canceled"):
        raise HTTPException(409, "job is not cancellable on this instance")
    return job
