import { describe, expect, it } from "vitest";
import {
  MAX_REGISTERED_CUSTOM_COLOR_MAPS,
  colorMapCssGradient,
  colorMapStops,
  hasColorMap,
  registerCustomColorMap,
  registeredCustomColorMaps,
  retainColorMap,
  sampleColorMap,
} from "./colormap";

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

describe("custom colormap registry", () => {
  const stops = [
    { position: 0, rgb: [0, 0, 0] as [number, number, number] },
    { position: 1, rgb: [1, 1, 1] as [number, number, number] },
  ];

  it("rejects malformed ids at the public mutation boundary", () => {
    expect(() => registerCustomColorMap(
      "__proto__" as never,
      "unsafe",
      stops,
    )).toThrow(/invalid format/);
    expect(hasColorMap("__proto__")).toBe(false);
  });

  it("bounds the session registry and evicts the oldest entry", () => {
    const first = "custom:coverage-0:a" as const;
    for (let index = 0; index <= MAX_REGISTERED_CUSTOM_COLOR_MAPS; index += 1) {
      registerCustomColorMap(
        `custom:coverage-${index}:a` as never,
        `Coverage ${index}`,
        stops,
      );
    }
    expect(registeredCustomColorMaps()).toHaveLength(MAX_REGISTERED_CUSTOM_COLOR_MAPS);
    expect(hasColorMap(first)).toBe(false);
    expect(hasColorMap(`custom:coverage-${MAX_REGISTERED_CUSTOM_COLOR_MAPS}:a`)).toBe(true);
  });

  it("keeps a colormap retained by an active viewer during eviction", () => {
    const active = "custom:active-selection:a" as const;
    registerCustomColorMap(active, "Active", stops);
    const releasePrimary = retainColorMap(active);
    const releaseComparison = retainColorMap(active);
    releasePrimary();
    try {
      for (let index = 0; index < MAX_REGISTERED_CUSTOM_COLOR_MAPS; index += 1) {
        registerCustomColorMap(
          `custom:active-filler-${index}:a` as never,
          `Active filler ${index}`,
          stops,
        );
      }
      expect(registeredCustomColorMaps()).toHaveLength(MAX_REGISTERED_CUSTOM_COLOR_MAPS);
      expect(hasColorMap(active)).toBe(true);
      expect(() => colorMapCssGradient(active)).not.toThrow();
    } finally {
      releaseComparison();
    }
  });

  it("preserves retained maps and reports a full registry without throwing", () => {
    for (let index = 0; index < MAX_REGISTERED_CUSTOM_COLOR_MAPS; index += 1) {
      registerCustomColorMap(
        `custom:retained-full-${index}:a` as never,
        `Retained ${index}`,
        stops,
      );
    }
    const releases = registeredCustomColorMaps().map(({ id }) => retainColorMap(id));
    try {
      expect(registerCustomColorMap(
        "custom:cannot-evict:a",
        "Cannot evict",
        stops,
      )).toBe(false);
      expect(hasColorMap("custom:cannot-evict:a")).toBe(false);
      expect(registeredCustomColorMaps()).toHaveLength(MAX_REGISTERED_CUSTOM_COLOR_MAPS);
    } finally {
      for (const release of releases) release();
    }
  });
});
