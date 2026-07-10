"""Cancellable adapter for a separately installed ParaView ``pvpython`` worker."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from .config import settings
from .jobs import JobCancelled, JobContext
from .metadata import ArrayInfo, DatasetMetadata


class WorkerUnavailable(RuntimeError):
    pass


def _command(*args: str) -> list[str]:
    if not settings.worker_command:
        raise WorkerUnavailable("operation requires PVWEB_PVPYTHON (ParaView worker capability)")
    script = Path(__file__).resolve().parents[2] / "workers" / "pv_worker.py"
    return [*settings.worker_command, str(script), *args]


def _run(command: list[str], ctx: JobContext) -> subprocess.CompletedProcess[str]:
    process_group_options = (
        {"start_new_session": True}
        if os.name == "posix"
        else {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    )
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        **process_group_options,
    )

    def terminate_tree(*, force: bool) -> None:
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
            elif force:
                process.kill()
            else:
                process.terminate()
        except ProcessLookupError:
            pass

    deadline = time.monotonic() + settings.worker_timeout_seconds
    while True:
        try:
            # communicate() drains both pipes while the process runs. Polling
            # without reading can deadlock a healthy pvpython once stderr fills
            # the OS pipe buffer.
            stdout, stderr = process.communicate(timeout=0.1)
            break
        except subprocess.TimeoutExpired:
            if ctx.cancelled:
                terminate_tree(force=False)
                try:
                    process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    terminate_tree(force=True)
                    process.communicate()
                raise JobCancelled()
            if time.monotonic() > deadline:
                terminate_tree(force=True)
                process.communicate()
                raise RuntimeError(f"ParaView worker timed out after {settings.worker_timeout_seconds}s")
    if process.returncode != 0:
        detail = (stderr or stdout or "unknown worker error").strip()
        raise RuntimeError(f"ParaView worker failed ({process.returncode}): {detail[-4000:]}")
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def extract_external_metadata(path: Path, ctx: JobContext) -> DatasetMetadata:
    result = _run(_command("metadata", str(path)), ctx)
    try:
        payload = json.loads(result.stdout)
        arrays = [ArrayInfo(**item) for item in payload.get("arrays", [])]
        return DatasetMetadata(
            dataset_type=payload.get("dataset_type", "Unknown"),
            num_points=payload.get("num_points"),
            num_cells=payload.get("num_cells"),
            num_blocks=payload.get("num_blocks"),
            bounds=payload.get("bounds"),
            timesteps=payload.get("timesteps"),
            arrays=arrays,
            extra=payload.get("extra") or {"reader": "paraview"},
        )
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("ParaView worker returned invalid metadata JSON") from exc


def run_transform(
    source: Path,
    output: Path,
    kind: str,
    params: dict,
    ctx: JobContext,
) -> None:
    params_path = output.with_suffix(".json")
    params_path.write_text(json.dumps(params, allow_nan=False), encoding="utf-8")
    _run(_command(kind, str(source), str(output), str(params_path)), ctx)
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError("ParaView worker produced no output artifact")
