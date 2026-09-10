/**
 * Minimal RFC 4180 CSV reader, standing in for Python's `csv` module.
 *
 * Naive splitting on commas is wrong for both CSV upstreams we read: ECB
 * csvdata quotes commas inside series titles, and OECD's labelled CSV does the
 * same. ecb.py says so explicitly, so the port needs real quote handling.
 *
 * Handles quoted fields, escaped quotes (""), and CRLF or LF line endings.
 */

/** Parse CSV text into rows of raw string fields. */
export function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false; // distinguishes a trailing newline from a final empty row

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // escaped quote
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      quoted = true;
      started = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      started = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (started || field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = "";
      started = false;
    } else {
      field += c;
      started = true;
    }
  }

  if (started || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parse CSV text into objects keyed by the header row, like csv.DictReader.
 * Rows shorter than the header get undefined for the missing columns.
 */
export function parseDicts(text: string): Record<string, string | undefined>[] {
  const rows = parseRows(text);
  const header = rows[0];
  if (header === undefined) return [];

  return rows.slice(1).map((row) => {
    const out: Record<string, string | undefined> = {};
    header.forEach((name, i) => {
      out[name] = row[i];
    });
    return out;
  });
}
