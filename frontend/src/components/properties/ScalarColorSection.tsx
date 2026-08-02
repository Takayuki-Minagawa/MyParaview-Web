import { memo, useEffect, useState } from "react";
import type {
  ArrayInfo,
  BuiltInColorMapName,
  ColorMapName,
  Dataset,
  ScalarSelection,
} from "../../types";
import { isImageScalarArray } from "../../lib/imageData";
import { registeredCustomColorMaps } from "../../lib/colormap";
import { importParaViewColorMapPreset } from "../../lib/paraviewPreset";
import { useMessages } from "../../i18n-context";

interface Props {
  dataset: Dataset;
  isImageData: boolean;
  colorBy: ScalarSelection | null;
  onColorBy: (selection: ScalarSelection | null) => void;
  dataColorRange: [number, number] | null;
  customColorRange: [number, number] | null;
  onCustomColorRange: (range: [number, number] | null) => void;
  colorMap: ColorMapName;
  onColorMap: (name: ColorMapName) => void;
  legendVisible: boolean;
  onLegendVisible: (visible: boolean) => void;
}

function RangeEditor({
  range,
  disabled,
  invalid,
  onChange,
}: {
  range: [number, number] | null;
  disabled: boolean;
  /** True only when the user's manual range is inverted — the read-only data
   * range of a constant array must not be flagged as a user error. */
  invalid: boolean;
  onChange: (range: [number, number]) => void;
}) {
  const messages = useMessages();
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

  return (
    <div className="range-inputs">
      <input
        type="number"
        aria-label={messages.properties.rangeMinimum}
        aria-invalid={invalid}
        aria-describedby={invalid ? "color-range-error" : undefined}
        value={draft[0]}
        disabled={disabled}
        onChange={(e) => setDraft([e.target.value, draft[1]])}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      <span>{messages.properties.rangeSeparator}</span>
      <input
        type="number"
        aria-label={messages.properties.rangeMaximum}
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

export const ScalarColorSection = memo(function ScalarColorSection({
  dataset,
  isImageData,
  colorBy,
  onColorBy,
  dataColorRange,
  customColorRange,
  onCustomColorRange,
  colorMap,
  onColorMap,
  legendVisible,
  onLegendVisible,
}: Props) {
  const messages = useMessages();
  const [customColorMaps, setCustomColorMaps] = useState(registeredCustomColorMaps);
  const [presetStatus, setPresetStatus] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const associationLabel = (array: ArrayInfo) =>
    array.association === "table"
      ? messages.properties.associationNames.tablePoint
      : messages.properties.associationNames[array.association];
  const colorArrays = (dataset.arrays ?? []).filter(
    (a) => isImageData
      ? isImageScalarArray(a)
      : a.association === "point" ||
        a.association === "cell" ||
        (dataset.dataset_type === "Table" && a.association === "table" && a.data_type === "numeric"),
  );
  const selectionValue = colorBy ? `${colorBy.association}:${colorBy.name}` : "";
  const displayedRange = customColorRange ?? dataColorRange;

  return (
    <>
      <h3>{messages.properties.scalarColor}</h3>
      <label className="sr-only" htmlFor="scalar-color-selection">{messages.properties.colorArrayLabel}</label>
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
          {messages.properties.solidColor}
        </option>
        {colorArrays.map((a) => {
          const association = a.association === "table" ? "point" : a.association;
          return (
          <option key={`${a.association}:${a.name}`} value={`${association}:${a.name}`}>
            {associationLabel(a)} · {a.name}{" "}
            {a.value_range ? `[${a.value_range[0]}, ${a.value_range[1]}]` : ""}
          </option>
          );
        })}
      </select>

      {colorBy && (
        <div className="display-controls">
          <label>
            {messages.properties.colorMap}
            <select value={colorMap} onChange={(e) => onColorMap(e.target.value as ColorMapName)}>
              {(Object.entries(messages.properties.colorMapNames) as [BuiltInColorMapName, string][]).map(
                ([name, label]) => (
                  <option key={name} value={name}>{label}</option>
                ),
              )}
              {customColorMaps.map(({ id, label }) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </label>

          <label className="color-map-import">
            <span>{messages.properties.importColorMap}</span>
            <input
              type="file"
              accept=".json,application/json"
              aria-label={messages.properties.importColorMap}
              onChange={(event) => {
                const input = event.currentTarget;
                const file = input.files?.[0];
                if (!file) return;
                setPresetStatus(null);
                if (file.size > 1024 * 1024) {
                  setPresetStatus({ kind: "error", message: messages.properties.colorMapFileTooLarge });
                  input.value = "";
                  return;
                }
                void file.text()
                  .then((text) => {
                    const preset = importParaViewColorMapPreset(text);
                    setCustomColorMaps(registeredCustomColorMaps());
                    onColorMap(preset.id);
                    setPresetStatus({
                      kind: "success",
                      message: `${messages.properties.colorMapImported}: ${preset.label}`,
                    });
                  })
                  .catch((reason) => setPresetStatus({
                    kind: "error",
                    message: `${messages.properties.colorMapImportFailed}: ${String(reason)}`,
                  }))
                  .finally(() => { input.value = ""; });
              }}
            />
          </label>
          {presetStatus && (
            <p
              className={presetStatus.kind === "error" ? "validation-error" : "muted"}
              role={presetStatus.kind === "error" ? "alert" : "status"}
            >
              {presetStatus.message}
            </p>
          )}

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={customColorRange !== null}
              disabled={!dataColorRange}
              onChange={(e) => onCustomColorRange(e.target.checked ? dataColorRange : null)}
            />
            {messages.properties.manualRange}
          </label>
          <RangeEditor
            range={displayedRange}
            disabled={customColorRange === null}
            invalid={customColorRange !== null && customColorRange[0] >= customColorRange[1]}
            onChange={onCustomColorRange}
          />

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={legendVisible}
              onChange={(e) => onLegendVisible(e.target.checked)}
            />
            {messages.properties.showLegend}
          </label>
          {customColorRange && customColorRange[0] >= customColorRange[1] && (
            <p id="color-range-error" className="validation-error" role="alert">
              {messages.properties.rangeError}
            </p>
          )}
        </div>
      )}

      <h3>{messages.properties.arrays}</h3>
      <ul className="array-list">
        {(dataset.arrays ?? []).map((a) => (
          <li key={`${a.association}:${a.name}`}>
            <span className={`chip chip-${a.association}`}>
              {messages.properties.associationNames[a.association]}
            </span>
            {a.name}
            {a.num_components > 1 ? ` (${a.num_components})` : ""}
          </li>
        ))}
      </ul>
    </>
  );
});
