from __future__ import annotations

import base64
import threading
import time

from app.db import SessionLocal
from app.jobs import JobManager
from app.models import Artifact, Job
from app.storage import store
from conftest import wait_for_job


def _project(client, name: str) -> str:
    return client.post("/projects", json={"name": name}).json()["id"]


def _upload(client, project_id: str, path):
    with open(path, "rb") as handle:
        response = client.post(
            f"/projects/{project_id}/datasets",
            files={"file": (path.name, handle, "application/octet-stream")},
        )
    assert response.status_code == 201, response.text
    return response.json()


def test_export_job_creates_downloadable_artifact(client, data_dir):
    project_id = _project(client, "artifact-export")
    source = data_dir / "sample_surface.vtp"
    dataset = _upload(client, project_id, source)

    created = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "export",
            "target_id": dataset["id"],
            "params": {"output_format": "source"},
        },
    )
    assert created.status_code == 202, created.text
    assert created.json()["params"] == {"output_format": "source"}
    finished = wait_for_job(client, created.json()["id"])
    assert finished["status"] == "succeeded", finished
    artifact_id = finished["result"]["artifact_id"]

    listed = client.get(f"/artifacts?dataset_id={dataset['id']}")
    assert listed.status_code == 200
    artifact = next(item for item in listed.json() if item["id"] == artifact_id)
    assert artifact["kind"] == "export"
    assert artifact["filename"].endswith("-export.vtp")
    assert artifact["size_bytes"] == len(source.read_bytes())

    downloaded = client.get(f"/artifacts/{artifact_id}")
    assert downloaded.status_code == 200
    assert downloaded.content == source.read_bytes()


def test_convert_without_worker_fails_honestly(client, data_dir):
    project_id = _project(client, "artifact-convert")
    dataset = _upload(client, project_id, data_dir / "sample_image.vti")
    created = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "convert",
            "target_id": dataset["id"],
            "params": {"output_format": "vtp"},
        },
    )
    finished = wait_for_job(client, created.json()["id"])
    assert finished["status"] == "failed"
    assert "requires PVWEB_PVPYTHON" in finished["log"]
    assert client.get(f"/artifacts?job_id={created.json()['id']}").json() == []

    convert_without_format = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "convert",
            "target_id": dataset["id"],
            "params": {},
        },
    )
    failed_default = wait_for_job(client, convert_without_format.json()["id"])
    assert failed_default["status"] == "failed"
    assert "require output_format='vtp'" in failed_default["log"]

    fake_export = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "export",
            "target_id": dataset["id"],
            "params": {"output_format": "vtp"},
        },
    )
    failed_export = wait_for_job(client, fake_export.json()["id"])
    assert failed_export["status"] == "failed"
    assert "only support output_format='source'" in failed_export["log"]


def test_filter_schema_and_worker_artifact(client, data_dir, monkeypatch):
    project_id = _project(client, "server-filter")
    dataset = _upload(client, project_id, data_dir / "sample_surface.vtp")
    ingest = client.post(f"/datasets/{dataset['id']}/ingest")
    assert wait_for_job(client, ingest.json()["id"])["status"] == "succeeded"

    invalid = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "filter",
            "target_id": dataset["id"],
            "params": {"filter": "clip", "origin": [0, 0, 0], "normal": [0, 0, 0]},
        },
    )
    assert invalid.status_code == 422

    huge_number = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "filter",
            "target_id": dataset["id"],
            "params": {
                "filter": "contour",
                "array": "temperature",
                "association": "points",
                "value": 10**4000,
            },
        },
    )
    assert huge_number.status_code == 422

    wrong_array = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "filter",
            "target_id": dataset["id"],
            "params": {
                "filter": "contour",
                "array": "does_not_exist",
                "association": "POINTS",
                "value": 1,
            },
        },
    )
    assert wrong_array.status_code == 422

    unavailable = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "filter",
            "target_id": dataset["id"],
            "params": {
                "filter": "contour",
                "array": "temperature",
                "association": "PoInTs",
                "value": 25,
            },
        },
    )
    assert unavailable.status_code == 202
    assert unavailable.json()["params"]["association"] == "POINTS"
    failed = wait_for_job(client, unavailable.json()["id"])
    assert failed["status"] == "failed"
    assert "PVWEB_PVPYTHON" in failed["log"]

    new_filter_unavailable = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "filter",
            "target_id": dataset["id"],
            "params": {"filter": "cell_to_point"},
        },
    )
    assert new_filter_unavailable.status_code == 202
    new_filter_failed = wait_for_job(client, new_filter_unavailable.json()["id"])
    assert new_filter_failed["status"] == "failed"
    assert "PVWEB_PVPYTHON" in new_filter_failed["log"]
    assert client.get(
        f"/artifacts?job_id={new_filter_unavailable.json()['id']}"
    ).json() == []

    def fake_transform(_source, output, _kind, _params, _ctx):
        output.write_bytes((data_dir / "sample_surface.vtp").read_bytes())

    monkeypatch.setattr("app.services.run_transform", fake_transform)
    created = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "filter",
            "target_id": dataset["id"],
            "params": {
                "filter": "threshold",
                "array": "temperature",
                "association": "POINTS",
                "minimum": 10,
                "maximum": 30,
            },
        },
    )
    finished = wait_for_job(client, created.json()["id"])
    assert finished["status"] == "succeeded", finished
    artifact = client.get(f"/artifacts/{finished['result']['artifact_id']}")
    assert artifact.status_code == 200
    assert b"PolyData" in artifact.content


