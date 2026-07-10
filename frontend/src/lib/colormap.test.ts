import { describe, expect, it } from "vitest";
import { colorMapCssGradient, colorMapStops, sampleColorMap } from "./colormap";

describe("sampleColorMap", () => {
  it("is blue-ish at the low end of cool-to-warm", () => {
    const [r, , b] = sampleColorMap("cool-to-warm", 0);
    expect(b).toBeGreaterThan(r);
  });
  it("is red-ish at the high end of cool-to-warm", () => {
    const [r, , b] = sampleColorMap("cool-to-warm", 1);
    expect(r).toBeGreaterThan(b);
  });
  it("clamps out-of-range input", () => {
    expect(sampleColorMap("cool-to-warm", -2)).toEqual(sampleColorMap("cool-to-warm", 0));
    expect(sampleColorMap("cool-to-warm", 5)).toEqual(sampleColorMap("cool-to-warm", 1));
  });
  it("colors the cool-to-warm midpoint near white", () => {
    const [r, g, b] = sampleColorMap("cool-to-warm", 0.5);
    expect(r).toBeCloseTo(0.87, 2);
    expect(g).toBeCloseTo(0.87, 2);
    expect(b).toBeCloseTo(0.87, 2);
  });
});

describe("registered colormaps", () => {
  it("returns defensive copies of transfer-function stops", () => {
    const first = colorMapStops("viridis");
    first[0].rgb[0] = 1;
    expect(colorMapStops("viridis")[0].rgb[0]).toBeCloseTo(0.267);
  });

  it("interpolates grayscale at the midpoint", () => {
    const [r, g, b] = sampleColorMap("grayscale", 0.5);
    expect(r).toBeCloseTo(g);
    expect(g).toBeCloseTo(b);
    expect(r).toBeCloseTo(0.515);
  });

  it("registers five colormaps including plasma and turbo", () => {
    for (const name of ["cool-to-warm", "viridis", "grayscale", "plasma", "turbo"] as const) {
      expect(colorMapStops(name).length).toBeGreaterThanOrEqual(2);
      expect(colorMapCssGradient(name)).toContain("linear-gradient");
    }
  });

  it("builds a CSS legend gradient", () => {
    const gradient = colorMapCssGradient("cool-to-warm");
    expect(gradient).toContain("linear-gradient");
    expect(gradient).toContain("50%");
  });
});
