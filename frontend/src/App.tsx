import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type {
  Dataset,
  Project,
  ProjectRole,
  ScalarSelection,
  ServerCapabilities,
} from "./types";
import { DatasetPanel } from "./components/DatasetPanel";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { VtkViewer } from "./components/VtkViewer";
import type { VtkViewerHandle } from "./components/VtkViewer";
import { RemoteViewer } from "./components/RemoteViewer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { clampSliceIndex } from "./lib/viewState";
import { sliceRangeFor, wholeExtentFor, SLICE_EXTENT_OFFSET } from "./lib/slice";
import { initializeOidc, login, logout } from "./oidc";
import { detectBrowserCapabilities } from "./lib/capabilities";
import { defaultImageScalar } from "./lib/imageData";
import type { Language, ThemeMode } from "./i18n";
import { MessagesProvider, useMessages } from "./i18n-context";
import { useProjectScope } from "./hooks/useProjectScope";
import { useDisplayState } from "./hooks/useDisplayState";
import { useJobPolling } from "./hooks/useJobPolling";
import { useProjectResources } from "./hooks/useProjectResources";
import { useRemoteSession } from "./hooks/useRemoteSession";
import { useDatasetJobs } from "./hooks/useDatasetJobs";
import { usePipelineActions } from "./hooks/usePipelineActions";
import { useDeepLink } from "./hooks/useDeepLink";
import { useDatasetUpload } from "./hooks/useDatasetUpload";

const readStoredLanguage = (): Language => {
  const value = window.localStorage.getItem("pvweb-language");
  return value === "en" ? "en" : "ja";
};

const readStoredTheme = (): ThemeMode => {
  const value = window.localStorage.getItem("pvweb-theme");
  if (value === "light" || value === "dark") return value;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
};

export function App() {
  const [language, setLanguage] = useState<Language>(readStoredLanguage);
  const [theme, setTheme] = useState<ThemeMode>(readStoredTheme);
  return (
    <MessagesProvider language={language}>
      <AppBody
        language={language}
        onLanguage={setLanguage}
        theme={theme}
        onTheme={setTheme}
      />
    </MessagesProvider>
  );
}

interface AppBodyProps {
  language: Language;
  onLanguage: (language: Language) => void;
  theme: ThemeMode;
  onTheme: (theme: ThemeMode) => void;
}

