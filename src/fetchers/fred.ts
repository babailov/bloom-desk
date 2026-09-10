/**
 * FRED observations API. Used for macro series history and the US 10Y yield.
 * Port of collector/src/collector/fetchers/fred.py.
 */
import type { GetText } from "../http";
import type { Point, Store } from "../store";

export const BASE = "https://api.stlouisfed.org/fred/series/observations";

interface Observation {
  date: string;
  value: string;
}

export function parseObservations(text: string): Point[] {
  const body = JSON.parse(text) as { observations?: Observation[] };
  const out: Point[] = [];
  for (const obs of body.observations ?? []) {
    if (obs.value === ".") continue; // FRED's marker for missing data
    const value = Number(obs.value);
    if (!Number.isFinite(value)) continue;
    out.push([obs.date, value]);
  }
  return out;
}

export async function fetchSeries(
  fredId: string,
  apiKey: string,
  getText: GetText,
): Promise<Point[]> {
  return parseObservations(
    await getText(BASE, { series_id: fredId, api_key: apiKey, file_type: "json" }),
  );
}

export interface SeriesCfg {
  id: string;
  fred: string;
}

/**
 * Daily job: raw history for every configured macro series.
 *
 * Raw values are stored; transforms are applied at read time by the API, so a
 * transform change never requires a refetch. Each series is fetched
 * independently -- one bad FRED id must not starve the others.
 */
export async function fetchMacroHistory(
  series: readonly SeriesCfg[],
  store: Store,
  apiKey: string,
  getText: GetText,
): Promise<string> {
  const errors: string[] = [];
  for (const cfg of series) {
    try {
      await store.upsertRecentPoints(`macro:${cfg.id}`, await fetchSeries(cfg.fred, apiKey, getText));
    } catch (exc) {
      errors.push(`${cfg.id}: ${String(exc)}`); // per-series isolation
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `${errors.length}/${series.length} macro series failed: ${errors.join("; ")}`,
    );
  }
  return "fred";
}
