import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Job } from "../types";
import { mergeJobSnapshots } from "../lib/job";
import type { ProjectScope } from "./useProjectScope";

interface Options {
  currentProjectId: string | null;
  scope: ProjectScope;
  jobErrorPrefix: string;
  onError: (message: string) => void;
  onErrorCleared: (prefix: string) => void;
}

/** Polls the project's job list and owns cancellation state. */
export function useJobPolling({
  currentProjectId,
  scope,
  jobErrorPrefix,
  onError,
  onErrorCleared,
}: Options) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [cancelingJobIds, setCancelingJobIds] = useState<Set<string>>(() => new Set());
  // Mirror of cancelingJobIds for a synchronous double-request guard.
  const cancelingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!currentProjectId) {
      setJobs([]);
      setCancelingJobIds(new Set());
      return;
    }
    const projectEpoch = scope.projectEpochRef.current;
    let disposed = false;
    let timer: number | undefined;
    const stillCurrent = () =>
      !disposed &&
      scope.currentProjectRef.current === currentProjectId &&
      scope.projectEpochRef.current === projectEpoch;
    const poll = async () => {
      try {
        const next = await api.listJobs(currentProjectId);
        if (stillCurrent()) {
          setJobs((previous) => mergeJobSnapshots(previous, next));
          onErrorCleared(jobErrorPrefix);
        }
      } catch (e) {
        if (stillCurrent()) onError(`${jobErrorPrefix}: ${String(e)}`);
      } finally {
        if (stillCurrent()) timer = window.setTimeout(poll, 1200);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [currentProjectId, scope, jobErrorPrefix, onError, onErrorCleared]);

  /** Upsert a job snapshot (e.g. one returned by a POST) into the list. */
  const upsertJob = useCallback((job: Job) => {
    setJobs((previous) =>
      mergeJobSnapshots(previous, [job, ...previous.filter((item) => item.id !== job.id)]),
    );
  }, []);

  const cancelJob = useCallback(
    (id: string) => {
      const ticket = scope.capture();
      if (!ticket || cancelingRef.current.has(id)) return;
      cancelingRef.current.add(id);
      setCancelingJobIds(new Set(cancelingRef.current));
      void (async () => {
        try {
          const canceled = await api.cancelJob(id);
          if (ticket.stillCurrent()) upsertJob(canceled);
        } catch (e) {
          if (ticket.stillCurrent()) onError(String(e));
        } finally {
          cancelingRef.current.delete(id);
          setCancelingJobIds(new Set(cancelingRef.current));
        }
      })();
    },
    [scope, upsertJob, onError],
  );

  return { jobs, setJobs, cancelingJobIds, upsertJob, cancelJob };
}