function AppBody({ language, onLanguage, theme, onTheme }: AppBodyProps) {
  const t = useMessages();
  const [manualOpen, setManualOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [clientExportPending, setClientExportPending] = useState(false);
  const [viewerLoadedUrl, setViewerLoadedUrl] = useState<string | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const viewerRef = useRef<VtkViewerHandle | null>(null);
  const [authState, setAuthState] = useState({
    ready: false,
    configured: false,
    authenticated: false,
  });
  const [serverCapabilities, setServerCapabilities] = useState<ServerCapabilities | null>(null);
  const browserCapabilities = useMemo(() => detectBrowserCapabilities(), []);
  const display = useDisplayState();
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

  const [backgroundChoice, setBackgroundChoice] =
    useState<"theme" | "black" | "gray" | "white">("theme");
  const viewerBackground = useMemo<[number, number, number]>(() => {
    if (backgroundChoice === "black") return [0.02, 0.02, 0.04];
    if (backgroundChoice === "gray") return [0.5, 0.5, 0.52];
    if (backgroundChoice === "white") return [1, 1, 1];
    return theme === "dark" ? [0.09, 0.11, 0.15] : [0.96, 0.97, 0.99];
  }, [backgroundChoice, theme]);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("pvweb-language", language);
    window.localStorage.setItem("pvweb-theme", theme);
  }, [language, theme]);

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

  useEffect(() => {
    void api.capabilities().then(setServerCapabilities).catch(() => setServerCapabilities(null));
  }, []);

  const switchProject = useCallback((projectId: string) => {
    scope.beginProjectSwitch(projectId);
    clearProjectResources();
    setJobs([]);
    setSelectedDatasetId(null);
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

  const createProject = useCallback((name: string) => {
    const ticket = scope.capture();
    return guard(async () => {
      const project = await api.createProject(name);
      setProjects((previous) => [project, ...previous]);
      // Only auto-switch when the user did not change projects meanwhile.
      if (ticket ? ticket.stillCurrent() : scope.currentProjectRef.current === null) {
        switchProject(project.id);
      }
    });
  }, [scope, guard, switchProject]);

  /** Select a dataset and wipe per-dataset display state. */
  const selectDataset = useCallback(async (id: string): Promise<Dataset | null> => {
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

  const selectedDataset = useMemo(
    () => datasets.find((d) => d.id === selectedDatasetId) ?? null,
    [datasets, selectedDatasetId],
  );

  const {
    savePipeline, restorePipeline, deletePipeline, renamePipeline, runPipeline,
  } = usePipelineActions({
    scope,
    display,
    selectedDataset,
    selectDataset,
    setPipelines,
    trackJob,
    onError: pushError,
    unreadableText: t.errors.savedPipelineUnreadable,
  });

  const { deepLink, copyShareLink, shareCopied } = useDeepLink({
    authReady: authState.ready,
    currentProjectId,
    selectedDatasetId,
    datasets,
    pipelines,
    restorePipeline,
    selectDataset,
    onError: pushError,
  });

  // ---- initial project list (and deep-linked project auto-switch)
  useEffect(() => {
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
  }, [guard, authState, deepLink, switchProject, scope]);

  const onGeometryExported = useCallback((blob: Blob, datasetId: string | null) => {
    if (!datasetId) {
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
    if (!datasetId) return;
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
  const viewerUrl = selectedDataset && selectedDataset.status === "ready"
    ? selectedDataset.dataset_type === "Collection"
      ? selectedDataset.extra?.bundle_complete === false
        ? null
        : api.timestepUrl(selectedDataset.id, display.timestepIndex)
      : api.downloadUrl(selectedDataset.id)
    : null;
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

  // ---- PVD playback loop. Depends on the specific values it reads, not the
  // whole display object, so unrelated renders cannot keep resetting the timer.
  const { playing, setPlaying, setTimestepIndex } = display;
  useEffect(() => {
    if (
      !playing ||
      selectedDataset?.dataset_type !== "Collection" ||
      !viewerUrl ||
      viewerLoadedUrl !== viewerUrl
    ) return;
    const count = selectedDataset.timesteps?.length ?? 0;
    if (count < 2) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(
      () => setTimestepIndex((index) => (index + 1) % count),
      800,
    );
    return () => window.clearTimeout(timer);
  }, [playing, setPlaying, setTimestepIndex, selectedDataset, viewerUrl, viewerLoadedUrl]);

  useEffect(() => {
    const maximum = Math.max(0, (selectedDataset?.timesteps?.length ?? 1) - 1);
    display.setTimestepIndex((index) => Math.min(index, maximum));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDataset?.id, selectedDataset?.timesteps?.length]);

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

  const onTimestepIndex = useCallback((index: number) => {
    display.setPlaying(false);
    display.setTimestepIndex(index);
  }, [display]);

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

  const onLoadComplete = useCallback(() => setViewerLoadedUrl(viewerUrl), [viewerUrl]);
  const onScreenshot = useCallback(() => viewerRef.current?.screenshot(), []);
  const onResetCamera = useCallback(() => viewerRef.current?.resetCamera(), []);

  // ---- grouped props for the memoized PropertiesPanel
  const viewControls = useMemo(() => ({
    dataColorRange: availableColorRange,
    sliceIndex: clampedSliceIndex,
    sliceMin,
    sliceMax,
    onSliceAxis,
    onTimestepIndex,
    onScreenshot,
    onResetCamera,
  }), [
    availableColorRange, clampedSliceIndex, sliceMin, sliceMax,
    onSliceAxis, onTimestepIndex, onScreenshot, onResetCamera,
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
    filterPending,
    serverFilterAvailable,
    onRunFilter: runServerFilter,
    onJobCreated: onAssistJobCreated,
    onDownloadTimestep: downloadTimestep,
  }), [
    exportDataset, exportPending, convertDataset, convertPending,
    runStats, statsPending, promoteArtifact, promotePendingIds,
    clientExport, clientExportPending, filterPending, serverFilterAvailable,
    runServerFilter, onAssistJobCreated, downloadTimestep,
  ]);

  const remoteControls = useMemo(() => ({
    available: !!serverCapabilities?.trame_sessions,
    session: remoteSession,
    pending: remotePending,
    onStart: startRemote,
    onStop: stopRemote,
  }), [serverCapabilities?.trame_sessions, remoteSession, remotePending, startRemote, stopRemote]);

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
        <div className="mode-controls" aria-label={t.common.displaySettings}>
          <div className="segmented">
            <button aria-pressed={theme === "light"} onClick={() => onTheme("light")}>
              {t.common.light}
            </button>
            <button aria-pressed={theme === "dark"} onClick={() => onTheme("dark")}>
              {t.common.dark}
            </button>
          </div>
          <div className="segmented">
            <button aria-pressed={language === "ja"} onClick={() => onLanguage("ja")}>
              {t.common.japanese}
            </button>
            <button aria-pressed={language === "en"} onClick={() => onLanguage("en")}>
              {t.common.english}
            </button>
          </div>
          <select
            aria-label={t.properties.background}
            value={backgroundChoice}
            onChange={(event) =>
              setBackgroundChoice(event.target.value as typeof backgroundChoice)
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
          <button onClick={copyShareLink} disabled={!currentProjectId}>
            {shareCopied ? t.common.copied : t.common.copyLink}
          </button>
          <button onClick={() => setManualOpen(true)}>{t.common.manual}</button>
        </div>
        <div className="panel-toggles">
          <button
            aria-pressed={leftCollapsed}
            onClick={() => setLeftCollapsed((value) => !value)}
          >
            {t.datasetPanel.datasets}
          </button>
          <button
            aria-pressed={rightCollapsed}
            onClick={() => setRightCollapsed((value) => !value)}
          >
            {t.properties.title}
          </button>
        </div>
        {errors.map((message, index) => (
          <span key={`${index}-${message}`} className="error-banner">
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
        className={`workspace${leftCollapsed ? " left-collapsed" : ""}${
          rightCollapsed ? " right-collapsed" : ""
        }`}
      >
        {manualOpen && (
          <div
            className="manual-backdrop"
            role="presentation"
            onClick={() => setManualOpen(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setManualOpen(false);
            }}
          >
            <section
              className="manual-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="manual-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="manual-header">
                <h2 id="manual-title">{t.manual.title}</h2>
                {/* autoFocus moves focus into the dialog so Escape works immediately */}
                <button autoFocus onClick={() => setManualOpen(false)}>{t.common.close}</button>
              </div>
              <p>{t.manual.intro}</p>
              <ol>
                {t.manual.steps.map((step) => <li key={step}>{step}</li>)}
              </ol>
              <p className="muted">{t.manual.publicNote}</p>
            </section>
          </div>
        )}
        <DatasetPanel
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
          onUploadFiles={(files) => void upload(files)}
          busy={busy}
          jobs={jobs}
          cancelingJobIds={cancelingJobIds}
          onCancelJob={cancelJob}
          pipelines={pipelines}
          canSavePipeline={!!selectedDataset}
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
              <VtkViewer
                ref={viewerRef}
                datasetId={selectedDataset?.id ?? null}
                url={viewerUrl}
                datasetType={viewerDatasetType}
                emptyMessage={viewerEmptyMessage}
                representation={display.representation}
                colorBy={display.colorBy}
                colorRange={activeColorRange}
                opacity={display.opacity}
                colorMap={display.colorMap}
                legendVisible={display.legendVisible}
                axesVisible={display.axesVisible}
                tableCoordinates={display.tableCoordinates}
                imageMode={display.imageMode}
                sliceAxis={display.sliceAxis}
                sliceIndex={clampedSliceIndex}
                volumeOpacityPoints={display.volumeOpacityPoints}
                cameraState={display.cameraState}
                onCameraChange={display.setCameraState}
                onScreenshotCaptured={onScreenshotCaptured}
                onGeometryExported={onGeometryExported}
                onColorRangeResolved={onColorRangeResolved}
                onLoadComplete={onLoadComplete}
                viewerBackground={viewerBackground}
              />
            )}
          </ErrorBoundary>
        </main>

        <PropertiesPanel
          dataset={selectedDataset}
          display={display}
          view={viewControls}
          jobs={jobControls}
          remote={remoteControls}
          artifacts={artifacts}
          onError={pushError}
        />
      </div>
    </div>
  );
}
