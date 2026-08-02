import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
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
import { colorMapCssGradient } from "../lib/colormap";
import { triggerBlobDownload } from "../lib/download";
import { useMessages } from "../i18n-context";
import type {
  DisplaySettings,
  Scene,
  VtkGenericRenderWindow,
  VtkOrientationWidget,
  VtkRenderer,
} from "../lib/viewer/vtkTypes";
import { SLICE_MODE } from "../lib/viewer/vtkTypes";
import { applyGeometryColor, applyImageColor, arrayRange } from "../lib/viewer/color";
import {
  applyCameraPreset,
  applyRepresentation,
  applySavedCamera,
  readCamera,
} from "../lib/viewer/camera";
import {
  buildImageScene,
  buildPolyDataScene,
  buildStructuredScene,
  buildTableScene,
  buildUnstructuredScene,
} from "../lib/viewer/scenes";
import { createScreenshotBlob } from "../lib/viewer/screenshot";
import {
  createClientPlaneController,
  type ClientPlaneController,
  type ClientPlaneSettings,
} from "../lib/viewer/planeTool";
import {
  createProbeController,
  type ProbeController,
  type ProbeResult,
} from "../lib/viewer/probe";
import {
  createMeasurementController,
  type MeasurementController,
  type MeasurementResult,
  type MeasurementSettings,
} from "../lib/viewer/measurementTool";
import {
  createVectorGlyphController,
  pointVectorArrayNames,
  VECTOR_GLYPH_SCALE_MAX,
  VECTOR_GLYPH_SCALE_MIN,
  type VectorGlyphController,
  type VectorGlyphSettings,
  type VectorGlyphSummary,
} from "../lib/viewer/vectorGlyph";

import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import "@kitware/vtk.js/Rendering/Profiles/Volume";
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import vtkXMLPolyDataWriter from "@kitware/vtk.js/IO/XML/XMLPolyDataWriter";
import vtkAxesActor from "@kitware/vtk.js/Rendering/Core/AxesActor";
import vtkOrientationMarkerWidget from "@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget";
import vtkImageMapper from "@kitware/vtk.js/Rendering/Core/ImageMapper";

type SurfaceDatasetType = "PolyData" | "UnstructuredGrid" | "StructuredGrid" | "RectilinearGrid";

function isSurfaceDatasetType(value: string | null | undefined): value is SurfaceDatasetType {
  return value === "PolyData" || value === "UnstructuredGrid"
    || value === "StructuredGrid" || value === "RectilinearGrid";
}

/** Imperative commands the parent can send without nonce-state plumbing. */
export interface VtkViewerHandle {
  /** Capture the current frame; downloads and reports via onScreenshotCaptured. */
  screenshot: () => void;
  /** Export the loaded geometry as VTP. Returns false when nothing exportable. */
  exportGeometry: () => boolean;
  resetCamera: () => void;
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
  viewerBackground: [number, number, number];
}

