import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CameraState,
  ColorMapName,
  ImageMode,
  Representation,
  ScalarSelection,
  SliceAxis,
  TableCoordinates,
  ViewState,
  VolumeOpacityPoint,
} from "../types";
import { DEFAULT_VOLUME_OPACITY_POINTS } from "../lib/imageData";

/** Undo/redo is intentionally bounded so camera moves and slider edits cannot
 * grow memory without limit during long visualization sessions. */
export const DISPLAY_HISTORY_LIMIT = 50;

/** The persisted, per-view fields shared by undo/redo and ViewState restore.
 * Runtime scalar ranges, playback state, and orientation-axes visibility are
 * transient viewer preferences and therefore stay outside this history. */
export interface DisplayHistorySnapshot {
  representation: Representation;
  colorBy: ScalarSelection | null;
  customColorRange: [number, number] | null;
  opacity: number;
  colorMap: ColorMapName;
  legendVisible: boolean;
  cameraState: CameraState | null;
  tableCoordinates: TableCoordinates | null;
  imageMode: ImageMode;
  sliceAxis: SliceAxis;
  sliceIndex: number;
  timestepIndex: number;
  volumeOpacityPoints: VolumeOpacityPoint[];
}

interface HistoryStacks {
  past: DisplayHistorySnapshot[];
  future: DisplayHistorySnapshot[];
}

const EMPTY_HISTORY: HistoryStacks = { past: [], future: [] };

function cloneSnapshot(snapshot: DisplayHistorySnapshot): DisplayHistorySnapshot {
  return {
    ...snapshot,
    colorBy: snapshot.colorBy ? { ...snapshot.colorBy } : null,
    customColorRange: snapshot.customColorRange ? [...snapshot.customColorRange] : null,
    cameraState: snapshot.cameraState
      ? {
        ...snapshot.cameraState,
        position: [...snapshot.cameraState.position],
        focal_point: [...snapshot.cameraState.focal_point],
        view_up: [...snapshot.cameraState.view_up],
      }
      : null,
    tableCoordinates: snapshot.tableCoordinates ? { ...snapshot.tableCoordinates } : null,
    volumeOpacityPoints: snapshot.volumeOpacityPoints === DEFAULT_VOLUME_OPACITY_POINTS
      ? DEFAULT_VOLUME_OPACITY_POINTS
      : snapshot.volumeOpacityPoints.map((point) => ({ ...point })),
  };
}

function snapshotsEqual(
  left: DisplayHistorySnapshot,
  right: DisplayHistorySnapshot,
): boolean {
  const sameRange = left.customColorRange === right.customColorRange || (
    !!left.customColorRange && !!right.customColorRange
    && left.customColorRange[0] === right.customColorRange[0]
    && left.customColorRange[1] === right.customColorRange[1]
  );
  const sameColorBy = left.colorBy === right.colorBy || (
    !!left.colorBy && !!right.colorBy
    && left.colorBy.name === right.colorBy.name
    && left.colorBy.association === right.colorBy.association
  );
  const sameCamera = left.cameraState === right.cameraState || (
    !!left.cameraState && !!right.cameraState
    && left.cameraState.parallel_scale === right.cameraState.parallel_scale
    && left.cameraState.position.every(
      (value, index) => value === right.cameraState?.position[index],
    )
    && left.cameraState.focal_point.every(
      (value, index) => value === right.cameraState?.focal_point[index],
    )
    && left.cameraState.view_up.every(
      (value, index) => value === right.cameraState?.view_up[index],
    )
  );
  const sameTableCoordinates = left.tableCoordinates === right.tableCoordinates || (
    !!left.tableCoordinates && !!right.tableCoordinates
    && left.tableCoordinates.x === right.tableCoordinates.x
    && left.tableCoordinates.y === right.tableCoordinates.y
    && left.tableCoordinates.z === right.tableCoordinates.z
  );
  const sameVolumeOpacity = left.volumeOpacityPoints === right.volumeOpacityPoints || (
    left.volumeOpacityPoints.length === right.volumeOpacityPoints.length
    && left.volumeOpacityPoints.every((point, index) => (
      point.value === right.volumeOpacityPoints[index]?.value
      && point.alpha === right.volumeOpacityPoints[index]?.alpha
    ))
  );

  return left.representation === right.representation
    && sameColorBy
    && sameRange
    && left.opacity === right.opacity
    && left.colorMap === right.colorMap
    && left.legendVisible === right.legendVisible
    && sameCamera
    && sameTableCoordinates
    && left.imageMode === right.imageMode
    && left.sliceAxis === right.sliceAxis
    && left.sliceIndex === right.sliceIndex
    && left.timestepIndex === right.timestepIndex
    && sameVolumeOpacity;
}

