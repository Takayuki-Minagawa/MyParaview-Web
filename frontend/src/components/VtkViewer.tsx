import { useEffect, useRef, useState } from "react";
import type {
  CameraState,
  ColorMapName,
  ImageMode,
  Representation,
  ScalarSelection,
  SliceAxis,
  TableCoordinates,
  VolumeOpacityPoint,
} from "../types";
import { colorMapCssGradient, colorMapStops } from "../lib/colormap";
import { triggerBlobDownload } from "../lib/download";
import { csvToPointData } from "../lib/csvToPoints";
import { authorizedFetch } from "../api";
import { DEFAULT_VOLUME_OPACITY_POINTS, isRuntimeImageScalar } from "../lib/imageData";
import { useMessages } from "../i18n-context";
import type { Messages } from "../i18n";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import "@kitware/vtk.js/Rendering/Profiles/Volume";
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import vtkXMLPolyDataReader from "@kitware/vtk.js/IO/XML/XMLPolyDataReader";
import vtkXMLImageDataReader from "@kitware/vtk.js/IO/XML/XMLImageDataReader";
import vtkXMLPolyDataWriter from "@kitware/vtk.js/IO/XML/XMLPolyDataWriter";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkColorTransferFunction from "@kitware/vtk.js/Rendering/Core/ColorTransferFunction";
import vtkAxesActor from "@kitware/vtk.js/Rendering/Core/AxesActor";
import vtkOrientationMarkerWidget from "@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkPoints from "@kitware/vtk.js/Common/Core/Points";
import vtkCellArray from "@kitware/vtk.js/Common/Core/CellArray";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkImageMapper from "@kitware/vtk.js/Rendering/Core/ImageMapper";
import vtkImageSlice from "@kitware/vtk.js/Rendering/Core/ImageSlice";
import vtkVolume from "@kitware/vtk.js/Rendering/Core/Volume";
import vtkVolumeMapper from "@kitware/vtk.js/Rendering/Core/VolumeMapper";
import vtkPiecewiseFunction from "@kitware/vtk.js/Common/DataModel/PiecewiseFunction";
import vtkGlyph3DMapper from "@kitware/vtk.js/Rendering/Core/Glyph3DMapper";
import vtkSphereSource from "@kitware/vtk.js/Filters/Sources/SphereSource";

const REPR_CODE: Record<Representation, number> = { points: 0, wireframe: 1, surface: 2 };
const SLICE_MODE: Record<SliceAxis, "I" | "J" | "K"> = { X: "I", Y: "J", Z: "K" };
type CameraPreset = "front" | "side" | "top" | "back" | "bottom" | "isometric";

/** vtk.js deep imports are untyped (see vtk-shim.d.ts); VtkHandle documents the
 * lifecycle contract we rely on while keeping Scene field names type-checked. */
interface VtkHandle {
  delete?: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [member: string]: any;
}

interface DisplaySettings {
  representation: Representation;
  colorBy: ScalarSelection | null;
  colorRange: [number, number] | null;
  opacity: number;
  colorMap: ColorMapName;
  cameraState: CameraState | null;
  legendVisible: boolean;
  sliceAxis: SliceAxis;
  sliceIndex: number;
  volumeOpacityPoints: VolumeOpacityPoint[];
}

interface Scene {
  kind: "geometry" | "slice" | "volume";
  grw: VtkHandle;
  renderer: VtkHandle;
  renderWindow: VtkHandle;
  axes: VtkHandle;
  orientationWidget: VtkHandle;
  resizeObserver: ResizeObserver;
  mapper: VtkHandle | null;
  prop: VtkHandle | null;
  reader: VtkHandle | null;
  output: VtkHandle | null;
  createdOutput: boolean;
  glyphSource: VtkHandle | null;
  pointGlyph: boolean;
  lut: VtkHandle | null;
  opacityFunction: VtkHandle | null;
  cameraSubscription: { unsubscribe?: () => void } | null;
  emitCamera: () => void;
  dataDiagnostic?: string;
}

