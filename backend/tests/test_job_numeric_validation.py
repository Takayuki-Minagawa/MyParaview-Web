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
    ],
)
def test_integer_like_job_params_are_normalized(kind, params, expected):
    job = JobCreate.model_validate(_job_payload(kind, params))

    assert job.params == expected
