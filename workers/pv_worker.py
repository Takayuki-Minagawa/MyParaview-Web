"""ParaView worker entry point. Run with ``pvpython``, never regular Python."""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def _paraview():
    try:
        from paraview import simple
    except ImportError as exc:
        raise RuntimeError("this script must run under a ParaView pvpython environment") from exc
    return simple


def _array_info(attributes, association: str) -> list[dict]:
    arrays: list[dict] = []
    for index in range(attributes.GetNumberOfArrays()):
        info = attributes.GetArrayInformation(index)
        components = info.GetNumberOfComponents()
        value_range = None
        if components == 1:
            candidate = list(info.GetComponentRange(0))
            if len(candidate) == 2 and all(math.isfinite(float(value)) for value in candidate):
                value_range = [float(candidate[0]), float(candidate[1])]
        arrays.append(
            {
                "name": info.GetName(),
                "association": association,
                "num_components": components,
                "data_type": str(info.GetDataType()),
                "value_range": value_range,
            }
        )
    return arrays


def metadata(source: str) -> None:
    simple = _paraview()
    reader = simple.OpenDataFile(source)
    if reader is None:
        raise RuntimeError(f"ParaView has no reader for {source}")
    simple.UpdatePipeline(proxy=reader)
    info = reader.GetDataInformation()
    raw_timesteps = [float(value) for value in (getattr(reader, "TimestepValues", None) or [])]
    timesteps = raw_timesteps if all(map(math.isfinite, raw_timesteps)) else []
    raw_bounds = [float(value) for value in info.GetBounds()]
    bounds = raw_bounds if len(raw_bounds) == 6 and all(map(math.isfinite, raw_bounds)) else None
    data_class_name = str(info.GetDataClassName())
    payload = {
        # ParaView 5.10 embeds Python 3.8, which has no str.removeprefix().
        "dataset_type": (
            data_class_name[3:] if data_class_name.startswith("vtk") else data_class_name
        ),
        "num_points": int(info.GetNumberOfPoints()),
        "num_cells": int(info.GetNumberOfCells()),
        "num_blocks": int(info.GetNumberOfDataSets() or 1),
        "bounds": bounds,
        "timesteps": timesteps or None,
        "arrays": [
            *_array_info(info.GetPointDataInformation(), "point"),
            *_array_info(info.GetCellDataInformation(), "cell"),
        ],
        "extra": {"reader": "paraview"},
    }
    print(json.dumps(payload, allow_nan=False))


def _apply_filter(simple, source, params: dict):
    operation = params["filter"]
    if operation == "slice":
        result = simple.Slice(Input=source)
        result.SliceType = "Plane"
        result.SliceType.Origin = params["origin"]
        result.SliceType.Normal = params["normal"]
    elif operation == "clip":
        result = simple.Clip(Input=source)
        result.ClipType = "Plane"
        result.ClipType.Origin = params["origin"]
        result.ClipType.Normal = params["normal"]
    elif operation == "contour":
        contour_input = source
        contour_association = params.get("association", "POINTS")
        if contour_association == "CELLS":
            contour_input = simple.CellDatatoPointData(Input=source)
            contour_association = "POINTS"
        result = simple.Contour(Input=contour_input)
        result.ContourBy = [contour_association, params["array"]]
        result.Isosurfaces = [params["value"]]
    elif operation == "threshold":
        result = simple.Threshold(Input=source)
        result.Scalars = [params.get("association", "POINTS"), params["array"]]
        result.LowerThreshold = params["minimum"]
        result.UpperThreshold = params["maximum"]
    elif operation == "cell_to_point":
        result = simple.CellDatatoPointData(Input=source)
        # Keep this explicit so the API contract always converts every cell
        # array, independent of ParaView's saved/default proxy properties.
        result.ProcessAllArrays = 1
    elif operation == "resample":
        result = simple.ResampleToImage(Input=source)
        result.SamplingDimensions = params["dimensions"]
    elif operation == "decimate":
        result = simple.Decimate(Input=source)
        result.TargetReduction = params["target_reduction"]
    else:
        raise ValueError(f"unsupported filter {operation!r}")
    return result


