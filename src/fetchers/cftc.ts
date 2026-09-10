/**
 * CFTC COT via the Socrata public reporting API (keyless).
 * Port of collector/src/collector/fetchers/cftc.py.
 *
 * Dataset 6dca-aqww = legacy futures-only report; net non-commercial
 * positioning = long - short, weekly. $limit=5000 covers ~30y of Tuesdays.
 */
import type { GetText } from "../http";
import type { Point } from "../store";

export const BASE = "https://publicreporting.cftc.gov/resource/6dca-aqww.json";

export function parseReports(text: string): Point[] {
  const rows = JSON.parse(text) as Record<string, unknown>[];
  const out: Point[] = [];

  for (const row of rows) {
    // Socrata dates arrive as full ISO timestamps; the date half is the key.
    const raw = row["report_date_as_yyyy_mm_dd"];
    if (typeof raw !== "string") continue;
    const d = raw.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;

    const long = Number(row["noncomm_positions_long_all"]);
    const short = Number(row["noncomm_positions_short_all"]);
    // a malformed row must not fail the series
    if (!Number.isFinite(long) || !Number.isFinite(short)) continue;

    out.push([d, long - short]);
  }

  if (out.length === 0) throw new Error("cftc payload contained no usable reports");
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

export async function fetchNetNoncommercial(code: string, getText: GetText): Promise<Point[]> {
  return parseReports(
    await getText(BASE, {
      cftc_contract_market_code: code,
      $select:
        "report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all",
      $order: "report_date_as_yyyy_mm_dd",
      $limit: "5000",
    }),
  );
}
