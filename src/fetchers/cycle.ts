/**
 * Daily market-cycle job: one series list, seven source kinds, per-series
 * isolation (a bad id or a dead file URL degrades that series only, and the
 * summary error raises at the end so /healthz surfaces it).
 *
 * Port of collector/src/collector/fetchers/cycle.py.
 */
import type { CycleSeriesCfg } from "../config";
import type { GetBytes, GetText } from "../http";
import type { Point, Store } from "../store";
import * as aaii from "./aaii";
import * as cboe from "./cboe";
import * as cftc from "./cftc";
import * as dbnomics from "./dbnomics";
import * as fred from "./fred";
import * as oecd from "./oecd";
import * as yahoo from "./yahoo";

/**
 * Fetch, range-filter and store one cycle series. Returns the number of points
 * written.
 *
 * Exported as its own unit so the daily Workflow can make each series a
 * `step.do()`: a failure at series 30 then resumes at 30 instead of refetching
 * the 29 that already succeeded.
 */
export async function fetchCycleSeries(
  cfg: CycleSeriesCfg,
  store: Store,
  fredApiKey: string,
  getText: GetText,
  getBytes: GetBytes,
  today?: string,
): Promise<number> {
  let points = await fetchOne(cfg, fredApiKey, getText, getBytes, today);

  if (cfg.valid_range) {
    const [lo, hi] = cfg.valid_range;
    points = points.filter(([, v]) => v >= lo && v <= hi);
    // Upsert alone never removes points a feed served while it was corrupt.
    await store.pruneOutsideRange(`cycle:${cfg.id}`, lo, hi);
  }

  return store.upsertRecentPoints(`cycle:${cfg.id}`, points);
}

async function fetchOne(
  cfg: CycleSeriesCfg,
  fredApiKey: string,
  getText: GetText,
  getBytes: GetBytes,
  today?: string,
): Promise<Point[]> {
  if (cfg.fred) return fred.fetchSeries(cfg.fred, fredApiKey, getText);
  if (cfg.dbnomics) return dbnomics.fetchSeries(cfg.dbnomics, getText);
  if (cfg.oecd) return oecd.fetchSeries(cfg.oecd, getText);
  if (cfg.cftc) return cftc.fetchNetNoncommercial(cfg.cftc, getText);
  if (cfg.cboe) return cboe.fetchRatioHistory(cfg.cboe, getText, cboe.DEFAULT_DAYS, today);
  if (cfg.aaii) return aaii.fetchSpread(getBytes);
  if (cfg.yahoo_ratio) {
    const [num, den] = cfg.yahoo_ratio;
    const a = await yahoo.fetchChart(num, getText, "10y");
    const b = await yahoo.fetchChart(den, getText, "10y");
    return yahoo.ratioPoints(a.closes, b.closes);
  }
  throw new Error("no source configured");
}

export async function fetchCycle(
  series: readonly CycleSeriesCfg[],
  store: Store,
  fredApiKey: string,
  getText: GetText,
  getBytes: GetBytes,
  today?: string,
): Promise<string> {
  const errors: string[] = [];

  for (const cfg of series) {
    try {
      await fetchCycleSeries(cfg, store, fredApiKey, getText, getBytes, today);
    } catch (exc) {
      errors.push(`${cfg.id}: ${String(exc)}`); // per-series isolation
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `${errors.length}/${series.length} cycle series failed: ${errors.join("; ")}`,
    );
  }
  return "cycle";
}
