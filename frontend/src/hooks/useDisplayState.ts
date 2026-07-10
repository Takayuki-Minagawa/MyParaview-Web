import { useCallback, useMemo, useState } from "react";
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
import { DEFAULT_VOLUME_OPACITY_POINTS } from "../components/VtkViewer";

/** Everything the viewer/properties panel shows for the selected dataset.
 * ``reset()`` returns every field to its initial value — the single source of
 * truth for the "new dataset/project selected" wipe that used to be duplicated
 * in three places. */
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

  /** Choosing a color array invalidates manual and runtime ranges. */
  const setColorBy = useCallback((selection: ScalarSelection | null) => {
    setColorByState(selection);
    setCustomColorRange(null);
    setRuntimeColorRange(null);
  }, []);

  /** Wipe per-dataset display settings (axes visibility is a viewer-level
   * preference and intentionally survives). */
  const reset = useCallback(() => {
    setColorByState(null);
    setCustomColorRange(null);
    setRuntimeColorRange(null);
    setCameraState(null);
    setTableCoordinates(null);
    setImageMode("slice");
    setSliceAxis("Z");
    setSliceIndex(0);
    setTimestepIndex(0);
    setPlaying(false);
    setVolumeOpacityPoints(DEFAULT_VOLUME_OPACITY_POINTS);
  }, []);

  // Memoized so the object's identity only changes when a display value
  // changes — consumers use it in effect dependency arrays.
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
    reset,
  }), [
    representation, colorBy, customColorRange, runtimeColorRange, opacity,
    colorMap, legendVisible, axesVisible, cameraState, tableCoordinates,
    imageMode, sliceAxis, sliceIndex, timestepIndex, playing,
    volumeOpacityPoints, setColorBy, reset,
  ]);
}

export type DisplayState = ReturnType<typeof useDisplayState>;
