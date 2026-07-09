import type { Dataset, Job, Project } from "./types";

export const API_BASE =
  (import.meta.env?.VITE_API_BASE as string | undefined) ?? "http://localhost:8000";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, init);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`${resp.status} ${resp.statusText}: ${text}`);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

export const api = {
  health: () => req<{ status: string }>("/health"),

  listProjects: () => req<Project[]>("/projects"),
  createProject: (name: string) =>
    req<Project>("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),

  listDatasets: (projectId: string) =>
    req<Dataset[]>(`/projects/${projectId}/datasets`),
  getDataset: (id: string) => req<Dataset>(`/datasets/${id}`),

  uploadDataset: (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req<Dataset>(`/projects/${projectId}/datasets`, { method: "POST", body: fd });
  },

  ingest: (datasetId: string) =>
    req<Job>(`/datasets/${datasetId}/ingest`, { method: "POST" }),

  getJob: (id: string) => req<Job>(`/jobs/${id}`),
  cancelJob: (id: string) => req<Job>(`/jobs/${id}/cancel`, { method: "POST" }),

  downloadUrl: (datasetId: string) => `${API_BASE}/datasets/${datasetId}/download`,
};

const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

/** Poll a job until it reaches a terminal state. */
export async function pollJob(
  jobId: string,
  onTick?: (job: Job) => void,
  { intervalMs = 400, timeoutMs = 60000 }: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<Job> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await api.getJob(jobId);
    onTick?.(job);
    if (TERMINAL.has(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} timed out`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
