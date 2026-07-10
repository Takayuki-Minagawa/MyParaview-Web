import { describe, expect, it } from "vitest";
import {
  AXIS_NORMALS,
  SLICE_EXTENT_OFFSET,
  boundsCenter,
  sliceRangeFor,
  wholeExtentFor,
} from "./slice";

describe("axis constants", () => {
  it("maps each axis to its (min, max) pair offset in a WholeExtent array", () => {
    expect(SLICE_EXTENT_OFFSET).toEqual({ X: 0, Y: 2, Z: 4 });
  });

  it("provides a unit normal per axis", () => {
    expect(AXIS_NORMALS).toEqual({
      X: [1, 0, 0],
      Y: [0, 1, 0],
      Z: [0, 0, 1],
    });
  });
});

describe("wholeExtentFor", () => {
  it("passes an explicit extent through untouched", () => {
    const extent = [1, 5, 2, 6, 3, 7];
    expect(wholeExtentFor([10, 10, 10], extent)).toBe(extent);
  });

  it("derives the extent from dimensions when none is given", () => {
    expect(wholeExtentFor([10, 20, 30], undefined)).toEqual([0, 9, 0, 19, 0, 29]);
  });

  it("clamps to zero for missing or degenerate dimensions", () => {
    expect(wholeExtentFor([], undefined)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(wholeExtentFor([0, 1], undefined)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe("sliceRangeFor", () => {
  it("reads the pair for the requested axis", () => {
    const extent = [0, 9, 0, 19, 0, 29];
    expect(sliceRangeFor(extent, "X")).toEqual({ min: 0, max: 9 });
    expect(sliceRangeFor(extent, "Y")).toEqual({ min: 0, max: 19 });
    expect(sliceRangeFor(extent, "Z")).toEqual({ min: 0, max: 29 });
  });

  it("clamps max so it never falls below min", () => {
    expect(sliceRangeFor([5, 2, 0, 0, 0, 0], "X")).toEqual({ min: 5, max: 5 });
  });

  it("falls back to zero for missing entries", () => {
    expect(sliceRangeFor([], "Z")).toEqual({ min: 0, max: 0 });
    expect(sliceRangeFor([0, 9, 3], "Y")).toEqual({ min: 3, max: 3 });
  });
});

describe("boundsCenter", () => {
  it("returns the per-axis midpoints", () => {
    expect(boundsCenter([0, 2, 0, 4, -2, 2])).toEqual([1, 2, 0]);
  });

  it("defaults to the origin for null or undefined bounds", () => {
    expect(boundsCenter(null)).toEqual([0, 0, 0]);
    expect(boundsCenter(undefined)).toEqual([0, 0, 0]);
  });
});
