"""Lease-release guarantees of LeasedFileResponse (app/responses.py)."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.responses import LeasedFileResponse


class RecordingStore:
    """ObjectStore stand-in that records every release_path call."""

    def __init__(self) -> None:
        self.released: list[str] = []

    def release_path(self, key: str) -> None:
        self.released.append(key)


def _scope(headers: tuple = ()) -> dict:
    return {"type": "http", "method": "GET", "headers": list(headers)}


async def _receive() -> dict:
    return {"type": "http.disconnect"}


@pytest.fixture
def payload_file(tmp_path) -> Path:
    path = tmp_path / "payload.bin"
    path.write_bytes(b"payload")
    return path


def test_release_fires_exactly_once_after_successful_send(payload_file) -> None:
    store = RecordingStore()
    response = LeasedFileResponse(payload_file, store=store, object_key="obj-key")
    events: list = []

    async def send(message) -> None:
        assert store.released == [], "lease must be held until the send completes"
        events.append(message["type"])

    asyncio.run(response(_scope(), _receive, send))

    assert events[0] == "http.response.start"
    assert store.released == ["obj-key"]


def test_release_fires_exactly_once_when_send_raises(payload_file) -> None:
    store = RecordingStore()
    response = LeasedFileResponse(payload_file, store=store, object_key="obj-key")

    async def send(message) -> None:
        if message["type"] == "http.response.body":
            raise OSError("client disconnected")

    with pytest.raises(OSError, match="client disconnected"):
        asyncio.run(response(_scope(), _receive, send))

    assert store.released == ["obj-key"]


@pytest.mark.parametrize(
    ("range_header", "expected_status"),
    [
        (b"wat", 400),
        (b"bytes=999-1000", 416),
    ],
)
def test_release_fires_on_range_early_returns(payload_file, range_header, expected_status) -> None:
    store = RecordingStore()
    response = LeasedFileResponse(payload_file, store=store, object_key="obj-key")
    statuses: list[int] = []

    async def send(message) -> None:
        if message["type"] == "http.response.start":
            statuses.append(message["status"])

    asyncio.run(response(_scope(((b"range", range_header),)), _receive, send))

    assert statuses == [expected_status]
    assert store.released == ["obj-key"]


def test_release_is_idempotent_across_repeat_calls(payload_file) -> None:
    store = RecordingStore()
    response = LeasedFileResponse(payload_file, store=store, object_key="obj-key")

    async def send(message) -> None:
        pass

    asyncio.run(response(_scope(), _receive, send))
    response._release_lease()
    response._release_lease()

    assert store.released == ["obj-key"]
