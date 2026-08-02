import { describe, expect, it } from "vitest";
import type { Dataset } from "../types";
import {
  camerasEqual,
  clampComparisonTimestep,
  comparisonDatasetType,
  comparisonScalarSelection,
  comparisonSliceIndex,
  comparisonTableCoordinates,
  nextComparisonTimestep,
} from "./comparison";

function dataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: "d1",
    project_id: "p1",
    filename: "mesh.vtp",
    ext: ".vtp",
    size_bytes: 1,
    status: "ready",
    dataset_type: "PolyData",
    created_at: "2026-08-02T00:00:00Z",
    ...overrides,
  };
}

describe("comparison view derivation", () => {
  it("resolves collection types and clamps independent timesteps", () => {
    const collection = dataset({
      dataset_type: "Collection",
      extra: { inner_type: "UnstructuredGrid" },
      timesteps: [0, 0.5, 1],
    });
    expect(comparisonDatasetType(collection)).toBe("UnstructuredGrid");
    expect(clampComparisonTimestep(collection, 20)).toBe(2);
    expect(nextComparisonTimestep(collection, 0)).toBe(1);
    expect(nextComparisonTimestep(collection, 2)).toBe(1);
  });

  it("reuses compatible scalars and falls back for image data", () => {
    const image = dataset({
      dataset_type: "ImageData",
      arrays: [
        { name: "velocity", association: "point", num_components: 3 },
        { name: "temperature", association: "point", num_components: 1, value_range: [2, 8] },
      ],
    });
    expect(comparisonScalarSelection(image, { name: "missing", association: "point" }))
      .toEqual({ name: "temperature", association: "point" });
    expect(comparisonScalarSelection(image, { name: "velocity", association: "point" }))
      .toEqual({ name: "velocity", association: "point" });
  });

  it("validates table coordinates and clamps image slices to the second dataset", () => {
    const table = dataset({
      dataset_type: "Table",
      arrays: ["a", "b", "c"].map((name) => ({
        name,
        association: "table" as const,
        num_components: 1,
        data_type: "numeric",
      })),
    });
    expect(comparisonTableCoordinates(table, { x: "missing", y: "b", z: "c" }))
      .toEqual({ x: "a", y: "b", z: "c" });

    const image = dataset({
      dataset_type: "ImageData",
      extra: { dimensions: [5, 6, 7], whole_extent: [-2, 2, 10, 15, 20, 26] },
    });
    expect(comparisonSliceIndex(image, "Y", 99)).toBe(15);
    expect(comparisonSliceIndex(image, "X", -99)).toBe(-2);
  });

  it("compares camera values rather than object identity", () => {
    const camera = {
      position: [1, 2, 3] as [number, number, number],
      focal_point: [0, 0, 0] as [number, number, number],
      view_up: [0, 1, 0] as [number, number, number],
      parallel_scale: 2,
    };
    expect(camerasEqual(camera, { ...camera })).toBe(true);
    expect(camerasEqual(camera, { ...camera, parallel_scale: 3 })).toBe(false);
  });
});
