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


def test_promote_rejects_artifact_content_that_fails_the_upload_sniff(client, data_dir):
    """A client_export with arbitrary bytes must not bypass the upload magic check."""
    project_id = _project(client, "promote-sniff")
    dataset = _upload(client, project_id, data_dir / "sample_surface.vtp")

    uploaded = client.post(
        f"/artifacts?dataset_id={dataset['id']}&kind=client_export",
        files={"file": ("fake.vtp", b"\x00\x01 not xml at all", "application/octet-stream")},
    )
    assert uploaded.status_code == 201, uploaded.text
    artifact_id = uploaded.json()["id"]

    rejected = client.post(f"/artifacts/{artifact_id}/promote")
    assert rejected.status_code == 400
    assert "does not match" in rejected.text


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


def test_presigned_redirect_requires_the_object_to_exist(client, data_dir, monkeypatch):
    """A presigned URL is minted without checking S3; the API must not redirect
    to a missing object (raw S3 404) instead of its own 410/stream."""
    from app.storage import store

    project_id = _project(client, "presigned-guard")
    dataset = _upload(client, project_id, data_dir / "sample_surface.vtp")

    monkeypatch.setattr(
        type(store), "presigned_url",
        lambda self, key, *, filename, expires_seconds=300: "https://s3.example/signed",
    )

    # Object present: the download redirects to the presigned URL.
    redirected = client.get(
        f"/datasets/{dataset['id']}/download", follow_redirects=False
    )
    assert redirected.status_code == 307
    assert redirected.headers["location"] == "https://s3.example/signed"

    # exists() false (e.g. evicted/deleted on S3): no redirect — fall through
    # to the streaming path, which serves the object or raises the clean 410.
    monkeypatch.setattr(type(store), "exists", lambda self, key: False)
    fallthrough = client.get(f"/datasets/{dataset['id']}/download", follow_redirects=False)
    assert fallthrough.status_code != 307
    assert fallthrough.status_code in (200, 410)
