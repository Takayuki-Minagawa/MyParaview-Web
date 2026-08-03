from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from app.config import settings
from app.jobs import JobCancelled, JobContext
from app.worker import (
    WorkerUnavailable,
    _resolve_ffmpeg_executable,
    _run,
    resolve_ffmpeg_executable,
    run_movie_video,
    run_pipeline_transform,
)


def test_pipeline_transform_uses_one_worker_command_with_complete_chain(
    tmp_path, monkeypatch
):
    source = tmp_path / "source.vtu"
    source.write_text("source")
    output = tmp_path / "result.vtp"
    filters = [
        {
            "filter": "clip",
            "origin": [0, 0, 0],
            "normal": [1, 0, 0],
        },
        {
            "filter": "threshold",
            "array": "temperature",
            "association": "POINTS",
            "minimum": 10,
            "maximum": 20,
        },
    ]
    commands = []

    monkeypatch.setattr(
        "app.worker._command", lambda *args: ["pvpython", *args]
    )

    def fake_run(command, _ctx):
        commands.append(command)
        Path(command[-2]).write_text("vtp")

    monkeypatch.setattr("app.worker._run", fake_run)
    context = JobContext("test", threading.Event())

    run_pipeline_transform(source, output, filters, context)

    params_path = output.with_suffix(".json")
    assert commands == [
        ["pvpython", "pipeline", str(source), str(output), str(params_path)]
    ]
    assert json.loads(params_path.read_text()) == {"filters": filters}


def test_ffmpeg_must_be_configured_and_executable(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "ffmpeg_executable", "")
    with pytest.raises(WorkerUnavailable, match="PVWEB_FFMPEG"):
        resolve_ffmpeg_executable()

    missing = tmp_path / "missing-ffmpeg"
    monkeypatch.setattr(settings, "ffmpeg_executable", str(missing))
    with pytest.raises(WorkerUnavailable, match="not found or is not executable"):
        resolve_ffmpeg_executable()

    executable = tmp_path / "ffmpeg"
    executable.write_text("#!/bin/sh\nexit 0\n")
    executable.chmod(0o700)
    monkeypatch.setattr(settings, "ffmpeg_executable", str(executable))
    assert resolve_ffmpeg_executable() == str(executable.resolve())


def test_ffmpeg_resolution_is_cached_per_operator_setting(tmp_path, monkeypatch):
    executable = tmp_path / "ffmpeg"
    executable.write_text("#!/bin/sh\nexit 0\n")
    executable.chmod(0o700)
    calls = 0

    def counted_which(configured):
        nonlocal calls
        calls += 1
        return str(executable) if configured == "cached-ffmpeg" else None

    _resolve_ffmpeg_executable.cache_clear()
    monkeypatch.setattr(settings, "ffmpeg_executable", "cached-ffmpeg")
    monkeypatch.setattr("app.worker.shutil.which", counted_which)
    assert resolve_ffmpeg_executable() == str(executable.resolve())
    assert resolve_ffmpeg_executable() == str(executable.resolve())
    assert calls == 1

    monkeypatch.setattr(settings, "ffmpeg_executable", "missing-cached-ffmpeg")
    with pytest.raises(WorkerUnavailable):
        resolve_ffmpeg_executable()
    with pytest.raises(WorkerUnavailable):
        resolve_ffmpeg_executable()
    assert calls == 2


def test_movie_video_passes_trusted_ffmpeg_path_through_worker_params(
    tmp_path, monkeypatch
):
    source = tmp_path / "source.pvd"
    source.write_text("source")
    output = tmp_path / "unsafe name;still-safe.mp4"
    executable = tmp_path / "trusted ffmpeg"
    executable.write_text("#!/bin/sh\nexit 0\n")
    executable.chmod(0o700)
    monkeypatch.setattr(settings, "ffmpeg_executable", str(executable))
    monkeypatch.setattr("app.worker._command", lambda *args: ["pvpython", *args])
    commands = []

    def fake_run(command, _ctx):
        commands.append(command)
        output.write_bytes(b"video")
        return subprocess.CompletedProcess(
            command, 0, 'ParaView info\n{"frame_count": 3}\n', ""
        )

    monkeypatch.setattr("app.worker._run", fake_run)
    context = JobContext("test", threading.Event())

    frame_count = run_movie_video(
        source,
        output,
        {
            "format": "mp4",
            "fps": 30,
            "ffmpeg_executable": "/client/cannot/select/this",
        },
        context,
    )

    params_path = output.with_suffix(".json")
    assert frame_count == 3
    assert commands == [
        ["pvpython", "movie", str(source), str(output), str(params_path)]
    ]
    worker_params = json.loads(params_path.read_text())
    assert worker_params["ffmpeg_executable"] == str(executable.resolve())
    assert worker_params["format"] == "mp4"


def test_worker_drains_large_stdout_without_pipe_deadlock(monkeypatch):
    monkeypatch.setattr(settings, "worker_timeout_seconds", 3)
    context = JobContext("test", threading.Event())
    result = _run(
        [sys.executable, "-c", "import sys; sys.stdout.write('x' * 2_000_000)"],
        context,
    )
    assert len(result.stdout) == 2_000_000


def test_worker_cancellation_terminates_child(monkeypatch):
    monkeypatch.setattr(settings, "worker_timeout_seconds", 10)
    event = threading.Event()
    context = JobContext("test", event)
    timer = threading.Timer(0.1, event.set)
    timer.start()
    try:
        with pytest.raises(JobCancelled):
            _run([sys.executable, "-c", "import time; time.sleep(10)"], context)
    finally:
        timer.cancel()


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process-group regression")
def test_worker_timeout_kills_descendant_processes(monkeypatch):
    monkeypatch.setattr(settings, "worker_timeout_seconds", 0.2)
    context = JobContext("test", threading.Event())
    child = "import time; time.sleep(5)"
    parent = (
        "import subprocess,sys,time; "
        f"subprocess.Popen([sys.executable,'-c',{child!r}]); time.sleep(5)"
    )
    started = time.monotonic()
    with pytest.raises(RuntimeError, match="timed out"):
        _run([sys.executable, "-c", parent], context)
    assert time.monotonic() - started < 1.5
