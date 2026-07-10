import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

function Bomb(): never {
  throw new Error("boom");
}

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary fallbackTitle="crashed" fallbackHint="reload">
        <p>content</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("content")).toBeDefined();
  });

  it("shows the fallback instead of blanking the page on a render crash", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary fallbackTitle="crashed" fallbackHint="reload">
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText("crashed")).toBeDefined();
    expect(screen.getByText(/boom/)).toBeDefined();
    consoleError.mockRestore();
  });

  it("recovers when resetKey changes, as the fallback hint promises", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary fallbackTitle="crashed" fallbackHint="reload" resetKey="ds1">
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeDefined();

    // Selecting another dataset (new resetKey) must clear the caught error.
    rerender(
      <ErrorBoundary fallbackTitle="crashed" fallbackHint="reload" resetKey="ds2">
        <p>recovered</p>
      </ErrorBoundary>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("recovered")).toBeDefined();
    consoleError.mockRestore();
  });

  it("keeps the fallback while resetKey is unchanged", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary fallbackTitle="crashed" fallbackHint="reload" resetKey="ds1">
        <Bomb />
      </ErrorBoundary>,
    );
    rerender(
      <ErrorBoundary fallbackTitle="crashed" fallbackHint="reload" resetKey="ds1">
        <p>unreached</p>
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.queryByText("unreached")).toBeNull();
    consoleError.mockRestore();
  });
});
