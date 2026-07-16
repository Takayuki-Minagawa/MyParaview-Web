"""Test configuration: isolate data root/db before the app package imports."""

from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="pvweb-test-")
os.environ["PVWEB_DATA_ROOT"] = _TMP
os.environ["PVWEB_DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
os.environ["PVWEB_AUTH_MODE"] = "dev"
os.environ["PVWEB_ALLOW_INSECURE_DEV_AUTH"] = "1"
# Keep /jobs/stream teardown from stalling the suite for the full 5 minutes.
os.environ["PVWEB_JOB_STREAM_MAX_SECONDS"] = "2"

import pytest  # noqa: E402
from app.db import init_db  # noqa: E402
from app.main import app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

DATA_DIR = Path(__file__).parent / "data"


@pytest.fixture(scope="session")
def client() -> TestClient:
    init_db()
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def data_dir() -> Path:
    return DATA_DIR


def wait_for_job(client: TestClient, job_id: str, *, timeout: float = 10.0) -> dict:
    """Poll a job until it reaches a terminal state or times out."""
    deadline = time.time() + timeout
    terminal = {"succeeded", "failed", "canceled"}
    while time.time() < deadline:
        resp = client.get(f"/jobs/{job_id}")
        resp.raise_for_status()
        body = resp.json()
        if body["status"] in terminal:
            return body
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish within {timeout}s")
