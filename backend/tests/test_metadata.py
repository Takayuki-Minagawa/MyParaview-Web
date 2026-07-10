"""Unit tests for the stdlib metadata extractors."""

from __future__ import annotations

from pathlib import Path

import pytest
from defusedxml.common import DefusedXmlException

from app.metadata import UnsupportedFormatError, extract_metadata

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
