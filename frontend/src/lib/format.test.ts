import { describe, expect, it } from "vitest";
import { formatBounds, formatCount, humanFileSize } from "./format";

describe("humanFileSize", () => {
  it("keeps small values in bytes", () => {
    expect(humanFileSize(512)).toBe("512 B");
  });
  it("scales to KB/MB", () => {
    expect(humanFileSize(2048)).toBe("2.0 KB");
    expect(humanFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
  });
  it("renders dash for null", () => {
    expect(formatCount(null)).toBe("-");
    expect(formatCount(undefined)).toBe("-");
  });
});

describe("formatBounds", () => {
  it("formats a 6-tuple per axis", () => {
    expect(formatBounds([0, 1, 0, 2, -1, 1])).toBe("X[0, 1]  Y[0, 2]  Z[-1, 1]");
  });
  it("returns dash for invalid input", () => {
    expect(formatBounds(null)).toBe("-");
    expect(formatBounds([1, 2, 3])).toBe("-");
  });
});
