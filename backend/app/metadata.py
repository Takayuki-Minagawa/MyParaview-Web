"""Dataset metadata extraction.

Self-contained parsers for VTK XML native formats (.vtp/.vti/.vtu/.vts/.vtr),
the .pvd time-series collection format, and CSV tables. Uses only the Python
standard library so that the ingestion worker needs no VTK/ParaView install.

Scope (per work_plan M0-D / M1-B):
  * Structural metadata is always extracted (dataset type, counts, array names,
    components, dtypes, bounds where cheaply derivable).
  * Scalar *ranges* and point-derived *bounds* are computed only when the data
    arrays are stored inline as ``format="ascii"``. Binary/appended payloads are
    reported structurally with ``range=None`` rather than guessed. This is an
    honest limitation documented in the README and is where a server-side VTK
    reader would later take over.
"""

from __future__ import annotations

import csv
import math
import os
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from typing import List, Optional


@dataclass
class ArrayInfo:
    name: str
    association: str  # 'point' | 'cell' | 'field' | 'table'
    num_components: int = 1
    data_type: Optional[str] = None
    value_range: Optional[List[float]] = None  # [min, max] over inline values


@dataclass
class DatasetMetadata:
    dataset_type: str
    num_points: Optional[int] = None
    num_cells: Optional[int] = None
    num_blocks: Optional[int] = None
    bounds: Optional[List[float]] = None  # [xmin,xmax,ymin,ymax,zmin,zmax]
    timesteps: Optional[List[float]] = None
    arrays: List[ArrayInfo] = field(default_factory=list)
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = asdict(self)
        # drop empty optionals for a cleaner API payload
        return {k: v for k, v in d.items() if v not in (None, [], {})}


class UnsupportedFormatError(ValueError):
    """Raised when a file extension has no supported parser."""


# --------------------------------------------------------------------------- #
# Small parsing helpers
# --------------------------------------------------------------------------- #
def _floats(text: Optional[str]) -> List[float]:
    if not text:
        return []
    out: List[float] = []
    for tok in text.split():
        try:
            out.append(float(tok))
        except ValueError:
            continue
    return out


def _range_of(values: List[float]) -> Optional[List[float]]:
    finite = [v for v in values if math.isfinite(v)]
    if not finite:
        return None
    return [min(finite), max(finite)]


def _range_for(values: List[float], num_components: int) -> Optional[List[float]]:
    """Range of a data array.

    Scalars: plain min/max. Multi-component (vector/tensor): the *magnitude*
    range over whole tuples, matching how vtk.js colors a multi-component array
    by default. A flat min/max across interleaved components would be wrong.
    """
    if num_components <= 1:
        return _range_of(values)
    mags: List[float] = []
    for i in range(0, len(values) - num_components + 1, num_components):
        tup = values[i : i + num_components]
        mag = math.sqrt(sum(c * c for c in tup))
        if math.isfinite(mag):
            mags.append(mag)
    if not mags:
        return None
    return [min(mags), max(mags)]


def _padded(values: List[float], fill: List[float]) -> List[float]:
    """Return values padded/truncated to len(fill), for robustness to malformed
    Origin/Spacing attributes with fewer than 3 tokens."""
    return (values + fill)[: len(fill)]


def _bounds_from_points(coords: List[float]) -> Optional[List[float]]:
    """coords is a flat list of x,y,z triples."""
    if len(coords) < 3:
        return None
    xs = coords[0::3]
    ys = coords[1::3]
    zs = coords[2::3]
    if not xs:
        return None
    return [min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)]


def _local(tag: str) -> str:
    """Strip an XML namespace prefix if present."""
    return tag.rsplit("}", 1)[-1]


def _find_child(elem: ET.Element, name: str) -> Optional[ET.Element]:
    for child in elem:
        if _local(child.tag) == name:
            return child
    return None


def _find_children(elem: ET.Element, name: str) -> List[ET.Element]:
    return [c for c in elem if _local(c.tag) == name]


# --------------------------------------------------------------------------- #
# DataArray -> ArrayInfo
# --------------------------------------------------------------------------- #
def _parse_data_arrays(container: Optional[ET.Element], association: str) -> List[ArrayInfo]:
    arrays: List[ArrayInfo] = []
    if container is None:
        return arrays
    for da in _find_children(container, "DataArray"):
        name = da.get("Name") or da.get("name") or "(unnamed)"
        ncomp = int(da.get("NumberOfComponents", "1") or "1")
        dtype = da.get("type")
        fmt = (da.get("format") or "ascii").lower()
        value_range = None
        if fmt == "ascii":
            value_range = _range_for(_floats(da.text), ncomp)
        arrays.append(
            ArrayInfo(
                name=name,
                association=association,
                num_components=ncomp,
                data_type=dtype,
                value_range=value_range,
            )
        )
    return arrays


