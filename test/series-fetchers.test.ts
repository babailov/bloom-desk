import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import FRED_JSON from "./fixtures/fred_dgs10.json?raw";
import DBNOMICS_JSON from "./fixtures/dbnomics_ism.json?raw";
import OECD_CSV from "./fixtures/oecd_cli.csv?raw";
import CFTC_JSON from "./fixtures/cftc_vix.json?raw";
import CBOE_JSON from "./fixtures/cboe_daily.json?raw";
import BUBA_CSV from "./fixtures/bundesbank_10y.csv?raw";
import ECB_CSV from "./fixtures/ecb_3m.csv?raw";

import * as fred from "../src/fetchers/fred";
import * as dbnomics from "../src/fetchers/dbnomics";
import * as oecd from "../src/fetchers/oecd";
import * as cftc from "../src/fetchers/cftc";
import * as cboe from "../src/fetchers/cboe";
import * as bundesbank from "../src/fetchers/bundesbank";
import * as ecb from "../src/fetchers/ecb";
import { Store } from "../src/store";

// Ports test_fred / test_dbnomics / test_oecd / test_cftc / test_cboe /
// test_bundesbank / test_ecb, against the same recorded fixtures.

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM series_points").run();
});

describe("fred", () => {
  it("skips FRED's missing-value marker", () => {
    expect(fred.parseObservations(FRED_JSON)).toEqual([
      ["2026-07-06", 4.15],
      ["2026-07-08", 4.12],
    ]);
  });

  it("passes the key, id and file type", async () => {
    let seen: Record<string, string> | undefined;
    const points = await fred.fetchSeries("DGS10", "test-key", async (_u, params) => {
      seen = params;
      return FRED_JSON;
    });
    expect(seen).toEqual({ series_id: "DGS10", api_key: "test-key", file_type: "json" });
    expect(points).toHaveLength(2);
  });

  it("writes every configured series", async () => {
    const store = new Store(env.DB);
    const label = await fred.fetchMacroHistory(
      [
        { id: "us-10y", fred: "DGS10" },
        { id: "us-cpi", fred: "CPIAUCSL" },
      ],
      store,
      "test-key",
      async () => FRED_JSON,
    );
    expect(label).toBe("fred");
    expect((await store.points("macro:us-10y")).size).toBeGreaterThan(0);
    expect((await store.points("macro:us-cpi")).size).toBeGreaterThan(0);
  });

  it("isolates a bad series and still writes the good one", async () => {
    const store = new Store(env.DB);
    const getText = async (_u: string, params?: Record<string, string>) => {
      if (params?.["series_id"] === "NOPE") throw new Error("HTTP 400 for https://api.stlouisfed.org");
      return FRED_JSON;
    };

    await expect(
      fred.fetchMacroHistory(
        [
          { id: "bad", fred: "NOPE" },
          { id: "good", fred: "DGS10" },
        ],
        store,
        "k",
        getText,
      ),
    ).rejects.toThrow(/bad:.*|1\/2/);

    expect((await store.points("macro:good")).size).toBeGreaterThan(0);
  });
});

describe("dbnomics", () => {
  it("maps monthly periods to the first of month and skips nulls", () => {
    expect(dbnomics.parseSeries(DBNOMICS_JSON)).toEqual([
      ["2026-05-01", 49.5],
      ["2026-07-01", 48.7], // null June skipped
    ]);
  });

  it("keeps daily periods as they are", () => {
    const text = '{"series": {"docs": [{"period": ["2026-07-15"], "value": [1.5]}]}}';
    expect(dbnomics.parseSeries(text)).toEqual([["2026-07-15", 1.5]]);
  });

  it("raises when there are no docs", () => {
    expect(() => dbnomics.parseSeries('{"series": {"docs": []}}')).toThrow();
  });

  it("builds the series url", async () => {
    let url: string | undefined;
    let params: Record<string, string> | undefined;
    const points = await dbnomics.fetchSeries("ISM/pmi/pm", async (u, p) => {
      url = u;
      params = p;
      return DBNOMICS_JSON;
    });
    expect(url).toBe("https://api.db.nomics.world/v22/series/ISM/pmi/pm");
    expect(params).toEqual({ observations: "1" });
    expect(points).toHaveLength(2);
  });
});

describe("oecd", () => {
  it("maps monthly periods and skips blanks", () => {
    expect(oecd.parseCsv(OECD_CSV)).toEqual([["2024-07-01", 99.39526]]);
  });

  it("returns nothing for a header-only response", () => {
    const header = OECD_CSV.split("\n")[0]!;
    expect(oecd.parseCsv(`${header}\n`)).toEqual([]);
  });

  it("raises when a fetched series has no usable points", async () => {
    const header = OECD_CSV.split("\n")[0]!;
    await expect(oecd.fetchSeries("REF", async () => `${header}\n`)).rejects.toThrow(
      /no usable points/,
    );
  });

  it("builds the url and params", async () => {
    const ref = "OECD.SDD.STES,DSD_STES@DF_CLI,4.1/USA.M.LI...AA...H";
    let url: string | undefined;
    let params: Record<string, string> | undefined;
    const points = await oecd.fetchSeries(ref, async (u, p) => {
      url = u;
      params = p;
      return OECD_CSV;
    });
    expect(url).toBe(`https://sdmx.oecd.org/public/rest/data/${ref}`);
    expect(params).toEqual({ startPeriod: "1990-01", format: "csvfilewithlabels" });
    expect(points).toEqual([["2024-07-01", 99.39526]]);
  });
});

