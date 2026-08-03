import { describe, expect, it } from "vitest";
import { createViewerContextPool } from "./contextPool";

describe("viewer WebGL context pool", () => {
  it("caps active contexts at two and reuses a released slot", () => {
    const pool = createViewerContextPool(2);
    const primary = pool.tryAcquire("primary");
    const secondary = pool.tryAcquire("secondary");

    expect(primary).not.toBeNull();
    expect(secondary).not.toBeNull();
    expect(pool.activeCount).toBe(2);
    expect(pool.tryAcquire("hidden-third-view")).toBeNull();

    secondary?.release();
    expect(pool.activeCount).toBe(1);
    const switchedSecondary = pool.tryAcquire("switched-secondary");
    expect(switchedSecondary).not.toBeNull();
    expect(pool.activeCount).toBe(2);

    primary?.release();
    switchedSecondary?.release();
    expect(pool.activeCount).toBe(0);
  });

  it("makes cleanup idempotent for React effect replay", () => {
    const pool = createViewerContextPool(1);
    const lease = pool.tryAcquire("strict-mode-view");
    expect(lease?.released).toBe(false);

    lease?.release();
    lease?.release();

    expect(lease?.released).toBe(true);
    expect(pool.activeCount).toBe(0);
    expect(pool.tryAcquire("remounted-view")).not.toBeNull();
  });

  it("rejects invalid limits", () => {
    expect(() => createViewerContextPool(0)).toThrow(RangeError);
    expect(() => createViewerContextPool(1.5)).toThrow(RangeError);
  });
});
