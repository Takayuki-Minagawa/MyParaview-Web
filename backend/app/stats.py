"""In-process array statistics for browser-native dataset formats.

Statistics are computed only from values the stdlib parsers can actually read:
CSV numeric columns and VTK XML ``format="ascii"`` data arrays. Binary or
appended payloads fail explicitly instead of guessing — exact statistics for
those live behind the ParaView worker capability.

Both readers make two streaming passes over the source. The first pass derives
the count, range, and mean; the second derives the variance and histogram. This
keeps memory proportional to the number of arrays and histogram bins rather
than to the number of values in an uploaded dataset.
"""

from __future__ import annotations

import csv
import math
import re
from dataclasses import dataclass, field
from typing import Callable, Optional
from xml.sax.handler import ContentHandler

from defusedxml import sax as SafeSAX


_ASSOCIATIONS = {"PointData": "point", "CellData": "cell"}
_WHITESPACE = re.compile(r"\s+")
# A float token longer than this is malformed for practical VTK use. Bounding
# it prevents a single unterminated token from becoming a file-sized buffer.
_MAX_NUMERIC_TOKEN_CHARS = 4096


@dataclass
class _ArrayAccumulator:
    """Constant-space state for one output array."""

    name: str
    association: str
    count: int = 0
    minimum: float = math.inf
    maximum: float = -math.inf
    total: float = 0.0
    mean: float = 0.0
    squared_deviation_total: float = 0.0
    histogram_counts: list[int] = field(default_factory=list)

    def observe_range(self, value: float) -> None:
        self.count += 1
        self.minimum = min(self.minimum, value)
        self.maximum = max(self.maximum, value)
        self.total += value

    def prepare_distribution(self, bins: int) -> None:
        self.mean = self.total / self.count
        self.histogram_counts = [0] * bins

    def observe_distribution(self, value: float) -> None:
        self.squared_deviation_total += (value - self.mean) ** 2
        width = self.maximum - self.minimum
        if width > 0:
            slot = min(
                int((value - self.minimum) / width * len(self.histogram_counts)),
                len(self.histogram_counts) - 1,
            )
        else:
            slot = 0
        self.histogram_counts[slot] += 1

    def to_payload(self, bins: int) -> dict:
        return {
            "name": self.name,
            "association": self.association,
            "count": self.count,
            "min": self.minimum,
            "max": self.maximum,
            "mean": self.mean,
            "stddev": math.sqrt(self.squared_deviation_total / self.count),
            "histogram": {
                "bins": bins,
                "min": self.minimum,
                "max": self.maximum,
                "counts": self.histogram_counts,
            },
        }


def _local_name(name: str) -> str:
    """Return the local part of either a SAX QName or ElementTree-style name."""
    return name.rsplit("}", 1)[-1].rsplit(":", 1)[-1]


class _VTKStatisticsHandler(ContentHandler):
    """Stream readable DataArray values to a callback without retaining XML."""

    def __init__(self, observe: Callable[[tuple[str, str], float], None]) -> None:
        super().__init__()
        self.observe = observe
        self.stack: list[str] = []
        self.root_is_vtk = False
        self.dataset_type = ""
        self.dataset_seen = False
        self.skipped_binary = 0

        self._active_key: Optional[tuple[str, str]] = None
        self._active_depth = -1
        self._num_components = 1
        self._component_count = 0
        self._magnitude_squared = 0.0
        self._token_parts: list[str] = []
        self._token_length = 0
        self._discard_token = False

    def startElement(self, name, attrs) -> None:  # noqa: N802 - SAX API
        local = _local_name(name)
        parent = self.stack[-1] if self.stack else None

        if not self.stack:
            self.root_is_vtk = local == "VTKFile"
            if self.root_is_vtk:
                self.dataset_type = attrs.get("type", "")
        elif len(self.stack) == 1 and self.root_is_vtk:
            if local == self.dataset_type:
                self.dataset_seen = True

        association = _ASSOCIATIONS.get(parent or "")
        is_piece_array = (
            len(self.stack) == 4
            and self.stack[1] == self.dataset_type
            and self.stack[2] == "Piece"
        )
        if local == "DataArray" and association and is_piece_array:
            data_format = (attrs.get("format", "ascii") or "ascii").lower()
            if data_format != "ascii":
                self.skipped_binary += 1
            else:
                array_name = attrs.get("Name") or attrs.get("name") or "(unnamed)"
                self._active_key = (association, array_name)
                self._active_depth = len(self.stack)
                self._num_components = int(
                    attrs.get("NumberOfComponents", "1") or "1"
                )
                self._component_count = 0
                self._magnitude_squared = 0.0
                self._reset_token()

        self.stack.append(local)

    def characters(self, content: str) -> None:
        if self._active_key is None:
            return

        start = 0
        for match in _WHITESPACE.finditer(content):
            self._append_token_fragment(content, start, match.start())
            self._finish_token()
            start = match.end()
        self._append_token_fragment(content, start, len(content))

    def endElement(self, name) -> None:  # noqa: N802 - SAX API
        local = _local_name(name)
        if (
            local == "DataArray"
            and self._active_key is not None
            and self._active_depth == len(self.stack) - 1
        ):
            self._finish_token()
            # Incomplete vector tuples intentionally match the previous parser:
            # they do not contribute a magnitude.
            self._active_key = None
            self._active_depth = -1
            self._component_count = 0
            self._magnitude_squared = 0.0

        if self.stack:
            self.stack.pop()

    def _append_token_fragment(self, content: str, start: int, end: int) -> None:
        if start >= end or self._discard_token:
            return
        fragment_length = end - start
        if self._token_length + fragment_length > _MAX_NUMERIC_TOKEN_CHARS:
            self._token_parts.clear()
            self._token_length = 0
            self._discard_token = True
            return
        self._token_parts.append(content[start:end])
        self._token_length += fragment_length

    def _finish_token(self) -> None:
        if self._discard_token:
            self._reset_token()
            return
        if not self._token_parts:
            return

        token = "".join(self._token_parts)
        self._reset_token()
        try:
            value = float(token)
        except ValueError:
            return
        self._observe_component(value)

    def _reset_token(self) -> None:
        self._token_parts.clear()
        self._token_length = 0
        self._discard_token = False

    def _observe_component(self, value: float) -> None:
        if self._active_key is None:
            return
        if self._num_components <= 1:
            if math.isfinite(value):
                self.observe(self._active_key, value)
            return

        self._component_count += 1
        self._magnitude_squared += value * value
        if self._component_count == self._num_components:
            magnitude = math.sqrt(self._magnitude_squared)
            if math.isfinite(magnitude):
                self.observe(self._active_key, magnitude)
            self._component_count = 0
            self._magnitude_squared = 0.0


