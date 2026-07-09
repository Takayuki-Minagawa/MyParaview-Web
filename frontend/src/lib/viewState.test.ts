import { describe, expect, it } from "vitest";
import { parseViewState } from "./viewState";

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
});
