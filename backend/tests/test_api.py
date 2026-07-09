"""API integration tests exercising the M1 end-to-end flow."""

from __future__ import annotations

from conftest import wait_for_job


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_project_crud(client):
    resp = client.post("/projects", json={"name": "Demo"})
    assert resp.status_code == 201
    pid = resp.json()["id"]

    assert client.get(f"/projects/{pid}").json()["name"] == "Demo"
    assert any(p["id"] == pid for p in client.get("/projects").json())

    assert client.get("/projects/nope").status_code == 404


def _new_project(client, name="P") -> str:
    return client.post("/projects", json={"name": name}).json()["id"]


def _upload(client, pid, data_dir, filename):
    path = data_dir / filename
    with open(path, "rb") as fh:
        return client.post(
            f"/projects/{pid}/datasets",
            files={"file": (filename, fh, "application/octet-stream")},
        )


def test_upload_ingest_and_metadata_end_to_end(client, data_dir):
    pid = _new_project(client, "ingest")
    up = _upload(client, pid, data_dir, "sample_surface.vtp")
    assert up.status_code == 201, up.text
    ds = up.json()
    assert ds["status"] == "registered"
    assert ds["ext"] == ".vtp"
    assert ds["size_bytes"] > 0

    job = client.post(f"/datasets/{ds['id']}/ingest")
    assert job.status_code == 202
    finished = wait_for_job(client, job.json()["id"])
    assert finished["status"] == "succeeded", finished

    meta = client.get(f"/datasets/{ds['id']}/metadata").json()
    assert meta["status"] == "ready"
    assert meta["dataset_type"] == "PolyData"
    assert meta["num_points"] == 4
    assert meta["num_cells"] == 4
    assert meta["bounds"] == [0.0, 1.0, 0.0, 1.0, 0.0, 1.0]
    names = {a["name"] for a in meta["arrays"]}
    assert {"temperature", "velocity", "cell_id"} <= names


def test_ingest_csv(client, data_dir):
    pid = _new_project(client, "csv")
    ds = _upload(client, pid, data_dir, "sample_points.csv").json()
    job = client.post(f"/datasets/{ds['id']}/ingest")
    finished = wait_for_job(client, job.json()["id"])
    assert finished["status"] == "succeeded"
    meta = client.get(f"/datasets/{ds['id']}/metadata").json()
    assert meta["dataset_type"] == "Table"
    assert meta["num_points"] == 4


def test_upload_rejects_unknown_extension(client, data_dir):
    pid = _new_project(client)
    resp = client.post(
        f"/projects/{pid}/datasets",
        files={"file": ("evil.exe", b"MZ\x00\x00", "application/octet-stream")},
    )
    assert resp.status_code == 415


def test_upload_rejects_mismatched_content(client):
    pid = _new_project(client)
    # .vtp extension but the bytes are not VTK XML
    resp = client.post(
        f"/projects/{pid}/datasets",
        files={"file": ("fake.vtp", b"this is not xml at all", "application/octet-stream")},
    )
    assert resp.status_code == 400


def test_download_roundtrip(client, data_dir):
    pid = _new_project(client)
    ds = _upload(client, pid, data_dir, "sample_image.vti").json()
    resp = client.get(f"/datasets/{ds['id']}/download")
    assert resp.status_code == 200
    assert b"<VTKFile" in resp.content


def test_pipeline_crud(client, data_dir):
    pid = _new_project(client, "pipe")
    ds = _upload(client, pid, data_dir, "sample_surface.vtp").json()

    create = client.post(
        "/pipelines",
        json={
            "project_id": pid,
            "name": "surface + clip",
            "nodes": [
                {"node_type": "reader", "name": "read", "local_id": "r1",
                 "dataset_id": ds["id"], "params": {}},
                {"node_type": "filter", "name": "Clip", "local_id": "f1",
                 "input_id": "r1", "params": {"axis": "x", "value": 0.5}},
            ],
        },
    )
    assert create.status_code == 201, create.text
    body = create.json()
    plid = body["id"]
    assert len(body["nodes"]) == 2
    # the filter's input_id must resolve to the reader node's real persisted id
    reader = next(n for n in body["nodes"] if n["node_type"] == "reader")
    clip = next(n for n in body["nodes"] if n["node_type"] == "filter")
    assert clip["input_id"] == reader["id"]

    patched = client.patch(
        f"/pipelines/{plid}",
        json={"nodes": [{"node_type": "representation", "name": "surface", "params": {"color_by": "temperature"}}]},
    )
    assert patched.status_code == 200
    assert len(patched.json()["nodes"]) == 1
    assert patched.json()["nodes"][0]["node_type"] == "representation"


def test_pipeline_rejects_unresolvable_input_id(client, data_dir):
    pid = _new_project(client, "badpipe")
    resp = client.post(
        "/pipelines",
        json={
            "project_id": pid,
            "name": "broken",
            "nodes": [
                {"node_type": "filter", "name": "Clip", "input_id": "ghost", "params": {}},
            ],
        },
    )
    assert resp.status_code == 422


def test_cancel_completed_job_conflicts(client, data_dir):
    pid = _new_project(client, "cancel")
    ds = _upload(client, pid, data_dir, "sample_surface.vtp").json()
    job = client.post(f"/datasets/{ds['id']}/ingest").json()
    wait_for_job(client, job["id"])
    resp = client.post(f"/jobs/{job['id']}/cancel")
    assert resp.status_code == 409  # already terminal


def test_cancel_missing_job_404(client):
    assert client.post("/jobs/does-not-exist/cancel").status_code == 404
