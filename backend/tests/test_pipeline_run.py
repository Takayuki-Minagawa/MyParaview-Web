"""Server-side pipeline execution (POST /pipelines/{id}/run) validation and jobs."""

from __future__ import annotations

import uuid

from conftest import wait_for_job


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


def _pipeline(client, project_id: str, nodes: list[dict]) -> dict:
    response = client.post(
        "/pipelines",
        json={"project_id": project_id, "name": _unique("run"), "nodes": nodes},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_run_rejects_pipeline_without_filter_nodes(client, data_dir):
    project_id = _project(client, "pipeline-run-nofilter")
    dataset = _upload(client, project_id, data_dir / "sample_surface.vtp")
    pipeline = _pipeline(
        client,
        project_id,
        [
            {"node_type": "reader", "name": "read", "local_id": "r1",
             "dataset_id": dataset["id"], "params": {}},
            {"node_type": "representation", "name": "view", "input_id": "r1",
             "params": {}},
        ],
    )
    response = client.post(f"/pipelines/{pipeline['id']}/run")
    assert response.status_code == 422
    assert "no filter nodes" in response.text


def test_run_valid_slice_chain_fails_without_worker(client, data_dir):
    project_id = _project(client, "pipeline-run-slice")
    dataset = _upload(client, project_id, data_dir / "sample_surface.vtp")
    ingest = client.post(f"/datasets/{dataset['id']}/ingest").json()
    assert wait_for_job(client, ingest["id"])["status"] == "succeeded"
    pipeline = _pipeline(
        client,
        project_id,
        [
            {"node_type": "reader", "name": "read", "local_id": "r1",
             "dataset_id": dataset["id"], "params": {}},
            {"node_type": "filter", "name": "Slice", "local_id": "f1", "input_id": "r1",
             "params": {"filter": "slice", "origin": [0, 0, 0], "normal": [0, 0, 1]}},
        ],
    )
    response = client.post(f"/pipelines/{pipeline['id']}/run")
    assert response.status_code == 202, response.text
    job = response.json()
    assert job["kind"] == "pipeline"
    assert job["target_id"] == dataset["id"]
    assert job["params"]["pipeline_id"] == pipeline["id"]
    assert job["params"]["filters"] == [
        {"filter": "slice", "origin": [0, 0, 0], "normal": [0, 0, 1]}
    ]
    # No ParaView worker is configured in tests, so execution fails honestly.
    finished = wait_for_job(client, job["id"])
    assert finished["status"] == "failed"
    assert "PVWEB_PVPYTHON" in finished["log"]


def test_run_executes_complete_filter_chain_in_one_worker_call(
    client, data_dir, monkeypatch
):
    project_id = _project(client, "pipeline-run-chain")
    dataset = _upload(client, project_id, data_dir / "sample_surface.vtp")
    pipeline = _pipeline(
        client,
        project_id,
        [
            {
                "node_type": "reader",
                "name": "read",
                "local_id": "r1",
                "dataset_id": dataset["id"],
                "params": {},
            },
            {
                "node_type": "filter",
                "name": "first threshold",
                "local_id": "f1",
                "input_id": "r1",
                "params": {
                    "filter": "threshold",
                    "array": "temperature",
                    "association": "POINTS",
                    "minimum": 0,
                    "maximum": 100,
                },
            },
            {
                "node_type": "filter",
                "name": "second threshold",
                "local_id": "f2",
                "input_id": "f1",
                "params": {
                    "filter": "threshold",
                    "array": "temperature",
                    "association": "POINTS",
                    "minimum": 20,
                    "maximum": 30,
                },
            },
        ],
    )
    calls = []

    def fake_pipeline_transform(source, output, filters, _ctx):
        calls.append((source, output, filters))
        output.write_bytes((data_dir / "sample_surface.vtp").read_bytes())

    monkeypatch.setattr(
        "app.services.run_pipeline_transform", fake_pipeline_transform
    )

    response = client.post(f"/pipelines/{pipeline['id']}/run")
    assert response.status_code == 202, response.text
    finished = wait_for_job(client, response.json()["id"])

    assert finished["status"] == "succeeded", finished
    assert len(calls) == 1
    assert calls[0][0].name.endswith(".vtp")
    assert calls[0][1].name.endswith("-pipeline.vtp")
    assert [item["filter"] for item in calls[0][2]] == [
        "threshold",
        "threshold",
    ]


def test_run_rejects_invalid_filter_params(client, data_dir):
    project_id = _project(client, "pipeline-run-bogus")
    dataset = _upload(client, project_id, data_dir / "sample_surface.vtp")
    pipeline = _pipeline(
        client,
        project_id,
        [
            {"node_type": "reader", "name": "read", "local_id": "r1",
             "dataset_id": dataset["id"], "params": {}},
            {"node_type": "filter", "name": "Bogus", "local_id": "f1", "input_id": "r1",
             "params": {"filter": "bogus"}},
        ],
    )
    response = client.post(f"/pipelines/{pipeline['id']}/run")
    assert response.status_code == 422
    assert "pipeline node params invalid" in response.text


def test_run_rejects_reader_without_dataset(client):
    project_id = _project(client, "pipeline-run-nodataset")
    pipeline = _pipeline(
        client,
        project_id,
        [
            {"node_type": "reader", "name": "read", "local_id": "r1", "params": {}},
            {"node_type": "filter", "name": "Slice", "local_id": "f1", "input_id": "r1",
             "params": {"filter": "slice", "origin": [0, 0, 0], "normal": [0, 0, 1]}},
        ],
    )
    response = client.post(f"/pipelines/{pipeline['id']}/run")
    assert response.status_code == 422
    assert "reader has no dataset" in response.text
