import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { api, pollJob } from "../api";
import type { Artifact, Job } from "../types";
import type { Language, Messages } from "../i18n";
import type { DisplayState } from "./useDisplayState";
import type { ProjectScope } from "./useProjectScope";

interface Options {
  scope: ProjectScope;
  display: DisplayState;
  language: Language;
  t: Messages;
  upsertJob: (job: Job) => void;
  refreshDatasets: (projectId: string) => Promise<void>;
  refreshArtifacts: (datasetId: string) => Promise<void>;
  setArtifacts: Dispatch<SetStateAction<Artifact[]>>;
  setSelectedDatasetId: (id: string) => void;
  clearErrors: () => void;
  onError: (message: string) => void;
}

/** Upload (single file or bundle) plus the follow-up ingest tracking and
 * completion auto-select. Owns the busy banner text. */
export function useDatasetUpload({
  scope,
  display,
  language,
  t,
  upsertJob,
  refreshDatasets,
  refreshArtifacts,
  setArtifacts,
  setSelectedDatasetId,
  clearErrors,
  onError,
}: Options) {
  const [busy, setBusy] = useState<string | null>(null);
  const clearBusy = useCallback(() => setBusy(null), []);

  const upload = useCallback(async (files: File[]) => {
    const ticket = scope.capture();
    if (!ticket || files.length === 0) return;
    // Auto-selecting the finished upload must not steal a selection the user
    // made while the ingest was running.
    const selectionAtStart = scope.selectionRequestRef.current;
    const pvd = files.find((file) => file.name.toLowerCase().endsWith(".pvd"));
    const externalDescriptor = files.find((file) => /\.(case|xdmf|xmf)$/i.test(file.name));
    const primary = pvd ?? externalDescriptor ?? files[0];
    if (files.length > 1 && !pvd && !externalDescriptor) {
      onError(t.errors.multiFileDescriptor);
      return;
    }
    const pvdBundle = !!pvd && files.length > 1;
    const isBundle = pvdBundle || !!externalDescriptor;
    clearErrors();
    try {
      setBusy(
        language === "ja"
          ? `${primary.name}${isBundle ? ` ${t.errors.andMore}${files.length - 1}件` : ""} ${t.errors.uploadingSuffix}`
          : `${primary.name}${isBundle ? ` ${t.errors.andMore} ${files.length - 1}` : ""} ${t.errors.uploadingSuffix}`,
      );
      const ds = pvdBundle
        ? await api.uploadDatasetBundle(ticket.projectId, files)
        : isBundle && externalDescriptor
          ? await api.uploadExternalDatasetBundle(ticket.projectId, files)
          : await api.uploadDataset(ticket.projectId, primary);
      if (ticket.stillCurrent()) setBusy(t.errors.metadataParsing);
      const job = await api.ingest(ds.id);
      const final = await pollJob(job.id, (j) => {
        if (ticket.stillCurrent()) {
          setBusy(`${t.errors.parsingProgress} ${Math.round(j.progress * 100)}%`);
          upsertJob(j);
        }
      });
      if (!ticket.stillCurrent()) return;
      await refreshDatasets(ticket.projectId);
      if (!ticket.stillCurrent()) return;
      if (scope.selectionRequestRef.current === selectionAtStart) {
        scope.beginSelection(ds.id);
        setSelectedDatasetId(ds.id);
        display.reset();
        setArtifacts([]);
        void refreshArtifacts(ds.id);
      }
      if (final.status !== "succeeded" && ticket.stillCurrent()) {
        const lastLog = (final.log ?? "").split("\n").filter(Boolean).pop() ?? "";
        onError(`${t.errors.metadataFailed} (${final.status}): ${lastLog}`);
      }
    } catch (e) {
      if (ticket.stillCurrent()) onError(String(e));
    } finally {
      if (ticket.stillCurrent()) setBusy(null);
    }
  }, [
    scope, onError, clearErrors, language, t, upsertJob, refreshDatasets,
    display, setArtifacts, setSelectedDatasetId, refreshArtifacts,
  ]);

  return { upload, busy, clearBusy };
}
