import { describe, expect, it } from "vitest";
import { registerCustomColorMap } from "./colormap";
import { clampSliceIndex, parseViewState } from "./viewState";

const VALID = {
  schema_version: 1,
  representation: "surface",
  color_by: { name: "stress", association: "cell" },
  color_range: [-2, 8],
  opacity: 0.7,
  color_map: "viridis",
  legend_visible: true,
  camera: {
    position: [2, 2, 2],
    focal_point: [0, 0, 0],
    view_up: [0, 0, 1],
    parallel_scale: 1.5,
  },
};

describe("parseViewState", () => {
  it("accepts and copies a versioned view state", () => {
    expect(parseViewState(VALID)).toEqual(VALID);
  });

  it("rejects unsafe or future values", () => {
    expect(parseViewState({ ...VALID, schema_version: 2 })).toBeNull();
    expect(parseViewState({ ...VALID, opacity: 3 })).toBeNull();
    expect(parseViewState({ ...VALID, color_by: { name: "x", association: "field" } })).toBeNull();
    expect(parseViewState({ ...VALID, color_range: [10, 0] })).toBeNull();
    expect(parseViewState({ ...VALID, color_range: [1, 1] })).toBeNull();
    expect(parseViewState({ ...VALID, color_map: "custom:not-registered" })).toBeNull();
  });

  it("restores a custom colormap while its imported preset is registered", () => {
    const id = "custom:test:view-state" as const;
    registerCustomColorMap(id, "Test", [
      { position: 0, rgb: [0, 0, 0] },
      { position: 1, rgb: [1, 1, 1] },
    ]);
    expect(parseViewState({ ...VALID, color_map: id })?.color_map).toBe(id);
  });

  it("round-trips CSV and ImageData display controls", () => {
    const extended = {
      ...VALID,
      table_coordinates: { x: "lon", y: "lat", z: "height" },
      image_mode: "volume",
      slice_axis: "Y",
      slice_index: 12,
      timestep_index: 3,
    };
    expect(parseViewState(extended)).toEqual(extended);
    expect(parseViewState({ ...extended, table_coordinates: { x: "a", y: "a", z: "b" } }))
      .toBeNull();
  });

  it("round-trips volume opacity control points and rejects malformed ones", () => {
    const points = [
      { value: 0, alpha: 0 },
      { value: 0.4, alpha: 0.6 },
      { value: 1, alpha: 0.85 },
    ];
    const withPoints = { ...VALID, volume_opacity_points: points };
    expect(parseViewState(withPoints)).toEqual(withPoints);
    // Saved states from before the field existed still parse.
    expect(parseViewState(VALID)?.volume_opacity_points).toBeUndefined();
    // Out-of-range, too few, and non-numeric points are rejected.
    expect(
      parseViewState({ ...VALID, volume_opacity_points: [{ value: -0.1, alpha: 0 }, { value: 1, alpha: 1 }] }),
    ).toBeNull();
    expect(
      parseViewState({ ...VALID, volume_opacity_points: [{ value: 0, alpha: 0 }] }),
    ).toBeNull();
    expect(
      parseViewState({ ...VALID, volume_opacity_points: [{ value: 0, alpha: "x" }, { value: 1, alpha: 1 }] }),
    ).toBeNull();
  });

  it("clamps restored slices to the active extent while allowing negative extents", () => {
    expect(clampSliceIndex(-1, 0, 10)).toBe(0);
    expect(clampSliceIndex(11, 0, 10)).toBe(10);
    expect(clampSliceIndex(-1, -5, 5)).toBe(-1);
  });
});
