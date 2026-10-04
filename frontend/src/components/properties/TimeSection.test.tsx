import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { TimeSection } from "./TimeSection";
import { MessagesProvider } from "../../i18n-context";
import type { Dataset } from "../../types";

const DATASET: Dataset = {
  id: "d1", project_id: "p1", filename: "series.pvd", ext: ".pvd",
  size_bytes: 100, status: "ready", dataset_type: "Collection",
  created_at: "2026-10-04T00:00:00Z", timesteps: [0, 1.5, 3],
};

function renderSection(overrides: Partial<ComponentProps<typeof TimeSection>> = {}) {
  const handlers = {
    onTimestepIndex: vi.fn(), onTogglePlayback: vi.fn(),
    onSpeed: vi.fn(), onLoop: vi.fn(), onDownloadTimestep: vi.fn(),
  };
  render(<MessagesProvider language="en"><TimeSection
    dataset={DATASET} timestepIndex={1} playing={false} speed={1} loop
    playbackAvailable {...handlers} {...overrides}
  /></MessagesProvider>);
  return handlers;
}

describe("TimeSection", () => {
  it("routes navigation, speed, loop, slider, and download controls", () => {
    const handlers = renderSection();
    for (const [name, index] of [["First", 0], ["Previous", 0], ["Next", 2], ["Last", 2]] as const) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(handlers.onTimestepIndex).toHaveBeenLastCalledWith(index);
    }
    fireEvent.change(screen.getByLabelText("PVD timestep"), { target: { value: "2" } });
    expect(handlers.onTimestepIndex).toHaveBeenLastCalledWith(2);
    fireEvent.change(screen.getByLabelText("Playback speed"), { target: { value: "4" } });
    expect(handlers.onSpeed).toHaveBeenCalledWith(4);
    fireEvent.click(screen.getByLabelText("Loop playback"));
    expect(handlers.onLoop).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: /Download/ }));
    expect(handlers.onDownloadTimestep).toHaveBeenCalledWith(1);
  });

  it.each([99, -1])("clamps step %i consistently in the label, slider, and download", (index) => {
    const handlers = renderSection({ timestepIndex: index });
    const expected = index < 0 ? 0 : 2;
    expect(screen.getByText(`step ${expected} / 2 · t=${DATASET.timesteps?.[expected]}`)).toBeTruthy();
    expect((screen.getByLabelText("PVD timestep") as HTMLInputElement).value).toBe(String(expected));
    fireEvent.click(screen.getByRole("button", { name: /Download/ }));
    expect(handlers.onDownloadTimestep).toHaveBeenCalledWith(expected);
    expect((screen.getByRole("button", { name: index < 0 ? "First" : "Last" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables playback/navigation for one step and playback after a load failure", () => {
    renderSection({ dataset: { ...DATASET, timesteps: [0] }, timestepIndex: 0, playbackAvailable: false });
    for (const name of ["Play", "First", "Previous", "Next", "Last"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("shows missing bundle information instead of controls", () => {
    renderSection({ dataset: { ...DATASET, extra: { bundle_complete: false } } });
    expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
  });
});
