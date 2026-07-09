import { useRef, useState } from "react";
import type { Dataset, Project } from "../types";
import { humanFileSize } from "../lib/format";

interface Props {
  projects: Project[];
  currentProjectId: string | null;
  onSelectProject: (id: string) => void;
  onCreateProject: (name: string) => void;
  datasets: Dataset[];
  selectedDatasetId: string | null;
  onSelectDataset: (id: string) => void;
  onUpload: (file: File) => void;
  busy: string | null;
}

const STATUS_LABEL: Record<Dataset["status"], string> = {
  registered: "未処理",
  ingesting: "解析中",
  ready: "準備完了",
  error: "エラー",
};

export function DatasetPanel(props: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);
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
          accept=".vtp,.vti,.vtu,.vts,.vtr,.pvd,.csv"
          disabled={!props.currentProjectId}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) props.onUpload(f);
            if (fileRef.current) fileRef.current.value = "";
          }}
        />
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
    </aside>
  );
}
