import type { Dataset, Representation } from "../types";
import { formatBounds, formatCount } from "../lib/format";

interface Props {
  dataset: Dataset | null;
  representation: Representation;
  onRepresentation: (r: Representation) => void;
  colorBy: string | null;
  onColorBy: (name: string | null) => void;
  onScreenshot: () => void;
  onResetCamera: () => void;
}

const REPRESENTATIONS: Representation[] = ["surface", "wireframe", "points"];

export function PropertiesPanel({
  dataset,
  representation,
  onRepresentation,
  colorBy,
  onColorBy,
  onScreenshot,
  onResetCamera,
}: Props) {
  if (!dataset) {
    return (
      <aside className="panel panel-right">
        <h2>プロパティ</h2>
        <p className="muted">データセットを選択すると詳細が表示されます。</p>
      </aside>
    );
  }

  const pointArrays = (dataset.arrays ?? []).filter((a) => a.association === "point");

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

      <h3>スカラー着色</h3>
      <select value={colorBy ?? ""} onChange={(e) => onColorBy(e.target.value || null)}>
        <option value="">（なし / 単色）</option>
        {pointArrays.map((a) => (
          <option key={a.name} value={a.name}>
            {a.name} {a.value_range ? `[${a.value_range[0]}, ${a.value_range[1]}]` : ""}
          </option>
        ))}
      </select>

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
    </aside>
  );
}