def _piece_arrays(piece: ET.Element) -> List[ArrayInfo]:
    arrays: List[ArrayInfo] = []
    arrays += _parse_data_arrays(_find_child(piece, "PointData"), "point")
    arrays += _parse_data_arrays(_find_child(piece, "CellData"), "cell")
    arrays += _parse_data_arrays(_find_child(piece, "FieldData"), "field")
    return arrays


# --------------------------------------------------------------------------- #
# Per-type extractors
# --------------------------------------------------------------------------- #
def _extract_polydata(grid: ET.Element) -> DatasetMetadata:
    piece = _find_child(grid, "Piece")
    meta = DatasetMetadata(dataset_type="PolyData", num_blocks=1)
    if piece is None:
        return meta
    meta.num_points = int(piece.get("NumberOfPoints", "0") or "0")
    ncells = 0
    for attr in ("NumberOfVerts", "NumberOfLines", "NumberOfStrips", "NumberOfPolys"):
        ncells += int(piece.get(attr, "0") or "0")
    meta.num_cells = ncells
    points = _find_child(piece, "Points")
    if points is not None:
        da = _find_child(points, "DataArray")
        if da is not None and (da.get("format") or "ascii").lower() == "ascii":
            meta.bounds = _bounds_from_points(_floats(da.text))
    meta.arrays = _piece_arrays(piece)
    return meta


def _extract_unstructured(grid: ET.Element) -> DatasetMetadata:
    piece = _find_child(grid, "Piece")
    meta = DatasetMetadata(dataset_type="UnstructuredGrid", num_blocks=1)
    if piece is None:
        return meta
    meta.num_points = int(piece.get("NumberOfPoints", "0") or "0")
    meta.num_cells = int(piece.get("NumberOfCells", "0") or "0")
    points = _find_child(piece, "Points")
    if points is not None:
        da = _find_child(points, "DataArray")
        if da is not None and (da.get("format") or "ascii").lower() == "ascii":
            meta.bounds = _bounds_from_points(_floats(da.text))
    meta.arrays = _piece_arrays(piece)
    return meta


def _extract_imagedata(grid: ET.Element) -> DatasetMetadata:
    meta = DatasetMetadata(dataset_type="ImageData", num_blocks=1)
    try:
        extent = [int(v) for v in (grid.get("WholeExtent", "0 0 0 0 0 0")).split()]
    except ValueError:
        extent = []
    origin = _padded(_floats(grid.get("Origin", "0 0 0")), [0.0, 0.0, 0.0])
    spacing = _padded(_floats(grid.get("Spacing", "1 1 1")), [1.0, 1.0, 1.0])
    if len(extent) == 6:
        x0, x1, y0, y1, z0, z1 = extent
        dims = [x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1]
        meta.num_points = dims[0] * dims[1] * dims[2]
        cell_dims = [max(d - 1, 1) for d in dims]
        meta.num_cells = cell_dims[0] * cell_dims[1] * cell_dims[2]
        meta.bounds = [
            origin[0] + x0 * spacing[0], origin[0] + x1 * spacing[0],
            origin[1] + y0 * spacing[1], origin[1] + y1 * spacing[1],
            origin[2] + z0 * spacing[2], origin[2] + z1 * spacing[2],
        ]
        meta.extra = {"whole_extent": extent, "origin": origin, "spacing": spacing, "dimensions": dims}
    piece = _find_child(grid, "Piece")
    if piece is not None:
        meta.arrays = _piece_arrays(piece)
    return meta


_XML_TYPE_DISPATCH = {
    "PolyData": _extract_polydata,
    "UnstructuredGrid": _extract_unstructured,
    "ImageData": _extract_imagedata,
}


def _extract_vtk_xml(path: str) -> DatasetMetadata:
    root = ET.parse(path).getroot()
    if _local(root.tag) != "VTKFile":
        raise UnsupportedFormatError(f"Not a VTKFile: root tag {root.tag!r}")
    vtk_type = root.get("type", "")
    grid = _find_child(root, vtk_type)
    handler = _XML_TYPE_DISPATCH.get(vtk_type)
    if handler is None or grid is None:
        # structural fallback for types without a dedicated extractor
        meta = DatasetMetadata(dataset_type=vtk_type or "Unknown")
        if grid is not None:
            piece = _find_child(grid, "Piece")
            if piece is not None:
                meta.arrays = _piece_arrays(piece)
        return meta
    return handler(grid)


