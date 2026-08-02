"""Cancellable adapter for a separately installed ParaView ``pvpython`` worker."""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import time
from functools import lru_cache
from pathlib import Path

from .config import settings
from .jobs import JobCancelled, JobContext
from .metadata import ArrayInfo, DatasetMetadata


class WorkerUnavailable(RuntimeError):
    pass


@lru_cache(maxsize=32)
def _resolve_ffmpeg_executable(configured: str) -> str | None:
    """Resolve one immutable operator setting once per API process."""
    resolved = shutil.which(configured)
    if resolved is None:
        return None
    path = Path(resolved).resolve()
    if not path.is_file() or not os.access(path, os.X_OK):
        return None
    return str(path)


def resolve_ffmpeg_executable() -> str:
    """Return the configured ffmpeg as an executable absolute path.

    The client never supplies this value.  Resolving and validating the
    operator-controlled setting here prevents a movie parameter from becoming
    an executable or a shell fragment in the pvpython worker.
    """
    configured = settings.ffmpeg_executable
    if not configured:
        raise WorkerUnavailable("video export requires PVWEB_FFMPEG (ffmpeg capability)")
    resolved = _resolve_ffmpeg_executable(configured)
    if resolved is None:
        raise WorkerUnavailable(
            f"PVWEB_FFMPEG executable was not found or is not executable: {configured}"
        )
    return resolved


def ffmpeg_available() -> bool:
    try:
        resolve_ffmpeg_executable()
    except WorkerUnavailable:
        return False
    return True


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
                raise JobCancelled() from None
            if time.monotonic() > deadline:
                terminate_tree(force=True)
                process.communicate()
                raise RuntimeError(
                    f"ParaView worker timed out after {settings.worker_timeout_seconds}s"
                ) from None
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


def _write_params(params_path: Path, payload: dict) -> Path:
    """Serialize worker parameters next to the output (NaN-free JSON)."""
    params_path.write_text(json.dumps(payload, allow_nan=False), encoding="utf-8")
    return params_path


def _require_output(output: Path) -> None:
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError("ParaView worker produced no output artifact")


def run_transform(
    source: Path,
    output: Path,
    kind: str,
    params: dict,
    ctx: JobContext,
) -> None:
    params_path = _write_params(output.with_suffix(".json"), params)
    _run(_command(kind, str(source), str(output), str(params_path)), ctx)
    _require_output(output)


def run_pipeline_transform(
    source: Path,
    output: Path,
    filters: list[dict],
    ctx: JobContext,
) -> None:
    """Run a complete filter chain in one ParaView process.

    Intermediate ParaView proxies stay in their native dataset types.  The
    worker converts only the final proxy to the VTP artifact contract.
    """
    params_path = _write_params(output.with_suffix(".json"), {"filters": filters})
    _run(_command("pipeline", str(source), str(output), str(params_path)), ctx)
    _require_output(output)


def run_movie_frames(
    source: Path,
    frames_dir: Path,
    params: dict,
    ctx: JobContext,
) -> list[Path]:
    """Render one frame per timestep and return the frame paths in order."""
    params_path = _write_params(frames_dir.parent / f"{frames_dir.name}-params.json", params)
    _run(_command("movie", str(source), str(frames_dir), str(params_path)), ctx)
    frames = sorted(frames_dir.glob("frame-*.png"))
    if not frames:
        raise RuntimeError("ParaView worker produced no movie frames")
    return frames


def run_movie_video(
    source: Path,
    output: Path,
    params: dict,
    ctx: JobContext,
) -> int:
    """Render and encode a video within the worker process-group contract.

    ffmpeg is launched by ``pv_worker.py`` without creating a new process
    group.  Therefore the existing timeout/cancel handling in ``_run`` kills
    both pvpython and its ffmpeg descendant.
    """
    ffmpeg_executable = resolve_ffmpeg_executable()
    worker_params = {
        **params,
        # Always overwrite a similarly named client field with the trusted,
        # resolved operator setting.
        "ffmpeg_executable": ffmpeg_executable,
    }
    params_path = _write_params(output.with_suffix(".json"), worker_params)
    result = _run(_command("movie", str(source), str(output), str(params_path)), ctx)
    _require_output(output)
    # The final stdout line is a small worker-owned manifest.  ParaView may
    # write informational lines before it, so parse from the end.
    for line in reversed(result.stdout.splitlines()):
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        frame_count = payload.get("frame_count") if isinstance(payload, dict) else None
        if isinstance(frame_count, int) and not isinstance(frame_count, bool) and frame_count > 0:
            return frame_count
    raise RuntimeError("ParaView worker returned no valid video frame count")
