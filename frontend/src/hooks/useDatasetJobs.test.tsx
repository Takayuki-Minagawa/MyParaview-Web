import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useDatasetJobs } from "./useDatasetJobs";
import { useProjectScope } from "./useProjectScope";
import { api, pollJob } from "../api";
import type { Job } from "../types";

vi.mock("../api", () => ({
  api: {
    createJob: vi.fn(),
    createMovieJob: vi.fn(),
    promoteArtifact: vi.fn(),
    ingest: vi.fn(),
    timestepUrl: vi.fn((id: string, index: number) => `/datasets/${id}/timesteps/${index}/download`),
  },
  authorizedFetch: vi.fn(),
  pollJob: vi.fn(),
}));

const createJob = vi.mocked(api.createJob);
const createMovieJob = vi.mocked(api.createMovieJob);
const mockedPollJob = vi.mocked(pollJob);

function job(id: string, status: Job["status"] = "succeeded"): Job {
  return {
    id,
    project_id: "p1",
    kind: "export",
    status,
    progress: 1,
    log: "done",
    created_at: "",
    updated_at: "",
  } as Job;
}

function renderJobs() {
  const upsertJob = vi.fn();
  const refreshArtifacts = vi.fn().mockResolvedValue(undefined);
  const refreshDatasets = vi.fn().mockResolvedValue(undefined);
  const clearErrors = vi.fn();
  const onError = vi.fn();
  const rendered = renderHook(() => {
    const scope = useProjectScope();
    const jobs = useDatasetJobs({
      scope,
      upsertJob,
      refreshArtifacts,
      refreshDatasets,
      clearErrors,
      onError,
      metadataFailedText: "metadata failed",
    });
    return { scope, jobs };
  });
  act(() => {
    rendered.result.current.scope.beginProjectSwitch("p1");
    rendered.result.current.scope.beginSelection("d1");
  });
  return { ...rendered, upsertJob, refreshArtifacts, refreshDatasets, clearErrors, onError };
}

describe("useDatasetJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exportDataset creates the job, tracks it, and refreshes artifacts", async () => {
    createJob.mockResolvedValue(job("j1", "queued"));
    mockedPollJob.mockResolvedValue(job("j1", "succeeded"));
    const { result, refreshArtifacts, upsertJob } = renderJobs();

    act(() => result.current.jobs.exportDataset());
    expect(result.current.jobs.exportPending).toBe(true);
    await waitFor(() => expect(result.current.jobs.exportPending).toBe(false));
    expect(createJob).toHaveBeenCalledWith("p1", "export", "d1", { output_format: "source" });
    expect(upsertJob).toHaveBeenCalled();
    expect(refreshArtifacts).toHaveBeenCalledWith("d1");
  });

  it("a failed tracked job surfaces its last log line via onError", async () => {
    createJob.mockResolvedValue(job("j1", "queued"));
    mockedPollJob.mockResolvedValue({ ...job("j1", "failed"), log: "start\nboom" });
    const { result, onError } = renderJobs();

    act(() => result.current.jobs.runStats());
    await waitFor(() => expect(result.current.jobs.statsPending).toBe(false));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("boom");
  });

  it("exportMovie uses the typed movie API and tracks the artifact job", async () => {
    createMovieJob.mockResolvedValue({ ...job("movie-1", "queued"), kind: "movie" });
    mockedPollJob.mockResolvedValue({ ...job("movie-1", "succeeded"), kind: "movie" });
    const { result, refreshArtifacts } = renderJobs();
    const params = { format: "webm", fps: 30, width: 1280, height: 720 } as const;

    act(() => result.current.jobs.exportMovie(params));
    expect(result.current.jobs.moviePending).toBe(true);
    await waitFor(() => expect(result.current.jobs.moviePending).toBe(false));
    expect(createMovieJob).toHaveBeenCalledWith("p1", "d1", params);
    expect(refreshArtifacts).toHaveBeenCalledWith("d1");
  });

  it("re-entrant clicks while pending are ignored", async () => {
    createJob.mockResolvedValue(job("j1", "queued"));
    mockedPollJob.mockImplementation(() => new Promise(() => {}));
    const { result } = renderJobs();

    act(() => result.current.jobs.convertDataset());
    await waitFor(() => expect(result.current.jobs.convertPending).toBe(true));
    act(() => result.current.jobs.convertDataset());
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it("promoteArtifact tracks pending per artifact id and refreshes datasets", async () => {
    vi.mocked(api.promoteArtifact).mockResolvedValue({ id: "d2" } as never);
    vi.mocked(api.ingest).mockResolvedValue(job("j2", "queued"));
    mockedPollJob.mockResolvedValue(job("j2", "succeeded"));
    const { result, refreshDatasets } = renderJobs();

    act(() => result.current.jobs.promoteArtifact({ id: "a1", filename: "x.vtp" } as never));
    expect(result.current.jobs.promotePendingIds.has("a1")).toBe(true);
    await waitFor(() => expect(result.current.jobs.promotePendingIds.has("a1")).toBe(false));
    expect(refreshDatasets).toHaveBeenCalledWith("p1");
  });

  it("resetPending clears every pending flag", async () => {
    createJob.mockResolvedValue(job("j1", "queued"));
    mockedPollJob.mockImplementation(() => new Promise(() => {}));
    const { result } = renderJobs();

    act(() => result.current.jobs.exportDataset());
    await waitFor(() => expect(result.current.jobs.exportPending).toBe(true));
    act(() => result.current.jobs.resetPending());
    expect(result.current.jobs.exportPending).toBe(false);
    expect(result.current.jobs.moviePending).toBe(false);
  });
});
