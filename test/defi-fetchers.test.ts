import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import ZYFAI_JSON from "./fixtures/zyfai_safe_base.json?raw";
import MIDNIGHT_JSON from "./fixtures/midnight_books.json?raw";

import { fetchDefi, parseOpportunities, type DefiRow } from "../src/fetchers/zyfai";
import { fetchMidnight, impliedApy, parseBooks, type MidnightRow } from "../src/fetchers/midnight";
import { Store } from "../src/store";
import type { DefiCfg } from "../src/config";

// Ports collector/tests/test_zyfai.py and test_midnight.py.

const store = () => new Store(env.DB);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM series_points"),
    env.DB.prepare("DELETE FROM docs"),
  ]);
});

describe("zyfai parsing", () => {
  it("keeps everything object-shaped; row validation is fetch-time", () => {
    const opps = parseOpportunities(ZYFAI_JSON);
    expect(opps).toHaveLength(3);
    expect(opps[0]?.["pool_name"]).toBe("Clearstar cbAssets Vault");
    expect(opps[0]?.["combined_apy"]).toBeCloseTo(7.977915857647811, 10);
  });

  it("raises without a data list", () => {
    expect(() => parseOpportunities('{"status": "error"}')).toThrow();
    expect(() => parseOpportunities('{"status": "success", "data": "nope"}')).toThrow();
    expect(() => parseOpportunities("[]")).toThrow();
    expect(() => parseOpportunities("null")).toThrow();
  });

  it("drops non-object elements", () => {
    expect(parseOpportunities('{"data": [{"pool_name": "A"}, "junk", null]}')).toEqual([
      { pool_name: "A" },
    ]);
  });
});

describe("zyfai fetch", () => {
  const DEFI: DefiCfg = {
    asset: "USDC",
    strategies: [
      { id: "safe", label: "Conservative" },
      { id: "degen", label: "Moderate" },
      { id: "async", label: "Dynamic" },
    ],
    chains: [{ id: 8453, name: "Base", usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }],
    midnight_chains: [8453],
    token_symbols: {},
    morpho_graphql: "https://blue-api.morpho.org/graphql",
    morpho_first: 25,
  };
  const BASE_URL = "https://defiapi.zyf.ai/api/v2/opportunities";

  const payload = (...opps: Record<string, unknown>[]) =>
    JSON.stringify({ status: "success", data: opps });

  const opp = (address: string, apy: number, name = "Pool") => ({
    protocol_name: "Proto",
    pool_name: name,
    combined_apy: apy,
    chain_id: 8453,
    pool_address: address,
    tvlUsd: 1000.0,
    url: "https://example.com",
    averageCombinedApy7Days: null,
    averageCombinedApy30Days: null,
  });

  const A = "0x000000000000000000000000000000000000000a";
  const B = "0x000000000000000000000000000000000000000b";

  async function rows(): Promise<DefiRow[]> {
    return (await store().doc<{ rows: DefiRow[] }>("defi_pools"))!.payload.rows;
  }

  it("builds urls and params for every strategy", async () => {
    const seen: [string, Record<string, string> | undefined][] = [];
    const fakeGet = async (url: string, params?: Record<string, string>) => {
      seen.push([url, params]);
      return payload();
    };

    // all endpoints succeeded but returned zero pools: valid empty doc, no raise
    expect(await fetchDefi(DEFI, BASE_URL, store(), fakeGet)).toBe("zyfai");
    expect(seen[0]).toEqual([
      `${BASE_URL}/safe`,
      { asset: "USDC", chainId: "8453", status: "live" },
    ]);
    expect(seen.map(([u]) => u)).toEqual([
      `${BASE_URL}/safe`,
      `${BASE_URL}/degen`,
      `${BASE_URL}/async`,
    ]);
    expect(await rows()).toEqual([]);
  });

  it("dedupes to the most conservative tier and sorts tier-first", async () => {
    const fakeGet = async (url: string) =>
      url.includes("/safe")
        ? payload(opp(A, 5.0, "A"))
        : payload(opp(A, 5.0, "A"), opp(B, 9.0, "B")); // degen & async re-list A

    await fetchDefi(DEFI, BASE_URL, store(), fakeGet);

    // B's higher APY does not move it above the more conservative tier section
    expect((await rows()).map((r) => [r.pool, r.tier])).toEqual([
      ["A", "Conservative"],
      ["B", "Moderate"],
    ]);
  });

  it("records a daily APY point under a lowercased series key", async () => {
    const mixedCase = "0x000000000000000000000000000000000000000A";
    const fakeGet = async (url: string) =>
      url.includes("/safe") ? payload(opp(mixedCase, 5.0)) : payload();

    await fetchDefi(DEFI, BASE_URL, store(), fakeGet);
    const points = await store().points(`defi:8453:${mixedCase.toLowerCase()}`);
    expect([...points.values()]).toEqual([5.0]);
  });

  it("degrades on partial failure", async () => {
    const fakeGet = async (url: string) => {
      if (url.includes("/safe")) throw new Error("HTTP 500");
      return payload(opp(B, 9.0, "B"));
    };

    expect(await fetchDefi(DEFI, BASE_URL, store(), fakeGet)).toBe("zyfai");
    // B comes back from degen AND async; dedupe keeps the first (Moderate) only
    expect((await rows()).map((r) => [r.pool, r.tier])).toEqual([["B", "Moderate"]]);
  });

  it("raises on total failure and leaves the previous doc alone", async () => {
    await store().putDoc("defi_pools", { rows: [{ pool: "Old" }] }, "zyfai");

    await expect(
      fetchDefi(DEFI, BASE_URL, store(), async () => {
        throw new Error("HTTP 500");
      }),
    ).rejects.toThrow(/all zyfai endpoints failed/);

    expect((await rows())[0]?.pool).toBe("Old");
  });

  it("skips malformed rows and keeps null averages as null", async () => {
    // the fixture holds 2 good rows + 1 missing combined_apy
    const fakeGet = async (url: string) => (url.includes("/safe") ? ZYFAI_JSON : payload());
    await fetchDefi(DEFI, BASE_URL, store(), fakeGet);

    const out = await rows();
    expect(out).toHaveLength(2);
    const clearstar = out[0]!;
    expect(clearstar.pool).toBe("Clearstar cbAssets Vault");
    expect(clearstar.apy).toBeCloseTo(7.977915857647811, 10);
    expect(clearstar.apy_7d).toBeCloseTo(6.542457503857143, 10);
    expect(clearstar.tvl_usd).toBeCloseTo(10732971.31491206, 5);
    expect(clearstar.tier).toBe("Conservative");
    expect(clearstar.chain).toBe("Base");
    expect(out[1]?.apy_7d).toBeNull();
  });

  it("sorts APY descending within a tier", async () => {
    const fakeGet = async (url: string) =>
      url.includes("/safe") ? payload(opp(A, 3.0, "Low"), opp(B, 8.0, "High")) : payload();

    await fetchDefi(DEFI, BASE_URL, store(), fakeGet);
    expect((await rows()).map((r) => r.pool)).toEqual(["High", "Low"]);
  });

  it("keeps the previous doc when every endpoint is healthy but empty", async () => {
    await store().putDoc("defi_pools", { rows: [{ pool: "Old", tier: "Conservative" }] }, "zyfai");

    expect(await fetchDefi(DEFI, BASE_URL, store(), async () => payload())).toBe("zyfai");
    expect((await rows())[0]?.pool).toBe("Old");
  });
});