def transform(kind: str, source: str, output: str, params_file: str) -> None:
    simple = _paraview()
    params = json.loads(Path(params_file).read_text(encoding="utf-8"))
    reader = simple.OpenDataFile(source)
    if reader is None:
        raise RuntimeError(f"ParaView has no reader for {source}")
    result = reader
    if kind == "filter":
        result = _apply_filter(simple, reader, params)
    elif kind == "pipeline":
        filters = params.get("filters")
        if not isinstance(filters, list) or not filters:
            raise ValueError("pipeline requires a non-empty filters list")
        for filter_params in filters:
            if not isinstance(filter_params, dict):
                raise ValueError("pipeline filters must be objects")
            result = _apply_filter(simple, result, filter_params)
    # VTP artifacts must be PolyData regardless of the reader/filter output
    # (external readers and Threshold commonly produce composite/UG datasets).
    multiblock = simple.ConvertToMultiBlock(Input=result)
    merged = simple.MergeBlocks(Input=multiblock)
    surface = simple.ExtractSurface(Input=merged)
    simple.UpdatePipeline(proxy=surface)
    simple.SaveData(output, proxy=surface)


def _prepared_view(simple, reader, params: dict):
    """Create a render view showing ``reader`` with optional scalar coloring."""
    view = simple.GetActiveViewOrCreate("RenderView")
    view.ViewSize = [int(params.get("width", 1280)), int(params.get("height", 960))]
    display = simple.Show(reader, view)
    array = params.get("array")
    if array:
        association = str(params.get("association", "POINTS")).upper()
        simple.ColorBy(display, (association, str(array)))
        display.RescaleTransferFunctionToDataRange(True, False)
    simple.ResetCamera(view)
    return view


def render(source: str, output: str, params_file: str) -> None:
    """Render a single server-side screenshot of the dataset."""
    simple = _paraview()
    params = json.loads(Path(params_file).read_text(encoding="utf-8"))
    reader = simple.OpenDataFile(source)
    if reader is None:
        raise RuntimeError(f"ParaView has no reader for {source}")
    simple.UpdatePipeline(proxy=reader)
    view = _prepared_view(simple, reader, params)
    timesteps = [float(value) for value in (getattr(reader, "TimestepValues", None) or [])]
    if timesteps:
        index = int(params.get("timestep_index", 0))
        if not (0 <= index < len(timesteps)):
            raise RuntimeError(f"timestep_index {index} out of range 0..{len(timesteps) - 1}")
        view.ViewTime = timesteps[index]
    simple.Render(view)
    simple.SaveScreenshot(output, view)


def _render_movie_frames(simple, source: str, output_dir: Path, params: dict) -> list[Path]:
    """Render one PNG per timestep and return the ordered frame paths."""
    reader = simple.OpenDataFile(source)
    if reader is None:
        raise RuntimeError(f"ParaView has no reader for {source}")
    simple.UpdatePipeline(proxy=reader)
    view = _prepared_view(simple, reader, params)
    timesteps = [float(value) for value in (getattr(reader, "TimestepValues", None) or [])]
    if not timesteps:
        timesteps = [0.0]
    output_dir.mkdir(parents=True, exist_ok=True)
    frames: list[Path] = []
    for index, time_value in enumerate(timesteps):
        view.ViewTime = time_value
        simple.Render(view)
        frame = output_dir / f"frame-{index:04d}.png"
        simple.SaveScreenshot(str(frame), view)
        frames.append(frame)
    return frames


