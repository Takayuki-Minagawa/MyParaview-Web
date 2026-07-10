"""Tests for the audit middleware wired in app/main.py."""

from __future__ import annotations

import uuid

from sqlalchemy import func, select


def _new_project(client, prefix: str) -> str:
    resp = client.post("/projects", json={"name": f"{prefix}-{uuid.uuid4().hex[:8]}"})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _upload_vtp(client, project_id: str, data_dir) -> str:
    with open(data_dir / "sample_surface.vtp", "rb") as fh:
        resp = client.post(
            f"/projects/{project_id}/datasets",
            files={"file": ("sample_surface.vtp", fh, "application/octet-stream")},
        )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _project_events(project_id: str) -> list:
    from app.db import SessionLocal
    from app.models import AuditEvent

    with SessionLocal() as db:
        events = list(db.scalars(select(AuditEvent).where(AuditEvent.project_id == project_id)))
        db.expunge_all()
    return events


def _total_event_count() -> int:
    from app.db import SessionLocal
    from app.models import AuditEvent

    with SessionLocal() as db:
        return db.scalar(select(func.count()).select_from(AuditEvent)) or 0


def test_post_projects_persists_an_audit_event(client):
    pid = _new_project(client, "audit-mw-post")
    events = _project_events(pid)
    assert any(
        event.action == "post"
        and event.resource_type == "project"
        and event.resource_id == pid
        and event.status_code == 201
        and event.detail["path"] == "/projects"
        for event in events
    )


def test_dataset_download_records_get_event(client, data_dir):
    pid = _new_project(client, "audit-mw-download")
    dataset_id = _upload_vtp(client, pid, data_dir)

    resp = client.get(f"/datasets/{dataset_id}/download")
    assert resp.status_code == 200

    events = _project_events(pid)
    assert any(
        event.action == "get"
        and event.resource_type == "dataset"
        and event.resource_id == dataset_id
        and event.status_code == 200
        and event.detail["path"] == f"/datasets/{dataset_id}/download"
        for event in events
    )


def test_timestep_frame_download_is_not_audited(client, data_dir):
    pid = _new_project(client, "audit-mw-timestep")
    dataset_id = _upload_vtp(client, pid, data_dir)
    timestep_path = f"/datasets/{dataset_id}/timesteps/0/download"

    # a plain VTP is not an ingested collection, so the request fails, but the
    # middleware must classify the path as a timestep frame either way.
    resp = client.get(timestep_path)
    assert resp.status_code in {404, 409}

    events = _project_events(pid)
    assert not any(event.detail["path"] == timestep_path for event in events)


def test_plain_get_projects_is_not_audited(client):
    # prime the audit trail so the count is not trivially zero
    _new_project(client, "audit-mw-list")

    before = _total_event_count()
    assert client.get("/projects").status_code == 200
    assert _total_event_count() == before
