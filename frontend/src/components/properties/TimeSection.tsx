import { memo } from "react";
import type { Dataset } from "../../types";
import { useMessages } from "../../i18n-context";

interface Props {
  dataset: Dataset;
  timestepIndex: number;
  onTimestepIndex: (index: number) => void;
  playing: boolean;
  onTogglePlayback: () => void;
  onDownloadTimestep: (index: number) => void;
}

export const TimeSection = memo(function TimeSection({
  dataset,
  timestepIndex,
  onTimestepIndex,
  playing,
  onTogglePlayback,
  onDownloadTimestep,
}: Props) {
  const messages = useMessages();
  if (dataset.extra?.bundle_complete === false) {
    return <p className="muted">{messages.properties.pvdMissing}</p>;
  }

  const timesteps = dataset.timesteps ?? [];
  const lastIndex = Math.max(0, timesteps.length - 1);
  const currentIndex = Math.min(timestepIndex, lastIndex);
  return (
    <div className="display-controls time-controls">
      <strong>{messages.properties.pvdTime}</strong>
      <div className="row">
        <button disabled={timesteps.length < 2} onClick={onTogglePlayback}>
          {playing ? messages.properties.pause : messages.properties.play}
        </button>
        <span className="mono">
          {messages.properties.stepWord} {currentIndex} / {lastIndex}
          {timesteps.length ? ` · t=${timesteps[timestepIndex] ?? timesteps[0]}` : ""}
        </span>
      </div>
      <input
        type="range"
        aria-label={messages.properties.pvdStepLabel}
        min="0"
        max={lastIndex}
        step="1"
        value={currentIndex}
        disabled={timesteps.length < 2}
        onChange={(event) => onTimestepIndex(Number(event.target.value))}
      />
      <button
        disabled={timesteps.length === 0}
        onClick={() => onDownloadTimestep(currentIndex)}
      >
        {messages.properties.timestepDownload}
      </button>
    </div>
  );
});
