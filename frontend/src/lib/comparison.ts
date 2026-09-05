import type {
  CameraState,
  Dataset,
  ScalarSelection,
  SliceAxis,
  TableCoordinates,
} from "../types";
import { defaultImageScalar } from "./imageData";
import { sliceRangeFor, wholeExtentFor } from "./slice";

export function comparisonDatasetType(dataset: Dataset | null): string | null {
  if (!dataset) return null;
  return dataset.dataset_type === "Collection"
    ? String(dataset.extra?.inner_type ?? "") || null
    : dataset.dataset_type ?? null;
}

export function clampComparisonTimestep(dataset: Dataset | null, index: number): number {
  const maximum = Math.max(0, (dataset?.timesteps?.length ?? 1) - 1);
  return Math.max(0, Math.min(Math.trunc(index), maximum));
}

export function nextComparisonTimestep(dataset: Dataset, primaryIndex: number): number {
  const count = dataset.timesteps?.length ?? 0;
  if (dataset.dataset_type !== "Collection" || count < 2) return 0;
  const current = clampComparisonTimestep(dataset, primaryIndex);
  return current + 1 < count ? current + 1 : current - 1;
}

function matchingArray(dataset: Dataset, selection: ScalarSelection) {
  return (dataset.arrays ?? []).find((array) =>
    array.name === selection.name && (
      array.association === selection.association ||
      (dataset.dataset_type === "Table" && selection.association === "point"
        && array.association === "table")
    ),
  );
}

export function comparisonScalarSelection(
  dataset: Dataset | null,
  requested: ScalarSelection | null,
): ScalarSelection | null {
  if (!dataset) return null;
  if (requested && matchingArray(dataset, requested)) return requested;
  return comparisonDatasetType(dataset) === "ImageData"
    ? defaultImageScalar(dataset.arrays ?? [])
    : null;
}

export function comparisonScalarRange(
  dataset: Dataset | null,
  selection: ScalarSelection | null,
): [number, number] | null {
  if (!dataset || !selection) return null;
  return matchingArray(dataset, selection)?.value_range ?? null;
}

export function comparisonTableCoordinates(
  dataset: Dataset | null,
  requested: TableCoordinates | null,
): TableCoordinates | null {
  if (comparisonDatasetType(dataset) !== "Table" || !dataset) return requested;
  const numericNames = (dataset.arrays ?? [])
    .filter((array) => array.association === "table" && array.data_type === "numeric")
    .map((array) => array.name);
  if (
    requested &&
    new Set(Object.values(requested)).size === 3 &&
    Object.values(requested).every((name) => numericNames.includes(name))
  ) return requested;
  if (numericNames.length < 3) return null;
  return { x: numericNames[0], y: numericNames[1], z: numericNames[2] };
}

export function comparisonSliceIndex(
  dataset: Dataset | null,
  axis: SliceAxis,
  requested: number,
): number {
  const dimensions = (dataset?.extra?.dimensions as number[] | undefined) ?? [1, 1, 1];
  const extent = wholeExtentFor(
    dimensions,
    dataset?.extra?.whole_extent as number[] | undefined,
  );
  const { min, max } = sliceRangeFor(extent, axis);
  return Math.max(min, Math.min(requested, max));
}

export function camerasEqual(left: CameraState | null, right: CameraState | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (left.parallel_projection ?? false) === (right.parallel_projection ?? false)
    && left.parallel_scale === right.parallel_scale
    && left.position.every((value, index) => value === right.position[index])
    && left.focal_point.every((value, index) => value === right.focal_point[index])
    && left.view_up.every((value, index) => value === right.view_up[index]);
}
