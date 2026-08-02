"""ParaView worker entry point. Run with ``pvpython``, never regular Python."""

from __future__ import annotations

import json
import math
import sys
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
    payload = {
        "dataset_type": info.GetDataClassName().removeprefix("vtk"),
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


def movie(source: str, output_dir: str, params_file: str) -> None:
    """Render one PNG frame per timestep into ``output_dir``."""
    simple = _paraview()
    params = json.loads(Path(params_file).read_text(encoding="utf-8"))
    reader = simple.OpenDataFile(source)
    if reader is None:
        raise RuntimeError(f"ParaView has no reader for {source}")
    simple.UpdatePipeline(proxy=reader)
    view = _prepared_view(simple, reader, params)
    timesteps = [float(value) for value in (getattr(reader, "TimestepValues", None) or [])]
    if not timesteps:
        timesteps = [0.0]
    frames_root = Path(output_dir)
    frames_root.mkdir(parents=True, exist_ok=True)
    for index, time_value in enumerate(timesteps):
        view.ViewTime = time_value
        simple.Render(view)
        simple.SaveScreenshot(str(frames_root / f"frame-{index:04d}.png"), view)


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
        movie(argv[2], argv[3], argv[4])
        return
    raise SystemExit(
        "usage: pv_worker.py metadata SOURCE | (filter|convert|pipeline|render) SOURCE OUTPUT PARAMS"
        " | movie SOURCE OUTPUT_DIR PARAMS"
    )


if __name__ == "__main__":
    main(sys.argv)
