import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type {
  CameraState,
  Dataset,
  Project,
  ProjectRole,
  ScalarSelection,
} from "./types";
import { DatasetPanel } from "./components/DatasetPanel";
import { PropertiesPanel } from "./components/PropertiesPanel";
import type { VtkViewerHandle } from "./components/VtkViewer";
import { ComparisonViewport } from "./components/ComparisonViewport";
import { RemoteViewer } from "./components/RemoteViewer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ManualDialog } from "./components/ManualDialog";
import { clampSliceIndex } from "./lib/viewState";
import { sliceRangeFor, wholeExtentFor, SLICE_EXTENT_OFFSET } from "./lib/slice";
import { initializeOidc, login, logout } from "./oidc";
import { detectBrowserCapabilities } from "./lib/capabilities";
import { defaultImageScalar } from "./lib/imageData";
import { viewerUrlFor } from "./lib/datasetUrl";
import { isLocalDataset, isLocalDatasetId, type SceneSummary } from "./lib/localDataset";
import { triggerBlobDownload } from "./lib/download";
import type { Language, ThemeMode } from "./i18n";
import { MessagesProvider, useMessages } from "./i18n-context";
import { useProjectScope } from "./hooks/useProjectScope";
import { useDisplayState } from "./hooks/useDisplayState";
import { useDisplayHistoryShortcuts } from "./hooks/useDisplayHistoryShortcuts";
import { useJobPolling } from "./hooks/useJobPolling";
import { useProjectResources } from "./hooks/useProjectResources";
import { useRemoteSession } from "./hooks/useRemoteSession";
import { useDatasetJobs } from "./hooks/useDatasetJobs";
import { usePipelineActions } from "./hooks/usePipelineActions";
import { useDeepLink } from "./hooks/useDeepLink";
import { useDatasetUpload } from "./hooks/useDatasetUpload";
import { useTimestepPlayback, type ViewerLoadState } from "./hooks/useTimestepPlayback";
import { useServerConnection } from "./hooks/useServerConnection";
import { useLocalDatasets } from "./hooks/useLocalDatasets";
import { useLayoutPreferences } from "./hooks/useLayoutPreferences";

const LANGUAGE_STORAGE_KEY = "pvweb-language";
const THEME_STORAGE_KEY = "pvweb-theme";

const readStoredLanguage = (): Language => {
  const value = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return value === "en" ? "en" : "ja";
};

const systemTheme = (): ThemeMode =>
  window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";

const readStoredTheme = (): ThemeMode => {
  const value = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (value === "light" || value === "dark") return value;
  return systemTheme();
};

const hasStoredTheme = (): boolean => {
  const value = window.localStorage.getItem(THEME_STORAGE_KEY);
  return value === "light" || value === "dark";
};

export function App() {
  const [language, setLanguage] = useState<Language>(readStoredLanguage);
  const [theme, setThemeState] = useState<ThemeMode>(readStoredTheme);
  // Only an explicit choice is persisted; otherwise the theme keeps
  // following the system preference on later visits.
  const [themeExplicit, setThemeExplicit] = useState(hasStoredTheme);
  const setTheme = useCallback((next: ThemeMode) => {
    setThemeExplicit(true);
    setThemeState(next);
  }, []);
  const resetAppearance = useCallback(() => {
    setLanguage("ja");
    setThemeExplicit(false);
    setThemeState(systemTheme());
  }, []);
  return (
    <MessagesProvider language={language}>
      <AppBody
        language={language}
        onLanguage={setLanguage}
        theme={theme}
        themeExplicit={themeExplicit}
        onTheme={setTheme}
        onResetAppearance={resetAppearance}
      />
    </MessagesProvider>
  );
}

interface AppBodyProps {
  language: Language;
  onLanguage: (language: Language) => void;
  theme: ThemeMode;
  themeExplicit: boolean;
  onTheme: (theme: ThemeMode) => void;
  onResetAppearance: () => void;
}