export const VtkViewer = forwardRef<VtkViewerHandle, Props>(function VtkViewer(props, ref) {
  const {
    datasetId, url, datasetType, emptyMessage, representation, colorBy, colorRange, opacity, colorMap,
    legendVisible, axesVisible, tableCoordinates, imageMode, sliceAxis, sliceIndex,
    volumeOpacityPoints,
    onColorRangeResolved, onLoadComplete, cameraState, onCameraChange, onScreenshotCaptured,
    onGeometryExported, viewerBackground,
  } = props;
  const messages = useMessages();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const ctx = useRef<Scene | null>(null);
  const planeControllerRef = useRef<ClientPlaneController | null>(null);
  const probeControllerRef = useRef<ProbeController | null>(null);
  const measurementControllerRef = useRef<MeasurementController | null>(null);
  const vectorGlyphControllerRef = useRef<VectorGlyphController | null>(null);
  const [status, setStatus] = useState("");
  const [probeEnabled, setProbeEnabled] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const probeEnabledRef = useRef(probeEnabled);
  probeEnabledRef.current = probeEnabled;
  const [measurementSettings, setMeasurementSettings] = useState<MeasurementSettings>({
    enabled: false,
    mode: "distance",
  });
  const [measurementResult, setMeasurementResult] = useState<MeasurementResult | null>(null);
  const measurementSettingsRef = useRef(measurementSettings);
  measurementSettingsRef.current = measurementSettings;
  const [vectorArrays, setVectorArrays] = useState<string[]>([]);
  const [vectorGlyphSettings, setVectorGlyphSettings] = useState<VectorGlyphSettings>({
    enabled: false,
    arrayName: null,
    scale: 1,
  });
  const [vectorGlyphSummary, setVectorGlyphSummary] = useState<VectorGlyphSummary | null>(null);
  const vectorGlyphSettingsRef = useRef(vectorGlyphSettings);
  vectorGlyphSettingsRef.current = vectorGlyphSettings;
  const [planeSettings, setPlaneSettings] = useState<ClientPlaneSettings>({
    enabled: false,
    mode: "clip",
    axis: "X",
    inverted: false,
  });
  const planeSettingsRef = useRef(planeSettings);
  planeSettingsRef.current = planeSettings;
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

  const supported = datasetType === "ImageData" || datasetType === "Table"
    || isSurfaceDatasetType(datasetType);
  const tableReady = datasetType !== "Table" || (
    !!tableCoordinates && new Set(Object.values(tableCoordinates)).size === 3
  );
  const renderable = !!url && supported && tableReady;
  const planeToolAvailable = renderable && isSurfaceDatasetType(datasetType);

  useImperativeHandle(ref, () => ({
    screenshot: () => {
      const scene = ctx.current;
      if (!scene) return;
      const capturedDatasetId = datasetIdRef.current;
      const settings = displayRef.current;
      scene.renderWindow.captureImages().forEach((promise) =>
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
    },
    exportGeometry: () => {
      const scene = ctx.current;
      if (!scene?.output || scene.kind !== "geometry") return false;
      const capturedDatasetId = datasetIdRef.current;
      try {
        const writer = vtkXMLPolyDataWriter.newInstance();
        const xml: string = writer.write(scene.output);
        writer.delete?.();
        const blob = new Blob([xml], { type: "application/xml" });
        triggerBlobDownload(blob, "geometry.vtp");
        exportCallbackRef.current?.(blob, capturedDatasetId);
        return true;
      } catch (error) {
        setStatus(`${messagesRef.current.viewer.exportError}: ${String(error)}`);
        return false;
      }
    },
    resetCamera: () => {
      const scene = ctx.current;
      if (!scene) return;
      scene.renderer.resetCamera();
      scene.renderWindow.render();
      scene.emitCamera?.();
    },
  }), []);

  useEffect(() => {
    if (!containerRef.current || !renderable || !url || !datasetType) return;
    let disposed = false;
    const isDisposed = () => disposed;
    const abortController = new AbortController();
    const strings = messagesRef.current;
    setStatus(strings.viewer.loading);
    setVectorArrays([]);
    setVectorGlyphSummary(null);
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

    // The concrete vtk.js classes carry partial upstream typings that do not
    // structurally match our minimal interfaces; cast once at this boundary.
    const scene: Scene = {
      kind: "geometry",
      grw: grw as unknown as VtkGenericRenderWindow,
      renderer: renderer as unknown as VtkRenderer,
      renderWindow,
      axes,
      orientationWidget: orientationWidget as unknown as VtkOrientationWidget,
      resizeObserver,
      mapper: null, prop: null, reader: null, output: null, createdOutput: false,
      glyphSource: null, pointGlyph: false,
      lut: null, opacityFunction: null, cameraSubscription: null, emitCamera: () => {},
    };
    let planeController: ClientPlaneController | null = null;
    let probeController: ProbeController | null = null;
    let measurementController: MeasurementController | null = null;
    let vectorGlyphController: VectorGlyphController | null = null;
    scene.emitCamera = () => cameraCallbackRef.current(readCamera(scene));
    ctx.current = scene;
    const interactor = renderWindow.getInteractor();
    const interactionEvents = typeof interactor.onEndInteractionEvent === "function"
      ? interactor
      : interactor.getInteractorStyle?.();
    scene.cameraSubscription = interactionEvents?.onEndInteractionEvent?.(scene.emitCamera) ?? null;

    const finish = () => {
      if (disposed || !scene.prop) return;
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
        scene.prop.getProperty().setOpacity(display.opacity);
        scene.renderer.addActor(scene.prop);
        if (isSurfaceDatasetType(datasetType)) {
          const vectorNames = pointVectorArrayNames(scene.output);
          const currentGlyphSettings = vectorGlyphSettingsRef.current;
          const nextGlyphSettings = {
            ...currentGlyphSettings,
            arrayName: currentGlyphSettings.arrayName
              && vectorNames.includes(currentGlyphSettings.arrayName)
              ? currentGlyphSettings.arrayName
              : vectorNames[0] ?? null,
          };
          vectorGlyphSettingsRef.current = nextGlyphSettings;
          setVectorArrays(vectorNames);
          setVectorGlyphSettings(nextGlyphSettings);
          vectorGlyphController = createVectorGlyphController(scene);
          vectorGlyphControllerRef.current = vectorGlyphController;
          setVectorGlyphSummary(vectorGlyphController?.apply(nextGlyphSettings) ?? null);
          planeController = createClientPlaneController(scene);
          planeControllerRef.current = planeController;
          planeController?.apply(planeSettingsRef.current);
          if (scene.output) {
            probeController = createProbeController(
              scene.renderer,
              interactor,
              scene.output,
              setProbeResult,
            );
            probeControllerRef.current = probeController;
            probeController?.setEnabled(probeEnabledRef.current);
            measurementController = createMeasurementController(
              scene.renderer,
              scene.output.getBounds(),
              setMeasurementResult,
            );
            measurementControllerRef.current = measurementController;
            measurementController.apply(measurementSettingsRef.current);
          }
        }
      } else {
        if (scene.kind === "slice") {
          scene.mapper?.setSlicingMode(vtkImageMapper.SlicingMode[SLICE_MODE[display.sliceAxis]]);
          scene.mapper?.setSlice(display.sliceIndex);
        }
        const pointArrays = scene.output?.getPointData().getArrays?.() ?? [];
        const pointArrayCount = pointArrays.length;
        const pointScalarCount = pointArrays.filter(
          (array) => array.getNumberOfComponents?.() === 1,
        ).length;
        const cellArrayCount = scene.output?.getCellData?.()?.getNumberOfArrays?.() ?? 0;
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
        await buildPolyDataScene(scene, url, abortController.signal, isDisposed);
      } else if (datasetType === "UnstructuredGrid") {
        await buildUnstructuredScene(scene, url, strings, abortController.signal, isDisposed);
      } else if (datasetType === "StructuredGrid" || datasetType === "RectilinearGrid") {
        await buildStructuredScene(
          scene, url, datasetType, strings, abortController.signal, isDisposed,
        );
      } else if (datasetType === "Table" && tableCoordinates) {
        await buildTableScene(
          scene, url, tableCoordinates, strings, abortController.signal, isDisposed,
        );
      } else if (datasetType === "ImageData") {
        const display = displayRef.current;
        await buildImageScene(
          scene, url, imageMode, display.sliceAxis, display.sliceIndex,
          abortController.signal, isDisposed,
        );
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
        measurementController?.delete();
        if (measurementControllerRef.current === measurementController) {
          measurementControllerRef.current = null;
        }
        probeController?.delete();
        if (probeControllerRef.current === probeController) probeControllerRef.current = null;
        planeController?.delete();
        if (planeControllerRef.current === planeController) planeControllerRef.current = null;
        vectorGlyphController?.delete();
        if (vectorGlyphControllerRef.current === vectorGlyphController) {
          vectorGlyphControllerRef.current = null;
        }
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
    planeControllerRef.current?.apply(planeSettings);
  }, [planeSettings]);

  useEffect(() => {
    probeControllerRef.current?.setEnabled(probeEnabled);
    if (!probeEnabled) setProbeResult(null);
  }, [probeEnabled]);

  useEffect(() => {
    measurementControllerRef.current?.apply(measurementSettings);
    if (!measurementSettings.enabled) setMeasurementResult(null);
  }, [measurementSettings]);

  useEffect(() => {
    setVectorGlyphSummary(vectorGlyphControllerRef.current?.apply(vectorGlyphSettings) ?? null);
  }, [vectorGlyphSettings]);

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
      {planeToolAvailable && (
        <div className="viewer-toolbar viewer-plane-toolbar" aria-label={messages.viewer.planeTools}>
          <button
            aria-pressed={probeEnabled}
            onClick={() => {
              const next = !probeEnabled;
              setProbeEnabled(next);
              if (next) {
                setPlaneSettings((current) => ({ ...current, enabled: false }));
                setMeasurementSettings((current) => ({ ...current, enabled: false }));
              }
            }}
          >
            {messages.viewer.probe}
          </button>
          {(["clip", "slice"] as const).map((mode) => (
            <button
              key={mode}
              aria-pressed={planeSettings.enabled && planeSettings.mode === mode}
              onClick={() => {
                setProbeEnabled(false);
                setMeasurementSettings((current) => ({ ...current, enabled: false }));
                setPlaneSettings((current) => ({
                  ...current,
                  enabled: current.mode !== mode || !current.enabled,
                  mode,
                }));
              }}
            >
              {mode === "clip" ? messages.viewer.clientClip : messages.viewer.clientSlice}
            </button>
          ))}
          {(["distance", "angle"] as const).map((mode) => (
            <button
              key={mode}
              aria-pressed={measurementSettings.enabled && measurementSettings.mode === mode}
              onClick={() => {
                setProbeEnabled(false);
                setPlaneSettings((current) => ({ ...current, enabled: false }));
                setMeasurementSettings((current) => ({
                  enabled: current.mode !== mode || !current.enabled,
                  mode,
                }));
              }}
            >
              {mode === "distance" ? messages.viewer.measureDistance : messages.viewer.measureAngle}
            </button>
          ))}
          <button
            disabled={!measurementSettings.enabled}
            onClick={() => measurementControllerRef.current?.reset()}
          >
            {messages.viewer.measureReset}
          </button>
          {(["X", "Y", "Z"] as const).map((axis) => (
            <button
              key={axis}
              aria-label={`${messages.viewer.planeNormal} ${axis}`}
              aria-pressed={planeSettings.axis === axis}
              disabled={!planeSettings.enabled}
              onClick={() => setPlaneSettings((current) => ({ ...current, axis }))}
            >
              {axis}
            </button>
          ))}
          <button
            aria-pressed={planeSettings.inverted}
            disabled={!planeSettings.enabled}
            onClick={() => setPlaneSettings((current) => ({
              ...current,
              inverted: !current.inverted,
            }))}
          >
            {messages.viewer.planeFlip}
          </button>
          <button
            disabled={!planeSettings.enabled}
            onClick={() => planeControllerRef.current?.reset()}
          >
            {messages.viewer.planeReset}
          </button>
        </div>
      )}
      {vectorArrays.length > 0 && (
        <div
          className="viewer-toolbar viewer-vector-toolbar"
          aria-label={messages.viewer.vectorGlyphTools}
        >
          <button
            aria-pressed={vectorGlyphSettings.enabled}
            onClick={() => setVectorGlyphSettings((current) => ({
              ...current,
              enabled: !current.enabled,
            }))}
          >
            {messages.viewer.vectorGlyphToggle}
          </button>
          <label>
            <span>{messages.viewer.vectorArray}</span>
            <select
              aria-label={messages.viewer.vectorArray}
              value={vectorGlyphSettings.arrayName ?? ""}
              onChange={(event) => setVectorGlyphSettings((current) => ({
                ...current,
                arrayName: event.target.value,
              }))}
            >
              {vectorArrays.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label>
            <span>{messages.viewer.vectorScale}</span>
            <input
              aria-label={messages.viewer.vectorScale}
              type="range"
              min={VECTOR_GLYPH_SCALE_MIN}
              max={VECTOR_GLYPH_SCALE_MAX}
              step="0.1"
              value={vectorGlyphSettings.scale}
              onChange={(event) => setVectorGlyphSettings((current) => ({
                ...current,
                scale: Number(event.target.value),
              }))}
            />
            <output>{vectorGlyphSettings.scale.toFixed(1)}×</output>
          </label>
          {vectorGlyphSettings.enabled && (
            <span className="viewer-vector-count" role="status">
              {vectorGlyphSummary
                ? `${messages.viewer.vectorGlyphCount}: ${vectorGlyphSummary.glyphCount.toLocaleString()} / ${vectorGlyphSummary.sourcePointCount.toLocaleString()}`
                : messages.viewer.vectorGlyphEmpty}
            </span>
          )}
        </div>
      )}
      {probeEnabled && probeResult && (
        <div
          className="probe-tooltip"
          role="status"
          style={{
            left: probeResult.displayPosition[0] + 12,
            bottom: probeResult.displayPosition[1] + 12,
          }}
        >
          <button
            className="probe-close"
            aria-label={messages.common.close}
            onClick={() => setProbeResult(null)}
          >
            ×
          </button>
          {probeResult.worldPosition && (
            <div>
              <strong>{messages.viewer.probePosition}</strong>{" "}
              {probeResult.worldPosition.map((value) => Number(value).toPrecision(6)).join(", ")}
            </div>
          )}
          <div>
            {messages.viewer.probePoint}: {probeResult.pointId ?? "—"}
            {" · "}{messages.viewer.probeCell}: {probeResult.cellId ?? "—"}
          </div>
          {probeResult.values.length ? (
            <dl>
              {probeResult.values.map((entry) => (
                <div key={`${entry.association}:${entry.name}`}>
                  <dt>{entry.association} · {entry.name}</dt>
                  <dd>{entry.value.toPrecision(7)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <div>{messages.viewer.probeNoScalars}</div>
          )}
        </div>
      )}
      {measurementSettings.enabled && (
        <div className="measurement-readout" role="status">
          {measurementResult
            ? measurementResult.mode === "distance"
              ? `${messages.viewer.distance}: ${measurementResult.value.toPrecision(7)}`
              : `${messages.viewer.angle}: ${measurementResult.value.toPrecision(6)}°`
            : measurementSettings.mode === "distance"
              ? messages.viewer.distanceHint
              : messages.viewer.angleHint}
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
});
