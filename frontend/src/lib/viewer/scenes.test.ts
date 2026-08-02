import { describe, expect, it } from "vitest";
import { csvDiagnostics, structuredSurfaceToPolyData, tableToPolyData } from "./scenes";
import { MESSAGES } from "../../i18n";

const CSV = "x,y,z,temp\n0,0,0,1\n1,0,0,2\n1,1,0,bad\n";

describe("tableToPolyData", () => {
  it("builds a vertex-per-row polydata with scalar arrays attached", () => {
    const { output, invalidScalarCells, skippedRows } = tableToPolyData(CSV, {
      x: "x", y: "y", z: "z",
    });
    expect(output.getNumberOfPoints()).toBe(3);
    expect(skippedRows).toBe(0);
    expect(invalidScalarCells).toBe(1); // "bad" temp cell
    const temp = output.getPointData().getArrayByName("temp");
    expect(temp).toBeTruthy();
    expect(temp?.getNumberOfComponents()).toBe(1);
  });

  it("skips rows with unparseable coordinates", () => {
    const { output, skippedRows } = tableToPolyData(
      "x,y,z\n0,0,0\nnope,0,0\n1,1,1\n",
      { x: "x", y: "y", z: "z" },
    );
    expect(output.getNumberOfPoints()).toBe(2);
    expect(skippedRows).toBe(1);
  });
});

describe("csvDiagnostics", () => {
  const messages = MESSAGES.en;

  it("is empty when nothing was dropped", () => {
    expect(csvDiagnostics(messages, 0, 0)).toBe("");
  });

  it("mentions skipped rows and invalid cells with counts", () => {
    const text = csvDiagnostics(messages, 2, 3);
    expect(text).toContain("3");
    expect(text).toContain("2");
  });
});

describe("structuredSurfaceToPolyData", () => {
  it("attaches VTS/VTR boundary topology and scalar arrays", () => {
    const output = structuredSurfaceToPolyData({
      sourceType: "RectilinearGrid",
      numberOfPoints: 4,
      points: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
      polys: new Uint32Array([4, 0, 1, 3, 2]),
      lines: new Uint32Array(),
      verts: new Uint32Array(),
      pointArrays: [{
        name: "temperature", numberOfComponents: 1, values: new Float64Array([1, 2, 3, 4]),
      }],
      cellArrays: [{ name: "region", numberOfComponents: 1, values: new Float64Array([7]) }],
      sourceCellCount: 1,
      primitiveCount: 1,
    });
    expect(output.getNumberOfPoints()).toBe(4);
    expect(Array.from(output.getPolys().getData())).toEqual([4, 0, 1, 3, 2]);
    expect(output.getPointData().getArrayByName("temperature")?.getRange()).toEqual([1, 4]);
    expect(output.getCellData().getArrayByName("region")?.getRange()).toEqual([7, 7]);
    output.delete();
  });
});
