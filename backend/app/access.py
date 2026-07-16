"""Load-and-authorize helpers shared by the routers.

Every router repeats the same three steps before touching a resource: load it,
404 when missing, then check the caller's role on the owning project. These
helpers make that one call with canonical error wording, so 404/403 behavior
cannot drift between endpoints.
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .auth import Principal, require_project_role
from .models import Dataset, Job, Pipeline, Project


def require_project(
    db: Session, project_id: str, principal: Principal, minimum: str = "viewer"
) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    require_project_role(db, project_id, principal, minimum)
    return project


def authorized_dataset(
    db: Session, dataset_id: str, principal: Principal, minimum: str = "viewer"
) -> Dataset:
    dataset = db.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(404, "dataset not found")
    require_project_role(db, dataset.project_id, principal, minimum)
    return dataset


def authorized_job(
    db: Session, job_id: str, principal: Principal, minimum: str = "viewer"
) -> Job:
    job = db.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    if not job.project_id:
        raise HTTPException(403, "unscoped job access is forbidden")
    require_project_role(db, job.project_id, principal, minimum)
    return job


def authorized_pipeline(
    db: Session, pipeline_id: str, principal: Principal, minimum: str = "viewer"
) -> Pipeline:
    pipeline = db.get(Pipeline, pipeline_id)
    if pipeline is None:
        raise HTTPException(404, "pipeline not found")
    require_project_role(db, pipeline.project_id, principal, minimum)
    return pipeline