def _ffmpeg_argv(
    executable: str,
    frames_dir: Path,
    output: Path,
    output_format: str,
    fps: int,
) -> list[str]:
    """Build the complete ffmpeg argv; no client value becomes an option."""
    common = [
        executable,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-framerate",
        str(fps),
        "-start_number",
        "0",
        "-i",
        str(frames_dir / "frame-%04d.png"),
        "-an",
        # yuv420p codecs need even dimensions.  Padding avoids silently
        # rejecting otherwise valid render sizes while preserving every pixel.
        "-vf",
        "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    ]
    if output_format == "mp4":
        codec = [
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
        ]
    elif output_format == "webm":
        codec = [
            "-c:v",
            "libvpx-vp9",
            "-crf",
            "32",
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p",
        ]
    else:
        raise RuntimeError(f"unsupported movie video format {output_format!r}")
    return [*common, *codec, str(output)]


def _encode_video(frames_dir: Path, output: Path, params: dict) -> None:
    executable_value = params.get("ffmpeg_executable")
    if not isinstance(executable_value, str) or not executable_value:
        raise RuntimeError("video export requires a validated PVWEB_FFMPEG executable")
    executable = Path(executable_value)
    if (
        not executable.is_absolute()
        or not executable.is_file()
        or not os.access(executable, os.X_OK)
    ):
        raise RuntimeError("PVWEB_FFMPEG is not an executable absolute path")
    output_format = params["format"]
    fps = params.get("fps")
    if (
        isinstance(fps, bool)
        or not isinstance(fps, int)
        or not 1 <= fps <= 120
    ):
        raise RuntimeError("movie fps must be an integer between 1 and 120")
    expected_suffix = f".{output_format}"
    if output.suffix.lower() != expected_suffix:
        raise RuntimeError(
            f"movie output suffix must be {expected_suffix} for format {output_format}"
        )
    argv = _ffmpeg_argv(
        str(executable), frames_dir, output, output_format, fps
    )
    try:
        # Do not create a child process group: the API's pvpython timeout and
        # cancellation handler owns the existing group and can terminate this
        # ffmpeg descendant together with the worker.  shell=False plus a
        # complete argv keeps filenames and options out of shell parsing.
        completed = subprocess.run(
            argv,
            shell=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
    except OSError as exc:
        raise RuntimeError(f"failed to start PVWEB_FFMPEG: {exc}") from exc
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "unknown ffmpeg error").strip()
        raise RuntimeError(
            f"ffmpeg failed ({completed.returncode}): {detail[-4000:]}"
        )
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError("ffmpeg produced no video artifact")


def movie(source: str, output: str, params_file: str) -> int:
    """Render a legacy frame ZIP input directory or an encoded video file."""
    simple = _paraview()
    params = json.loads(Path(params_file).read_text(encoding="utf-8"))
    output_format = params.get("format", "zip")
    if output_format == "zip":
        return len(_render_movie_frames(simple, source, Path(output), params))
    if output_format not in {"mp4", "webm"}:
        raise RuntimeError(f"unsupported movie format {output_format!r}")

    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # Validate the executable before doing potentially expensive rendering.
    executable = params.get("ffmpeg_executable")
    if not isinstance(executable, str) or not Path(executable).is_absolute():
        raise RuntimeError("video export requires a validated PVWEB_FFMPEG executable")
    if not Path(executable).is_file() or not os.access(executable, os.X_OK):
        raise RuntimeError("PVWEB_FFMPEG is not an executable absolute path")
    with tempfile.TemporaryDirectory(
        prefix="pvweb-video-frames-", dir=str(output_path.parent)
    ) as frames_dir:
        frames_root = Path(frames_dir)
        frames = _render_movie_frames(simple, source, frames_root, params)
        _encode_video(frames_root, output_path, params)
    return len(frames)


def main(argv: list[str]) -> None:
    if len(argv) == 3 and argv[1] == "metadata":
        metadata(argv[2])
        return
    if len(argv) == 5 and argv[1] in {"filter", "convert", "pipeline"}:
        transform(argv[1], argv[2], argv[3], argv[4])
        return
    if len(argv) == 5 and argv[1] == "render":
        render(argv[2], argv[3], argv[4])
        return
    if len(argv) == 5 and argv[1] == "movie":
        frame_count = movie(argv[2], argv[3], argv[4])
        print(json.dumps({"frame_count": frame_count}, allow_nan=False))
        return
    raise SystemExit(
        "usage: pv_worker.py metadata SOURCE | (filter|convert|pipeline|render) SOURCE OUTPUT PARAMS"
        " | movie SOURCE OUTPUT_DIR PARAMS"
    )


if __name__ == "__main__":
    main(sys.argv)
