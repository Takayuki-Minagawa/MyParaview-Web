import { useState } from "react";
import type { Pipeline } from "../types";
import type { Messages } from "../i18n";

interface Props {
  messages: Messages;
  pipelines: Pipeline[];
  canSave: boolean;
  onSave: (name: string) => void;
  onRestore: (pipeline: Pipeline) => void;
  onDelete: (pipeline: Pipeline) => void;
}

export function PipelinePanel({ messages, pipelines, canSave, onSave, onRestore, onDelete }: Props) {
  const [name, setName] = useState("");
  return (
    <section className="pipeline-browser">
      <h2>{messages.pipelinePanel.title}</h2>
      <div className="row">
        <input
          aria-label={messages.pipelinePanel.saveNameLabel}
          placeholder={messages.pipelinePanel.saveNamePlaceholder}
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
          {messages.common.save}
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
              <button aria-label={`${pipeline.name}${messages.pipelinePanel.restoreLabel}`} onClick={() => onRestore(pipeline)}>
                {messages.common.restore}
              </button>
              <button aria-label={`${pipeline.name}${messages.pipelinePanel.deleteLabel}`} onClick={() => onDelete(pipeline)}>
                {messages.common.delete}
              </button>
            </div>
          </li>
        ))}
        {pipelines.length === 0 && <li className="empty">{messages.pipelinePanel.empty}</li>}
      </ul>
    </section>
  );
}
