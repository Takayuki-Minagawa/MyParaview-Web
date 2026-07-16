import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dataset, Pipeline } from "../types";

interface Options {
  /** Deep links are parsed once auth settles, not on every render. */
  authReady: boolean;
  currentProjectId: string | null;
  selectedDatasetId: string | null;
  datasets: Dataset[];
  pipelines: Pipeline[];
  restorePipeline: (pipeline: Pipeline) => Promise<void>;
  selectDataset: (id: string) => Promise<Dataset | null>;
  onError: (message: string) => void;
}

/** URL deep-link parsing/application plus the share-link clipboard action. */
export function useDeepLink({
  authReady,
  currentProjectId,
  selectedDatasetId,
  datasets,
  pipelines,
  restorePipeline,
  selectDataset,
  onError,
}: Options) {
  const [shareCopied, setShareCopied] = useState(false);
  const deepLink = useMemo(() => {
    const query = new URLSearchParams(window.location.search);
    return {
      projectId: query.get("project"),
      datasetId: query.get("dataset"),
      pipelineId: query.get("pipeline"),
    };
    // The URL only carries a deep link on initial load; re-parse once auth settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady]);
  const deepLinkAppliedRef = useRef(false);

  // Apply the dataset/pipeline part once the project's data has loaded.
  useEffect(() => {
    if (
      deepLinkAppliedRef.current ||
      !deepLink.projectId ||
      currentProjectId !== deepLink.projectId
    ) return;
    if (deepLink.pipelineId) {
      const pipeline = pipelines.find((item) => item.id === deepLink.pipelineId);
      if (!pipeline) return;
      deepLinkAppliedRef.current = true;
      void restorePipeline(pipeline);
      return;
    }
    if (deepLink.datasetId && datasets.some((item) => item.id === deepLink.datasetId)) {
      deepLinkAppliedRef.current = true;
      void selectDataset(deepLink.datasetId);
    }
  }, [currentProjectId, datasets, pipelines, deepLink, restorePipeline, selectDataset]);

  const copyShareLink = useCallback(() => {
    const url = new URL(window.location.origin + window.location.pathname);
    if (currentProjectId) url.searchParams.set("project", currentProjectId);
    if (selectedDatasetId) url.searchParams.set("dataset", selectedDatasetId);
    void navigator.clipboard.writeText(url.toString())
      .then(() => {
        setShareCopied(true);
        window.setTimeout(() => setShareCopied(false), 2000);
      })
      .catch((e) => onError(String(e)));
  }, [currentProjectId, selectedDatasetId, onError]);

  return { deepLink, copyShareLink, shareCopied };
}
