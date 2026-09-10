import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import YAHOO_SPX from "./fixtures/yahoo_spx.json?raw";
import FRED_JSON from "./fixtures/fred_dgs10.json?raw";
import BUBA_CSV from "./fixtures/bundesbank_10y.csv?raw";
import ECB_CSV from "./fixtures/ecb_3m.csv?raw";

import * as yahoo from "../src/fetchers/yahoo";
import { fetchEquity, type EquityQuote } from "../src/fetchers/equity";
import { fetchBonds, type BondQuote } from "../src/fetchers/bonds";
import type { BondCfg, CbRateCfg, IndexCfg } from "../src/config";
import { Store, type Point } from "../src/store";

// Ports test_yahoo / test_equity / test_bonds.

const store = () => new Store(env.DB);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM series_points"),
    env.DB.prepare("DELETE FROM docs"),
  ]);
});

const cfg = (symbol: string, y = "^GSPC"): IndexCfg => ({ symbol, name: symbol, yahoo: y });

async function equityQuotes(): Promise<Record<string, EquityQuote>> {
  return (await store().doc<Record<string, EquityQuote>>("equity_quotes"))!.payload;
}
async function bondQuotes(): Promise<Record<string, BondQuote>> {
  return (await store().doc<Record<string, BondQuote>>("bond_quotes"))!.payload;
}

describe("yahoo", () => {
  it("parses closes, skips nulls, sorts, and reads the fresher last", () => {
    const quote = yahoo.parseChart(YAHOO_SPX);
    expect(quote.closes).toHaveLength(2); // null close skipped
    expect(quote.closes.map(([d]) => d)).toEqual([...quote.closes.map(([d]) => d)].sort());
    expect(quote.closes.at(-1)).toEqual(["2026-07-13", 6234.5]);
    expect(quote.last).toBe(6240.1);
    expect(quote.lastTs?.endsWith("Z")).toBe(true);
  });

  it("raises on an empty result", () => {
    expect(() => yahoo.parseChart('{"chart":{"result":[{}]}}')).toThrow();
  });

  it("surfaces the upstream description for a delisted symbol", () => {
    const text =
      '{"chart": {"result": null, "error": {"code": "Not Found",' +
      ' "description": "No data found, symbol may be delisted"}}}';
    expect(() => yahoo.parseChart(text)).toThrow(/symbol may be delisted/);
  });

  it("sends the range param and no header override", async () => {
    let seen: { url?: string; params?: Record<string, string>; headers?: unknown } = {};
    const quote = await yahoo.fetchChart("^GSPC", async (url, params, headers) => {
      seen = { url, params, headers };
      return YAHOO_SPX;
    });
    expect(quote.last).toBe(6240.1);
    expect(seen.params?.["range"]).toBe("1y");
    // no per-fetcher header override: http.getText applies the honest default
    expect(seen.headers).toBeUndefined();
    expect(seen.url).toMatch(/%5EGSPC|\^GSPC/);
  });

  it("honours an explicit range", async () => {
    let params: Record<string, string> | undefined;
    await yahoo.fetchChart(
      "^GSPC",
      async (_u, p) => {
        params = p;
        return YAHOO_SPX;
      },
      "10y",
    );
    expect(params?.["range"]).toBe("10y");
  });

  it("aligns ratio series on common dates", () => {
    const a: Point[] = [["2026-08-20", 10], ["2026-08-21", 12], ["2026-08-24", 14]];
    const b: Point[] = [["2026-08-21", 4], ["2026-08-24", 7], ["2026-08-25", 8]];
    expect(yahoo.ratioPoints(a, b)).toEqual([["2026-08-21", 3], ["2026-08-24", 2]]);
  });

  it("drops empty intersections and zero denominators", () => {
    const a: Point[] = [["2026-08-20", 10]];
    expect(yahoo.ratioPoints(a, [["2026-08-21", 4]])).toEqual([]);
    expect(yahoo.ratioPoints(a, [["2026-08-20", 0]])).toEqual([]);
  });
});

describe("equity", () => {
  const fakeGet = async () => YAHOO_SPX;

  it("writes the quote and the daily closes", async () => {
    expect(await fetchEquity([cfg("SPX")], store(), fakeGet)).toBe("yahoo");
    const q = (await equityQuotes())["SPX"]!;
    expect(q.source).toBe("yahoo");
    expect(q.last).toBe(6240.1); // fresher-than-close quote
    expect((await store().points("idx:SPX")).size).toBeGreaterThan(0);
  });

  it("carries a failed symbol forward with its stale timestamp", async () => {
    await store().putDoc(
      "equity_quotes",
      { HSI: { last: 24000.0, ts: "2026-07-07T00:00:00Z", source: "yahoo", delayed: true } },
      "yahoo",
    );

    const getSpxOnly = async (url: string) => {
      if (url.includes("%5EGSPC")) return YAHOO_SPX;
      throw new Error("yahoo down");
    };

    expect(await fetchEquity([cfg("SPX"), cfg("HSI", "^HSI")], store(), getSpxOnly)).toBe("yahoo");
    const quotes = await equityQuotes();
    expect(quotes["HSI"]?.last).toBe(24000.0); // carried forward, not deleted
    expect(quotes["HSI"]?.ts).toBe("2026-07-07T00:00:00Z"); // old ts => visibly stale
    expect(quotes["SPX"]?.last).toBe(6240.1);
  });

  it("raises when every symbol fails, even with a previous doc", async () => {
    await store().putDoc(
      "equity_quotes",
      { SPX: { last: 6000.0, ts: "2026-07-01T00:00:00Z", source: "yahoo", delayed: true } },
      "yahoo",
    );
    await expect(
      fetchEquity([cfg("SPX")], store(), async () => {
        throw new Error("yahoo down");
      }),
    ).rejects.toThrow(/all equity symbols failed/);
  });

  it("drops a symbol removed from config", async () => {
    await store().putDoc(
      "equity_quotes",
      {
        SPX: { last: 6000.0, ts: "2026-07-01T00:00:00Z", source: "yahoo", delayed: true },
        RUT: { last: 2200.0, ts: "2026-07-01T00:00:00Z", source: "yahoo", delayed: true },
      },
      "yahoo",
    );
    await fetchEquity([cfg("SPX")], store(), fakeGet);

    const quotes = await equityQuotes();
    expect(quotes["RUT"]).toBeUndefined(); // removed from config -> dropped
    expect(quotes["SPX"]?.last).toBe(6240.1);
  });

  it("reports a symbol with no source but keeps going", async () => {
    const bare: IndexCfg = { symbol: "XXX", name: "No Source" };
    expect(await fetchEquity([cfg("SPX"), bare], store(), fakeGet)).toBe("yahoo");
    expect((await equityQuotes())["XXX"]).toBeUndefined();
  });

  it("makes exactly one call per symbol when yahoo succeeds", async () => {
    const calls: string[] = [];
    await fetchEquity([cfg("SPX")], store(), async (url) => {
      calls.push(url);
      return YAHOO_SPX;
    });
    expect(calls).toHaveLength(1);
  });
});

