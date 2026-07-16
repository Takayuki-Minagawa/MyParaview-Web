"""Focused coverage for streaming and multi-piece array statistics."""

from __future__ import annotations

import math
import tracemalloc

import pytest
from app.stats import compute_dataset_statistics


def test_csv_two_pass_statistics_preserve_numeric_results(tmp_path):
    dataset = tmp_path / "values.csv"
    dataset.write_text(
        "value,other,label\n"
        "1,10,alpha\n"
        "2,not-a-number,beta\n"
        "nan,20,gamma\n"
        "4,30,delta\n",
        encoding="utf-8",
    )

    arrays = compute_dataset_statistics(str(dataset), ".csv", bins=3)

    assert arrays is not None
    assert [entry["name"] for entry in arrays] == ["value", "other"]
    by_name = {entry["name"]: entry for entry in arrays}

    values = by_name["value"]
    assert values["association"] == "table"
    assert values["count"] == 3
    assert values["min"] == 1.0
    assert values["max"] == 4.0
    assert values["mean"] == pytest.approx(7.0 / 3.0)
    assert values["stddev"] == pytest.approx(
        math.sqrt(sum((value - 7.0 / 3.0) ** 2 for value in (1.0, 2.0, 4.0)) / 3)
    )
    assert values["histogram"]["counts"] == [1, 1, 1]

    other = by_name["other"]
    assert other["count"] == 3
    assert other["mean"] == 20.0
    assert other["stddev"] == pytest.approx(math.sqrt(200.0 / 3.0))
    assert other["histogram"]["counts"] == [1, 1, 1]


def test_vtk_statistics_aggregate_arrays_across_pieces(tmp_path):
    dataset = tmp_path / "multi-piece.vtp"
    dataset.write_text(
        """<?xml version="1.0"?>
<VTKFile type="PolyData">
  <PolyData>
    <Piece>
      <PointData>
        <DataArray Name="shared" format="ascii">1 2</DataArray>
        <DataArray Name="velocity" NumberOfComponents="3" format="ascii">
          3 4 0
        </DataArray>
      </PointData>
      <CellData>
        <DataArray Name="shared" format="ascii">10</DataArray>
      </CellData>
    </Piece>
    <Piece>
      <PointData>
        <DataArray Name="shared" format="ascii">3 4</DataArray>
        <DataArray Name="velocity" NumberOfComponents="3" format="ascii">
          0 0 5
        </DataArray>
      </PointData>
      <CellData>
        <DataArray Name="shared" format="ascii">20</DataArray>
      </CellData>
    </Piece>
  </PolyData>
</VTKFile>
""",
        encoding="utf-8",
    )

    arrays = compute_dataset_statistics(str(dataset), ".vtp", bins=2)

    assert arrays is not None
    assert len(arrays) == 3
    by_key = {(entry["association"], entry["name"]): entry for entry in arrays}

    points = by_key[("point", "shared")]
    assert points["count"] == 4
    assert points["min"] == 1.0
    assert points["max"] == 4.0
    assert points["mean"] == 2.5
    assert points["stddev"] == pytest.approx(math.sqrt(1.25))
    assert points["histogram"]["counts"] == [2, 2]

    vectors = by_key[("point", "velocity")]
    assert vectors["count"] == 2
    assert vectors["min"] == vectors["max"] == vectors["mean"] == 5.0
    assert vectors["stddev"] == 0.0
    assert vectors["histogram"]["counts"] == [2, 0]

    cells = by_key[("cell", "shared")]
    assert cells["count"] == 2
    assert cells["mean"] == 15.0
    assert cells["histogram"]["counts"] == [1, 1]


@pytest.mark.parametrize("extension", [".csv", ".vtp"])
def test_large_ascii_statistics_do_not_retain_all_values(tmp_path, extension):
    """Peak traced memory stays flat relative to a 50k-value input.

    The former list/DOM implementation retained several megabytes for these
    files. The streaming readers need only parser buffers and accumulator state.
    """

    dataset = tmp_path / f"large{extension}"
    value_count = 50_000
    with dataset.open("w", encoding="utf-8", newline="") as output:
        if extension == ".csv":
            output.write("value\n")
            for index in range(value_count):
                output.write(f"{index % 100}\n")
        else:
            output.write(
                '<VTKFile type="PolyData"><PolyData><Piece><PointData>'
                '<DataArray Name="value" format="ascii">'
            )
            for index in range(value_count):
                output.write(f"{index % 100} ")
            output.write(
                "</DataArray></PointData></Piece></PolyData></VTKFile>"
            )

    tracemalloc.start()
    try:
        arrays = compute_dataset_statistics(str(dataset), extension, bins=10)
        _, peak_bytes = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert arrays is not None
    assert arrays[0]["count"] == value_count
    assert arrays[0]["mean"] == 49.5
    assert sum(arrays[0]["histogram"]["counts"]) == value_count
    assert peak_bytes < 1_000_000
