/**
 * ECB Data Portal SDMX REST: daily euro-area yield-curve rates, keyless.
 * Port of collector/src/collector/fetchers/ecb.py.
 *
 * Config stores the full SDMX key including the dataflow prefix
 * ("YC.B.U2.EUR..."); the URL wants them split (/data/YC/B.U2.EUR...).
 * csvdata rows quote commas inside titles, so this parses with a real CSV
 * reader, not a naive split.
 */
import { parseRows } from "../csv";
import type { GetText } from "../http";
import type { Point } from "../store";

export const BASE = "https://data-api.ecb.europa.eu/service/data";

export function parseCsv(text: string): Point[] {
  const rows = parseRows(text);
  const header = rows[0];
  if (header === undefined) throw new Error("ecb CSV was empty");

  const tCol = header.indexOf("TIME_PERIOD");
  const vCol = header.indexOf("OBS_VALUE");
  if (tCol === -1 || vCol === -1) {
    throw new Error("ecb CSV missing TIME_PERIOD/OBS_VALUE columns");
  }

  const out: Point[] = [];
  for (const row of rows.slice(1)) {
    const d = row[tCol];
    const rawValue = row[vCol];
    // blank observations and stray short rows
    if (d === undefined || rawValue === undefined || rawValue === "") continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;

    const v = Number(rawValue);
    if (!Number.isFinite(v)) continue;
    out.push([d, v]);
  }

  if (out.length === 0) throw new Error("ecb CSV contained no usable rows");
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

export async function fetchSeries(series: string, getText: GetText): Promise<Point[]> {
  const dot = series.indexOf(".");
  const flow = series.slice(0, dot);
  const key = series.slice(dot + 1);
  return parseCsv(
    await getText(`${BASE}/${flow}/${key}`, {
      format: "csvdata",
      lastNObservations: "400",
    }),
  );
}
