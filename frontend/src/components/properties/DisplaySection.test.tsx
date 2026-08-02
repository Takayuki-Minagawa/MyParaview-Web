import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessagesProvider } from "../../i18n-context";
import { MESSAGES } from "../../i18n";
import { DisplaySection } from "./DisplaySection";

function renderSection({ canUndo = false, canRedo = false } = {}) {
  const onUndo = vi.fn();
  const onRedo = vi.fn();
  render(
    <MessagesProvider language="en">
      <DisplaySection
        isImageData={false}
        representation="surface"
        onRepresentation={vi.fn()}
        opacity={1}
        onOpacity={vi.fn()}
        axesVisible={true}
        onAxesVisible={vi.fn()}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={onUndo}
        onRedo={onRedo}
        onScreenshot={vi.fn()}
        onResetCamera={vi.fn()}
      />
    </MessagesProvider>,
  );
  return { onUndo, onRedo };
}

describe("DisplaySection history controls", () => {
  it("localizes the controls and disables empty history directions", () => {
    renderSection();
    const undo = screen.getByRole("button", { name: MESSAGES.en.properties.undoDisplay });
    const redo = screen.getByRole("button", { name: MESSAGES.en.properties.redoDisplay });
    expect((undo as HTMLButtonElement).disabled).toBe(true);
    expect((redo as HTMLButtonElement).disabled).toBe(true);
    expect(undo.getAttribute("title")).toContain(MESSAGES.en.properties.undoShortcut);
    expect(redo.getAttribute("title")).toContain(MESSAGES.en.properties.redoShortcut);
  });

  it("invokes the available history actions", async () => {
    const user = userEvent.setup();
    const handlers = renderSection({ canUndo: true, canRedo: true });
    await user.click(screen.getByRole("button", { name: MESSAGES.en.properties.undoDisplay }));
    await user.click(screen.getByRole("button", { name: MESSAGES.en.properties.redoDisplay }));
    expect(handlers.onUndo).toHaveBeenCalledTimes(1);
    expect(handlers.onRedo).toHaveBeenCalledTimes(1);
  });
});
