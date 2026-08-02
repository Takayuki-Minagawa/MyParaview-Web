import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkGlyph3DMapper from "@kitware/vtk.js/Rendering/Core/Glyph3DMapper";
import vtkPoints from "@kitware/vtk.js/Common/Core/Points";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkArrowSource from "@kitware/vtk.js/Filters/Sources/ArrowSource";
import type { Scene, VtkDataArrayLike, VtkDataSet, VtkProp } from "./vtkTypes";

export const MAX_VECTOR_GLYPHS = 2_000;
export const VECTOR_GLYPH_SCALE_MIN = 0.1;
export const VECTOR_GLYPH_SCALE_MAX = 5;

const VECTOR_ARRAY_NAME = "__pvweb_glyph_vector";
const DEFAULT_ARROW_LENGTH_FRACTION = 0.08;

export interface VectorGlyphSettings {
  enabled: boolean;
  arrayName: string | null;
  /** Relative multiplier around the automatically normalized arrow size. */
  scale: number;
}

export interface VectorGlyphSummary {
  glyphCount: number;
  sourcePointCount: number;
}

interface SampledVectors extends VectorGlyphSummary {
  points: Float32Array;
  vectors: Float32Array;
  maxMagnitude: number;
}

interface GlyphResources {
  actor: VtkProp;
  mapper: ReturnType<typeof vtkGlyph3DMapper.newInstance>;
  source: ReturnType<typeof vtkArrowSource.newInstance>;
  input: ReturnType<typeof vtkPolyData.newInstance>;
  points: ReturnType<typeof vtkPoints.newInstance>;
  vectorArray: ReturnType<typeof vtkDataArray.newInstance>;
  arrayName: string;
  baseScale: number;
  summary: VectorGlyphSummary;
}

export interface VectorGlyphController {
  apply: (settings: VectorGlyphSettings) => VectorGlyphSummary | null;
  delete: () => void;
}

function finitePositive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function clampedScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(VECTOR_GLYPH_SCALE_MIN, Math.min(VECTOR_GLYPH_SCALE_MAX, value));
}

/** Select indices across the full domain, always including both ends when possible. */
export function deterministicSampleIndices(total: number, limit: number): number[] {
  if (!Number.isFinite(total) || !Number.isFinite(limit)) return [];
  const count = Math.max(0, Math.floor(total));
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (count === 0 || boundedLimit === 0) return [];
  if (count <= boundedLimit) return Array.from({ length: count }, (_, index) => index);
  if (boundedLimit === 1) return [0];

  const last = count - 1;
  return Array.from(
    { length: boundedLimit },
    (_, index) => Math.round((index * last) / (boundedLimit - 1)),
  );
}

/** Named three-component point arrays are directly usable as arrow vectors. */
export function pointVectorArrayNames(dataset: VtkDataSet | null): string[] {
  const arrays = dataset?.getPointData().getArrays?.() ?? [];
  return Array.from(new Set(arrays.flatMap((array) => {
    const name = array.getName?.();
    return name?.trim() && array.getNumberOfComponents?.() === 3 ? [name] : [];
  }))).sort();
}

function arrayValues(array: VtkDataArrayLike): ArrayLike<number> | null {
  return array.getData?.() ?? null;
}

/** Extract a bounded point/vector subset without mutating the source dataset. */
export function samplePointVectors(
  dataset: VtkDataSet,
  arrayName: string,
  limit = MAX_VECTOR_GLYPHS,
): SampledVectors | null {
  const pointValues = dataset.getPoints?.()?.getData?.();
  const vectorArray = dataset.getPointData().getArrayByName?.(arrayName);
  const vectorValues = vectorArray ? arrayValues(vectorArray) : null;
  if (!pointValues || !vectorValues || vectorArray?.getNumberOfComponents?.() !== 3) return null;

  const sourcePointCount = Math.min(
    Math.floor(pointValues.length / 3),
    Math.floor(vectorValues.length / 3),
  );
  let validVectorCount = 0;
  let maxMagnitude = 0;

  const magnitudeAt = (pointIndex: number): number | null => {
    const offset = pointIndex * 3;
    const px = pointValues[offset];
    const py = pointValues[offset + 1];
    const pz = pointValues[offset + 2];
    const vx = vectorValues[offset];
    const vy = vectorValues[offset + 1];
    const vz = vectorValues[offset + 2];
    if (
      !Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)
      || !Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)
    ) return null;
    const magnitude = Math.hypot(vx, vy, vz);
    return finitePositive(magnitude) ? magnitude : null;
  };

  // Count first so sampling is distributed over valid vectors rather than
  // accidentally selecting only zero/invalid tuples in a sparse array.
  for (let pointIndex = 0; pointIndex < sourcePointCount; pointIndex += 1) {
    const magnitude = magnitudeAt(pointIndex);
    if (magnitude === null) continue;
    validVectorCount += 1;
    maxMagnitude = Math.max(maxMagnitude, magnitude);
  }

  if (validVectorCount === 0 || !finitePositive(maxMagnitude)) return null;
  const targetOrdinals = deterministicSampleIndices(validVectorCount, limit);
  const sampledPoints: number[] = [];
  const sampledVectors: number[] = [];
  let validOrdinal = 0;
  let targetCursor = 0;
  for (
    let pointIndex = 0;
    pointIndex < sourcePointCount && targetCursor < targetOrdinals.length;
    pointIndex += 1
  ) {
    if (magnitudeAt(pointIndex) === null) continue;
    if (validOrdinal === targetOrdinals[targetCursor]) {
      const offset = pointIndex * 3;
      sampledPoints.push(pointValues[offset], pointValues[offset + 1], pointValues[offset + 2]);
      sampledVectors.push(vectorValues[offset], vectorValues[offset + 1], vectorValues[offset + 2]);
      targetCursor += 1;
    }
    validOrdinal += 1;
  }

  return {
    points: new Float32Array(sampledPoints),
    vectors: new Float32Array(sampledVectors),
    glyphCount: sampledPoints.length / 3,
    sourcePointCount,
    maxMagnitude,
  };
}