def _contained_sibling(pvd_path: str, rel: str) -> Optional[str]:
    """Resolve ``rel`` (a .pvd DataSet ``file``) against the .pvd's directory,
    returning it only if it stays within that directory. Blocks absolute paths
    and ``..`` traversal. Returns None otherwise. Valid .pvd files reference
    their pieces with relative paths, so absolute paths are rejected outright."""
    if not rel or os.path.isabs(rel):
        return None
    base = os.path.realpath(os.path.dirname(pvd_path))
    candidate = os.path.realpath(os.path.join(base, rel))
    try:
        if os.path.commonpath([base, candidate]) != base:
            return None
    except ValueError:  # e.g. different drives on Windows
        return None
    return candidate


def _extract_pvd(path: str) -> DatasetMetadata:
    root = ET.parse(path).getroot()
    collection = _find_child(root, "Collection")
    meta = DatasetMetadata(dataset_type="Collection")
    if collection is None:
        return meta
    entries = _find_children(collection, "DataSet")
    timesteps = sorted({float(e.get("timestep", "0") or "0") for e in entries})
    files = [e.get("file") for e in entries if e.get("file")]
    parts = {int(e.get("part", "0") or "0") for e in entries}
    meta.timesteps = timesteps
    meta.num_blocks = len(parts)
    meta.extra = {"num_timesteps": len(timesteps), "files": files}
    # enrich arrays/counts from the first referenced piece if resolvable & XML.
    # The referenced path is restricted to the .pvd's own directory: a crafted
    # collection must not read absolute paths or escape via ".." into the rest
    # of the object store or the filesystem.
    first = _contained_sibling(path, files[0]) if files else None
    if first is not None:
        if os.path.isfile(first) and first.lower().endswith((".vtp", ".vti", ".vtu", ".vts", ".vtr")):
            try:
                inner = _extract_vtk_xml(first)
                meta.num_points = inner.num_points
                meta.num_cells = inner.num_cells
                meta.bounds = inner.bounds
                meta.arrays = inner.arrays
                meta.extra["inner_type"] = inner.dataset_type
            except Exception:  # noqa: BLE001 - enrichment is best-effort
                pass
    return meta


def _extract_csv(path: str) -> DatasetMetadata:
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.reader(fh)
        try:
            header = next(reader)
        except StopIteration:
            return DatasetMetadata(dataset_type="Table", num_points=0)
        columns = [h.strip() for h in header]
        col_values: List[List[float]] = [[] for _ in columns]
        col_numeric = [True] * len(columns)
        nrows = 0
        for row in reader:
            if not row:
                continue
            nrows += 1
            for i, cell in enumerate(row[: len(columns)]):
                if not col_numeric[i]:
                    continue
                cell = cell.strip()
                if cell == "":
                    continue
                try:
                    col_values[i].append(float(cell))
                except ValueError:
                    col_numeric[i] = False
    arrays: List[ArrayInfo] = []
    for i, name in enumerate(columns):
        vrange = _range_of(col_values[i]) if col_numeric[i] else None
        arrays.append(
            ArrayInfo(
                name=name or f"col{i}",
                association="table",
                num_components=1,
                data_type="numeric" if col_numeric[i] else "string",
                value_range=vrange,
            )
        )
    return DatasetMetadata(
        dataset_type="Table",
        num_points=nrows,
        arrays=arrays,
        extra={"num_rows": nrows, "num_columns": len(columns)},
    )


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #
_XML_EXTENSIONS = {".vtp", ".vti", ".vtu", ".vts", ".vtr"}


def extract_metadata(path: str) -> DatasetMetadata:
    """Extract metadata from a dataset file, dispatched by extension."""
    ext = os.path.splitext(path)[1].lower()
    if ext in _XML_EXTENSIONS:
        return _extract_vtk_xml(path)
    if ext == ".pvd":
        return _extract_pvd(path)
    if ext == ".csv":
        return _extract_csv(path)
    raise UnsupportedFormatError(
        f"No metadata parser for extension {ext!r}. "
        "Formats such as .cgns/.exo/.case/.xdmf are handled server-side by a "
        "VTK/ParaView reader (see work_plan M2)."
    )
