/**
 * ForexFactory weekly calendar -> 'macro_calendar' doc + 'macro_history' doc.
 * Port of collector/src/collector/fetchers/macro.py.
 *
 * Filter: USD/EUR + High impact. The scheduler job runs hourly; shouldRefresh
 * implements the spec cadence (6h baseline, hourly on days with releases).
 *
 * FF only publishes the current week (lastweek/nextweek endpoints 404), so the
 * panel's past-7-days section is fed by 'macro_history': every real fetch
 * upserts its releases keyed (country, name, time), so re-fetches refresh
 * actuals and revisions. Retained 30 days.
 *
 * Transport note (issue #2): ForexFactory rate-limits per client IP and
 * Cloudflare's shared Workers egress address is permanently over that quota, so
 * fetching from inside the Worker returns 429 every time. The body normally
 * arrives by push instead -- see src/ingest.ts -- which is why the parse and
 * the fetch are separate functions. Everything below the transport is shared by
 * both paths, so the panel is built by the same code either way.
 */
import type { CalendarMapEntry } from "../config";
import type { GetText } from "../http";
import type { Store } from "../store";

const COUNTRIES = new Set(["USD", "EUR"]);
const BASE_SECONDS = 6 * 3600;
const RELEASE_DAY_SECONDS = 55 * 60;
const HISTORY_DAYS = 30;

export interface Release {
  name: string;
  country: string;
  time: string;
  impact: string;
  previous: string | null;
  consensus: string | null;
  actual: string | null;
  series_id: string | null;
}

function mapSeries(
  country: string,
  title: string,
  calMap: readonly CalendarMapEntry[],
): string | null {
  for (const entry of calMap) {
    if (entry.country === country && title.toLowerCase().includes(entry.match.toLowerCase())) {
      return entry.series;
    }
  }
  return null;
}

/** Upsert releases into history keyed (country, name, time); prune to 30d. */
/**
 * The key separator is a literal NUL, escaped rather than embedded: a release
 * name can contain anything ForexFactory prints, and a printable delimiter
 * could be part of one. Written as a raw byte this file stopped being text as
 * far as git is concerned, which cost it every diff.
 */
const KEY_SEP = "\u0000";

export function mergeHistory(
  existing: readonly Release[],
  releases: readonly Release[],
  now: Date,
): Release[] {
  const byKey = new Map<string, Release>();
  for (const r of existing) byKey.set(`${r.country}${KEY_SEP}${r.name}${KEY_SEP}${r.time}`, r);
  for (const r of releases) byKey.set(`${r.country}${KEY_SEP}${r.name}${KEY_SEP}${r.time}`, r);

  const cutoff = now.getTime() - HISTORY_DAYS * 86_400_000;
  const kept: [number, Release][] = [];
  for (const r of byKey.values()) {
    const t = Date.parse(r.time);
    // "TBD"-time events never enter history
    if (Number.isNaN(t) || t < cutoff) continue;
    kept.push([t, r]);
  }
  kept.sort((a, b) => a[0] - b[0]);
  return kept.map(([, r]) => r);
}

interface RawEvent {
  country?: string;
  impact?: string;
  title?: string;
  date?: string;
  previous?: string;
  forecast?: string;
  actual?: string;
}

/**
 * Parse a raw ForexFactory calendar body into the releases we keep.
 *
 * Throws on a body that is not JSON, which is the useful failure: a rate-limit
 * page or an outage notice is HTML, and silently reading it as zero releases
 * would blank the panel and call it a success.
 */
export function parseCalendar(body: string, calMap: readonly CalendarMapEntry[]): Release[] {
  const events = JSON.parse(body) as RawEvent[];
  const releases: Release[] = [];

  for (const ev of events) {
    // one malformed event must not blank the calendar
    if (typeof ev?.country !== "string" || typeof ev.title !== "string") continue;
    if (typeof ev.date !== "string") continue;
    if (!COUNTRIES.has(ev.country) || ev.impact !== "High") continue;

    releases.push({
      name: ev.title,
      country: ev.country,
      time: ev.date,
      impact: ev.impact,
      previous: ev.previous || null,
      consensus: ev.forecast || null,
      actual: ev.actual || null,
      series_id: mapSeries(ev.country, ev.title, calMap),
    });
  }

  return releases;
}

/**
 * Write both docs from an already-retrieved body. Returns the source label.
 *
 * This is the whole fetcher minus the transport, so the push path in
 * src/ingest.ts and the cron fallback below produce byte-identical docs.
 */
export async function ingestCalendar(
  body: string,
  calMap: readonly CalendarMapEntry[],
  store: Store,
  now: Date = new Date(),
): Promise<string> {
  const releases = parseCalendar(body, calMap);

  await store.putDoc("macro_calendar", { releases }, "forexfactory");

  const hist = await store.doc<{ releases?: Release[] }>("macro_history");
  const existing = hist?.payload.releases ?? [];
  await store.putDoc(
    "macro_history",
    { releases: mergeHistory(existing, releases, now) },
    "forexfactory",
  );
  return "forexfactory";
}

export async function fetchCalendar(
  url: string,
  calMap: readonly CalendarMapEntry[],
  store: Store,
  getText: GetText,
  now: Date = new Date(),
): Promise<string> {
  return ingestCalendar(await getText(url), calMap, store, now);
}

/**
 * Does any release fall on `day` (an ISO date)?
 *
 * FF stamps events with an offset ("2026-09-06T21:30:00-04:00"). Python's
 * `fromisoformat(...).date()` reads the date in that original offset, not in
 * UTC, so the leading 10 characters are the faithful comparison.
 */
export function hasReleaseOn(releases: readonly Release[], day: string): boolean {
  for (const r of releases) {
    if (Number.isNaN(Date.parse(r.time))) continue; // e.g. FF emits "TBD"
    if (r.time.slice(0, 10) === day) return true;
  }
  return false;
}

export function shouldRefresh(
  lastSuccessIso: string | null,
  releaseToday: boolean,
  now: Date,
): boolean {
  if (lastSuccessIso === null) return true;
  const age = (now.getTime() - Date.parse(lastSuccessIso)) / 1000;
  if (age > BASE_SECONDS) return true;
  return releaseToday && age > RELEASE_DAY_SECONDS;
}

/**
 * The hourly scheduler job. Returns the active source label either way.
 *
 * The refresh clock is the doc's own updated_at (it moves only on a real
 * fetch), NOT fetcher_status.last_success, which the runner re-stamps on every
 * tick including skips.
 */
export async function fetchCalendarIfDue(
  url: string,
  calMap: readonly CalendarMapEntry[],
  store: Store,
  getText: GetText,
  now: Date = new Date(),
): Promise<string> {
  const doc = await store.doc<{ releases?: Release[] }>("macro_calendar");
  const lastFetch = doc?.updated_at ?? null;
  const releases = doc?.payload.releases ?? [];
  const releaseToday = hasReleaseOn(releases, now.toISOString().slice(0, 10));

  // A fresh calendar doc is not proof there's nothing to do: a deployment that
  // predates (or lost) macro_history would strand the past section empty until
  // the 6h cadence expires. Missing history forces a fetch.
  const historyMissing = (await store.doc("macro_history")) === null;

  if (historyMissing || shouldRefresh(lastFetch, releaseToday, now)) {
    return fetchCalendar(url, calMap, store, getText, now);
  }
  return "forexfactory";
}
