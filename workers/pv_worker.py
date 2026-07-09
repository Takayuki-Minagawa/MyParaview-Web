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


def transform(kind: str, source: str, output: str, params_file: str) -> None:
    simple = _paraview()
    params = json.loads(Path(params_file).read_text(encoding="utf-8"))
    reader = simple.OpenDataFile(source)
    if reader is None:
        raise RuntimeError(f"ParaView has no reader for {source}")
    result = reader
    if kind == "filter":
        operation = params["filter"]
        if operation == "slice":
            result = simple.Slice(Input=reader)
            result.SliceType = "Plane"
            result.SliceType.Origin = params["origin"]
            result.SliceType.Normal = params["normal"]
        elif operation == "clip":
            result = simple.Clip(Input=reader)
            result.ClipType = "Plane"
            result.ClipType.Origin = params["origin"]
            result.ClipType.Normal = params["normal"]
        elif operation == "contour":
            contour_input = reader
            contour_association = params.get("association", "POINTS")
            if contour_association == "CELLS":
                contour_input = simple.CellDatatoPointData(Input=reader)
                contour_association = "POINTS"
            result = simple.Contour(Input=contour_input)
            result.ContourBy = [contour_association, params["array"]]
            result.Isosurfaces = [params["value"]]
        elif operation == "threshold":
            result = simple.Threshold(Input=reader)
            result.Scalars = [params.get("association", "POINTS"), params["array"]]
            result.LowerThreshold = params["minimum"]
            result.UpperThreshold = params["maximum"]
        else:
            raise ValueError(f"unsupported filter {operation!r}")
    # VTP artifacts must be PolyData regardless of the reader/filter output
    # (external readers and Threshold commonly produce composite/UG datasets).
    multiblock = simple.ConvertToMultiBlock(Input=result)
    merged = simple.MergeBlocks(Input=multiblock)
    surface = simple.ExtractSurface(Input=merged)
    simple.UpdatePipeline(proxy=surface)
    simple.SaveData(output, proxy=surface)


def main(argv: list[str]) -> None:
    if len(argv) == 3 and argv[1] == "metadata":
        metadata(argv[2])
        return
    if len(argv) == 5 and argv[1] in {"filter", "convert"}:
        transform(argv[1], argv[2], argv[3], argv[4])
        return
    raise SystemExit("usage: pv_worker.py metadata SOURCE | (filter|convert) SOURCE OUTPUT PARAMS")


if __name__ == "__main__":
    main(sys.argv)
