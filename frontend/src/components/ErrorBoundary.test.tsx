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
});
