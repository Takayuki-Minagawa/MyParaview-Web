import { useCallback, useEffect, useMemo, useState } from "react";

export type BackgroundChoice = "theme" | "black" | "gray" | "white";

export const BACKGROUND_STORAGE_KEY = "pvweb-background";
export const PANELS_STORAGE_KEY = "pvweb-panels";
/** Below this width the side panels overlay the viewer as drawers. */
export const NARROW_LAYOUT_QUERY = "(max-width: 900px)";

interface PanelState {
  left: boolean;
  right: boolean;
}

const DEFAULT_PANELS: PanelState = { left: false, right: false };

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredBackground(storage: Pick<Storage, "getItem"> | null): BackgroundChoice {
  try {
    const value = storage?.getItem(BACKGROUND_STORAGE_KEY);
    return value === "black" || value === "gray" || value === "white" ? value : "theme";
  } catch {
    return "theme";
  }
}

/** Stored panel state means "collapsed" flags; absent means both open. */
export function readStoredPanels(storage: Pick<Storage, "getItem"> | null): PanelState | null {
  try {
    const raw = storage?.getItem(PANELS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PanelState>;
    return { left: parsed.left === true, right: parsed.right === true };
  } catch {
    return null;
  }
}

function matchesNarrow(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(NARROW_LAYOUT_QUERY).matches;
}

/** Viewer background and side-panel layout, persisted per browser. Narrow
 * viewports start with both panels closed and keep at most one open so the
 * viewer never shrinks to an unusable width (feedback F-04). */
export function useLayoutPreferences() {
  const [narrow, setNarrow] = useState(matchesNarrow);
  const [backgroundChoice, setBackgroundChoiceState] = useState<BackgroundChoice>(
    () => readStoredBackground(safeStorage()),
  );
  const [panels, setPanels] = useState<PanelState>(() => (
    matchesNarrow()
      ? { left: true, right: true }
      : readStoredPanels(safeStorage()) ?? DEFAULT_PANELS
  ));

  useEffect(() => {
    const media = window.matchMedia?.(NARROW_LAYOUT_QUERY);
    if (!media) return;
    const onChange = (event: MediaQueryListEvent) => {
      setNarrow(event.matches);
      if (event.matches) setPanels({ left: true, right: true });
    };
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    try {
      safeStorage()?.setItem(BACKGROUND_STORAGE_KEY, backgroundChoice);
    } catch {
      /* ignore storage failures */
    }
  }, [backgroundChoice]);

  useEffect(() => {
    // Drawer state on narrow screens is session-only; only the wide layout
    // is remembered so a later desktop visit restores the user's arrangement.
    if (narrow) return;
    try {
      safeStorage()?.setItem(PANELS_STORAGE_KEY, JSON.stringify(panels));
    } catch {
      /* ignore storage failures */
    }
  }, [panels, narrow]);

  const setBackgroundChoice = useCallback((choice: BackgroundChoice) => {
    setBackgroundChoiceState(choice);
  }, []);

  const toggleLeft = useCallback(() => {
    setPanels((current) => ({
      left: !current.left,
      right: narrow && current.left ? true : current.right,
    }));
  }, [narrow]);

  const toggleRight = useCallback(() => {
    setPanels((current) => ({
      left: narrow && current.right ? true : current.left,
      right: !current.right,
    }));
  }, [narrow]);

  const maximizeViewer = useCallback(() => setPanels({ left: true, right: true }), []);

  const resetLayout = useCallback(() => {
    setPanels(narrow ? { left: true, right: true } : DEFAULT_PANELS);
  }, [narrow]);

  const resetAll = useCallback(() => {
    setBackgroundChoiceState("theme");
    setPanels(narrow ? { left: true, right: true } : DEFAULT_PANELS);
    try {
      safeStorage()?.removeItem(BACKGROUND_STORAGE_KEY);
      safeStorage()?.removeItem(PANELS_STORAGE_KEY);
    } catch {
      /* ignore storage failures */
    }
  }, [narrow]);

  return useMemo(() => ({
    narrow,
    backgroundChoice,
    setBackgroundChoice,
    leftCollapsed: panels.left,
    rightCollapsed: panels.right,
    toggleLeft,
    toggleRight,
    maximizeViewer,
    resetLayout,
    resetAll,
  }), [
    narrow, backgroundChoice, setBackgroundChoice, panels, toggleLeft, toggleRight,
    maximizeViewer, resetLayout, resetAll,
  ]);
}
