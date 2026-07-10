import { useState } from "react";
import type { Pipeline } from "../types";

interface Props {
  pipelines: Pipeline[];
  canSave: boolean;
  onSave: (name: string) => void;
  onRestore: (pipeline: Pipeline) => void;
  onDelete: (pipeline: Pipeline) => void;
}

export function PipelinePanel({ pipelines, canSave, onSave, onRestore, onDelete }: Props) {
  const [name, setName] = useState("");
  return (
    <section className="pipeline-browser">
      <h2>Pipeline / 表示状態</h2>
      <div className="row">
        <input
          aria-label="保存する表示状態名"
          placeholder="表示状態名"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          disabled={!canSave || !name.trim()}
          onClick={() => {
            onSave(name.trim());
            setName("");
          }}
        >
          保存
        </button>
      </div>
      <ul className="pipeline-list">
        {pipelines.map((pipeline) => (
          <li key={pipeline.id}>
            <strong>{pipeline.name}</strong>
            <div className="pipeline-tree">
              {(pipeline.nodes ?? []).map((node, index) => (
                <span key={node.id}>{index ? " → " : ""}{node.name}</span>
              ))}
            </div>
            <div className="row">
              <button aria-label={`${pipeline.name} を復元`} onClick={() => onRestore(pipeline)}>
                復元
              </button>
              <button aria-label={`${pipeline.name} を削除`} onClick={() => onDelete(pipeline)}>
                削除
              </button>
            </div>
          </li>
        ))}
        {pipelines.length === 0 && <li className="empty">保存済み状態はありません。</li>}
      </ul>
    </section>
  );
}
