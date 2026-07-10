import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useProjectScope } from "./useProjectScope";

describe("useProjectScope", () => {
  it("capture() returns null when no project is current", () => {
    const { result } = renderHook(() => useProjectScope());
    expect(result.current.capture()).toBeNull();
  });

  it("returns the same object across re-renders (effects depending on it must not loop)", () => {
    const { result, rerender } = renderHook(() => useProjectScope());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("tickets stay current until a project switch invalidates them", () => {
    const { result } = renderHook(() => useProjectScope());
    result.current.currentProjectRef.current = "p1";

    const ticket = result.current.capture();
    expect(ticket).not.toBeNull();
    expect(ticket!.projectId).toBe("p1");
    expect(ticket!.stillCurrent()).toBe(true);

    result.current.beginProjectSwitch("p2");
    expect(ticket!.stillCurrent()).toBe(false);

    // A ticket captured after the switch tracks the new project.
    const fresh = result.current.capture();
    expect(fresh!.projectId).toBe("p2");
    expect(fresh!.stillCurrent()).toBe(true);
  });

  it("switching to the same project id still bumps the epoch and stales tickets", () => {
    const { result } = renderHook(() => useProjectScope());
    result.current.beginProjectSwitch("p1");
    const ticket = result.current.capture();
    expect(ticket!.stillCurrent()).toBe(true);

    result.current.beginProjectSwitch("p1");
    expect(ticket!.stillCurrent()).toBe(false);
  });

  it("stillSelected is only true for the same dataset with no newer selection", () => {
    const { result } = renderHook(() => useProjectScope());
    result.current.beginProjectSwitch("p1");
    result.current.beginSelection("d1");

    const ticket = result.current.capture();
    expect(ticket).not.toBeNull();
    expect(ticket!.stillSelected("d1")).toBe(true);
    expect(ticket!.stillSelected("d2")).toBe(false);

    result.current.beginSelection("d2");
    expect(ticket!.stillSelected("d1")).toBe(false);
    // Even the newly selected dataset fails on the stale ticket: a newer
    // beginSelection superseded the captured selection request.
    expect(ticket!.stillSelected("d2")).toBe(false);
  });
});
