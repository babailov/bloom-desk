/**
 * Read-only JSON API. Port of collector/src/collector/api.py.
 *
 * Two departures from the Python:
 *
 *   - /api/dashboard and /api/recessions serve precomputed docs written by the
 *     job path. The Python rebuilt both per request, scanning every index and
 *     every cycle series; against D1 that is thousands of rows read on each
 *     page load, for data that only changes on a fetcher cadence.
 *   - The permissive CORS middleware is gone. It existed so a separately hosted
 *     UI could call the API; here they are same-origin, and behind Cloudflare
 *     Access an open policy is a hole.
 */
import { Hono } from "hono";

import { applyTransform, toBands } from "./changes";
import { config } from "./config.data";
import { aaveBorrowId, aaveBorrowLabel, aaveSupplyId, aaveSupplyLabel } from "./config";
import { DASHBOARD_DOC, RECESSIONS_DOC, buildDashboard } from "./panels";
import { Store, shiftIsoDate } from "./store";

const RANGE_DAYS: Record<string, number> = { "1y": 365, "5y": 5 * 365, "10y": 10 * 365 };

/**
 * Extra history read before a range cutoff so a transform has its reference
 * point. 400 days covers yoy (needs 12 months back) and covers diff/pct_prev
 * even for an annual series.
 */
const TRANSFORM_LOOKBACK_DAYS = 400;

/** Where a series id lives in the store, plus how to present it. */
interface SeriesLookup {
  key: string;
  name: string;
  unit: string;
  transform?: string;
}

/**
 * Resolve a series id the same way api.py does, in the same order: macro
 * series, then cycle series, then rate refs, then indexes, bonds and CB rates.
 * Built once at module load, since config is static.
 */
function buildSeriesIndex(): Map<string, SeriesLookup> {
  const index = new Map<string, SeriesLookup>();

  for (const s of config.series) {
    index.set(s.id, { key: `macro:${s.id}`, name: s.name, unit: s.unit, transform: s.transform });
  }
  for (const s of config.cycle_series) {
    if (index.has(s.id)) continue; // macro series win, as the if/elif chain does
    index.set(s.id, {
      key: `cycle:${s.id}`,
      name: s.name,
      unit: s.unit,
      transform: s.transform ?? "none",
    });
  }

  // rate refs: already daily percent, no transform
  for (const a of config.refs.aave) {
    index.set(aaveSupplyId(a), { key: `ref:${aaveSupplyId(a)}`, name: aaveSupplyLabel(a), unit: "%" });
    index.set(aaveBorrowId(a), { key: `ref:${aaveBorrowId(a)}`, name: aaveBorrowLabel(a), unit: "%" });
  }
  for (const p of config.refs.pendle) {
    index.set(p.implied_id, { key: `ref:${p.implied_id}`, name: p.implied_label, unit: "%" });
    index.set(p.underlying_id, { key: `ref:${p.underlying_id}`, name: p.underlying_label, unit: "%" });
  }
  for (const f of config.refs.funding) {
    index.set(f.id, { key: `ref:${f.id}`, name: f.label, unit: "%" });
  }

  for (const i of config.indexes) {
    index.set(i.symbol, { key: `idx:${i.symbol}`, name: i.name, unit: "px" });
  }
  for (const b of config.bonds) {
    const id = `${b.country}${b.tenor}`;
    index.set(id, { key: `yield:${id}`, name: `${b.country} ${b.tenor} yield`, unit: "%" });
  }
  for (const c of config.cb_rates) {
    // USCB -> cb:US
    index.set(`${c.country}CB`, { key: `cb:${c.country}`, name: c.label, unit: "%" });
  }

  return index;
}

const SERIES_INDEX = buildSeriesIndex();

function isHealthy(f: { last_error_at: string | null; last_success: string | null }): boolean {
  if (!f.last_error_at) return true;
  if (!f.last_success) return false;
  return f.last_success >= f.last_error_at;
}

export function createApi() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/api/dashboard", async (c) => {
    const store = new Store(c.env.DB);
    const doc = await store.doc(DASHBOARD_DOC);
    if (doc !== null) return c.json(doc.payload);

    // Cold start only: no job has run yet, so there is nothing cached. Build it
    // live so the UI gets its panel skeleton rather than an empty object, the
    // way the Python did on every request. Not written back -- writes belong to
    // the job path, and the next cron tick is at most five minutes away.
    return c.json(
      await buildDashboard(store, config.indexes, new Date(), config.cycle_series, config.cycle_tabs),
    );
  });

  app.get("/api/series/:id", async (c) => {
    const id = c.req.param("id");
    const lookup = SERIES_INDEX.get(id);
    if (lookup === undefined) {
      return c.json({ detail: `unknown series: ${id}` }, 404);
    }

    const range = c.req.query("range") ?? "10y";
    if (range !== "max" && RANGE_DAYS[range] === undefined) {
      return c.json({ detail: `unknown range: ${range}` }, 422);
    }

    const store = new Store(c.env.DB);
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = range === "max" ? null : shiftIsoDate(today, -RANGE_DAYS[range]!);

    // The transform has to see observations from before the cutoff: yoy needs
    // the point 12 months earlier, diff and pct_prev need the one before. So
    // read with a lookback, transform, then trim to the requested range -- the
    // same result api.py gets by transforming the whole series first, without
    // reading the whole series.
    const needsHistory = lookup.transform !== undefined && lookup.transform !== "none";
    const readFrom =
      cutoff === null ? undefined : needsHistory ? shiftIsoDate(cutoff, -TRANSFORM_LOOKBACK_DAYS) : cutoff;

    const raw = await store.points(lookup.key, readFrom);
    const transformed = lookup.transform ? applyTransform(raw, lookup.transform) : raw;

    const points = [...transformed.entries()]
      .filter(([d]) => cutoff === null || d >= cutoff)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return c.json({
      id,
      name: lookup.name,
      unit: lookup.unit,
      points,
    });
  });

  app.get("/api/recessions", async (c) => {
    const doc = await new Store(c.env.DB).doc<{ bands: [string, string][] }>(RECESSIONS_DOC);
    return c.json({ bands: doc?.payload.bands ?? [] });
  });

  app.get("/healthz", async (c) => {
    const fetchers = await new Store(c.env.DB).statuses();
    return c.json({ ok: fetchers.every(isHealthy), fetchers });
  });

  return app;
}

/** Exported for the job path: recessions are derived, not fetched. */
export { toBands };
