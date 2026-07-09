export interface Project {
  id: string;
  name: string;
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