function appendBounded(
  stack: DisplayHistorySnapshot[],
  snapshot: DisplayHistorySnapshot,
): DisplayHistorySnapshot[] {
  const next = [...stack, cloneSnapshot(snapshot)];
  return next.length > DISPLAY_HISTORY_LIMIT
    ? next.slice(next.length - DISPLAY_HISTORY_LIMIT)
    : next;
}

/** Everything the viewer/properties panel shows for the selected dataset.
 * ``reset()`` returns every per-dataset field to its initial value and starts a
 * new history boundary for a dataset/project change. */
export function useDisplayState() {
  const [representation, setRepresentation] = useState<Representation>("surface");
  const [colorBy, setColorByState] = useState<ScalarSelection | null>(null);
  const [customColorRange, setCustomColorRange] = useState<[number, number] | null>(null);
  const [runtimeColorRange, setRuntimeColorRange] = useState<[number, number] | null>(null);
  const [opacity, setOpacity] = useState(1);
  const [colorMap, setColorMap] = useState<ColorMapName>("cool-to-warm");
  const [legendVisible, setLegendVisible] = useState(true);
  const [axesVisible, setAxesVisible] = useState(true);
  const [cameraState, setCameraState] = useState<CameraState | null>(null);
  const [tableCoordinates, setTableCoordinates] = useState<TableCoordinates | null>(null);
  const [imageMode, setImageMode] = useState<ImageMode>("slice");
  const [sliceAxis, setSliceAxis] = useState<SliceAxis>("Z");
  const [sliceIndex, setSliceIndex] = useState(0);
  const [timestepIndex, setTimestepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [volumeOpacityPoints, setVolumeOpacityPoints] = useState<VolumeOpacityPoint[]>(
    DEFAULT_VOLUME_OPACITY_POINTS,
  );

  /** Choosing a color array invalidates manual and runtime ranges as one
   * history entry (React batches the three state updates). */
  const setColorBy = useCallback((selection: ScalarSelection | null) => {
    setColorByState(selection);
    setCustomColorRange(null);
    setRuntimeColorRange(null);
  }, []);

  const snapshot = useMemo<DisplayHistorySnapshot>(() => ({
    representation,
    colorBy,
    customColorRange,
    opacity,
    colorMap,
    legendVisible,
    cameraState,
    tableCoordinates,
    imageMode,
    sliceAxis,
    sliceIndex,
    timestepIndex,
    volumeOpacityPoints,
  }), [
    representation, colorBy, customColorRange, opacity, colorMap,
    legendVisible, cameraState, tableCoordinates, imageMode, sliceAxis,
    sliceIndex, timestepIndex, volumeOpacityPoints,
  ]);

  const snapshotRef = useRef(snapshot);
  const lastRecordedSnapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const [history, setHistory] = useState<HistoryStacks>(EMPTY_HISTORY);
  const historyRef = useRef(history);
  historyRef.current = history;

  const replaceHistory = useCallback((next: HistoryStacks) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  const applySnapshot = useCallback((next: DisplayHistorySnapshot) => {
    setRepresentation(next.representation);
    setColorByState(next.colorBy);
    setCustomColorRange(next.customColorRange);
    setOpacity(next.opacity);
    setColorMap(next.colorMap);
    setLegendVisible(next.legendVisible);
    setCameraState(next.cameraState);
    setTableCoordinates(next.tableCoordinates);
    setImageMode(next.imageMode);
    setSliceAxis(next.sliceAxis);
    setSliceIndex(next.sliceIndex);
    setTimestepIndex(next.timestepIndex);
    setVolumeOpacityPoints(next.volumeOpacityPoints);
    // Derived ranges must be recomputed for the restored color selection, and
    // playback must stop so it cannot immediately overwrite a restored step.
    setRuntimeColorRange(null);
    setPlaying(false);
  }, []);

  const applyWithoutRecording = useCallback((nextValue: DisplayHistorySnapshot) => {
    const next = cloneSnapshot(nextValue);
    snapshotRef.current = next;
    lastRecordedSnapshotRef.current = next;
    applySnapshot(next);
  }, [applySnapshot]);

  // Ordinary setters remain the public API. Observe their batched result here,
  // dedupe value-equivalent objects, then add one entry for the rendered state.
  useEffect(() => {
    if (snapshotsEqual(lastRecordedSnapshotRef.current, snapshot)) return;
    const previous = cloneSnapshot(lastRecordedSnapshotRef.current);
    lastRecordedSnapshotRef.current = cloneSnapshot(snapshot);
    const currentHistory = historyRef.current;
    replaceHistory({
      past: appendBounded(currentHistory.past, previous),
      future: [],
    });
  }, [snapshot, replaceHistory]);

  const undo = useCallback(() => {
    const currentHistory = historyRef.current;
    const target = currentHistory.past[currentHistory.past.length - 1];
    if (!target) return;
    const current = cloneSnapshot(snapshotRef.current);
    replaceHistory({
      past: currentHistory.past.slice(0, -1),
      future: appendBounded(currentHistory.future, current),
    });
    applyWithoutRecording(target);
  }, [applyWithoutRecording, replaceHistory]);

  const redo = useCallback(() => {
    const currentHistory = historyRef.current;
    const target = currentHistory.future[currentHistory.future.length - 1];
    if (!target) return;
    const current = cloneSnapshot(snapshotRef.current);
    replaceHistory({
      past: appendBounded(currentHistory.past, current),
      future: currentHistory.future.slice(0, -1),
    });
    applyWithoutRecording(target);
  }, [applyWithoutRecording, replaceHistory]);

  /** Apply a stored ViewState atomically, so restoring a pipeline is exactly
   * one undoable operation rather than one entry per setter. */
  const restoreViewState = useCallback((state: ViewState) => {
    const current = cloneSnapshot(snapshotRef.current);
    const target: DisplayHistorySnapshot = {
      representation: state.representation,
      colorBy: state.color_by,
      customColorRange: state.color_range,
      opacity: state.opacity,
      colorMap: state.color_map,
      legendVisible: state.legend_visible,
      cameraState: state.camera,
      tableCoordinates: state.table_coordinates ?? null,
      imageMode: state.image_mode ?? "slice",
      sliceAxis: state.slice_axis ?? "Z",
      sliceIndex: state.slice_index ?? 0,
      timestepIndex: state.timestep_index ?? 0,
      volumeOpacityPoints: state.volume_opacity_points ?? DEFAULT_VOLUME_OPACITY_POINTS,
    };
    if (!snapshotsEqual(current, target)) {
      const currentHistory = historyRef.current;
      replaceHistory({
        past: appendBounded(currentHistory.past, current),
        future: [],
      });
    }
    applyWithoutRecording(target);
  }, [applyWithoutRecording, replaceHistory]);

  /** Wipe per-dataset display settings (viewer-level preferences survive) and
   * clear both stacks so undo never crosses a dataset/project boundary. */
  const reset = useCallback(() => {
    const target: DisplayHistorySnapshot = {
      ...cloneSnapshot(snapshotRef.current),
      colorBy: null,
      customColorRange: null,
      cameraState: null,
      tableCoordinates: null,
      imageMode: "slice",
      sliceAxis: "Z",
      sliceIndex: 0,
      timestepIndex: 0,
      volumeOpacityPoints: DEFAULT_VOLUME_OPACITY_POINTS,
    };
    replaceHistory(EMPTY_HISTORY);
    applyWithoutRecording(target);
  }, [applyWithoutRecording, replaceHistory]);

  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  // Memoized so the object's identity only changes when a display value or
  // history availability changes — consumers use it in effect dependencies.
  return useMemo(() => ({
    representation, setRepresentation,
    colorBy, setColorBy, setColorByState,
    customColorRange, setCustomColorRange,
    runtimeColorRange, setRuntimeColorRange,
    opacity, setOpacity,
    colorMap, setColorMap,
    legendVisible, setLegendVisible,
    axesVisible, setAxesVisible,
    cameraState, setCameraState,
    tableCoordinates, setTableCoordinates,
    imageMode, setImageMode,
    sliceAxis, setSliceAxis,
    sliceIndex, setSliceIndex,
    timestepIndex, setTimestepIndex,
    playing, setPlaying,
    volumeOpacityPoints, setVolumeOpacityPoints,
    canUndo, canRedo, undo, redo, restoreViewState, reset,
  }), [
    representation, colorBy, customColorRange, runtimeColorRange, opacity,
    colorMap, legendVisible, axesVisible, cameraState, tableCoordinates,
    imageMode, sliceAxis, sliceIndex, timestepIndex, playing,
    volumeOpacityPoints, canUndo, canRedo, setColorBy, undo, redo,
    restoreViewState, reset,
  ]);
}

export type DisplayState = ReturnType<typeof useDisplayState>;
