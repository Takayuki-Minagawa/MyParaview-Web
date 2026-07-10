import { memo } from "react";
import type { ImageMode, SliceAxis, VolumeOpacityPoint } from "../../types";
import { useMessages } from "../../i18n-context";

const MAX_POINTS = 4;
const MIN_POINTS = 2;

interface Props {
  imageMode: ImageMode;
  onImageMode: (mode: ImageMode) => void;
  sliceAxis: SliceAxis;
  onSliceAxis: (axis: SliceAxis) => void;
  sliceIndex: number;
  onSliceIndex: (index: number) => void;
  sliceMin: number;
  sliceMax: number;
  volumeOpacityPoints: VolumeOpacityPoint[];
  onVolumeOpacityPoints: (points: VolumeOpacityPoint[]) => void;
}

export const ImageSection = memo(function ImageSection({
  imageMode,
  onImageMode,
  sliceAxis,
  onSliceAxis,
  sliceIndex,
  onSliceIndex,
  sliceMin,
  sliceMax,
  volumeOpacityPoints,
  onVolumeOpacityPoints,
}: Props) {
  const messages = useMessages();

  const updatePoint = (index: number, key: keyof VolumeOpacityPoint, raw: number) => {
    const next = volumeOpacityPoints.map((point) => ({ ...point }));
    if (!next[index]) return;
    if (key === "value") {
      // Clamp against neighbours so the points stay sorted by value.
      const lower = index > 0 ? next[index - 1].value : 0;
      const upper = index < next.length - 1 ? next[index + 1].value : 1;
      next[index].value = Math.min(upper, Math.max(lower, raw));
    } else {
      next[index].alpha = Math.min(1, Math.max(0, raw));
    }
    onVolumeOpacityPoints(next);
  };

  const addPoint = () => {
    if (volumeOpacityPoints.length >= MAX_POINTS || volumeOpacityPoints.length < 2) return;
    const next = volumeOpacityPoints.map((point) => ({ ...point }));
    const last = next.length - 1;
    // Insert at the midpoint between the last two points.
    next.splice(last, 0, {
      value: (next[last - 1].value + next[last].value) / 2,
      alpha: (next[last - 1].alpha + next[last].alpha) / 2,
    });
    onVolumeOpacityPoints(next);
  };

  const removePoint = () => {
    if (volumeOpacityPoints.length <= MIN_POINTS) return;
    onVolumeOpacityPoints(volumeOpacityPoints.slice(0, -1));
  };

  return (
    <div className="display-controls image-controls">
      <strong>{messages.properties.imageDisplay}</strong>
      <div className="row">
        {(["slice", "volume"] as ImageMode[]).map((mode) => (
          <label className="radio" key={mode}>
            <input
              type="radio"
              name="image-mode"
              checked={imageMode === mode}
              onChange={() => onImageMode(mode)}
            />
            {messages.properties.imageModeNames[mode]}
          </label>
        ))}
      </div>
      {imageMode === "slice" && (
        <>
          <label>
            {messages.properties.sliceAxis}
            <select value={sliceAxis} onChange={(event) => onSliceAxis(event.target.value as SliceAxis)}>
              <option value="X">X</option>
              <option value="Y">Y</option>
              <option value="Z">Z</option>
            </select>
          </label>
          <label>
            {messages.properties.sliceLabel} {sliceIndex} ({sliceMin}–{sliceMax})
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
      {imageMode === "volume" && (
        <div className="display-controls volume-opacity-controls">
          <strong>{messages.properties.volumeOpacity}</strong>
          {volumeOpacityPoints.map((point, index) => (
            <div className="row" key={index}>
              <label>
                {messages.properties.volumeOpacityValue} {point.value.toFixed(2)}
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={point.value}
                  onChange={(event) => updatePoint(index, "value", Number(event.target.value))}
                />
              </label>
              <label>
                {messages.properties.volumeOpacityAlpha} {point.alpha.toFixed(2)}
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={point.alpha}
                  onChange={(event) => updatePoint(index, "alpha", Number(event.target.value))}
                />
              </label>
            </div>
          ))}
          <div className="row">
            <button disabled={volumeOpacityPoints.length >= MAX_POINTS} onClick={addPoint}>
              {messages.properties.volumeOpacityAdd}
            </button>
            <button disabled={volumeOpacityPoints.length <= MIN_POINTS} onClick={removePoint}>
              {messages.properties.volumeOpacityRemove}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
