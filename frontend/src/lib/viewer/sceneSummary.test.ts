import { describe, expect, it } from "vitest";
import { summarizeScene } from "./sceneSummary";
import type { VtkDataSet } from "./vtkTypes";

function array(name: string, components: number, range: number[]) {
  return {
    getName: () => name,
    getNumberOfComponents: () => components,
    getRange: () => range,
  };
}

describe("summarizeScene", () => {
  it("reports counts, finite bounds, and point/cell arrays", () => {
    const output = {
      getPointData: () => ({ getArrays: () => [array("t", 1, [1, 2]), array("v", 3, [0, 5])] }),
      getCellData: () => ({ getArrays: () => [array("id", 1, [0, 3])] }),
      getBounds: () => [0, 1, 0, 2, 0, 3],
      getNumberOfPoints: () => 8,
      getNumberOfCells: () => 4,
      getSpacing: () => [1, 1, 1],
    } as unknown as VtkDataSet;
    expect(summarizeScene(output)).toEqual({
      num_points: 8,
      num_cells: 4,
      bounds: [0, 1, 0, 2, 0, 3],
      arrays: [
        { name: "t", association: "point", num_components: 1, data_type: "numeric", value_range: [1, 2] },
        { name: "v", association: "point", num_components: 3, data_type: "numeric", value_range: [0, 5] },
        { name: "id", association: "cell", num_components: 1, data_type: "numeric", value_range: [0, 3] },
      ],
    });
  });

  it("drops non-finite bounds and ranges and tolerates missing accessors", () => {
    const output = {
      getPointData: () => ({ getArrays: () => [array("nan", 1, [NaN, 1]), array("", 1, [0, 1])] }),
      getBounds: () => [Infinity, -Infinity, 0, 1, 0, 1],
      getNumberOfPoints: () => 0,
      getSpacing: () => [1, 1, 1],
    } as unknown as VtkDataSet;
    expect(summarizeScene(output)).toEqual({
      num_points: 0,
      num_cells: null,
      bounds: null,
      arrays: [{ name: "nan", association: "point", num_components: 1, data_type: "numeric", value_range: null }],
    });
    expect(summarizeScene(null)).toBeNull();
  });
});
