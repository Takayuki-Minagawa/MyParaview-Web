import { useCallback, useEffect, useMemo, useState } from "react";
import { api, pollJob } from "./api";
import type { Dataset, Project, Representation } from "./types";
import { DatasetPanel } from "./components/DatasetPanel";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { VtkViewer } from "./components/VtkViewer";

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [representation, setRepresentation] = useState<Representation>("surface");
  const [colorBy, setColorBy] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [screenshotNonce, setScreenshotNonce] = useState(0);
  const [resetNonce, setResetNonce] = useState(0);

  const guard = useCallback(async (fn: () => Promise<void>) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshDatasets = useCallback(
    (projectId: string) =>
      guard(async () => {
        setDatasets(await api.listDatasets(projectId));
      }),
    [guard],
  );

  useEffect(() => {
    guard(async () => setProjects(await api.listProjects()));
  }, [guard]);

  useEffect(() => {
    if (currentProjectId) refreshDatasets(currentProjectId);
  }, [currentProjectId, refreshDatasets]);

  const createProject = (name: string) =>
    guard(async () => {
      const p = await api.createProject(name);
      setProjects((prev) => [p, ...prev]);
      setCurrentProjectId(p.id);
    });

  const upload = (file: File) =>
    guard(async () => {
      if (!currentProjectId) return;
      setBusy(`${file.name} をアップロード中…`);
      const ds = await api.uploadDataset(currentProjectId, file);
      setBusy("メタデータを解析中…");
      const job = await api.ingest(ds.id);
      await pollJob(job.id, (j) => setBusy(`解析中… ${Math.round(j.progress * 100)}%`));
      await refreshDatasets(currentProjectId);
      setSelectedDatasetId(ds.id);
      setBusy(null);
    }).finally(() => setBusy(null));

  const selectDataset = (id: string) =>
    guard(async () => {
      const ds = await api.getDataset(id);
      setSelectedDatasetId(id);
      setColorBy(null);
      setDatasets((prev) => prev.map((d) => (d.id === id ? ds : d)));
    });

  const selectedDataset = useMemo(
    () => datasets.find((d) => d.id === selectedDatasetId) ?? null,
    [datasets, selectedDatasetId],
  );

  const colorRange = useMemo<[number, number] | null>(() => {
    if (!selectedDataset || !colorBy) return null;
    const arr = (selectedDataset.arrays ?? []).find((a) => a.name === colorBy);
    return arr?.value_range ?? null;
  }, [selectedDataset, colorBy]);

  const viewerUrl =
    selectedDataset && selectedDataset.status === "ready"
      ? api.downloadUrl(selectedDataset.id)
      : null;

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">◵ PVWeb</span>
        <span className="subtitle">ParaView類似 Web可視化 (M1 MVP)</span>
        {error && <span className="error-banner">{error}</span>}
      </header>

      <div className="workspace">
        <DatasetPanel
          projects={projects}
          currentProjectId={currentProjectId}
          onSelectProject={setCurrentProjectId}
          onCreateProject={createProject}
          datasets={datasets}
          selectedDatasetId={selectedDatasetId}
          onSelectDataset={selectDataset}
          onUpload={upload}
          busy={busy}
        />

        <main className="center">
          <VtkViewer
            url={viewerUrl}
            datasetType={selectedDataset?.dataset_type}
            representation={representation}
            colorByArray={colorBy}
            colorRange={colorRange}
            screenshotNonce={screenshotNonce}
            resetNonce={resetNonce}
          />
        </main>

        <PropertiesPanel
          dataset={selectedDataset}
          representation={representation}
          onRepresentation={setRepresentation}
          colorBy={colorBy}
          onColorBy={setColorBy}
          onScreenshot={() => setScreenshotNonce((n) => n + 1)}
          onResetCamera={() => setResetNonce((n) => n + 1)}
        />
      </div>
    </div>
  );
}
