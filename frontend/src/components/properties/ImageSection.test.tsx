import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { ImageSection } from "./ImageSection";
import { MessagesProvider } from "../../i18n-context";
import { MESSAGES } from "../../i18n";
import type { VolumeOpacityPoint } from "../../types";

const messages = MESSAGES.ja;

const twoPoints: VolumeOpacityPoint[] = [
  { value: 0, alpha: 0 },
  { value: 1, alpha: 1 },
];

function renderSection(overrides: Partial<ComponentProps<typeof ImageSection>> = {}) {
  const handlers = {
    onImageMode: vi.fn(),
    onSliceAxis: vi.fn(),
    onSliceIndex: vi.fn(),
    onVolumeOpacityPoints: vi.fn(),
  };
  const { container } = render(
    <MessagesProvider language="ja">
      <ImageSection
        imageMode="volume"
        sliceAxis="X"
        sliceIndex={0}
        sliceMin={0}
        sliceMax={10}
        volumeOpacityPoints={twoPoints}
        {...handlers}
        {...overrides}
      />
    </MessagesProvider>,
  );
  return { handlers, container };
}

function rangeInputs(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]'));
}

describe("ImageSection volume mode", () => {
  it("renders one value and one alpha slider per opacity point", () => {
    const { container } = renderSection();
    expect(screen.getByText(messages.properties.volumeOpacity)).toBeDefined();
    expect(rangeInputs(container).length).toBe(4);
  });

  it("appends a midpoint control point via the add button", async () => {
    const user = userEvent.setup();
    const { handlers } = renderSection();
    await user.click(screen.getByRole("button", { name: messages.properties.volumeOpacityAdd }));
    expect(handlers.onVolumeOpacityPoints).toHaveBeenCalledTimes(1);
    expect(handlers.onVolumeOpacityPoints).toHaveBeenCalledWith([
      { value: 0, alpha: 0 },
      { value: 0.5, alpha: 0.5 },
      { value: 1, alpha: 1 },
    ]);
  });

  it("disables add at 4 points and remove at 2 points", () => {
    const fourPoints: VolumeOpacityPoint[] = [
      { value: 0, alpha: 0 },
      { value: 0.3, alpha: 0.3 },
      { value: 0.7, alpha: 0.7 },
      { value: 1, alpha: 1 },
    ];
    renderSection({ volumeOpacityPoints: fourPoints });
    const add = screen.getByRole("button", {
      name: messages.properties.volumeOpacityAdd,
    }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);

    const { handlers } = renderSection({ volumeOpacityPoints: twoPoints });
    const removes = screen.getAllByRole("button", {
      name: messages.properties.volumeOpacityRemove,
    }) as HTMLButtonElement[];
    const remove = removes[removes.length - 1];
    expect(remove.disabled).toBe(true);
    fireEvent.click(remove);
    expect(handlers.onVolumeOpacityPoints).not.toHaveBeenCalled();
  });

  it("removes the last point when more than two exist", async () => {
    const user = userEvent.setup();
    const threePoints: VolumeOpacityPoint[] = [
      { value: 0, alpha: 0 },
      { value: 0.5, alpha: 0.5 },
      { value: 1, alpha: 1 },
    ];
    const { handlers } = renderSection({ volumeOpacityPoints: threePoints });
    await user.click(
      screen.getByRole("button", { name: messages.properties.volumeOpacityRemove }),
    );
    expect(handlers.onVolumeOpacityPoints).toHaveBeenCalledWith([
      { value: 0, alpha: 0 },
      { value: 0.5, alpha: 0.5 },
    ]);
  });

  it("reports slider changes through onVolumeOpacityPoints, clamped to neighbours", () => {
    const { handlers, container } = renderSection();
    const sliders = rangeInputs(container);
    // First slider is point 0's value; clamp keeps it between 0 and point 1's value.
    fireEvent.change(sliders[0], { target: { value: "0.4" } });
    expect(handlers.onVolumeOpacityPoints).toHaveBeenCalledWith([
      { value: 0.4, alpha: 0 },
      { value: 1, alpha: 1 },
    ]);

    // Second slider is point 0's alpha; it clamps to [0, 1].
    fireEvent.change(sliders[1], { target: { value: "0.9" } });
    expect(handlers.onVolumeOpacityPoints).toHaveBeenLastCalledWith([
      { value: 0, alpha: 0.9 },
      { value: 1, alpha: 1 },
    ]);
  });
});

describe("ImageSection slice mode", () => {
  it("renders the axis select and a slider bounded by sliceMin/sliceMax", () => {
    const { container } = renderSection({ imageMode: "slice", sliceMin: 2, sliceMax: 9, sliceIndex: 4 });
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["X", "Y", "Z"]);

    const slider = rangeInputs(container)[0];
    expect(slider.min).toBe("2");
    expect(slider.max).toBe("9");
    expect(slider.value).toBe("4");
  });

  it("reports axis and index changes", async () => {
    const user = userEvent.setup();
    const { handlers, container } = renderSection({ imageMode: "slice" });
    await user.selectOptions(container.querySelector("select") as HTMLSelectElement, "Y");
    expect(handlers.onSliceAxis).toHaveBeenCalledWith("Y");

    fireEvent.change(rangeInputs(container)[0], { target: { value: "7" } });
    expect(handlers.onSliceIndex).toHaveBeenCalledWith(7);
  });
});