function AppBody({
  language, onLanguage, theme, themeExplicit, onTheme, onResetAppearance,
}: AppBodyProps) {
  const t = useMessages();
  const [manualOpen, setManualOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [clientExportPending, setClientExportPending] = useState(false);
  const [comparisonEnabled, setComparisonEnabled] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [viewerLoadState, setViewerLoadState] = useState<ViewerLoadState | null>(null);
  const viewerRef = useRef<VtkViewerHandle | null>(null);
  const [authState, setAuthState] = useState({
    ready: false,
    configured: false,
    authenticated: false,
  });
  const browserCapabilities = useMemo(() => detectBrowserCapabilities(), []);
  const connection = useServerConnection();
  const serverCapabilities = connection.capabilities;
  const connected = connection.status === "connected";
  const layout = useLayoutPreferences();
  const display = useDisplayState();
  useDisplayHistoryShortcuts({
    canUndo: display.canUndo,
    canRedo: display.canRedo,
    undo: display.undo,
    redo: display.redo,
  });
  const scope = useProjectScope();

  // ---- error banners: multiple concurrent failures no longer clobber each other
  const pushError = useCallback((message: string) => {
    setErrors((previous) =>
      previous.includes(message) ? previous : [...previous.slice(-2), message],
    );
  }, []);
  const clearErrorsByPrefix = useCallback((prefix: string) => {
    setErrors((previous) => {
      const next = previous.filter((entry) => !entry.startsWith(`${prefix}:`));
      return next.length === previous.length ? previous : next;
    });
  }, []);
  const clearErrors = useCallback(() => setErrors([]), []);
  const dismissError = useCallback((index: number) => {
    setErrors((previous) => previous.filter((_, position) => position !== index));
  }, []);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    try {
      clearErrors();
      await fn();
    } catch (e) {
      pushError(String(e));
    }
  }, [clearErrors, pushError]);

  const errorPrefixes = useMemo(() => ({
    dataset: t.errors.datasetUpdate,
    pipeline: t.errors.pipelineUpdate,
    member: t.errors.memberUpdate,
    artifact: t.errors.artifactUpdate,
  }), [t]);

  const resources = useProjectResources({
    scope,
    prefixes: errorPrefixes,
    onError: pushError,
    onErrorCleared: clearErrorsByPrefix,
  });
  const {
    datasets, setDatasets, pipelines, setPipelines, membership, members,
    artifacts, setArtifacts,
    refreshDatasets, refreshPipelines, refreshMembership, refreshArtifacts,
    clearProjectResources,
  } = resources;

  const { jobs, setJobs, cancelingJobIds, upsertJob, cancelJob } = useJobPolling({
    currentProjectId,
    scope,
    jobErrorPrefix: t.errors.jobUpdate,
    onError: pushError,
    onErrorCleared: clearErrorsByPrefix,
  });

  const {
    remoteSession, remotePending, startRemote, stopRemote,
    clearOnProjectSwitch: clearRemoteOnProjectSwitch,
    stopIfDatasetChanged: stopRemoteIfDatasetChanged,
  } = useRemoteSession({ scope, onError: pushError });

  const {
    trackJob,
    exportDataset, exportPending,
    convertDataset, convertPending,
    runStats, statsPending,
    exportMovie, moviePending,
    runServerFilter, filterPending,
    onAssistJobCreated, promoteArtifact, promotePendingIds,
    downloadTimestep, resetPending,
  } = useDatasetJobs({
    scope,
    upsertJob,
    refreshArtifacts,
    refreshDatasets,
    clearErrors,
    onError: pushError,
    metadataFailedText: t.errors.metadataFailed,
  });

  const { upload, busy, clearBusy } = useDatasetUpload({
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
    onError: pushError,
  });

  const {
    localDatasets, loadingLabel: localLoadingLabel, openFiles: openLocalFiles,
    openSample, removeLocal, applySummary, fileFor: localFileFor,
  } = useLocalDatasets({ t, onError: pushError });

  const viewerBackground = useMemo<[number, number, number]>(() => {
    if (layout.backgroundChoice === "black") return [0.02, 0.02, 0.04];
    if (layout.backgroundChoice === "gray") return [0.5, 0.5, 0.52];
    if (layout.backgroundChoice === "white") return [1, 1, 1];
    return theme === "dark" ? [0.09, 0.11, 0.15] : [0.96, 0.97, 0.99];
  }, [layout.backgroundChoice, theme]);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    if (themeExplicit) window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    else window.localStorage.removeItem(THEME_STORAGE_KEY);
  }, [language, theme, themeExplicit]);

  useEffect(() => {
    let disposed = false;
    void initializeOidc()
      .then((state) => {
        if (!disposed) setAuthState({ ready: true, ...state });
      })
      .catch((reason) => {
        if (!disposed) {
          setAuthState({ ready: true, configured: true, authenticated: false });
          pushError(`${t.auth.oidcErrorPrefix}: ${String(reason)}`);
        }
      });
    return () => { disposed = true; };
    // Runs once; auth strings are stable for the app session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchProject = useCallback((projectId: string) => {
    scope.beginProjectSwitch(projectId);
    clearProjectResources();
    setJobs([]);
    setSelectedDatasetId(null);
    setComparisonEnabled(false);
    clearRemoteOnProjectSwitch();
    display.reset();
    resetPending();
    setClientExportPending(false);
    clearBusy();
    clearErrors();
    setCurrentProjectId(projectId);
  }, [
    scope, clearProjectResources, setJobs, display, clearErrors,
    clearRemoteOnProjectSwitch, resetPending, clearBusy,
  ]);

  useEffect(() => {
    scope.currentProjectRef.current = currentProjectId;
    if (!currentProjectId) {
      clearProjectResources();
      setJobs([]);
      return;
    }
    void refreshDatasets(currentProjectId);
    void refreshPipelines(currentProjectId);
    void refreshMembership(currentProjectId);
  }, [
    currentProjectId, scope, clearProjectResources, setJobs,
    refreshDatasets, refreshPipelines, refreshMembership,
  ]);

  // Losing the server drops every server-scoped resource; local datasets stay.
  useEffect(() => {
    if (connected) return;
    setProjects([]);
    if (scope.currentProjectRef.current !== null) {
      scope.beginProjectSwitch("");
      scope.currentProjectRef.current = null;
    }
    setCurrentProjectId(null);
    setSelectedDatasetId((current) => (isLocalDatasetId(current) ? current : null));
    clearRemoteOnProjectSwitch();
  }, [connected, scope, clearRemoteOnProjectSwitch]);

  const createProject = useCallback(async (name: string): Promise<boolean> => {
    const ticket = scope.capture();
    clearErrors();
    try {
      const project = await api.createProject(name);
      setProjects((previous) => [project, ...previous]);
      // Only auto-switch when the user did not change projects meanwhile.
      if (ticket ? ticket.stillCurrent() : scope.currentProjectRef.current === null) {
        switchProject(project.id);
      }
      return true;
    } catch (e) {
      pushError(String(e));
      return false;
    }
  }, [scope, clearErrors, pushError, switchProject]);

  const localDatasetsRef = useRef(localDatasets);
  localDatasetsRef.current = localDatasets;

  /** Select a dataset and wipe per-dataset display state. */
  const selectDataset = useCallback(async (id: string): Promise<Dataset | null> => {
    if (isLocalDatasetId(id)) {
      const local = localDatasetsRef.current.find((dataset) => dataset.id === id) ?? null;
      if (!local) return null;
      scope.beginSelection(id);
      clearErrors();
      setSelectedDatasetId(id);
      stopRemoteIfDatasetChanged(id);
      display.reset();
      setArtifacts([]);
      return local;
    }
    const ticket = scope.capture();
    if (!ticket) return null;
    const request = scope.selectionRequestRef.current + 1;
    scope.selectionRequestRef.current = request;
    clearErrors();
    try {
      const ds = await api.getDataset(id);
      if (
        !ticket.stillCurrent() ||
        scope.selectionRequestRef.current !== request ||
        ds.project_id !== ticket.projectId
      ) return null;
      setSelectedDatasetId(id);
      scope.selectedDatasetRef.current = id;
      stopRemoteIfDatasetChanged(id);
      display.reset();
      setArtifacts([]);
      setDatasets((previous) => previous.map((d) => (d.id === id ? ds : d)));
      void refreshArtifacts(id);
      return ds;
    } catch (e) {
      if (ticket.stillCurrent() && scope.selectionRequestRef.current === request) {
        pushError(String(e));
      }
      return null;
    }
  }, [
    scope, clearErrors, display, setArtifacts, setDatasets, refreshArtifacts,
    pushError, stopRemoteIfDatasetChanged,
  ]);

  const openLocal = useCallback(async (files: File[]) => {
    const dataset = await openLocalFiles(files);
    if (dataset) {
      localDatasetsRef.current = [dataset, ...localDatasetsRef.current];
      void selectDataset(dataset.id);
    }
  }, [openLocalFiles, selectDataset]);

  const openLocalSample = useCallback(async (sampleId: string) => {
    const dataset = await openSample(sampleId);
    if (dataset) {
      localDatasetsRef.current = [dataset, ...localDatasetsRef.current];
      void selectDataset(dataset.id);
    }
  }, [openSample, selectDataset]);

  const removeLocalDataset = useCallback((id: string) => {
    removeLocal(id);
    setSelectedDatasetId((current) => (current === id ? null : current));
  }, [removeLocal]);

  const updateDatasetTags = useCallback(async (
    datasetId: string,
    tags: string[],
  ): Promise<Dataset | null> => {
    const ticket = scope.capture();
    if (!ticket) return null;
    clearErrors();
    try {
      const updated = await api.updateDatasetTags(datasetId, tags);
      if (!ticket.stillCurrent() || updated.project_id !== ticket.projectId) return null;
      setDatasets((previous) => previous.map(
        (dataset) => (dataset.id === updated.id ? updated : dataset),
      ));
      return updated;
    } catch (reason) {
      if (ticket.stillCurrent()) pushError(String(reason));
      return null;
    }
  }, [scope, clearErrors, setDatasets, pushError]);

  // Server datasets are only usable while connected. Hiding them as soon as
  // the connection drops (or switches to another server) keeps render-time
  // URL builders from targeting a missing or different API base.
  const allDatasets = useMemo(
    () => (connected ? [...localDatasets, ...datasets] : localDatasets),
    [connected, localDatasets, datasets],
  );
  const selectedDataset = useMemo(
    () => allDatasets.find((d) => d.id === selectedDatasetId) ?? null,
    [allDatasets, selectedDatasetId],
  );
  const selectedIsLocal = isLocalDataset(selectedDataset);

  const {
    savePipeline, restorePipeline, deletePipeline, renamePipeline, runPipeline,
  } = usePipelineActions({
    scope,
    display,
    selectedDataset: selectedIsLocal ? null : selectedDataset,
    selectDataset,
    setPipelines,
    trackJob,
    onError: pushError,
    unreadableText: t.errors.savedPipelineUnreadable,
  });

  const { deepLink, copyShareLink, shareCopied } = useDeepLink({
    authReady: authState.ready,
    currentProjectId,
    selectedDatasetId: selectedIsLocal ? null : selectedDatasetId,
    datasets,
    pipelines,
    restorePipeline,
    selectDataset,
    onError: pushError,
  });

  // ---- project list once a server connection exists (and deep-linked auto-switch)
  useEffect(() => {
    if (!connected) return;
    if (!authState.ready || (authState.configured && !authState.authenticated)) return;
    void guard(async () => {
      const next = await api.listProjects();
      setProjects(next);
      if (
        deepLink.projectId &&
        scope.currentProjectRef.current !== deepLink.projectId &&
        next.some((project) => project.id === deepLink.projectId)
      ) {
        switchProject(deepLink.projectId);
      }
    });
  }, [connected, connection.epoch, guard, authState, deepLink, switchProject, scope]);

  const onGeometryExported = useCallback((blob: Blob, datasetId: string | null) => {
    if (!datasetId || isLocalDatasetId(datasetId)) {
      setClientExportPending(false);
      return;
    }
    const ticket = scope.capture();
    void api.uploadArtifact(datasetId, "client_export", blob)
      .then((artifact) => {
        if (ticket?.stillSelected(datasetId)) {
          setArtifacts((previous) => [artifact, ...previous]);
        }
      })
      .catch((e) => {
        if (ticket?.stillCurrent()) pushError(String(e));
      })
      .finally(() => setClientExportPending(false));
  }, [scope, setArtifacts, pushError]);

  const clientExport = useCallback(() => {
    if (clientExportPending) return;
    setClientExportPending(true);
    // The handle reports synchronously whether an exportable geometry scene
    // exists, so no timeout race is needed to release the pending flag.
    const started = viewerRef.current?.exportGeometry() ?? false;
    if (!started) setClientExportPending(false);
  }, [clientExportPending]);

  const putMember = useCallback((userId: string, role: ProjectRole) => {
    const ticket = scope.capture();
    if (!ticket) return;
    void api.putMember(ticket.projectId, userId, role)
      .then(() => {
        if (ticket.stillCurrent()) void refreshMembership(ticket.projectId);
      })
      .catch((reason) => {
        if (ticket.stillCurrent()) pushError(String(reason));
      });
  }, [scope, refreshMembership, pushError]);

  const deleteMember = useCallback((userId: string) => {
    const ticket = scope.capture();
    if (!ticket) return;
    void api.deleteMember(ticket.projectId, userId)
      .then(() => {
        if (ticket.stillCurrent()) void refreshMembership(ticket.projectId);
      })
      .catch((reason) => {
        if (ticket.stillCurrent()) pushError(String(reason));
      });
  }, [scope, refreshMembership, pushError]);

  const onScreenshotCaptured = useCallback((blob: Blob, datasetId: string | null) => {
    if (!datasetId || isLocalDatasetId(datasetId)) return;
    const ticket = scope.capture();
    void api.uploadArtifact(datasetId, "screenshot", blob)
      .then((artifact) => {
        if (ticket?.stillSelected(datasetId)) {
          setArtifacts((previous) => [artifact, ...previous]);
        }
      })
      .catch((e) => {
        if (ticket?.stillCurrent()) pushError(String(e));
      });
  }, [scope, setArtifacts, pushError]);

  const onSceneSummary = useCallback((datasetId: string | null, summary: SceneSummary) => {
    if (datasetId && isLocalDatasetId(datasetId)) applySummary(datasetId, summary);
  }, [applySummary]);

  // ---- derived view values
  const colorRange = useMemo<[number, number] | null>(() => {
    if (!selectedDataset || !display.colorBy) return null;
    const arr = (selectedDataset.arrays ?? []).find(
      (a) =>
        a.name === display.colorBy?.name &&
        (a.association === display.colorBy?.association ||
          (selectedDataset.dataset_type === "Table" &&
            display.colorBy?.association === "point" &&
            a.association === "table")),
    );
    return arr?.value_range ?? null;
  }, [selectedDataset, display.colorBy]);

  // CSV rows with invalid coordinates are omitted by the viewer, so its
  // post-filter range is authoritative rather than the all-row metadata range.
  const availableColorRange = selectedDataset?.dataset_type === "Table"
    ? display.runtimeColorRange
    : colorRange ?? display.runtimeColorRange;
  const activeColorRange =
    display.customColorRange && display.customColorRange[0] < display.customColorRange[1]
      ? display.customColorRange
      : availableColorRange;

  const collectionInnerType = selectedDataset?.dataset_type === "Collection"
    ? String(selectedDataset.extra?.inner_type ?? "")
    : null;
  const viewerDatasetType = collectionInnerType || selectedDataset?.dataset_type;
  const viewerUrl = viewerUrlFor(selectedDataset, display.timestepIndex);
  const viewerEmptyMessage = selectedDataset?.dataset_type === "Collection" &&
    selectedDataset.extra?.bundle_complete === false
    ? t.appMessages.incompletePvd
    : undefined;

  // ---- table/image defaults when a dataset arrives
  useEffect(() => {
    if (!selectedDataset) return;
    if (selectedDataset.dataset_type === "Table" && !display.tableCoordinates) {
      const numeric = (selectedDataset.arrays ?? [])
        .filter((array) => array.association === "table" && array.data_type === "numeric")
        .map((array) => array.name);
      const pick = (axis: string, fallback: number) =>
        numeric.find((name) => name.toLowerCase() === axis) ?? numeric[fallback] ?? "";
      const inferred = { x: pick("x", 0), y: pick("y", 1), z: pick("z", 2) };
      if (new Set(Object.values(inferred)).size === 3 && Object.values(inferred).every(Boolean)) {
        display.setTableCoordinates(inferred);
        display.setRepresentation("points");
      }
    }
    if (viewerDatasetType === "ImageData" && !display.colorBy) {
      const scalar = defaultImageScalar(selectedDataset.arrays ?? []);
      if (scalar) display.setColorByState(scalar);
    }
  }, [selectedDataset, display, viewerDatasetType]);

  const playback = useTimestepPlayback({
    datasetId: selectedDataset?.id ?? null,
    enabled: selectedDataset?.dataset_type === "Collection" && !remoteSession,
    timestepCount: selectedDataset?.timesteps?.length ?? 0,
    timestepIndex: display.timestepIndex,
    viewerUrl,
    playing: display.playing,
    setPlaying: display.setPlaying,
    setTimestepIndex: display.setTimestepIndex,
    setPlaybackTimestep: display.setPlaybackTimestep,
  });
  const playbackLoadStateChange = playback.onLoadStateChange;
  const onLoadStateChange = useCallback((url: string, state: ViewerLoadState) => {
    setViewerLoadState(state);
    playbackLoadStateChange(url, state);
  }, [playbackLoadStateChange]);

  useEffect(() => {
    const maximum = Math.max(0, (selectedDataset?.timesteps?.length ?? 1) - 1);
    display.setTimestepIndex((index) => Math.min(index, maximum));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDataset?.id, selectedDataset?.timesteps?.length]);

  useEffect(() => {
    setViewerLoadState(null);
  }, [selectedDatasetId]);

  const dimensions = (selectedDataset?.extra?.dimensions as number[] | undefined) ?? [1, 1, 1];
  const wholeExtent = wholeExtentFor(
    dimensions,
    selectedDataset?.extra?.whole_extent as number[] | undefined,
  );
  const { min: sliceMin, max: sliceMax } = sliceRangeFor(wholeExtent, display.sliceAxis);
  const clampedSliceIndex = clampSliceIndex(display.sliceIndex, sliceMin, sliceMax);

  useEffect(() => {
    if (display.sliceIndex !== clampedSliceIndex) display.setSliceIndex(clampedSliceIndex);
  }, [display, clampedSliceIndex]);

  const onSliceAxis = useCallback((axis: typeof display.sliceAxis) => {
    display.setSliceAxis(axis);
    display.setSliceIndex(wholeExtent[SLICE_EXTENT_OFFSET[axis]] ?? 0);
    // wholeExtent identity changes per render; the values are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, wholeExtent.join(",")]);

  const onColorRangeResolved = useCallback(
    (selection: ScalarSelection, range: [number, number]) => {
      display.setRuntimeColorRange((previous) => previous);
      if (
        display.colorBy?.name === selection.name &&
        display.colorBy.association === selection.association
      ) {
        display.setRuntimeColorRange(range);
      }
    },
    [display],
  );

  const onScreenshot = useCallback(() => viewerRef.current?.screenshot(), []);
  const onResetCamera = useCallback(() => viewerRef.current?.resetCamera(), []);
  const onApplyCamera = useCallback((camera: CameraState) => {
    display.setCameraState(camera);
  }, [display]);

  const downloadLocalFile = useCallback((index: number) => {
    if (!selectedDataset || !selectedIsLocal) return;
    const file = localFileFor(selectedDataset.id, index);
    if (file) triggerBlobDownload(file, file.name);
  }, [selectedDataset, selectedIsLocal, localFileFor]);
  const onDownloadTimestep = useCallback((index: number) => {
    if (selectedIsLocal) downloadLocalFile(index);
    else downloadTimestep(index);
  }, [selectedIsLocal, downloadLocalFile, downloadTimestep]);
  const onDownloadOriginal = useCallback(() => {
    downloadLocalFile(selectedDataset?.dataset_type === "Collection" ? display.timestepIndex : 0);
  }, [downloadLocalFile, selectedDataset?.dataset_type, display.timestepIndex]);

  // ---- grouped props for the memoized PropertiesPanel
  const viewControls = useMemo(() => ({
    dataColorRange: availableColorRange,
    sliceIndex: clampedSliceIndex,
    sliceMin,
    sliceMax,
    onSliceAxis,
    onTimestepIndex: playback.seek,
    playbackSpeed: playback.speed,
    onPlaybackSpeed: playback.setSpeed,
    playbackLoop: playback.loop,
    onPlaybackLoop: playback.setLoop,
    playbackAvailable: playback.playbackAvailable,
    onTogglePlayback: playback.togglePlayback,
    onScreenshot,
    onResetCamera,
    onApplyCamera,
  }), [
    availableColorRange, clampedSliceIndex, sliceMin, sliceMax,
    onSliceAxis, playback.seek, playback.speed, playback.setSpeed,
    playback.loop, playback.setLoop, playback.playbackAvailable, playback.togglePlayback,
    onScreenshot, onResetCamera, onApplyCamera,
  ]);

  const serverFilterAvailable = serverCapabilities?.paraview_worker ?? false;
  const jobControls = useMemo(() => ({
    onExport: exportDataset,
    exportPending,
    onConvert: convertDataset,
    convertPending,
    onRunStats: runStats,
    statsPending,
    onPromoteArtifact: promoteArtifact,
    promotePendingIds,
    onClientExport: clientExport,
    clientExportPending,
    onMovieExport: exportMovie,
    moviePending,
    filterPending,
    serverFilterAvailable,
    videoExportAvailable: serverCapabilities?.video_export ?? false,
    onRunFilter: runServerFilter,
    onJobCreated: onAssistJobCreated,
    onDownloadTimestep,
  }), [
    exportDataset, exportPending, convertDataset, convertPending,
    runStats, statsPending, promoteArtifact, promotePendingIds,
    clientExport, clientExportPending, exportMovie, moviePending,
    filterPending, serverFilterAvailable, serverCapabilities?.video_export,
    runServerFilter, onAssistJobCreated, onDownloadTimestep,
  ]);

  const remoteControls = useMemo(() => ({
    available: !!serverCapabilities?.trame_sessions,
    session: remoteSession,
    pending: remotePending,
    onStart: startRemote,
    onStop: stopRemote,
  }), [serverCapabilities?.trame_sessions, remoteSession, remotePending, startRemote, stopRemote]);

  const buildDiagnostics = useCallback(() => ({
    app: "MyParaView-Web",
    generated_at: new Date().toISOString(),
    build_mode: import.meta.env?.MODE ?? "unknown",
    connection: {
      mode: connection.mode,
      config_source: connection.config.source,
      api_base: connection.apiBase,
      status: connection.status,
      failure: connection.failure,
      server_capabilities: serverCapabilities,
    },
    browser: {
      user_agent: navigator.userAgent,
      language: navigator.language,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      renderer: browserCapabilities.renderer,
      webgpu: browserCapabilities.webgpu,
      wasm: browserCapabilities.wasm,
    },
    ui: {
      language,
      theme,
      background: layout.backgroundChoice,
      narrow_layout: layout.narrow,
      left_panel_collapsed: layout.leftCollapsed,
      right_panel_collapsed: layout.rightCollapsed,
    },
    selection: selectedDataset ? {
      source: selectedIsLocal ? "browser-local" : "server",
      dataset_type: selectedDataset.dataset_type,
      ext: selectedDataset.ext,
      size_bytes: selectedDataset.size_bytes,
      timestep_index: display.timestepIndex,
      timestep_count: selectedDataset.timesteps?.length ?? 0,
      load_state: viewerLoadState,
      representation: display.representation,
      color_by: display.colorBy,
      color_map: display.colorMap,
    } : null,
    errors,
  }), [
    connection, serverCapabilities, browserCapabilities, language, theme, layout,
    selectedDataset, selectedIsLocal, display.timestepIndex, viewerLoadState,
    display.representation, display.colorBy, display.colorMap, errors,
  ]);

  const resetPreferences = useCallback(() => {
    layout.resetAll();
    window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    onResetAppearance();
  }, [layout, onResetAppearance]);

  const loadStateText = viewerLoadState === "loading"
    ? t.connection.loadStateLoading
    : viewerLoadState === "ready"
      ? t.connection.loadStateReady
      : viewerLoadState === "error"
        ? t.connection.loadStateError
        : null;
  const selectionStatus = selectedDataset
    ? [
      `${t.connection.selectionStatus}: ${selectedDataset.filename}`,
      selectedIsLocal ? t.connection.modeStatic : t.connection.modeServer,
      loadStateText,
      selectedDataset.dataset_type === "Collection"
        ? `${t.connection.timestepLabel} ${display.timestepIndex + 1} / ${selectedDataset.timesteps?.length ?? 0}`
        : null,
    ].filter(Boolean).join(" · ")
    : t.connection.noSelection;

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">◵ {t.common.appName}</span>
        <span className="subtitle">{t.common.subtitle}</span>
        <span className="capability-badge" title={t.capabilities.title}>
          {browserCapabilities.renderer} · {browserCapabilities.webgpu ? t.capabilities.webgpuDetected : t.capabilities.webgpuMissing}
          {` · ${browserCapabilities.wasm ? t.capabilities.wasmAvailable : t.capabilities.wasmMissing}`}
          {serverCapabilities?.paraview_worker ? ` · ${t.capabilities.worker}` : ""}
        </span>
        <div className="auth-controls">
          {!authState.ready ? (
            <span className="muted">{t.auth.checking}</span>
          ) : authState.configured && !authState.authenticated ? (
            <button onClick={() => void login()}>{t.auth.login}</button>
          ) : authState.configured ? (
            <button onClick={() => void logout()}>{t.auth.logout}</button>
          ) : null}
        </div>
        <div className="mode-controls" role="group" aria-label={t.common.displaySettings}>
          <div className="segmented" role="group" aria-label={t.layout.themeGroup}>
            <button aria-pressed={theme === "light"} onClick={() => onTheme("light")}>
              {t.common.light}
            </button>
            <button aria-pressed={theme === "dark"} onClick={() => onTheme("dark")}>
              {t.common.dark}
            </button>
          </div>
          <div className="segmented" role="group" aria-label={t.layout.languageGroup}>
            <button aria-pressed={language === "ja"} onClick={() => onLanguage("ja")}>
              {t.common.japanese}
            </button>
            <button aria-pressed={language === "en"} onClick={() => onLanguage("en")}>
              {t.common.english}
            </button>
          </div>
          <select
            aria-label={t.properties.background}
            value={layout.backgroundChoice}
            onChange={(event) =>
              layout.setBackgroundChoice(event.target.value as typeof layout.backgroundChoice)
            }
          >
            {(Object.keys(t.properties.backgroundNames) as Array<
              keyof typeof t.properties.backgroundNames
            >).map((choice) => (
              <option key={choice} value={choice}>
                {t.properties.backgroundNames[choice]}
              </option>
            ))}
          </select>
          <button
            onClick={copyShareLink}
            disabled={!currentProjectId}
            title={currentProjectId ? undefined : t.connection.projectRequired}
          >
            {shareCopied ? t.common.copied : t.common.copyLink}
          </button>
          <button
            aria-pressed={comparisonEnabled}
            disabled={!selectedDataset || !!remoteSession}
            onClick={() => setComparisonEnabled((value) => !value)}
          >
            {t.viewer.comparisonToggle}
          </button>
          <button onClick={() => setManualOpen(true)}>{t.common.manual}</button>
          <button onClick={resetPreferences} title={t.layout.resetPreferencesHint}>
            {t.layout.resetPreferences}
          </button>
        </div>
        <div className="panel-toggles" role="group" aria-label={t.layout.panelsGroup}>
          <button
            aria-expanded={!layout.leftCollapsed}
            aria-controls="dataset-panel"
            aria-label={`${t.datasetPanel.datasets}: ${layout.leftCollapsed ? t.layout.panelOpen : t.layout.panelClose}`}
            title={`${t.datasetPanel.datasets}: ${layout.leftCollapsed ? t.layout.panelOpen : t.layout.panelClose}`}
            onClick={layout.toggleLeft}
          >
            {t.datasetPanel.datasets}
          </button>
          <button
            aria-expanded={!layout.rightCollapsed}
            aria-controls="properties-panel"
            aria-label={`${t.properties.title}: ${layout.rightCollapsed ? t.layout.panelOpen : t.layout.panelClose}`}
            title={`${t.properties.title}: ${layout.rightCollapsed ? t.layout.panelOpen : t.layout.panelClose}`}
            onClick={layout.toggleRight}
          >
            {t.properties.title}
          </button>
          <button
            onClick={layout.maximizeViewer}
            disabled={layout.leftCollapsed && layout.rightCollapsed}
          >
            {t.layout.maximizeViewer}
          </button>
          <button onClick={layout.resetLayout}>{t.layout.resetLayout}</button>
        </div>
        {errors.map((message, index) => (
          <span key={`${index}-${message}`} className="error-banner" role="alert">
            {message}
            <button
              className="link-button"
              aria-label={t.common.dismiss}
              onClick={() => dismissError(index)}
            >
              ×
            </button>
          </span>
        ))}
      </header>

      <div
        className={`workspace${layout.leftCollapsed ? " left-collapsed" : ""}${
          layout.rightCollapsed ? " right-collapsed" : ""
        }${layout.narrow ? " narrow" : ""}`}
      >
        <ManualDialog open={manualOpen} mode={connection.mode} onClose={() => setManualOpen(false)} />
        <DatasetPanel
          connection={connection}
          buildDiagnostics={buildDiagnostics}
          localDatasets={localDatasets}
          localLoadingLabel={localLoadingLabel}
          onOpenLocalFiles={(files) => void openLocal(files)}
          onOpenSample={(sampleId) => void openLocalSample(sampleId)}
          onRemoveLocalDataset={removeLocalDataset}
          projects={projects}
          currentProjectId={currentProjectId}
          onSelectProject={switchProject}
          onCreateProject={createProject}
          membership={membership}
          members={members}
          onPutMember={putMember}
          onDeleteMember={deleteMember}
          datasets={datasets}
          selectedDatasetId={selectedDatasetId}
          onSelectDataset={(id) => void selectDataset(id)}
          onUpdateDatasetTags={updateDatasetTags}
          onUploadFiles={(files) => void upload(files)}
          busy={busy}
          jobs={jobs}
          cancelingJobIds={cancelingJobIds}
          onCancelJob={cancelJob}
          pipelines={pipelines}
          canSavePipeline={!!selectedDataset && !selectedIsLocal}
          serverRunAvailable={!!serverCapabilities?.paraview_worker}
          onSavePipeline={(name) => void savePipeline(name)}
          onRestorePipeline={(pipeline) => void restorePipeline(pipeline)}
          onDeletePipeline={deletePipeline}
          onRenamePipeline={renamePipeline}
          onRunPipeline={runPipeline}
          onError={pushError}
        />

        <main className="center">
          <ErrorBoundary
            fallbackTitle={t.common.renderCrashTitle}
            fallbackHint={t.common.renderCrashHint}
            resetKey={remoteSession ? `remote:${remoteSession.id}` : selectedDatasetId ?? "none"}
          >
            {remoteSession ? (
              <RemoteViewer session={remoteSession} onError={pushError} />
            ) : (
              <ComparisonViewport
                ref={viewerRef}
                enabled={comparisonEnabled}
                datasets={allDatasets}
                primaryDataset={selectedDataset}
                primaryTimestepIndex={display.timestepIndex}
                primary={{
                  datasetId: selectedDataset?.id ?? null,
                  url: viewerUrl,
                  datasetType: viewerDatasetType,
                  emptyMessage: viewerEmptyMessage,
                  representation: display.representation,
                  displayStyle: display.displayStyle,
                  colorBy: display.colorBy,
                  colorRange: activeColorRange,
                  opacity: display.opacity,
                  colorMap: display.colorMap,
                  legendVisible: display.legendVisible,
                  axesVisible: display.axesVisible,
                  tableCoordinates: display.tableCoordinates,
                  imageMode: display.imageMode,
                  sliceAxis: display.sliceAxis,
                  sliceIndex: clampedSliceIndex,
                  volumeOpacityPoints: display.volumeOpacityPoints,
                  cameraState: display.cameraState,
                  onCameraChange: display.setCameraState,
                  onScreenshotCaptured,
                  onGeometryExported,
                  onColorRangeResolved,
                  onLoadStateChange,
                  onSceneSummary,
                  viewerBackground,
                }}
              />
            )}
          </ErrorBoundary>
          <div
            className="selection-status"
            role="status"
            data-testid="selection-status"
            title={selectionStatus}
          >
            {selectionStatus}
          </div>
        </main>

        <PropertiesPanel
          dataset={selectedDataset}
          display={display}
          view={viewControls}
          jobs={jobControls}
          remote={remoteControls}
          artifacts={artifacts}
          onDownloadOriginal={onDownloadOriginal}
          onError={pushError}
        />
      </div>
    </div>
  );
}
