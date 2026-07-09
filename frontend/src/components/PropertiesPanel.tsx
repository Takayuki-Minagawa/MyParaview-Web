import { useEffect, useRef, useState } from "react";
import type {
  ColorMapName,
  Dataset,
  Representation,
  ScalarSelection,
  Artifact,
  ImageMode,
  SliceAxis,
  TableCoordinates,
  AssistProposal,
} from "../types";
import { api } from "../api";
import { formatBounds, formatCount, humanFileSize } from "../lib/format";

interface Props {
  dataset: Dataset | null;
  representation: Representation;
  onRepresentation: (r: Representation) => void;
  colorBy: ScalarSelection | null;
  onColorBy: (selection: ScalarSelection | null) => void;
  dataColorRange: [number, number] | null;
  customColorRange: [number, number] | null;
  onCustomColorRange: (range: [number, number] | null) => void;
  opacity: number;
  onOpacity: (opacity: number) => void;
  colorMap: ColorMapName;
  onColorMap: (name: ColorMapName) => void;
  legendVisible: boolean;
  onLegendVisible: (visible: boolean) => void;
  onScreenshot: () => void;
  onResetCamera: () => void;
  artifacts: Artifact[];
  onExport: () => void;
  exportPending: boolean;
  filterPending: boolean;
  serverFilterAvailable: boolean;
  onRunFilter: (params: Record<string, unknown>) => void;
  tableCoordinates: TableCoordinates | null;
  onTableCoordinates: (coordinates: TableCoordinates) => void;
  imageMode: ImageMode;
  onImageMode: (mode: ImageMode) => void;
  sliceAxis: SliceAxis;
  onSliceAxis: (axis: SliceAxis) => void;
  sliceIndex: number;
  onSliceIndex: (index: number) => void;
  sliceMin: number;
  sliceMax: number;
  timestepIndex: number;
  onTimestepIndex: (index: number) => void;
  playing: boolean;
  onTogglePlayback: () => void;
}

const REPRESENTATIONS: Representation[] = ["surface", "wireframe", "points"];

function RangeEditor({
  range,
  disabled,
  onChange,
}: {
  range: [number, number] | null;
  disabled: boolean;
  onChange: (range: [number, number]) => void;
}) {
  const [draft, setDraft] = useState<[string, string]>(["", ""]);
  useEffect(() => {
    setDraft(range ? [String(range[0]), String(range[1])] : ["", ""]);
  }, [range]);

  const commit = () => {
    const next: [number, number] = [Number(draft[0]), Number(draft[1])];
    if (draft.every((value) => value.trim() !== "") && next.every(Number.isFinite)) {
      onChange(next);
    } else {
      setDraft(range ? [String(range[0]), String(range[1])] : ["", ""]);
    }
  };
  const invalid = !!range && range[0] >= range[1];

  return (
    <div className="range-inputs">
      <input
        type="number"
        aria-label="カラー範囲の最小値"
        aria-invalid={invalid}
        aria-describedby={invalid ? "color-range-error" : undefined}
        value={draft[0]}
        disabled={disabled}
        onChange={(e) => setDraft([e.target.value, draft[1]])}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      <span>〜</span>
      <input
        type="number"
        aria-label="カラー範囲の最大値"
        aria-invalid={invalid}
        aria-describedby={invalid ? "color-range-error" : undefined}
        value={draft[1]}
        disabled={disabled}
        onChange={(e) => setDraft([draft[0], e.target.value])}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </div>
  );
}

