import { useEffect, useRef, useState } from "react";
import type {
  CameraState,
  ColorMapName,
  ImageMode,
  Representation,
  ScalarSelection,
  SliceAxis,
  TableCoordinates,
} from "../types";
import { colorMapCssGradient, colorMapStops } from "../lib/colormap";
import { csvToPointData } from "../lib/csvToPoints";
import { authorizedFetch } from "../api";
import { isRuntimeImageScalar } from "../lib/imageData";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import "@kitware/vtk.js/Rendering/Profiles/Volume";
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import vtkXMLPolyDataReader from "@kitware/vtk.js/IO/XML/XMLPolyDataReader";
import vtkXMLImageDataReader from "@kitware/vtk.js/IO/XML/XMLImageDataReader";
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
type CameraPreset = "front" | "side" | "top" | "isometric";

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
  tableCoordinates: TableCoordinates | null;
  imageMode: ImageMode;
  sliceAxis: SliceAxis;
  sliceIndex: number;
  onColorRangeResolved?: (selection: ScalarSelection, range: [number, number]) => void;
  onLoadComplete?: () => void;
  cameraState: CameraState | null;
  onCameraChange: (camera: CameraState) => void;
  onScreenshotCaptured?: (blob: Blob, datasetId: string | null) => void;
  screenshotNonce: number;
  resetNonce: number;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function arrayRange(output: any, selection: ScalarSelection): [number, number] | null {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyGeometryColor(scene: any, selection: ScalarSelection | null, range: [number, number] | null, map: ColorMapName) {
  scene.lut?.delete?.();
  scene.lut = null;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyImageColor(scene: any, selection: ScalarSelection | null, range: [number, number] | null, map: ColorMapName, opacity: number) {
  if (!scene.output || !selection || selection.association !== "point" || !range) return false;
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
    opacityFunction.addPoint(opacityRange[0], 0);
    opacityFunction.addPoint(opacityRange[1], Math.max(0, opacity * 0.85));
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
  return polyData;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyRepresentation(scene: any, representation: Representation) {
  if (scene.kind !== "geometry" || !scene.prop) return;
  const property = scene.prop.getProperty();
  property.setRepresentation(scene.pointGlyph ? REPR_CODE.surface : REPR_CODE[representation]);
  property.setEdgeVisibility(representation === "surface");
  property.setPointSize(representation === "points" ? 7 : 1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyCameraPreset(scene: any, preset: CameraPreset) {
  if (!scene) return;
  const camera = scene.renderer.getActiveCamera();
  const focal = camera.getFocalPoint();
  const distance = Math.max(camera.getDistance?.() ?? 1, 1e-6);
  const definitions: Record<CameraPreset, { direction: number[]; up: number[] }> = {
    front: { direction: [0, -1, 0], up: [0, 0, 1] },
    side: { direction: [1, 0, 0], up: [0, 0, 1] },
    top: { direction: [0, 0, 1], up: [0, 1, 0] },
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readCamera(scene: any): CameraState {
  const camera = scene.renderer.getActiveCamera();
  return {
    position: [...camera.getPosition()] as CameraState["position"],
    focal_point: [...camera.getFocalPoint()] as CameraState["focal_point"],
    view_up: [...camera.getViewUp()] as CameraState["view_up"],
    parallel_scale: camera.getParallelScale(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applySavedCamera(scene: any, state: CameraState) {
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
    legendVisible, tableCoordinates, imageMode, sliceAxis, sliceIndex,
    onColorRangeResolved, onLoadComplete, cameraState, onCameraChange, onScreenshotCaptured,
    screenshotNonce, resetNonce,
  } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = useRef<any>(null);
  const [status, setStatus] = useState("");
  const rangeCallbackRef = useRef(onColorRangeResolved);
  rangeCallbackRef.current = onColorRangeResolved;
  const loadCallbackRef = useRef(onLoadComplete);
  loadCallbackRef.current = onLoadComplete;
  const cameraCallbackRef = useRef(onCameraChange);
  cameraCallbackRef.current = onCameraChange;
  const screenshotCallbackRef = useRef(onScreenshotCaptured);
  screenshotCallbackRef.current = onScreenshotCaptured;
  const datasetIdRef = useRef(datasetId);
  datasetIdRef.current = datasetId;
  const displayRef = useRef({
    representation, colorBy, colorRange, opacity, colorMap, cameraState, legendVisible,
    sliceAxis, sliceIndex,
  });
  displayRef.current = {
    representation, colorBy, colorRange, opacity, colorMap, cameraState, legendVisible,
    sliceAxis, sliceIndex,
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
    setStatus("読み込み中…");
    const grw = vtkGenericRenderWindow.newInstance({ background: [0.09, 0.11, 0.15] });
    grw.setContainer(containerRef.current);
    grw.resize();
    const renderer = grw.getRenderer();
    const renderWindow = grw.getRenderWindow();
    const axes = vtkAxesActor.newInstance();
    const orientationWidget = vtkOrientationMarkerWidget.newInstance({
      actor: axes,
      interactor: renderWindow.getInteractor(),
    });
    orientationWidget.setEnabled(true);
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

    const scene: any = {
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
      let displayDiagnostic = "";
      if (scene.kind === "geometry") {
        applyRepresentation(scene, display.representation);
        applyGeometryColor(scene, display.colorBy, resolvedRange, display.colorMap);
        scene.prop.getProperty().setOpacity(display.opacity);
        renderer.addActor(scene.prop);
      } else {
        if (scene.kind === "slice") {
          scene.mapper.setSlicingMode(vtkImageMapper.SlicingMode[SLICE_MODE[display.sliceAxis]]);
          scene.mapper.setSlice(display.sliceIndex);
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
        );
        if (!applied) {
          displayDiagnostic = pointArrayCount === 0 && cellArrayCount > 0
            ? "ImageDataにpoint dataがありません。cell dataはサーバ側でpoint dataへ変換してください。"
            : pointArrayCount === 0
              ? "ImageDataに表示可能なpoint data配列がありません。"
              : pointScalarCount === 0
                ? "ImageDataの表示には1成分point scalar配列が必要です。"
                : "表示するpoint scalar配列または有限な値域を選択してください。";
        }
        if (scene.kind === "slice") renderer.addActor(scene.prop);
        else renderer.addVolume(scene.prop);
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
        const output = tableToPolyData(await response.text(), tableCoordinates);
        if (disposed) return;
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
        setStatus(`描画エラー: ${String(error)}`);
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
          if (scene.kind === "volume") renderer.removeVolume(scene.prop);
          else renderer.removeActor(scene.prop);
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
  }, [
    url, datasetType, renderable, imageMode,
    tableCoordinates?.x, tableCoordinates?.y, tableCoordinates?.z,
  ]);

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
      scene.prop.getProperty().setOpacity(Math.max(0, Math.min(1, opacity)));
    }
    else {
      const applied = applyImageColor(scene, colorBy, range, colorMap, opacity);
      if (applied) setStatus("");
    }
    scene.renderWindow.render();
  }, [colorBy, colorRange, colorMap, opacity]);

  useEffect(() => {
    const scene = ctx.current;
    if (!scene || scene.kind !== "slice") return;
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
          const link = document.createElement("a");
          const objectUrl = URL.createObjectURL(blob);
          link.href = objectUrl;
          link.download = "screenshot.png";
          link.click();
          window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
          screenshotCallbackRef.current?.(blob, capturedDatasetId);
        })
        .catch((error: unknown) => setStatus(`スクリーンショットエラー: ${String(error)}`)),
    );
  }, [screenshotNonce]);

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
        <div className="viewer-toolbar" aria-label="標準ビュー方向">
          <button onClick={() => applyCameraPreset(ctx.current, "front")}>正面</button>
          <button onClick={() => applyCameraPreset(ctx.current, "side")}>側面</button>
          <button onClick={() => applyCameraPreset(ctx.current, "top")}>上面</button>
          <button onClick={() => applyCameraPreset(ctx.current, "isometric")}>等角</button>
        </div>
      )}
      {!renderable && (
        <div className="viewer-overlay">
          {!url
            ? emptyMessage ?? "データセットを選択してください。"
            : datasetType === "Table" && !tableReady
              ? "重複しないX/Y/Z列を選択してください。"
              : `「${datasetType}」はブラウザ直接描画の対象外です。`}
        </div>
      )}
      {renderable && status && <div className="viewer-overlay">{status}</div>}
      {renderable && colorBy && colorRange && legendVisible && (
        <div className="color-legend" aria-label="カラーレジェンド">
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
