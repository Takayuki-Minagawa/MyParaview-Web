import { useRef, useState } from "react";
import type { Dataset, Job, Project, ProjectMember, ProjectRole } from "../types";
import { humanFileSize } from "../lib/format";
import { isCancellable, lastLogLine } from "../lib/job";
import { PipelinePanel } from "./PipelinePanel";
import type { Pipeline } from "../types";
import type { Messages } from "../i18n";

interface Props {
  messages: Messages;
  projects: Project[];
  currentProjectId: string | null;
  onSelectProject: (id: string) => void;
  onCreateProject: (name: string) => void;
  membership: ProjectMember | null;
  members: ProjectMember[];
  onPutMember: (userId: string, role: ProjectRole) => void;
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

export function DatasetPanel(props: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const bundleRef = useRef<HTMLInputElement | null>(null);
  const [newName, setNewName] = useState("");
  const [memberId, setMemberId] = useState("");
  const [memberRole, setMemberRole] = useState<ProjectRole>("viewer");
  const t = props.messages;

  return (
    <aside className="panel panel-left">
      <h2>{t.datasetPanel.projects}</h2>
      <select
        value={props.currentProjectId ?? ""}
        onChange={(e) => props.onSelectProject(e.target.value)}
      >
        <option value="" disabled>
          {t.datasetPanel.selectProject}
        </option>
        {props.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <div className="row">
        <input
          placeholder={t.datasetPanel.newProjectName}
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
          {t.common.create}
        </button>
      </div>

      {props.membership?.role === "admin" && (
        <section className="member-admin" aria-label={t.datasetPanel.memberAdmin}>
          <h3>{t.datasetPanel.members}</h3>
          <ul className="member-list">
            {props.members.map((member) => (
              <li key={member.id}>
                <span title={member.user_id}>{member.user_id}</span>
                <span className="badge">{member.role}</span>
              </li>
            ))}
          </ul>
          <div className="row">
            <input
              aria-label={t.datasetPanel.subjectLabel}
              placeholder={t.datasetPanel.subjectPlaceholder}
              value={memberId}
              onChange={(event) => setMemberId(event.target.value)}
            />
            <select
              aria-label={t.datasetPanel.roleLabel}
              value={memberRole}
              onChange={(event) => setMemberRole(event.target.value as ProjectRole)}
            >
              <option value="viewer">viewer</option>
              <option value="editor">editor</option>
              <option value="admin">admin</option>
            </select>
            <button
              disabled={!memberId.trim()}
              onClick={() => {
                const subject = memberId.trim();
                if (!subject) return;
                props.onPutMember(subject, memberRole);
                setMemberId("");
              }}
            >
              {t.datasetPanel.grant}
            </button>
          </div>
        </section>
      )}

      <h2>{t.datasetPanel.datasets}</h2>
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
          aria-label={t.datasetPanel.bundleLabel}
          accept=".pvd,.vtp,.vti,.case,.xdmf,.xmf,.h5,.hdf5,.geo,.scl,.vec,.dat,.bin"
          multiple
          disabled={!props.currentProjectId}
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? []);
            if (selected.length) props.onUploadFiles(selected);
            if (bundleRef.current) bundleRef.current.value = "";
          }}
        />
        <span className="muted">{t.datasetPanel.bundleHelp}</span>
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
            <span className={`badge badge-${d.status}`}>{t.datasetStatus[d.status]}</span>
            <span className="ds-meta">
              {d.dataset_type ?? d.ext} · {humanFileSize(d.size_bytes)}
            </span>
          </li>
        ))}
        {props.datasets.length === 0 && props.currentProjectId && (
          <li className="empty">{t.datasetPanel.emptyDatasets}</li>
        )}
      </ul>

      <h2>{t.datasetPanel.jobs}</h2>
      <ul className="job-list" aria-live="polite">
        {props.jobs.map((job) => (
          <li key={job.id}>
            <div className="job-heading">
              <span>{job.kind}</span>
              <span className={`badge badge-${job.status}`}>{job.status}</span>
            </div>
            <progress value={job.progress} max={1} aria-label={`${job.kind}${t.datasetPanel.progress}`} />
            <div className="job-log" title={lastLogLine(job.log)}>
              {lastLogLine(job.log) || t.datasetPanel.waitingLog}
            </div>
            {isCancellable(job) && (
              <button
                className="danger-button"
                disabled={props.cancelingJobIds.has(job.id)}
                onClick={() => props.onCancelJob(job.id)}
            >
                {props.cancelingJobIds.has(job.id) ? t.common.canceling : t.common.cancel}
              </button>
            )}
          </li>
        ))}
        {props.jobs.length === 0 && <li className="empty">{t.datasetPanel.emptyJobs}</li>}
      </ul>

      <PipelinePanel
        messages={t}
        pipelines={props.pipelines}
        canSave={props.canSavePipeline}
        onSave={props.onSavePipeline}
        onRestore={props.onRestorePipeline}
        onDelete={props.onDeletePipeline}
      />
    </aside>
  );
}