describe("cftc", () => {
  it("computes net non-commercial and skips a malformed row", () => {
    expect(cftc.parseReports(CFTC_JSON)).toEqual([
      ["2026-08-11", -50766.0], // 61234 - 112000
      ["2026-08-18", 10000.0],
    ]);
  });

  it("filters by contract code", async () => {
    let url: string | undefined;
    let params: Record<string, string> | undefined;
    const points = await cftc.fetchNetNoncommercial("1170E1", async (u, p) => {
      url = u;
      params = p;
      return CFTC_JSON;
    });
    expect(url).toBe("https://publicreporting.cftc.gov/resource/6dca-aqww.json");
    expect(params?.["cftc_contract_market_code"]).toBe("1170E1");
    expect(params?.["$order"]).toBe("report_date_as_yyyy_mm_dd");
    expect(params?.["$limit"]).toBe("5000");
    expect(points).toHaveLength(2);
  });
});

describe("cboe", () => {
  it("extracts a named ratio", () => {
    expect(cboe.parseDaily(CBOE_JSON, "TOTAL PUT/CALL RATIO")).toBe(0.72);
    expect(cboe.parseDaily(CBOE_JSON, "EQUITY PUT/CALL RATIO")).toBe(0.51);
  });

  it("raises for an unknown ratio name", () => {
    expect(() => cboe.parseDaily(CBOE_JSON, "NO SUCH RATIO")).toThrow();
  });

  it("walks weekdays and skips a holiday", async () => {
    const seen: string[] = [];
    const getText = async (url: string) => {
      seen.push(url);
      if (url.includes("2026-08-21")) throw new Error("HTTP 403"); // pretend Friday was a holiday
      return CBOE_JSON;
    };

    // Mon 2026-08-24 back 7 days: weekdays 8/18..8/24 = 5 URLs
    const points = await cboe.fetchRatioHistory("TOTAL PUT/CALL RATIO", getText, 7, "2026-08-24");

    expect(seen).toHaveLength(5);
    expect(seen.every((u) => u.includes("_daily_options"))).toBe(true);
    expect(points).toContainEqual(["2026-08-24", 0.72]);
    expect(points.every(([d]) => d !== "2026-08-21")).toBe(true); // holiday skipped
    for (const [d] of points) {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      expect(dow).toBeGreaterThan(0);
      expect(dow).toBeLessThan(6);
    }
  });

  it("raises when every day in the walk fails", async () => {
    await expect(
      cboe.fetchRatioHistory("TOTAL PUT/CALL RATIO", async () => {
        throw new Error("HTTP 403");
      }, 7, "2026-08-24"),
    ).rejects.toThrow(/no usable days/);
  });
});

describe("bundesbank", () => {
  it("parses German decimal commas", () => {
    expect(bundesbank.parseCsv(BUBA_CSV)).toEqual([
      ["2026-07-06", 3.07],
      ["2026-07-07", 3.16],
      ["2026-07-08", 3.17],
    ]);
  });

  it("discards the BOM'd metadata header and non-trading-day rows", () => {
    // Real responses are BOM-prefixed. The BOM'd first metadata line must be
    // discarded like any other non-date row, not break parsing.
    expect(BUBA_CSV.startsWith("﻿")).toBe(true);
    const points = bundesbank.parseCsv(BUBA_CSV);
    expect(points).toHaveLength(3);
    expect(points.every(([d]) => d !== "2026-07-05")).toBe(true);
  });

  it("sorts out-of-order rows", () => {
    const shuffled = "2026-07-08;3,17;\n2026-07-06;3,07;\n2026-07-07;3,16;\n";
    expect(bundesbank.parseCsv(shuffled).map(([d]) => d)).toEqual([
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
    ]);
  });

  it("raises when there are no data rows", () => {
    expect(() => bundesbank.parseCsv("BBSIS;foo\nTitle;bar\n")).toThrow();
  });

  it("builds the url and params", async () => {
    const series = "D.I.ZST.ZI.EUR.S1311.B.A604.R10XX.R.A.A._Z._Z.A";
    let url: string | undefined;
    let params: Record<string, string> | undefined;
    const points = await bundesbank.fetchSeries(series, async (u, p) => {
      url = u;
      params = p;
      return BUBA_CSV;
    });
    expect(url).toBe(`https://api.statistiken.bundesbank.de/rest/data/BBSIS/${series}`);
    expect(params).toEqual({ format: "csv", lastNObservations: "400" });
    expect(points).toHaveLength(3);
  });
});

describe("ecb", () => {
  it("parses csvdata whose titles contain quoted commas", () => {
    // A naive comma-split would misalign columns. The fixture is a real
    // response, so this covers it.
    const points = ecb.parseCsv(ECB_CSV);
    expect(points[0]).toEqual(["2026-07-20", 2.3299925919]);
    expect(points.at(-1)).toEqual(["2026-07-22", 2.3337121399]);
    expect(points.map(([d]) => d)).toEqual([...points.map(([d]) => d)].sort());
  });

  it("rejects empty, headerless and data-less responses", () => {
    expect(() => ecb.parseCsv("")).toThrow();
    expect(() => ecb.parseCsv("KEY,FREQ\nYC.B,1\n")).toThrow();
    const header = ECB_CSV.split("\n")[0]!;
    expect(() => ecb.parseCsv(`${header}\n`)).toThrow();
  });

  it("splits the dataflow from the key", async () => {
    let url: string | undefined;
    let params: Record<string, string> | undefined;
    const points = await ecb.fetchSeries("YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_3M", async (u, p) => {
      url = u;
      params = p;
      return ECB_CSV;
    });
    expect(url?.endsWith("/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_3M")).toBe(true);
    expect(params?.["format"]).toBe("csvdata");
    expect(points).toHaveLength(3);
  });
});
