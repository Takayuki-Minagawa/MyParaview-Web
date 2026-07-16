import { describe, expect, it } from "vitest";
import { csvDiagnostics, tableToPolyData } from "./scenes";
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
