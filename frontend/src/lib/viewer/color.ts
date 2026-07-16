/** Color/lookup-table application for geometry and image scenes. */
import vtkColorTransferFunction from "@kitware/vtk.js/Rendering/Core/ColorTransferFunction";
import vtkPiecewiseFunction from "@kitware/vtk.js/Common/DataModel/PiecewiseFunction";
import type { ColorMapName, ScalarSelection, VolumeOpacityPoint } from "../../types";
import { colorMapStops } from "../colormap";
import { DEFAULT_VOLUME_OPACITY_POINTS, isRuntimeImageScalar } from "../imageData";
import type { Scene, VtkDataSet } from "./vtkTypes";

export function createLut(range: [number, number], colorMap: ColorMapName) {
  const width = range[1] - range[0];
  const epsilon = Math.max(Math.abs(range[0]) * 1e-6, 1e-6);
  const mappingRange: [number, number] =
    width > 0 ? range : [range[0] - epsilon, range[1] + epsilon];
  const lut = vtkColorTransferFunction.newInstance();
  lut.setVectorModeToMagnitude();
  for (const stop of colorMapStops(colorMap)) {
    const value = mappingRange[0] + stop.position * (mappingRange[1] - mappingRange[0]);
    lut.addRGBPoint(value, ...stop.rgb);
  }
  return lut;
}

export function arrayRange(
  output: VtkDataSet | null,
  selection: ScalarSelection,
): [number, number] | null {
  const attributes =
    selection.association === "cell" ? output?.getCellData?.() : output?.getPointData();
  const array = attributes?.getArrayByName?.(selection.name);
  if (!array) return null;
  const component = (array.getNumberOfComponents?.() ?? 1) > 1 ? -1 : 0;
  const range = array.getRange?.(component);
  if (!range || range.length < 2 || !range.every(Number.isFinite) || range[0] > range[1]) {
    return null;
  }
  return [range[0], range[1]];
}

export function applyGeometryColor(
  scene: Scene,
  selection: ScalarSelection | null,
  range: [number, number] | null,
  map: ColorMapName,
) {
  scene.lut?.delete?.();
  scene.lut = null;
  if (!scene.mapper) return;
  if (!selection || !range) {
    scene.mapper.setScalarVisibility(false);
    return;
  }
  const lut = createLut(range, map);
  scene.lut = lut;
  scene.mapper.setLookupTable(lut);
  scene.mapper.setColorModeToMapScalars();
  if (selection.association === "cell") scene.mapper.setScalarModeToUseCellFieldData();
  else scene.mapper.setScalarModeToUsePointFieldData();
  scene.mapper.setColorByArrayName(selection.name);
  scene.mapper.setScalarVisibility(true);
  scene.mapper.setUseLookupTableScalarRange(true);
}

export function applyImageColor(
  scene: Scene,
  selection: ScalarSelection | null,
  range: [number, number] | null,
  map: ColorMapName,
  opacity: number,
  volumeOpacityPoints: VolumeOpacityPoint[],
): boolean {
  if (!scene.output || !scene.prop || !scene.mapper) return false;
  if (!selection || selection.association !== "point" || !range) return false;
  const selectedArray = scene.output.getPointData().getArrayByName?.(selection.name);
  if (!isRuntimeImageScalar(selectedArray)) return false;
  scene.output.getPointData().setActiveScalars(selection.name);
  scene.lut?.delete?.();
  scene.opacityFunction?.delete?.();
  scene.lut = createLut(range, map);
  const property = scene.prop.getProperty();
  property.setRGBTransferFunction(0, scene.lut);
  if (scene.kind === "slice") {
    property.setColorWindow(Math.max(range[1] - range[0], Number.EPSILON));
    property.setColorLevel((range[0] + range[1]) / 2);
    property.setOpacity(opacity);
  } else {
    const epsilon = Math.max(Math.abs(range[0]) * 1e-6, 1e-6);
    const opacityRange: [number, number] = range[0] < range[1]
      ? range
      : [range[0] - epsilon, range[1] + epsilon];
    const opacityFunction = vtkPiecewiseFunction.newInstance();
    const points = volumeOpacityPoints.length >= 2
      ? volumeOpacityPoints
      : DEFAULT_VOLUME_OPACITY_POINTS;
    const span = opacityRange[1] - opacityRange[0];
    // vtkPiecewiseFunction replaces (not stacks) nodes with an equal x, so two
    // control points clamped to the same value would silently drop one —
    // typically the alpha=0 endpoint. Nudge duplicates apart instead.
    let previousX = Number.NEGATIVE_INFINITY;
    for (const point of [...points].sort((a, b) => a.value - b.value)) {
      const x = opacityRange[0] + Math.max(0, Math.min(1, point.value)) * span;
      const distinctX = x <= previousX ? previousX + Math.max(span * 1e-6, 1e-9) : x;
      previousX = distinctX;
      opacityFunction.addPoint(
        distinctX,
        Math.max(0, Math.min(1, point.alpha)) * Math.max(0, opacity),
      );
    }
    scene.opacityFunction = opacityFunction;
    property.setScalarOpacity(0, opacityFunction);
    property.setInterpolationTypeToLinear();
    property.setShade(true);
    const spacing = scene.output.getSpacing().map((value) => Math.abs(value)).filter(Boolean);
    scene.mapper.setSampleDistance(Math.max(Math.min(...spacing, 1) * 0.7, 1e-6));
  }
  return true;
}
