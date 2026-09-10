/**
 * OECD SDMX data API (keyless) -- CLI / confidence indicators for cycle series.
 * Port of collector/src/collector/fetchers/oecd.py.
 *
 * A series ref is "{flow}/{key}" appended to the rest/data base. The
 * csvfilewithlabels format carries values in TIME_PERIOD / OBS_VALUE columns.
 */
import { parseDicts } from "../csv";
import type { GetText } from "../http";
import type { Point } from "../store";

export const BASE = "https://sdmx.oecd.org/public/rest/data";

export function parseCsv(text: string): Point[] {
  const out: Point[] = [];
  for (const row of parseDicts(text)) {
    const period = row["TIME_PERIOD"];
    const value = row["OBS_VALUE"];
    if (!period || !value) continue;

    const parts = period.split("-");
    const y = parts[0];
    if (y === undefined || !/^\d{4}$/.test(y)) continue;
    const month = parts.length > 1 && parts[1] !== undefined ? parts[1].padStart(2, "0") : "01";
    if (!/^\d{2}$/.test(month)) continue;

    const numeric = Number(value);
    if (!Number.isFinite(numeric)) continue;

    // OECD periods are monthly at finest, so the day is always the first.
    out.push([`${y}-${month}-01`, numeric]);
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

export async function fetchSeries(oecdRef: string, getText: GetText): Promise<Point[]> {
  const text = await getText(`${BASE}/${oecdRef}`, {
    startPeriod: "1990-01",
    format: "csvfilewithlabels",
  });
  const points = parseCsv(text);
  if (points.length === 0) {
    throw new Error(`oecd series ${oecdRef} contained no usable points`);
  }
  return points;
}
