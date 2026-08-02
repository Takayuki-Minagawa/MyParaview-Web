import { describe, expect, it } from "vitest";
import type { VtkAttributes, VtkDataSet } from "./vtkTypes";
import { probeValues, scalarValuesAt } from "./probe";

function attributes(arrays: Array<{
  name: string;
  components: number;
  tuples: number[][];
}>): VtkAttributes {
  return {
    addArray: () => {},
    setActiveScalars: () => {},
    getArrays: () => arrays.map((array) => ({
      getName: () => array.name,
      getNumberOfComponents: () => array.components,
      getTuple: (id: number) => array.tuples[id] ?? [],
    })),
  };
}

describe("scalarValuesAt", () => {
  it("returns finite scalar tuples and omits vectors/non-finite values", () => {
    const values = scalarValuesAt(attributes([
      { name: "temperature", components: 1, tuples: [[10], [20]] },
      { name: "velocity", components: 3, tuples: [[1, 2, 3], [4, 5, 6]] },
      { name: "missing", components: 1, tuples: [[NaN], [Infinity]] },
    ]), 1, "point");

    expect(values).toEqual([{ association: "point", name: "temperature", value: 20 }]);
  });

  it("returns no values without a selected tuple", () => {
    expect(scalarValuesAt(attributes([]), null, "cell")).toEqual([]);
  });
});

describe("probeValues", () => {
  it("combines selected point and cell scalars", () => {
    const pointData = attributes([{ name: "p", components: 1, tuples: [[2]] }]);
    const cellData = attributes([{ name: "c", components: 1, tuples: [[3]] }]);
    const output = {
      getPointData: () => pointData,
      getCellData: () => cellData,
    } as unknown as VtkDataSet;

    expect(probeValues(output, 0, 0)).toEqual([
      { association: "point", name: "p", value: 2 },
      { association: "cell", name: "c", value: 3 },
    ]);
  });
});
