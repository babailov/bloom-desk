import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import FF_JSON from "./fixtures/ff_calendar.json?raw";
import FRED_JSON from "./fixtures/fred_dgs10.json?raw";
import DBNOMICS_JSON from "./fixtures/dbnomics_ism.json?raw";
import OECD_CSV from "./fixtures/oecd_cli.csv?raw";
import CFTC_JSON from "./fixtures/cftc_vix.json?raw";
import CBOE_JSON from "./fixtures/cboe_daily.json?raw";
import YAHOO_SPX from "./fixtures/yahoo_spx.json?raw";
import XLS_DATA_URI from "./fixtures/aaii_sentiment.xls?inline";

import {
  fetchCalendar,
  fetchCalendarIfDue,
  hasReleaseOn,
  shouldRefresh,
  type Release,
} from "../src/fetchers/macro";
import { fetchCycle } from "../src/fetchers/cycle";
import { runFetcher } from "../src/runner";
import { Store } from "../src/store";
import type { CalendarMapEntry, CycleSeriesCfg } from "../src/config";

// Ports test_macro / test_cycle / test_runner.

const store = () => new Store(env.DB);

function aaiiFixture(): ArrayBuffer {
  const base64 = XLS_DATA_URI.slice(XLS_DATA_URI.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const CAL_MAP: CalendarMapEntry[] = [
  { country: "USD", match: "Core CPI", series: "us-core-cpi-yoy" },
  { country: "USD", match: "CPI", series: "us-cpi-yoy" },
  { country: "EUR", match: "CPI", series: "ez-hicp-yoy" },
];

const fakeGet = async () => FF_JSON;

async function releases(key: string): Promise<Release[]> {
  const doc = await store().doc<{ releases: Release[] }>(key);
  return doc?.payload.releases ?? [];
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM series_points"),
    env.DB.prepare("DELETE FROM docs"),
    env.DB.prepare("DELETE FROM fetcher_status"),
  ]);
});

