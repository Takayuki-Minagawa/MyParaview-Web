import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, pollJob } from "./api";
import type {
  ColorMapName,
  Dataset,
  Project,
  Representation,
  ScalarSelection,
  Job,
  CameraState,
  Pipeline,
  ViewState,
  Artifact,
  ImageMode,
  SliceAxis,
  TableCoordinates,
  ServerCapabilities,
  ProjectMember,
  ProjectRole,
} from "./types";
import { DatasetPanel } from "./components/DatasetPanel";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { VtkViewer } from "./components/VtkViewer";
import { mergeJobSnapshots } from "./lib/job";
import { clampSliceIndex, parseViewState } from "./lib/viewState";
import { initializeOidc, login, logout } from "./oidc";
import { detectBrowserCapabilities } from "./lib/capabilities";
import { defaultImageScalar } from "./lib/imageData";
import { MESSAGES } from "./i18n";
import type { Language, ThemeMode } from "./i18n";

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
  const [manualOpen, setManualOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [representation, setRepresentation] = useState<Representation>("surface");
  const [colorBy, setColorByState] = useState<ScalarSelection | null>(null);
  const [customColorRange, setCustomColorRange] = useState<[number, number] | null>(null);
  const [runtimeColorRange, setRuntimeColorRange] = useState<[number, number] | null>(null);
  const [opacity, setOpacity] = useState(1);
  const [colorMap, setColorMap] = useState<ColorMapName>("cool-to-warm");
  const [legendVisible, setLegendVisible] = useState(true);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [cancelingJobIds, setCancelingJobIds] = useState<Set<string>>(() => new Set());
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [cameraState, setCameraState] = useState<CameraState | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [exportPending, setExportPending] = useState(false);
  const [filterPending, setFilterPending] = useState(false);
  const [tableCoordinates, setTableCoordinates] = useState<TableCoordinates | null>(null);
  const [imageMode, setImageMode] = useState<ImageMode>("slice");
  const [sliceAxis, setSliceAxis] = useState<SliceAxis>("Z");
  const [sliceIndex, setSliceIndex] = useState(0);
  const [timestepIndex, setTimestepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [viewerLoadedUrl, setViewerLoadedUrl] = useState<string | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [screenshotNonce, setScreenshotNonce] = useState(0);
  const [resetNonce, setResetNonce] = useState(0);
  const [authState, setAuthState] = useState({
    ready: false,
    configured: false,
    authenticated: false,
  });
  const [serverCapabilities, setServerCapabilities] = useState<ServerCapabilities | null>(null);
  const [membership, setMembership] = useState<ProjectMember | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const browserCapabilities = useMemo(() => detectBrowserCapabilities(), []);
  const t = MESSAGES[language];
  const viewerBackground = useMemo<[number, number, number]>(
    () => theme === "dark" ? [0.09, 0.11, 0.15] : [0.96, 0.97, 0.99],
    [theme],
  );
  const deepLink = useMemo(() => {
    const query = new URLSearchParams(window.location.search);
    return {
      projectId: query.get("project"),
      datasetId: query.get("dataset"),
      pipelineId: query.get("pipeline"),
    };
  }, [authState.ready]);
  const deepLinkAppliedRef = useRef(false);
  const currentProjectRef = useRef<string | null>(null);
  const projectEpochRef = useRef(0);
  const selectionRequestRef = useRef(0);
  const selectedDatasetRef = useRef<string | null>(null);
  const isCurrentProject = (projectId: string, epoch: number) =>
    currentProjectRef.current === projectId && projectEpochRef.current === epoch;

  const guard = useCallback(async (fn: () => Promise<void>) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(String(e));
    }
  }, []);

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
          setError(`${t.auth.oidcErrorPrefix}: ${String(reason)}`);
        }
      });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    void api.capabilities().then(setServerCapabilities).catch(() => setServerCapabilities(null));
  }, []);

  const refreshDatasets = useCallback(async (projectId: string) => {
    const epoch = projectEpochRef.current;
    try {
      const next = await api.listDatasets(projectId);
      if (currentProjectRef.current === projectId && projectEpochRef.current === epoch) {
        setDatasets(next);
        setError((value) => value?.startsWith(`${t.errors.datasetUpdate}:`) ? null : value);
      }
    } catch (e) {
      if (currentProjectRef.current === projectId && projectEpochRef.current === epoch) {
        setError(`${t.errors.datasetUpdate}: ${String(e)}`);
      }
    }
  }, [t.errors.datasetUpdate]);

  const refreshPipelines = useCallback(async (projectId: string) => {
    const epoch = projectEpochRef.current;
    try {
      const next = await api.listPipelines(projectId);
      if (currentProjectRef.current === projectId && projectEpochRef.current === epoch) {
        setPipelines(next);
      }
    } catch (e) {
      if (currentProjectRef.current === projectId && projectEpochRef.current === epoch) {
        setError(`${t.errors.pipelineUpdate}: ${String(e)}`);
      }
    }
  }, [t.errors.pipelineUpdate]);

  const refreshMembership = useCallback(async (projectId: string) => {
    const epoch = projectEpochRef.current;
    try {
      const current = await api.getMembership(projectId);
      const nextMembers = current.role === "admin" ? await api.listMembers(projectId) : [];
      if (currentProjectRef.current === projectId && projectEpochRef.current === epoch) {
        setMembership(current);
        setMembers(nextMembers);
      }
    } catch (e) {
      if (currentProjectRef.current === projectId && projectEpochRef.current === epoch) {
        setMembership(null);
        setMembers([]);
        setError(`${t.errors.memberUpdate}: ${String(e)}`);
      }
    }
  }, [t.errors.memberUpdate]);

  const refreshArtifacts = useCallback(
    async (datasetId: string, projectId: string, epoch: number, selectionRequest: number) => {
      try {
        const next = await api.listArtifacts(datasetId);
        if (
          currentProjectRef.current === projectId &&
          projectEpochRef.current === epoch &&
          selectionRequestRef.current === selectionRequest &&
          selectedDatasetRef.current === datasetId
        ) setArtifacts(next);
      } catch (e) {
        if (
          currentProjectRef.current === projectId &&
          projectEpochRef.current === epoch &&
          selectionRequestRef.current === selectionRequest
        ) setError(`${t.errors.artifactUpdate}: ${String(e)}`);
      }
    },
    [t.errors.artifactUpdate],
  );

  const switchProject = useCallback((projectId: string) => {
    projectEpochRef.current += 1;
    selectionRequestRef.current += 1;
    selectedDatasetRef.current = null;
    currentProjectRef.current = projectId;
    setDatasets([]);
    setJobs([]);
    setPipelines([]);
    setMembership(null);
    setMembers([]);
    setCancelingJobIds(new Set());
    setSelectedDatasetId(null);
    setColorByState(null);
    setCustomColorRange(null);
    setRuntimeColorRange(null);
    setCameraState(null);
    setArtifacts([]);
    setExportPending(false);
    setFilterPending(false);
    setTableCoordinates(null);
    setImageMode("slice");
    setSliceAxis("Z");
    setSliceIndex(0);
    setTimestepIndex(0);
    setPlaying(false);
    setBusy(null);
    setError(null);
    setCurrentProjectId(projectId);
  }, []);

  useEffect(() => {
    if (!authState.ready || (authState.configured && !authState.authenticated)) return;
    guard(async () => {
      const next = await api.listProjects();
      setProjects(next);
      if (
        deepLink.projectId &&
        currentProjectRef.current !== deepLink.projectId &&
        next.some((project) => project.id === deepLink.projectId)
      ) {
        switchProject(deepLink.projectId);
      }
    });
  }, [guard, authState, deepLink, switchProject]);

  useEffect(() => {
    currentProjectRef.current = currentProjectId;
    if (!currentProjectId) {
      setDatasets([]);
      setJobs([]);
      setPipelines([]);
      setMembership(null);
      setMembers([]);
      return;
    }
    void refreshDatasets(currentProjectId);
    void refreshPipelines(currentProjectId);
    void refreshMembership(currentProjectId);
    const projectEpoch = projectEpochRef.current;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await api.listJobs(currentProjectId);
        if (
          !disposed &&
          currentProjectRef.current === currentProjectId &&
          projectEpochRef.current === projectEpoch
        ) {
          setJobs((previous) => mergeJobSnapshots(previous, next));
          setError((value) => value?.startsWith(`${t.errors.jobUpdate}:`) ? null : value);
        }
      } catch (e) {
        if (
          !disposed &&
          currentProjectRef.current === currentProjectId &&
          projectEpochRef.current === projectEpoch
        ) {
          setError(`${t.errors.jobUpdate}: ${String(e)}`);
        }
      } finally {
        if (
          !disposed &&
          currentProjectRef.current === currentProjectId &&
          projectEpochRef.current === projectEpoch
        ) {
          timer = window.setTimeout(poll, 1200);
        }
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [currentProjectId, refreshDatasets, refreshPipelines, refreshMembership]);

  const createProject = (name: string) => {
    const startProject = currentProjectRef.current;
    const epoch = projectEpochRef.current;
    return guard(async () => {
      const p = await api.createProject(name);
      setProjects((prev) => [p, ...prev]);
      if (currentProjectRef.current === startProject && projectEpochRef.current === epoch) {
        switchProject(p.id);
      }
    });
  };

  const upload = async (files: File[]) => {
    const projectId = currentProjectRef.current;
    if (!projectId || files.length === 0) return;
    const pvd = files.find((file) => file.name.toLowerCase().endsWith(".pvd"));
    const externalDescriptor = files.find((file) => /\.(case|xdmf|xmf)$/i.test(file.name));
    const primary = pvd ?? externalDescriptor ?? files[0];
    if (files.length > 1 && !pvd && !externalDescriptor) {
      setError(t.errors.multiFileDescriptor);
      return;
    }
    const pvdBundle = !!pvd && files.length > 1;
    const isBundle = pvdBundle || !!externalDescriptor;
    const epoch = projectEpochRef.current;
    const selectionRequest = selectionRequestRef.current;
    setError(null);
    try {
      setBusy(
        language === "ja"
          ? `${primary.name}${isBundle ? ` ${t.errors.andMore}${files.length - 1}件` : ""} ${t.errors.uploadingSuffix}`
          : `${primary.name}${isBundle ? ` ${t.errors.andMore} ${files.length - 1}` : ""} ${t.errors.uploadingSuffix}`,
      );
      const ds = pvdBundle
        ? await api.uploadDatasetBundle(projectId, files)
        : isBundle && externalDescriptor
          ? await api.uploadExternalDatasetBundle(projectId, files)
          : await api.uploadDataset(projectId, primary);
      if (isCurrentProject(projectId, epoch)) setBusy(t.errors.metadataParsing);
      const job = await api.ingest(ds.id);
      const final = await pollJob(job.id, (j) => {
        if (isCurrentProject(projectId, epoch)) {
          setBusy(`${t.errors.parsingProgress} ${Math.round(j.progress * 100)}%`);
          setJobs((previous) => mergeJobSnapshots(previous, [j, ...previous.filter((x) => x.id !== j.id)]));
        }
      });
      if (!isCurrentProject(projectId, epoch)) return;
      await refreshDatasets(projectId);
      if (!isCurrentProject(projectId, epoch)) return;
      if (selectionRequestRef.current === selectionRequest) {
        selectionRequestRef.current += 1;
        selectedDatasetRef.current = ds.id;
        setSelectedDatasetId(ds.id);
        setColorByState(null);
        setCustomColorRange(null);
        setRuntimeColorRange(null);
        setCameraState(null);
        setTableCoordinates(null);
        setImageMode("slice");
        setSliceAxis("Z");
        setSliceIndex(0);
        setTimestepIndex(0);
        setPlaying(false);
        setArtifacts([]);
        void refreshArtifacts(
          ds.id,
          projectId,
          epoch,
          selectionRequestRef.current,
        );
      }
      if (final.status !== "succeeded" && isCurrentProject(projectId, epoch)) {
        const lastLog = (final.log ?? "").split("\n").filter(Boolean).pop() ?? "";
        setError(`${t.errors.metadataFailed} (${final.status}): ${lastLog}`);
      }
    } catch (e) {
      if (isCurrentProject(projectId, epoch)) setError(String(e));
    } finally {
      if (isCurrentProject(projectId, epoch)) setBusy(null);
    }
  };

  const selectDataset = async (id: string): Promise<Dataset | null> => {
    const projectId = currentProjectRef.current;
    if (!projectId) return null;
    const epoch = projectEpochRef.current;
    const request = ++selectionRequestRef.current;
    setError(null);
    try {
      const ds = await api.getDataset(id);
      if (
        !isCurrentProject(projectId, epoch) ||
        selectionRequestRef.current !== request ||
        ds.project_id !== projectId
      ) return null;
      setSelectedDatasetId(id);
      selectedDatasetRef.current = id;
      setColorByState(null);
      setCustomColorRange(null);
      setRuntimeColorRange(null);
      setCameraState(null);
      setTableCoordinates(null);
      setImageMode("slice");
      setSliceAxis("Z");
      setSliceIndex(0);
      setTimestepIndex(0);
      setPlaying(false);
      setArtifacts([]);
      setDatasets((prev) => prev.map((d) => (d.id === id ? ds : d)));
      void refreshArtifacts(id, projectId, epoch, request);
      return ds;
    } catch (e) {
      if (isCurrentProject(projectId, epoch) && selectionRequestRef.current === request) {
        setError(String(e));
      }
      return null;
    }
  };

  const savePipeline = async (name: string) => {
    const projectId = currentProjectRef.current;
    if (!projectId || !selectedDataset) return;
    const epoch = projectEpochRef.current;
    const state: ViewState = {
      schema_version: 1,
      representation,
      color_by: colorBy,
      color_range: customColorRange,
      opacity,
      color_map: colorMap,
      legend_visible: legendVisible,
      camera: cameraState,
      table_coordinates: tableCoordinates,
      image_mode: imageMode,
      slice_axis: sliceAxis,
      slice_index: clampedSliceIndex,
      timestep_index: timestepIndex,
    };
    try {
      const created = await api.createViewPipeline(projectId, selectedDataset.id, name, state);
      if (isCurrentProject(projectId, epoch)) {
        setPipelines((previous) => [created, ...previous]);
      }
    } catch (e) {
      if (isCurrentProject(projectId, epoch)) setError(String(e));
    }
  };

  const restorePipeline = async (pipeline: Pipeline) => {
    const projectId = currentProjectRef.current;
    if (!projectId || pipeline.project_id !== projectId) return;
    const epoch = projectEpochRef.current;
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
      setError(t.errors.savedPipelineUnreadable);
      return;
    }
    const dataset = await selectDataset(input.dataset_id);
    if (!dataset || !isCurrentProject(projectId, epoch)) return;
    setRepresentation(state.representation);
    setColorByState(state.color_by);
    setCustomColorRange(state.color_range);
    setRuntimeColorRange(null);
    setOpacity(state.opacity);
    setColorMap(state.color_map);
    setLegendVisible(state.legend_visible);
    setCameraState(state.camera);
    setTableCoordinates(state.table_coordinates ?? null);
    setImageMode(state.image_mode ?? "slice");
    setSliceAxis(state.slice_axis ?? "Z");
    setSliceIndex(state.slice_index ?? 0);
    setTimestepIndex(state.timestep_index ?? 0);
    setPlaying(false);
  };

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
  }, [currentProjectId, datasets, pipelines, deepLink]);

  const selectedDataset = useMemo(
    () => datasets.find((d) => d.id === selectedDatasetId) ?? null,
    [datasets, selectedDatasetId],
  );

  const colorRange = useMemo<[number, number] | null>(() => {
    if (!selectedDataset || !colorBy) return null;
    const arr = (selectedDataset.arrays ?? []).find(
      (a) =>
        a.name === colorBy.name &&
        (a.association === colorBy.association ||
          (selectedDataset.dataset_type === "Table" &&
            colorBy.association === "point" &&
            a.association === "table")),
    );
    return arr?.value_range ?? null;
  }, [selectedDataset, colorBy]);

  const setColorBy = (selection: ScalarSelection | null) => {
    setColorByState(selection);
    setCustomColorRange(null);
    setRuntimeColorRange(null);
  };

  // CSV rows with invalid coordinates are omitted by the viewer, so its
  // post-filter range is authoritative rather than the all-row metadata range.
  const availableColorRange = selectedDataset?.dataset_type === "Table"
    ? runtimeColorRange
    : colorRange ?? runtimeColorRange;
  const activeColorRange =
    customColorRange && customColorRange[0] < customColorRange[1]
      ? customColorRange
      : availableColorRange;

  const collectionInnerType = selectedDataset?.dataset_type === "Collection"
    ? String(selectedDataset.extra?.inner_type ?? "")
    : null;
  const viewerDatasetType = collectionInnerType || selectedDataset?.dataset_type;
  const viewerUrl = selectedDataset && selectedDataset.status === "ready"
    ? selectedDataset.dataset_type === "Collection"
      ? selectedDataset.extra?.bundle_complete === false
        ? null
        : api.timestepUrl(selectedDataset.id, timestepIndex)
      : api.downloadUrl(selectedDataset.id)
    : null;
  const viewerEmptyMessage = selectedDataset?.dataset_type === "Collection" &&
    selectedDataset.extra?.bundle_complete === false
    ? t.appMessages.incompletePvd
    : undefined;

  useEffect(() => {
    if (!selectedDataset) return;
    if (selectedDataset.dataset_type === "Table" && !tableCoordinates) {
      const numeric = (selectedDataset.arrays ?? [])
        .filter((array) => array.association === "table" && array.data_type === "numeric")
        .map((array) => array.name);
      const pick = (axis: string, fallback: number) =>
        numeric.find((name) => name.toLowerCase() === axis) ?? numeric[fallback] ?? "";
      const inferred = { x: pick("x", 0), y: pick("y", 1), z: pick("z", 2) };
      if (new Set(Object.values(inferred)).size === 3 && Object.values(inferred).every(Boolean)) {
        setTableCoordinates(inferred);
        setRepresentation("points");
      }
    }
    if (viewerDatasetType === "ImageData" && !colorBy) {
      const scalar = defaultImageScalar(selectedDataset.arrays ?? []);
      if (scalar) setColorByState(scalar);
    }
  }, [selectedDataset, tableCoordinates, colorBy, viewerDatasetType]);

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
  }, [playing, selectedDataset, viewerUrl, viewerLoadedUrl]);

  useEffect(() => {
    const maximum = Math.max(0, (selectedDataset?.timesteps?.length ?? 1) - 1);
    setTimestepIndex((index) => Math.min(index, maximum));
  }, [selectedDataset?.id, selectedDataset?.timesteps?.length]);

  const dimensions = (selectedDataset?.extra?.dimensions as number[] | undefined) ?? [1, 1, 1];
  const wholeExtent = (selectedDataset?.extra?.whole_extent as number[] | undefined) ?? [
    0, Math.max(0, dimensions[0] - 1),
    0, Math.max(0, dimensions[1] - 1),
    0, Math.max(0, dimensions[2] - 1),
  ];
  const extentOffset = { X: 0, Y: 2, Z: 4 }[sliceAxis];
  const sliceMin = wholeExtent[extentOffset] ?? 0;
  const sliceMax = Math.max(sliceMin, wholeExtent[extentOffset + 1] ?? sliceMin);
  const clampedSliceIndex = clampSliceIndex(sliceIndex, sliceMin, sliceMax);

  useEffect(() => {
    if (sliceIndex !== clampedSliceIndex) setSliceIndex(clampedSliceIndex);
  }, [sliceIndex, clampedSliceIndex]);

  const exportDataset = async () => {
    const projectId = currentProjectRef.current;
    const datasetId = selectedDatasetRef.current;
    if (!projectId || !datasetId || exportPending) return;
    const epoch = projectEpochRef.current;
    const selectionRequest = selectionRequestRef.current;
    setExportPending(true);
    setError(null);
    try {
      const job = await api.createJob(projectId, "export", datasetId, {
        output_format: "source",
      });
      if (isCurrentProject(projectId, epoch)) {
        setJobs((previous) => mergeJobSnapshots(previous, [job, ...previous]));
      }
      const final = await pollJob(job.id, (next) => {
        if (isCurrentProject(projectId, epoch)) {
          setJobs((previous) =>
            mergeJobSnapshots(previous, [next, ...previous.filter((item) => item.id !== next.id)]),
          );
        }
      });
      if (final.status !== "succeeded") {
        throw new Error(`export job ${final.status}`);
      }
      await refreshArtifacts(datasetId, projectId, epoch, selectionRequest);
    } catch (e) {
      if (isCurrentProject(projectId, epoch)) setError(String(e));
    } finally {
      if (isCurrentProject(projectId, epoch)) setExportPending(false);
    }
  };

  const runServerFilter = async (params: Record<string, unknown>) => {
    const projectId = currentProjectRef.current;
    const datasetId = selectedDatasetRef.current;
    if (!projectId || !datasetId || filterPending) return;
    const epoch = projectEpochRef.current;
    const selectionRequest = selectionRequestRef.current;
    setFilterPending(true);
    setError(null);
    try {
      const job = await api.createJob(projectId, "filter", datasetId, params);
      if (isCurrentProject(projectId, epoch)) {
        setJobs((previous) => mergeJobSnapshots(previous, [job, ...previous]));
      }
      const final = await pollJob(job.id, (next) => {
        if (isCurrentProject(projectId, epoch)) {
          setJobs((previous) => mergeJobSnapshots(previous, [next, ...previous]));
        }
      });
      if (final.status !== "succeeded") {
        const lastLog = final.log.split("\n").filter(Boolean).pop() ?? final.status;
        throw new Error(`filter job ${final.status}: ${lastLog}`);
      }
      await refreshArtifacts(datasetId, projectId, epoch, selectionRequest);
    } catch (reason) {
      if (isCurrentProject(projectId, epoch)) setError(String(reason));
    } finally {
      if (isCurrentProject(projectId, epoch)) setFilterPending(false);
    }
  };

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
        <div className="mode-controls" aria-label="Display settings">
          <div className="segmented">
            <button aria-pressed={theme === "light"} onClick={() => setTheme("light")}>
              {t.common.light}
            </button>
            <button aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>
              {t.common.dark}
            </button>
          </div>
          <div className="segmented">
            <button aria-pressed={language === "ja"} onClick={() => setLanguage("ja")}>
              {t.common.japanese}
            </button>
            <button aria-pressed={language === "en"} onClick={() => setLanguage("en")}>
              {t.common.english}
            </button>
          </div>
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
        {error && <span className="error-banner">{error}</span>}
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
          messages={t}
          projects={projects}
          currentProjectId={currentProjectId}
          onSelectProject={switchProject}
          onCreateProject={createProject}
          membership={membership}
          members={members}
          onPutMember={(userId: string, role: ProjectRole) => {
            const projectId = currentProjectRef.current;
            if (!projectId) return;
            const epoch = projectEpochRef.current;
            void api.putMember(projectId, userId, role)
              .then(() => {
                if (isCurrentProject(projectId, epoch)) void refreshMembership(projectId);
              })
              .catch((reason) => {
                if (isCurrentProject(projectId, epoch)) setError(String(reason));
              });
          }}
          datasets={datasets}
          selectedDatasetId={selectedDatasetId}
          onSelectDataset={selectDataset}
          onUploadFiles={(files) => void upload(files)}
          busy={busy}
          jobs={jobs}
          cancelingJobIds={cancelingJobIds}
          pipelines={pipelines}
          canSavePipeline={!!selectedDataset}
          onSavePipeline={(name) => void savePipeline(name)}
          onRestorePipeline={(pipeline) => void restorePipeline(pipeline)}
          onDeletePipeline={(pipeline) => {
            const projectId = currentProjectRef.current;
            if (!projectId || pipeline.project_id !== projectId) return;
            const epoch = projectEpochRef.current;
            void api.deletePipeline(pipeline.id)
              .then(() => {
                if (isCurrentProject(projectId, epoch)) {
                  setPipelines((previous) => previous.filter((item) => item.id !== pipeline.id));
                }
              })
              .catch((e) => {
                if (isCurrentProject(projectId, epoch)) setError(String(e));
              });
          }}
          onCancelJob={(id) => {
            const projectId = currentProjectRef.current;
            const target = jobs.find((job) => job.id === id);
            if (!projectId || target?.project_id !== projectId || cancelingJobIds.has(id)) return;
            const epoch = projectEpochRef.current;
            setCancelingJobIds((previous) => new Set(previous).add(id));
            setError(null);
            void (async () => {
              try {
                const canceled = await api.cancelJob(id);
                if (isCurrentProject(projectId, epoch)) {
                  setJobs((previous) =>
                    mergeJobSnapshots(
                      previous,
                      previous.map((job) => job.id === id ? canceled : job),
                    ),
                  );
                }
              } catch (e) {
                if (isCurrentProject(projectId, epoch)) setError(String(e));
              } finally {
                setCancelingJobIds((previous) => {
                  const next = new Set(previous);
                  next.delete(id);
                  return next;
                });
              }
            })();
          }}
        />

        <main className="center">
          <VtkViewer
            messages={t}
            datasetId={selectedDataset?.id ?? null}
            url={viewerUrl}
            datasetType={viewerDatasetType}
            emptyMessage={viewerEmptyMessage}
            representation={representation}
            colorBy={colorBy}
            colorRange={activeColorRange}
            opacity={opacity}
            colorMap={colorMap}
            legendVisible={legendVisible}
            tableCoordinates={tableCoordinates}
            imageMode={imageMode}
            sliceAxis={sliceAxis}
            sliceIndex={clampedSliceIndex}
            cameraState={cameraState}
            onCameraChange={setCameraState}
            onScreenshotCaptured={(blob, datasetId) => {
              const projectId = currentProjectRef.current;
              if (!projectId || !datasetId) return;
              const epoch = projectEpochRef.current;
              const selectionRequest = selectionRequestRef.current;
              void api.uploadArtifact(datasetId, "screenshot", blob)
                .then((artifact) => {
                  if (
                    isCurrentProject(projectId, epoch) &&
                    selectionRequestRef.current === selectionRequest &&
                    selectedDatasetRef.current === datasetId
                  ) setArtifacts((previous) => [artifact, ...previous]);
                })
                .catch((e) => {
                  if (isCurrentProject(projectId, epoch)) setError(String(e));
                });
            }}
            onColorRangeResolved={(selection, range) => {
              if (
                colorBy?.name === selection.name &&
                colorBy.association === selection.association
              ) {
                setRuntimeColorRange(range);
              }
            }}
            onLoadComplete={() => setViewerLoadedUrl(viewerUrl)}
            screenshotNonce={screenshotNonce}
            resetNonce={resetNonce}
            viewerBackground={viewerBackground}
          />
        </main>

        <PropertiesPanel
          messages={t}
          dataset={selectedDataset}
          representation={representation}
          onRepresentation={setRepresentation}
          colorBy={colorBy}
          onColorBy={setColorBy}
          dataColorRange={availableColorRange}
          customColorRange={customColorRange}
          onCustomColorRange={setCustomColorRange}
          opacity={opacity}
          onOpacity={setOpacity}
          colorMap={colorMap}
          onColorMap={setColorMap}
          legendVisible={legendVisible}
          onLegendVisible={setLegendVisible}
          onScreenshot={() => setScreenshotNonce((n) => n + 1)}
          onResetCamera={() => setResetNonce((n) => n + 1)}
          artifacts={artifacts}
          onExport={() => void exportDataset()}
          exportPending={exportPending}
          filterPending={filterPending}
          serverFilterAvailable={serverCapabilities?.paraview_worker ?? false}
          onRunFilter={(params) => void runServerFilter(params)}
          tableCoordinates={tableCoordinates}
          onTableCoordinates={setTableCoordinates}
          imageMode={imageMode}
          onImageMode={setImageMode}
          sliceAxis={sliceAxis}
          onSliceAxis={(axis) => {
            setSliceAxis(axis);
            const offset = { X: 0, Y: 2, Z: 4 }[axis];
            setSliceIndex(wholeExtent[offset] ?? 0);
          }}
          sliceIndex={clampedSliceIndex}
          onSliceIndex={setSliceIndex}
          sliceMin={sliceMin}
          sliceMax={sliceMax}
          timestepIndex={timestepIndex}
          onTimestepIndex={(index) => {
            setPlaying(false);
            setTimestepIndex(index);
          }}
          playing={playing}
          onTogglePlayback={() => setPlaying((value) => !value)}
        />
      </div>
    </div>
  );
}
