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

export type Representation = "surface" | "wireframe" | "points";

export type ScalarAssociation = "point" | "cell";
export type ColorMapName = "cool-to-warm" | "viridis" | "grayscale" | "plasma" | "turbo";

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
  trame_sessions: boolean;
}
