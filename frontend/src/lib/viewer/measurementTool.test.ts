import { describe, expect, it } from "vitest";
import { normalizeMeasurement } from "./measurementTool";

describe("normalizeMeasurement", () => {
  it("keeps world-space distance values", () => {
    expect(normalizeMeasurement("distance", 12.5)).toBe(12.5);
  });

  it("converts angle widget radians to degrees", () => {
    expect(normalizeMeasurement("angle", Math.PI / 2)).toBeCloseTo(90);
  });

  it("guards invalid widget output", () => {
    expect(normalizeMeasurement("distance", Number.NaN)).toBe(0);
    expect(normalizeMeasurement("angle", -1)).toBe(0);
  });
});
