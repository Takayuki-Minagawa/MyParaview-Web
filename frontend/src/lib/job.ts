import type { Job } from "../types";

export function lastLogLine(log: string): string {
  const lines = log.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

export function isCancellable(job: Job): boolean {
  return job.status === "queued" || job.status === "running";
}

/** Merge polling snapshots without letting an older response regress status. */
export function mergeJobSnapshots(current: Job[], incoming: Job[]): Job[] {
  const merged = new Map(current.map((job) => [job.id, job]));
  for (const job of incoming) {
    const previous = merged.get(job.id);
    if (!previous || previous.updated_at <= job.updated_at) merged.set(job.id, job);
  }
  const order = [
    ...incoming.map((job) => job.id),
    ...current.map((job) => job.id),
  ];
  return [...new Set(order)].map((id) => merged.get(id)).filter((job): job is Job => !!job);
}