function normalizedBaseScale(dataset: VtkDataSet, maxMagnitude: number): number {
  const bounds = dataset.getBounds();
  const diagonal = Math.hypot(
    bounds[1] - bounds[0],
    bounds[3] - bounds[2],
    bounds[5] - bounds[4],
  );
  return finitePositive(diagonal) && finitePositive(maxMagnitude)
    ? (diagonal * DEFAULT_ARROW_LENGTH_FRACTION) / maxMagnitude
    : 1;
}

/** Owns the secondary glyph actor and all of its vtk.js resources. */
export function createVectorGlyphController(scene: Scene): VectorGlyphController | null {
  if (!scene.output || scene.kind !== "geometry") return null;
  const dataset = scene.output;
  let resources: GlyphResources | null = null;

  const clear = (render: boolean) => {
    if (!resources) return;
    scene.renderer.removeActor(resources.actor);
    resources.actor.delete?.();
    resources.mapper.delete?.();
    resources.source.delete?.();
    resources.vectorArray.delete?.();
    resources.points.delete?.();
    resources.input.delete?.();
    resources = null;
    if (render) scene.renderWindow.render();
  };

  const apply = (settings: VectorGlyphSettings): VectorGlyphSummary | null => {
    const arrayName = settings.arrayName?.trim() ? settings.arrayName : null;
    if (!settings.enabled || !arrayName) {
      clear(true);
      return null;
    }

    if (resources?.arrayName === arrayName) {
      resources.mapper.setScaleFactor(resources.baseScale * clampedScale(settings.scale));
      scene.renderer.resetCameraClippingRange();
      scene.renderWindow.render();
      return resources.summary;
    }

    clear(false);
    const sampled = samplePointVectors(dataset, arrayName);
    if (!sampled) {
      scene.renderWindow.render();
      return null;
    }

    const input = vtkPolyData.newInstance();
    const points = vtkPoints.newInstance();
    points.setData(sampled.points, 3);
    input.setPoints(points);
    const vectorArray = vtkDataArray.newInstance({
      name: VECTOR_ARRAY_NAME,
      numberOfComponents: 3,
      values: sampled.vectors,
    });
    input.getPointData().addArray(vectorArray);

    const source = vtkArrowSource.newInstance({
      shaftResolution: 6,
      tipResolution: 6,
      shaftRadius: 0.035,
      tipRadius: 0.1,
      tipLength: 0.3,
    });
    const baseScale = normalizedBaseScale(dataset, sampled.maxMagnitude);
    const mapper = vtkGlyph3DMapper.newInstance({
      orient: true,
      orientationArray: VECTOR_ARRAY_NAME,
      scaling: true,
      scaleArray: VECTOR_ARRAY_NAME,
      scaleFactor: baseScale * clampedScale(settings.scale),
    });
    mapper.setOrientationModeToDirection();
    mapper.setScaleModeToScaleByMagnitude();
    mapper.setInputData(input);
    mapper.setSourceConnection(source.getOutputPort());
    mapper.setScalarVisibility(false);

    const actor = vtkActor.newInstance();
    actor.setMapper(mapper);
    // Glyphs are an overlay; keep G2 probe and G3 measurement picking aimed at
    // the source geometry rather than at synthetic arrow primitives.
    actor.setPickable(false);
    actor.getProperty().setColor(0.96, 0.58, 0.12);
    actor.getProperty().setOpacity(0.95);
    scene.renderer.addActor(actor as unknown as VtkProp);
    resources = {
      actor: actor as unknown as VtkProp,
      mapper,
      source,
      input,
      points,
      vectorArray,
      arrayName,
      baseScale,
      summary: {
        glyphCount: sampled.glyphCount,
        sourcePointCount: sampled.sourcePointCount,
      },
    };
    scene.renderer.resetCameraClippingRange();
    scene.renderWindow.render();
    return resources.summary;
  };

  return {
    apply,
    delete: () => clear(false),
  };
}
