/**
 * Assemble the /api/dashboard payload from store contents.
 * Port of collector/src/collector/panels.py.
 *
 * One structural change from the Python: this no longer runs per request.
 * `_equity_rows` and `_cycle_panel` call `store.points()` once per index and
 * once per cycle series, which against SQLite was a local scan and against D1
 * is thousands of rows read on every page load. buildDashboard now runs at the
 * end of each job and its result is stored as a single doc, so the API reads
 * one row. See rebuildDashboard.
 */
import { applyTransform, bpMove, pctChange, refClose, type Points } from "./changes";
import type { CycleSeriesCfg, CycleTabCfg, IndexCfg } from "./config";
import { round } from "./num";
import type { Doc, Store } from "./store";

const HORIZONS = ["1d", "1w", "ytd", "1y"] as const;

/** Cached dashboard doc key. The API reads this and nothing else. */
export const DASHBOARD_DOC = "dashboard";

/** Cached NBER recession bands, derived from the cycle:usrec series. */
export const RECESSIONS_DOC = "recessions";

/**
 * asof = quote ts; accepted: ~20min midnight-UTC window can shift the 1d ref,
 * self-corrects next tick.
 *
 * Throws on anything unparseable, the way Python's fromisoformat does. That
 * throw is load-bearing: it is what makes a malformed quote degrade its own row
 * instead of quietly producing a row keyed on garbage.
 */
function asOf(tsIso: unknown): string {
  if (typeof tsIso !== "string" || Number.isNaN(Date.parse(tsIso))) {
    throw new TypeError(`unparseable timestamp: ${String(tsIso)}`);
  }
  return tsIso.slice(0, 10);
}

/** Mirrors Python raising KeyError/TypeError on a missing or wrong-typed field. */
function requireNumber(x: unknown, what: string): number {
  if (typeof x !== "number" || !Number.isFinite(x)) {
    throw new TypeError(`missing or non-numeric ${what}`);
  }
  return x;
}

function requireString(x: unknown, what: string): string {
  if (typeof x !== "string" || x === "") throw new TypeError(`missing ${what}`);
  return x;
}

/** As stored; see the note on RefRow for why nothing here is guaranteed. */
interface EquityQuote {
  last?: unknown;
  ts?: unknown;
  source?: unknown;
  delayed?: unknown;
}

async function equityRows(store: Store, indexes: readonly IndexCfg[]): Promise<unknown[]> {
  const doc = await store.doc<Record<string, EquityQuote>>("equity_quotes");
  if (doc === null) return [];

  const rows: Record<string, unknown>[] = [];
  for (const idx of indexes) {
    // config order == display order
    const quote = doc.payload[idx.symbol];
    if (quote === undefined) continue;
    try {
      const closes = await store.points(`idx:${idx.symbol}`);
      const asof = asOf(quote.ts);
      const last = requireNumber(quote.last, "equity last");
      const row: Record<string, unknown> = {
        symbol: idx.symbol,
        name: idx.name,
        last,
        source: quote.source,
        delayed: quote.delayed,
        updated_at: doc.updated_at,
      };
      for (const horizon of HORIZONS) {
        row[`chg_${horizon}`] = pctChange(last, refClose(closes, asof, horizon));
      }
      rows.push(row);
    } catch (exc) {
      // one malformed row must degrade that row, never 500 the dashboard
      console.warn(`skipping malformed equity quote for ${idx.symbol}: ${String(exc)}`);
    }
  }
  return rows;
}

/** As stored; see the note on RefRow for why nothing here is guaranteed. */
interface BondQuote {
  country?: unknown;
  yield_pct?: unknown;
  ts?: unknown;
  source?: unknown;
  tenor?: unknown;
  label?: unknown;
}

/**
 * Matrix rows, one per country: CB rate + 3M + 10Y, changes on the 10Y.
 *
 * Country order = doc insertion order (= bonds config order). A malformed entry
 * degrades to a null cell; a country with no usable cell is dropped.
 */
