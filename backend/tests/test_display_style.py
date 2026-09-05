import pytest
from pydantic import ValidationError

from app.schemas import ViewState

BASE = dict(representation="surface", opacity=1, color_map="viridis", legend_visible=True)
STYLE = dict(solid_color="#ff8800", edge_color="#000000", point_size=12, line_width=3)
CAMERA = dict(position=[2, 2, 2], focal_point=[0, 0, 0], view_up=[0, 0, 1], parallel_scale=2)


def test_display_style_round_trip_and_legacy_defaults():
    state = ViewState(**BASE, display_style=STYLE, camera={**CAMERA, "parallel_projection": True})
    assert state.model_dump()["display_style"] == STYLE
    assert state.camera.parallel_projection is True
    legacy = ViewState(**BASE, camera=CAMERA)
    assert legacy.display_style.point_size == 7
    assert legacy.camera.parallel_projection is False
    assert "display_style" not in legacy.model_dump(exclude_unset=True)
    assert ViewState(**{**BASE, "representation": "surface-with-edges"})


@pytest.mark.parametrize("field,value", [
    ("solid_color", "red"), ("edge_color", "#fff"), ("point_size", 0),
    ("point_size", float("inf")), ("line_width", 11), ("line_width", float("nan")),
])
def test_invalid_style_rejected(field, value):
    with pytest.raises(ValidationError):
        ViewState(**BASE, display_style={**STYLE, field: value})


def test_projection_requires_boolean():
    with pytest.raises(ValidationError):
        ViewState(**BASE, camera={**CAMERA, "parallel_projection": "false"})
