"""Job listing filters, pagination, stats jobs, capability failures, and SSE stream."""

from __future__ import annotations

import json
import uuid

import pytest

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


def test_video_export_capability_requires_pvpython_and_executable_ffmpeg(
    client, tmp_path, monkeypatch
):
    from app.config import settings

    executable = tmp_path / "ffmpeg"
    executable.write_text("#!/bin/sh\nexit 0\n")
    executable.chmod(0o700)

    monkeypatch.setattr(settings, "worker_command", [])
    monkeypatch.setattr(settings, "ffmpeg_executable", str(executable))
    assert client.get("/capabilities").json()["video_export"] is False

    monkeypatch.setattr(settings, "worker_command", ["pvpython"])
    assert client.get("/capabilities").json()["video_export"] is True

    monkeypatch.setattr(settings, "ffmpeg_executable", str(tmp_path / "missing"))
    assert client.get("/capabilities").json()["video_export"] is False


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


def test_video_movie_without_ffmpeg_fails_explicitly(client, data_dir, monkeypatch):
    from app.config import settings

    project_id = _project(client, "job-video-no-ffmpeg")
    dataset = _ingested_dataset(client, data_dir, project_id)
    monkeypatch.setattr(settings, "ffmpeg_executable", "")
    created = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "movie",
            "target_id": dataset["id"],
            "params": {"format": "mp4", "fps": 30},
        },
    )
    assert created.status_code == 202, created.text
    finished = wait_for_job(client, created.json()["id"])
    assert finished["status"] == "failed"
    assert "PVWEB_FFMPEG" in finished["log"]
    assert client.get(f"/artifacts?job_id={created.json()['id']}").json() == []


def test_video_movie_without_pvpython_fails_after_ffmpeg_validation(
    client, data_dir, tmp_path, monkeypatch
):
    from app.config import settings

    project_id = _project(client, "job-video-no-pvpython")
    dataset = _ingested_dataset(client, data_dir, project_id)
    executable = tmp_path / "ffmpeg"
    executable.write_text("#!/bin/sh\nexit 0\n")
    executable.chmod(0o700)
    monkeypatch.setattr(settings, "ffmpeg_executable", str(executable))
    monkeypatch.setattr(settings, "worker_command", [])
    created = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "movie",
            "target_id": dataset["id"],
            "params": {"format": "webm", "fps": 30},
        },
    )
    assert created.status_code == 202, created.text
    finished = wait_for_job(client, created.json()["id"])
    assert finished["status"] == "failed"
    assert "PVWEB_PVPYTHON" in finished["log"]
    assert client.get(f"/artifacts?job_id={created.json()['id']}").json() == []


def test_legacy_movie_default_still_creates_frame_png_zip(
    client, data_dir, monkeypatch
):
    import io
    import zipfile

    project_id = _project(client, "job-movie-legacy-zip")
    dataset = _ingested_dataset(client, data_dir, project_id)

    def fake_frames(_source, frames_dir, params, _ctx):
        assert params["format"] == "zip"
        frames_dir.mkdir(parents=True)
        frames = [frames_dir / "frame-0000.png", frames_dir / "frame-0001.png"]
        for index, frame in enumerate(frames):
            frame.write_bytes(b"png" + bytes([index]))
        return frames

    monkeypatch.setattr("app.services.run_movie_frames", fake_frames)
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
    assert created.json()["params"] == {
        "width": 1280,
        "height": 960,
        "format": "zip",
        "fps": 24,
    }
    finished = wait_for_job(client, created.json()["id"])
    assert finished["status"] == "succeeded", finished
    artifact_id = finished["result"]["artifact_id"]
    listed = client.get(f"/artifacts?job_id={created.json()['id']}").json()
    assert [(item["kind"], item["filename"], item["content_type"]) for item in listed] == [
        ("movie_frames", "sample_surface-movie.zip", "application/zip")
    ]
    downloaded = client.get(f"/artifacts/{artifact_id}")
    with zipfile.ZipFile(io.BytesIO(downloaded.content)) as archive:
        assert archive.namelist() == ["frame-0000.png", "frame-0001.png"]


@pytest.mark.parametrize(
    ("output_format", "content_type"),
    [("mp4", "video/mp4"), ("webm", "video/webm")],
)
def test_video_movie_creates_typed_artifact(
    client, data_dir, monkeypatch, output_format, content_type
):
    project_id = _project(client, f"job-movie-{output_format}")
    dataset = _ingested_dataset(client, data_dir, project_id)

    def fake_video(_source, output, params, _ctx):
        assert params["format"] == output_format
        assert params["fps"] == 30
        output.write_bytes(f"fake-{output_format}".encode())
        return 4

    monkeypatch.setattr("app.services.run_movie_video", fake_video)
    created = client.post(
        "/jobs",
        json={
            "project_id": project_id,
            "kind": "movie",
            "target_id": dataset["id"],
            "params": {
                "format": output_format,
                "fps": 30,
                "width": 640,
                "height": 360,
            },
        },
    )
    assert created.status_code == 202, created.text
    finished = wait_for_job(client, created.json()["id"])
    assert finished["status"] == "succeeded", finished
    assert finished["result"]["format"] == output_format
    assert finished["result"]["fps"] == 30
    assert finished["result"]["frame_count"] == 4
    listed = client.get(f"/artifacts?job_id={created.json()['id']}").json()
    assert len(listed) == 1
    artifact = listed[0]
    assert artifact["kind"] == "movie_video"
    assert artifact["filename"] == f"sample_surface-movie.{output_format}"
    assert artifact["content_type"] == content_type
    downloaded = client.get(f"/artifacts/{artifact['id']}")
    assert downloaded.headers["content-type"].startswith(content_type)
    assert downloaded.content == f"fake-{output_format}".encode()


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


def test_stream_cursor_delivers_jobs_sharing_the_boundary_timestamp():
    """A job committed with the same updated_at as the cursor must still stream."""
    from app.routers.jobs import filter_new_job_events

    t2 = "2026-07-10T00:00:02"
    job_a = ({"id": "a"}, t2, "a")
    job_b = ({"id": "b"}, t2, "b")

    # Tick 1: only A exists at the boundary timestamp.
    events, cursor, emitted = filter_new_job_events([job_a], None, set())
    assert [event["id"] for event in events] == ["a"]
    assert cursor == t2 and emitted == {"a"}

    # Tick 2: B was committed later with an identical updated_at. The >= query
    # returns both rows; only the already-sent pair (t2, a) is filtered.
    events, cursor, emitted = filter_new_job_events([job_a, job_b], cursor, emitted)
    assert [event["id"] for event in events] == ["b"]
    assert cursor == t2 and emitted == {"a", "b"}

    # Tick 3: nothing new — no re-emission of either job.
    events, cursor, emitted = filter_new_job_events([job_a, job_b], cursor, emitted)
    assert events == []

    # A later update resets the emitted set at the new boundary.
    job_a_updated = ({"id": "a", "status": "succeeded"}, "2026-07-10T00:00:03", "a")
    events, cursor, emitted = filter_new_job_events(
        [job_a, job_b, job_a_updated], cursor, emitted
    )
    assert [event.get("status") for event in events] == ["succeeded"]
    assert emitted == {"a"}
    assert cursor == "2026-07-10T00:00:03"
