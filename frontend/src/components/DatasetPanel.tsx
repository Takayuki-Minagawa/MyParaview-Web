import { useRef, useState } from "react";
import type { Dataset, Job, Project } from "../types";
import { humanFileSize } from "../lib/format";
import { isCancellable, lastLogLine } from "../lib/job";
import { PipelinePanel } from "./PipelinePanel";
import type { Pipeline } from "../types";

interface Props {
  projects: Project[];
  currentProjectId: string | null;
  onSelectProject: (id: string) => void;
  onCreateProject: (name: string) => void;
  datasets: Dataset[];
  selectedDatasetId: string | null;
  onSelectDataset: (id: string) => void;
  onUploadFiles: (files: File[]) => void;
  busy: string | null;
  jobs: Job[];
  onCancelJob: (id: string) => void;
  cancelingJobIds: ReadonlySet<string>;
  pipelines: Pipeline[];
  canSavePipeline: boolean;
  onSavePipeline: (name: string) => void;
  onRestorePipeline: (pipeline: Pipeline) => void;
  onDeletePipeline: (pipeline: Pipeline) => void;
}

const STATUS_LABEL: Record<Dataset["status"], string> = {
  registered: "未処理",
  ingesting: "解析中",
  ready: "準備完了",
  error: "エラー",
};

export function DatasetPanel(props: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const bundleRef = useRef<HTMLInputElement | null>(null);
  const [newName, setNewName] = useState("");

  return (
    <aside className="panel panel-left">
      <h2>プロジェクト</h2>
      <select
        value={props.currentProjectId ?? ""}
        onChange={(e) => props.onSelectProject(e.target.value)}
      >
        <option value="" disabled>
          選択…
        </option>
        {props.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <div className="row">
        <input
          placeholder="新規プロジェクト名"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          onClick={() => {
            if (newName.trim()) {
              props.onCreateProject(newName.trim());
              setNewName("");
            }
          }}
        >
          作成
        </button>
      </div>

      <h2>データセット</h2>
      <div className="row">
        <input
          ref={fileRef}
          type="file"
          accept=".vtp,.vti,.vtu,.vts,.vtr,.pvd,.csv,.cgns,.exo,.e,.case,.xdmf,.xmf"
          disabled={!props.currentProjectId}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) props.onUploadFiles([f]);
            if (fileRef.current) fileRef.current.value = "";
          }}
        />
      </div>
      <div className="bundle-upload">
        <input
          ref={(element) => {
            bundleRef.current = element;
            element?.setAttribute("webkitdirectory", "");
          }}
          type="file"
          aria-label="複数ファイルデータセットのフォルダ一式"
          accept=".pvd,.vtp,.vti,.case,.xdmf,.xmf,.h5,.hdf5,.geo,.scl,.vec,.dat,.bin"
          multiple
          disabled={!props.currentProjectId}
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? []);
            if (selected.length) props.onUploadFiles(selected);
            if (bundleRef.current) bundleRef.current.value = "";
          }}
        />
        <span className="muted">PVD / EnSight / XDMF は参照ファイルを含むフォルダ一式を選択</span>
      </div>
      {props.busy && <div className="busy">{props.busy}</div>}

      <ul className="dataset-list">
        {props.datasets.map((d) => (
          <li
            key={d.id}
            className={d.id === props.selectedDatasetId ? "selected" : ""}
            onClick={() => props.onSelectDataset(d.id)}
          >
            <span className="ds-name">{d.filename}</span>
            <span className={`badge badge-${d.status}`}>{STATUS_LABEL[d.status]}</span>
            <span className="ds-meta">
              {d.dataset_type ?? d.ext} · {humanFileSize(d.size_bytes)}
            </span>
          </li>
        ))}
        {props.datasets.length === 0 && props.currentProjectId && (
          <li className="empty">データセットがありません。アップロードしてください。</li>
        )}
      </ul>

      <h2>ジョブセンター</h2>
      <ul className="job-list" aria-live="polite">
        {props.jobs.map((job) => (
          <li key={job.id}>
            <div className="job-heading">
              <span>{job.kind}</span>
              <span className={`badge badge-${job.status}`}>{job.status}</span>
            </div>
            <progress value={job.progress} max={1} aria-label={`${job.kind} の進捗`} />
            <div className="job-log" title={lastLogLine(job.log)}>
              {lastLogLine(job.log) || "ログ待機中"}
            </div>
            {isCancellable(job) && (
              <button
                className="danger-button"
                disabled={props.cancelingJobIds.has(job.id)}
                onClick={() => props.onCancelJob(job.id)}
              >
                {props.cancelingJobIds.has(job.id) ? "キャンセル中…" : "キャンセル"}
              </button>
            )}
          </li>
        ))}
        {props.jobs.length === 0 && <li className="empty">ジョブはありません。</li>}
      </ul>

      <PipelinePanel
        pipelines={props.pipelines}
        canSave={props.canSavePipeline}
        onSave={props.onSavePipeline}
        onRestore={props.onRestorePipeline}
        onDelete={props.onDeletePipeline}
      />
    </aside>
  );
}
