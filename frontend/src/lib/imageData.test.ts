import { describe, expect, it } from "vitest";
import { defaultImageScalar, isRuntimeImageScalar } from "./imageData";

describe("ImageData scalar selection", () => {
  it("skips vectors and selects the first one-component point array", () => {
    expect(defaultImageScalar([
      { name: "velocity", association: "point", num_components: 3 },
      { name: "cell-temp", association: "cell", num_components: 1 },
      { name: "temperature", association: "point", num_components: 1 },
    ])).toEqual({ name: "temperature", association: "point" });
  });

  it("returns null when no point scalar exists", () => {
    expect(defaultImageScalar([
      { name: "velocity", association: "point", num_components: 3 },
      { name: "density", association: "cell", num_components: 1 },
    ])).toBeNull();
  });

  it("rejects saved vector selections against runtime vtk arrays", () => {
    expect(isRuntimeImageScalar({ getNumberOfComponents: () => 1 })).toBe(true);
    expect(isRuntimeImageScalar({ getNumberOfComponents: () => 3 })).toBe(false);
    expect(isRuntimeImageScalar(null)).toBe(false);
  });
});
