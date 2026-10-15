/** Extract dataset metadata from a parsed vtk.js data object so browser-local
 * files get the same properties-panel information as server-ingested ones. */
import type { ArrayInfo } from "../../types";
import type { SceneSummary } from "../localDataset";
import type { VtkAttributes, VtkDataArrayLike, VtkDataSet } from "./vtkTypes";

function finiteRange(array: VtkDataArrayLike): [number, number] | null {
  const components = array.getNumberOfComponents?.() ?? 1;
  const range = array.getRange?.(components > 1 ? -1 : 0);
  if (!range || range.length < 2) return null;
  const [minimum, maximum] = range;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return null;
  return [minimum, maximum];
}

function describeArrays(
  attributes: VtkAttributes | null | undefined,
  association: "point" | "cell",
): ArrayInfo[] {
  return (attributes?.getArrays?.() ?? []).flatMap((array) => {
    const name = array.getName?.() ?? "";
    if (!name) return [];
    return [{
      name,
      association,
      num_components: array.getNumberOfComponents?.() ?? 1,
      data_type: "numeric",
      value_range: finiteRange(array),
    }];
  });
}

export function summarizeScene(output: VtkDataSet | null | undefined): SceneSummary | null {
  if (!output) return null;
  const bounds = output.getBounds?.();
  const finiteBounds = Array.isArray(bounds) && bounds.length === 6
    && bounds.every((value) => Number.isFinite(value))
    ? [...bounds]
    : null;
  const numCells = output.getNumberOfCells?.();
  return {
    num_points: output.getNumberOfPoints?.() ?? null,
    num_cells: typeof numCells === "number" ? numCells : null,
    bounds: finiteBounds,
    arrays: [
      ...describeArrays(output.getPointData(), "point"),
      ...describeArrays(output.getCellData?.(), "cell"),
    ],
  };
}
