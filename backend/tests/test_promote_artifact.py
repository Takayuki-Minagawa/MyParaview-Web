"""Promoting derived artifacts to first-class datasets."""

from __future__ import annotations

import base64
import uuid

from conftest import wait_for_job

# 1x1 transparent PNG (same fixture as test_artifacts.py).
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def _unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _project(client, name: str) -> str:
    return client.post("/projects", json={"name": _unique(name)}).json()["id"]


def _upload(client, project_id: str, path):
    with open(path, "rb") as handle:
        response = client.post(
            f"/projects/{project_id}/datasets",
            files={"file": (path.name, handle, "application/octet-stream")},
        )
    assert response.status_code == 201, response.text
    return response.json()


def test_promote_export_artifact_to_ingestable_dataset(client, data_dir):
    project_id = _project(client, "promote-export")
    dataset = _upload(client, project_id, data_dir / "sample_surface.vtp")
    ingest = client.post(f"/datasets/{dataset['id']}/ingest").json()
    assert wait_for_job(client, ingest["id"])["status"] == "succeeded"

    export = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "export",
            "target_id": dataset["id"],
            "params": {"output_format": "source"},
        },
    )
    assert export.status_code == 202, export.text
    finished = wait_for_job(client, export.json()["id"])
    assert finished["status"] == "succeeded", finished
    artifact_id = finished["result"]["artifact_id"]

    promoted = client.post(f"/artifacts/{artifact_id}/promote")
    assert promoted.status_code == 201, promoted.text
    new_dataset = promoted.json()
    assert new_dataset["id"] != dataset["id"]
    assert new_dataset["project_id"] == project_id
    assert new_dataset["status"] == "registered"
    assert new_dataset["ext"] == ".vtp"
    assert new_dataset["filename"].endswith("-export.vtp")
    assert new_dataset["size_bytes"] > 0

    # The promoted copy is a real dataset: the normal ingest flow works on it.
    reingest = client.post(f"/datasets/{new_dataset['id']}/ingest")
    assert reingest.status_code == 202
    assert wait_for_job(client, reingest.json()["id"])["status"] == "succeeded"
    fetched = client.get(f"/datasets/{new_dataset['id']}").json()
    assert fetched["status"] == "ready"
    assert fetched["dataset_type"] == "PolyData"


def test_promote_screenshot_artifact_is_rejected(client, data_dir):
    project_id = _project(client, "promote-screenshot")
    dataset = _upload(client, project_id, data_dir / "sample_surface.vtp")

    uploaded = client.post(
        f"/artifacts?dataset_id={dataset['id']}&kind=screenshot",
        files={"file": ("view.png", _PNG, "image/png")},
    )
    assert uploaded.status_code == 201, uploaded.text
    artifact_id = uploaded.json()["id"]

    rejected = client.post(f"/artifacts/{artifact_id}/promote")
    assert rejected.status_code == 422
    assert "cannot be promoted" in rejected.text