describe("midnight", () => {
  // All expected numbers below assume this frozen "now" (epoch 1784678400).
  const NOW = new Date("2026-07-22T00:00:00Z");
  const NOW_S = NOW.getTime() / 1000;

  const DEFI: DefiCfg = {
    asset: "USDC",
    strategies: [{ id: "safe", label: "Conservative" }],
    chains: [{ id: 8453, name: "Base", usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }],
    midnight_chains: [8453],
    token_symbols: { "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "cbBTC" },
    morpho_graphql: "https://blue-api.morpho.org/graphql",
    morpho_first: 25,
  };
  const BASE_URL = "https://api.morpho.org/v0/midnight";

  async function curveRows(): Promise<MidnightRow[]> {
    return (await store().doc<{ rows: MidnightRow[] }>("midnight_curve"))!.payload.rows;
  }

  it("parses books and the cursor", () => {
    const [cursor, books] = parseBooks(MIDNIGHT_JSON);
    expect(cursor).toBeNull();
    expect(books).toHaveLength(3);
    expect(books[1]?.["maturity"]).toBe(1787929200);
  });

  it("raises without a data list", () => {
    expect(() => parseBooks('{"cursor": null}')).toThrow();
  });

  it("annualizes a clean price", () => {
    // price 0.99 WAD, exactly 73 days out -> (1/0.99)^(365/73) - 1 = (100/99)^5 - 1
    const maturity = NOW_S + 73 * 86400;
    expect(impliedApy("990000000000000000", maturity, NOW)).toBeCloseTo(5.153571281335045, 10);
  });

  it("reproduces a real capture", () => {
    // best ask of the Aug-28 book: p=0.9958739, 37.625 days -> 4.0925%
    expect(impliedApy("995873900000000000", 1787929200, NOW)).toBeCloseTo(4.0925361830999485, 10);
  });

  it("returns null for matured, garbage and near-maturity inputs", () => {
    const maturity = NOW_S + 73 * 86400;
    expect(impliedApy("990000000000000000", NOW_S - 86400, NOW)).toBeNull();
    expect(impliedApy("0", maturity, NOW)).toBeNull();
    expect(impliedApy("2000000000000000000", maturity, NOW)).toBeNull(); // p=2.0 > sanity band
    // Sub-hour horizons overflow to Infinity in JS rather than raising.
    expect(impliedApy("500000000000000000", NOW_S + 60, NOW)).toBeNull();
  });

  it("builds the curve from the fixture", async () => {
    const seen: { url: string; params?: Record<string, string> }[] = [];
    const fakeGet = async (url: string, params?: Record<string, string>) => {
      seen.push({ url, params });
      return MIDNIGHT_JSON;
    };

    expect(await fetchMidnight(DEFI, BASE_URL, store(), fakeGet, NOW)).toBe("morpho");
    expect(seen[0]?.url).toBe(`${BASE_URL}/books`);
    expect(seen[0]?.params).toEqual({ chain_ids: "8453", limit: "20" });

    const rows = await curveRows();
    expect(rows).toHaveLength(2); // WETH book filtered out
    const [aug, sep] = rows as [MidnightRow, MidnightRow]; // sorted by maturity ascending
    expect(aug.maturity).toBe("2026-08-28");
    expect(sep.maturity).toBe("2026-09-25");
    expect(aug.days).toBeCloseTo(37.625, 6);
    // best ask selected by min price even though the fixture lists worst-first
    expect(aug.lend_apy).toBeCloseTo(4.0925361830999485, 10);
    expect(aug.borrow_apy).toBeCloseTo(4.53047561440989, 10);
    expect(aug.ask_depth_usd).toBeCloseTo(100699.339381, 6); // 6-dec USDC sum
    expect(aug.bid_depth_usd).toBeCloseTo(318.754794, 6);
    expect(aug.collateral).toBe("cbBTC");
    expect(aug.chain).toBe("Base");
    // one-sided book: no asks -> lend unavailable, borrow still quoted
    expect(sep.lend_apy).toBeNull();
    expect(sep.borrow_apy).not.toBeNull();
    expect(sep.ask_depth_usd).toBe(0);
    expect(sep.bid_depth_usd).toBeCloseTo(250.0, 6);
  });

  it("follows the cursor", async () => {
    const data = (JSON.parse(MIDNIGHT_JSON) as { data: unknown[] }).data;
    const page1 = JSON.stringify({ cursor: "abc", data: [data[1]] });
    const page2 = JSON.stringify({ cursor: null, data: [data[0]] });

    const calls: (Record<string, string> | undefined)[] = [];
    const fakeGet = async (_url: string, params?: Record<string, string>) => {
      calls.push(params);
      return params?.["cursor"] ? page2 : page1;
    };

    await fetchMidnight(DEFI, BASE_URL, store(), fakeGet, NOW);
    expect(calls[1]?.["cursor"]).toBe("abc");
    expect(await curveRows()).toHaveLength(2);
  });

  it("skips a matured book", async () => {
    const data = (JSON.parse(MIDNIGHT_JSON) as { data: Record<string, unknown>[] }).data;
    const matured = { ...data[1], maturity: NOW_S - 86400 };

    await fetchMidnight(DEFI, BASE_URL, store(), async () =>
      JSON.stringify({ cursor: null, data: [matured] }), NOW);
    expect(await curveRows()).toEqual([]);
  });

  it("truncates an unknown collateral address", async () => {
    const data = (JSON.parse(MIDNIGHT_JSON) as { data: Record<string, unknown>[] }).data;
    const book = {
      ...data[1],
      collaterals: [{ token: "0xdeadbeef00000000000000000000000000000000" }],
    };

    await fetchMidnight(DEFI, BASE_URL, store(), async () =>
      JSON.stringify({ cursor: null, data: [book] }), NOW);
    expect((await curveRows())[0]?.collateral).toBe("0xdead…");
  });

  it("raises when every chain fails", async () => {
    await expect(
      fetchMidnight(DEFI, BASE_URL, store(), async () => {
        throw new Error("HTTP 502");
      }, NOW),
    ).rejects.toThrow(/all midnight chains failed/);
  });

  it("overwrites the previous doc when there are no live books", async () => {
    // Deliberate divergence from zyfai: zero live USDC books is a VALID state
    // (post-maturity gap) and must replace old rows, not preserve them.
    await store().putDoc("midnight_curve", { rows: [{ maturity: "2026-01-01" }] }, "morpho");

    await fetchMidnight(DEFI, BASE_URL, store(), async () =>
      JSON.stringify({ cursor: null, data: [] }), NOW);
    expect(await curveRows()).toEqual([]);
  });
});
