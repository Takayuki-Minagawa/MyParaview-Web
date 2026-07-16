import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useJobPolling } from "./useJobPolling";
import { useProjectScope } from "./useProjectScope";
import { api } from "../api";
import type { Job } from "../types";

vi.mock("../api", () => ({
  api: {
    listJobs: vi.fn(),
    cancelJob: vi.fn(),
  },
}));

const listJobs = vi.mocked(api.listJobs);
const cancelJob = vi.mocked(api.cancelJob);

function job(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    project_id: "p1",
    kind: "ingest",
    status: "running",
    progress: 0.5,
    log: "",
    target_id: null,
    params: null,
    result: null,
    error: null,
    created_at: "2026-07-16T00:00:00Z",
    updated_at: "2026-07-16T00:00:00Z",
    ...overrides,
  } as Job;
}

/** Renders useProjectScope + useJobPolling together so the polling hook sees
 * the real scope-ticket behavior. */
function renderPolling(initialProjectId: string | null) {
  const onError = vi.fn();
  const onErrorCleared = vi.fn();
  const rendered = renderHook(
    ({ currentProjectId }: { currentProjectId: string | null }) => {
      const scope = useProjectScope();
      const polling = useJobPolling({
        currentProjectId,
        scope,
        jobErrorPrefix: "jobs",
        onError,
        onErrorCleared,
      });
      return { scope, polling };
    },
    // Mount without a project first so the scope refs can be pointed at the
    // project BEFORE the polling effect runs (mirrors App's ordering, where
    // beginProjectSwitch happens in the select handler ahead of the render
    // that passes the new currentProjectId down).
    { initialProps: { currentProjectId: null as string | null } },
  );
  if (initialProjectId) {
    act(() => rendered.result.current.scope.beginProjectSwitch(initialProjectId));
    rendered.rerender({ currentProjectId: initialProjectId });
  }
  return { ...rendered, onError, onErrorCleared };
}

describe("useJobPolling", () => {
  beforeEach(() => {
    listJobs.mockReset();
    cancelJob.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps jobs empty and never polls without a current project", () => {
    const { result } = renderPolling(null);
    expect(result.current.polling.jobs).toEqual([]);
    expect(listJobs).not.toHaveBeenCalled();
  });

  it("polls the project's jobs and stores the snapshot", async () => {
    listJobs.mockResolvedValue([job("j1")]);
    const { result, onErrorCleared } = renderPolling("p1");
    // beginProjectSwitch happens after mount; remount the effect by rerendering
    // is not needed — the first poll already ran with currentProjectId="p1".
    await waitFor(() => expect(result.current.polling.jobs).toHaveLength(1));
    expect(result.current.polling.jobs[0].id).toBe("j1");
    expect(onErrorCleared).toHaveBeenCalledWith("jobs");
  });

  it("keeps the same jobs array reference when a poll returns identical data", async () => {
    vi.useFakeTimers();
    listJobs.mockResolvedValue([job("j1")]);
    const { result } = renderPolling("p1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.polling.jobs).toHaveLength(1);
    const first = result.current.polling.jobs;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(listJobs.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.current.polling.jobs).toBe(first);
  });

  it("ignores a poll response that resolves after a project switch", async () => {
    let resolvePoll: (jobs: Job[]) => void = () => {};
    listJobs.mockImplementation(
      () => new Promise<Job[]>((resolve) => { resolvePoll = resolve; }),
    );
    const { result } = renderPolling("p1");
    act(() => {
      result.current.scope.beginProjectSwitch("p2");
    });
    await act(async () => {
      resolvePoll([job("stale")]);
      await Promise.resolve();
    });
    expect(result.current.polling.jobs).toEqual([]);
  });

  it("reports poll errors through onError with the prefix", async () => {
    listJobs.mockRejectedValue(new Error("boom"));
    const { onError } = renderPolling("p1");
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0]).toMatch(/^jobs: /);
  });

  it("upsertJob puts a fresh job snapshot at the front", async () => {
    listJobs.mockResolvedValue([job("j1")]);
    const { result } = renderPolling("p1");
    await waitFor(() => expect(result.current.polling.jobs).toHaveLength(1));
    act(() => {
      result.current.polling.upsertJob(job("j2", { status: "queued" }));
    });
    expect(result.current.polling.jobs.map((item) => item.id)).toEqual(["j2", "j1"]);
  });

  it("cancelJob guards against a double request for the same id", async () => {
    listJobs.mockResolvedValue([job("j1")]);
    let resolveCancel: (value: Job) => void = () => {};
    cancelJob.mockImplementation(
      () => new Promise<Job>((resolve) => { resolveCancel = resolve; }),
    );
    const { result } = renderPolling("p1");
    await waitFor(() => expect(result.current.polling.jobs).toHaveLength(1));

    act(() => {
      result.current.polling.cancelJob("j1");
      result.current.polling.cancelJob("j1");
    });
    expect(cancelJob).toHaveBeenCalledTimes(1);
    expect(result.current.polling.cancelingJobIds.has("j1")).toBe(true);

    await act(async () => {
      resolveCancel(job("j1", { status: "canceled", updated_at: "2026-07-16T00:00:01Z" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(result.current.polling.cancelingJobIds.has("j1")).toBe(false),
    );
    expect(result.current.polling.jobs[0].status).toBe("canceled");
  });
});
