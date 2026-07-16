"""Transactional and RBAC guarantees of locked_project (app/project_locks.py)."""

from __future__ import annotations

import threading
import time
import uuid

import pytest
from fastapi import HTTPException

from app.auth import Principal
from app.db import SessionLocal
from app.models import Project, ProjectMember, User
from app.project_locks import locked_project


def _create_project(name_prefix: str) -> str:
    with SessionLocal() as db:
        project = Project(name=f"{name_prefix}-{uuid.uuid4().hex[:8]}")
        db.add(project)
        db.commit()
        return project.id


def _delete_project(project_id: str) -> None:
    with SessionLocal() as db:
        project = db.get(Project, project_id)
        if project is not None:
            db.delete(project)
            db.commit()


def _add_member(project_id: str, role: str) -> Principal:
    user_id = f"lock-user-{uuid.uuid4().hex[:8]}"
    with SessionLocal() as db:
        db.add(User(id=user_id))
        db.flush()
        db.add(ProjectMember(project_id=project_id, user_id=user_id, role=role))
        db.commit()
    return Principal(id=user_id)


def test_locked_project_commits_mutation_on_success(client):
    project_id = _create_project("lock-commit")
    try:
        with SessionLocal() as db:
            with locked_project(db, project_id) as project:
                project.name = "lock-commit-renamed"
            assert not db.in_transaction()
        with SessionLocal() as db:
            assert db.get(Project, project_id).name == "lock-commit-renamed"
    finally:
        _delete_project(project_id)


def test_locked_project_rolls_back_mutation_on_exception(client):
    project_id = _create_project("lock-rollback")
    try:
        with SessionLocal() as db:
            original_name = db.get(Project, project_id).name
        with SessionLocal() as db:
            with pytest.raises(RuntimeError, match="validation failed"):
                with locked_project(db, project_id) as project:
                    project.name = "lock-rollback-should-not-persist"
                    raise RuntimeError("validation failed")
            assert not db.in_transaction()
        with SessionLocal() as db:
            assert db.get(Project, project_id).name == original_name
    finally:
        _delete_project(project_id)


def test_locked_project_raises_404_for_missing_project(client):
    with SessionLocal() as db:
        with pytest.raises(HTTPException) as excinfo:
            with locked_project(db, "does-not-exist"):
                raise AssertionError("body must not run for a missing project")
        assert excinfo.value.status_code == 404
        assert not db.in_transaction()


def test_locked_project_rechecks_rbac_inside_the_lock(client):
    project_id = _create_project("lock-rbac")
    try:
        viewer = _add_member(project_id, "viewer")
        editor = _add_member(project_id, "editor")
        stranger = Principal(id=f"lock-user-{uuid.uuid4().hex[:8]}")

        with SessionLocal() as db:
            with pytest.raises(HTTPException) as excinfo:
                with locked_project(db, project_id, viewer, "editor"):
                    raise AssertionError("body must not run without the required role")
            assert excinfo.value.status_code == 403

            with pytest.raises(HTTPException) as excinfo:
                with locked_project(db, project_id, stranger, "viewer"):
                    raise AssertionError("body must not run for a non-member")
            assert excinfo.value.status_code == 403

            with locked_project(db, project_id, editor, "editor") as project:
                assert project.id == project_id
    finally:
        _delete_project(project_id)


def test_locked_project_serializes_concurrent_holders(client):
    project_id = _create_project("lock-serialize")
    order: list[str] = []
    first_inside = threading.Event()
    release_first = threading.Event()
    failures: list[Exception] = []

    def first_holder() -> None:
        try:
            with SessionLocal() as db:
                with locked_project(db, project_id):
                    order.append("first-enter")
                    first_inside.set()
                    assert release_first.wait(timeout=2), "test harness never released"
                    order.append("first-exit")
        except Exception as exc:  # noqa: BLE001 - surface thread assertion
            failures.append(exc)
            first_inside.set()

    def second_holder() -> None:
        try:
            assert first_inside.wait(timeout=2)
            with SessionLocal() as db:
                with locked_project(db, project_id):
                    order.append("second-enter")
        except Exception as exc:  # noqa: BLE001 - surface thread assertion
            failures.append(exc)

    try:
        threads = [
            threading.Thread(target=first_holder),
            threading.Thread(target=second_holder),
        ]
        for thread in threads:
            thread.start()
        assert first_inside.wait(timeout=2)
        # Give the contender time to block on the held lock so the final
        # ordering assertion actually exercises serialization.
        time.sleep(0.2)
        assert "second-enter" not in order
        release_first.set()
        for thread in threads:
            thread.join(timeout=2)
        assert failures == []
        assert order == ["first-enter", "first-exit", "second-enter"]
    finally:
        release_first.set()
        _delete_project(project_id)
