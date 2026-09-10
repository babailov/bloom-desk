/**
 * DBnomics series API -- keyless aggregator (ISM PMIs and future cycle series).
 * Port of collector/src/collector/fetchers/dbnomics.py.
 *
 * A series ref is "PROVIDER/dataset/series", passed straight into the v22 URL.
 */
import type { GetText } from "../http";
import type { Point } from "../store";

export const BASE = "https://api.db.nomics.world/v22/series";

/** "YYYY-MM" means the first of that month; "YYYY-MM-DD" is itself. */
function parsePeriod(period: string): string | null {
  const parts = period.split("-");
  const [y, m, d] = parts;
  if (y === undefined || !/^\d{4}$/.test(y)) return null;
  if (parts.length === 2 && m !== undefined) return `${y}-${m.padStart(2, "0")}-01`;
  if (parts.length === 3 && m !== undefined && d !== undefined) {
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

export function parseSeries(text: string): Point[] {
  const body = JSON.parse(text) as {
    series?: { docs?: { period?: string[]; value?: (number | null)[] }[] };
  };
  const doc = body.series?.docs?.[0];
  if (doc === undefined) throw new Error("dbnomics payload has no series docs");

  const periods = doc.period ?? [];
  const values = doc.value ?? [];
  const out: Point[] = [];
  for (let i = 0; i < Math.min(periods.length, values.length); i++) {
    const value = values[i];
    if (value === null || value === undefined) continue;
    const iso = parsePeriod(periods[i]!);
    if (iso === null) continue;
    out.push([iso, Number(value)]);
  }

  if (out.length === 0) throw new Error("dbnomics series contained no usable points");
  return out;
}

export async function fetchSeries(seriesRef: string, getText: GetText): Promise<Point[]> {
  return parseSeries(await getText(`${BASE}/${seriesRef}`, { observations: "1" }));
}
