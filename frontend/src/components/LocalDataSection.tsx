import { memo, useId, useRef, useState } from "react";
import type { Dataset } from "../types";
import { useMessages } from "../i18n-context";
import { humanFileSize } from "../lib/format";
import { SAMPLES } from "../lib/samples";

interface Props {
  localDatasets: Dataset[];
  selectedDatasetId: string | null;
  loadingLabel: string | null;
  onOpenFiles: (files: File[]) => void;
  onOpenSample: (sampleId: string) => void;
  onSelectDataset: (id: string) => void;
  onRemoveDataset: (id: string) => void;
}

const SINGLE_ACCEPT = ".vtp,.vtu,.vts,.vtr,.vti,.csv";
const FOLDER_ACCEPT = ".pvd,.vtp,.vtu,.vts,.vtr,.vti,.csv";

export const LocalDataSection = memo(function LocalDataSection({
  localDatasets,
  selectedDatasetId,
  loadingLabel,
  onOpenFiles,
  onOpenSample,
  onSelectDataset,
  onRemoveDataset,
}: Props) {
  const t = useMessages();
  const fileId = useId();
  const folderId = useId();
  const sampleId = useId();
  const formatsId = useId();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const folderRef = useRef<HTMLInputElement | null>(null);
  const [sample, setSample] = useState<string>(SAMPLES[0].id);
  const busy = loadingLabel !== null;

  return (
    <section className="local-data" aria-labelledby="local-title">
      <h2 id="local-title">{t.local.title}</h2>
      <p className="muted">{t.local.intro}</p>
      <div className="local-open">
        <label htmlFor={fileId}>{t.local.openFileLabel}</label>
        <input
          id={fileId}
          ref={fileRef}
          type="file"
          accept={SINGLE_ACCEPT}
          aria-describedby={formatsId}
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onOpenFiles([file]);
            if (fileRef.current) fileRef.current.value = "";
          }}
        />
      </div>
      <div className="local-open">
        <label htmlFor={folderId}>{t.local.openFolderLabel}</label>
        <input
          id={folderId}
          ref={(element) => {
            folderRef.current = element;
            element?.setAttribute("webkitdirectory", "");
          }}
          type="file"
          multiple
          accept={FOLDER_ACCEPT}
          aria-describedby={formatsId}
          disabled={busy}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length) onOpenFiles(files);
            if (folderRef.current) folderRef.current.value = "";
          }}
        />
        <span className="muted">{t.local.openFolderHelp}</span>
      </div>
      <div className="local-open">
        <label htmlFor={sampleId}>{t.local.sampleLabel}</label>
        <div className="row">
          <select
            id={sampleId}
            value={sample}
            disabled={busy}
            onChange={(event) => setSample(event.target.value)}
          >
            {SAMPLES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {t.local.sampleNames[entry.id]}
              </option>
            ))}
          </select>
          <button type="button" disabled={busy} onClick={() => onOpenSample(sample)}>
            {t.local.openSample}
          </button>
        </div>
      </div>
      <p id={formatsId} className="muted local-formats" aria-label={t.local.formatHint}>
        {t.local.browserFormats}
        <br />
        {t.local.serverFormats}
      </p>
      {busy && (
        <div className="busy" role="status">{t.local.loading} {loadingLabel}</div>
      )}
      <h3>{t.local.list}</h3>
      <ul className="dataset-list local-dataset-list">
        {localDatasets.map((dataset) => (
          <li key={dataset.id} className={dataset.id === selectedDatasetId ? "selected" : ""}>
            <button
              type="button"
              className="dataset-select-button"
              aria-pressed={dataset.id === selectedDatasetId}
              onClick={() => onSelectDataset(dataset.id)}
            >
              <span className="ds-name">{dataset.filename}</span>
              <span className="badge badge-ready">{t.datasetStatus.ready}</span>
              <span className="ds-meta">
                {dataset.dataset_type ?? dataset.ext} · {humanFileSize(dataset.size_bytes)}
                {dataset.timesteps ? ` · ${dataset.timesteps.length} ${t.properties.stepWord}` : ""}
              </span>
            </button>
            <button
              type="button"
              className="link-button dataset-tag-edit"
              aria-label={`${dataset.filename}${t.local.remove}`}
              onClick={() => onRemoveDataset(dataset.id)}
            >
              {t.common.close}
            </button>
          </li>
        ))}
        {localDatasets.length === 0 && <li className="empty">{t.local.empty}</li>}
      </ul>
    </section>
  );
});
