import { memo, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { AuditEvent, Dataset, Job, Project, ProjectMember, ProjectRole } from "../types";
import { api } from "../api";
import { triggerBlobDownload } from "../lib/download";
import { isCancellable, lastLogLine } from "../lib/job";
import { DatasetList } from "./DatasetList";
import { PipelinePanel } from "./PipelinePanel";
import type { Pipeline } from "../types";
import { useMessages } from "../i18n-context";
import { ConnectionSection } from "./ConnectionSection";
import { LocalDataSection } from "./LocalDataSection";
import type { ServerConnection } from "../hooks/useServerConnection";

interface Props {
  connection: ServerConnection;
  buildDiagnostics: () => Record<string, unknown>;
  localDatasets: Dataset[];
  localLoadingLabel: string | null;
  onOpenLocalFiles: (files: File[]) => void;
  onOpenSample: (sampleId: string) => void;
  onRemoveLocalDataset: (id: string) => void;
  projects: Project[];
  currentProjectId: string | null;
  onSelectProject: (id: string) => void;
  /** Resolves true when the project exists; the name is kept on failure. */
  onCreateProject: (name: string) => Promise<boolean>;
  membership: ProjectMember | null;
  members: ProjectMember[];
  onPutMember: (userId: string, role: ProjectRole) => void;
  onDeleteMember: (userId: string) => void;
  datasets: Dataset[];
  selectedDatasetId: string | null;
  onSelectDataset: (id: string) => void;
  onUpdateDatasetTags: (id: string, tags: string[]) => Promise<Dataset | null>;
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
  const [nameError, setNameError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [memberId, setMemberId] = useState("");
  const [memberRole, setMemberRole] = useState<ProjectRole>("viewer");
  const t = useMessages();
  const projectSelectId = useId();
  const newNameId = useId();
  const nameErrorId = useId();
  const singleFileId = useId();
  const bundleId = useId();
  const uploadHintId = useId();
  const serverHintId = useId();
  const connected = props.connection.status === "connected";
  const serverMode = props.connection.mode === "server";
  const uploadDisabledReason = !connected
    ? t.connection.serverFeaturesNeedConnection
    : !props.currentProjectId
      ? t.connection.projectRequired
      : null;

  const submitProject = async (event: FormEvent) => {
    event.preventDefault();
    if (creating) return;
    const name = newName.trim();
    if (!name) {
      setNameError(t.datasetPanel.nameRequired);
      return;
    }
    setNameError(null);
    setCreating(true);
    try {
      // Only a confirmed success clears the field; a failed request keeps the
      // typed name so the user can retry without re-entering it (F-02).
      if (await props.onCreateProject(name)) setNewName("");
      else setNameError(t.datasetPanel.createFailed);
    } finally {
      setCreating(false);
    }
  };

  return (
    <aside className="panel panel-left" id="dataset-panel" aria-label={t.datasetPanel.datasets}>
      <ConnectionSection
        connection={props.connection}
        buildDiagnostics={props.buildDiagnostics}
      />
      <LocalDataSection
        localDatasets={props.localDatasets}
        selectedDatasetId={props.selectedDatasetId}
        loadingLabel={props.localLoadingLabel}
        onOpenFiles={props.onOpenLocalFiles}
        onOpenSample={props.onOpenSample}
        onSelectDataset={props.onSelectDataset}
        onRemoveDataset={props.onRemoveLocalDataset}
      />

      <section
        className={`server-features${connected ? "" : " server-features-disabled"}`}
        aria-labelledby="server-features-title"
        aria-describedby={connected ? undefined : serverHintId}
      >
      <h2 id="server-features-title">{t.datasetPanel.serverSection}</h2>
      {!connected && (
        <p id={serverHintId} className="muted">
          {serverMode && props.connection.status !== "disconnected"
            ? t.connection.serverFeaturesNeedConnection
            : t.connection.connectHelp}
        </p>
      )}
      <h3>{t.datasetPanel.projects}</h3>
      <label htmlFor={projectSelectId}>{t.datasetPanel.projectSelectLabel}</label>
      <select
        id={projectSelectId}
        value={props.currentProjectId ?? ""}
        disabled={!connected}
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
      <form
        className="project-create"
        aria-label={t.datasetPanel.createProjectForm}
        onSubmit={(event) => void submitProject(event)}
      >
        <label htmlFor={newNameId}>{t.datasetPanel.newProjectNameLabel}</label>
        <div className="row">
          <input
            id={newNameId}
            placeholder={t.datasetPanel.newProjectName}
            value={newName}
            disabled={!connected || creating}
            aria-invalid={nameError !== null}
            aria-describedby={nameError ? nameErrorId : undefined}
            onChange={(e) => {
              setNewName(e.target.value);
              if (nameError) setNameError(null);
            }}
          />
          <button type="submit" disabled={!connected || creating}>
            {creating ? t.datasetPanel.creating : t.common.create}
          </button>
        </div>
        {nameError && (
          <p id={nameErrorId} className="validation-error" role="alert">{nameError}</p>
        )}
      </form>

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

      <h3>{t.datasetPanel.datasets}</h3>
      {uploadDisabledReason && (
        <p id={uploadHintId} className="muted">{uploadDisabledReason}</p>
      )}
      <div className="local-open">
        <label htmlFor={singleFileId}>{t.datasetPanel.singleFileLabel}</label>
        <input
          id={singleFileId}
          ref={fileRef}
          type="file"
          accept=".vtp,.vti,.vtu,.vts,.vtr,.pvd,.csv,.cgns,.exo,.e,.case,.xdmf,.xmf"
          disabled={!!uploadDisabledReason}
          aria-describedby={uploadDisabledReason ? uploadHintId : undefined}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) props.onUploadFiles([f]);
            if (fileRef.current) fileRef.current.value = "";
          }}
        />
      </div>
      <div className="bundle-upload local-open">
        <label htmlFor={bundleId}>{t.datasetPanel.bundleLabel}</label>
        <input
          id={bundleId}
          ref={(element) => {
            bundleRef.current = element;
            element?.setAttribute("webkitdirectory", "");
          }}
          type="file"
          accept=".pvd,.vtp,.vti,.case,.xdmf,.xmf,.h5,.hdf5,.geo,.scl,.vec,.dat,.bin"
          multiple
          disabled={!!uploadDisabledReason}
          aria-describedby={uploadDisabledReason ? uploadHintId : undefined}
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? []);
            if (selected.length) props.onUploadFiles(selected);
            if (bundleRef.current) bundleRef.current.value = "";
          }}
        />
        <span className="muted">{t.datasetPanel.bundleHelp}</span>
      </div>
      {props.busy && <div className="busy" role="status">{props.busy}</div>}

      <DatasetList
        projectId={props.currentProjectId}
        datasets={props.datasets}
        selectedDatasetId={props.selectedDatasetId}
        canEditTags={props.membership?.role === "editor" || props.membership?.role === "admin"}
        onSelectDataset={props.onSelectDataset}
        onUpdateDatasetTags={props.onUpdateDatasetTags}
        onError={props.onError}
      />

      <h3>{t.datasetPanel.jobs}</h3>
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
      </section>
    </aside>
  );
});
