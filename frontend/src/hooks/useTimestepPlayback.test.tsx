import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDisplayState } from "./useDisplayState";
import { useTimestepPlayback } from "./useTimestepPlayback";

function setup(initial = { datasetId: "d1", count: 3, enabled: true }) {
  return renderHook(({ datasetId, count, enabled }) => {
    const display = useDisplayState();
    const url = `${datasetId}/${display.timestepIndex}`;
    const playback = useTimestepPlayback({
      datasetId, enabled, timestepCount: count, timestepIndex: display.timestepIndex,
      viewerUrl: url, playing: display.playing, setPlaying: display.setPlaying,
      setTimestepIndex: display.setTimestepIndex,
      setPlaybackTimestep: display.setPlaybackTimestep,
    });
    return { display, playback, url };
  }, { initialProps: initial });
}

describe("useTimestepPlayback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for every rendered frame and keeps the default 800ms loop", () => {
    const { result } = setup();
    act(() => result.current.playback.togglePlayback());
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.display.timestepIndex).toBe(0);
    act(() => result.current.playback.onLoadStateChange(result.current.url, "ready"));
    act(() => vi.advanceTimersByTime(799));
    expect(result.current.display.timestepIndex).toBe(0);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.display.timestepIndex).toBe(1);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.display.timestepIndex).toBe(1);
    // A late completion for the previous frame must not unlock this frame.
    act(() => result.current.playback.onLoadStateChange("d1/0", "ready"));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.display.timestepIndex).toBe(1);
    act(() => result.current.playback.onLoadStateChange(result.current.url, "ready"));
    act(() => vi.advanceTimersByTime(800));
    expect(result.current.display.timestepIndex).toBe(2);
    act(() => result.current.playback.onLoadStateChange(result.current.url, "ready"));
    act(() => vi.advanceTimersByTime(800));
    expect(result.current.display.timestepIndex).toBe(0);
    expect(result.current.display.playing).toBe(true);
    expect(result.current.display.canUndo).toBe(false);
  });

  it("uses speed multipliers without resetting the timer on unrelated renders", () => {
    const { result, rerender } = setup();
    act(() => {
      result.current.playback.setSpeed(2);
      result.current.playback.onLoadStateChange(result.current.url, "ready");
      result.current.playback.togglePlayback();
    });
    act(() => vi.advanceTimersByTime(200));
    rerender({ datasetId: "d1", count: 3, enabled: true });
    act(() => result.current.display.setOpacity(0.5));
    act(() => vi.advanceTimersByTime(199));
    expect(result.current.display.timestepIndex).toBe(0);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.display.timestepIndex).toBe(1);
    act(() => result.current.playback.setSpeed(0));
    expect(result.current.playback.speed).toBe(2);
  });

  it("stops after rendering the last frame without looping and restarts at the first", () => {
    const { result } = setup({ datasetId: "d1", count: 2, enabled: true });
    act(() => {
      result.current.playback.setLoop(false);
      result.current.playback.onLoadStateChange(result.current.url, "ready");
      result.current.playback.togglePlayback();
    });
    act(() => vi.advanceTimersByTime(800));
    expect(result.current.display.timestepIndex).toBe(1);
    expect(result.current.display.playing).toBe(true);
    act(() => result.current.playback.onLoadStateChange(result.current.url, "ready"));
    expect(result.current.display.playing).toBe(false);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.display.timestepIndex).toBe(1);
    act(() => result.current.playback.togglePlayback());
    expect(result.current.display.timestepIndex).toBe(0);
    expect(result.current.display.playing).toBe(true);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.display.timestepIndex).toBe(0);
  });

  it("pauses and clamps manual seeks, and never reuses a previous frame completion", () => {
    const { result } = setup();
    act(() => {
      result.current.playback.onLoadStateChange(result.current.url, "ready");
      result.current.playback.togglePlayback();
    });
    act(() => result.current.playback.seek(99));
    expect(result.current.display.timestepIndex).toBe(2);
    expect(result.current.display.playing).toBe(false);
    act(() => result.current.playback.seek(-2));
    act(() => result.current.playback.togglePlayback());
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.display.timestepIndex).toBe(0);
    act(() => result.current.playback.onLoadStateChange(result.current.url, "ready"));
    act(() => vi.advanceTimersByTime(800));
    expect(result.current.display.timestepIndex).toBe(1);
  });

  it("cancels a pending advance when the same URL starts reloading", () => {
    const { result } = setup();
    act(() => {
      result.current.playback.onLoadStateChange(result.current.url, "ready");
      result.current.playback.togglePlayback();
    });
    act(() => vi.advanceTimersByTime(400));
    act(() => result.current.playback.onLoadStateChange(result.current.url, "loading"));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.display.timestepIndex).toBe(0);
  });

  it("stops on load failure and ignores errors from replaced frames", () => {
    const { result } = setup();
    act(() => result.current.playback.togglePlayback());
    act(() => result.current.playback.onLoadStateChange("old/0", "error"));
    expect(result.current.display.playing).toBe(true);
    act(() => result.current.playback.onLoadStateChange(result.current.url, "error"));
    expect(result.current.display.playing).toBe(false);
    expect(result.current.playback.playbackAvailable).toBe(false);
    act(() => result.current.playback.togglePlayback());
    expect(result.current.display.playing).toBe(false);
    act(() => result.current.playback.seek(1));
    expect(result.current.playback.playbackAvailable).toBe(true);
  });

  it("stops on dataset/project changes, disabled playback, and unmount", () => {
    const { result, rerender, unmount } = setup();
    act(() => {
      result.current.playback.onLoadStateChange(result.current.url, "ready");
      result.current.playback.togglePlayback();
    });
    rerender({ datasetId: "d2", count: 3, enabled: true });
    expect(result.current.display.playing).toBe(false);
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.display.timestepIndex).toBe(0);
    act(() => {
      result.current.playback.onLoadStateChange(result.current.url, "ready");
      result.current.playback.togglePlayback();
    });
    rerender({ datasetId: "d2", count: 3, enabled: false });
    expect(result.current.display.playing).toBe(false);
    rerender({ datasetId: "d2", count: 3, enabled: true });
    act(() => result.current.playback.togglePlayback());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1])("does not play a %i-frame collection", (count) => {
    const { result } = setup({ datasetId: "d1", count, enabled: true });
    act(() => result.current.playback.togglePlayback());
    expect(result.current.display.playing).toBe(false);
    expect(result.current.playback.playbackAvailable).toBe(false);
  });
});