describe("bonds", () => {
  const fakeGet = async (url: string) => {
    if (url.includes("stlouisfed")) return FRED_JSON;
    if (url.includes("bundesbank")) return BUBA_CSV;
    if (url.includes("data-api.ecb")) return ECB_CSV;
    throw new Error(`unexpected url: ${url}`);
  };

  const makeCfg = (over: Partial<BondCfg> = {}): BondCfg => ({
    country: "DE",
    tenor: "10Y",
    bundesbank: "D.I.ZST.ZI.EUR.S1311.B.A604.R10XX.R.A.A._Z._Z.A",
    ...over,
  });

  const run = (bonds: BondCfg[], cbRates: CbRateCfg[] = [], get = fakeGet) =>
    fetchBonds(bonds, cbRates, store(), get, "k");

  it("reads a FRED bond", async () => {
    expect(await run([makeCfg({ country: "US", fred: "DGS10", bundesbank: undefined })])).toBe("fred");
    const q = (await bondQuotes())["US10Y"]!;
    expect(q.yield_pct).toBe(4.12);
    expect(q.source).toBe("fred");
    expect(q.country).toBe("US");
    expect(q.tenor).toBe("10Y");
    expect((await store().points("yield:US10Y")).get("2026-07-08")).toBe(4.12);
  });

  it("reads a Bundesbank bond", async () => {
    expect(await run([makeCfg()])).toBe("bundesbank");
    const q = (await bondQuotes())["DE10Y"]!;
    expect(q.yield_pct).toBe(3.17);
    expect(q.source).toBe("bundesbank");
    expect((await store().points("yield:DE10Y")).get("2026-07-08")).toBe(3.17);
  });

  it("reads an ECB curve point", async () => {
    const c = makeCfg({ tenor: "3M", bundesbank: undefined, ecb: "YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_3M" });
    expect(await run([c])).toBe("ecb");
    const q = (await bondQuotes())["DE3M"]!;
    expect(q.yield_pct).toBe(2.3337121399);
    expect(q.source).toBe("ecb");
    expect((await store().points("yield:DE3M")).get("2026-07-20")).toBe(2.3299925919);
  });

  it("writes CB rates alongside bonds", async () => {
    const cbs: CbRateCfg[] = [{ country: "US", label: "FED", fred: "DFEDTARU" }];
    expect(await run([makeCfg()], cbs)).toBe("bundesbank+fred");

    const fed = (await bondQuotes())["USCB"]!;
    expect(fed.label).toBe("FED");
    expect(fed.country).toBe("US");
    expect(fed.yield_pct).toBe(4.12); // fred_dgs10 fixture value
    expect(fed.tenor).toBeUndefined();
    expect((await store().points("cb:US")).get("2026-07-08")).toBe(4.12);
  });

  it("carries a failed instrument forward and drops removed and old-shape keys", async () => {
    await store().putDoc(
      "bond_quotes",
      {
        DE10Y: { country: "DE", tenor: "10Y", yield_pct: 2.5, ts: "2026-07-01T00:00:00Z", source: "bundesbank" },
        IT10Y: { country: "IT", tenor: "10Y", yield_pct: 3.9, ts: "2026-07-01T00:00:00Z", source: "yahoo" },
        // pre-matrix key: must be dropped
        DE: { country: "DE", tenor: "10Y", yield_pct: 4.6, ts: "2026-07-01T00:00:00Z", source: "bundesbank" },
      },
      "bundesbank",
    );

    const deFails = async (url: string) => {
      if (url.includes("stlouisfed")) return FRED_JSON;
      throw new Error("bundesbank down");
    };

    // config now has US (works via fred) and DE (fails); IT no longer configured
    const label = await run(
      [makeCfg({ country: "US", fred: "DGS10", bundesbank: undefined }), makeCfg()],
      [],
      deFails,
    );
    expect(label).toBe("fred");

    const quotes = await bondQuotes();
    expect(quotes["DE10Y"]?.yield_pct).toBe(2.5); // carried forward, visibly stale via old ts
    expect(quotes["US10Y"]?.yield_pct).toBe(4.12); // fresh
    expect(quotes["IT10Y"]).toBeUndefined(); // removed from config -> dropped
    expect(quotes["DE"]).toBeUndefined(); // old-shape key -> dropped
  });

  it("raises when every instrument fails", async () => {
    await expect(
      run([makeCfg()], [], async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow(/all bonds failed/);
  });
});
