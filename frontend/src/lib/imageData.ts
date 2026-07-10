import type { ArrayInfo, ScalarSelection } from "../types";

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
