import { describe, expect, it, vi } from "vitest";
import type { Scene, VtkDataArrayLike, VtkDataSet } from "./vtkTypes";
import {
  createVectorGlyphController,
  deterministicSampleIndices,
  MAX_VECTOR_GLYPHS,
  pointVectorArrayNames,
  samplePointVectors,
} from "./vectorGlyph";

interface ArrayFixture {
  name: string;
  components: number;
  values: ArrayLike<number>;
}

function dataArray(fixture: ArrayFixture): VtkDataArrayLike {
  return {
    getName: () => fixture.name,
    getNumberOfComponents: () => fixture.components,
    getData: () => fixture.values,
  };
}

function dataset(points: ArrayLike<number>, arrays: ArrayFixture[]): VtkDataSet {
  const vtkArrays = arrays.map(dataArray);
  return {
    getPointData: () => ({
      getArrays: () => vtkArrays,
      getArrayByName: (name) => vtkArrays.find((array) => array.getName?.() === name) ?? null,
      getNumberOfArrays: () => vtkArrays.length,
      setActiveScalars: () => {},
      addArray: () => {},
    }),
    getCellData: () => ({
      setActiveScalars: () => {},
      addArray: () => {},
    }),
    getPoints: () => ({ getData: () => points }),
    getSpacing: () => [1, 1, 1],
    getBounds: () => [0, 10, 0, 4, 0, 2],
    getNumberOfPoints: () => Math.floor(points.length / 3),
  };
}

describe("deterministicSampleIndices", () => {
  it("spreads a bounded sample across the full point range", () => {
    expect(deterministicSampleIndices(10, 4)).toEqual([0, 3, 6, 9]);
    expect(deterministicSampleIndices(11, 4)).toEqual([0, 3, 7, 10]);
    expect(deterministicSampleIndices(3, 10)).toEqual([0, 1, 2]);
  });

  it("handles empty and one-point limits", () => {
    expect(deterministicSampleIndices(10, 1)).toEqual([0]);
    expect(deterministicSampleIndices(10, 0)).toEqual([]);
    expect(deterministicSampleIndices(0, 10)).toEqual([]);
    expect(deterministicSampleIndices(Number.POSITIVE_INFINITY, 10)).toEqual([]);
  });
});

describe("pointVectorArrayNames", () => {
  it("returns sorted, unique named three-component point arrays", () => {
    const output = dataset(new Float32Array([0, 0, 0]), [
      { name: "velocity", components: 3, values: new Float32Array(3) },
      { name: "pressure", components: 1, values: new Float32Array(1) },
      { name: "displacement", components: 3, values: new Float32Array(3) },
      { name: " flow vector ", components: 3, values: new Float32Array(3) },
      { name: "velocity", components: 3, values: new Float32Array(3) },
      { name: " ", components: 3, values: new Float32Array(3) },
    ]);

    expect(pointVectorArrayNames(output)).toEqual([" flow vector ", "displacement", "velocity"]);
  });
});

describe("samplePointVectors", () => {
  it("caps large datasets and deterministically includes the final point", () => {
    const count = MAX_VECTOR_GLYPHS + 501;
    const points = new Float32Array(count * 3);
    const vectors = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      points[index * 3] = index;
      vectors[index * 3] = 1;
    }
    const sampled = samplePointVectors(dataset(points, [
      { name: "velocity", components: 3, values: vectors },
    ]), "velocity");

    expect(sampled?.glyphCount).toBe(MAX_VECTOR_GLYPHS);
    expect(sampled?.sourcePointCount).toBe(count);
    expect(sampled?.points[0]).toBe(0);
    expect(sampled?.points[(sampled?.points.length ?? 0) - 3]).toBe(count - 1);
  });

  it("skips non-finite and zero vectors without exceeding the requested limit", () => {
    const output = dataset(new Float32Array([
      0, 0, 0,
      1, 0, 0,
      2, 0, 0,
      Number.NaN, 0, 0,
    ]), [{
      name: "velocity",
      components: 3,
      values: new Float32Array([
        1, 0, 0,
        0, 0, 0,
        0, 2, 0,
        0, 0, 3,
      ]),
    }]);

    const sampled = samplePointVectors(output, "velocity", 4);
    expect(sampled?.glyphCount).toBe(2);
    expect(Array.from(sampled?.points ?? [])).toEqual([0, 0, 0, 2, 0, 0]);
    expect(sampled?.maxMagnitude).toBe(2);
  });

  it("samples over valid tuples so a sparse non-zero vector is not missed", () => {
    const count = MAX_VECTOR_GLYPHS + 501;
    const points = new Float32Array(count * 3);
    const vectors = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) points[index * 3] = index;
    vectors[1 * 3 + 1] = 4;
    const sampled = samplePointVectors(dataset(points, [
      { name: "sparse", components: 3, values: vectors },
    ]), "sparse");

    expect(sampled?.glyphCount).toBe(1);
    expect(sampled?.points[0]).toBe(1);
    expect(sampled?.vectors[1]).toBe(4);
  });

  it("rejects missing and non-vector arrays", () => {
    const output = dataset(new Float32Array([0, 0, 0]), [
      { name: "pressure", components: 1, values: new Float32Array([1]) },
    ]);
    expect(samplePointVectors(output, "missing")).toBeNull();
    expect(samplePointVectors(output, "pressure")).toBeNull();
  });
});

describe("createVectorGlyphController", () => {
  it("reuses resources for scale-only changes and releases them on disable/delete", () => {
    const output = dataset(new Float32Array([0, 0, 0, 1, 0, 0]), [{
      name: "velocity",
      components: 3,
      values: new Float32Array([1, 0, 0, 0, 2, 0]),
    }]);
    const addActor = vi.fn();
    const removeActor = vi.fn();
    const render = vi.fn();
    const scene = {
      kind: "geometry",
      output,
      renderer: {
        addActor,
        removeActor,
        resetCameraClippingRange: vi.fn(),
      },
      renderWindow: { render },
    } as unknown as Scene;
    const controller = createVectorGlyphController(scene);

    expect(controller?.apply({ enabled: true, arrayName: "velocity", scale: 1 })).toEqual({
      glyphCount: 2,
      sourcePointCount: 2,
    });
    controller?.apply({ enabled: true, arrayName: "velocity", scale: 2 });
    expect(addActor).toHaveBeenCalledTimes(1);
    expect(removeActor).not.toHaveBeenCalled();

    controller?.apply({ enabled: false, arrayName: "velocity", scale: 2 });
    expect(removeActor).toHaveBeenCalledTimes(1);
    controller?.apply({ enabled: true, arrayName: "velocity", scale: 1 });
    controller?.delete();
    expect(addActor).toHaveBeenCalledTimes(2);
    expect(removeActor).toHaveBeenCalledTimes(2);
  });
});
