export interface Project {
  id: string;
  name: string;
  created_at: string;
}

export type ProjectRole = "viewer" | "editor" | "admin";

export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  role: ProjectRole;
  created_at: string;
}

export interface ArrayInfo {
  name: string;
  association: "point" | "cell" | "field" | "table";
  num_components: number;
  data_type?: string | null;
  value_range?: [number, number] | null;
}

export interface Dataset {
  id: string;
  project_id: string;
  filename: string;
  ext: string;
  size_bytes: number;
  status: "registered" | "ingesting" | "ready" | "error";
  error?: string | null;
  dataset_type?: string | null;
  num_points?: number | null;
  num_cells?: number | null;
  num_blocks?: number | null;
  bounds?: number[] | null;
  timesteps?: number[] | null;
  arrays?: ArrayInfo[] | null;
  extra?: Record<string, unknown> | null;
  tags?: string[];
  created_at: string;
}

export interface Job {
  id: string;
  project_id?: string | null;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  progress: number;
  log: string;
  result?: Record<string, unknown> | null;
  target_id?: string | null;
  created_at: string;
  updated_at: string;
}

// Canonical value lists; UI pickers, validators, and the assistant all
// derive from these so a new entry cannot be added in one place only.
export const REPRESENTATION_NAMES = ["surface", "wireframe", "points"] as const;
export type Representation = (typeof REPRESENTATION_NAMES)[number];

export type ScalarAssociation = "point" | "cell";

export const COLOR_MAP_NAMES = [
  "cool-to-warm",
  "viridis",
  "grayscale",
  "plasma",
  "turbo",
] as const;
export type BuiltInColorMapName = (typeof COLOR_MAP_NAMES)[number];
export type CustomColorMapName = `custom:${string}`;
export type ColorMapName = BuiltInColorMapName | CustomColorMapName;

/** Client-creatable job kinds (POST /jobs). */
export const JOB_KINDS = ["convert", "filter", "export", "render", "stats", "movie"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const MOVIE_FORMATS = ["zip", "mp4", "webm"] as const;
export type MovieFormat = (typeof MOVIE_FORMATS)[number];

export interface MovieParams {
  /** Omitted format preserves the legacy PNG-frame ZIP contract. */
  format?: MovieFormat;
  fps?: number;
  width?: number;
  height?: number;
}

export const SERVER_FILTER_NAMES = [
  "slice",
  "clip",
  "contour",
  "threshold",
  "cell_to_point",
  "resample",
  "decimate",
] as const;
export type ServerFilterName = (typeof SERVER_FILTER_NAMES)[number];

export type ServerFilterParams =
  | { filter: "slice" | "clip"; origin: [number, number, number]; normal: [number, number, number] }
  | { filter: "contour"; array: string; association: "POINTS" | "CELLS"; value: number }
  | {
    filter: "threshold";
    array: string;
    association: "POINTS" | "CELLS";
    minimum: number;
    maximum: number;
  }
  | { filter: "cell_to_point" }
  | { filter: "resample"; dimensions: [number, number, number] }
  | { filter: "decimate"; target_reduction: number };

export interface JobParamsByKind {
  convert: Record<string, unknown>;
  filter: ServerFilterParams;
  export: Record<string, unknown>;
  render: Record<string, unknown>;
  stats: Record<string, unknown>;
  movie: MovieParams;
}

export interface ScalarSelection {
  name: string;
  association: ScalarAssociation;
}

export interface CameraState {
  position: [number, number, number];
  focal_point: [number, number, number];
  view_up: [number, number, number];
  parallel_scale: number;
}

export interface ViewState {
  schema_version: 1;
  representation: Representation;
  color_by: ScalarSelection | null;
  /** null means use the selected array's data range automatically. */
  color_range: [number, number] | null;
  opacity: number;
  color_map: ColorMapName;
  legend_visible: boolean;
  camera: CameraState | null;
  table_coordinates?: TableCoordinates | null;
  image_mode?: ImageMode;
  slice_axis?: SliceAxis;
  slice_index?: number;
  timestep_index?: number;
  volume_opacity_points?: VolumeOpacityPoint[];
}

export interface PipelineNode {
  id: string;
  pipeline_id: string;
  node_type: "reader" | "filter" | "representation";
  name: string;
  params: Record<string, unknown>;
  input_id?: string | null;
  dataset_id?: string | null;
}

export interface Pipeline {
  id: string;
  project_id: string;
  name: string;
  created_at: string;
  nodes: PipelineNode[];
}

export interface Artifact {
  id: string;
  dataset_id?: string | null;
  job_id?: string | null;
  kind: string;
  filename: string;
  size_bytes: number;
  content_type: string;
  created_at: string;
}

/** Shape of a stats_json artifact produced by the statistics job. */
export interface ArrayStatistics {
  name: string;
  association: string;
  count: number;
  min: number;
  max: number;
  mean: number;
  stddev: number;
  histogram: {
    bins: number;
    min: number;
    max: number;
    counts: number[];
  };
}

export interface DatasetStatistics {
  dataset_id: string;
  bins: number;
  arrays: ArrayStatistics[];
}

export interface CollectionStep {
  index: number;
  time: number;
  parts: number[];
  files: string[];
}

export interface TableCoordinates {
  x: string;
  y: string;
  z: string;
}

export type ImageMode = "slice" | "volume";
export type SliceAxis = "X" | "Y" | "Z";

/** One control point of the volume-rendering opacity transfer function.
 * ``value`` is normalized 0..1 across the active color range. */
export interface VolumeOpacityPoint {
  value: number;
  alpha: number;
}

export interface AssistProposal {
  id?: string | null;
  action: "filter_job" | "view_change" | "none";
  params: Record<string, unknown>;
  reason: string;
  requires_confirmation: boolean;
  status?: "proposed" | "applied" | "dismissed";
}

export interface AssistProposalRecord {
  id: string;
  project_id: string;
  dataset_id: string;
  actor_id?: string | null;
  prompt: string;
  action: "filter_job" | "view_change" | "none";
  params: Record<string, unknown>;
  reason: string;
  status: "proposed" | "applied" | "dismissed";
  applied_job_id?: string | null;
  created_at: string;
}

export interface AuditEvent {
  id: string;
  actor_id?: string | null;
  project_id?: string | null;
  action: string;
  resource_type: string;
  resource_id?: string | null;
  status_code: number;
  detail?: Record<string, unknown> | null;
  created_at: string;
}

export interface RenderSession {
  id: string;
  project_id: string;
  dataset_id: string;
  mode: "remote" | "local";
  status: string;
  expires_at: string;
  created_at: string;
}

export interface RenderSessionCreated extends RenderSession {
  websocket_path: string;
  websocket_protocol: string;
}

export interface ServerCapabilities {
  database: "sqlite" | "postgresql";
  object_store: "local" | "s3";
  oidc: boolean;
  paraview_worker: boolean;
  video_export: boolean;
  job_queue: "local" | "rq";
  trame_sessions: boolean;
}
