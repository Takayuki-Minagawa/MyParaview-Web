import { memo, useEffect, useRef, useState } from "react";
import type { AuditEvent, Dataset, Job, Project, ProjectMember, ProjectRole } from "../types";
import { api } from "../api";
import { humanFileSize } from "../lib/format";
import { triggerBlobDownload } from "../lib/download";
import { isCancellable, lastLogLine } from "../lib/job";
import { PipelinePanel } from "./PipelinePanel";
import type { Pipeline } from "../types";
import { useMessages } from "../i18n-context";

interface Props {
  projects: Project[];
  currentProjectId: string | null;
  onSelectProject: (id: string) => void;
  onCreateProject: (name: string) => void;
  membership: ProjectMember | null;
  members: ProjectMember[];
  onPutMember: (userId: string, role: ProjectRole) => void;
  onDeleteMember: (userId: string) => void;
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
  serverRunAvailable: boolean;
  onSavePipeline: (name: string) => void;
  onRestorePipeline: (pipeline: Pipeline) => void;
  onDeletePipeline: (pipeline: Pipeline) => void;
  onRenamePipeline: (pipeline: Pipeline, name: string) => void;
  onRunPipeline: (pipeline: Pipeline) => void;
  onError: (message: string) => void;
}

function AuditSection({
  projectId,
  onError,
}: {
  projectId: string;
  onError: (message: string) => void;
}) {
  const t = useMessages();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [loading, setLoading] = useState(false);

  // A project switch must not keep showing the previous project's events,
  // and a late response for the old project must not surface either.
  const activeProjectRef = useRef(projectId);
  useEffect(() => {
    activeProjectRef.current = projectId;
    setEvents(null);
  }, [projectId]);

  const toggle = () => {
    if (events !== null) {
      setEvents(null);
      return;
    }
    const requested = projectId;
    setLoading(true);
    api.listAuditEvents(requested, 50)
      .then((next) => {
        if (activeProjectRef.current === requested) setEvents(next);
      })
      .catch((reason) => onError(String(reason)))
      .finally(() => setLoading(false));
  };

  const downloadCsv = () => {
    api.downloadAuditCsv(projectId)
      .then((blob) => triggerBlobDownload(blob, "audit.csv"))
      .catch((reason) => onError(String(reason)));
  };

  return (
    <section className="audit-log" aria-label={t.datasetPanel.auditLog}>
      <h3>{t.datasetPanel.auditLog}</h3>
      <div className="row">
        <button onClick={toggle} disabled={loading}>
          {events === null ? t.datasetPanel.auditShow : t.datasetPanel.auditHide}
        </button>
        <button onClick={downloadCsv}>{t.datasetPanel.auditDownloadCsv}</button>
      </div>
      {events !== null && (
        <ul className="audit-list">
          {events.map((event) => (
            <li key={event.id}>
              <span className="mono">{new Date(event.created_at).toLocaleString()}</span>{" "}
              <span className="badge">{event.action}</span> {event.resource_type}
              {event.actor_id ? ` · ${event.actor_id}` : ""} · {event.status_code}
            </li>
          ))}
          {events.length === 0 && <li className="empty">{t.datasetPanel.auditEmpty}</li>}
        </ul>
      )}
    </section>
  );
}

export const DatasetPanel = memo(function DatasetPanel(props: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const bundleRef = useRef<HTMLInputElement | null>(null);
  const [newName, setNewName] = useState("");
  const [memberId, setMemberId] = useState("");
  const [memberRole, setMemberRole] = useState<ProjectRole>("viewer");
  const t = useMessages();

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
                <button
                  className="danger-button"
                  aria-label={`${member.user_id}${t.datasetPanel.removeMemberLabel}`}
                  onClick={() => props.onDeleteMember(member.user_id)}
                >
                  {t.common.remove}
                </button>
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
          {props.currentProjectId && (
            <AuditSection projectId={props.currentProjectId} onError={props.onError} />
          )}
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
            role="button"
            tabIndex={0}
            aria-pressed={d.id === props.selectedDatasetId}
            onClick={() => props.onSelectDataset(d.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onSelectDataset(d.id);
              }
            }}
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
        pipelines={props.pipelines}
        canSave={props.canSavePipeline}
        serverRunAvailable={props.serverRunAvailable}
        onSave={props.onSavePipeline}
        onRestore={props.onRestorePipeline}
        onDelete={props.onDeletePipeline}
        onRename={props.onRenamePipeline}
        onRun={props.onRunPipeline}
      />
    </aside>
  );
});
