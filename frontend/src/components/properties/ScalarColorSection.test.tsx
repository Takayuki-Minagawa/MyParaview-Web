import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { ScalarColorSection } from "./ScalarColorSection";
import { MessagesProvider } from "../../i18n-context";
import { MESSAGES } from "../../i18n";
import type { Dataset } from "../../types";
import { registerCustomColorMap } from "../../lib/colormap";

const messages = MESSAGES.ja;

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: "d1",
    project_id: "p1",
    filename: "mesh.vtp",
    ext: ".vtp",
    size_bytes: 1024,
    status: "ready",
    created_at: "2026-01-01T00:00:00Z",
    arrays: [
      { name: "temp", association: "point", num_components: 1, value_range: [0, 10] },
      { name: "flux:norm", association: "cell", num_components: 1 },
    ],
    ...overrides,
  };
}

function renderSection(overrides: Partial<ComponentProps<typeof ScalarColorSection>> = {}) {
  const handlers = {
    onColorBy: vi.fn(),
    onCustomColorRange: vi.fn(),
    onColorMap: vi.fn(),
    onLegendVisible: vi.fn(),
  };
  render(
    <MessagesProvider language="ja">
      <ScalarColorSection
        dataset={makeDataset()}
        isImageData={false}
        colorBy={{ association: "point", name: "temp" }}
        dataColorRange={[0, 10]}
        customColorRange={null}
        colorMap="viridis"
        legendVisible={false}
        {...handlers}
        {...overrides}
      />
    </MessagesProvider>,
  );
  return handlers;
}

describe("ScalarColorSection color map", () => {
  it("renders one option per colormap defined in the messages", () => {
    renderSection();
    const select = screen.getByDisplayValue(
      messages.properties.colorMapNames.viridis,
    ) as HTMLSelectElement;
    const labels = Array.from(select.options).map((option) => option.textContent);
    expect(labels.slice(0, 5)).toEqual(Object.values(messages.properties.colorMapNames));
    expect(select.options.length).toBeGreaterThanOrEqual(5);
  });

  it("reports colormap changes via onColorMap", async () => {
    const user = userEvent.setup();
    const handlers = renderSection();
    const select = screen.getByDisplayValue(messages.properties.colorMapNames.viridis);
    await user.selectOptions(select, "turbo");
    expect(handlers.onColorMap).toHaveBeenCalledWith("turbo");
  });

  it("imports a ParaView JSON preset and selects it", async () => {
    const user = userEvent.setup();
    const handlers = renderSection();
    const file = new File([
      JSON.stringify({
        Name: "Review Thermal",
        RGBPoints: [0, 0, 0, 1, 1, 1, 0, 0],
      }),
    ], "thermal.json", { type: "application/json" });

    await user.upload(screen.getByLabelText(messages.properties.importColorMap), file);

    await waitFor(() => expect(handlers.onColorMap).toHaveBeenCalled());
    const calls = handlers.onColorMap.mock.calls;
    expect(calls[calls.length - 1]?.[0]).toMatch(/^custom:/);
    expect((await screen.findByRole("status")).textContent).toContain("Review Thermal");
  });

  it("updates options when a saved view registers a colormap outside the panel", async () => {
    const id = "custom:SavedView:g001" as const;
    renderSection({ colorMap: id });
    const select = screen.getAllByRole("combobox")[1] as HTMLSelectElement;
    expect(select.value).not.toBe(id);

    act(() => {
      registerCustomColorMap(id, "Saved view preset", [
        { position: 0, rgb: [0, 0, 0] },
        { position: 1, rgb: [1, 1, 1] },
      ]);
    });

    await waitFor(() => expect(select.value).toBe(id));
    expect(screen.getByRole("option", { name: "Saved view preset" })).toBeTruthy();
  });
});

describe("ScalarColorSection array selection", () => {
  it("parses association and name from the option value, keeping colons in the name", async () => {
    const user = userEvent.setup();
    const handlers = renderSection();
    const select = screen.getByLabelText(messages.properties.colorArrayLabel);
    await user.selectOptions(select, "cell:flux:norm");
    expect(handlers.onColorBy).toHaveBeenCalledTimes(1);
    expect(handlers.onColorBy).toHaveBeenCalledWith({ association: "cell", name: "flux:norm" });
  });

  it("clears the selection when the solid-color option is chosen", async () => {
    const user = userEvent.setup();
    const handlers = renderSection();
    const select = screen.getByLabelText(messages.properties.colorArrayLabel);
    await user.selectOptions(select, "");
    expect(handlers.onColorBy).toHaveBeenCalledWith(null);
  });
});

describe("ScalarColorSection manual range", () => {
  it("disables the checkbox when no data range is known", () => {
    renderSection({ dataColorRange: null });
    const checkbox = screen.getByLabelText(messages.properties.manualRange) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(false);
  });

  it("enables the manual range with the current data range", async () => {
    const user = userEvent.setup();
    const handlers = renderSection({ dataColorRange: [2, 8] });
    const checkbox = screen.getByLabelText(messages.properties.manualRange) as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    await user.click(checkbox);
    expect(handlers.onCustomColorRange).toHaveBeenCalledTimes(1);
    expect(handlers.onCustomColorRange).toHaveBeenCalledWith([2, 8]);
  });

  it("clears the custom range when unchecked", async () => {
    const user = userEvent.setup();
    const handlers = renderSection({ customColorRange: [2, 8] });
    const checkbox = screen.getByLabelText(messages.properties.manualRange) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await user.click(checkbox);
    expect(handlers.onCustomColorRange).toHaveBeenCalledWith(null);
  });
});
