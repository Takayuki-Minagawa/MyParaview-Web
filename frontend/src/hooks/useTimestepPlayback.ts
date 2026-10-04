import { useCallback, useEffect, useRef, useState } from "react";

export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
export const DEFAULT_FRAME_DELAY_MS = 800;
export type ViewerLoadState = "loading" | "ready" | "error";

interface Options {
  datasetId: string | null;
  enabled: boolean;
  timestepCount: number;
  timestepIndex: number;
  viewerUrl: string | null;
  playing: boolean;
  setPlaying: (playing: boolean) => void;
  setTimestepIndex: (index: number) => void;
  setPlaybackTimestep: (index: number) => void;
}

/** Advance only after the current frame renders. Speed is a multiplier of the
 * dwell time, so slow downloads never skip frames or create overlapping loads. */
export function useTimestepPlayback({
  datasetId, enabled, timestepCount, timestepIndex, viewerUrl,
  playing, setPlaying, setTimestepIndex, setPlaybackTimestep,
}: Options) {
  const [speed, setSpeed] = useState<number>(1);
  const [loop, setLoop] = useState(true);
  const [loadedFrame, setLoadedFrame] = useState<{
    url: string;
    state: ViewerLoadState;
  } | null>(null);
  const activeUrlRef = useRef(viewerUrl);
  activeUrlRef.current = viewerUrl;
  const previousDatasetRef = useRef(datasetId);
  const canPlay = enabled && timestepCount > 1 && !!viewerUrl;
  const lastIndex = Math.max(0, timestepCount - 1);
  const loadFailed = loadedFrame?.url === viewerUrl && loadedFrame.state === "error";

  const onLoadStateChange = useCallback((url: string, state: ViewerLoadState) => {
    // A completion for a replaced dataset/frame cannot unlock the active one.
    if (url !== activeUrlRef.current) return;
    setLoadedFrame({ url, state });
    if (state === "error") setPlaying(false);
  }, [setPlaying]);

  useEffect(() => {
    if (previousDatasetRef.current !== datasetId || !canPlay) setPlaying(false);
    previousDatasetRef.current = datasetId;
  }, [datasetId, canPlay, setPlaying]);

  useEffect(() => {
    if (!playing || !canPlay || loadedFrame?.url !== viewerUrl
      || loadedFrame.state !== "ready") return;
    if (!loop && timestepIndex >= lastIndex) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setLoadedFrame(null);
      setPlaybackTimestep(timestepIndex >= lastIndex ? 0 : timestepIndex + 1);
    }, DEFAULT_FRAME_DELAY_MS / speed);
    return () => window.clearTimeout(timer);
  }, [
    playing, canPlay, loadedFrame, viewerUrl, loop, timestepIndex,
    lastIndex, speed, setPlaying, setPlaybackTimestep,
  ]);

  const seek = useCallback((index: number) => {
    if (!Number.isFinite(index)) return;
    const next = Math.max(0, Math.min(Math.trunc(index), lastIndex));
    setPlaying(false);
    if (next !== timestepIndex) setLoadedFrame(null);
    setTimestepIndex(next);
  }, [lastIndex, timestepIndex, setPlaying, setTimestepIndex]);

  const togglePlayback = useCallback(() => {
    if (!canPlay || loadFailed) return;
    if (!playing && !loop && timestepIndex >= lastIndex) {
      setLoadedFrame(null);
      setPlaybackTimestep(0);
    }
    setPlaying(!playing);
  }, [canPlay, loadFailed, playing, loop, timestepIndex, lastIndex, setPlaybackTimestep, setPlaying]);

  const changeSpeed = useCallback((value: number) => {
    if (PLAYBACK_SPEEDS.some((candidate) => candidate === value)) setSpeed(value);
  }, []);

  return {
    speed, setSpeed: changeSpeed, loop, setLoop, seek, togglePlayback,
    playbackAvailable: canPlay && !loadFailed, onLoadStateChange,
  };
}
