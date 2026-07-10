"""Dedicated tests for the pipelines router (app/routers/pipelines.py)."""

from __future__ import annotations

import uuid


def _new_project(client, prefix: str) -> str:
    return client.post("/projects", json={"name": f"{prefix}-{uuid.uuid4().hex[:8]}"}).json()["id"]


def _upload_vtp(client, project_id: str, data_dir) -> dict:
    with open(data_dir / "sample_surface.vtp", "rb") as fh:
        resp = client.post(
            f"/projects/{project_id}/datasets",
            files={"file": ("sample_surface.vtp", fh, "application/octet-stream")},
        )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_create_pipeline_remaps_local_input_ids(client, data_dir):
    pid = _new_project(client, "pipe-remap")
    ds = _upload_vtp(client, pid, data_dir)

    created = client.post(
        "/pipelines",
        json={
            "project_id": pid,
            "name": "remap",
            "nodes": [
                {"node_type": "reader", "name": "read", "local_id": "reader",
                 "dataset_id": ds["id"], "params": {}},
                {"node_type": "representation", "name": "view", "input_id": "reader",
                 "params": {}},
            ],
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()
    reader = next(node for node in body["nodes"] if node["node_type"] == "reader")
    representation = next(node for node in body["nodes"] if node["node_type"] == "representation")
    assert representation["input_id"] == reader["id"]
    assert representation["input_id"] != "reader"

    # the remapped edge must be persisted, not just serialized from the request
    fetched = client.get(f"/pipelines/{body['id']}")
    assert fetched.status_code == 200
    persisted = next(
        node for node in fetched.json()["nodes"] if node["node_type"] == "representation"
    )
    assert persisted["input_id"] == reader["id"]


def test_create_pipeline_rejects_unknown_local_input_id(client):
    pid = _new_project(client, "pipe-bad-input")
    resp = client.post(
        "/pipelines",
        json={
            "project_id": pid,
            "name": "broken",
            "nodes": [
                {"node_type": "reader", "name": "read", "local_id": "reader", "params": {}},
                {"node_type": "filter", "name": "Clip", "input_id": "ghost", "params": {}},
            ],
        },
    )
    assert resp.status_code == 422
    assert "input_id" in resp.text


def test_create_pipeline_rejects_dataset_from_another_project(client, data_dir):
    owner = _new_project(client, "pipe-ds-owner")
    other = _new_project(client, "pipe-ds-other")
    ds = _upload_vtp(client, owner, data_dir)

    resp = client.post(
        "/pipelines",
        json={
            "project_id": other,
            "name": "cross-project",
            "nodes": [
                {"node_type": "reader", "name": "read", "dataset_id": ds["id"], "params": {}},
            ],
        },
    )
    assert resp.status_code == 422
    assert "different project" in resp.text


def test_patch_pipeline_renames_without_touching_nodes(client, data_dir):
    pid = _new_project(client, "pipe-rename")
    ds = _upload_vtp(client, pid, data_dir)
    created = client.post(
        "/pipelines",
        json={
            "project_id": pid,
            "name": "before",
            "nodes": [
                {"node_type": "reader", "name": "read", "dataset_id": ds["id"], "params": {}},
            ],
        },
    ).json()
    node_ids = [node["id"] for node in created["nodes"]]

    patched = client.patch(f"/pipelines/{created['id']}", json={"name": "after"})
    assert patched.status_code == 200
    body = patched.json()
    assert body["name"] == "after"
    assert [node["id"] for node in body["nodes"]] == node_ids


def test_patch_pipeline_replaces_node_set(client, data_dir):
    pid = _new_project(client, "pipe-replace")
    ds = _upload_vtp(client, pid, data_dir)
    created = client.post(
        "/pipelines",
        json={
            "project_id": pid,
            "name": "replace-nodes",
            "nodes": [
                {"node_type": "reader", "name": "read", "local_id": "r1",
                 "dataset_id": ds["id"], "params": {}},
                {"node_type": "filter", "name": "Clip", "local_id": "f1",
                 "input_id": "r1", "params": {"axis": "x", "value": 0.5}},
            ],
        },
    ).json()
    old_node_ids = {node["id"] for node in created["nodes"]}
    assert len(old_node_ids) == 2

    patched = client.patch(
        f"/pipelines/{created['id']}",
        json={
            "nodes": [
                {"node_type": "representation", "name": "surface",
                 "params": {"color_by": "temperature"}},
            ],
        },
    )
    assert patched.status_code == 200
    body = patched.json()
    assert len(body["nodes"]) == 1
    assert body["nodes"][0]["node_type"] == "representation"
    assert body["nodes"][0]["id"] not in old_node_ids
    assert body["name"] == "replace-nodes"

    fetched = client.get(f"/pipelines/{created['id']}").json()
    assert [node["node_type"] for node in fetched["nodes"]] == ["representation"]


def test_delete_pipeline_removes_it_from_list(client, data_dir):
    pid = _new_project(client, "pipe-delete")
    ds = _upload_vtp(client, pid, data_dir)
    created = client.post(
        "/pipelines",
        json={
            "project_id": pid,
            "name": "doomed",
            "nodes": [
                {"node_type": "reader", "name": "read", "local_id": "r1",
                 "dataset_id": ds["id"], "params": {}},
                {"node_type": "representation", "name": "view", "input_id": "r1", "params": {}},
            ],
        },
    ).json()

    assert client.delete(f"/pipelines/{created['id']}").status_code == 204
    assert client.get(f"/pipelines/{created['id']}").status_code == 404
    listed = client.get(f"/pipelines?project_id={pid}")
    assert listed.status_code == 200
    assert all(pipeline["id"] != created["id"] for pipeline in listed.json())
