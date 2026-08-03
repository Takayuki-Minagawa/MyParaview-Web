import { describe, expect, it } from "vitest";
import { axisNormal, boundsCenter } from "./planeTool";

describe("boundsCenter", () => {
  it("returns the midpoint of vtk bounds", () => {
    expect(boundsCenter([-2, 6, 4, 10, -8, 2])).toEqual([2, 7, -3]);
  });

  it("uses a safe origin for invalid bounds", () => {
    expect(boundsCenter([Infinity, -Infinity, 0, 1, 0, 1])).toEqual([0, 0, 0]);
    expect(boundsCenter([])).toEqual([0, 0, 0]);
  });
});

describe("axisNormal", () => {
  it.each([
    ["X", [1, 0, 0]],
    ["Y", [0, 1, 0]],
    ["Z", [0, 0, 1]],
  ] as const)("maps %s to a unit normal", (axis, expected) => {
    expect(axisNormal(axis)).toEqual(expected);
  });

  it("inverts the selected normal", () => {
    expect(axisNormal("Y", true)).toEqual([0, -1, 0]);
  });
});
