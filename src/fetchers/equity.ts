/**
 * Equity indexes, from Yahoo's keyless chart API.
 * Port of collector/src/collector/fetchers/equity.py.
 *
 * (Stooq was a fallback until it put its CSV endpoint behind a JavaScript
 * proof-of-work wall; it returned HTTP 200 with an HTML challenge body rather
 * than an error, so it failed at parse time and never served a quote. Removed
 * 2026-09-06 along with an optional IBKR path that returned data flagged just
 * as delayed as Yahoo's, for no gain.)
 *
 * Writes daily closes to series 'idx:{symbol}' and the latest quotes to the
 * 'equity_quotes' doc: {symbol: {last, ts, source, delayed}}.
 */
import type { IndexCfg } from "../config";
import type { GetText } from "../http";
import type { Store } from "../store";
import * as yahoo from "./yahoo";

export interface EquityQuote {
  last: number;
  ts: string;
  source: string;
  delayed: boolean;
}

export async function fetchEquity(
  indexes: readonly IndexCfg[],
  store: Store,
  getText: GetText,
): Promise<string> {
  const sourcesUsed = new Set<string>();

  // Stale beats gone: seed with the previous doc so a symbol that fails every
  // source this run keeps its last-known quote (its old ts marks it stale).
  // Symbols removed from config are dropped, not carried forward forever.
  const wanted = new Set(indexes.map((i) => i.symbol));
  const prev = await store.doc<Record<string, EquityQuote>>("equity_quotes");
  const quotes: Record<string, EquityQuote> = {};
  if (prev) {
    for (const [symbol, quote] of Object.entries(prev.payload)) {
      if (wanted.has(symbol)) quotes[symbol] = quote;
    }
  }

  let fetched = 0;
  const errors: string[] = [];

  for (const idx of indexes) {
    if (!idx.yahoo) {
      errors.push(`${idx.symbol}: no source configured`);
      continue;
    }
    try {
      const chart = await yahoo.fetchChart(idx.yahoo, getText);
      await store.upsertRecentPoints(`idx:${idx.symbol}`, chart.closes);

      const [lastD, lastV] = chart.closes[chart.closes.length - 1]!;
      quotes[idx.symbol] = {
        last: chart.last ?? lastV,
        ts: chart.lastTs ?? `${lastD}T00:00:00Z`,
        source: "yahoo",
        delayed: true,
      };
      sourcesUsed.add("yahoo");
      fetched++;
    } catch (exc) {
      // one dead symbol must not kill the run
      errors.push(`${idx.symbol}: ${String(exc)}`);
    }
  }

  if (fetched === 0) throw new Error(`all equity symbols failed: ${errors.join("; ")}`);

  const label = [...sourcesUsed].sort().join("+");
  await store.putDoc("equity_quotes", quotes, label);
  return label;
}
