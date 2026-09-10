/**
 * Deutsche Bundesbank SDMX REST: daily Bund yields (BBSIS dataset), keyless.
 * Port of collector/src/collector/fetchers/bundesbank.py.
 */
import type { GetText } from "../http";
import type { Point } from "../store";

export const BASE = "https://api.statistiken.bundesbank.de/rest/data/BBSIS/";

export function parseCsv(text: string): Point[] {
  const out: Point[] = [];

  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(";");
    if (parts.length < 2) continue;

    const d = parts[0]!.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue; // metadata header rows

    // German decimal comma.
    const v = Number(parts[1]!.trim().replace(",", "."));
    // Non-trading-day markers ("." and friends) parse to NaN and are skipped.
    if (!Number.isFinite(v) || parts[1]!.trim() === "") continue;

    out.push([d, v]);
  }

  if (out.length === 0) throw new Error("bundesbank CSV contained no usable rows");
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

export async function fetchSeries(series: string, getText: GetText): Promise<Point[]> {
  return parseCsv(
    await getText(`${BASE}${series}`, { format: "csv", lastNObservations: "400" }),
  );
}
