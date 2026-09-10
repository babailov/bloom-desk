/**
 * Pure change math. No I/O, no clock access -- everything injected.
 * Port of collector/src/collector/changes.py.
 *
 * Points are keyed by ISO date string, so ordering is lexicographic and
 * date arithmetic goes through shiftIsoDate. See the note in store.ts on why
 * these are strings rather than Date.
 */
import { round } from "./num";
import { shiftIsoDate } from "./store";

export type Points = Map<string, number>;

export function pctChange(last: number, ref: number | null): number | null {
  if (ref === null || ref === 0) return null;
  return round((last / ref - 1.0) * 100, 2);
}

export function bpMove(currentPct: number, refPct: number | null): number | null {
  if (refPct === null) return null;
  return round((currentPct - refPct) * 100);
}

/**
 * Reference close for a change horizon.
 *
 * Selection rule: latest close ON OR BEFORE the target date, so weekends and
 * holidays resolve to the prior trading day. '1d' is strictly before asof.
 */
export function refClose(closes: Points, asof: string, horizon: string): number | null {
  if (closes.size === 0) return null;
  const dates = [...closes.keys()].sort();

  const latestOnOrBefore = (target: string): number | null => {
    let found: string | undefined;
    for (const d of dates) {
      if (d <= target) found = d;
      else break;
    }
    return found === undefined ? null : closes.get(found)!;
  };

  switch (horizon) {
    case "1d": {
      let found: string | undefined;
      for (const d of dates) {
        if (d < asof) found = d;
        else break;
      }
      return found === undefined ? null : closes.get(found)!;
    }
    case "1w":
      return latestOnOrBefore(shiftIsoDate(asof, -7));
    case "1m":
      return latestOnOrBefore(shiftIsoDate(asof, -30));
    case "1y":
      return latestOnOrBefore(shiftIsoDate(asof, -365));
    case "ytd":
      return latestOnOrBefore(`${Number(asof.slice(0, 4)) - 1}-12-31`);
    default:
      throw new Error(`unknown horizon: ${horizon}`);
  }
}

/**
 * Contiguous runs of value==1 (NBER USREC) -> (start, end) band pairs.
 *
 * End = first 0-date after the run, or the last observation while still inside
 * one (an open recession shades up to the newest data point).
 */
export function toBands(points: Points): [string, string][] {
  const bands: [string, string][] = [];
  const ordered = [...points.keys()].sort();
  let start: string | null = null;

  for (const d of ordered) {
    if (points.get(d) === 1 && start === null) start = d;
    else if (points.get(d) !== 1 && start !== null) {
      bands.push([start, d]);
      start = null;
    }
  }
  if (start !== null) bands.push([start, ordered[ordered.length - 1]!]);
  return bands;
}

/** Shift an ISO date back one year, or null when that date does not exist. */
function oneYearEarlier(iso: string): string | null {
  const year = Number(iso.slice(0, 4)) - 1;
  const candidate = `${year}${iso.slice(4)}`;
  // Feb 29 in a non-leap year: Python raises ValueError, we return null.
  const parsed = new Date(`${candidate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === candidate ? candidate : null;
}

/**
 * Transforms for macro series charts.
 *
 * none: raw values. diff: change vs previous observation (NFP-style).
 * pct_prev: % change vs previous observation. yoy: % change vs the observation
 * 12 months earlier (same day-of-month, monthly series).
 */
export function applyTransform(points: Points, kind: string): Points {
  if (kind === "none") return new Map(points);

  const ordered = [...points.keys()].sort();
  const out: Points = new Map();

  if (kind === "diff" || kind === "pct_prev") {
    for (let i = 1; i < ordered.length; i++) {
      const prevD = ordered[i - 1]!;
      const curD = ordered[i]!;
      const prev = points.get(prevD)!;
      const cur = points.get(curD)!;
      if (kind === "diff") out.set(curD, round(cur - prev, 2));
      else if (prev !== 0) out.set(curD, round((cur / prev - 1.0) * 100, 2));
    }
    return out;
  }

  if (kind === "yoy") {
    for (const d of ordered) {
      const earlier = oneYearEarlier(d);
      const prev = earlier === null ? undefined : points.get(earlier);
      // Python's `if prev:` also skips a zero previous value, which would
      // divide by zero anyway.
      if (prev) out.set(d, round((points.get(d)! / prev - 1.0) * 100, 2));
    }
    return out;
  }

  throw new Error(`unknown transform: ${kind}`);
}
