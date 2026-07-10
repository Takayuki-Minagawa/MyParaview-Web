import type {
  Artifact,
  AssistProposal,
  CollectionStep,
  Dataset,
  Job,
  Pipeline,
  Project,
  ProjectMember,
  ProjectRole,
  ServerCapabilities,
  ViewState,
} from "./types";

export const API_BASE =
  (import.meta.env?.VITE_API_BASE as string | undefined) ?? "http://localhost:8000";

export function setAccessToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) window.sessionStorage.setItem("pvweb.accessToken", token);
  else window.sessionStorage.removeItem("pvweb.accessToken");
}

function accessToken() {
  return typeof window === "undefined"
    ? null
    : window.sessionStorage.getItem("pvweb.accessToken");
}

export function authorizedFetch(input: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  const token = accessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await authorizedFetch(`${API_BASE}${path}`, init);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`${resp.status} ${resp.statusText}: ${text}`);
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

export const api = {
  health: () => req<{ status: string }>("/health"),
  capabilities: () => req<ServerCapabilities>("/capabilities"),

  listProjects: () => req<Project[]>("/projects"),
  createProject: (name: string) =>
    req<Project>("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  getMembership: (projectId: string) =>
    req<ProjectMember>(`/projects/${projectId}/membership`),
  listMembers: (projectId: string) =>
    req<ProjectMember[]>(`/projects/${projectId}/members`),
  putMember: (projectId: string, userId: string, role: ProjectRole) =>
    req<ProjectMember>(
      `/projects/${projectId}/members`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, role }),
      },
    ),

  listDatasets: (projectId: string) =>
    req<Dataset[]>(`/projects/${projectId}/datasets`),
  getDataset: (id: string) => req<Dataset>(`/datasets/${id}`),

  uploadDataset: (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return req<Dataset>(`/projects/${projectId}/datasets`, { method: "POST", body: fd });
  },
  uploadDatasetBundle: (projectId: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) {
      form.append("files", file, file.webkitRelativePath || file.name);
    }
    return req<Dataset>(`/projects/${projectId}/dataset-bundles`, {
      method: "POST",
      body: form,
    });
  },
  uploadExternalDatasetBundle: (projectId: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) {
      form.append("files", file, file.webkitRelativePath || file.name);
    }
    return req<Dataset>(`/projects/${projectId}/external-dataset-bundles`, {
      method: "POST",
      body: form,
    });
  },

  ingest: (datasetId: string) =>
    req<Job>(`/datasets/${datasetId}/ingest`, { method: "POST" }),

  getJob: (id: string) => req<Job>(`/jobs/${id}`),
  listJobs: (projectId?: string) =>
    req<Job[]>(`/jobs${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ""}`),
  cancelJob: (id: string) => req<Job>(`/jobs/${id}/cancel`, { method: "POST" }),
  createJob: (
    projectId: string,
    kind: "convert" | "filter" | "export",
    targetId: string,
    params: Record<string, unknown>,
  ) => req<Job>("/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, kind, target_id: targetId, params }),
  }),

  listPipelines: (projectId: string) =>
    req<Pipeline[]>(`/pipelines?project_id=${encodeURIComponent(projectId)}`),
  createViewPipeline: (
    projectId: string,
    datasetId: string,
    name: string,
    viewState: ViewState,
  ) => req<Pipeline>("/pipelines", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: projectId,
      name,
      nodes: [
        { node_type: "reader", name: "Reader", local_id: "reader", dataset_id: datasetId, params: {} },
        {
          node_type: "representation",
          name: "Representation",
          input_id: "reader",
          params: { view_state: viewState },
        },
      ],
    }),
  }),
  deletePipeline: (id: string) => req<void>(`/pipelines/${id}`, { method: "DELETE" }),

  listArtifacts: (datasetId: string) =>
    req<Artifact[]>(`/artifacts?dataset_id=${encodeURIComponent(datasetId)}`),
  uploadArtifact: (datasetId: string, kind: "screenshot" | "client_export", blob: Blob) => {
    const form = new FormData();
    const extension = kind === "screenshot" ? "png" : "bin";
    form.append("file", blob, `${kind}.${extension}`);
    return req<Artifact>(
      `/artifacts?dataset_id=${encodeURIComponent(datasetId)}&kind=${kind}`,
      { method: "POST", body: form },
    );
  },
  downloadArtifact: async (artifactId: string) => {
    const response = await authorizedFetch(`${API_BASE}/artifacts/${artifactId}`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.blob();
  },

  downloadUrl: (datasetId: string) => `${API_BASE}/datasets/${datasetId}/download`,
  listTimesteps: (datasetId: string) =>
    req<CollectionStep[]>(`/datasets/${datasetId}/timesteps`),
  timestepUrl: (datasetId: string, stepIndex: number) =>
    `${API_BASE}/datasets/${datasetId}/timesteps/${stepIndex}/download`,
  proposeAssistance: (datasetId: string, prompt: string) =>
    req<AssistProposal>("/assist/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset_id: datasetId, prompt }),
    }),
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
