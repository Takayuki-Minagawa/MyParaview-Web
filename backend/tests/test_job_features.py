"""Job listing filters, pagination, stats jobs, capability failures, and SSE stream."""

from __future__ import annotations

import json
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


def _ingested_dataset(client, data_dir, project_id: str) -> dict:
    dataset = _upload(client, project_id, data_dir / "sample_surface.vtp")
    ingest = client.post(f"/datasets/{dataset['id']}/ingest")
    assert ingest.status_code == 202
    assert wait_for_job(client, ingest.json()["id"])["status"] == "succeeded"
    return dataset


def test_list_jobs_filters_by_status(client, data_dir):
    project_id = _project(client, "job-status-filter")
    dataset = _upload(client, project_id, data_dir / "sample_surface.vtp")
    ingest = client.post(f"/datasets/{dataset['id']}/ingest").json()
    assert wait_for_job(client, ingest["id"])["status"] == "succeeded"

    render = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "render",
            "target_id": dataset["id"],
            "params": {},
        },
    ).json()
    assert wait_for_job(client, render["id"])["status"] == "failed"

    succeeded = client.get(f"/jobs?project_id={project_id}&status=succeeded")
    assert succeeded.status_code == 200
    succeeded_ids = {job["id"] for job in succeeded.json()}
    assert all(job["status"] == "succeeded" for job in succeeded.json())
    assert ingest["id"] in succeeded_ids
    assert render["id"] not in succeeded_ids

    failed = client.get(f"/jobs?project_id={project_id}&status=failed")
    assert {job["id"] for job in failed.json()} == {render["id"]}


def test_list_jobs_pagination(client, data_dir):
    project_id = _project(client, "job-pagination")
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
    ).json()
    assert wait_for_job(client, export["id"])["status"] == "succeeded"

    full = client.get(f"/jobs?project_id={project_id}").json()
    assert len(full) >= 2
    full_ids = {job["id"] for job in full}

    paged_ids: set[str] = set()
    for offset in range(len(full)):
        page = client.get(f"/jobs?project_id={project_id}&limit=1&offset={offset}")
        assert page.status_code == 200
        body = page.json()
        assert len(body) == 1
        paged_ids.add(body[0]["id"])
    assert paged_ids == full_ids

    beyond = client.get(f"/jobs?project_id={project_id}&limit=1&offset={len(full)}")
    assert beyond.json() == []


def test_list_jobs_requires_project_id(client):
    assert client.get("/jobs").status_code == 422


def test_stats_job_produces_json_artifact(client, data_dir):
    project_id = _project(client, "job-stats")
    dataset = _ingested_dataset(client, data_dir, project_id)

    created = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "stats",
            "target_id": dataset["id"],
            "params": {"bins": 8},
        },
    )
    assert created.status_code == 202, created.text
    finished = wait_for_job(client, created.json()["id"])
    assert finished["status"] == "succeeded", finished

    listed = client.get(f"/artifacts?dataset_id={dataset['id']}").json()
    stats_artifacts = [item for item in listed if item["kind"] == "stats_json"]
    assert len(stats_artifacts) == 1
    artifact = stats_artifacts[0]
    assert artifact["id"] == finished["result"]["artifact_id"]
    assert artifact["filename"].endswith("-stats.json")

    downloaded = client.get(f"/artifacts/{artifact['id']}")
    assert downloaded.status_code == 200
    payload = downloaded.json()
    assert payload["dataset_id"] == dataset["id"]
    assert payload["bins"] == 8
    arrays = payload["arrays"]
    assert arrays
    first = arrays[0]
    assert {"name", "min", "max", "mean", "stddev", "histogram"} <= set(first)
    for entry in arrays:
        histogram = entry["histogram"]
        assert histogram["bins"] == 8
        assert sum(histogram["counts"]) == entry["count"]
    named = {entry["name"]: entry for entry in arrays}
    assert named["temperature"]["min"] == 10.0
    assert named["temperature"]["max"] == 40.0
    assert named["temperature"]["mean"] == 25.0


def test_stats_job_rejects_invalid_bins(client, data_dir):
    project_id = _project(client, "job-stats-bins")
    dataset = _ingested_dataset(client, data_dir, project_id)
    rejected = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "stats",
            "target_id": dataset["id"],
            "params": {"bins": 0},
        },
    )
    assert rejected.status_code == 422


def test_render_job_without_worker_fails_with_capability_error(client, data_dir):
    project_id = _project(client, "job-render")
    dataset = _ingested_dataset(client, data_dir, project_id)
    created = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "render",
            "target_id": dataset["id"],
            "params": {"width": 320, "height": 240},
        },
    )
    assert created.status_code == 202, created.text
    finished = wait_for_job(client, created.json()["id"])
    assert finished["status"] == "failed"
    assert "PVWEB_PVPYTHON" in finished["log"]


def test_movie_job_without_worker_fails_with_capability_error(client, data_dir):
    project_id = _project(client, "job-movie")
    dataset = _ingested_dataset(client, data_dir, project_id)
    created = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "movie",
            "target_id": dataset["id"],
            "params": {},
        },
    )
    assert created.status_code == 202, created.text
    finished = wait_for_job(client, created.json()["id"])
    assert finished["status"] == "failed"
    assert "PVWEB_PVPYTHON" in finished["log"]


def test_jobs_stream_emits_existing_job_snapshot(client, data_dir):
    project_id = _project(client, "job-stream")
    dataset = _upload(client, project_id, data_dir / "sample_surface.vtp")
    ingest = client.post(f"/datasets/{dataset['id']}/ingest").json()
    assert wait_for_job(client, ingest["id"])["status"] == "succeeded"

    with client.stream("GET", f"/jobs/stream?project_id={project_id}") as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        seen = None
        # The first poll tick snapshots every existing job immediately.
        for line in response.iter_lines():
            if line.startswith("data: "):
                seen = json.loads(line[len("data: "):])
                break
        assert seen is not None
        assert seen["project_id"] == project_id
        assert seen["id"] == ingest["id"]
