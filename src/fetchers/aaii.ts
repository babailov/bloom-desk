/**
 * AAII investor sentiment survey -- weekly bull-bear spread.
 * Port of collector/src/collector/fetchers/aaii.py.
 *
 * The survey ships as a legacy .xls with a header row, weekly data rows
 * (date, bullish, neutral, bearish as fractions) and footer summary rows.
 * Any row whose first cell isn't an Excel date is skipped; values <= 1.5 are
 * treated as fractions and scaled to percentage points.
 *
 * SheetJS replaces xlrd. `cellDates: true` reproduces xlrd's XL_CELL_DATE
 * check exactly: date-formatted cells arrive as Date, the header string and the
 * "Average" footer stay strings.
 *
 * The trap, verified against this fixture: SheetJS builds those Dates in the
 * ambient timezone, and `UTC: true` does not change that in 0.20.3. East of
 * UTC, `toISOString().slice(0, 10)` reports the previous day. The calendar date
 * lives in the *local* components, so that is what isoFromExcelDate reads.
 * Workers runs UTC, which would have hidden this until it moved.
 */
import * as XLSX from "xlsx";

import { USER_AGENT, type GetBytes } from "../http";
import { round2 } from "../num";
import type { Point } from "../store";

export const URL = "https://www.aaii.com/files/surveys/sentiment.xls";

/**
 * aaii.com's WAF 403s a bare product token (e.g. "bloom-desk/0.1") but serves
 * the file to the standard `product/version (comment)` form. Honest, not
 * disguised.
 */
const HEADERS = { "User-Agent": USER_AGENT };

/** Fractions at or below this are scaled to percentage points. */
const FRACTION_CEILING = 1.5;

/** ISO date from a SheetJS Date, read in local time. See the module note. */
function isoFromExcelDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseSentiment(content: ArrayBuffer): Point[] {
  const wb = XLSX.read(new Uint8Array(content), { type: "array", cellDates: true });
  const first = wb.SheetNames[0];
  if (first === undefined) throw new Error("aaii sentiment workbook has no sheets");

  const sheet = wb.Sheets[first];
  if (sheet === undefined) throw new Error("aaii sentiment workbook has no sheets");

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    blankrows: true,
  });

  const out: Point[] = [];
  for (const row of rows) {
    // header, footer, or blank spacer row
    if (row.length < 4 || !(row[0] instanceof Date)) continue;

    let bull = row[1];
    let bear = row[3];
    if (typeof bull !== "number" || typeof bear !== "number") continue;
    if (!Number.isFinite(bull) || !Number.isFinite(bear)) continue;

    if (Math.abs(bull) <= FRACTION_CEILING && Math.abs(bear) <= FRACTION_CEILING) {
      bull *= 100; // fractions -> percentage points
      bear *= 100;
    }
    out.push([isoFromExcelDate(row[0]), round2(bull - bear)]);
  }

  if (out.length === 0) throw new Error("aaii sentiment sheet contained no usable rows");
  return out;
}

export async function fetchSpread(getBytes: GetBytes): Promise<Point[]> {
  return parseSentiment(await getBytes(URL, undefined, HEADERS));
}
