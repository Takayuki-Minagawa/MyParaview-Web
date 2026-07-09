export type RGB = [number, number, number];

/**
 * Cool-to-warm diverging colormap (blue -> white -> red), a common default for
 * scalar coloring in scientific visualization. Input is clamped to [0, 1].
 */
export function coolToWarm(t: number): RGB {
  const x = Math.max(0, Math.min(1, t));
  const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
  if (x < 0.5) {
    const u = x / 0.5; // blue -> white
    return [lerp(0.23, 0.87, u), lerp(0.3, 0.87, u), lerp(0.75, 0.87, u)];
  }
  const u = (x - 0.5) / 0.5; // white -> red
  return [lerp(0.87, 0.71, u), lerp(0.87, 0.02, u), lerp(0.87, 0.15, u)];
}

/** Normalize a value into [0,1] given a [min,max] range. */
export function normalize(value: number, range: [number, number]): number {
  const [min, max] = range;
  if (max <= min) return 0;
  return (value - min) / (max - min);
}

/** Map a scalar to an RGB color through the given range and colormap. */
export function colorForValue(
  value: number,
  range: [number, number],
  map: (t: number) => RGB = coolToWarm,
): RGB {
  return map(normalize(value, range));
}