async function bondRows(store: Store): Promise<unknown[]> {
  const doc = await store.doc<Record<string, BondQuote>>("bond_quotes");
  if (doc === null) return [];

  const rows = new Map<string, Record<string, unknown>>();
  for (const [key, quote] of Object.entries(doc.payload)) {
    try {
      const country = requireString(quote?.country, "bond country");
      let row = rows.get(country);
      if (row === undefined) {
        row = {
          country,
          cb_pct: null,
          cb_label: null,
          y3m_pct: null,
          y10_pct: null,
          chg_1d_bp: null,
          chg_1w_bp: null,
          updated_at: doc.updated_at,
        };
        rows.set(country, row);
      }

      if (key.endsWith("CB")) {
        row["cb_pct"] = requireNumber(quote.yield_pct, "cb yield_pct");
        row["cb_label"] = quote.label ?? null;
      } else if (quote.tenor === "3M") {
        row["y3m_pct"] = requireNumber(quote.yield_pct, "3M yield_pct");
      } else if (quote.tenor === "10Y") {
        const yieldPct = requireNumber(quote.yield_pct, "10Y yield_pct");
        const series = await store.points(`yield:${country}10Y`);
        const asof = asOf(quote.ts);
        row["y10_pct"] = yieldPct;
        row["chg_1d_bp"] = bpMove(yieldPct, refClose(series, asof, "1d"));
        row["chg_1w_bp"] = bpMove(yieldPct, refClose(series, asof, "1w"));
      }
    } catch (exc) {
      // one malformed entry must degrade its cell, never 500 the dashboard
      console.warn(`skipping malformed bond quote for ${key}: ${String(exc)}`);
    }
  }

  return [...rows.values()].filter((r) =>
    ["cb_pct", "y3m_pct", "y10_pct"].some((c) => r[c] !== null),
  );
}

/** As stored. Fields are optional because a doc written by an older build, or
 * a partially-written one, must degrade its row rather than 500 the dashboard. */
interface RefRow {
  id?: unknown;
  label?: unknown;
  value_pct?: unknown;
  extra?: unknown;
}

async function refsRows(store: Store, doc: Doc<{ rows?: RefRow[] }>): Promise<unknown[]> {
  const asof = asOf(doc.updated_at);
  const rows: unknown[] = [];

  for (const r of doc.payload.rows ?? []) {
    try {
      const id = requireString(r?.id, "ref id");
      const valuePct = requireNumber(r.value_pct, "ref value_pct");
      const series = await store.points(`ref:${id}`);
      rows.push({
        id,
        label: requireString(r.label, "ref label"),
        value_pct: valuePct,
        chg_1d_bp: bpMove(valuePct, refClose(series, asof, "1d")),
        chg_1w_bp: bpMove(valuePct, refClose(series, asof, "1w")),
        extra: r.extra ?? null,
      });
    } catch (exc) {
      // one malformed row must degrade that row, never 500 the dashboard
      console.warn(`skipping malformed ref row for ${String(r?.id)}: ${String(exc)}`);
    }
  }
  return rows;
}

async function refsPanel(store: Store): Promise<unknown> {
  const doc = await store.doc<{ rows?: RefRow[] }>("rate_refs");
  if (doc === null) return { rows: [], updated_at: null, source: null };
  return { rows: await refsRows(store, doc), updated_at: doc.updated_at, source: doc.source };
}

async function docPanel(store: Store, key: string, listKey: string): Promise<Record<string, unknown>> {
  const doc = await store.doc<Record<string, unknown>>(key);
  if (doc === null) return { [listKey]: [], updated_at: null, source: null };
  return { [listKey]: doc.payload[listKey], updated_at: doc.updated_at, source: doc.source };
}

interface Release {
  time: string;
}

/**
 * Timeline split: 'past' = last 7 days from macro_history (FF only serves the
 * current week, so history is our own accumulation); 'releases' = the
 * calendar's upcoming entries. Unparseable times ("TBD") stay upcoming.
 */
