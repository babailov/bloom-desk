import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { buildDashboard } from "../src/panels";
import { Store, shiftIsoDate } from "../src/store";
import type { CycleSeriesCfg, CycleTabCfg, IndexCfg } from "../src/config";

// Ports collector/tests/test_panels.py.

const NOW = new Date("2026-07-08T14:30:00Z");
const INDEXES: IndexCfg[] = [{ symbol: "SPX", name: "S&P 500", yahoo: "^GSPC" }];

// rate_refs rows have no per-row 'ts' (unlike bond/equity quotes); the panel
// anchors asof to the doc's own updated_at, which putDoc always stamps with the
// real wall-clock time. So ref series fixtures are seeded relative to today,
// not a fixed calendar date, for the bp-change math below to land on
// non-trivial, reproducible values.
const TODAY = new Date().toISOString().slice(0, 10);

const store = () => new Store(env.DB);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM series_points"),
    env.DB.prepare("DELETE FROM docs"),
    env.DB.prepare("DELETE FROM fetcher_status"),
  ]);
});

async function seeded(): Promise<Store> {
  const s = store();

  await s.upsertPoints("idx:SPX", [
    ["2025-12-31", 5800.0],
    ["2026-06-30", 6100.0],
    ["2026-07-01", 6150.0],
    ["2026-07-07", 6200.0],
    ["2026-07-08", 6234.5],
  ]);
  await s.putDoc(
    "equity_quotes",
    { SPX: { last: 6234.5, ts: "2026-07-08T14:00:00Z", source: "yahoo", delayed: true } },
    "yahoo",
  );

  await s.upsertPoints("yield:US10Y", [
    ["2026-07-01", 4.2],
    ["2026-07-07", 4.15],
    ["2026-07-08", 4.12],
  ]);
  await s.putDoc(
    "bond_quotes",
    {
      US10Y: { country: "US", tenor: "10Y", yield_pct: 4.12, ts: "2026-07-08T00:00:00Z", source: "fred" },
      US3M: { country: "US", tenor: "3M", yield_pct: 3.89, ts: "2026-07-08T00:00:00Z", source: "fred" },
      USCB: { country: "US", label: "FED", yield_pct: 3.75, ts: "2026-07-08T00:00:00Z", source: "fred" },
      // no 3M/CB: null cells
      JP10Y: { country: "JP", tenor: "10Y", yield_pct: 4.6, ts: "2026-07-08T00:00:00Z", source: "bundesbank" },
    },
    "bundesbank+fred",
  );

  await s.putDoc(
    "macro_calendar",
    {
      releases: [
        { name: "CPI y/y", country: "USD", time: "2026-07-10T12:30:00-04:00", impact: "High", series_id: "us-cpi-yoy" },
        // released before NOW -> past section only
        { name: "Retail Sales m/m", country: "USD", time: "2026-07-08T08:30:00-04:00", impact: "High", actual: "0.4%", series_id: "us-retail" },
      ],
    },
    "forexfactory",
  );
  await s.putDoc(
    "macro_history",
    {
      releases: [
        // outside the 7d window
        { name: "Old GDP q/q", country: "USD", time: "2026-06-20T08:30:00-04:00", actual: "2.1%" },
        { name: "Non-Farm Payrolls", country: "USD", time: "2026-07-03T08:30:00-04:00", actual: "185k" },
        { name: "Retail Sales m/m", country: "USD", time: "2026-07-08T08:30:00-04:00", actual: "0.4%" },
      ],
    },
    "forexfactory",
  );

  await s.putDoc("news", { items: [{ headline: "h", url: "u", feed: "FT" }] }, "rss");
  await s.putDoc("defi_pools", { rows: [{ pool: "Clearstar", apy: 7.98 }] }, "zyfai");
  await s.putDoc("midnight_curve", { rows: [{ maturity: "2026-08-28", lend_apy: 4.09 }] }, "morpho");
  await s.putDoc(
    "morpho_markets",
    { rows: [{ collateral: "cbBTC", lltv_pct: 86.0, tvl_usd: 1413119205.8 }] },
    "morpho-blue",
  );

  await s.upsertPoints("ref:aave-base-usdc-supply", [
    [shiftIsoDate(TODAY, -7), 2.6],
    [shiftIsoDate(TODAY, -1), 2.69],
    [TODAY, 2.71],
  ]);
  await s.putDoc(
    "rate_refs",
    {
      rows: [
        { id: "aave-base-usdc-supply", label: "AAVE SUPPLY", value_pct: 2.71, extra: null },
        // no ref: series seeded -- exercises the "no history yet" case
        { id: "aave-base-usdc-borrow", label: "AAVE BORROW", value_pct: 3.88, extra: null },
      ],
    },
    "refs",
  );

  return s;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Dash = { as_of: string; panels: Record<string, any> };

describe("buildDashboard", () => {
  it("builds every panel from a seeded store", async () => {
    const dash = (await buildDashboard(await seeded(), INDEXES, NOW)) as Dash;
    expect(dash.as_of).toBe("2026-07-08T14:30:00.000Z");

    const row = dash.panels["equity"].rows[0];
    expect(row.symbol).toBe("SPX");
    expect(row.name).toBe("S&P 500");
    expect(row.last).toBe(6234.5);
    expect(row.delayed).toBe(true);
    expect(row.source).toBe("yahoo");
    expect(row.chg_1d).toBe(0.56); // vs 6200.0 (Jul 7)
    expect(row.chg_1w).toBe(1.37); // vs 6150.0 (Jul 1, on-or-before rule)
    expect(row.chg_ytd).toBe(7.49); // vs 5800.0 (Dec 31 2025)
    expect(row.chg_1y).toBeNull(); // no history that far back
    expect(dash.panels["equity"].updated_at).toBeTruthy();

    const [us, jp] = dash.panels["bonds"].rows; // doc insertion order preserved
    expect(us.country).toBe("US");
    expect(us.y10_pct).toBe(4.12);
    expect(us.y3m_pct).toBe(3.89);
    expect(us.cb_pct).toBe(3.75);
    expect(us.cb_label).toBe("FED");
    expect(us.chg_1d_bp).toBe(-3); // 10Y: 4.12 vs 4.15
    expect(us.chg_1w_bp).toBe(-8); // 10Y: 4.12 vs 4.20 (Jul 1)
    expect(jp.country).toBe("JP");
    expect(jp.y10_pct).toBe(4.6);
    expect(jp.y3m_pct).toBeNull(); // unsourced cells stay null
    expect(jp.cb_pct).toBeNull();
    expect(jp.chg_1d_bp).toBeNull(); // no yield:JP10Y history seeded
    expect(dash.panels["bonds"].source).toBe("bundesbank+fred");

    const macro = dash.panels["macro"];
    expect(macro.releases.map((r: { name: string }) => r.name)).toEqual(["CPI y/y"]);
    expect(macro.releases[0].series_id).toBe("us-cpi-yoy");
    expect(macro.past.map((r: { name: string }) => r.name)).toEqual([
      "Non-Farm Payrolls",
      "Retail Sales m/m", // chronological, 7-day window
    ]);
    expect(macro.past[1].actual).toBe("0.4%");

    expect(dash.panels["news"].items[0].feed).toBe("FT");
    expect(dash.panels["defi"].rows[0].pool).toBe("Clearstar");
    expect(dash.panels["defi"].source).toBe("zyfai");
    expect(dash.panels["midnight"].rows[0].maturity).toBe("2026-08-28");
    expect(dash.panels["morpho"].rows[0].collateral).toBe("cbBTC");
    expect(dash.panels["morpho"].source).toBe("morpho-blue");

    const refs = dash.panels["refs"];
    expect(refs.source).toBe("refs");
    const [supply, borrow] = refs.rows;
    expect(supply.id).toBe("aave-base-usdc-supply");
    expect(supply.label).toBe("AAVE SUPPLY");
    expect(supply.value_pct).toBe(2.71);
    expect(supply.chg_1d_bp).toBe(2); // 2.71 vs 2.69 (yesterday)
    expect(supply.chg_1w_bp).toBe(11); // 2.71 vs 2.60 (a week ago)
    expect(borrow.id).toBe("aave-base-usdc-borrow");
    expect(borrow.chg_1d_bp).toBeNull(); // no history yet for this ref
    expect(borrow.chg_1w_bp).toBeNull();
  });

  it("degrades to empty panels on an empty store", async () => {
    const dash = (await buildDashboard(store(), INDEXES, NOW)) as Dash;
    expect(dash.panels["equity"].rows).toEqual([]);
    expect(dash.panels["bonds"].rows).toEqual([]);
    expect(dash.panels["macro"].releases).toEqual([]);
    expect(dash.panels["macro"].past).toEqual([]);
    expect(dash.panels["news"].items).toEqual([]);
    expect(dash.panels["defi"].rows).toEqual([]);
    expect(dash.panels["midnight"].rows).toEqual([]);
    expect(dash.panels["morpho"].rows).toEqual([]);
    expect(dash.panels["refs"]).toEqual({ rows: [], updated_at: null, source: null });
  });
});

describe("malformed docs degrade one row, never the dashboard", () => {
  it("skips an equity quote with an unparseable timestamp", async () => {
    const s = await seeded();
    await s.putDoc(
      "equity_quotes",
      { SPX: { last: 6234.5, ts: "not-a-timestamp", source: "yahoo", delayed: true } },
      "yahoo",
    );

    const dash = (await buildDashboard(s, INDEXES, NOW)) as Dash;
    expect(dash.panels["equity"].rows).toEqual([]); // bad row skipped
    expect(dash.panels["bonds"].rows.length).toBeGreaterThan(0); // other panels unaffected
  });

  it("drops an all-null bond row and a pre-matrix key", async () => {
    const s = await seeded();
    await s.putDoc(
      "bond_quotes",
      {
        // yield_pct missing on the only US entry -> all-null row -> dropped
        US10Y: { country: "US", tenor: "10Y", ts: "2026-07-08T00:00:00Z", source: "fred" },
        // pre-matrix key shape (no country) -> degraded, not a 500
        JP: { tenor: "10Y", yield_pct: 4.6, ts: "2026-07-08T00:00:00Z", source: "bundesbank" },
      },
      "fred",
    );

    const dash = (await buildDashboard(s, INDEXES, NOW)) as Dash;
    expect(dash.panels["bonds"].rows).toEqual([]);
    expect(dash.panels["equity"].rows.length).toBeGreaterThan(0);
  });

  it("skips a ref row missing value_pct", async () => {
    const s = await seeded();
    await s.putDoc(
      "rate_refs",
      {
        rows: [
          { id: "aave-base-usdc-supply", label: "AAVE SUPPLY" }, // value_pct missing
          { id: "aave-base-usdc-borrow", label: "AAVE BORROW", value_pct: 3.88, extra: null },
        ],
      },
      "refs",
    );

    const dash = (await buildDashboard(s, INDEXES, NOW)) as Dash;
    expect(dash.panels["refs"].rows.map((r: { id: string }) => r.id)).toEqual([
      "aave-base-usdc-borrow",
    ]);
    expect(dash.panels["equity"].rows.length).toBeGreaterThan(0);
  });
});

describe("cycle panel", () => {
  it("computes values and 1m/1y changes, degrading an empty series", async () => {
    const s = store();
    await s.upsertPoints("cycle:vix", [
      ["2025-08-20", 30.0],
      ["2026-07-20", 20.0],
      ["2026-08-20", 16.5],
    ]);

    const series: CycleSeriesCfg[] = [
      { id: "vix", name: "VIX", unit: "idx", fred: "VIXCLS" },
      { id: "empty", name: "Empty", unit: "idx", fred: "NONE" },
      { id: "usrec", name: "Rec", unit: "idx", fred: "USREC", hidden: true },
    ];
    const tabs: CycleTabCfg[] = [
      {
        id: "risk",
        label: "RISK",
        panels: [
          { title: "VOL", rows: [{ series: "vix", overlay: "usrec" }, { series: "empty" }] },
        ],
      },
    ];

    const dash = (await buildDashboard(s, INDEXES, NOW, series, tabs)) as Dash;
    const tab = dash.panels["cycle"].tabs[0];
    expect([tab.id, tab.label]).toEqual(["risk", "RISK"]);

    const row = tab.panels[0].rows[0];
    expect(row.id).toBe("vix");
    expect(row.name).toBe("VIX");
    expect(row.unit).toBe("idx");
    expect(row.value).toBe(16.5);
    expect(row.chg_1m).toBe(-3.5); // vs 2026-07-20
    expect(row.chg_1y).toBe(-13.5); // vs 2025-08-20
    expect(row.overlay).toBe("usrec");

    const emptyRow = tab.panels[0].rows[1];
    expect(emptyRow.value).toBeNull();
    expect(emptyRow.chg_1m).toBeNull();
  });

  it("applies the configured transform", async () => {
    const s = store();
    await s.upsertPoints("cycle:m2", [
      ["2025-08-01", 100.0],
      ["2026-08-01", 110.0],
    ]);

    const series: CycleSeriesCfg[] = [
      { id: "m2", name: "M2 YoY", unit: "%", transform: "yoy", fred: "M2SL" },
    ];
    const tabs: CycleTabCfg[] = [
      { id: "econ", label: "ECON", panels: [{ title: "MONEY", rows: [{ series: "m2" }] }] },
    ];

    const dash = (await buildDashboard(s, INDEXES, NOW, series, tabs)) as Dash;
    expect(dash.panels["cycle"].tabs[0].panels[0].rows[0].value).toBe(10.0);
  });

  it("drops a tab row referencing an unknown series", async () => {
    const tabs: CycleTabCfg[] = [
      { id: "risk", label: "RISK", panels: [{ title: "VOL", rows: [{ series: "ghost" }] }] },
    ];
    const dash = (await buildDashboard(store(), INDEXES, NOW, [], tabs)) as Dash;
    expect(dash.panels["cycle"].tabs[0].panels[0].rows).toEqual([]);
  });
});
