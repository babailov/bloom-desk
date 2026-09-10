/**
 * Government yields (10Y + 3M) and central bank policy rates.
 * Port of collector/src/collector/fetchers/bonds.py.
 *
 * Chain per bond: FRED (US) -> Bundesbank (DE 10Y) -> ECB (euro-area 3M curve).
 * CB rates use the same FRED fetcher.
 *
 * UK gilts are deliberately absent: the only keyless daily source is the BoE
 * IADB CSV export, whose path robots.txt disallows. Rather than ship a fetcher
 * that every user would be running against that directive, the UK row is out.
 *
 * Writes history to 'yield:{country}{tenor}' / 'cb:{country}' and latest to the
 * 'bond_quotes' doc keyed '{country}{tenor}' ('US10Y', 'US3M', 'USCB'):
 * {country, tenor|label, yield_pct, ts, source}. Instruments that fail this run
 * keep their last-known quote (stale beats gone) -- but only instruments still
 * in config, because the panels layer iterates the doc's keys.
 */
import type { BondCfg, CbRateCfg } from "../config";
import type { GetText } from "../http";
import type { Point, Store } from "../store";
import * as bundesbank from "./bundesbank";
import * as ecb from "./ecb";
import * as fred from "./fred";

export interface BondQuote {
  country: string;
  yield_pct: number;
  ts: string;
  source: string;
  tenor?: string;
  label?: string;
}

/** (closes, source) via the keyless-source chain, or null if unconfigured. */
async function dailySeries(
  cfg: BondCfg | CbRateCfg,
  getText: GetText,
  fredApiKey: string,
): Promise<{ closes: Point[]; source: string } | null> {
  if (cfg.fred) {
    return { closes: await fred.fetchSeries(cfg.fred, fredApiKey, getText), source: "fred" };
  }
  if ("bundesbank" in cfg && cfg.bundesbank) {
    return { closes: await bundesbank.fetchSeries(cfg.bundesbank, getText), source: "bundesbank" };
  }
  if ("ecb" in cfg && cfg.ecb) {
    return { closes: await ecb.fetchSeries(cfg.ecb, getText), source: "ecb" };
  }
  return null;
}

export async function fetchBonds(
  bonds: readonly BondCfg[],
  cbRates: readonly CbRateCfg[],
  store: Store,
  getText: GetText,
  fredApiKey: string,
): Promise<string> {
  const instruments: { key: string; seriesId: string; cfg: BondCfg | CbRateCfg; isBond: boolean }[] = [
    ...bonds.map((b) => ({
      key: `${b.country}${b.tenor}`,
      seriesId: `yield:${b.country}${b.tenor}`,
      cfg: b as BondCfg | CbRateCfg,
      isBond: true,
    })),
    ...cbRates.map((c) => ({
      key: `${c.country}CB`,
      seriesId: `cb:${c.country}`,
      cfg: c as BondCfg | CbRateCfg,
      isBond: false,
    })),
  ];

  const wanted = new Set(instruments.map((i) => i.key));
  const prev = await store.doc<Record<string, BondQuote>>("bond_quotes");
  const quotes: Record<string, BondQuote> = {};
  if (prev) {
    // Pre-matrix docs were keyed by bare country; those keys fall out of
    // `wanted` and are dropped.
    for (const [key, quote] of Object.entries(prev.payload)) {
      if (wanted.has(key)) quotes[key] = quote;
    }
  }

  const sourcesUsed = new Set<string>();
  const errors: string[] = [];
  let fetched = 0;

  for (const { key, seriesId, cfg, isBond } of instruments) {
    let result: { closes: Point[]; source: string } | null;
    try {
      result = await dailySeries(cfg, getText, fredApiKey);
    } catch (exc) {
      // one instrument must not kill the run
      console.warn(`bond fetch failed for ${key}: ${String(exc)}`);
      errors.push(`${key}: ${String(exc)}`);
      continue;
    }
    if (result === null) {
      errors.push(`${key}: no source configured`);
      continue;
    }

    const last = result.closes[result.closes.length - 1];
    if (last === undefined) {
      errors.push(`${key}: source returned no points`);
      continue;
    }

    await store.upsertRecentPoints(seriesId, result.closes);

    const quote: BondQuote = {
      country: cfg.country,
      yield_pct: last[1],
      ts: `${last[0]}T00:00:00Z`,
      source: result.source,
    };
    if (isBond) quote.tenor = (cfg as BondCfg).tenor;
    else quote.label = (cfg as CbRateCfg).label;

    quotes[key] = quote;
    sourcesUsed.add(result.source);
    fetched++;
  }

  if (fetched === 0) throw new Error(`all bonds failed: ${errors.join("; ")}`);

  const label = [...sourcesUsed].sort().join("+");
  await store.putDoc("bond_quotes", quotes, label);
  return label;
}
