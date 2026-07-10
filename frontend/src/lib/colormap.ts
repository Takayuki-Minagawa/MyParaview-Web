export type RGB = [number, number, number];
export type ColorMapName = "cool-to-warm" | "viridis" | "grayscale";
export interface ColorStop {
  position: number;
  rgb: RGB;
}

const MAPS: Record<ColorMapName, ColorStop[]> = {
  "cool-to-warm": [
    { position: 0, rgb: [0.23, 0.3, 0.75] },
    { position: 0.5, rgb: [0.87, 0.87, 0.87] },
    { position: 1, rgb: [0.71, 0.02, 0.15] },
  ],
  viridis: [
    { position: 0, rgb: [0.267, 0.005, 0.329] },
    { position: 0.25, rgb: [0.23, 0.322, 0.546] },
    { position: 0.5, rgb: [0.128, 0.567, 0.551] },
    { position: 0.75, rgb: [0.369, 0.789, 0.383] },
    { position: 1, rgb: [0.993, 0.906, 0.144] },
  ],
  grayscale: [
    { position: 0, rgb: [0.08, 0.08, 0.08] },
    { position: 1, rgb: [0.95, 0.95, 0.95] },
  ],
};

export function colorMapStops(name: ColorMapName): ColorStop[] {
  return MAPS[name].map((stop) => ({ ...stop, rgb: [...stop.rgb] as RGB }));
}

export function colorMapCssGradient(name: ColorMapName): string {
  const stops = MAPS[name].map(({ position, rgb }) => {
    const channel = rgb.map((value) => Math.round(value * 255)).join(", ");
    return `rgb(${channel}) ${Math.round(position * 100)}%`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/**
 * Cool-to-warm diverging colormap (blue -> white -> red), a common default for
 * scalar coloring in scientific visualization. Input is clamped to [0, 1].
 */
export function coolToWarm(t: number): RGB {
  return sampleColorMap("cool-to-warm", t);
}

/** Sample any registered colormap using piecewise-linear interpolation. */
export function sampleColorMap(name: ColorMapName, t: number): RGB {
  const x = Math.max(0, Math.min(1, t));
  const stops = MAPS[name];
  const rightIndex = stops.findIndex((stop) => stop.position >= x);
  if (rightIndex <= 0) return [...stops[0].rgb] as RGB;
  const right = stops[rightIndex];
  const left = stops[rightIndex - 1];
  const width = right.position - left.position;
  const u = width > 0 ? (x - left.position) / width : 0;
  return left.rgb.map((value, index) => value + (right.rgb[index] - value) * u) as RGB;
}

/** Normalize a value into [0,1] given a [min,max] range. */
export function normalize(value: number, range: [number, number]): number {
  const [min, max] = range;
  if (max <= min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/** Map a scalar to an RGB color through the given range and colormap. */
export function colorForValue(
  value: number,
  range: [number, number],
  map: (t: number) => RGB = coolToWarm,
): RGB {
  return map(normalize(value, range));
}
