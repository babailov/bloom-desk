/**
 * CBOE daily market statistics -- put/call ratios (keyless CDN JSON).
 * Port of collector/src/collector/fetchers/cboe.py.
 *
 * The endpoint is per-day, so history accumulates: each run walks the last
 * `days` weekdays and upserts what it finds. Holidays and not-yet-published
 * days answer 403 on the CDN and are skipped silently -- only a fully-empty
 * walk raises. Verified 2026-09-10: the CDN returns S3 AccessDenied, not 404,
 * for a day it has no file for.
 */
import type { GetText } from "../http";
import { shiftIsoDate, type Point } from "../store";

export const BASE = "https://cdn.cboe.com/data/us/options/market_statistics/daily";
export const DEFAULT_DAYS = 30;

export function parseDaily(text: string, ratioName: string): number {
  const body = JSON.parse(text) as { ratios?: { name?: string; value?: unknown }[] };
  for (const ratio of body.ratios ?? []) {
    if (ratio.name === ratioName) {
      const value = Number(ratio.value);
      if (!Number.isFinite(value)) break;
      return value;
    }
  }
  throw new Error(`cboe daily stats missing ratio ${JSON.stringify(ratioName)}`);
}

/** Day of week for an ISO date, 0=Sunday, in UTC. */
function utcDay(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

export async function fetchRatioHistory(
  ratioName: string,
  getText: GetText,
  days: number = DEFAULT_DAYS,
  today?: string,
): Promise<Point[]> {
  const start = today ?? new Date().toISOString().slice(0, 10);
  const out: Point[] = [];

  for (let back = 0; back < days; back++) {
    const d = shiftIsoDate(start, -back);
    const dow = utcDay(d);
    if (dow === 0 || dow === 6) continue; // no stats published on weekends
    try {
      out.push([d, parseDaily(await getText(`${BASE}/${d}_daily_options`), ratioName)]);
    } catch {
      continue; // holiday or not-yet-published day
    }
  }

  if (out.length === 0) {
    throw new Error(`cboe returned no usable days for ${JSON.stringify(ratioName)}`);
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}
