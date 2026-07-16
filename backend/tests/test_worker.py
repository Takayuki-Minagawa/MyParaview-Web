from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

import pytest
from app.config import settings
from app.jobs import JobCancelled, JobContext
from app.worker import _run, run_pipeline_transform


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
