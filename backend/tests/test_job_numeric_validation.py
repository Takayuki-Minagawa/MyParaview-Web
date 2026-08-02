"""Regression coverage for numeric job parameter request validation."""

from __future__ import annotations

import pytest

from app.schemas import JobCreate


def _job_payload(kind: str, params: dict) -> dict:
    return {
        "project_id": "project-id",
        "kind": kind,
        "target_id": "dataset-id",
        "params": params,
    }


@pytest.mark.parametrize(
    ("kind", "params"),
    [
        ("render", {"width": None}),
        ("render", {"height": []}),
        ("render", {"width": True}),
        ("render", {"height": 240.5}),
        ("render", {"width": "320.5"}),
        ("stats", {"bins": None}),
        ("stats", {"bins": []}),
        ("stats", {"bins": False}),
        ("stats", {"bins": 8.5}),
        ("stats", {"bins": "8.5"}),
        ("movie", {"fps": None}),
        ("movie", {"fps": []}),
        ("movie", {"fps": False}),
        ("movie", {"fps": 23.5}),
        ("movie", {"fps": "23.5"}),
    ],
)
def test_invalid_integer_job_params_return_422(client, kind, params):
    response = client.post("/jobs", json=_job_payload(kind, params))

    assert response.status_code == 422
    assert "must be an integer" in response.text


@pytest.mark.parametrize(
    ("kind", "params", "expected"),
    [
        ("render", {"width": "320", "height": 240.0}, {"width": 320, "height": 240}),
        ("stats", {"bins": "8"}, {"bins": 8}),
        ("stats", {"bins": 8.0}, {"bins": 8}),
        (
            "movie",
            {"format": "mp4", "fps": "30", "width": 640.0, "height": 360},
            {"format": "mp4", "fps": 30, "width": 640, "height": 360},
        ),
    ],
)
def test_integer_like_job_params_are_normalized(kind, params, expected):
    job = JobCreate.model_validate(_job_payload(kind, params))

    assert job.params == expected


@pytest.mark.parametrize(
    ("params", "message"),
    [
        ({"format": None}, "format must be zip, mp4, or webm"),
        ({"format": "MP4"}, "format must be zip, mp4, or webm"),
        ({"format": "gif"}, "format must be zip, mp4, or webm"),
        ({"fps": 0}, "fps must be between 1 and 120"),
        ({"fps": 121}, "fps must be between 1 and 120"),
    ],
)
def test_invalid_movie_params_return_422(client, params, message):
    response = client.post("/jobs", json=_job_payload("movie", params))

    assert response.status_code == 422
    assert message in response.text


def test_movie_defaults_keep_legacy_zip_and_strip_client_executable():
    job = JobCreate.model_validate(
        _job_payload("movie", {"ffmpeg_executable": "/tmp/not-trusted"})
    )

    assert job.params == {
        "width": 1280,
        "height": 960,
        "format": "zip",
        "fps": 24,
    }


@pytest.mark.parametrize(
    ("params", "message"),
    [
        ({"filter": "resample"}, "dimensions must contain three integers"),
        (
            {"filter": "resample", "dimensions": [32, 32]},
            "dimensions must contain three integers",
        ),
        (
            {"filter": "resample", "dimensions": [32, True, 32]},
            "dimensions values must be an integer",
        ),
        (
            {"filter": "resample", "dimensions": [32, 4.5, 32]},
            "dimensions values must be an integer",
        ),
        (
            {"filter": "resample", "dimensions": [1, 32, 32]},
            "dimensions values must be between 2 and 512",
        ),
        (
            {"filter": "resample", "dimensions": [32, 32, 513]},
            "dimensions values must be between 2 and 512",
        ),
        (
            {"filter": "resample", "dimensions": [512, 512, 65]},
            "dimensions product must not exceed 16777216 samples",
        ),
        (
            {"filter": "decimate"},
            "target_reduction must be a finite number",
        ),
        (
            {"filter": "decimate", "target_reduction": "0.5"},
            "target_reduction must be a finite number",
        ),
        (
            {"filter": "decimate", "target_reduction": -0.01},
            "target_reduction must be greater than or equal to 0 and less than 1",
        ),
        (
            {"filter": "decimate", "target_reduction": 1},
            "target_reduction must be greater than or equal to 0 and less than 1",
        ),
    ],
)
def test_invalid_new_filter_params_return_422(client, params, message):
    response = client.post("/jobs", json=_job_payload("filter", params))

    assert response.status_code == 422
    assert message in response.text


@pytest.mark.parametrize(
    ("params", "expected"),
    [
        ({"filter": "CELL_TO_POINT"}, {"filter": "cell_to_point"}),
        (
            {"filter": "RESAMPLE", "dimensions": ["16", 24.0, 32]},
            {"filter": "resample", "dimensions": [16, 24, 32]},
        ),
        (
            {"filter": "resample", "dimensions": [256, 256, 256]},
            {"filter": "resample", "dimensions": [256, 256, 256]},
        ),
        (
            {"filter": "DECIMATE", "target_reduction": 0.5},
            {"filter": "decimate", "target_reduction": 0.5},
        ),
    ],
)
def test_new_filter_params_are_normalized(params, expected):
    job = JobCreate.model_validate(_job_payload("filter", params))

    assert job.params == expected


def test_client_job_kind_is_an_openapi_enum():
    kind_schema = JobCreate.model_json_schema()["properties"]["kind"]

    assert kind_schema["enum"] == [
        "convert",
        "filter",
        "export",
        "render",
        "stats",
        "movie",
    ]
