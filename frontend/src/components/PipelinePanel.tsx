import { memo, useState } from "react";
import type { Pipeline } from "../types";
import { useMessages } from "../i18n-context";

interface Props {
  pipelines: Pipeline[];
  canSave: boolean;
  serverRunAvailable: boolean;
  onSave: (name: string) => void;
  onRestore: (pipeline: Pipeline) => void;
  onDelete: (pipeline: Pipeline) => void;
  onRename: (pipeline: Pipeline, name: string) => void;
  onRun: (pipeline: Pipeline) => void;
}

export const PipelinePanel = memo(function PipelinePanel({
  pipelines,
  canSave,
  serverRunAvailable,
  onSave,
  onRestore,
  onDelete,
  onRename,
  onRun,
}: Props) {
  const messages = useMessages();
  const [name, setName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const hasFilterNode = (pipeline: Pipeline) =>
    (pipeline.nodes ?? []).some((node) => node.node_type === "filter");

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
            {renamingId === pipeline.id ? (
              <div className="row">
                <input
                  aria-label={messages.pipelinePanel.renamePrompt}
                  placeholder={messages.pipelinePanel.renamePrompt}
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                />
                <button
                  disabled={!renameDraft.trim()}
                  onClick={() => {
                    onRename(pipeline, renameDraft.trim());
                    setRenamingId(null);
                  }}
                >
                  {messages.common.save}
                </button>
                <button onClick={() => setRenamingId(null)}>{messages.common.close}</button>
              </div>
            ) : (
              <div className="row">
                <button
                  aria-label={`${pipeline.name}${messages.pipelinePanel.restoreLabel}`}
                  onClick={() => onRestore(pipeline)}
                >
                  {messages.common.restore}
                </button>
                <button
                  aria-label={`${pipeline.name}${messages.pipelinePanel.renameLabel}`}
                  onClick={() => {
                    setRenamingId(pipeline.id);
                    setRenameDraft(pipeline.name);
                  }}
                >
                  {messages.common.rename}
                </button>
                {hasFilterNode(pipeline) && (
                  <button
                    aria-label={`${pipeline.name}${messages.pipelinePanel.runLabel}`}
                    title={messages.pipelinePanel.runHint}
                    disabled={!serverRunAvailable}
                    onClick={() => onRun(pipeline)}
                  >
                    {messages.pipelinePanel.run}
                  </button>
                )}
                <button
                  aria-label={`${pipeline.name}${messages.pipelinePanel.deleteLabel}`}
                  onClick={() => onDelete(pipeline)}
                >
                  {messages.common.delete}
                </button>
              </div>
            )}
          </li>
        ))}
        {pipelines.length === 0 && <li className="empty">{messages.pipelinePanel.empty}</li>}
      </ul>
    </section>
  );
});
