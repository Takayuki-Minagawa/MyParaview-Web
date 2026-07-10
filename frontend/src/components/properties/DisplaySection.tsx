import { memo } from "react";
import type { Representation } from "../../types";
import { useMessages } from "../../i18n-context";

const REPRESENTATIONS: Representation[] = ["surface", "wireframe", "points"];

interface Props {
  isImageData: boolean;
  representation: Representation;
  onRepresentation: (r: Representation) => void;
  opacity: number;
  onOpacity: (opacity: number) => void;
  axesVisible: boolean;
  onAxesVisible: (visible: boolean) => void;
  onScreenshot: () => void;
  onResetCamera: () => void;
}

export const DisplaySection = memo(function DisplaySection({
  isImageData,
  representation,
  onRepresentation,
  opacity,
  onOpacity,
  axesVisible,
  onAxesVisible,
  onScreenshot,
  onResetCamera,
}: Props) {
  const messages = useMessages();
  return (
    <>
      <h3>{messages.properties.display}</h3>
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
              {messages.properties.representationNames[r]}
            </label>
          ))}
        </div>
      )}

      <label className="opacity-control">
        {messages.properties.opacity} {Math.round(opacity * 100)}%
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={opacity}
          onChange={(e) => onOpacity(Number(e.target.value))}
        />
      </label>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={axesVisible}
          onChange={(e) => onAxesVisible(e.target.checked)}
        />
        {messages.properties.axesVisible}
      </label>

      <div className="row actions">
        <button onClick={onResetCamera}>{messages.properties.resetCamera}</button>
        <button onClick={onScreenshot}>{messages.properties.screenshot}</button>
      </div>
    </>
  );
});