interface Props {
  datasetId: string | null;
  url: string | null;
  datasetType?: string | null;
  emptyMessage?: string;
  representation: Representation;
  colorBy: ScalarSelection | null;
  colorRange: [number, number] | null;
  opacity: number;
  colorMap: ColorMapName;
  legendVisible: boolean;
  axesVisible: boolean;
  tableCoordinates: TableCoordinates | null;
  imageMode: ImageMode;
  sliceAxis: SliceAxis;
  sliceIndex: number;
  volumeOpacityPoints: VolumeOpacityPoint[];
  onColorRangeResolved?: (selection: ScalarSelection, range: [number, number]) => void;
  onLoadComplete?: () => void;
  cameraState: CameraState | null;
  onCameraChange: (camera: CameraState) => void;
  onScreenshotCaptured?: (blob: Blob, datasetId: string | null) => void;
  onGeometryExported?: (blob: Blob, datasetId: string | null) => void;
  screenshotNonce: number;
  exportNonce: number;
  resetNonce: number;
  viewerBackground: [number, number, number];
}

function createLut(range: [number, number], colorMap: ColorMapName) {
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

function arrayRange(output: VtkHandle | null, selection: ScalarSelection): [number, number] | null {
  const attributes =
    selection.association === "cell" ? output?.getCellData?.() : output?.getPointData?.();
  const array = attributes?.getArrayByName?.(selection.name);
  if (!array) return null;
  const component = (array.getNumberOfComponents?.() ?? 1) > 1 ? -1 : 0;
  const range = array.getRange?.(component);
  if (!range || range.length < 2 || !range.every(Number.isFinite) || range[0] > range[1]) {
    return null;
  }
  return [range[0], range[1]];
}

function applyGeometryColor(scene: Scene, selection: ScalarSelection | null, range: [number, number] | null, map: ColorMapName) {
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

function applyImageColor(
  scene: Scene,
  selection: ScalarSelection | null,
  range: [number, number] | null,
  map: ColorMapName,
  opacity: number,
  volumeOpacityPoints: VolumeOpacityPoint[],
) {
  if (!scene.output || !scene.prop || !scene.mapper) return false;
  if (!selection || selection.association !== "point" || !range) return false;
  const selectedArray = scene.output.getPointData?.().getArrayByName?.(selection.name);
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
    const spacing = scene.output.getSpacing().map((value: number) => Math.abs(value)).filter(Boolean);
    scene.mapper.setSampleDistance(Math.max(Math.min(...spacing, 1) * 0.7, 1e-6));
  }
  return true;
}

function tableToPolyData(text: string, coordinates: TableCoordinates) {
  const parsed = csvToPointData(text, coordinates);
  const polyData = vtkPolyData.newInstance();
  const points = vtkPoints.newInstance();
  points.setData(parsed.points, 3);
  polyData.setPoints(points);
  const connectivity = new Uint32Array(parsed.numberOfPoints * 2);
  for (let index = 0; index < parsed.numberOfPoints; index += 1) {
    connectivity[index * 2] = 1;
    connectivity[index * 2 + 1] = index;
  }
  const verts = vtkCellArray.newInstance({ values: connectivity });
  polyData.setVerts(verts);
  for (const source of parsed.arrays) {
    polyData.getPointData().addArray(vtkDataArray.newInstance({
      name: source.name,
      numberOfComponents: 1,
      values: source.values,
    }));
  }
  return {
    output: polyData,
    invalidScalarCells: parsed.invalidScalarCells,
    skippedRows: parsed.skippedRows,
  };
}

function csvDiagnostics(
  messages: Messages,
  invalidScalarCells: number,
  skippedRows: number,
): string {
  const parts: string[] = [];
  if (skippedRows > 0) {
    parts.push(
      `${messages.viewer.csvSkippedRowsPrefix}${skippedRows}${messages.viewer.csvSkippedRowsSuffix}`,
    );
  }
  if (invalidScalarCells > 0) {
    parts.push(
      `${messages.viewer.csvInvalidCellsPrefix}${invalidScalarCells}${messages.viewer.csvInvalidCellsSuffix}`,
    );
  }
  return parts.join(" ");
}

function applyRepresentation(scene: Scene, representation: Representation) {
  if (scene.kind !== "geometry" || !scene.prop) return;
  const property = scene.prop.getProperty();
  property.setRepresentation(scene.pointGlyph ? REPR_CODE.surface : REPR_CODE[representation]);
  property.setEdgeVisibility(representation === "surface");
  property.setPointSize(representation === "points" ? 7 : 1);
}

function applyCameraPreset(scene: Scene | null, preset: CameraPreset) {
  if (!scene) return;
  const camera = scene.renderer.getActiveCamera();
  const focal = camera.getFocalPoint();
  const distance = Math.max(camera.getDistance?.() ?? 1, 1e-6);
  const definitions: Record<CameraPreset, { direction: number[]; up: number[] }> = {
    front: { direction: [0, -1, 0], up: [0, 0, 1] },
    side: { direction: [1, 0, 0], up: [0, 0, 1] },
    top: { direction: [0, 0, 1], up: [0, 1, 0] },
    back: { direction: [0, 1, 0], up: [0, 0, 1] },
    bottom: { direction: [0, 0, -1], up: [0, -1, 0] },
    isometric: { direction: [1, -1, 1], up: [0, 0, 1] },
  };
  const { direction, up } = definitions[preset];
  const length = Math.hypot(...direction);
  camera.setPosition(
    focal[0] + (direction[0] / length) * distance,
    focal[1] + (direction[1] / length) * distance,
    focal[2] + (direction[2] / length) * distance,
  );
  camera.setViewUp(...up);
  scene.renderer.resetCameraClippingRange();
  scene.renderWindow.render();
  scene.emitCamera?.();
}

function readCamera(scene: Scene): CameraState {
  const camera = scene.renderer.getActiveCamera();
  return {
    position: [...camera.getPosition()] as CameraState["position"],
    focal_point: [...camera.getFocalPoint()] as CameraState["focal_point"],
    view_up: [...camera.getViewUp()] as CameraState["view_up"],
    parallel_scale: camera.getParallelScale(),
  };
}

function applySavedCamera(scene: Scene, state: CameraState) {
  const camera = scene.renderer.getActiveCamera();
  camera.setPosition(...state.position);
  camera.setFocalPoint(...state.focal_point);
  camera.setViewUp(...state.view_up);
  camera.setParallelScale(state.parallel_scale);
  scene.renderer.resetCameraClippingRange();
  scene.renderWindow.render();
}

async function createScreenshotBlob(dataUrl: string, settings: {
  colorBy: ScalarSelection | null;
  colorRange: [number, number] | null;
  colorMap: ColorMapName;
  legendVisible: boolean;
}): Promise<Blob> {
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("captured image could not be decoded"));
  });
  image.src = dataUrl;
  await loaded;
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");
  context.drawImage(image, 0, 0);
  if (settings.legendVisible && settings.colorBy && settings.colorRange) {
    const width = Math.min(280, Math.max(180, canvas.width * 0.28));
    const x = canvas.width - width - 18;
    const y = canvas.height - 86;
    context.fillStyle = "rgba(15, 17, 23, 0.86)";
    context.fillRect(x, y, width, 68);
    context.fillStyle = "#f3f4f6";
    context.font = "12px system-ui, sans-serif";
    context.fillText(`${settings.colorBy.association} · ${settings.colorBy.name}`, x + 10, y + 18);
    const gradient = context.createLinearGradient(x + 10, 0, x + width - 10, 0);
    for (const stop of colorMapStops(settings.colorMap)) {
      const [r, g, b] = stop.rgb.map((value) => Math.round(value * 255));
      gradient.addColorStop(stop.position, `rgb(${r}, ${g}, ${b})`);
    }
    context.fillStyle = gradient;
    context.fillRect(x + 10, y + 26, width - 20, 12);
    context.fillStyle = "#f3f4f6";
    context.font = "10px ui-monospace, monospace";
    context.fillText(settings.colorRange[0].toPrecision(5), x + 10, y + 54);
    const maximum = settings.colorRange[1].toPrecision(5);
    context.fillText(maximum, x + width - 10 - context.measureText(maximum).width, y + 54);
  }
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG encoding failed")), "image/png"),
  );
}

