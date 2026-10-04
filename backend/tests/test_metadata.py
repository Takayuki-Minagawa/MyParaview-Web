"""Unit tests for the stdlib metadata extractors."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest
from defusedxml.common import DefusedXmlException

from app.metadata import DatasetMetadata, UnsupportedFormatError, extract_metadata

DATA = Path(__file__).parent / "data"


def _array(meta, name):
    return next(a for a in meta.arrays if a.name == name)


def test_polydata_vtp():
    meta = extract_metadata(str(DATA / "sample_surface.vtp"))
    assert meta.dataset_type == "PolyData"
    assert meta.num_points == 4
    assert meta.num_cells == 4  # 4 polys
    assert meta.bounds == [0.0, 1.0, 0.0, 1.0, 0.0, 1.0]

    temp = _array(meta, "temperature")
    assert temp.association == "point"
    assert temp.num_components == 1
    assert temp.value_range == [10.0, 40.0]

    vel = _array(meta, "velocity")
    assert vel.association == "point"
    assert vel.num_components == 3
    # multi-component range is the magnitude range over tuples, not a flat min/max.
    # velocity tuples are (0,0,0),(1,0,0),(0,1,0),(0,0,1) -> magnitudes 0,1,1,1
    assert vel.value_range == [0.0, 1.0]

    cid = _array(meta, "cell_id")
    assert cid.association == "cell"


def test_imagedata_vti_uses_extent_and_spacing():
    meta = extract_metadata(str(DATA / "sample_image.vti"))
    assert meta.dataset_type == "ImageData"
    assert meta.num_points == 8  # 2*2*2
    assert meta.num_cells == 1  # 1*1*1
    # spacing is 2 -> extent [0,1] maps to physical [0,2]
    assert meta.bounds == [0.0, 2.0, 0.0, 2.0, 0.0, 2.0]
    assert meta.extra["dimensions"] == [2, 2, 2]
    assert _array(meta, "density").value_range == [1.0, 8.0]


def test_csv_table():
    meta = extract_metadata(str(DATA / "sample_points.csv"))
    assert meta.dataset_type == "Table"
    assert meta.num_points == 4  # rows
    assert meta.extra["num_columns"] == 5
    assert _array(meta, "temperature").value_range == [100.0, 180.0]
    label = _array(meta, "label")
    assert label.data_type == "string"
    assert label.value_range is None


def test_pvd_collection_timesteps_and_enrichment():
    meta = extract_metadata(str(DATA / "sample_series.pvd"), pvd_enrich_siblings=True)
    assert meta.dataset_type == "Collection"
    assert meta.timesteps == [0.0, 1.5]
    assert meta.num_blocks == 1
    # enriched from the first referenced piece (series_step0.vtp)
    assert meta.num_points == 3
    assert _array(meta, "temperature").value_range == [0.0, 10.0]
    assert meta.extra["files"] == ["series_step0.vtp", "series_step1.vtp"]


def test_vtk_xml_rejects_internal_entities(tmp_path):
    payload = (
        '<?xml version="1.0"?>'
        '<!DOCTYPE VTKFile [<!ENTITY expanded "0 0 0">]>'
        '<VTKFile type="PolyData"><PolyData><Piece NumberOfPoints="1" NumberOfPolys="0">'
        '<Points><DataArray type="Float32" NumberOfComponents="3" format="ascii">'
        '&expanded;</DataArray></Points></Piece></PolyData></VTKFile>'
    )
    path = tmp_path / "entity.vtp"
    path.write_text(payload)
    with pytest.raises(DefusedXmlException):
        extract_metadata(str(path))


@pytest.mark.parametrize("value", ["nan", "inf", "-inf"])
def test_pvd_rejects_non_finite_timestep(tmp_path, value):
    pvd = tmp_path / "invalid-time.pvd"
    pvd.write_text(
        '<?xml version="1.0"?><VTKFile type="Collection"><Collection>'
        f'<DataSet timestep="{value}" file="step.vtp"/>'
        "</Collection></VTKFile>"
    )
    with pytest.raises(ValueError, match="timestep must be finite"):
        extract_metadata(str(pvd))


def test_pvd_rejects_non_numeric_timestep_with_clear_error(tmp_path):
    pvd = tmp_path / "invalid-time.pvd"
    pvd.write_text(
        '<?xml version="1.0"?><VTKFile type="Collection"><Collection>'
        '<DataSet timestep="abc" file="step.vtp"/>'
        "</Collection></VTKFile>"
    )
    with pytest.raises(ValueError, match="PVD timestep must be a number"):
        extract_metadata(str(pvd))


def test_pvd_imagedata_preserves_grid_metadata(tmp_path):
    (tmp_path / "frame.vti").write_bytes((DATA / "sample_image.vti").read_bytes())
    pvd = tmp_path / "image-series.pvd"
    pvd.write_text(
        '<?xml version="1.0"?><VTKFile type="Collection"><Collection>'
        '<DataSet timestep="0" file="frame.vti"/>'
        "</Collection></VTKFile>"
    )
    meta = extract_metadata(str(pvd), pvd_enrich_siblings=True)
    assert meta.extra["inner_type"] == "ImageData"
    assert meta.extra["dimensions"] == [2, 2, 2]
    assert meta.extra["whole_extent"] == [0, 1, 0, 1, 0, 1]


_MINI_VTP = (
    '<?xml version="1.0"?>\n'
    '<VTKFile type="PolyData"><PolyData>'
    '<Piece NumberOfPoints="3" NumberOfPolys="1">'
    '<Points><DataArray type="Float32" NumberOfComponents="3" format="ascii">'
    "0 0 0 1 0 0 0 1 0</DataArray></Points>"
    "</Piece></PolyData></VTKFile>\n"
)


def test_pvd_does_not_read_outside_its_directory(tmp_path):
    # a crafted PVD must not escape its own directory via ".." or absolute paths
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.vtp").write_text(_MINI_VTP)

    inside = tmp_path / "inside"
    inside.mkdir()
    pvd = inside / "series.pvd"
    pvd.write_text(
        '<?xml version="1.0"?>\n'
        '<VTKFile type="Collection"><Collection>'
        '<DataSet timestep="0" file="../outside/secret.vtp"/>'
        "</Collection></VTKFile>\n"
    )
    meta = extract_metadata(str(pvd), pvd_enrich_siblings=True)
    assert meta.dataset_type == "Collection"
    assert meta.timesteps == [0.0]
    # enrichment is blocked -> counts stay unset despite the reachable target
    assert meta.num_points is None


def test_pvd_rejects_absolute_path_reference(tmp_path):
    # even an absolute path that happens to resolve inside the .pvd directory is
    # rejected: valid .pvd files reference pieces relatively.
    d = tmp_path / "run"
    d.mkdir()
    target = d / "step0.vtp"
    target.write_text(_MINI_VTP)
    pvd = d / "series.pvd"
    pvd.write_text(
        '<?xml version="1.0"?>\n'
        '<VTKFile type="Collection"><Collection>'
        f'<DataSet timestep="0" file="{target}"/>'
        "</Collection></VTKFile>\n"
    )
    meta = extract_metadata(str(pvd), pvd_enrich_siblings=True)
    assert meta.timesteps == [0.0]
    assert meta.num_points is None  # absolute reference not enriched


def test_pvd_enriches_from_sibling_in_same_directory(tmp_path):
    d = tmp_path / "run"
    d.mkdir()
    (d / "step0.vtp").write_text(_MINI_VTP)
    pvd = d / "series.pvd"
    pvd.write_text(
        '<?xml version="1.0"?>\n'
        '<VTKFile type="Collection"><Collection>'
        '<DataSet timestep="0" file="step0.vtp"/>'
        "</Collection></VTKFile>\n"
    )
    meta = extract_metadata(str(pvd), pvd_enrich_siblings=True)
    assert meta.num_points == 3  # in-directory enrichment still works


def test_pvd_broken_first_piece_keeps_collection_metadata(tmp_path):
    (tmp_path / "broken.vtp").write_text(
        '<?xml version="1.0"?><VTKFile type="PolyData"><PolyData>'
    )
    pvd = tmp_path / "series.pvd"
    pvd.write_text(
        '<?xml version="1.0"?><VTKFile type="Collection"><Collection>'
        '<DataSet timestep="0" file="broken.vtp"/>'
        '</Collection></VTKFile>'
    )
    meta = extract_metadata(str(pvd), pvd_enrich_siblings=True)
    assert meta.dataset_type == "Collection"
    assert meta.timesteps == [0.0]
    assert meta.extra["inner_type"] == "PolyData"
    assert "enrichment_warning" in meta.extra


def test_pvd_ignores_fileless_invalid_part_and_counts_parsed_entries(tmp_path):
    pvd = tmp_path / "fileless-part.pvd"
    pvd.write_text(
        '<?xml version="1.0"?><VTKFile type="Collection"><Collection>'
        '<DataSet part="1.5"/>'
        '<DataSet timestep="0" part="2" file="step.vtp"/>'
        '</Collection></VTKFile>'
    )
    meta = extract_metadata(str(pvd), pvd_enrich_siblings=False)
    assert meta.num_blocks == 1
    assert meta.extra["entries"] == [
        {"timestep": 0.0, "part": 2, "group": "", "file": "step.vtp"}
    ]


def test_pvd_rejects_non_integer_part_on_referenced_entry(tmp_path):
    pvd = tmp_path / "invalid-part.pvd"
    pvd.write_text(
        '<?xml version="1.0"?><VTKFile type="Collection"><Collection>'
        '<DataSet timestep="0" part="1.5" file="step.vtp"/>'
        '</Collection></VTKFile>'
    )
    with pytest.raises(ValueError, match="part must be an integer"):
        extract_metadata(str(pvd))


def test_imagedata_tolerates_malformed_origin(tmp_path):
    # Origin/Spacing with fewer than 3 tokens must not raise IndexError.
    p = tmp_path / "bad.vti"
    p.write_text(
        '<?xml version="1.0"?>\n'
        '<VTKFile type="ImageData">\n'
        '  <ImageData WholeExtent="0 1 0 1 0 1" Origin="0 0" Spacing="1 1">\n'
        '    <Piece Extent="0 1 0 1 0 1"><PointData></PointData></Piece>\n'
        "  </ImageData>\n"
        "</VTKFile>\n"
    )
    meta = extract_metadata(str(p))
    assert meta.dataset_type == "ImageData"
    assert meta.num_points == 8


def test_unsupported_extension_raises():
    with pytest.raises(UnsupportedFormatError):
        extract_metadata("/tmp/does_not_matter.cgns")


def test_to_dict_drops_empty_optionals():
    meta = extract_metadata(str(DATA / "sample_surface.vtp"))
    d = meta.to_dict()
    assert "dataset_type" in d
    assert "arrays" in d
    # timesteps is None for a static polydata and should be omitted
    assert "timesteps" not in d


@pytest.mark.parametrize("extension,vtk_type", [("vtp", "PolyData"), ("vtu", "UnstructuredGrid")])
@pytest.mark.parametrize("coordinates", ["nan 0 0", "0 inf 0", "0 0 -inf", "0 0 0 1"])
def test_point_bounds_omit_non_finite_or_incomplete_coordinates(
    tmp_path, extension, vtk_type, coordinates
):
    path = tmp_path / f"invalid-points.{extension}"
    path.write_text(
        f'<VTKFile type="{vtk_type}"><{vtk_type}><Piece NumberOfPoints="1">'
        f'<Points><DataArray format="ascii">{coordinates}</DataArray></Points>'
        f'</Piece></{vtk_type}></VTKFile>'
    )
    meta = extract_metadata(str(path))
    assert meta.bounds is None
    json.dumps(meta.to_dict(), allow_nan=False)


@pytest.mark.parametrize("attribute", ["Origin", "Spacing"])
@pytest.mark.parametrize("value", ["nan", "inf", "-inf", "1e309"])
def test_imagedata_rejects_non_finite_geometry(tmp_path, attribute, value):
    path = tmp_path / "invalid-geometry.vti"
    path.write_text(
        '<VTKFile type="ImageData">'
        f'<ImageData WholeExtent="0 1 0 1 0 1" {attribute}="{value} 1 1"/>'
        '</VTKFile>'
    )
    with pytest.raises(ValueError, match="Origin and Spacing must be finite"):
        extract_metadata(str(path))


@pytest.mark.parametrize("extent", ["0 2 0 1 0 1", f"0 {10**400} 0 1 0 1"])
def test_imagedata_rejects_bounds_overflow_from_finite_inputs(tmp_path, extent):
    path = tmp_path / "overflow.vti"
    path.write_text(
        '<VTKFile type="ImageData">'
        f'<ImageData WholeExtent="{extent}" Spacing="1e308 1 1"/>'
        '</VTKFile>'
    )
    with pytest.raises(ValueError, match="bounds must be finite"):
        extract_metadata(str(path))


def test_imagedata_negative_spacing_preserves_ordered_physical_bounds(tmp_path):
    path = tmp_path / "negative-spacing.vti"
    path.write_text(
        '<VTKFile type="ImageData">'
        '<ImageData WholeExtent="1 3 -2 1 0 1" Origin="10 20 30" Spacing="-2 -3 4"/>'
        '</VTKFile>'
    )
    meta = extract_metadata(str(path))
    assert meta.bounds == [4.0, 8.0, 17.0, 26.0, 30.0, 34.0]
    assert meta.extra["spacing"] == [-2.0, -3.0, 4.0]


@pytest.mark.parametrize("scale", [1e308, 1e-300])
def test_vector_magnitude_range_avoids_intermediate_overflow_and_underflow(tmp_path, scale):
    path = tmp_path / "large-vectors.vtp"
    path.write_text(
        '<VTKFile type="PolyData"><PolyData><Piece><PointData>'
        '<DataArray Name="velocity" NumberOfComponents="3" format="ascii">'
        f'{scale} {scale} 0'
        '</DataArray></PointData></Piece></PolyData></VTKFile>'
    )
    meta = extract_metadata(str(path))
    expected = math.hypot(scale, scale)
    assert _array(meta, "velocity").value_range == [expected, expected]
    json.dumps(meta.to_dict(), allow_nan=False)


def test_csv_non_finite_samples_do_not_pollute_metadata(tmp_path):
    path = tmp_path / "non-finite.csv"
    path.write_text("value,empty\n1,nan\nnan,inf\ninf,-inf\n-3,1e309\n")
    meta = extract_metadata(str(path))
    assert _array(meta, "value").value_range == [-3.0, 1.0]
    assert _array(meta, "empty").value_range is None
    json.dumps(meta.to_dict(), allow_nan=False)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_metadata_serialization_rejects_nested_non_finite_values(value):
    meta = DatasetMetadata(dataset_type="External", extra={"reader": {"range": [value]}})
    with pytest.raises(ValueError, match="JSON-compatible finite values"):
        meta.to_dict()
