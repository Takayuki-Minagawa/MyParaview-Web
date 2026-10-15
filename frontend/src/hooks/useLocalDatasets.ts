import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dataset } from "../types";
import type { Messages } from "../i18n";
import {
  createLocalDataset,
  LocalDatasetError,
  withSceneSummary,
  type LocalDatasetSource,
  type SceneSummary,
} from "../lib/localDataset";
import { loadSample, sampleById } from "../lib/samples";

interface Options {
  t: Messages;
  onError: (message: string) => void;
}

/** Translate a local-dataset failure into the banner text. */
export function formatLocalDatasetError(error: unknown, t: Messages): string {
  if (error instanceof LocalDatasetError) {
    const details = error.details.length ? `: ${error.details.join(", ")}` : "";
    switch (error.code) {
      case "no-files": return t.local.errorNoFiles;
      case "unsupported": return `${t.local.errorUnsupported}${details}`;
      case "server-only": return `${t.local.errorServerOnly}${details}`;
      case "missing-files": return `${t.local.errorMissingFiles}${details}`;
      case "invalid-pvd": return t.local.errorInvalidPvd;
      case "needs-descriptor": return t.local.errorNeedsDescriptor;
      case "empty-csv": return t.local.errorEmptyCsv;
    }
  }
  return `${t.local.errorLoadFailed}: ${String(error)}`;
}

/** Browser-local datasets opened from disk or from the sample catalog. */
export function useLocalDatasets({ t, onError }: Options) {
  const [sources, setSources] = useState<LocalDatasetSource[]>([]);
  const [loadingLabel, setLoadingLabel] = useState<string | null>(null);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  useEffect(() => () => {
    sourcesRef.current.forEach((source) => source.revoke());
  }, []);

  const register = useCallback((source: LocalDatasetSource) => {
    setSources((previous) => [source, ...previous]);
    return source.dataset;
  }, []);

  const openFiles = useCallback(async (files: File[]): Promise<Dataset | null> => {
    setLoadingLabel(files[0]?.name ?? "");
    try {
      return register(await createLocalDataset(files));
    } catch (error) {
      onError(formatLocalDatasetError(error, t));
      return null;
    } finally {
      setLoadingLabel(null);
    }
  }, [register, onError, t]);

  const openSample = useCallback(async (sampleId: string): Promise<Dataset | null> => {
    const sample = sampleById(sampleId);
    if (!sample) return null;
    const label = t.local.sampleNames[sample.id];
    setLoadingLabel(label);
    try {
      const baseUrl = (import.meta.env?.BASE_URL as string | undefined) ?? "/";
      return register(await loadSample(sample, baseUrl, label));
    } catch (error) {
      onError(formatLocalDatasetError(error, t));
      return null;
    } finally {
      setLoadingLabel(null);
    }
  }, [register, onError, t]);

  const removeLocal = useCallback((id: string) => {
    setSources((previous) => {
      previous.find((source) => source.dataset.id === id)?.revoke();
      return previous.filter((source) => source.dataset.id !== id);
    });
  }, []);

  const applySummary = useCallback((id: string, summary: SceneSummary) => {
    setSources((previous) => previous.map((source) => (
      source.dataset.id === id
        ? { ...source, dataset: withSceneSummary(source.dataset, summary) }
        : source
    )));
  }, []);

  const fileFor = useCallback((id: string, timestepIndex = 0): File | null => {
    const source = sourcesRef.current.find((item) => item.dataset.id === id);
    if (!source) return null;
    // Collections keep the descriptor first; timestep files follow in order.
    const offset = source.dataset.dataset_type === "Collection" ? 1 : 0;
    return source.files[offset + timestepIndex] ?? source.files[0] ?? null;
  }, []);

  const localDatasets = useMemo(() => sources.map((source) => source.dataset), [sources]);

  return { localDatasets, loadingLabel, openFiles, openSample, removeLocal, applySummary, fileFor };
}
