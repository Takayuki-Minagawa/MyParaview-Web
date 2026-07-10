"""Project-scoped mutation guards for supported database deployments."""

from __future__ import annotations

import threading
from contextlib import contextmanager
from collections.abc import Iterator

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .auth import Principal, require_project_role
from .models import Project

_LOCKS = tuple(threading.RLock() for _ in range(64))


@contextmanager
def project_guard(project_id: str) -> Iterator[None]:
    lock = _LOCKS[hash(project_id) % len(_LOCKS)]
    with lock:
        yield


@contextmanager
def locked_project(
    db: Session,
    project_id: str,
    principal: Principal | None = None,
    minimum_role: str = "viewer",
) -> Iterator[Project]:
    """Serialize a project mutation in-process and at the database boundary.

    PostgreSQL uses a row lock. SQLite ignores ``FOR UPDATE``, so an immediate
    transaction obtains the database write lock before we re-read project and
    membership state. This remains effective across uvicorn worker processes.
    The helper commits on successful exit and rolls back on every exception, so
    project existence, RBAC recheck, validation, and mutation are one unit.
    """
    with project_guard(project_id):
        if db.in_transaction():
            db.rollback()
        if db.get_bind().dialect.name == "sqlite":
            db.connection().exec_driver_sql("BEGIN IMMEDIATE")
        try:
            project = db.scalar(
                select(Project).where(Project.id == project_id).with_for_update()
            )
            if project is None:
                raise HTTPException(404, "project not found")
            if principal is not None:
                require_project_role(db, project_id, principal, minimum_role)
            yield project
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            if db.in_transaction():
                db.rollback()
