import { useCallback, useMemo, useRef } from "react";

/** A capture of "which project/selection was active when this async work
 * started", with predicates the completion handler checks before touching
 * state. Centralizes the stale-response guards previously copy-pasted at
 * every async call site in App. */
export interface ScopeTicket {
  projectId: string;
  /** The project (and its epoch) is still the active one. */
  stillCurrent(): boolean;
  /** Additionally, no newer dataset selection superseded this work. */
  stillSelected(datasetId: string): boolean;
}

export function useProjectScope() {
  const currentProjectRef = useRef<string | null>(null);
  const projectEpochRef = useRef(0);
  const selectionRequestRef = useRef(0);
  const selectedDatasetRef = useRef<string | null>(null);

  const capture = useCallback((): ScopeTicket | null => {
    const projectId = currentProjectRef.current;
    if (!projectId) return null;
    const epoch = projectEpochRef.current;
    const selectionRequest = selectionRequestRef.current;
    return {
      projectId,
      stillCurrent: () =>
        currentProjectRef.current === projectId && projectEpochRef.current === epoch,
      stillSelected: (datasetId: string) =>
        currentProjectRef.current === projectId &&
        projectEpochRef.current === epoch &&
        selectionRequestRef.current === selectionRequest &&
        selectedDatasetRef.current === datasetId,
    };
  }, []);

  /** Invalidate every outstanding ticket; called when switching projects. */
  const beginProjectSwitch = useCallback((projectId: string) => {
    projectEpochRef.current += 1;
    selectionRequestRef.current += 1;
    selectedDatasetRef.current = null;
    currentProjectRef.current = projectId;
  }, []);

  /** Start a new dataset selection; outstanding selection work becomes stale. */
  const beginSelection = useCallback((datasetId: string | null) => {
    selectionRequestRef.current += 1;
    selectedDatasetRef.current = datasetId;
    return selectionRequestRef.current;
  }, []);

  // A stable identity is load-bearing: consumers put this object in effect
  // dependency arrays, and a per-render identity would re-run those effects
  // (and their fetches) after every render.
  return useMemo(
    () => ({
      currentProjectRef,
      projectEpochRef,
      selectionRequestRef,
      selectedDatasetRef,
      capture,
      beginProjectSwitch,
      beginSelection,
    }),
    [capture, beginProjectSwitch, beginSelection],
  );
}

export type ProjectScope = ReturnType<typeof useProjectScope>;