def test_job_rejects_cross_project_target(client, data_dir):
    owner = _project(client, "owner-artifact")
    other = _project(client, "other-artifact")
    dataset = _upload(client, owner, data_dir / "sample_surface.vtp")
    response = client.post(
        "/jobs",
        json={"project_id": other, "kind": "export", "target_id": dataset["id"], "params": {}},
    )
    assert response.status_code == 422


def test_unscoped_legacy_job_and_artifact_fail_closed(client):
    with SessionLocal() as db:
        job = Job(kind="export", status="failed", log="secret", params={})
        db.add(job)
        db.flush()
        object_key = store.new_key(".bin")
        store.save_bytes(object_key, b"secret artifact")
        artifact = Artifact(
            job_id=job.id,
            kind="export",
            filename="secret.bin",
            size_bytes=15,
            object_key=object_key,
        )
        db.add(artifact)
        db.commit()
        job_id = job.id
        artifact_id = artifact.id
    try:
        headers = {"X-PVWeb-User": "unrelated"}
        assert client.get(f"/jobs/{job_id}", headers=headers).status_code == 403
        assert client.get(f"/artifacts?job_id={job_id}", headers=headers).status_code == 403
        assert client.get(f"/artifacts/{artifact_id}", headers=headers).status_code == 410
    finally:
        store.delete(object_key)


def test_client_screenshot_artifact_roundtrip(client, data_dir):
    project_id = _project(client, "screenshot")
    dataset = _upload(client, project_id, data_dir / "sample_surface.vtp")
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )
    response = client.post(
        f"/artifacts?dataset_id={dataset['id']}&kind=screenshot",
        files={"file": ("view.png", png, "image/png")},
    )
    assert response.status_code == 201, response.text
    artifact = response.json()
    assert artifact["filename"] == "view.png"
    assert artifact["size_bytes"] == len(png)
    assert client.get(f"/artifacts/{artifact['id']}").content == png

    bad = client.post(
        f"/artifacts?dataset_id={dataset['id']}&kind=screenshot",
        files={"file": ("fake.png", b"not-png", "image/png")},
    )
    assert bad.status_code == 400

    signed_but_corrupt = client.post(
        f"/artifacts?dataset_id={dataset['id']}&kind=screenshot",
        files={"file": ("corrupt.png", b"\x89PNG\r\n\x1a\nnot-valid", "image/png")},
    )
    assert signed_but_corrupt.status_code == 400


def test_artifact_list_requires_scope(client):
    assert client.get("/artifacts").status_code == 422


def test_cancel_after_artifact_commit_compensates_result(client):
    with SessionLocal() as db:
        job = Job(kind="export", status="queued", params={})
        db.add(job)
        db.commit()
        db.refresh(job)
        job_id = job.id

    committed = threading.Event()
    release = threading.Event()
    object_key = store.new_key(".bin")

    def body(ctx):
        store.save_bytes(object_key, b"derived")
        with SessionLocal() as db:
            artifact = Artifact(
                job_id=ctx.job_id,
                kind="export",
                filename="derived.bin",
                size_bytes=7,
                object_key=object_key,
            )
            db.add(artifact)
            db.commit()
            db.refresh(artifact)
            artifact_id = artifact.id
        committed.set()
        assert release.wait(2)
        return {"artifact_id": artifact_id}

    local_manager = JobManager(max_workers=1)
    try:
        local_manager.submit(job_id, body)
        assert committed.wait(2)
        assert local_manager.cancel(job_id)
        release.set()
        deadline = time.time() + 2
        while time.time() < deadline:
            with SessionLocal() as db:
                remaining = db.query(Artifact).filter(Artifact.job_id == job_id).count()
            if remaining == 0 and not store.exists(object_key):
                break
            time.sleep(0.01)
        assert remaining == 0
        assert not store.exists(object_key)
    finally:
        release.set()
        local_manager.shutdown()
