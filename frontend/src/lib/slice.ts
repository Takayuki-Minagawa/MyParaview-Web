import type { SliceAxis } from "../types";

/** Offset of each axis' (min, max) pair inside a VTK WholeExtent array. */
export const SLICE_EXTENT_OFFSET: Record<SliceAxis, number> = { X: 0, Y: 2, Z: 4 };

/** Unit normal for each slice axis, used for slice/clip plane parameters. */
export const AXIS_NORMALS: Record<SliceAxis, [number, number, number]> = {
  X: [1, 0, 0],
  Y: [0, 1, 0],
  Z: [0, 0, 1],
};

export function wholeExtentFor(
  dimensions: number[],
  wholeExtent: number[] | undefined,
): number[] {
  return wholeExtent ?? [
    0, Math.max(0, (dimensions[0] ?? 1) - 1),
    0, Math.max(0, (dimensions[1] ?? 1) - 1),
    0, Math.max(0, (dimensions[2] ?? 1) - 1),
  ];
}

export function sliceRangeFor(
  wholeExtent: number[],
  axis: SliceAxis,
): { min: number; max: number } {
  const offset = SLICE_EXTENT_OFFSET[axis];
  const min = wholeExtent[offset] ?? 0;
  return { min, max: Math.max(min, wholeExtent[offset + 1] ?? min) };
}

export function boundsCenter(bounds: number[] | null | undefined): [number, number, number] {
  const b = bounds ?? [0, 0, 0, 0, 0, 0];
  return [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
}
