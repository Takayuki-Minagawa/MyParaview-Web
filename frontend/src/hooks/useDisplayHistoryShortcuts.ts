import { useEffect, useRef } from "react";

interface DisplayHistoryShortcuts {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(
    "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
  );
}

/** Installs conventional Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, and Ctrl/Cmd+Y
 * shortcuts without stealing native editing history from form controls. */
export function useDisplayHistoryShortcuts(options: DisplayHistoryShortcuts): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || isEditableTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      const current = optionsRef.current;
      const undoRequested = key === "z" && !event.shiftKey;
      const redoRequested = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);

      if (undoRequested && current.canUndo) {
        event.preventDefault();
        current.undo();
      } else if (redoRequested && current.canRedo) {
        event.preventDefault();
        current.redo();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
