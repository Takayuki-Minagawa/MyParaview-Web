from __future__ import annotations

import json
import sys
from pathlib import Path

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
        monkeypatch.setattr(pv_worker, "_paraview", lambda: simple)
        params_file = tmp_path / f"{kind}.json"
        params_file.write_text(json.dumps(params))
        output = str(tmp_path / f"{kind}.vtp")
        pv_worker.transform(kind, "source.cgns", output, str(params_file))
        assert simple.saved is not None
        assert simple.saved[0] == output
        assert simple.saved[1].kind == "surface"
        assert simple.saved[1].source.kind == "merged"
        assert simple.saved[1].source.source.kind == "multiblock"
