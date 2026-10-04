"""Ingest must keep Dataset/Job JSON readable after malformed numeric input."""

from __future__ import annotations

import pytest

from app.metadata import DatasetMetadata
from conftest import wait_for_job


def _ingest(client, filename, contents):
    project_id = client.post("/projects", json={"name": "metadata safety"}).json()["id"]
    uploaded = client.post(
        f"/projects/{project_id}/datasets",
        files={"file": (filename, contents, "application/xml")},
    )
    assert uploaded.status_code == 201
    dataset_id = uploaded.json()["id"]
    submitted = client.post(f"/datasets/{dataset_id}/ingest")
    assert submitted.status_code == 202
    job = wait_for_job(client, submitted.json()["id"])
    dataset = client.get(f"/datasets/{dataset_id}")
    assert dataset.status_code == 200
    listed = client.get(f"/projects/{project_id}/datasets")
    assert listed.status_code == 200
    assert listed.json() == [dataset.json()]
    return job, dataset.json()


def test_non_finite_point_bounds_do_not_break_dataset_or_job_reads(client):
    job, dataset = _ingest(
        client,
        "nan.vtp",
        '<VTKFile type="PolyData"><PolyData><Piece NumberOfPoints="1">'
        '<Points><DataArray format="ascii">nan 0 0</DataArray></Points>'
        '</Piece></PolyData></VTKFile>',
    )
    assert job["status"] == "succeeded"
    assert dataset["status"] == "ready"
    assert dataset["bounds"] is None
    assert "bounds" not in job["result"]["metadata"]


@pytest.mark.parametrize(
    "geometry",
    ['Origin="nan 0 0"', 'Spacing="1e308 1 1"'],
)
def test_invalid_image_geometry_leaves_readable_error_state(client, geometry):
    job, dataset = _ingest(
        client,
        "invalid.vti",
        '<VTKFile type="ImageData">'
        f'<ImageData WholeExtent="0 2 0 1 0 1" {geometry}/>'
        '</VTKFile>',
    )
    assert job["status"] == "failed"
    assert dataset["status"] == "error"
    assert "must be finite" in dataset["error"]
    assert dataset["bounds"] is None
    assert dataset["extra"] is None


def test_ingest_validates_reader_metadata_inside_error_handler(client, monkeypatch):
    monkeypatch.setattr(
        "app.services._ingest_single_metadata",
        lambda *_args: DatasetMetadata(
            dataset_type="External", extra={"nested": {"value": float("inf")}}
        ),
    )
    job, dataset = _ingest(
        client, "reader.vtp", '<VTKFile type="PolyData"><PolyData/></VTKFile>'
    )
    assert job["status"] == "failed"
    assert dataset["status"] == "error"
    assert "JSON-compatible finite values" in dataset["error"]
    assert dataset["extra"] is None
