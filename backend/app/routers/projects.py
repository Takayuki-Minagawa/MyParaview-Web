from __future__ import annotations

import csv
import io

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..access import tag_audit
from ..auth import Principal, get_principal, require_project_role
from ..broker import try_delete_remote
from ..config import settings
from ..db import get_db
from ..jobs import drain_object_deletions, enqueue_object_deletion
from ..models import Artifact, AuditEvent, Dataset, DatasetFile, Job, Project, ProjectMember, User
from ..pipeline_lifecycle import detach_pipeline_inputs
from ..project_locks import locked_project
from ..schemas import (
    AuditEventOut,
    ProjectCreate,
    ProjectMemberCreate,
    ProjectMemberOut,
    ProjectOut,
)

router = APIRouter(prefix="/projects", tags=["projects"])
PROJECT_DELETE_SYNC_DRAIN_LIMIT = 5_000


def _project_delete_drain_batch_size(object_count: int) -> int:
    return min(max(object_count, 1), PROJECT_DELETE_SYNC_DRAIN_LIMIT)


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(
    payload: ProjectCreate,
    request: Request,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    project = Project(name=payload.name)
    db.add(project)
    db.flush()
    tag_audit(request, "project", project.id, project.id)
    db.add(ProjectMember(project_id=project.id, user_id=principal.id, role="admin"))
    db.commit()
    db.refresh(project)
    return project


@router.get("", response_model=list[ProjectOut])
def list_projects(
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    stmt = (
        select(Project)
        .join(ProjectMember, ProjectMember.project_id == Project.id)
        .where(ProjectMember.user_id == principal.id)
        .order_by(Project.created_at.desc())
    )
    return list(db.scalars(stmt))


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(
    project_id: str,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    require_project_role(db, project_id, principal)
    return project


@router.delete("/{project_id}", status_code=204)
def delete_project(
    project_id: str,
    request: Request,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    object_keys: set[str] = set()
    remote_session_ids: list[str] = []
    with locked_project(db, project_id, principal, "admin") as project:
        active_job = db.scalar(
            select(Job.id).where(
                Job.project_id == project_id,
                Job.status.in_(("queued", "running")),
            ).limit(1)
        )
        if active_job:
            raise HTTPException(409, "cancel or wait for active project jobs before deletion")
        tag_audit(request, "project", project.id, project.id)
        remote_session_ids = [
            render_session.remote_session_id for render_session in project.render_sessions
        ]
        dataset_ids = list(db.scalars(select(Dataset.id).where(Dataset.project_id == project_id)))
        job_ids = list(db.scalars(select(Job.id).where(Job.project_id == project_id)))
        object_keys = set(db.scalars(select(Dataset.object_key).where(Dataset.project_id == project_id)))
        if dataset_ids:
            object_keys.update(
                db.scalars(select(DatasetFile.object_key).where(DatasetFile.dataset_id.in_(dataset_ids)))
            )
        if dataset_ids or job_ids:
            artifact_filter = []
            if dataset_ids:
                artifact_filter.append(Artifact.dataset_id.in_(dataset_ids))
            if job_ids:
                artifact_filter.append(Artifact.job_id.in_(job_ids))
            object_keys.update(
                db.scalars(select(Artifact.object_key).where(or_(*artifact_filter)))
            )
        detach_pipeline_inputs(db, project_id=project_id)
        for object_key in object_keys:
            enqueue_object_deletion(db, object_key)
        db.delete(project)
    # The project and its local session records are already deleted. Keep
    # broker cleanup best-effort so its outage cannot misreport the committed
    # delete. Object cleanup is durable in the transaction-backed outbox.
    # Drain a generous bounded prefix immediately. Very large projects leave
    # the durable tail for the periodic drainer instead of occupying one
    # request worker for an unbounded number of object-store round trips.
    drain_object_deletions(
        object_keys=set(object_keys),
        batch_size=_project_delete_drain_batch_size(len(object_keys)),
    )
    for remote_session_id in remote_session_ids:
        try_delete_remote(remote_session_id)


@router.get("/{project_id}/members", response_model=list[ProjectMemberOut])
def list_members(
    project_id: str,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "project not found")
    require_project_role(db, project_id, principal, "admin")
    return list(db.scalars(select(ProjectMember).where(ProjectMember.project_id == project_id)))


@router.get("/{project_id}/membership", response_model=ProjectMemberOut)
def get_current_membership(
    project_id: str,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "project not found")
    require_project_role(db, project_id, principal)
    membership = db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == principal.id,
        )
    )
    if membership is None:
        raise HTTPException(403, "project membership not found")
    return membership


def _assert_not_last_admin(db: Session, project_id: str, *, action: str) -> None:
    """Reject demoting/removing the only admin; a project must stay manageable."""
    admin_count = db.scalar(
        select(func.count()).select_from(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.role == "admin",
        )
    )
    if (admin_count or 0) <= 1:
        raise HTTPException(409, f"cannot {action} the project's last admin")


def _put_member(
    project_id: str,
    user_id: str,
    payload: ProjectMemberCreate,
    db: Session,
    principal: Principal,
):
    if payload.user_id != user_id:
        raise HTTPException(422, "path and payload user_id must match")
    with locked_project(db, project_id, principal, "admin"):
        user = db.get(User, user_id)
        if user is None:
            user = User(id=user_id, email=payload.email, display_name=payload.display_name)
            db.add(user)
            db.flush()  # ProjectMember has no User relationship to infer insert order from.
        membership = db.scalar(
            select(ProjectMember).where(
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == user_id,
            )
        )
        if membership is not None and membership.role == "admin" and payload.role != "admin":
            _assert_not_last_admin(db, project_id, action="demote")
        if membership is None:
            membership = ProjectMember(project_id=project_id, user_id=user_id, role=payload.role)
        else:
            membership.role = payload.role
        db.add(membership)
        db.flush()
        return membership


@router.put("/{project_id}/members", response_model=ProjectMemberOut)
def put_member_from_body(
    project_id: str,
    payload: ProjectMemberCreate,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    """Provider-agnostic member update; OIDC subjects may contain '/' characters."""
    return _put_member(project_id, payload.user_id, payload, db, principal)


@router.put("/{project_id}/members/{user_id}", response_model=ProjectMemberOut)
def put_member(
    project_id: str,
    user_id: str,
    payload: ProjectMemberCreate,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    """Backward-compatible route for callers whose subject is a simple path segment."""
    return _put_member(project_id, user_id, payload, db, principal)


@router.delete("/{project_id}/members", response_model=ProjectMemberOut)
def delete_member(
    project_id: str,
    user_id: str = Query(min_length=1),
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    """Remove a member. Query parameter keeps OIDC subjects with '/' addressable."""
    with locked_project(db, project_id, principal, "admin"):
        membership = db.scalar(
            select(ProjectMember).where(
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == user_id,
            )
        )
        if membership is None:
            raise HTTPException(404, "project member not found")
        if membership.role == "admin":
            _assert_not_last_admin(db, project_id, action="remove")
        removed = ProjectMemberOut.model_validate(membership)
        db.delete(membership)
        db.flush()
        return removed


def _audit_csv(events: list[AuditEvent]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        ["id", "created_at", "actor_id", "action", "resource_type", "resource_id", "status_code", "path"]
    )
    for event in events:
        writer.writerow([
            event.id,
            event.created_at.isoformat(),
            event.actor_id or "",
            event.action,
            event.resource_type,
            event.resource_id or "",
            event.status_code,
            (event.detail or {}).get("path", ""),
        ])
    return buffer.getvalue()


# response_model is None because the csv format intentionally returns
# text/csv; the JSON branch validates through AuditEventOut itself. Both
# content types are declared for OpenAPI accuracy.
@router.get(
    "/{project_id}/audit",
    response_model=None,
    responses={
        200: {
            "model": list[AuditEventOut],
            "content": {"text/csv": {}},
        }
    },
)
def list_audit_events(
    project_id: str,
    format: str = Query(default="json", pattern="^(json|csv)$"),
    limit: int = Query(default=0, ge=0),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "project not found")
    require_project_role(db, project_id, principal, "admin")
    effective_limit = min(limit or settings.audit_list_limit, settings.audit_list_limit)
    stmt = (
        select(AuditEvent)
        .where(AuditEvent.project_id == project_id)
        .order_by(AuditEvent.created_at.desc())
        .limit(effective_limit)
        .offset(offset)
    )
    events = list(db.scalars(stmt))
    if format == "csv":
        return PlainTextResponse(
            _audit_csv(events),
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="audit.csv"'},
        )
    # response_model=None skips FastAPI's ORM conversion; validate explicitly.
    return [AuditEventOut.model_validate(event) for event in events]
