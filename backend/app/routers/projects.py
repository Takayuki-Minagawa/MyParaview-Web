from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import Principal, get_principal, require_project_role
from ..db import get_db
from ..models import AuditEvent, Project, ProjectMember, User
from .sessions import _delete_remote_session
from ..schemas import (
    AuditEventOut,
    ProjectCreate,
    ProjectMemberCreate,
    ProjectMemberOut,
    ProjectOut,
)

router = APIRouter(prefix="/projects", tags=["projects"])


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
    request.state.audit_project_id = project.id
    request.state.audit_resource_type = "project"
    request.state.audit_resource_id = project.id
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
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    require_project_role(db, project_id, principal, "admin")
    request.state.audit_project_id = project.id
    request.state.audit_resource_type = "project"
    request.state.audit_resource_id = project.id
    try:
        for render_session in list(project.render_sessions):
            _delete_remote_session(render_session)
    except httpx.HTTPError as exc:
        raise HTTPException(502, "failed to stop a project render session") from exc
    db.delete(project)
    db.commit()


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


@router.put("/{project_id}/members/{user_id}", response_model=ProjectMemberOut)
def put_member(
    project_id: str,
    user_id: str,
    payload: ProjectMemberCreate,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    if payload.user_id != user_id:
        raise HTTPException(422, "path and payload user_id must match")
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "project not found")
    require_project_role(db, project_id, principal, "admin")
    user = db.get(User, user_id)
    if user is None:
        user = User(id=user_id, email=payload.email, display_name=payload.display_name)
        db.add(user)
    membership = db.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == user_id,
        )
    )
    if membership is None:
        membership = ProjectMember(project_id=project_id, user_id=user_id, role=payload.role)
    else:
        membership.role = payload.role
    db.add(membership)
    db.commit()
    db.refresh(membership)
    return membership


@router.get("/{project_id}/audit", response_model=list[AuditEventOut])
def list_audit_events(
    project_id: str,
    db: Session = Depends(get_db),
    principal: Principal = Depends(get_principal),
):
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "project not found")
    require_project_role(db, project_id, principal, "admin")
    stmt = (
        select(AuditEvent)
        .where(AuditEvent.project_id == project_id)
        .order_by(AuditEvent.created_at.desc())
        .limit(500)
    )
    return list(db.scalars(stmt))
