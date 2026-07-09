"""Unit tests for the stdlib metadata extractors."""

from __future__ import annotations

from pathlib import Path

import pytest

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
    meta = extract_metadata(str(DATA / "sample_series.pvd"))
    assert meta.dataset_type == "Collection"
    assert meta.timesteps == [0.0, 1.5]
    assert meta.num_blocks == 1
    # enriched from the first referenced piece (series_step0.vtp)
    assert meta.num_points == 3
    assert _array(meta, "temperature").value_range == [0.0, 10.0]
    assert meta.extra["files"] == ["series_step0.vtp", "series_step1.vtp"]


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
    meta = extract_metadata(str(pvd))
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
    meta = extract_metadata(str(pvd))
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
    meta = extract_metadata(str(pvd))
    assert meta.num_points == 3  # in-directory enrichment still works


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
