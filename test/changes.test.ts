import { describe, expect, it } from "vitest";
import { applyTransform, bpMove, pctChange, refClose, toBands, type Points } from "../src/changes";

// Ports collector/tests/test_changes.py.

const points = (obj: Record<string, number>): Points => new Map(Object.entries(obj));
const plain = (p: Points): Record<string, number> => Object.fromEntries(p);

const CLOSES = points({
  // Mon 2026-06-29 .. Fri 2026-07-03, then Mon 2026-07-06 .. Wed 2026-07-08
  "2026-06-29": 100.0,
  "2026-06-30": 101.0,
  "2026-07-01": 102.0,
  "2026-07-02": 103.0,
  "2026-07-03": 104.0,
  "2026-07-06": 105.0,
  "2026-07-07": 106.0,
  "2026-07-08": 107.0,
});

describe("pctChange", () => {
  it("computes percent moves", () => {
    expect(pctChange(110.0, 100.0)).toBe(10.0);
    expect(pctChange(95.0, 100.0)).toBe(-5.0);
  });

  it("returns null without a usable reference", () => {
    expect(pctChange(110.0, null)).toBeNull();
    expect(pctChange(110.0, 0.0)).toBeNull();
  });
});

describe("bpMove", () => {
  it("converts a percentage-point move to basis points", () => {
    expect(bpMove(4.12, 4.15)).toBe(-3);
    expect(bpMove(4.12, null)).toBeNull();
  });
});

describe("refClose", () => {
  it("1d skips the same day", () => {
    // asof Wed 8th -> previous close is Tue 7th
    expect(refClose(CLOSES, "2026-07-08", "1d")).toBe(106.0);
  });

  it("1d reaches back over a weekend", () => {
    // asof Mon 6th -> previous close is Fri 3rd
    expect(refClose(CLOSES, "2026-07-06", "1d")).toBe(104.0);
  });

  it("1w takes the prior trading day when the target is a holiday", () => {
    expect(refClose(CLOSES, "2026-07-08", "1w")).toBe(102.0);
    expect(refClose(CLOSES, "2026-07-06", "1w")).toBe(100.0);
  });

  it("1m uses the latest close on or before 30 days back", () => {
    const closes = points({ "2026-07-20": 10.0, "2026-07-24": 11.0, "2026-08-20": 12.0 });
    expect(refClose(closes, "2026-08-24", "1m")).toBe(11.0); // 8/24-30d = 7/25 -> 7/24
  });

  it("ytd uses the last close of the prior year", () => {
    const closes = new Map(CLOSES);
    closes.set("2025-12-30", 90.0); // Dec 31 2025 not a trading day here
    expect(refClose(closes, "2026-07-08", "ytd")).toBe(90.0);
  });

  it("returns null when history is missing", () => {
    expect(refClose(CLOSES, "2026-07-08", "1y")).toBeNull();
    expect(refClose(new Map(), "2026-07-08", "1d")).toBeNull();
  });

  it("raises for an unknown horizon", () => {
    expect(() => refClose(CLOSES, "2026-07-08", "3d")).toThrow(/unknown horizon/);
  });
});

describe("applyTransform", () => {
  it("handles none, diff and pct_prev", () => {
    const pts = points({ "2026-01-01": 100.0, "2026-02-01": 102.0, "2026-03-01": 104.04 });
    expect(plain(applyTransform(pts, "none"))).toEqual(plain(pts));
    expect(plain(applyTransform(pts, "diff"))).toEqual({ "2026-02-01": 2.0, "2026-03-01": 2.04 });
    expect(plain(applyTransform(pts, "pct_prev"))).toEqual({
      "2026-02-01": 2.0,
      "2026-03-01": 2.0,
    });
  });

  it("handles yoy", () => {
    const pts = points({
      "2025-06-01": 100.0,
      "2025-07-01": 100.5,
      "2026-06-01": 103.0,
      "2026-07-01": 103.5,
    });
    expect(plain(applyTransform(pts, "yoy"))).toEqual({ "2026-06-01": 3.0, "2026-07-01": 2.99 });
  });

  it("drops Feb 29 from yoy rather than throwing", () => {
    // Python raises ValueError building date(year-1, 2, 29); the point is skipped.
    const pts = points({ "2023-02-28": 100.0, "2024-02-29": 103.0 });
    expect(plain(applyTransform(pts, "yoy"))).toEqual({});
  });

  it("raises for an unknown transform", () => {
    expect(() => applyTransform(points({}), "nope")).toThrow(/unknown transform/);
  });
});

describe("toBands", () => {
  it("pairs runs of ones", () => {
    const pts = points({
      "2026-01-01": 0.0,
      "2026-02-01": 1.0,
      "2026-03-01": 1.0,
      "2026-04-01": 0.0,
      "2026-05-01": 1.0,
    });
    expect(toBands(pts)).toEqual([
      ["2026-02-01", "2026-04-01"],
      ["2026-05-01", "2026-05-01"], // still-open run ends at last obs
    ]);
  });

  it("handles empty and all-zero inputs", () => {
    expect(toBands(new Map())).toEqual([]);
    expect(toBands(points({ "2026-01-01": 0.0 }))).toEqual([]);
  });
});
