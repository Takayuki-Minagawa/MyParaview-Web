"""Persistence and lifecycle of assistant proposals (apply/dismiss/RBAC)."""

from __future__ import annotations

import uuid

from app.jobs import RQJobManager
from app.jobs import manager as default_manager
from conftest import wait_for_job


def _unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _setup(client, data_dir, name: str) -> tuple[str, str]:
    """Create a project with an ingested ascii VTP dataset; return (pid, dsid)."""
    project_id = client.post("/projects", json={"name": _unique(name)}).json()["id"]
    with open(data_dir / "sample_surface.vtp", "rb") as handle:
        dataset = client.post(
            f"/projects/{project_id}/datasets",
            files={"file": ("sample_surface.vtp", handle, "application/xml")},
        ).json()
    ingest = client.post(f"/datasets/{dataset['id']}/ingest").json()
    assert wait_for_job(client, ingest["id"])["status"] == "succeeded"
    return project_id, dataset["id"]


def _propose(client, dataset_id: str, prompt: str) -> dict:
    response = client.post(
        "/assist/proposals", json={"dataset_id": dataset_id, "prompt": prompt}
    )
    assert response.status_code == 200, response.text
    return response.json()


def _record(client, dataset_id: str, proposal_id: str) -> dict:
    listed = client.get(f"/assist/proposals?dataset_id={dataset_id}")
    assert listed.status_code == 200
    return next(item for item in listed.json() if item["id"] == proposal_id)


def test_proposal_is_persisted_and_listed(client, data_dir):
    _, dataset_id = _setup(client, data_dir, "assist-persist")
    prompt = "slice this dataset please"
    proposal = _propose(client, dataset_id, prompt)
    assert proposal["id"]
    assert proposal["action"] == "filter_job"

    record = _record(client, dataset_id, proposal["id"])
    assert record["status"] == "proposed"
    assert record["prompt"] == prompt
    assert record["action"] == "filter_job"
    assert record["params"]["filter"] == "slice"
    assert record["applied_job_id"] is None


def test_apply_view_change_proposal_is_rejected(client, data_dir):
    _, dataset_id = _setup(client, data_dir, "assist-viewchange")
    proposal = _propose(client, dataset_id, "color by temperature")
    assert proposal["action"] == "view_change"
    response = client.post(f"/assist/proposals/{proposal['id']}/apply")
    assert response.status_code == 422


def test_apply_filter_proposal_launches_job(client, data_dir):
    project_id, dataset_id = _setup(client, data_dir, "assist-apply")
    proposal = _propose(client, dataset_id, "slice")
    assert proposal["action"] == "filter_job"

    applied = client.post(f"/assist/proposals/{proposal['id']}/apply")
    assert applied.status_code == 200, applied.text
    job = applied.json()
    assert job["kind"] == "filter"
    assert job["project_id"] == project_id
    assert job["target_id"] == dataset_id

    record = _record(client, dataset_id, proposal["id"])
    assert record["status"] == "applied"
    assert record["applied_job_id"] == job["id"]

    # No worker configured: the job exists and reaches a terminal state.
    finished = wait_for_job(client, job["id"])
    assert finished["id"] == job["id"]

    second = client.post(f"/assist/proposals/{proposal['id']}/apply")
    assert second.status_code == 409


def test_apply_filter_proposal_can_retry_after_queue_outage(
    client, data_dir, monkeypatch
):
    _, dataset_id = _setup(client, data_dir, "assist-queue-outage")
    proposal = _propose(client, dataset_id, "slice")

    def unavailable():
        raise ConnectionError("redis offline")

    monkeypatch.setattr(
        "app.routers.assist.manager",
        RQJobManager(queue_provider=unavailable),
    )
    unavailable_response = client.post(f"/assist/proposals/{proposal['id']}/apply")
    assert unavailable_response.status_code == 503
    record = _record(client, dataset_id, proposal["id"])
    assert record["status"] == "proposed"
    assert record["applied_job_id"] is None

    monkeypatch.setattr("app.routers.assist.manager", default_manager)
    retry = client.post(f"/assist/proposals/{proposal['id']}/apply")
    assert retry.status_code == 200, retry.text


def test_dismiss_proposal_and_repeat_conflicts(client, data_dir):
    _, dataset_id = _setup(client, data_dir, "assist-dismiss")
    proposal = _propose(client, dataset_id, "slice")

    dismissed = client.post(f"/assist/proposals/{proposal['id']}/dismiss")
    assert dismissed.status_code == 200
    assert dismissed.json()["status"] == "dismissed"
    assert _record(client, dataset_id, proposal["id"])["status"] == "dismissed"

    again = client.post(f"/assist/proposals/{proposal['id']}/dismiss")
    assert again.status_code == 409
    assert client.post(f"/assist/proposals/{proposal['id']}/apply").status_code == 409


def test_viewer_cannot_apply_proposal(client, data_dir):
    project_id, dataset_id = _setup(client, data_dir, "assist-rbac")
    viewer_subject = _unique("assist-viewer")
    viewer = {"X-PVWeb-User": viewer_subject}
    granted = client.put(
        f"/projects/{project_id}/members",
        json={"user_id": viewer_subject, "role": "viewer"},
    )
    assert granted.status_code == 200

    proposal = _propose(client, dataset_id, "slice")
    denied = client.post(f"/assist/proposals/{proposal['id']}/apply", headers=viewer)
    assert denied.status_code == 403
    assert _record(client, dataset_id, proposal["id"])["status"] == "proposed"
