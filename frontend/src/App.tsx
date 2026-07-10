import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, authorizedFetch, pollJob } from "./api";
import type {
  Dataset,
  Job,
  Pipeline,
  Project,
  ProjectRole,
  RenderSessionCreated,
  ScalarSelection,
  ServerCapabilities,
  ViewState,
  Artifact,
} from "./types";
import { DatasetPanel } from "./components/DatasetPanel";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { VtkViewer } from "./components/VtkViewer";
import { RemoteViewer } from "./components/RemoteViewer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { clampSliceIndex, parseViewState } from "./lib/viewState";
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

const readStoredLanguage = (): Language => {
  const value = window.localStorage.getItem("pvweb-language");
  return value === "en" ? "en" : "ja";
};

const readStoredTheme = (): ThemeMode => {
  const value = window.localStorage.getItem("pvweb-theme");
  if (value === "light" || value === "dark") return value;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
};

const triggerBlobDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
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
  const [exportPending, setExportPending] = useState(false);
  const [convertPending, setConvertPending] = useState(false);
  const [statsPending, setStatsPending] = useState(false);
  const [filterPending, setFilterPending] = useState(false);
  const [clientExportPending, setClientExportPending] = useState(false);
  const [promotePendingIds, setPromotePendingIds] = useState<Set<string>>(() => new Set());
  const [remoteSession, setRemoteSession] = useState<RenderSessionCreated | null>(null);
  const [remotePending, setRemotePending] = useState(false);
  const [viewerLoadedUrl, setViewerLoadedUrl] = useState<string | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [screenshotNonce, setScreenshotNonce] = useState(0);
  const [exportNonce, setExportNonce] = useState(0);
  const [resetNonce, setResetNonce] = useState(0);
  const [shareCopied, setShareCopied] = useState(false);
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

  const [backgroundChoice, setBackgroundChoice] =
    useState<"theme" | "black" | "gray" | "white">("theme");
  const viewerBackground = useMemo<[number, number, number]>(() => {
    if (backgroundChoice === "black") return [0.02, 0.02, 0.04];
    if (backgroundChoice === "gray") return [0.5, 0.5, 0.52];
    if (backgroundChoice === "white") return [1, 1, 1];
    return theme === "dark" ? [0.09, 0.11, 0.15] : [0.96, 0.97, 0.99];
  }, [backgroundChoice, theme]);
  const deepLink = useMemo(() => {
    const query = new URLSearchParams(window.location.search);
    return {
      projectId: query.get("project"),
      datasetId: query.get("dataset"),
      pipelineId: query.get("pipeline"),
    };
    // The URL only carries a deep link on initial load; re-parse once auth settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState.ready]);
  const deepLinkAppliedRef = useRef(false);

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

  const stopRemoteSession = useCallback((session: RenderSessionCreated | null) => {
    if (!session) return;
    void api.deleteSession(session.id).catch(() => {
      // best-effort: expiry cleans up server-side
    });
  }, []);

  const switchProject = useCallback((projectId: string) => {
    scope.beginProjectSwitch(projectId);
    clearProjectResources();
    setJobs([]);
    setSelectedDatasetId(null);
    setRemoteSession((session) => {
      stopRemoteSession(session);
      return null;
    });
    display.reset();
    setExportPending(false);
    setConvertPending(false);
    setStatsPending(false);
    setFilterPending(false);
    setClientExportPending(false);
    setPromotePendingIds(new Set());
    setBusy(null);
    clearErrors();
    setCurrentProjectId(projectId);
  }, [scope, clearProjectResources, setJobs, display, clearErrors, stopRemoteSession]);

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
  }, [scope, clearErrors, display, setArtifacts, setDatasets, refreshArtifacts, pushError]);

  const upload = useCallback(async (files: File[]) => {
    const ticket = scope.capture();
    if (!ticket || files.length === 0) return;
    const pvd = files.find((file) => file.name.toLowerCase().endsWith(".pvd"));
    const externalDescriptor = files.find((file) => /\.(case|xdmf|xmf)$/i.test(file.name));
    const primary = pvd ?? externalDescriptor ?? files[0];
    if (files.length > 1 && !pvd && !externalDescriptor) {
      pushError(t.errors.multiFileDescriptor);
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
      scope.beginSelection(ds.id);
      setSelectedDatasetId(ds.id);
      display.reset();
      setArtifacts([]);
      void refreshArtifacts(ds.id);
      if (final.status !== "succeeded" && ticket.stillCurrent()) {
        const lastLog = (final.log ?? "").split("\n").filter(Boolean).pop() ?? "";
        pushError(`${t.errors.metadataFailed} (${final.status}): ${lastLog}`);
      }
    } catch (e) {
      if (ticket.stillCurrent()) pushError(String(e));
    } finally {
      if (ticket.stillCurrent()) setBusy(null);
    }
  }, [
    scope, pushError, clearErrors, language, t, upsertJob, refreshDatasets,
    display, setArtifacts, refreshArtifacts,
  ]);

  const selectedDataset = useMemo(
    () => datasets.find((d) => d.id === selectedDatasetId) ?? null,
    [datasets, selectedDatasetId],
  );

  const savePipeline = useCallback(async (name: string) => {
    const ticket = scope.capture();
    if (!ticket || !selectedDataset) return;
    const state: ViewState = {
      schema_version: 1,
      representation: display.representation,
      color_by: display.colorBy,
      color_range: display.customColorRange,
      opacity: display.opacity,
      color_map: display.colorMap,
      legend_visible: display.legendVisible,
      camera: display.cameraState,
      table_coordinates: display.tableCoordinates,
      image_mode: display.imageMode,
      slice_axis: display.sliceAxis,
      slice_index: display.sliceIndex,
      timestep_index: display.timestepIndex,
    };
    try {
      const created = await api.createViewPipeline(
        ticket.projectId, selectedDataset.id, name, state,
      );
      if (ticket.stillCurrent()) {
        setPipelines((previous) => [created, ...previous]);
      }
    } catch (e) {
      if (ticket.stillCurrent()) pushError(String(e));
    }
  }, [scope, selectedDataset, display, setPipelines, pushError]);

  const restorePipeline = useCallback(async (pipeline: Pipeline) => {
    const ticket = scope.capture();
    if (!ticket || pipeline.project_id !== ticket.projectId) return;
    const nodes = pipeline.nodes ?? [];
    const representationNode = nodes.find((node) => node.node_type === "representation");
    const state = parseViewState(representationNode?.params.view_state);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    let input = representationNode;
    const visited = new Set<string>();
    while (input?.input_id && !visited.has(input.input_id)) {
      visited.add(input.input_id);
      input = byId.get(input.input_id);
      if (input?.node_type === "reader") break;
    }
    if (!input?.dataset_id || input.node_type !== "reader" || !state) {
      pushError(t.errors.savedPipelineUnreadable);
      return;
    }
    const dataset = await selectDataset(input.dataset_id);
    if (!dataset || !ticket.stillCurrent()) return;
    display.setRepresentation(state.representation);
    display.setColorByState(state.color_by);
    display.setCustomColorRange(state.color_range);
    display.setRuntimeColorRange(null);
    display.setOpacity(state.opacity);
    display.setColorMap(state.color_map);
    display.setLegendVisible(state.legend_visible);
    display.setCameraState(state.camera);
    display.setTableCoordinates(state.table_coordinates ?? null);
    display.setImageMode(state.image_mode ?? "slice");
    display.setSliceAxis(state.slice_axis ?? "Z");
    display.setSliceIndex(state.slice_index ?? 0);
    display.setTimestepIndex(state.timestep_index ?? 0);
    display.setPlaying(false);
  }, [scope, pushError, t, selectDataset, display]);

  const deletePipeline = useCallback((pipeline: Pipeline) => {
    const ticket = scope.capture();
    if (!ticket || pipeline.project_id !== ticket.projectId) return;
    void api.deletePipeline(pipeline.id)
      .then(() => {
        if (ticket.stillCurrent()) {
          setPipelines((previous) => previous.filter((item) => item.id !== pipeline.id));
        }
      })
      .catch((e) => {
        if (ticket.stillCurrent()) pushError(String(e));
      });
  }, [scope, setPipelines, pushError]);

  const renamePipeline = useCallback((pipeline: Pipeline, name: string) => {
    const ticket = scope.capture();
    if (!ticket || pipeline.project_id !== ticket.projectId) return;
    void api.renamePipeline(pipeline.id, name)
      .then((updated) => {
        if (ticket.stillCurrent()) {
          setPipelines((previous) =>
            previous.map((item) => (item.id === updated.id ? updated : item)),
          );
        }
      })
      .catch((e) => {
        if (ticket.stillCurrent()) pushError(String(e));
      });
  }, [scope, setPipelines, pushError]);

  /** Track a job returned by a POST until completion, refreshing artifacts. */
  const trackJob = useCallback(async (job: Job, ticket = scope.capture()) => {
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

  const runDatasetJob = useCallback(async (
    kind: "convert" | "filter" | "export" | "render" | "stats" | "movie",
    params: Record<string, unknown>,
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
      if (ticket.stillCurrent()) pushError(String(e));
    } finally {
      if (ticket.stillCurrent()) setPending(false);
    }
  }, [scope, clearErrors, trackJob, pushError]);

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

  const runServerFilter = useCallback((params: Record<string, unknown>) => {
    if (filterPending) return;
    void runDatasetJob("filter", params, setFilterPending);
  }, [filterPending, runDatasetJob]);

  const runPipeline = useCallback((pipeline: Pipeline) => {
    const ticket = scope.capture();
    if (!ticket || pipeline.project_id !== ticket.projectId) return;
    void (async () => {
      try {
        const job = await api.runPipeline(pipeline.id);
        await trackJob(job, ticket);
      } catch (e) {
        if (ticket.stillCurrent()) pushError(String(e));
      }
    })();
  }, [scope, trackJob, pushError]);

  const onAssistJobCreated = useCallback((job: Job) => {
    const ticket = scope.capture();
    void trackJob(job, ticket).catch((e) => {
      if (ticket?.stillCurrent()) pushError(String(e));
    });
  }, [scope, trackJob, pushError]);

  const promoteArtifact = useCallback((artifact: Artifact) => {
    const ticket = scope.capture();
    if (!ticket) return;
    setPromotePendingIds((previous) => new Set(previous).add(artifact.id));
    void (async () => {
      try {
        const dataset = await api.promoteArtifact(artifact.id);
        const job = await api.ingest(dataset.id);
        if (ticket.stillCurrent()) upsertJob(job);
        await pollJob(job.id, (next) => {
          if (ticket.stillCurrent()) upsertJob(next);
        });
        if (ticket.stillCurrent()) await refreshDatasets(ticket.projectId);
      } catch (e) {
        if (ticket.stillCurrent()) pushError(String(e));
      } finally {
        setPromotePendingIds((previous) => {
          const next = new Set(previous);
          next.delete(artifact.id);
          return next;
        });
      }
    })();
  }, [scope, upsertJob, refreshDatasets, pushError]);

  const downloadTimestep = useCallback((index: number) => {
    const datasetId = scope.selectedDatasetRef.current;
    if (!datasetId) return;
    void authorizedFetch(api.timestepUrl(datasetId, index))
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const blob = await response.blob();
        triggerBlobDownload(blob, `timestep-${index}`);
      })
      .catch((e) => pushError(String(e)));
  }, [scope, pushError]);

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
    setExportNonce((n) => n + 1);
    // If the viewer cannot export (no geometry scene), release the pending flag.
    window.setTimeout(() => setClientExportPending(false), 10000);
  }, [clientExportPending]);

  const startRemote = useCallback(() => {
    const ticket = scope.capture();
    const datasetId = scope.selectedDatasetRef.current;
    if (!ticket || !datasetId || remotePending) return;
    setRemotePending(true);
    void api.createSession(ticket.projectId, datasetId)
      .then((session) => {
        if (ticket.stillCurrent()) setRemoteSession(session);
        else stopRemoteSession(session);
      })
      .catch((e) => {
        if (ticket.stillCurrent()) pushError(String(e));
      })
      .finally(() => setRemotePending(false));
  }, [scope, remotePending, pushError, stopRemoteSession]);

  const stopRemote = useCallback(() => {
    if (!remoteSession || remotePending) return;
    setRemotePending(true);
    void api.deleteSession(remoteSession.id)
      .catch((e) => pushError(String(e)))
      .finally(() => {
        setRemoteSession(null);
        setRemotePending(false);
      });
  }, [remoteSession, remotePending, pushError]);

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

  const copyShareLink = useCallback(() => {
    const url = new URL(window.location.origin + window.location.pathname);
    if (currentProjectId) url.searchParams.set("project", currentProjectId);
    if (selectedDatasetId) url.searchParams.set("dataset", selectedDatasetId);
    void navigator.clipboard.writeText(url.toString())
      .then(() => {
        setShareCopied(true);
        window.setTimeout(() => setShareCopied(false), 2000);
      })
      .catch((e) => pushError(String(e)));
  }, [currentProjectId, selectedDatasetId, pushError]);

  // ---- deep link application after project data loads
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

  // ---- PVD playback loop
  useEffect(() => {
    if (
      !display.playing ||
      selectedDataset?.dataset_type !== "Collection" ||
      !viewerUrl ||
      viewerLoadedUrl !== viewerUrl
    ) return;
    const count = selectedDataset.timesteps?.length ?? 0;
    if (count < 2) {
      display.setPlaying(false);
      return;
    }
    const timer = window.setTimeout(
      () => display.setTimestepIndex((index) => (index + 1) % count),
      800,
    );
    return () => window.clearTimeout(timer);
  }, [display, selectedDataset, viewerUrl, viewerLoadedUrl]);

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
  const onScreenshot = useCallback(() => setScreenshotNonce((n) => n + 1), []);
  const onResetCamera = useCallback(() => setResetNonce((n) => n + 1), []);

  const remoteAvailable = !!serverCapabilities?.trame_sessions;

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
          <div className="manual-backdrop" role="presentation" onClick={() => setManualOpen(false)}>
            <section
              className="manual-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="manual-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="manual-header">
                <h2 id="manual-title">{t.manual.title}</h2>
                <button onClick={() => setManualOpen(false)}>{t.common.close}</button>
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
          >
            {remoteSession ? (
              <RemoteViewer session={remoteSession} onError={pushError} />
            ) : (
              <VtkViewer
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
                screenshotNonce={screenshotNonce}
                exportNonce={exportNonce}
                resetNonce={resetNonce}
                viewerBackground={viewerBackground}
              />
            )}
          </ErrorBoundary>
        </main>

        <PropertiesPanel
          dataset={selectedDataset}
          representation={display.representation}
          onRepresentation={display.setRepresentation}
          colorBy={display.colorBy}
          onColorBy={display.setColorBy}
          dataColorRange={availableColorRange}
          customColorRange={display.customColorRange}
          onCustomColorRange={display.setCustomColorRange}
          opacity={display.opacity}
          onOpacity={display.setOpacity}
          colorMap={display.colorMap}
          onColorMap={display.setColorMap}
          legendVisible={display.legendVisible}
          onLegendVisible={display.setLegendVisible}
          onScreenshot={onScreenshot}
          onResetCamera={onResetCamera}
          axesVisible={display.axesVisible}
          onAxesVisible={display.setAxesVisible}
          artifacts={artifacts}
          onExport={exportDataset}
          exportPending={exportPending}
          onConvert={convertDataset}
          convertPending={convertPending}
          onRunStats={runStats}
          statsPending={statsPending}
          onPromoteArtifact={promoteArtifact}
          promotePendingIds={promotePendingIds}
          onClientExport={clientExport}
          clientExportPending={clientExportPending}
          filterPending={filterPending}
          serverFilterAvailable={serverCapabilities?.paraview_worker ?? false}
          onRunFilter={runServerFilter}
          onJobCreated={onAssistJobCreated}
          tableCoordinates={display.tableCoordinates}
          onTableCoordinates={display.setTableCoordinates}
          imageMode={display.imageMode}
          onImageMode={display.setImageMode}
          sliceAxis={display.sliceAxis}
          onSliceAxis={onSliceAxis}
          sliceIndex={clampedSliceIndex}
          onSliceIndex={display.setSliceIndex}
          sliceMin={sliceMin}
          sliceMax={sliceMax}
          volumeOpacityPoints={display.volumeOpacityPoints}
          onVolumeOpacityPoints={display.setVolumeOpacityPoints}
          timestepIndex={display.timestepIndex}
          onTimestepIndex={onTimestepIndex}
          playing={display.playing}
          onTogglePlayback={() => display.setPlaying((value) => !value)}
          onDownloadTimestep={downloadTimestep}
          remoteAvailable={remoteAvailable}
          remoteSession={remoteSession}
          remotePending={remotePending}
          onStartRemote={startRemote}
          onStopRemote={stopRemote}
          onError={pushError}
        />
      </div>
    </div>
  );
}
