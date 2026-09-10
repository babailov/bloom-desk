import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Store, shiftIsoDate, type Point } from "../src/store";

// Ports collector/tests/test_store.py. Same cases, same assertions, plus
// coverage for the two things D1 forced that SQLite did not: the bound
// parameter cap and the bounded upsert.

function store(): Store {
  return new Store(env.DB);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM series_points"),
    env.DB.prepare("DELETE FROM docs"),
    env.DB.prepare("DELETE FROM fetcher_status"),
  ]);
});

describe("points", () => {
  it("upserts and reads back, overwriting on conflict", async () => {
    const s = store();
    await s.upsertPoints("idx:SPX", [
      ["2026-07-07", 6200.0],
      ["2026-07-08", 6234.5],
    ]);
    await s.upsertPoints("idx:SPX", [["2026-07-08", 6240.0]]);

    expect(Object.fromEntries(await s.points("idx:SPX"))).toEqual({
      "2026-07-07": 6200.0,
      "2026-07-08": 6240.0,
    });
  });

  it("filters by since", async () => {
    const s = store();
    await s.upsertPoints("m", [
      ["2025-01-01", 1.0],
      ["2026-01-01", 2.0],
    ]);
    expect(Object.fromEntries(await s.points("m", "2025-06-01"))).toEqual({ "2026-01-01": 2.0 });
  });

  it("returns empty for an unknown series", async () => {
    expect((await store().points("nope")).size).toBe(0);
  });

  it("skips non-numeric values", async () => {
    const s = store();
    await s.upsertPoints("m", [["2026-01-01", 1.0]]);
    // SQLite's dynamic typing allows TEXT in a REAL column. One corrupt row
    // must not poison the series.
    await env.DB.prepare(
      "INSERT INTO series_points(series_id, d, value) VALUES('m', '2026-01-02', 'oops')",
    ).run();

    expect(Object.fromEntries(await s.points("m"))).toEqual({ "2026-01-01": 1.0 });
  });

  it("returns points oldest first", async () => {
    const s = store();
    await s.upsertPoints("m", [
      ["2026-03-01", 3.0],
      ["2026-01-01", 1.0],
      ["2026-02-01", 2.0],
    ]);
    expect([...(await s.points("m")).keys()]).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });
});

describe("bound parameter cap", () => {
  it("writes a series far larger than D1's 100-parameter limit", async () => {
    // 2,600 points is a 10-year daily FRED history: 7,800 bound parameters
    // against a cap of 100. This is the case that breaks a naive executemany
    // port, so it is asserted rather than assumed.
    const s = store();
    const points: Point[] = Array.from({ length: 2600 }, (_, i) => [
      shiftIsoDate("2016-01-01", i),
      i * 1.5,
    ]);

    await s.upsertPoints("cycle:big", points);

    const read = await s.points("cycle:big");
    expect(read.size).toBe(2600);
    expect(read.get("2016-01-01")).toBe(0);
    expect(read.get(shiftIsoDate("2016-01-01", 2599))).toBe(2599 * 1.5);
  });

  it("writes a chunk boundary exactly", async () => {
    // 33 rows per statement, so 33 and 34 straddle the boundary.
    const s = store();
    for (const n of [33, 34]) {
      const points: Point[] = Array.from({ length: n }, (_, i) => [
        shiftIsoDate("2020-01-01", i),
        i,
      ]);
      await s.upsertPoints(`edge:${n}`, points);
      expect((await s.points(`edge:${n}`)).size).toBe(n);
    }
  });

  it("does nothing for an empty payload", async () => {
    const s = store();
    await s.upsertPoints("empty", []);
    expect((await s.points("empty")).size).toBe(0);
  });
});