export function VtkViewer(props: Props) {
  const {
    datasetId, url, datasetType, emptyMessage, representation, colorBy, colorRange, opacity, colorMap,
    legendVisible, axesVisible, tableCoordinates, imageMode, sliceAxis, sliceIndex,
    volumeOpacityPoints,
    onColorRangeResolved, onLoadComplete, cameraState, onCameraChange, onScreenshotCaptured,
    onGeometryExported, screenshotNonce, exportNonce, resetNonce, viewerBackground,
  } = props;
  const messages = useMessages();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const ctx = useRef<Scene | null>(null);
  const [status, setStatus] = useState("");
  const rangeCallbackRef = useRef(onColorRangeResolved);
  rangeCallbackRef.current = onColorRangeResolved;
  const loadCallbackRef = useRef(onLoadComplete);
  loadCallbackRef.current = onLoadComplete;
  const cameraCallbackRef = useRef(onCameraChange);
  cameraCallbackRef.current = onCameraChange;
  const screenshotCallbackRef = useRef(onScreenshotCaptured);
  screenshotCallbackRef.current = onScreenshotCaptured;
  const exportCallbackRef = useRef(onGeometryExported);
  exportCallbackRef.current = onGeometryExported;
  const datasetIdRef = useRef(datasetId);
  datasetIdRef.current = datasetId;
  // The scene-building effect must not rebuild (and re-fetch the dataset) when
  // only display settings, translations, or theme background change — those are
  // read through refs / applied by light effects instead.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const backgroundRef = useRef(viewerBackground);
  backgroundRef.current = viewerBackground;
  const axesVisibleRef = useRef(axesVisible);
  axesVisibleRef.current = axesVisible;
  const displayRef = useRef<DisplaySettings>({
    representation, colorBy, colorRange, opacity, colorMap, cameraState, legendVisible,
    sliceAxis, sliceIndex, volumeOpacityPoints,
  });
  displayRef.current = {
    representation, colorBy, colorRange, opacity, colorMap, cameraState, legendVisible,
    sliceAxis, sliceIndex, volumeOpacityPoints,
  };

  const supported = datasetType === "PolyData" || datasetType === "ImageData" || datasetType === "Table";
  const tableReady = datasetType !== "Table" || (
    !!tableCoordinates && new Set(Object.values(tableCoordinates)).size === 3
  );
  const renderable = !!url && supported && tableReady;

  useEffect(() => {
    if (!containerRef.current || !renderable || !url || !datasetType) return;
    let disposed = false;
    const abortController = new AbortController();
    const strings = messagesRef.current;
    setStatus(strings.viewer.loading);
    const grw = vtkGenericRenderWindow.newInstance({ background: backgroundRef.current });
    grw.setContainer(containerRef.current);
    grw.resize();
    const renderer = grw.getRenderer();
    const renderWindow = grw.getRenderWindow();
    const axes = vtkAxesActor.newInstance();
    const orientationWidget = vtkOrientationMarkerWidget.newInstance({
      actor: axes,
      interactor: renderWindow.getInteractor(),
    });
    orientationWidget.setEnabled(axesVisibleRef.current);
    orientationWidget.setViewportCorner(vtkOrientationMarkerWidget.Corners.BOTTOM_LEFT);
    orientationWidget.setViewportSize(0.14);
    orientationWidget.setMinPixelSize(48);
    orientationWidget.setMaxPixelSize(110);
    const resizeObserver = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (disposed || !box || box.width <= 0 || box.height <= 0) return;
      grw.resize();
      renderWindow.render();
    });
    resizeObserver.observe(containerRef.current);

    const scene: Scene = {
      kind: "geometry", grw, renderer, renderWindow, axes, orientationWidget, resizeObserver,
      mapper: null, prop: null, reader: null, output: null, createdOutput: false,
      glyphSource: null, pointGlyph: false,
      lut: null, opacityFunction: null, cameraSubscription: null, emitCamera: () => {},
    };
    scene.emitCamera = () => cameraCallbackRef.current(readCamera(scene));
    ctx.current = scene;
    const interactor = renderWindow.getInteractor();
    const interactionEvents = typeof interactor.onEndInteractionEvent === "function"
      ? interactor
      : interactor.getInteractorStyle?.();
    scene.cameraSubscription = interactionEvents?.onEndInteractionEvent?.(scene.emitCamera) ?? null;

    const finish = () => {
      if (disposed) return;
      const display = displayRef.current;
      const resolvedRange = display.colorRange ?? (
        display.colorBy ? arrayRange(scene.output, display.colorBy) : null
      );
      if (!display.colorRange && display.colorBy && resolvedRange) {
        rangeCallbackRef.current?.(display.colorBy, resolvedRange);
      }
      let displayDiagnostic = scene.dataDiagnostic ?? "";
      if (scene.kind === "geometry") {
        applyRepresentation(scene, display.representation);
        applyGeometryColor(scene, display.colorBy, resolvedRange, display.colorMap);
        scene.prop?.getProperty().setOpacity(display.opacity);
        scene.renderer.addActor(scene.prop);
      } else {
        if (scene.kind === "slice") {
          scene.mapper?.setSlicingMode(vtkImageMapper.SlicingMode[SLICE_MODE[display.sliceAxis]]);
          scene.mapper?.setSlice(display.sliceIndex);
        }
        const pointArrays = scene.output?.getPointData?.().getArrays?.() ?? [];
        const pointArrayCount = pointArrays.length;
        const pointScalarCount = pointArrays.filter(
          (array: { getNumberOfComponents?: () => number }) =>
            array.getNumberOfComponents?.() === 1,
        ).length;
        const cellArrayCount = scene.output?.getCellData?.().getNumberOfArrays?.() ?? 0;
        const applied = applyImageColor(
          scene, display.colorBy, resolvedRange, display.colorMap, display.opacity,
          display.volumeOpacityPoints,
        );
        if (!applied) {
          displayDiagnostic = pointArrayCount === 0 && cellArrayCount > 0
            ? strings.viewer.imageNoPointData
            : pointArrayCount === 0
              ? strings.viewer.imageNoDisplayableArrays
              : pointScalarCount === 0
                ? strings.viewer.imageNeedsScalar
                : strings.viewer.imageSelectScalar;
        }
        if (scene.kind === "slice") scene.renderer.addActor(scene.prop);
        else scene.renderer.addVolume(scene.prop);
      }
      renderer.resetCamera();
      if (display.cameraState) applySavedCamera(scene, display.cameraState);
      renderWindow.render();
      scene.emitCamera();
      setStatus(displayDiagnostic);
      loadCallbackRef.current?.();
    };

    const load = async () => {
      if (datasetType === "PolyData") {
        const reader = vtkXMLPolyDataReader.newInstance();
        const mapper = vtkMapper.newInstance();
        const actor = vtkActor.newInstance();
        actor.setMapper(mapper);
        scene.reader = reader;
        scene.mapper = mapper;
        scene.prop = actor;
        const response = await authorizedFetch(url, { signal: abortController.signal });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        reader.parseAsArrayBuffer(await response.arrayBuffer());
        if (disposed) return;
        scene.output = reader.getOutputData();
        mapper.setInputConnection(reader.getOutputPort());
      } else if (datasetType === "Table" && tableCoordinates) {
        const response = await authorizedFetch(url, { signal: abortController.signal });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const { output, invalidScalarCells, skippedRows } = tableToPolyData(
          await response.text(), tableCoordinates,
        );
        if (disposed) return;
        const diagnostic = csvDiagnostics(strings, invalidScalarCells, skippedRows);
        if (diagnostic) scene.dataDiagnostic = diagnostic;
        const useGlyphs = output.getNumberOfPoints() <= 2_000;
        const bounds = output.getBounds();
        const diagonal = Math.hypot(
          bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4],
        );
        const glyphSource = useGlyphs ? vtkSphereSource.newInstance({
          radius: Math.max(diagonal * 0.035, 0.01),
          thetaResolution: 8,
          phiResolution: 8,
        }) : null;
        const mapper = useGlyphs
          ? vtkGlyph3DMapper.newInstance({ scaling: false })
          : vtkMapper.newInstance();
        const actor = vtkActor.newInstance();
        actor.setMapper(mapper);
        mapper.setInputData(output);
        if (glyphSource) {
          (mapper as ReturnType<typeof vtkGlyph3DMapper.newInstance>)
            .setSourceConnection(glyphSource.getOutputPort());
        }
        scene.mapper = mapper;
        scene.prop = actor;
        scene.output = output;
        scene.createdOutput = true;
        scene.glyphSource = glyphSource;
        scene.pointGlyph = useGlyphs;
      } else if (datasetType === "ImageData") {
        const reader = vtkXMLImageDataReader.newInstance();
        scene.reader = reader;
        const response = await authorizedFetch(url, { signal: abortController.signal });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        reader.parseAsArrayBuffer(await response.arrayBuffer());
        if (disposed) return;
        scene.output = reader.getOutputData();
        if (imageMode === "slice") {
          const mapper = vtkImageMapper.newInstance();
          const image = vtkImageSlice.newInstance();
          image.setMapper(mapper);
          mapper.setInputConnection(reader.getOutputPort());
          mapper.setSlicingMode(vtkImageMapper.SlicingMode[SLICE_MODE[sliceAxis]]);
          mapper.setSlice(sliceIndex);
          scene.kind = "slice";
          scene.mapper = mapper;
          scene.prop = image;
        } else {
          const mapper = vtkVolumeMapper.newInstance();
          const volume = vtkVolume.newInstance();
          volume.setMapper(mapper);
          mapper.setInputConnection(reader.getOutputPort());
          scene.kind = "volume";
          scene.mapper = mapper;
          scene.prop = volume;
        }
      }
      finish();
    };
    void load().catch((error: unknown) => {
      if (!disposed && !(error instanceof DOMException && error.name === "AbortError")) {
        setStatus(`${messagesRef.current.viewer.renderError}: ${String(error)}`);
      }
    });

    return () => {
      disposed = true;
      abortController.abort();
      try {
        resizeObserver.disconnect();
        scene.cameraSubscription?.unsubscribe?.();
        orientationWidget.setEnabled(false);
        if (scene.prop) {
          if (scene.kind === "volume") scene.renderer.removeVolume(scene.prop);
          else scene.renderer.removeActor(scene.prop);
        }
        scene.lut?.delete?.();
        scene.opacityFunction?.delete?.();
        scene.reader?.delete?.();
        scene.glyphSource?.delete?.();
        scene.mapper?.delete?.();
        scene.prop?.delete?.();
        if (scene.createdOutput) scene.output?.delete?.();
        orientationWidget.delete?.();
        axes.delete?.();
        grw.delete();
      } catch {
        /* already torn down */
      }
      if (ctx.current === scene) ctx.current = null;
    };
    // Intentionally keyed on rebuild-worthy primitives only. sliceAxis /
    // sliceIndex are read for the initial slice placement; later changes are
    // applied in place by the dedicated slice effect below without a scene
    // rebuild. tableCoordinates is keyed by its x/y/z values (not identity)
    // so parent re-renders don't tear down the scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    url, datasetType, renderable, imageMode,
    tableCoordinates?.x, tableCoordinates?.y, tableCoordinates?.z,
  ]);

  useEffect(() => {
    const scene = ctx.current;
    if (!scene) return;
    scene.renderer.setBackground(...viewerBackground);
    scene.renderWindow.render();
  }, [viewerBackground]);

  useEffect(() => {
    const scene = ctx.current;
    if (!scene) return;
    scene.orientationWidget.setEnabled(axesVisible);
    scene.renderWindow.render();
  }, [axesVisible]);

  useEffect(() => {
    if (!ctx.current) return;
    applyRepresentation(ctx.current, representation);
    ctx.current.renderWindow.render();
  }, [representation]);

  useEffect(() => {
    const scene = ctx.current;
    if (!scene?.output) return;
    const range = colorRange ?? (colorBy ? arrayRange(scene.output, colorBy) : null);
    if (!colorRange && colorBy && range) rangeCallbackRef.current?.(colorBy, range);
    if (scene.kind === "geometry") {
      applyGeometryColor(scene, colorBy, range, colorMap);
      scene.prop?.getProperty().setOpacity(Math.max(0, Math.min(1, opacity)));
    }
    else {
      const applied = applyImageColor(
        scene, colorBy, range, colorMap, opacity, volumeOpacityPoints,
      );
      if (applied) setStatus("");
    }
    scene.renderWindow.render();
  }, [colorBy, colorRange, colorMap, opacity, volumeOpacityPoints]);

  useEffect(() => {
    const scene = ctx.current;
    if (!scene || scene.kind !== "slice" || !scene.mapper) return;
    scene.mapper.setSlicingMode(vtkImageMapper.SlicingMode[SLICE_MODE[sliceAxis]]);
    scene.mapper.setSlice(sliceIndex);
    scene.renderer.resetCameraClippingRange();
    scene.renderWindow.render();
  }, [sliceAxis, sliceIndex]);

  useEffect(() => {
    if (!ctx.current || !cameraState) return;
    applySavedCamera(ctx.current, cameraState);
  }, [cameraState]);

  useEffect(() => {
    if (!screenshotNonce || !ctx.current) return;
    const capturedDatasetId = datasetIdRef.current;
    const settings = displayRef.current;
    ctx.current.renderWindow.captureImages().forEach((promise: Promise<string>) =>
      promise
        .then((dataUrl) => createScreenshotBlob(dataUrl, settings))
        .then((blob) => {
          triggerBlobDownload(blob, "screenshot.png");
          screenshotCallbackRef.current?.(blob, capturedDatasetId);
        })
        .catch((error: unknown) =>
          setStatus(`${messagesRef.current.viewer.screenshotError}: ${String(error)}`),
        ),
    );
  }, [screenshotNonce]);

  useEffect(() => {
    const scene = ctx.current;
    if (!exportNonce || !scene?.output || scene.kind !== "geometry") return;
    const capturedDatasetId = datasetIdRef.current;
    try {
      const writer = vtkXMLPolyDataWriter.newInstance();
      const xml: string = writer.write(scene.output);
      writer.delete?.();
      const blob = new Blob([xml], { type: "application/xml" });
      triggerBlobDownload(blob, "geometry.vtp");
      exportCallbackRef.current?.(blob, capturedDatasetId);
    } catch (error) {
      setStatus(`${messagesRef.current.viewer.exportError}: ${String(error)}`);
    }
  }, [exportNonce]);

  useEffect(() => {
    if (!resetNonce || !ctx.current) return;
    ctx.current.renderer.resetCamera();
    ctx.current.renderWindow.render();
    ctx.current.emitCamera?.();
  }, [resetNonce]);

  return (
    <div className="viewer">
      <div ref={containerRef} className="viewer-canvas" />
      {renderable && (
        <div className="viewer-toolbar" aria-label={messages.viewer.standardViews}>
          <button onClick={() => applyCameraPreset(ctx.current, "front")}>{messages.viewer.front}</button>
          <button onClick={() => applyCameraPreset(ctx.current, "back")}>{messages.viewer.back}</button>
          <button onClick={() => applyCameraPreset(ctx.current, "side")}>{messages.viewer.side}</button>
          <button onClick={() => applyCameraPreset(ctx.current, "top")}>{messages.viewer.top}</button>
          <button onClick={() => applyCameraPreset(ctx.current, "bottom")}>{messages.viewer.bottom}</button>
          <button onClick={() => applyCameraPreset(ctx.current, "isometric")}>{messages.viewer.isometric}</button>
        </div>
      )}
      {!renderable && (
        <div className="viewer-overlay">
          {!url
            ? emptyMessage ?? messages.viewer.chooseDataset
            : datasetType === "Table" && !tableReady
              ? messages.viewer.chooseDistinctColumns
              : datasetType
                ? `“${datasetType}” ${messages.viewer.unsupportedPrefix}`
                : messages.viewer.chooseDataset}
        </div>
      )}
      {renderable && status && <div className="viewer-overlay">{status}</div>}
      {renderable && colorBy && colorRange && legendVisible && (
        <div className="color-legend" aria-label={messages.viewer.colorLegend}>
          <strong>{colorBy.association} · {colorBy.name}</strong>
          <div className="color-legend-gradient" style={{ background: colorMapCssGradient(colorMap) }} />
          <div className="color-legend-values">
            <span>{colorRange[0].toPrecision(5)}</span>
            <span>{colorRange[1].toPrecision(5)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
