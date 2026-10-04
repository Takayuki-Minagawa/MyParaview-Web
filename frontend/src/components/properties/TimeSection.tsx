import { memo } from "react";
import type { Dataset } from "../../types";
import { useMessages } from "../../i18n-context";
import { PLAYBACK_SPEEDS } from "../../hooks/useTimestepPlayback";

interface Props {
  dataset: Dataset;
  timestepIndex: number;
  onTimestepIndex: (index: number) => void;
  playing: boolean;
  onTogglePlayback: () => void;
  playbackAvailable: boolean;
  speed: number;
  onSpeed: (speed: number) => void;
  loop: boolean;
  onLoop: (loop: boolean) => void;
  onDownloadTimestep: (index: number) => void;
}

export const TimeSection = memo(function TimeSection({
  dataset,
  timestepIndex,
  onTimestepIndex,
  playing,
  onTogglePlayback,
  playbackAvailable,
  speed,
  onSpeed,
  loop,
  onLoop,
  onDownloadTimestep,
}: Props) {
  const messages = useMessages();
  if (dataset.extra?.bundle_complete === false) {
    return <p className="muted">{messages.properties.pvdMissing}</p>;
  }

  const timesteps = dataset.timesteps ?? [];
  const lastIndex = Math.max(0, timesteps.length - 1);
  const currentIndex = Number.isFinite(timestepIndex)
    ? Math.max(0, Math.min(Math.trunc(timestepIndex), lastIndex)) : 0;
  return (
    <div className="display-controls time-controls">
      <strong>{messages.properties.pvdTime}</strong>
      <div className="row">
        <button disabled={!playing && !playbackAvailable} onClick={onTogglePlayback}>
          {playing ? messages.properties.pause : messages.properties.play}
        </button>
        <span className="mono">
          {messages.properties.stepWord} {currentIndex} / {lastIndex}
          {timesteps.length ? ` · t=${timesteps[currentIndex]}` : ""}
        </span>
      </div>
      <div className="time-navigation" role="group" aria-label={messages.properties.timeNavigation}>
        <button disabled={currentIndex === 0} onClick={() => onTimestepIndex(0)}>
          {messages.properties.firstStep}
        </button>
        <button disabled={currentIndex === 0} onClick={() => onTimestepIndex(currentIndex - 1)}>
          {messages.properties.previousStep}
        </button>
        <button disabled={currentIndex >= lastIndex} onClick={() => onTimestepIndex(currentIndex + 1)}>
          {messages.properties.nextStep}
        </button>
        <button disabled={currentIndex >= lastIndex} onClick={() => onTimestepIndex(lastIndex)}>
          {messages.properties.lastStep}
        </button>
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
      <div className="row time-playback-options">
        <label>
          {messages.properties.playbackSpeed}
          <select value={speed} onChange={(event) => onSpeed(Number(event.target.value))}>
            {PLAYBACK_SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
          </select>
        </label>
        <label className="time-loop-option">
          <input type="checkbox" checked={loop} onChange={(event) => onLoop(event.target.checked)} />
          {messages.properties.loopPlayback}
        </label>
      </div>
      <button
        disabled={timesteps.length === 0}
        onClick={() => onDownloadTimestep(currentIndex)}
      >
        {messages.properties.timestepDownload}
      </button>
    </div>
  );
});