def _stream_vtk_values(
    path: str, observe: Callable[[tuple[str, str], float], None]
) -> _VTKStatisticsHandler:
    handler = _VTKStatisticsHandler(observe)
    SafeSAX.parse(path, handler)
    if not handler.root_is_vtk:
        raise ValueError("statistics require a VTK XML dataset or CSV table")
    if not handler.dataset_seen:
        raise ValueError("VTK XML file has no dataset element")
    return handler


def _vtk_xml_statistics(path: str, bins: int) -> list[dict]:
    arrays: dict[tuple[str, str], _ArrayAccumulator] = {}

    def observe_range(key: tuple[str, str], value: float) -> None:
        association, name = key
        accumulator = arrays.setdefault(
            key, _ArrayAccumulator(name=name, association=association)
        )
        accumulator.observe_range(value)

    first_pass = _stream_vtk_values(path, observe_range)
    populated = {key: value for key, value in arrays.items() if value.count}
    if not populated:
        if first_pass.skipped_binary:
            raise ValueError(
                "arrays are stored in binary/appended format; exact statistics "
                "require the ParaView worker capability"
            )
        raise ValueError("dataset has no readable data arrays")

    for accumulator in populated.values():
        accumulator.prepare_distribution(bins)

    def observe_distribution(key: tuple[str, str], value: float) -> None:
        accumulator = populated.get(key)
        if accumulator is not None:
            accumulator.observe_distribution(value)

    _stream_vtk_values(path, observe_distribution)
    return [accumulator.to_payload(bins) for accumulator in populated.values()]


def _stream_csv_values(
    path: str, observe: Callable[[str, float], None]
) -> None:
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
                    observe(column, value)


def _csv_statistics(path: str, bins: int) -> list[dict]:
    columns: dict[str, _ArrayAccumulator] = {}

    def observe_range(name: str, value: float) -> None:
        accumulator = columns.setdefault(
            name, _ArrayAccumulator(name=name, association="table")
        )
        accumulator.observe_range(value)

    _stream_csv_values(path, observe_range)
    populated = {name: value for name, value in columns.items() if value.count}
    if not populated:
        raise ValueError("CSV table has no numeric columns")

    for accumulator in populated.values():
        accumulator.prepare_distribution(bins)

    def observe_distribution(name: str, value: float) -> None:
        accumulator = populated.get(name)
        if accumulator is not None:
            accumulator.observe_distribution(value)

    _stream_csv_values(path, observe_distribution)
    return [accumulator.to_payload(bins) for accumulator in populated.values()]


def compute_dataset_statistics(path: str, ext: str, bins: int) -> Optional[list[dict]]:
    """Return per-array statistics, or raise ValueError when unreadable."""
    if ext == ".csv":
        return _csv_statistics(path, bins)
    if ext in {".vtp", ".vti", ".vtu", ".vts", ".vtr"}:
        return _vtk_xml_statistics(path, bins)
    raise ValueError(
        f"statistics are not available for {ext} datasets without the ParaView worker"
    )
