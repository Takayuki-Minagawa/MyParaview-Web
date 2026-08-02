from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from workers import pv_worker  # noqa: E402


class Proxy:
    def __init__(self, kind: str, source=None) -> None:
        self.kind = kind
        self.source = source


class FakeSimple:
    def __init__(self) -> None:
        self.saved = None

    def OpenDataFile(self, _source):
        return Proxy("reader")

    def Threshold(self, *, Input):
        proxy = Proxy("threshold", Input)
        proxy.Scalars = None
        proxy.LowerThreshold = None
        proxy.UpperThreshold = None
        return proxy

    def CellDatatoPointData(self, *, Input):
        proxy = Proxy("cell_to_point", Input)
        proxy.ProcessAllArrays = None
        return proxy

    def ResampleToImage(self, *, Input):
        proxy = Proxy("resample", Input)
        proxy.SamplingDimensions = None
        return proxy

    def Decimate(self, *, Input):
        proxy = Proxy("decimate", Input)
        proxy.TargetReduction = None
        return proxy

    def MergeBlocks(self, *, Input):
        return Proxy("merged", Input)

    def ConvertToMultiBlock(self, *, Input):
        return Proxy("multiblock", Input)

    def ExtractSurface(self, *, Input):
        return Proxy("surface", Input)

    def UpdatePipeline(self, *, proxy):
        assert proxy.kind == "surface"

    def SaveData(self, output, *, proxy):
        self.saved = (output, proxy)


class FakeArrayAttributes:
    def GetNumberOfArrays(self):
        return 0


class FakeDataInformation:
    def GetDataClassName(self):
        return "vtkUnstructuredGrid"

    def GetNumberOfPoints(self):
        return 1

    def GetNumberOfCells(self):
        return 1

    def GetNumberOfDataSets(self):
        return 1

    def GetBounds(self):
        return [0, 1, float("inf"), 2, 0, 3]

    def GetPointDataInformation(self):
        return FakeArrayAttributes()

    def GetCellDataInformation(self):
        return FakeArrayAttributes()


class MetadataSimple:
    def OpenDataFile(self, _source):
        proxy = Proxy("reader")
        proxy.TimestepValues = [float("nan")]
        proxy.GetDataInformation = lambda: FakeDataInformation()
        return proxy

    def UpdatePipeline(self, *, proxy):
        assert proxy.kind == "reader"


def test_convert_and_threshold_are_surface_extracted_before_vtp_save(tmp_path, monkeypatch):
    for kind, params in (
        ("convert", {}),
        (
            "filter",
            {
                "filter": "threshold",
                "array": "temperature",
                "association": "POINTS",
                "minimum": 0,
                "maximum": 1,
            },
        ),
    ):
        simple = FakeSimple()
        monkeypatch.setattr(pv_worker, "_paraview", lambda simple=simple: simple)
        params_file = tmp_path / f"{kind}.json"
        params_file.write_text(json.dumps(params))
        output = str(tmp_path / f"{kind}.vtp")
        pv_worker.transform(kind, "source.cgns", output, str(params_file))
        assert simple.saved is not None
        assert simple.saved[0] == output
        assert simple.saved[1].kind == "surface"
        assert simple.saved[1].source.kind == "merged"
        assert simple.saved[1].source.source.kind == "multiblock"


def test_pipeline_surface_extracts_only_after_all_native_filters(tmp_path, monkeypatch):
    simple = FakeSimple()
    monkeypatch.setattr(pv_worker, "_paraview", lambda: simple)
    params_file = tmp_path / "pipeline.json"
    params_file.write_text(
        json.dumps(
            {
                "filters": [
                    {
                        "filter": "threshold",
                        "array": "temperature",
                        "association": "POINTS",
                        "minimum": 0,
                        "maximum": 100,
                    },
                    {
                        "filter": "threshold",
                        "array": "temperature",
                        "association": "POINTS",
                        "minimum": 20,
                        "maximum": 30,
                    },
                ]
            }
        )
    )
    output = str(tmp_path / "pipeline.vtp")

    pv_worker.transform("pipeline", "source.vtu", output, str(params_file))

    assert simple.saved is not None
    surface = simple.saved[1]
    final_filter = surface.source.source.source
    assert surface.kind == "surface"
    assert final_filter.kind == "threshold"
    assert final_filter.source.kind == "threshold"
    assert final_filter.source.source.kind == "reader"


@pytest.mark.parametrize(
    ("params", "kind", "property_name", "expected"),
    [
        ({"filter": "cell_to_point"}, "cell_to_point", "ProcessAllArrays", 1),
        (
            {"filter": "resample", "dimensions": [16, 24, 32]},
            "resample",
            "SamplingDimensions",
            [16, 24, 32],
        ),
        (
            {"filter": "decimate", "target_reduction": 0.65},
            "decimate",
            "TargetReduction",
            0.65,
        ),
    ],
)
def test_new_filters_map_to_paraview_proxy_properties(
    params, kind, property_name, expected
):
    result = pv_worker._apply_filter(FakeSimple(), Proxy("reader"), params)

    assert result.kind == kind
    assert result.source.kind == "reader"
    assert getattr(result, property_name) == expected


def test_metadata_omits_non_finite_bounds(monkeypatch, capsys):
    monkeypatch.setattr(pv_worker, "_paraview", MetadataSimple)
    pv_worker.metadata("source.cgns")
    payload = json.loads(capsys.readouterr().out)
    assert payload["bounds"] is None
    assert payload["timesteps"] is None