async function macroPanel(store: Store, now: Date): Promise<Record<string, unknown>> {
  const panel = await docPanel(store, "macro_calendar", "releases");

  const upcoming: Release[] = [];
  for (const r of (panel["releases"] as Release[] | undefined) ?? []) {
    const t = Date.parse(r?.time);
    if (!Number.isNaN(t) && t < now.getTime()) continue;
    upcoming.push(r);
  }
  panel["releases"] = upcoming;

  const hist = await store.doc<{ releases?: Release[] }>("macro_history");
  const cutoff = now.getTime() - 7 * 86_400_000;
  const past: [number, Release][] = [];
  for (const r of hist?.payload.releases ?? []) {
    const t = Date.parse(r?.time);
    if (Number.isNaN(t)) continue;
    if (t >= cutoff && t < now.getTime()) past.push([t, r]);
  }
  past.sort((a, b) => a[0] - b[0]);
  panel["past"] = past.map(([, r]) => r);

  return panel;
}

/**
 * Latest transformed value + 1M/1Y diffs; a series with no data yet degrades to
 * null cells, never drops the row (the tab layout is config).
 */
async function cycleRow(
  store: Store,
  cfg: CycleSeriesCfg,
  overlay: string | undefined,
): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = {
    id: cfg.id,
    name: cfg.name,
    unit: cfg.unit,
    value: null,
    chg_1m: null,
    chg_1y: null,
    overlay: overlay ?? null,
  };

  const points: Points = applyTransform(
    await store.points(`cycle:${cfg.id}`),
    cfg.transform ?? "none",
  );
  if (points.size === 0) return row;

  const asof = [...points.keys()].sort().at(-1)!;
  const value = points.get(asof)!;
  row["value"] = value;

  for (const horizon of ["1m", "1y"] as const) {
    const ref = refClose(points, asof, horizon);
    row[`chg_${horizon}`] = ref === null ? null : round(value - ref, 2);
  }
  return row;
}

async function cyclePanel(
  store: Store,
  cycleSeries: readonly CycleSeriesCfg[],
  cycleTabs: readonly CycleTabCfg[],
): Promise<Record<string, unknown>> {
  const byId = new Map(cycleSeries.map((s) => [s.id, s]));
  const tabs: unknown[] = [];

  for (const tab of cycleTabs) {
    const panels: unknown[] = [];
    for (const panel of tab.panels) {
      const rows: unknown[] = [];
      for (const r of panel.rows) {
        const cfg = byId.get(r.series);
        if (cfg === undefined) {
          // config drift must degrade the row, not 500
          console.warn(`cycle tab ${tab.id} references unknown series ${r.series}`);
          continue;
        }
        rows.push(await cycleRow(store, cfg, r.overlay));
      }
      panels.push({ title: panel.title, rows });
    }
    tabs.push({ id: tab.id, label: tab.label, panels });
  }

  const status = await store.status("cycle");
  return { tabs, updated_at: status?.last_success ?? null, source: "cycle" };
}

export async function buildDashboard(
  store: Store,
  indexes: readonly IndexCfg[],
  now: Date,
  cycleSeries: readonly CycleSeriesCfg[] = [],
  cycleTabs: readonly CycleTabCfg[] = [],
): Promise<Record<string, unknown>> {
  const equityDoc = await store.doc("equity_quotes");
  const bondsDoc = await store.doc("bond_quotes");

  return {
    as_of: now.toISOString(),
    panels: {
      macro: await macroPanel(store, now),
      equity: {
        rows: await equityRows(store, indexes),
        updated_at: equityDoc?.updated_at ?? null,
      },
      bonds: {
        rows: await bondRows(store),
        updated_at: bondsDoc?.updated_at ?? null,
        source: bondsDoc?.source ?? null,
      },
      news: await docPanel(store, "news", "items"),
      defi: await docPanel(store, "defi_pools", "rows"),
      midnight: await docPanel(store, "midnight_curve", "rows"),
      morpho: await docPanel(store, "morpho_markets", "rows"),
      refs: await refsPanel(store),
      cycle: await cyclePanel(store, cycleSeries, cycleTabs),
    },
  };
}
