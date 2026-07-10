"""In-process array statistics for browser-native dataset formats.

Statistics are computed only from values the stdlib parsers can actually read:
CSV numeric columns and VTK XML ``format="ascii"`` data arrays. Binary or
appended payloads fail explicitly instead of guessing — exact statistics for
those live behind the ParaView worker capability.
"""

from __future__ import annotations

import csv
import math
from typing import List, Optional

from defusedxml import ElementTree as SafeET

from .metadata import _find_child, _find_children, _floats, _local


def _magnitudes(values: List[float], num_components: int) -> List[float]:
    if num_components <= 1:
        return [value for value in values if math.isfinite(value)]
    magnitudes: List[float] = []
    for index in range(0, len(values) - num_components + 1, num_components):
        window = values[index : index + num_components]
        magnitude = math.sqrt(sum(component * component for component in window))
        if math.isfinite(magnitude):
            magnitudes.append(magnitude)
    return magnitudes


def _array_statistics(name: str, association: str, values: List[float], bins: int) -> dict:
    minimum = min(values)
    maximum = max(values)
    count = len(values)
    mean = sum(values) / count
    variance = sum((value - mean) ** 2 for value in values) / count
    width = maximum - minimum
    counts = [0] * bins
    if width > 0:
        for value in values:
            slot = min(int((value - minimum) / width * bins), bins - 1)
            counts[slot] += 1
    else:
        counts[0] = count
    return {
        "name": name,
        "association": association,
        "count": count,
        "min": minimum,
        "max": maximum,
        "mean": mean,
        "stddev": math.sqrt(variance),
        "histogram": {"bins": bins, "min": minimum, "max": maximum, "counts": counts},
    }


def _vtk_xml_statistics(path: str, bins: int) -> list[dict]:
    root = SafeET.parse(path).getroot()
    if _local(root.tag) != "VTKFile":
        raise ValueError("statistics require a VTK XML dataset or CSV table")
    grid = _find_child(root, root.get("type", ""))
    if grid is None:
        raise ValueError("VTK XML file has no dataset element")
    results: list[dict] = []
    skipped_binary = 0
    for piece in _find_children(grid, "Piece"):
        for container_name, association in (("PointData", "point"), ("CellData", "cell")):
            container = _find_child(piece, container_name)
            if container is None:
                continue
            for data_array in _find_children(container, "DataArray"):
                name = data_array.get("Name") or data_array.get("name") or "(unnamed)"
                if (data_array.get("format") or "ascii").lower() != "ascii":
                    skipped_binary += 1
                    continue
                num_components = int(data_array.get("NumberOfComponents", "1") or "1")
                values = _magnitudes(_floats(data_array.text), num_components)
                if values:
                    results.append(_array_statistics(name, association, values, bins))
    if not results:
        if skipped_binary:
            raise ValueError(
                "arrays are stored in binary/appended format; exact statistics "
                "require the ParaView worker capability"
            )
        raise ValueError("dataset has no readable data arrays")
    return results


def _csv_statistics(path: str, bins: int) -> list[dict]:
    columns: dict[str, list[float]] = {}
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as source:
        reader = csv.DictReader(source)
        if not reader.fieldnames:
            raise ValueError("CSV table has no header row")
        for row in reader:
            for column, raw in row.items():
                if column is None or raw is None:
                    continue
                try:
                    value = float(raw)
                except ValueError:
                    continue
                if math.isfinite(value):
                    columns.setdefault(column, []).append(value)
    results = [
        _array_statistics(name, "table", values, bins)
        for name, values in columns.items()
        if values
    ]
    if not results:
        raise ValueError("CSV table has no numeric columns")
    return results


def compute_dataset_statistics(path: str, ext: str, bins: int) -> Optional[list[dict]]:
    """Return per-array statistics, or raise ValueError when unreadable."""
    if ext == ".csv":
        return _csv_statistics(path, bins)
    if ext in {".vtp", ".vti", ".vtu", ".vts", ".vtr"}:
        return _vtk_xml_statistics(path, bins)
    raise ValueError(
        f"statistics are not available for {ext} datasets without the ParaView worker"
    )
