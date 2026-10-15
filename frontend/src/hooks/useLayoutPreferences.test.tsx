import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_STORAGE_KEY,
  PANELS_STORAGE_KEY,
  readStoredBackground,
  readStoredPanels,
  useLayoutPreferences,
} from "./useLayoutPreferences";

function mockMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    matches,
    addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  return {
    emit: (next: boolean) => {
      media.matches = next;
      listeners.forEach((listener) => listener({ matches: next } as MediaQueryListEvent));
    },
  };
}

describe("useLayoutPreferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts with both panels open on wide screens and persists toggles", () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useLayoutPreferences());
    expect(result.current.narrow).toBe(false);
    expect(result.current.leftCollapsed).toBe(false);
    expect(result.current.rightCollapsed).toBe(false);
    act(() => result.current.toggleLeft());
    expect(result.current.leftCollapsed).toBe(true);
    expect(result.current.rightCollapsed).toBe(false);
    expect(readStoredPanels(window.localStorage)).toEqual({ left: true, right: false });
    act(() => result.current.setBackgroundChoice("gray"));
    expect(window.localStorage.getItem(BACKGROUND_STORAGE_KEY)).toBe("gray");
    act(() => result.current.resetAll());
    expect(result.current.backgroundChoice).toBe("theme");
    expect(result.current.leftCollapsed).toBe(false);
    expect(window.localStorage.getItem(PANELS_STORAGE_KEY)).toBe(JSON.stringify({ left: false, right: false }));
  });

  it("restores the stored wide layout and background", () => {
    mockMatchMedia(false);
    window.localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify({ left: false, right: true }));
    window.localStorage.setItem(BACKGROUND_STORAGE_KEY, "black");
    const { result } = renderHook(() => useLayoutPreferences());
    expect(result.current.rightCollapsed).toBe(true);
    expect(result.current.backgroundChoice).toBe("black");
  });

  it("closes both panels on narrow screens and keeps at most one drawer open", () => {
    const media = mockMatchMedia(true);
    window.localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify({ left: false, right: false }));
    const { result } = renderHook(() => useLayoutPreferences());
    expect(result.current.narrow).toBe(true);
    expect(result.current.leftCollapsed).toBe(true);
    expect(result.current.rightCollapsed).toBe(true);
    act(() => result.current.toggleLeft());
    expect(result.current.leftCollapsed).toBe(false);
    act(() => result.current.toggleRight());
    expect(result.current.rightCollapsed).toBe(false);
    expect(result.current.leftCollapsed).toBe(true);
    // Drawer state must not overwrite the remembered desktop arrangement.
    expect(readStoredPanels(window.localStorage)).toEqual({ left: false, right: false });
    act(() => result.current.maximizeViewer());
    expect(result.current.leftCollapsed && result.current.rightCollapsed).toBe(true);
    act(() => media.emit(false));
    expect(result.current.narrow).toBe(false);
    // Widening restores the remembered desktop layout and keeps it stored.
    expect(result.current.leftCollapsed).toBe(false);
    expect(result.current.rightCollapsed).toBe(false);
    expect(readStoredPanels(window.localStorage)).toEqual({ left: false, right: false });
  });

  it("falls back to defaults for corrupt storage", () => {
    window.localStorage.setItem(PANELS_STORAGE_KEY, "{not json");
    window.localStorage.setItem(BACKGROUND_STORAGE_KEY, "purple");
    expect(readStoredPanels(window.localStorage)).toBeNull();
    expect(readStoredBackground(window.localStorage)).toBe("theme");
  });
});
