import { fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDisplayHistoryShortcuts } from "./useDisplayHistoryShortcuts";

describe("useDisplayHistoryShortcuts", () => {
  it("uses Ctrl/Cmd+Z for undo and both conventional redo shortcuts", () => {
    const undo = vi.fn();
    const redo = vi.fn();
    renderHook(() => useDisplayHistoryShortcuts({ canUndo: true, canRedo: true, undo, redo }));

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    fireEvent.keyDown(window, { key: "Z", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });

    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(2);
  });

  it("does not consume shortcuts when the corresponding stack is empty", () => {
    const undo = vi.fn();
    const redo = vi.fn();
    renderHook(() => useDisplayHistoryShortcuts({ canUndo: false, canRedo: false, undo, redo }));

    const undoEvent = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, cancelable: true });
    const redoEvent = new KeyboardEvent(
      "keydown",
      { key: "z", ctrlKey: true, shiftKey: true, cancelable: true },
    );
    window.dispatchEvent(undoEvent);
    window.dispatchEvent(redoEvent);

    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
    expect(undoEvent.defaultPrevented).toBe(false);
    expect(redoEvent.defaultPrevented).toBe(false);
  });

  it("leaves native input undo alone and ignores modified shortcuts", () => {
    const undo = vi.fn();
    const redo = vi.fn();
    renderHook(() => useDisplayHistoryShortcuts({ canUndo: true, canRedo: true, undo, redo }));
    const input = document.createElement("input");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "plaintext-only");
    document.body.append(input);
    document.body.append(editable);

    fireEvent.keyDown(input, { key: "z", ctrlKey: true });
    fireEvent.keyDown(editable, { key: "z", ctrlKey: true });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, altKey: true });

    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
    input.remove();
    editable.remove();
  });

  it("reads updated availability and callbacks without reinstalling the listener", () => {
    const firstUndo = vi.fn();
    const secondUndo = vi.fn();
    const { rerender } = renderHook(
      ({ canUndo, undo }) => useDisplayHistoryShortcuts({
        canUndo,
        canRedo: false,
        undo,
        redo: vi.fn(),
      }),
      { initialProps: { canUndo: false, undo: firstUndo } },
    );

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    rerender({ canUndo: true, undo: secondUndo });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    expect(firstUndo).not.toHaveBeenCalled();
    expect(secondUndo).toHaveBeenCalledTimes(1);
  });
});
