import { useCallback, useState } from "react";
import { api, authorizedFetch, pollJob } from "../api";
import type {
  Artifact,
  Job,
  JobKind,
  JobParamsByKind,
  MovieParams,
  ServerFilterParams,
} from "../types";
import { responseFilename, triggerBlobDownload } from "../lib/download";
import type { ProjectScope, ScopeTicket } from "./useProjectScope";

interface Options {
  scope: ProjectScope;
  upsertJob: (job: Job) => void;
  refreshArtifacts: (datasetId: string) => Promise<void>;
  refreshDatasets: (projectId: string) => Promise<void>;
  clearErrors: () => void;
  onError: (message: string) => void;
  /** Localized prefix for a failed post-promotion ingest. */
  metadataFailedText: string;
}

/** Job-producing dataset actions (export/convert/stats/server filter),
 * artifact promotion, and timestep download — each with its pending state. */
export function useDatasetJobs({
  scope,
  upsertJob,
  refreshArtifacts,
  refreshDatasets,
  clearErrors,
  onError,
  metadataFailedText,
}: Options) {
  const [exportPending, setExportPending] = useState(false);
  const [convertPending, setConvertPending] = useState(false);
  const [statsPending, setStatsPending] = useState(false);
  const [moviePending, setMoviePending] = useState(false);
  const [filterPending, setFilterPending] = useState(false);
  const [promotePendingIds, setPromotePendingIds] = useState<Set<string>>(() => new Set());

  /** Project switches must not leave stale pending flags behind. */
  const resetPending = useCallback(() => {
    setExportPending(false);
    setConvertPending(false);
    setStatsPending(false);
    setMoviePending(false);
    setFilterPending(false);
    setPromotePendingIds(new Set());
  }, []);

  /** Track a job returned by a POST until completion, refreshing artifacts. */
  const trackJob = useCallback(async (job: Job, ticket: ScopeTicket | null = scope.capture()) => {
    if (ticket?.stillCurrent()) upsertJob(job);
    const final = await pollJob(job.id, (next) => {
      if (ticket?.stillCurrent()) upsertJob(next);
    });
    if (final.status !== "succeeded") {
      const lastLog = final.log.split("\n").filter(Boolean).pop() ?? final.status;
      throw new Error(`${final.kind} job ${final.status}: ${lastLog}`);
    }
    const datasetId = scope.selectedDatasetRef.current;
    if (ticket?.stillCurrent() && datasetId) await refreshArtifacts(datasetId);
    return final;
  }, [scope, upsertJob, refreshArtifacts]);

  const runDatasetJob = useCallback(async <K extends JobKind>(
    kind: K,
    params: JobParamsByKind[K],
    setPending: (pending: boolean) => void,
  ) => {
    const ticket = scope.capture();
    const datasetId = scope.selectedDatasetRef.current;
    if (!ticket || !datasetId) return;
    setPending(true);
    clearErrors();
    try {
      const job = await api.createJob(ticket.projectId, kind, datasetId, params);
      await trackJob(job, ticket);
    } catch (e) {
      if (ticket.stillCurrent()) onError(String(e));
    } finally {
      if (ticket.stillCurrent()) setPending(false);
    }
  }, [scope, clearErrors, trackJob, onError]);

  const exportDataset = useCallback(() => {
    if (exportPending) return;
    void runDatasetJob("export", { output_format: "source" }, setExportPending);
  }, [exportPending, runDatasetJob]);

  const convertDataset = useCallback(() => {
    if (convertPending) return;
    void runDatasetJob("convert", { output_format: "vtp" }, setConvertPending);
  }, [convertPending, runDatasetJob]);

  const runStats = useCallback(() => {
    if (statsPending) return;
    void runDatasetJob("stats", { bins: 32 }, setStatsPending);
  }, [statsPending, runDatasetJob]);

  const exportMovie = useCallback((params: MovieParams) => {
    if (moviePending) return;
    const ticket = scope.capture();
    const datasetId = scope.selectedDatasetRef.current;
    if (!ticket || !datasetId) return;
    setMoviePending(true);
    clearErrors();
    void api.createMovieJob(ticket.projectId, datasetId, params)
      .then((job) => trackJob(job, ticket))
      .catch((e) => {
        if (ticket.stillCurrent()) onError(String(e));
      })
      .finally(() => {
        if (ticket.stillCurrent()) setMoviePending(false);
      });
  }, [moviePending, scope, clearErrors, trackJob, onError]);

  const runServerFilter = useCallback((params: ServerFilterParams) => {
    if (filterPending) return;
    void runDatasetJob("filter", params, setFilterPending);
  }, [filterPending, runDatasetJob]);

  const onAssistJobCreated = useCallback((job: Job) => {
    const ticket = scope.capture();
    void trackJob(job, ticket).catch((e) => {
      if (ticket?.stillCurrent()) onError(String(e));
    });
  }, [scope, trackJob, onError]);

  const promoteArtifact = useCallback((artifact: Artifact) => {
    const ticket = scope.capture();
    if (!ticket) return;
    setPromotePendingIds((previous) => new Set(previous).add(artifact.id));
    void (async () => {
      try {
        const dataset = await api.promoteArtifact(artifact.id);
        const job = await api.ingest(dataset.id);
        if (ticket.stillCurrent()) upsertJob(job);
        const final = await pollJob(job.id, (next) => {
          if (ticket.stillCurrent()) upsertJob(next);
        });
        if (ticket.stillCurrent()) await refreshDatasets(ticket.projectId);
        if (final.status !== "succeeded" && ticket.stillCurrent()) {
          const lastLog = final.log.split("\n").filter(Boolean).pop() ?? final.status;
          onError(`${metadataFailedText} (${final.status}): ${lastLog}`);
        }
      } catch (e) {
        if (ticket.stillCurrent()) onError(String(e));
      } finally {
        setPromotePendingIds((previous) => {
          const next = new Set(previous);
          next.delete(artifact.id);
          return next;
        });
      }
    })();
  }, [scope, upsertJob, refreshDatasets, onError, metadataFailedText]);

  const downloadTimestep = useCallback((index: number) => {
    const datasetId = scope.selectedDatasetRef.current;
    if (!datasetId) return;
    void authorizedFetch(api.timestepUrl(datasetId, index))
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const blob = await response.blob();
        // Prefer the piece's real name (e.g. flow_0001.vtp); the fallback at
        // least carries an extension so the file opens in a viewer.
        triggerBlobDownload(blob, responseFilename(response, `timestep-${index}.bin`));
      })
      .catch((e) => onError(String(e)));
  }, [scope, onError]);

  return {
    trackJob,
    exportDataset,
    exportPending,
    convertDataset,
    convertPending,
    runStats,
    statsPending,
    exportMovie,
    moviePending,
    runServerFilter,
    filterPending,
    onAssistJobCreated,
    promoteArtifact,
    promotePendingIds,
    downloadTimestep,
    resetPending,
  };
}