export function PropertiesPanel({
  dataset,
  representation,
  onRepresentation,
  colorBy,
  onColorBy,
  dataColorRange,
  customColorRange,
  onCustomColorRange,
  opacity,
  onOpacity,
  colorMap,
  onColorMap,
  legendVisible,
  onLegendVisible,
  onScreenshot,
  onResetCamera,
  artifacts,
  onExport,
  exportPending,
  filterPending,
  serverFilterAvailable,
  onRunFilter,
  tableCoordinates,
  onTableCoordinates,
  imageMode,
  onImageMode,
  sliceAxis,
  onSliceAxis,
  sliceIndex,
  onSliceIndex,
  sliceMin,
  sliceMax,
  timestepIndex,
  onTimestepIndex,
  playing,
  onTogglePlayback,
}: Props) {
  const [serverFilter, setServerFilter] = useState<"slice" | "clip" | "contour" | "threshold">("contour");
  const [filterArray, setFilterArray] = useState("");
  const [filterMinimum, setFilterMinimum] = useState("0");
  const [filterMaximum, setFilterMaximum] = useState("1");
  const [assistantPrompt, setAssistantPrompt] = useState("");
  const [assistantProposal, setAssistantProposal] = useState<{
    value: AssistProposal;
    datasetId: string;
    prompt: string;
  } | null>(null);
  const [assistantPending, setAssistantPending] = useState(false);
  const [assistantError, setAssistantError] = useState<string | null>(null);
  const assistantRequestRef = useRef(0);
  const datasetIdRef = useRef(dataset?.id ?? "");
  const assistantPromptRef = useRef(assistantPrompt);
  datasetIdRef.current = dataset?.id ?? "";
  assistantPromptRef.current = assistantPrompt;

  useEffect(() => {
    assistantRequestRef.current += 1;
    setAssistantPrompt("");
    setAssistantProposal(null);
    setAssistantPending(false);
    setAssistantError(null);
  }, [dataset?.id]);

  useEffect(() => {
    const scalar = (dataset?.arrays ?? []).find(
      (array) =>
        (array.association === "point" || array.association === "cell") &&
        array.num_components === 1,
    );
    if (scalar) setFilterArray(`${scalar.association}:${scalar.name}`);
    else setFilterArray("");
    const range = scalar?.value_range;
    if (range) {
      setFilterMinimum(String(range[0]));
      setFilterMaximum(String(range[1]));
    } else {
      setFilterMinimum("0");
      setFilterMaximum("1");
    }
  }, [dataset?.id, dataset?.arrays]);

  if (!dataset) {
    return (
      <aside className="panel panel-right">
        <h2>プロパティ</h2>
        <p className="muted">データセットを選択すると詳細が表示されます。</p>
      </aside>
    );
  }

  const renderType = dataset.dataset_type === "Collection"
    ? String(dataset.extra?.inner_type ?? "")
    : dataset.dataset_type;
  const isImageData = renderType === "ImageData";
  const timesteps = dataset.timesteps ?? [];
  const colorArrays = (dataset.arrays ?? []).filter(
    (a) =>
      a.association === "point" ||
      (a.association === "cell" && !isImageData) ||
      (dataset.dataset_type === "Table" && a.association === "table" && a.data_type === "numeric"),
  );
  const selectionValue = colorBy ? `${colorBy.association}:${colorBy.name}` : "";
  const displayedRange = customColorRange ?? dataColorRange;
  const serverArrays = (dataset.arrays ?? []).filter(
    (array) =>
      (array.association === "point" || array.association === "cell") &&
      array.num_components === 1,
  );
  const filterMinimumNumber = Number(filterMinimum);
  const filterMaximumNumber = Number(filterMaximum);
  const filterNumbersValid =
    filterMinimum.trim() !== "" &&
    Number.isFinite(filterMinimumNumber) &&
    (serverFilter !== "threshold" || (
      filterMaximum.trim() !== "" &&
      Number.isFinite(filterMaximumNumber) &&
      filterMinimumNumber <= filterMaximumNumber
    ));
  const runFilter = () => {
    const axis = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[sliceAxis];
    const bounds = dataset.bounds ?? [0, 0, 0, 0, 0, 0];
    const origin = [
      (bounds[0] + bounds[1]) / 2,
      (bounds[2] + bounds[3]) / 2,
      (bounds[4] + bounds[5]) / 2,
    ];
    if (serverFilter === "slice" || serverFilter === "clip") {
      onRunFilter({ filter: serverFilter, origin, normal: axis });
      return;
    }
    const [association, ...nameParts] = filterArray.split(":");
    const array = nameParts.join(":");
    if (!array) return;
    if (serverFilter === "contour") {
      onRunFilter({
        filter: serverFilter,
        array,
        association: association === "cell" ? "CELLS" : "POINTS",
        value: Number(filterMinimum),
      });
    } else {
      onRunFilter({
        filter: serverFilter,
        array,
        association: association === "cell" ? "CELLS" : "POINTS",
        minimum: Number(filterMinimum),
        maximum: Number(filterMaximum),
      });
    }
  };

  return (
    <aside className="panel panel-right">
      <h2>プロパティ</h2>

      <table className="meta-table">
        <tbody>
          <tr><th>形式</th><td>{dataset.dataset_type ?? "-"}</td></tr>
          <tr><th>状態</th><td>{dataset.status}</td></tr>
          <tr><th>点数</th><td>{formatCount(dataset.num_points)}</td></tr>
          <tr><th>セル数</th><td>{formatCount(dataset.num_cells)}</td></tr>
          <tr><th>ブロック</th><td>{formatCount(dataset.num_blocks)}</td></tr>
          <tr><th>境界</th><td className="mono">{formatBounds(dataset.bounds)}</td></tr>
          {dataset.timesteps && (
            <tr><th>時刻</th><td>{dataset.timesteps.length} steps</td></tr>
          )}
        </tbody>
      </table>

      <h3>表示</h3>
      {!isImageData && (
        <div className="row">
          {REPRESENTATIONS.map((r) => (
            <label key={r} className="radio">
              <input
                type="radio"
                name="repr"
                checked={representation === r}
                onChange={() => onRepresentation(r)}
              />
              {r}
            </label>
          ))}
        </div>
      )}

      {dataset.dataset_type === "Collection" && (
        <div className="display-controls time-controls">
          <strong>PVD 時系列</strong>
          <div className="row">
            <button disabled={timesteps.length < 2} onClick={onTogglePlayback}>
              {playing ? "一時停止" : "再生"}
            </button>
            <span className="mono">
              step {Math.min(timestepIndex, Math.max(0, timesteps.length - 1))} / {Math.max(0, timesteps.length - 1)}
              {timesteps.length ? ` · t=${timesteps[timestepIndex] ?? timesteps[0]}` : ""}
            </span>
          </div>
          <input
            type="range"
            aria-label="PVDタイムステップ"
            min="0"
            max={Math.max(0, timesteps.length - 1)}
            step="1"
            value={Math.min(timestepIndex, Math.max(0, timesteps.length - 1))}
            disabled={timesteps.length < 2}
            onChange={(event) => onTimestepIndex(Number(event.target.value))}
          />
        </div>
      )}

      {dataset.dataset_type === "Table" && tableCoordinates && (
        <div className="display-controls table-coordinates">
          <strong>Table-to-Points 座標列</strong>
          {(["x", "y", "z"] as const).map((axis) => (
            <label key={axis}>
              {axis.toUpperCase()}
              <select
                value={tableCoordinates[axis]}
                onChange={(event) =>
                  onTableCoordinates({ ...tableCoordinates, [axis]: event.target.value })
                }
              >
                {(dataset.arrays ?? [])
                  .filter((array) => array.association === "table" && array.data_type === "numeric")
                  .map((array) => <option key={array.name} value={array.name}>{array.name}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}

      {isImageData && (
        <div className="display-controls image-controls">
          <strong>ImageData 表示</strong>
          <div className="row">
            {(["slice", "volume"] as ImageMode[]).map((mode) => (
              <label className="radio" key={mode}>
                <input
                  type="radio"
                  name="image-mode"
                  checked={imageMode === mode}
                  onChange={() => onImageMode(mode)}
                />
                {mode}
              </label>
            ))}
          </div>
          {imageMode === "slice" && (
            <>
              <label>
                Slice軸
                <select value={sliceAxis} onChange={(event) => onSliceAxis(event.target.value as SliceAxis)}>
                  <option value="X">X</option>
                  <option value="Y">Y</option>
                  <option value="Z">Z</option>
                </select>
              </label>
              <label>
                Slice {sliceIndex} ({sliceMin}–{sliceMax})
                <input
                  type="range"
                  min={sliceMin}
                  max={sliceMax}
                  step="1"
                  value={Math.max(sliceMin, Math.min(sliceIndex, sliceMax))}
                  onChange={(event) => onSliceIndex(Number(event.target.value))}
                />
              </label>
            </>
          )}
        </div>
      )}

      <label className="opacity-control">
        不透明度 {Math.round(opacity * 100)}%
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={opacity}
          onChange={(e) => onOpacity(Number(e.target.value))}
        />
      </label>

      <h3>スカラー着色</h3>
      <label className="sr-only" htmlFor="scalar-color-selection">着色するデータ配列</label>
      <select
        id="scalar-color-selection"
        value={selectionValue}
        onChange={(e) => {
          const [association, ...nameParts] = e.target.value.split(":");
          onColorBy(
            e.target.value
              ? {
                  association: association as ScalarSelection["association"],
                  name: nameParts.join(":"),
                }
              : null,
          );
        }}
      >
        <option value="" disabled={isImageData}>
          （なし / 単色）
        </option>
        {colorArrays.map((a) => {
          const association = a.association === "table" ? "point" : a.association;
          return (
          <option key={`${a.association}:${a.name}`} value={`${association}:${a.name}`}>
            {a.association === "table" ? "point (table)" : a.association} · {a.name}{" "}
            {a.value_range ? `[${a.value_range[0]}, ${a.value_range[1]}]` : ""}
          </option>
          );
        })}
      </select>

      {colorBy && (
        <div className="display-controls">
          <label>
            カラーマップ
            <select value={colorMap} onChange={(e) => onColorMap(e.target.value as ColorMapName)}>
              <option value="cool-to-warm">Cool to Warm</option>
              <option value="viridis">Viridis</option>
              <option value="grayscale">Grayscale</option>
            </select>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={customColorRange !== null}
              disabled={!dataColorRange}
              onChange={(e) => onCustomColorRange(e.target.checked ? dataColorRange : null)}
            />
            手動レンジ
          </label>
          <RangeEditor
            range={displayedRange}
            disabled={customColorRange === null}
            onChange={onCustomColorRange}
          />

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={legendVisible}
              onChange={(e) => onLegendVisible(e.target.checked)}
            />
            カラーレジェンドを表示
          </label>
          {customColorRange && customColorRange[0] >= customColorRange[1] && (
            <p id="color-range-error" className="validation-error" role="alert">
              最小値は最大値より小さくしてください。
            </p>
          )}
        </div>
      )}

      <h3>配列一覧</h3>
      <ul className="array-list">
        {(dataset.arrays ?? []).map((a) => (
          <li key={`${a.association}:${a.name}`}>
            <span className={`chip chip-${a.association}`}>{a.association}</span>
            {a.name}
            {a.num_components > 1 ? ` (${a.num_components})` : ""}
          </li>
        ))}
      </ul>

      <div className="row actions">
        <button onClick={onResetCamera}>カメラリセット</button>
        <button onClick={onScreenshot}>スクリーンショット</button>
      </div>

      <h3>サーバフィルタ</h3>
      <div className="display-controls">
        {!serverFilterAvailable && (
          <p className="muted">ParaView worker未設定のため、実行は無効です。</p>
        )}
        <label>
          フィルタ
          <select value={serverFilter} onChange={(event) => setServerFilter(event.target.value as typeof serverFilter)}>
            <option value="slice">Slice</option>
            <option value="clip">Clip</option>
            <option value="contour">Contour</option>
            <option value="threshold">Threshold</option>
          </select>
        </label>
        {(serverFilter === "slice" || serverFilter === "clip") ? (
          <p className="muted">{sliceAxis}軸法線・データ境界中心を使用</p>
        ) : (
          <>
            <label>
              配列
              <select value={filterArray} onChange={(event) => setFilterArray(event.target.value)}>
                {serverArrays.map((array) => (
                  <option key={`${array.association}:${array.name}`} value={`${array.association}:${array.name}`}>
                    {array.association} · {array.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {serverFilter === "contour" ? "等値" : "最小値"}
              <input type="number" value={filterMinimum} onChange={(event) => setFilterMinimum(event.target.value)} />
            </label>
            {serverFilter === "threshold" && (
              <label>
                最大値
                <input type="number" value={filterMaximum} onChange={(event) => setFilterMaximum(event.target.value)} />
              </label>
            )}
          </>
        )}
        <button
          disabled={
            !serverFilterAvailable ||
            filterPending ||
            ((serverFilter === "contour" || serverFilter === "threshold") && !filterArray) ||
            ((serverFilter === "contour" || serverFilter === "threshold") &&
              !serverArrays.some((array) => `${array.association}:${array.name}` === filterArray)) ||
            !filterNumbersValid
          }
          onClick={runFilter}
        >
          {filterPending ? "実行中…" : "フィルタを実行"}
        </button>
      </div>

      <h3>AI操作アシスタント</h3>
      <div className="display-controls">
        <label>
          操作したい内容
          <textarea
            rows={3}
            value={assistantPrompt}
            placeholder="例: temperature の等値面を作りたい"
            onChange={(event) => {
              assistantRequestRef.current += 1;
              setAssistantPrompt(event.target.value);
              setAssistantProposal(null);
              setAssistantPending(false);
            }}
          />
        </label>
        <button
          disabled={assistantPending || !assistantPrompt.trim()}
          onClick={() => {
            const requestId = ++assistantRequestRef.current;
            const requestedDatasetId = dataset.id;
            const requestedPrompt = assistantPrompt.trim();
            setAssistantPending(true);
            setAssistantError(null);
            void api.proposeAssistance(requestedDatasetId, requestedPrompt)
              .then((value) => {
                if (
                  assistantRequestRef.current === requestId &&
                  datasetIdRef.current === requestedDatasetId &&
                  assistantPromptRef.current.trim() === requestedPrompt
                ) setAssistantProposal({ value, datasetId: requestedDatasetId, prompt: requestedPrompt });
              })
              .catch((reason) => {
                if (assistantRequestRef.current === requestId) setAssistantError(String(reason));
              })
              .finally(() => {
                if (assistantRequestRef.current === requestId) setAssistantPending(false);
              });
          }}
        >
          {assistantPending ? "提案中…" : "変更案を作る"}
        </button>
        {assistantError && <p className="validation-error">{assistantError}</p>}
        {assistantProposal && (
          <div className="proposal-diff">
            <p>{assistantProposal.value.reason}</p>
            <pre>{JSON.stringify(assistantProposal.value.params, null, 2)}</pre>
            {assistantProposal.value.action !== "none" && assistantProposal.value.requires_confirmation && (
              <button
                disabled={
                  assistantProposal.value.action === "filter_job" &&
                  (!serverFilterAvailable || filterPending)
                }
                onClick={() => {
                  if (
                    assistantProposal.datasetId !== dataset.id ||
                    assistantProposal.prompt !== assistantPrompt.trim() ||
                    !assistantProposal.value.requires_confirmation
                  ) return;
                  if (assistantProposal.value.action === "filter_job") {
                    onRunFilter(assistantProposal.value.params);
                  } else {
                    const color = assistantProposal.value.params.color_by as Partial<ScalarSelection> | undefined;
                    const map = assistantProposal.value.params.color_map;
                    if (
                      color?.name &&
                      (color.association === "point" || color.association === "cell")
                    ) onColorBy(color as ScalarSelection);
                    if (map === "cool-to-warm" || map === "viridis" || map === "grayscale") {
                      onColorMap(map);
                    }
                  }
                  setAssistantProposal(null);
                }}
              >
                差分を確認して適用
              </button>
            )}
          </div>
        )}
      </div>

      <h3>Artifacts</h3>
      <button disabled={exportPending} onClick={onExport}>
        {exportPending ? "書き出し中…" : "元データを書き出す"}
      </button>
      <ul className="artifact-list">
        {artifacts.map((artifact) => (
          <li key={artifact.id}>
            <button
              className="link-button"
              onClick={() => {
                void api.downloadArtifact(artifact.id).then((blob) => {
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = artifact.filename;
                  link.click();
                  window.setTimeout(() => URL.revokeObjectURL(url), 0);
                });
              }}
            >
              {artifact.filename}
            </button>
            <span>{artifact.kind} · {humanFileSize(artifact.size_bytes)}</span>
          </li>
        ))}
        {artifacts.length === 0 && <li className="muted">生成済みArtifactはありません。</li>}
      </ul>
    </aside>
  );
}
