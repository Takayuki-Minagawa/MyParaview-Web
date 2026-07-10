"""Duplicate-ingest guard tests for POST /datasets/{id}/ingest."""

from __future__ import annotations

import uuid

from conftest import wait_for_job


def _new_project(client, prefix: str) -> str:
    return client.post("/projects", json={"name": f"{prefix}-{uuid.uuid4().hex[:8]}"}).json()["id"]


def _upload_vtp(client, project_id: str, data_dir) -> str:
    with open(data_dir / "sample_surface.vtp", "rb") as fh:
        resp = client.post(
            f"/projects/{project_id}/datasets",
            files={"file": ("sample_surface.vtp", fh, "application/octet-stream")},
        )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def test_reingest_is_accepted_after_previous_ingest_completes(client, data_dir):
    pid = _new_project(client, "ingest-guard-rerun")
    dataset_id = _upload_vtp(client, pid, data_dir)

    first = client.post(f"/datasets/{dataset_id}/ingest")
    assert first.status_code == 202
    assert wait_for_job(client, first.json()["id"])["status"] == "succeeded"

    second = client.post(f"/datasets/{dataset_id}/ingest")
    assert second.status_code == 202
    assert wait_for_job(client, second.json()["id"])["status"] == "succeeded"


def test_ingest_conflicts_while_dataset_status_is_ingesting(client, data_dir):
    from app.db import SessionLocal
    from app.models import Dataset

    pid = _new_project(client, "ingest-guard-status")
    dataset_id = _upload_vtp(client, pid, data_dir)

    with SessionLocal() as db:
        dataset = db.get(Dataset, dataset_id)
        previous_status = dataset.status
        dataset.status = "ingesting"
        db.add(dataset)
        db.commit()
    try:
        denied = client.post(f"/datasets/{dataset_id}/ingest")
        assert denied.status_code == 409
        assert "already running" in denied.text
    finally:
        with SessionLocal() as db:
            dataset = db.get(Dataset, dataset_id)
            dataset.status = previous_status
            db.add(dataset)
            db.commit()

    accepted = client.post(f"/datasets/{dataset_id}/ingest")
    assert accepted.status_code == 202
    assert wait_for_job(client, accepted.json()["id"])["status"] == "succeeded"


def test_ingest_conflicts_while_an_active_ingest_job_exists(client, data_dir):
    from app.db import SessionLocal
    from app.models import Job

    pid = _new_project(client, "ingest-guard-job")
    dataset_id = _upload_vtp(client, pid, data_dir)

    with SessionLocal() as db:
        job = Job(project_id=pid, kind="ingest", status="running", target_id=dataset_id)
        db.add(job)
        db.commit()
        job_id = job.id
    try:
        denied = client.post(f"/datasets/{dataset_id}/ingest")
        assert denied.status_code == 409
        assert "already running" in denied.text
    finally:
        with SessionLocal() as db:
            db.delete(db.get(Job, job_id))
            db.commit()

    accepted = client.post(f"/datasets/{dataset_id}/ingest")
    assert accepted.status_code == 202
    assert wait_for_job(client, accepted.json()["id"])["status"] == "succeeded"