describe("macro calendar", () => {
  it("filters to high-impact US and EU and maps series ids", async () => {
    expect(await fetchCalendar("http://x", CAL_MAP, store(), fakeGet)).toBe("forexfactory");

    const rows = await releases("macro_calendar");
    const titles = rows.map((r) => r.name);
    expect(titles).not.toContain("French Trade Balance"); // Low impact dropped
    expect(titles).not.toContain("BOJ Policy Rate"); // JPY dropped

    const core = rows.find((r) => r.name === "Core CPI m/m")!;
    expect(core.series_id).toBe("us-core-cpi-yoy"); // first-match-wins ordering
    expect(core.actual).toBeNull();
    expect(core.consensus).toBe("0.3%");
    expect(core.previous).toBe("0.2%");

    const ez = rows.find((r) => r.name.includes("Flash"))!;
    expect(ez.series_id).toBe("ez-hicp-yoy");
    expect(ez.actual).toBe("1.8%");
  });

  it("upserts history rather than appending", async () => {
    const now = new Date("2026-07-09T12:00:00Z");
    await fetchCalendar("http://x", CAL_MAP, store(), fakeGet, now);
    expect(await releases("macro_history")).toHaveLength(3);

    const events = JSON.parse(FF_JSON) as { title?: string; actual?: string }[];
    for (const ev of events) {
      if (ev.title === "Core CPI m/m") ev.actual = "0.4%"; // released since the last fetch
    }
    await fetchCalendar("http://x", CAL_MAP, store(), async () => JSON.stringify(events), now);

    const hist = await releases("macro_history");
    expect(hist).toHaveLength(3); // upserted, not appended
    expect(hist.find((r) => r.name === "Core CPI m/m")?.actual).toBe("0.4%");
    expect(hist.map((r) => r.time)).toEqual([...hist.map((r) => r.time)].sort());
  });

  it("prunes history older than 30 days and never admits unparseable times", async () => {
    await store().putDoc(
      "macro_history",
      {
        releases: [
          { name: "Ancient NFP", country: "USD", time: "2026-05-01T08:30:00-04:00" },
          { name: "Recent GDP", country: "USD", time: "2026-06-25T08:30:00-04:00" },
          { name: "No time", country: "USD", time: "TBD" },
        ],
      },
      "forexfactory",
    );

    await fetchCalendar("http://x", CAL_MAP, store(), fakeGet, new Date("2026-07-09T12:00:00Z"));

    const names = (await releases("macro_history")).map((r) => r.name);
    expect(names).not.toContain("Ancient NFP"); // > 30 days old
    expect(names).not.toContain("No time"); // unparseable time never enters history
    expect(names).toContain("Recent GDP"); // kept alongside the 3 fresh events
    expect(names).toHaveLength(4);
  });

  it("fetches when the calendar is fresh but history is missing", async () => {
    // Rollout/self-heal: a pre-history deployment leaves a fresh macro_calendar
    // with no macro_history doc; the skip logic must not strand the panel empty
    // until the 6h cadence expires.
    const now = new Date("2026-07-09T12:00:00Z");
    await store().putDoc("macro_calendar", { releases: [] }, "forexfactory");

    let calls = 0;
    const countingGet = async () => {
      calls++;
      return FF_JSON;
    };

    await fetchCalendarIfDue("http://x", CAL_MAP, store(), countingGet, now);
    expect(calls).toBe(1); // fetched despite fresh calendar
    expect(await store().doc("macro_history")).not.toBeNull();

    // with history present and calendar fresh, the next tick skips again
    await fetchCalendarIfDue("http://x", CAL_MAP, store(), countingGet, now);
    expect(calls).toBe(1);
  });

  it("skips malformed events without blanking the calendar", async () => {
    const events = JSON.parse(FF_JSON) as unknown[];
    events.unshift({ title: "Broken event", country: "USD" }); // no impact key

    await fetchCalendar("http://x", CAL_MAP, store(), async () => JSON.stringify(events));
    expect(await releases("macro_calendar")).toHaveLength(3);
  });

  it("detects releases on a day and tolerates bad time strings", () => {
    const rows = [{ time: "2026-07-10T12:30:00-04:00" }] as Release[];
    expect(hasReleaseOn(rows, "2026-07-10")).toBe(true);
    expect(hasReleaseOn(rows, "2026-07-11")).toBe(false);

    const messy = [{ time: "TBD" }, { time: "2026-07-10T12:30:00-04:00" }] as Release[];
    expect(hasReleaseOn(messy, "2026-07-10")).toBe(true);
    expect(hasReleaseOn([{ time: "TBD" }] as Release[], "2026-07-10")).toBe(false);
  });

  it("implements the 6h baseline and 55m release-day cadence", () => {
    const now = new Date("2026-07-09T12:00:00Z");
    expect(shouldRefresh(null, false, now)).toBe(true); // never fetched
    expect(shouldRefresh("2026-07-09T11:30:00Z", false, now)).toBe(false); // 30min, quiet day
    expect(shouldRefresh("2026-07-09T05:00:00Z", false, now)).toBe(true); // >6h old
    expect(shouldRefresh("2026-07-09T11:30:00Z", true, now)).toBe(false); // 30min, release day
    expect(shouldRefresh("2026-07-09T10:55:00Z", true, now)).toBe(true); // >55min, release day
  });

  it("keeps the refresh clock on the doc, not on hourly success stamps", async () => {
    // Regression: composed runFetcher x fetchCalendarIfDue across ticks. The
    // runner re-stamps last_success every tick including skips, so reading the
    // clock from there would refetch hourly forever.
    const events = JSON.parse(FF_JSON) as { date?: string }[];
    for (const ev of events) ev.date = "2020-01-01T09:00:00-04:00"; // quiet-day feed
    const quietFeed = JSON.stringify(events);

    let calls = 0;
    const countingGet = async () => {
      calls++;
      return quietFeed;
    };

    const base = Date.now();
    const tick = (at: Date) =>
      runFetcher("macro", store(), () =>
        fetchCalendarIfDue("http://x", CAL_MAP, store(), countingGet, at),
      );

    await tick(new Date(base));
    expect(calls).toBe(1);
    for (const h of [1, 2, 3, 4, 5]) await tick(new Date(base + h * 3600_000));
    expect(calls).toBe(1); // quiet-day hourly ticks: no refetch
    await tick(new Date(base + 6 * 3600_000 + 5 * 60_000));
    expect(calls).toBe(2); // past 6h baseline: refetch
  });
});

