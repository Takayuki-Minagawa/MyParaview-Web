import { describe, expect, it } from "vitest";
import {
  customColorMapDefinition,
  hasColorMap,
  registerCustomColorMap,
} from "./colormap";
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

  it("registers an embedded custom colormap before restoring a new session state", () => {
    const definition = {
      id: "custom:Reloadable:abc123" as const,
      label: "Reloadable",
      stops: [
        { position: 0, rgb: [0, 0.1, 0.2] as [number, number, number] },
        { position: 0.5, rgb: [0.4, 0.5, 0.6] as [number, number, number] },
        { position: 1, rgb: [0.8, 0.9, 1] as [number, number, number] },
      ],
    };
    expect(hasColorMap(definition.id)).toBe(false);

    const state = {
      ...VALID,
      color_map: definition.id,
      custom_color_map: definition,
    };
    expect(parseViewState(state)).toEqual(state);
    expect(customColorMapDefinition(definition.id)).toEqual(definition);
    // Legacy/bare references remain readable once the definition is registered.
    expect(parseViewState({ ...VALID, color_map: definition.id })?.color_map)
      .toBe(definition.id);
  });

  it("rejects mismatched, conflicting, or invalid embedded definitions without side effects", () => {
    const definition = {
      id: "custom:Portable:abc124" as const,
      label: "Portable",
      stops: [
        { position: 0, rgb: [0, 0, 0] as [number, number, number] },
        { position: 1, rgb: [1, 1, 1] as [number, number, number] },
      ],
    };
    expect(parseViewState({
      ...VALID,
      color_map: "custom:Different:abc125",
      custom_color_map: definition,
    })).toBeNull();
    expect(parseViewState({
      ...VALID,
      color_map: definition.id,
      custom_color_map: {
        ...definition,
        stops: [{ position: 0, rgb: [0, 0, 0] }, { position: 1.1, rgb: [1, 1, 1] }],
      },
    })).toBeNull();
    expect(parseViewState({
      ...VALID,
      opacity: 2,
      color_map: definition.id,
      custom_color_map: definition,
    })).toBeNull();
    expect(hasColorMap(definition.id)).toBe(false);

    const conflictId = "custom:Conflict:abc126" as const;
    registerCustomColorMap(conflictId, "Original", [
      { position: 0, rgb: [0, 0, 0] },
      { position: 1, rgb: [1, 1, 1] },
    ]);
    expect(parseViewState({
      ...VALID,
      color_map: conflictId,
      custom_color_map: {
        id: conflictId,
        label: "Replacement",
        stops: [
          { position: 0, rgb: [0, 0, 0] },
          { position: 1, rgb: [1, 0, 0] },
        ],
      },
    })).toBeNull();
    expect(customColorMapDefinition(conflictId)?.label).toBe("Original");
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
