import { describe, expect, it } from "vitest";
import type { Job } from "../types";
import { isCancellable, lastLogLine, mergeJobSnapshots } from "./job";

const job = (status: Job["status"]): Job => ({
  id: "j1",
  kind: "ingest",
  status,
  progress: 0,
  log: "",
  created_at: "2026-07-10T00:00:00Z",
  updated_at: "2026-07-10T00:00:00Z",
});

describe("job UI helpers", () => {
  it("extracts the last non-empty log line", () => {
    expect(lastLogLine("start\nworking\n\n")).toBe("working");
  });

  it("only permits cancellation of active jobs", () => {
    expect(isCancellable(job("queued"))).toBe(true);
    expect(isCancellable(job("running"))).toBe(true);
    expect(isCancellable(job("succeeded"))).toBe(false);
    expect(isCancellable(job("failed"))).toBe(false);
  });

  it("does not regress a job when an older poll finishes late", () => {
    const canceled = { ...job("canceled"), updated_at: "2026-07-10T00:00:02Z" };
    const staleRunning = { ...job("running"), updated_at: "2026-07-10T00:00:01Z" };
    expect(mergeJobSnapshots([canceled], [staleRunning])[0].status).toBe("canceled");
  });

  it("preserves a newly submitted job missing from a stale list and de-duplicates ids", () => {
    const submitted = { ...job("queued"), id: "new", updated_at: "2026-07-10T00:00:02Z" };
    const old = { ...job("succeeded"), id: "old", updated_at: "2026-07-10T00:00:01Z" };
    const merged = mergeJobSnapshots([submitted, old], [old, old]);
    expect(merged.map((item) => item.id)).toEqual(["old", "new"]);
  });
});
