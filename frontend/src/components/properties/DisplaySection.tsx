import { memo } from "react";
import type { Representation } from "../../types";
import { REPRESENTATION_NAMES } from "../../types";
import { useMessages } from "../../i18n-context";


interface Props {
  isImageData: boolean;
  representation: Representation;
  onRepresentation: (r: Representation) => void;
  opacity: number;
  onOpacity: (opacity: number) => void;
  axesVisible: boolean;
  onAxesVisible: (visible: boolean) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
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
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onScreenshot,
  onResetCamera,
}: Props) {
  const messages = useMessages();
  return (
    <>
      <h3>{messages.properties.display}</h3>
      {!isImageData && (
        <div className="row">
          {REPRESENTATION_NAMES.map((r) => (
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

      <div className="row actions" aria-label={messages.properties.displayHistory}>
        <button
          type="button"
          disabled={!canUndo}
          onClick={onUndo}
          title={`${messages.properties.undoDisplay} (${messages.properties.undoShortcut})`}
        >
          {messages.properties.undoDisplay}
        </button>
        <button
          type="button"
          disabled={!canRedo}
          onClick={onRedo}
          title={`${messages.properties.redoDisplay} (${messages.properties.redoShortcut})`}
        >
          {messages.properties.redoDisplay}
        </button>
      </div>

      <div className="row actions">
        <button onClick={onResetCamera}>{messages.properties.resetCamera}</button>
        <button onClick={onScreenshot}>{messages.properties.screenshot}</button>
      </div>
    </>
  );
});
