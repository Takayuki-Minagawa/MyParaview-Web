import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { useMessages } from "../i18n-context";
import { humanFileSize } from "../lib/format";
import type { Dataset } from "../types";

interface Props {
  projectId: string | null;
  datasets: Dataset[];
  selectedDatasetId: string | null;
  canEditTags: boolean;
  onSelectDataset: (id: string) => void;
  onUpdateDatasetTags: (id: string, tags: string[]) => Promise<Dataset | null>;
  onError: (message: string) => void;
}

function splitTags(value: string): string[] {
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

export function DatasetList({
  projectId,
  datasets,
  selectedDatasetId,
  canEditTags,
  onSelectDataset,
  onUpdateDatasetTags,
  onError,
}: Props) {
  const t = useMessages();
  const [nameFilter, setNameFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [searchResults, setSearchResults] = useState<Dataset[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const activeProjectRef = useRef(projectId);
  const searchRequestRef = useRef(0);

  useEffect(() => {
    activeProjectRef.current = projectId;
    searchRequestRef.current += 1;
    setNameFilter("");
    setTagFilter("");
    setSearchResults(null);
    setSearching(false);
    setEditingId(null);
    setTagDraft("");
    setUpdatingId(null);
  }, [projectId]);

  const visibleDatasets = searchResults ?? datasets;

  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId) return;
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    setSearching(true);
    try {
      const next = await api.listDatasets(projectId, {
        name: nameFilter,
        tag: tagFilter,
      });
      if (
        searchRequestRef.current === requestId
        && activeProjectRef.current === projectId
      ) {
        setSearchResults(next);
      }
    } catch (reason) {
      if (
        searchRequestRef.current === requestId
        && activeProjectRef.current === projectId
      ) {
        onError(String(reason));
      }
    } finally {
      if (
        searchRequestRef.current === requestId
        && activeProjectRef.current === projectId
      ) {
        setSearching(false);
      }
    }
  };

  const clearSearch = () => {
    searchRequestRef.current += 1;
    setNameFilter("");
    setTagFilter("");
    setSearchResults(null);
    setSearching(false);
  };

  const saveTags = async (dataset: Dataset) => {
    setUpdatingId(dataset.id);
    let updated: Dataset | null = null;
    try {
      updated = await onUpdateDatasetTags(dataset.id, splitTags(tagDraft));
    } catch (reason) {
      onError(String(reason));
    } finally {
      setUpdatingId(null);
    }
    if (!updated) return;
    setSearchResults((previous) => previous?.map(
      (item) => (item.id === updated.id ? updated : item),
    ) ?? null);
    setEditingId(null);
    setTagDraft("");
  };

  return (
    <>
      <form className="dataset-search" onSubmit={search}>
        <label>
          <span>{t.datasetPanel.searchNameLabel}</span>
          <input
            value={nameFilter}
            placeholder={t.datasetPanel.searchNamePlaceholder}
            disabled={!projectId || searching}
            onChange={(event) => setNameFilter(event.target.value)}
          />
        </label>
        <label>
          <span>{t.datasetPanel.tagFilterLabel}</span>
          <input
            value={tagFilter}
            placeholder={t.datasetPanel.tagFilterPlaceholder}
            disabled={!projectId || searching}
            onChange={(event) => setTagFilter(event.target.value)}
          />
        </label>
        <div className="dataset-search-actions">
          <button type="submit" disabled={!projectId || searching}>
            {searching ? t.datasetPanel.searching : t.datasetPanel.search}
          </button>
          <button
            type="button"
            disabled={!projectId || searching || (
              searchResults === null && !nameFilter && !tagFilter
            )}
            onClick={clearSearch}
          >
            {t.datasetPanel.clearSearch}
          </button>
        </div>
      </form>

      <ul className="dataset-list">
        {visibleDatasets.map((dataset) => {
          const editing = editingId === dataset.id;
          const updating = updatingId === dataset.id;
          return (
            <li
              key={dataset.id}
              className={dataset.id === selectedDatasetId ? "selected" : ""}
            >
              <button
                type="button"
                className="dataset-select-button"
                aria-pressed={dataset.id === selectedDatasetId}
                onClick={() => onSelectDataset(dataset.id)}
              >
                <span className="ds-name">{dataset.filename}</span>
                <span className={`badge badge-${dataset.status}`}>
                  {t.datasetStatus[dataset.status]}
                </span>
                <span className="ds-meta">
                  {dataset.dataset_type ?? dataset.ext} · {humanFileSize(dataset.size_bytes)}
                </span>
                {(dataset.tags?.length ?? 0) > 0 && (
                  <span className="ds-tags" aria-label={t.datasetPanel.tagsLabel}>
                    {dataset.tags?.map((tag) => (
                      <span className="tag-chip" key={tag}>{tag}</span>
                    ))}
                  </span>
                )}
              </button>
              {canEditTags && !editing && (
                <button
                  type="button"
                  className="link-button dataset-tag-edit"
                  aria-label={`${dataset.filename}${t.datasetPanel.editTagsLabel}`}
                  onClick={() => {
                    setEditingId(dataset.id);
                    setTagDraft((dataset.tags ?? []).join(", "));
                  }}
                >
                  {t.datasetPanel.editTags}
                </button>
              )}
              {editing && (
                <div className="dataset-tag-editor">
                  <label>
                    <span>{t.datasetPanel.tagsInputLabel}</span>
                    <input
                      value={tagDraft}
                      placeholder={t.datasetPanel.tagsInputPlaceholder}
                      disabled={updating}
                      onChange={(event) => setTagDraft(event.target.value)}
                    />
                  </label>
                  <div className="row">
                    <button
                      type="button"
                      disabled={updating}
                      onClick={() => void saveTags(dataset)}
                    >
                      {updating ? t.datasetPanel.updatingTags : t.common.save}
                    </button>
                    <button
                      type="button"
                      disabled={updating}
                      onClick={() => {
                        setEditingId(null);
                        setTagDraft("");
                      }}
                    >
                      {t.common.cancel}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {visibleDatasets.length === 0 && projectId && (
          <li className="empty">
            {searchResults === null
              ? t.datasetPanel.emptyDatasets
              : t.datasetPanel.noMatchingDatasets}
          </li>
        )}
      </ul>
    </>
  );
}
