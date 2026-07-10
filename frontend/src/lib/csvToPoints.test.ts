import { describe, expect, it } from "vitest";
import { csvToPointData, parseCsv } from "./csvToPoints";

describe("CSV Table-to-Points", () => {
  it("parses quoted fields and escaped quotes", () => {
    expect(parseCsv('x,label\n1,"a,b"\n2,"say ""hi"""\n')).toEqual([
      ["x", "label"],
      ["1", "a,b"],
      ["2", 'say "hi"'],
    ]);
  });

  it("builds points, skips invalid coordinates, and keeps numeric arrays", () => {
    const result = csvToPointData(
      "x,y,z,temp,label\n0,1,2,10,a\nbad,2,3,20,b\n4,5,6,30,c\n",
      { x: "x", y: "y", z: "z" },
    );
    expect(result.numberOfPoints).toBe(2);
    expect(result.skippedRows).toBe(1);
    expect([...result.points]).toEqual([0, 1, 2, 4, 5, 6]);
    expect(result.arrays.map((array) => array.name)).toEqual(["x", "y", "z", "temp"]);
  });

  it("accepts a UTF-8 BOM in the first coordinate header", () => {
    const result = csvToPointData("\uFEFFx,y,z\n1,2,3\n", { x: "x", y: "y", z: "z" });
    expect([...result.points]).toEqual([1, 2, 3]);
  });

  it("rejects missing coordinates and browser-limit overflow", () => {
    expect(() => csvToPointData("x,y\n1,2\n", { x: "x", y: "y", z: "z" })).toThrow();
    expect(() =>
      csvToPointData("x,y,z\n0,0,0\n1,1,1\n", { x: "x", y: "y", z: "z" }, 1),
    ).toThrow(/limit/);
  });

  it("skips empty coordinates and preserves sparse numeric scalars as NaN", () => {
    const result = csvToPointData(
      "x,y,z,temp\n0,1,2,10\n,2,3,20\n4,5,6,\n",
      { x: "x", y: "y", z: "z" },
    );
    expect(result.numberOfPoints).toBe(2);
    expect(result.skippedRows).toBe(1);
    expect(result.arrays.map((array) => array.name)).toEqual(["x", "y", "z", "temp"]);
    const temperature = result.arrays.find((array) => array.name === "temp");
    expect(temperature).toBeDefined();
    expect(temperature!.values[0]).toBe(10);
    expect(Number.isNaN(temperature!.values[1])).toBe(true);
  });

  it("excludes nonnumeric and all-empty scalar columns", () => {
    const result = csvToPointData(
      "x,y,z,label,empty\n0,1,2,a,\n4,5,6,b,\n",
      { x: "x", y: "y", z: "z" },
    );
    expect(result.arrays.map((array) => array.name)).toEqual(["x", "y", "z"]);
  });

  it("keeps numeric scalar columns with nonnumeric cells and reports the replacement", () => {
    const result = csvToPointData(
      "x,y,z,temp\n0,1,2,10\n4,5,6,N/A\n7,8,9,30\n",
      { x: "x", y: "y", z: "z" },
    );
    const temperature = result.arrays.find((array) => array.name === "temp");
    expect(temperature).toBeDefined();
    expect([...temperature!.values].slice(0, 1)).toEqual([10]);
    expect(Number.isNaN(temperature!.values[1])).toBe(true);
    expect(temperature!.values[2]).toBe(30);
    expect(result.invalidScalarCells).toBe(1);
  });
});
