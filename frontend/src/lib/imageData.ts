import type { ArrayInfo, ScalarSelection, VolumeOpacityPoint } from "../types";

/** Default two-point ramp matching the historical fixed volume transfer function. */
export const DEFAULT_VOLUME_OPACITY_POINTS: VolumeOpacityPoint[] = [
  { value: 0, alpha: 0 },
  { value: 1, alpha: 0.85 },
];

export function isImageScalarArray(array: ArrayInfo): boolean {
  return array.association === "point" && array.num_components === 1;
}

export function defaultImageScalar(arrays: ArrayInfo[]): ScalarSelection | null {
  const scalar = arrays.find(isImageScalarArray);
  return scalar ? { name: scalar.name, association: "point" } : null;
}

export function isRuntimeImageScalar(
  array: { getNumberOfComponents?: () => number } | null | undefined,
): boolean {
  return array?.getNumberOfComponents?.() === 1;
}
