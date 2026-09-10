import { describe, expect, it } from "vitest";
import XLS_DATA_URI from "./fixtures/aaii_sentiment.xls?inline";
import { URL as AAII_URL, fetchSpread, parseSentiment } from "../src/fetchers/aaii";

// Ports collector/tests/test_aaii.py. workerd has no fs, so the binary fixture
// arrives as a base64 data URI via Vite and is decoded here.

function fixture(): ArrayBuffer {
  const base64 = XLS_DATA_URI.slice(XLS_DATA_URI.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

describe("parseSentiment", () => {
  it("scales fractions to percentage points and skips header and footer", () => {
    expect(parseSentiment(fixture())).toEqual([
      ["2026-08-13", 6.0], // (0.38 - 0.32) * 100
      ["2026-08-20", 11.0], // (0.41 - 0.30) * 100
    ]);
  });

  it("reads the calendar date, not a timezone-shifted one", () => {
    // SheetJS builds Dates in the ambient timezone and `UTC: true` does not
    // change that, so toISOString() would report 2026-08-12 east of UTC.
    // Workers runs UTC, which would hide this until it moved.
    const dates = parseSentiment(fixture()).map(([d]) => d);
    expect(dates).toEqual(["2026-08-13", "2026-08-20"]);
  });
});

describe("fetchSpread", () => {
  it("hits the AAII url with the honest User-Agent", async () => {
    let seenUrl: string | undefined;
    let seenHeaders: Record<string, string> | undefined;

    const points = await fetchSpread(async (url, _params, headers) => {
      seenUrl = url;
      seenHeaders = headers;
      return fixture();
    });

    expect(seenUrl).toBe(AAII_URL);
    // The WAF 403s a bare product token, so the UA must be sent explicitly.
    expect(seenHeaders?.["User-Agent"]).toMatch(/^bloom-desk\//);
    expect(points).toHaveLength(2);
  });
});

describe("malformed sheets", () => {
  it("raises when no row is usable", () => {
    // A workbook that parses but holds no date-keyed rows is a shape change
    // upstream, not an empty week. It must fail loudly.
    const empty = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]).buffer; // truncated OLE2 header
    expect(() => parseSentiment(empty)).toThrow();
  });
});