describe("upsertRecentPoints", () => {
  it("takes the whole payload when the series is empty", async () => {
    const s = store();
    const points: Point[] = [
      ["2020-01-01", 1],
      ["2026-01-01", 2],
    ];
    expect(await s.upsertRecentPoints("fresh", points)).toBe(2);
    expect((await s.points("fresh")).size).toBe(2);
  });

  it("skips history older than the revision window but keeps recent revisions", async () => {
    const s = store();
    await s.upsertPoints("cycle:x", [
      ["2020-01-01", 1],
      ["2026-01-01", 2],
    ]);

    // Newest stored is 2026-01-01, so a 30-day window re-sends from 2025-12-02.
    // The 2020 point is old news; the 2026 one is a revision and must land.
    const written = await s.upsertRecentPoints(
      "cycle:x",
      [
        ["2020-01-01", 999],
        ["2026-01-01", 22],
        ["2026-02-01", 3],
      ],
      30,
    );

    expect(written).toBe(2);
    expect(Object.fromEntries(await s.points("cycle:x"))).toEqual({
      "2020-01-01": 1, // untouched, not clobbered by the 999
      "2026-01-01": 22, // revision applied
      "2026-02-01": 3, // new point applied
    });
  });

  it("reports zero for an empty payload", async () => {
    expect(await store().upsertRecentPoints("nothing", [])).toBe(0);
  });
});

describe("maxPointDate", () => {
  it("returns null for an unknown series and the newest date otherwise", async () => {
    const s = store();
    expect(await s.maxPointDate("nope")).toBeNull();
    await s.upsertPoints("m", [
      ["2026-01-01", 1],
      ["2026-03-01", 2],
      ["2026-02-01", 3],
    ]);
    expect(await s.maxPointDate("m")).toBe("2026-03-01");
  });
});

describe("docs", () => {
  it("round-trips and overwrites", async () => {
    const s = store();
    await s.putDoc("news", { items: [1] }, "rss");
    await s.putDoc("news", { items: [1, 2] }, "rss");

    const doc = await s.doc<{ items: number[] }>("news");
    expect(doc?.payload).toEqual({ items: [1, 2] });
    expect(doc?.source).toBe("rss");
    expect(doc?.updated_at.endsWith("Z")).toBe(true);
    expect(await s.doc("missing")).toBeNull();
  });

  it("treats a corrupted doc as missing", async () => {
    const s = store();
    await env.DB.prepare("INSERT INTO docs(key, payload, updated_at, source) VALUES(?,?,?,?)")
      .bind("news", "{not json", "2026-07-08T00:00:00Z", "rss")
      .run();
    expect(await s.doc("news")).toBeNull();
  });
});

describe("fetcher status", () => {
  it("keeps success and error history independent", async () => {
    const s = store();
    await s.recordError("equity", "boom");
    await s.recordSuccess("equity", "yahoo");
    await s.recordError("news", "feed died");

    const byName = new Map((await s.statuses()).map((st) => [st.name, st]));
    expect(byName.get("equity")?.active_source).toBe("yahoo");
    expect(byName.get("equity")?.last_success).not.toBeNull();
    expect(byName.get("equity")?.last_error).toBe("boom"); // error history kept
    expect(byName.get("news")?.last_success).toBeNull();
  });

  it("orders statuses by name", async () => {
    const s = store();
    await s.recordSuccess("zulu", "z");
    await s.recordSuccess("alpha", "a");
    expect((await s.statuses()).map((st) => st.name)).toEqual(["alpha", "zulu"]);
  });

  it("looks up one status by name", async () => {
    const s = store();
    await s.recordSuccess("cycle", "cycle");
    expect((await s.status("cycle"))?.active_source).toBe("cycle");
    expect(await s.status("nope")).toBeNull();
  });
});

describe("pruneOutsideRange", () => {
  it("deletes points outside the range", async () => {
    const s = store();
    await s.upsertPoints("cycle:x", [
      ["2026-01-01", 50.0],
      ["2026-02-01", 10.0],
    ]);
    await s.pruneOutsideRange("cycle:x", 20.0, 80.0);
    expect(Object.fromEntries(await s.points("cycle:x"))).toEqual({ "2026-01-01": 50.0 });
  });
});

describe("shiftIsoDate", () => {
  it("shifts in whole UTC days across month and year boundaries", () => {
    expect(shiftIsoDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftIsoDate("2026-02-28", 1)).toBe("2026-03-01"); // 2026 is not a leap year
    expect(shiftIsoDate("2024-02-28", 1)).toBe("2024-02-29"); // 2024 is
    expect(shiftIsoDate("2026-06-15", 0)).toBe("2026-06-15");
  });
});