describe("cycle", () => {
  const ALL_SOURCES: CycleSeriesCfg[] = [
    { id: "vix", name: "VIX", unit: "idx", fred: "VIXCLS" },
    { id: "ism", name: "ISM", unit: "idx", dbnomics: "ISM/pmi/pm" },
    { id: "cli", name: "CLI", unit: "idx", oecd: "F/USA.M.LI...AA...H" },
    { id: "cot", name: "COT", unit: "contracts", cftc: "1170E1" },
    { id: "pc", name: "PC", unit: "ratio", cboe: "TOTAL PUT/CALL RATIO" },
    { id: "aaii", name: "AAII", unit: "pts", aaii: "bull_bear_spread" },
    { id: "ratio", name: "R", unit: "ratio", yahoo_ratio: ["RSP", "SPY"] },
  ];

  function fakeIo(urls: string[]) {
    const getText = async (url: string) => {
      urls.push(url);
      if (url.includes("stlouisfed")) return FRED_JSON;
      if (url.includes("db.nomics")) return DBNOMICS_JSON;
      if (url.includes("sdmx.oecd")) return OECD_CSV;
      if (url.includes("cftc.gov")) return CFTC_JSON;
      if (url.includes("cboe.com")) return CBOE_JSON;
      if (url.includes("yahoo.com")) return YAHOO_SPX;
      throw new Error(`unexpected url ${url}`);
    };
    const getBytes = async (url: string) => {
      urls.push(url);
      return aaiiFixture();
    };
    return { getText, getBytes };
  }

  it("dispatches every source kind", async () => {
    const urls: string[] = [];
    const { getText, getBytes } = fakeIo(urls);

    const label = await fetchCycle(ALL_SOURCES, store(), "test-key", getText, getBytes, "2026-08-24");
    expect(label).toBe("cycle");

    for (const cfg of ALL_SOURCES) {
      expect((await store().points(`cycle:${cfg.id}`)).size, cfg.id).toBeGreaterThan(0);
    }
    expect(urls.filter((u) => u.includes("yahoo.com"))).toHaveLength(2); // numerator + denominator
  });

  it("isolates a failing series and still stores the good one", async () => {
    const series: CycleSeriesCfg[] = [
      { id: "bad", name: "Bad", unit: "idx", dbnomics: "NOPE/x/y" },
      { id: "vix", name: "VIX", unit: "idx", fred: "VIXCLS" },
    ];
    const getText = async (url: string) => {
      if (url.includes("db.nomics")) throw new Error("HTTP 404");
      return FRED_JSON;
    };
    const getBytes = async () => {
      throw new Error("unused");
    };

    await expect(fetchCycle(series, store(), "k", getText, getBytes)).rejects.toThrow(
      /1\/2 cycle series failed.*bad/,
    );
    expect((await store().points("cycle:vix")).size).toBeGreaterThan(0);
  });

  it("reports a series with no source configured", async () => {
    const getText = async () => {
      throw new Error("unused");
    };
    await expect(
      fetchCycle([{ id: "empty", name: "E", unit: "idx" }], store(), "k", getText, async () => {
        throw new Error("unused");
      }),
    ).rejects.toThrow(/empty/);
  });

  it("drops points outside valid_range", async () => {
    const urls: string[] = [];
    const { getText, getBytes } = fakeIo(urls);

    await fetchCycle(
      [{ id: "ism", name: "ISM", unit: "idx", dbnomics: "ISM/pmi/pm", valid_range: [20, 80] }],
      store(),
      "k",
      getText,
      getBytes,
    );
    expect(new Set((await store().points("cycle:ism")).values())).toEqual(new Set([49.5, 48.7]));

    // fred fixture holds 4.15 and 4.12; narrow the window so 4.12 falls out
    await fetchCycle(
      [{ id: "vixn", name: "V", unit: "idx", fred: "VIXCLS", valid_range: [4.13, 4.2] }],
      store(),
      "k",
      getText,
      getBytes,
    );
    expect([...(await store().points("cycle:vixn")).values()]).toEqual([4.15]);
  });
});

describe("runner", () => {
  it("records the active source on success", async () => {
    await runFetcher("equity", store(), async () => "yahoo");

    const st = (await store().statuses())[0]!;
    expect(st.name).toBe("equity");
    expect(st.active_source).toBe("yahoo");
    expect(st.last_success).not.toBeNull();
  });

  it("records and swallows an error", async () => {
    await runFetcher("news", store(), async () => {
      throw new Error("upstream down");
    }); // must NOT raise

    const st = (await store().statuses())[0]!;
    expect(st.last_error).toBe("Error: upstream down");
    expect(st.last_success).toBeNull();
  });
});
