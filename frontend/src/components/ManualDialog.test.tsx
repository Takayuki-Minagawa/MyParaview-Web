import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MessagesProvider } from "../i18n-context";
import { MESSAGES } from "../i18n";
import { ManualDialog, nextTrappedFocus } from "./ManualDialog";

const messages = MESSAGES.en;

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <MessagesProvider language="en">
      <select aria-label="Project"><option>one</option></select>
      <button onClick={() => setOpen(true)}>{messages.common.manual}</button>
      <ManualDialog open={open} mode="static" onClose={() => setOpen(false)} />
    </MessagesProvider>
  );
}

describe("ManualDialog keyboard behaviour (F-05)", () => {
  it("keeps Tab inside the dialog and closes with Escape from any element", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: messages.common.manual });
    opener.focus();
    await user.click(opener);
    const dialog = screen.getByRole("dialog");
    const close = screen.getByRole("button", { name: messages.common.close });
    expect(close).toHaveFocus();
    // Tab from the only focusable control cycles back inside, never to the page.
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByLabelText("Project")).not.toHaveFocus();
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("lists the current mode and feature availability", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: messages.common.manual }));
    expect(screen.getByText(`${messages.manual.currentMode}: ${messages.connection.modeStatic}`)).toBeTruthy();
    expect(screen.getByText(messages.manual.availableInBrowser)).toBeTruthy();
    expect(screen.getByText(messages.manual.needsServer)).toBeTruthy();
    expect(screen.getByText(messages.manual.unsupported)).toBeTruthy();
    expect(screen.getByText(messages.manual.staticSteps[0])).toBeTruthy();
  });
});

describe("nextTrappedFocus", () => {
  it("wraps at both ends and targets the dialog when nothing is focusable", () => {
    const root = document.createElement("div");
    const first = document.createElement("button");
    const last = document.createElement("input");
    root.append(first, last);
    document.body.append(root);
    expect(nextTrappedFocus(root, last, false)).toBe(first);
    expect(nextTrappedFocus(root, first, true)).toBe(last);
    expect(nextTrappedFocus(root, first, false)).toBeNull();
    expect(nextTrappedFocus(root, document.body, false)).toBe(first);
    const empty = document.createElement("div");
    expect(nextTrappedFocus(empty, null, false)).toBe(empty);
    root.remove();
    vi.restoreAllMocks();
  });
});
