import { describe, expect, it } from "vitest";
import {
  colorForValue,
  colorMapCssGradient,
  colorMapStops,
  coolToWarm,
  normalize,
  sampleColorMap,
} from "./colormap";

describe("normalize", () => {
  it("maps within range", () => {
    expect(normalize(5, [0, 10])).toBe(0.5);
  });
  it("guards a degenerate range", () => {
    expect(normalize(5, [3, 3])).toBe(0);
  });
  it("clamps values outside the range", () => {
    expect(normalize(-5, [0, 10])).toBe(0);
    expect(normalize(15, [0, 10])).toBe(1);
  });
});

describe("coolToWarm", () => {
  it("is blue-ish at the low end", () => {
    const [r, , b] = coolToWarm(0);
    expect(b).toBeGreaterThan(r);
  });
  it("is red-ish at the high end", () => {
    const [r, , b] = coolToWarm(1);
    expect(r).toBeGreaterThan(b);
  });
  it("clamps out-of-range input", () => {
    expect(coolToWarm(-2)).toEqual(coolToWarm(0));
    expect(coolToWarm(5)).toEqual(coolToWarm(1));
  });
});

describe("colorForValue", () => {
  it("colors the midpoint near white", () => {
    const [r, g, b] = colorForValue(5, [0, 10]);
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

  it("builds a CSS legend gradient", () => {
    const gradient = colorMapCssGradient("cool-to-warm");
    expect(gradient).toContain("linear-gradient");
    expect(gradient).toContain("50%");
  });
});
