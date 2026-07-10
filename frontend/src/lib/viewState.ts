import type {
  CameraState,
  ColorMapName,
  ImageMode,
  Representation,
  ScalarSelection,
  SliceAxis,
  TableCoordinates,
  ViewState,
} from "../types";

const REPRESENTATIONS = new Set<Representation>(["surface", "wireframe", "points"]);
const COLOR_MAPS = new Set<ColorMapName>([
  "cool-to-warm",
  "viridis",
  "grayscale",
  "plasma",
  "turbo",
]);

function finiteTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

export function parseViewState(value: unknown): ViewState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Record<string, unknown>;
  if (state.schema_version !== 1 || !REPRESENTATIONS.has(state.representation as Representation)) {
    return null;
  }
  if (!COLOR_MAPS.has(state.color_map as ColorMapName)) return null;
  if (typeof state.opacity !== "number" || state.opacity < 0 || state.opacity > 1) return null;
  if (typeof state.legend_visible !== "boolean") return null;

  let colorBy: ScalarSelection | null = null;
  if (state.color_by !== null) {
    if (!state.color_by || typeof state.color_by !== "object") return null;
    const selection = state.color_by as Record<string, unknown>;
    if (
      typeof selection.name !== "string" ||
      (selection.association !== "point" && selection.association !== "cell")
    ) return null;
    colorBy = { name: selection.name, association: selection.association };
  }

  const colorRange = state.color_range === null
    ? null
    : finiteTuple(state.color_range, 2)
      ? [state.color_range[0], state.color_range[1]] as [number, number]
      : null;
  if (state.color_range !== null && colorRange === null) return null;
  if (colorRange !== null && colorRange[0] >= colorRange[1]) return null;

  let camera: CameraState | null = null;
  if (state.camera !== null) {
    if (!state.camera || typeof state.camera !== "object") return null;
    const candidate = state.camera as Record<string, unknown>;
    if (
      !finiteTuple(candidate.position, 3) ||
      !finiteTuple(candidate.focal_point, 3) ||
      !finiteTuple(candidate.view_up, 3) ||
      typeof candidate.parallel_scale !== "number" ||
      candidate.parallel_scale <= 0
    ) return null;
    camera = {
      position: [...candidate.position] as CameraState["position"],
      focal_point: [...candidate.focal_point] as CameraState["focal_point"],
      view_up: [...candidate.view_up] as CameraState["view_up"],
      parallel_scale: candidate.parallel_scale,
    };
  }

  let tableCoordinates: TableCoordinates | null | undefined;
  if (state.table_coordinates === null) tableCoordinates = null;
  else if (state.table_coordinates !== undefined) {
    if (!state.table_coordinates || typeof state.table_coordinates !== "object") return null;
    const coordinates = state.table_coordinates as Record<string, unknown>;
    if (
      typeof coordinates.x !== "string" ||
      typeof coordinates.y !== "string" ||
      typeof coordinates.z !== "string" ||
      new Set([coordinates.x, coordinates.y, coordinates.z]).size !== 3
    ) return null;
    tableCoordinates = { x: coordinates.x, y: coordinates.y, z: coordinates.z };
  }
  if (state.image_mode !== undefined && state.image_mode !== "slice" && state.image_mode !== "volume") {
    return null;
  }
  if (state.slice_axis !== undefined && !["X", "Y", "Z"].includes(state.slice_axis as string)) {
    return null;
  }
  // VTK WholeExtent may start below zero, so sign is dataset-dependent. App
  // clamps the restored integer against the active dataset's actual extent.
  if (state.slice_index !== undefined && (!Number.isInteger(state.slice_index))) return null;
  if (
    state.timestep_index !== undefined &&
    (!Number.isInteger(state.timestep_index) || (state.timestep_index as number) < 0)
  ) return null;

  return {
    schema_version: 1,
    representation: state.representation as Representation,
    color_by: colorBy,
    color_range: colorRange,
    opacity: state.opacity,
    color_map: state.color_map as ColorMapName,
    legend_visible: state.legend_visible,
    camera,
    ...(state.table_coordinates !== undefined ? { table_coordinates: tableCoordinates } : {}),
    ...(state.image_mode !== undefined ? { image_mode: state.image_mode as ImageMode } : {}),
    ...(state.slice_axis !== undefined ? { slice_axis: state.slice_axis as SliceAxis } : {}),
    ...(state.slice_index !== undefined ? { slice_index: state.slice_index as number } : {}),
    ...(state.timestep_index !== undefined
      ? { timestep_index: state.timestep_index as number }
      : {}),
  };
}

export function clampSliceIndex(index: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(index, maximum));
}
