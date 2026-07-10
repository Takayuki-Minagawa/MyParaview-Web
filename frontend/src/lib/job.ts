import type { Job } from "../types";

export function lastLogLine(log: string): string {
  const lines = log.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

export function isCancellable(job: Job): boolean {
  return job.status === "queued" || job.status === "running";
}

/** Merge polling snapshots without letting an older response regress status.
 * Returns ``current`` unchanged (same reference) when the snapshot carries no
 * visible difference, so a poll tick does not force a re-render. */
export function mergeJobSnapshots(current: Job[], incoming: Job[]): Job[] {
  const merged = new Map(current.map((job) => [job.id, job]));
  for (const job of incoming) {
    const previous = merged.get(job.id);
    if (!previous) {
      merged.set(job.id, job);
      continue;
    }
    if (previous.updated_at > job.updated_at) continue;
    if (
      previous.updated_at === job.updated_at &&
      previous.status === job.status &&
      previous.progress === job.progress &&
      previous.log === job.log &&
      JSON.stringify(previous.result ?? null) === JSON.stringify(job.result ?? null)
    ) continue;
    merged.set(job.id, job);
  }
  const order = [
    ...incoming.map((job) => job.id),
    ...current.map((job) => job.id),
  ];
  const next = [...new Set(order)].map((id) => merged.get(id)).filter((job): job is Job => !!job);
  const unchanged =
    next.length === current.length && next.every((job, index) => job === current[index]);
  return unchanged ? current : next;
}
