import { describe, expect, it } from "vitest";
import { colorMapCssGradient, colorMapStops, sampleColorMap } from "./colormap";
import {
  importParaViewColorMapPreset,
  parseParaViewColorMapPreset,
} from "./paraviewPreset";

describe("ParaView colormap presets", () => {
  it("normalizes RGBPoints scalar coordinates and registers the preset", () => {
    const preset = importParaViewColorMapPreset(JSON.stringify([{
      Name: "Thermal Review",
      ColorSpace: "RGB",
      RGBPoints: [-10, 0, 0, 1, 0, 1, 1, 1, 30, 1, 0, 0],
    }]));

    expect(preset.id).toMatch(/^custom:/);
    expect(preset.label).toBe("Thermal Review");
    expect(colorMapStops(preset.id).map((stop) => stop.position)).toEqual([0, 0.25, 1]);
    expect(sampleColorMap(preset.id, 0)).toEqual([0, 0, 1]);
    expect(sampleColorMap(preset.id, 1)).toEqual([1, 0, 0]);
    expect(colorMapCssGradient(preset.id)).toContain("25%");
  });

  it("accepts IndexedColors and distributes them uniformly", () => {
    const preset = parseParaViewColorMapPreset(JSON.stringify({
      Name: "Indexed",
      IndexedColors: [0, 0, 0, 0.5, 0.25, 0.75, 1, 1, 1],
    }));

    expect(preset.stops.map((stop) => stop.position)).toEqual([0, 0.5, 1]);
  });

  it.each([
    ["not json", "valid JSON"],
    [JSON.stringify({ Name: "Missing colors" }), "IndexedColors"],
    [JSON.stringify({ Name: "Bad channel", RGBPoints: [0, 0, 0, 2, 1, 1, 1, 1] }), "between 0 and 1"],
    [JSON.stringify({ Name: "Duplicate", RGBPoints: [0, 0, 0, 0, 0, 1, 1, 1] }), "span a range"],
  ])("rejects malformed or unsupported input", (text, message) => {
    expect(() => parseParaViewColorMapPreset(text)).toThrow(message);
  });
});
