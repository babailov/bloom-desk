/**
 * Yahoo Finance chart API: keyless daily closes + a fresher last quote.
 * Port of collector/src/collector/fetchers/yahoo.py.
 *
 * The keyless equity source. Uses http.USER_AGENT like every other fetcher --
 * verified 2026-09-10 from Cloudflare egress that Yahoo serves this endpoint to
 * an honest UA, across all ten configured symbols.
 */
import type { GetText } from "../http";
import type { Point } from "../store";

/** Simple carrier: closes + a possibly-fresher last. */
export interface Quote {
  closes: Point[];
  last: number | null;
  lastTs: string | null;
}

interface ChartResult {
  timestamp?: number[];
  indicators?: { quote?: { close?: (number | null)[] }[] };
  meta?: { regularMarketPrice?: number; regularMarketTime?: number };
}

export function parseChart(text: string): Quote {
  const chart = (JSON.parse(text) as { chart?: { result?: ChartResult[]; error?: { description?: string } } })
    .chart;
  const result = chart?.result?.[0];
  if (result === undefined) {
    // unknown/delisted symbol: {"chart": {"result": null, "error": {...}}}
    throw new Error(`yahoo chart error: ${chart?.error?.description ?? "no result"}`);
  }

  const timestamps = result.timestamp ?? [];
  const closesRaw = result.indicators?.quote?.[0]?.close ?? [];

  const closes: Point[] = [];
  for (let i = 0; i < Math.min(timestamps.length, closesRaw.length); i++) {
    const c = closesRaw[i];
    if (c === null || c === undefined) continue;
    closes.push([new Date(timestamps[i]! * 1000).toISOString().slice(0, 10), Number(c)]);
  }
  if (closes.length === 0) throw new Error("yahoo chart contained no usable points");

  // callers rely on closes[-1] being latest
  closes.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const meta = result.meta ?? {};
  const marketTime = meta.regularMarketTime;
  return {
    closes,
    last: meta.regularMarketPrice ?? null,
    lastTs: marketTime ? new Date(marketTime * 1000).toISOString() : null,
  };
}

export async function fetchChart(
  symbol: string,
  getText: GetText,
  range = "1y",
): Promise<Quote> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  return parseChart(await getText(url, { range, interval: "1d" }));
}

/** Numerator/denominator closes aligned on common dates (cycle ratio series). */
export function ratioPoints(closesA: readonly Point[], closesB: readonly Point[]): Point[] {
  const bByDate = new Map(closesB);
  const out: Point[] = [];
  for (const [d, a] of closesA) {
    const b = bByDate.get(d);
    if (b) out.push([d, Math.round((a / b) * 10000) / 10000]); // skip missing dates and zero denominators
  }
  return out;
}
