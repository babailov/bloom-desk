import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import MORPHO_JSON from "./fixtures/morpho_markets.json?raw";
import AAVE_RPC_JSON from "./fixtures/aave_reserve_data.json?raw";
import PENDLE_MARKET from "./fixtures/pendle_market.json?raw";
import BINANCE_PREMIUM from "./fixtures/binance_premium_index.json?raw";

import {
  buildQuery,
  buildRow,
  fetchMorpho,
  parseMarkets,
  type MorphoRow,
} from "../src/fetchers/morpho";
import {
  expiryShort,
  fetchRefs,
  parseAaveReserveData,
  parseFundingPremium,
  parsePendleMarket,
  type RefRow,
} from "../src/fetchers/refs";
import { aaveBorrowId, aaveBorrowLabel, aaveSupplyId, aaveSupplyLabel } from "../src/config";
import type { AaveRefCfg, DefiCfg, RefsCfg } from "../src/config";
import { Store } from "../src/store";

// Ports collector/tests/test_morpho.py and test_refs.py.

const store = () => new Store(env.DB);
const MORPHO_FIXTURE = JSON.parse(MORPHO_JSON) as Record<string, unknown>;
const AAVE_RPC = JSON.parse(AAVE_RPC_JSON) as Record<string, unknown>;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM series_points"),
    env.DB.prepare("DELETE FROM docs"),
  ]);
});

describe("morpho", () => {
  const DEFI: DefiCfg = {
    asset: "USDC",
    strategies: [{ id: "safe", label: "Conservative" }],
    chains: [
      { id: 8453, name: "Base", usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
      { id: 1, name: "Ethereum", usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
      { id: 42161, name: "Arbitrum", usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
    ],
    midnight_chains: [8453],
    token_symbols: {},
    morpho_graphql: "https://blue-api.morpho.org/graphql",
    morpho_first: 25,
  };
  const CHAIN_NAMES = new Map(DEFI.chains.map((c) => [c.id, c.name]));

  async function rows(): Promise<MorphoRow[]> {
    return (await store().doc<{ rows: MorphoRow[] }>("morpho_markets"))!.payload.rows;
  }

  it("builds a query with listed:true, chain ids and lowercased addresses", () => {
    const q = buildQuery(
      [8453, 1, 42161],
      ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
      25,
    );
    expect(q).toContain("listed: true");
    expect(q).toContain("chainId_in: [8453, 1, 42161]");
    expect(q).toContain('"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"');
    expect(q).toContain('"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"');
    // addresses must be lowercase, never the mixed-case input
    expect(q).not.toContain("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(q).toContain("first: 25");
  });

  it("parses items and raises on error or missing shape", () => {
    // 5 real + idle + unknown-chain + garbage-apy + dCOMP, all object-shaped
    expect(parseMarkets(MORPHO_FIXTURE)).toHaveLength(9);
    expect(() => parseMarkets({ errors: [{ message: "boom" }] })).toThrow();
    expect(() => parseMarkets({ data: {} })).toThrow();
    expect(() => parseMarkets({ data: { markets: {} } })).toThrow();
    expect(() => parseMarkets({})).toThrow();
  });

  it("scales WAD lltv and fractional APYs, passing TVL through", () => {
    const row = buildRow(
      {
        marketId: "0xabc",
        lltv: "860000000000000000",
        chain: { id: 8453 },
        loanAsset: { symbol: "USDC" },
        collateralAsset: { symbol: "cbBTC" },
        state: {
          supplyApy: 0.0489,
          borrowApy: 0.0543,
          utilization: 0.9041,
          supplyAssetsUsd: 1413119205.7988927,
        },
      },
      CHAIN_NAMES,
    )!;
    expect(row.lltv_pct).toBeCloseTo(86.0, 9);
    expect(row.supply_apy).toBeCloseTo(4.89, 9);
    expect(row.borrow_apy).toBeCloseTo(5.43, 9);
    expect(row.utilization_pct).toBeCloseTo(90.41, 9);
    expect(row.tvl_usd).toBeCloseTo(1413119205.7988927, 5); // passthrough, no scaling
    expect(row.chain).toBe("Base");
    expect(row.chain_id).toBe(8453);
    expect(row.collateral).toBe("cbBTC");
    expect(row.market_id).toBe("0xabc");
  });

  it("skips idle, unknown-chain and malformed items", () => {
    const base = {
      marketId: "0x1",
      lltv: "860000000000000000",
      loanAsset: { symbol: "USDC" },
      state: { supplyApy: 0.05, borrowApy: 0.06, utilization: 0.9, supplyAssetsUsd: 5e6 },
    };
    expect(buildRow({ ...base, chain: { id: 8453 }, collateralAsset: null }, CHAIN_NAMES)).toBeNull();
    expect(
      buildRow({ ...base, chain: { id: 999 }, collateralAsset: { symbol: "WETH" } }, CHAIN_NAMES),
    ).toBeNull();
    expect(buildRow({ collateralAsset: { symbol: "X" } }, CHAIN_NAMES)).toBeNull();
    expect(
      buildRow({ ...base, lltv: "not-a-number", chain: { id: 8453 }, collateralAsset: { symbol: "cbBTC" } }, CHAIN_NAMES),
    ).toBeNull();
  });

  it("sorts TVL-desc and skips idle, unknown-chain and garbage-APY markets", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fakePost = async (url: string, body: unknown) => {
      seen.push({ url, body });
      return MORPHO_FIXTURE;
    };

    expect(await fetchMorpho(DEFI, store(), fakePost)).toBe("morpho-blue");
    expect(seen[0]?.url).toBe(DEFI.morpho_graphql);
    expect(seen[0]?.body).toHaveProperty("query");

    const out = await rows();
    expect(out).toHaveLength(6);
    expect(out[0]?.collateral).toBe("cbBTC");
    expect(out[0]?.chain).toBe("Base");
    expect(out[0]?.tvl_usd).toBeCloseTo(1413119205.7988927, 5);
    const tvls = out.map((r) => r.tvl_usd);
    expect(tvls).toEqual([...tvls].sort((a, b) => b - a));
  });

  it("drops the garbage-APY market but keeps the legitimate high-borrow one", async () => {
    await fetchMorpho(DEFI, store(), async () => MORPHO_FIXTURE);

    const out = await rows();
    expect(out.some((r) => r.collateral === "msY")).toBe(false);
    const dcomp = out.find((r) => r.collateral === "dCOMP")!;
    expect(dcomp.borrow_apy).toBeCloseTo(13.603793838014336, 10);
    expect(out.every((r) => r.supply_apy < 200 && r.borrow_apy < 200)).toBe(true);
  });

  it("keeps the previous doc when empty, but writes an empty first run", async () => {
    const empty = async () => ({ data: { markets: { items: [] } } });

    await store().putDoc("morpho_markets", { rows: [{ market_id: "old" }] }, "morpho-blue");
    expect(await fetchMorpho(DEFI, store(), empty)).toBe("morpho-blue");
    expect((await rows())[0]?.market_id).toBe("old");

    await env.DB.prepare("DELETE FROM docs").run();
    expect(await fetchMorpho(DEFI, store(), empty)).toBe("morpho-blue");
    expect(await rows()).toEqual([]);
  });

  it("raises on request failure and on a graphql errors member", async () => {
    await store().putDoc("morpho_markets", { rows: [{ market_id: "old" }] }, "morpho-blue");

    await expect(
      fetchMorpho(DEFI, store(), async () => {
        throw new Error("HTTP 500");
      }),
    ).rejects.toThrow(/morpho request\/parse failed/);
    expect((await rows())[0]?.market_id).toBe("old");

    await expect(
      fetchMorpho(DEFI, store(), async () => ({ errors: [{ message: "boom" }] })),
    ).rejects.toThrow(/morpho request\/parse failed/);
  });

  it("records a daily point under both series prefixes", async () => {
    await fetchMorpho(DEFI, store(), async () => MORPHO_FIXTURE);

    const top = (await rows())[0]!;
    const supply = await store().points(`mkt-supply:${top.chain_id}:${top.market_id}`);
    const borrow = await store().points(`mkt-borrow:${top.chain_id}:${top.market_id}`);
    expect([...supply.values()]).toEqual([top.supply_apy]);
    expect([...borrow.values()]).toEqual([top.borrow_apy]);
  });
});

describe("refs", () => {
  const SUPPLY_PCT = 2.735189345758076;
  const BORROW_PCT = 3.8981404251875613;
  const IMPLIED_PCT = 4.475867335355943;
  const UNDERLYING_PCT = 4.346230199002243;
  const FUNDING_PCT = 0.21790500000000002;

  const BASE_USDC: AaveRefCfg = {
    chain: "BASE",
    rpc: "https://base-rpc.publicnode.com",
    pool: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5",
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    symbol: "USDC",
  };
  const ETH_USDT: AaveRefCfg = {
    chain: "ETH",
    rpc: "https://ethereum-rpc.publicnode.com",
    pool: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
    asset: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    symbol: "USDT",
  };

  const REFS: RefsCfg = {
    aave: [BASE_USDC],
    llama_chart: [{ pool: "7e0661bf-8cf3-45e6-9424-31916d4c7b84", series: "aave-base-usdc-supply" }],
    pendle: [
      {
        chain_id: 8453,
        address: "0xa97bb0de338b23c088dba9bf8c948da726e49033",
        implied_id: "pendle-pt-cbbtc-usdc",
        implied_label: "PENDLE PT",
        underlying_id: "pendle-underlying-cbbtc-usdc",
        underlying_label: "PENDLE UNDERLY",
      },
    ],
    funding: [{ symbol: "BTCUSDT", id: "funding-binance-btc", label: "BTC FUND ANN" }],
  };

  const fakeGet = async (url: string) => {
    if (url.includes("pendle.finance") && url.includes("markets")) return PENDLE_MARKET;
    if (url.includes("premiumIndex")) return BINANCE_PREMIUM;
    throw new Error(`unexpected url: ${url}`);
  };
  const fakePost = async (url: string) => {
    if (url.includes("base-rpc.publicnode.com")) return AAVE_RPC;
    throw new Error(`unexpected url: ${url}`);
  };

  async function refRows(): Promise<RefRow[]> {
    return (await store().doc<{ rows: RefRow[] }>("rate_refs"))!.payload.rows;
  }
  const today = () => new Date().toISOString().slice(0, 10);

  it("decodes aave reserve data", () => {
    const [supply, borrow] = parseAaveReserveData(AAVE_RPC["result"] as string);
    expect(supply).toBeCloseTo(SUPPLY_PCT, 10);
    expect(borrow).toBeCloseTo(BORROW_PCT, 10);
  });

  it("rejects a short blob and rates outside the sanity band", () => {
    expect(() => parseAaveReserveData(`0x${"00".repeat(32 * 3)}`)).toThrow(); // only 3 words

    const words = Array<string>(5).fill("00".repeat(32));
    // word 2 (supply) absurdly large: 2000 ray-percent
    words[2] = BigInt(Math.round((2000 * 1e27) / 100)).toString(16).padStart(64, "0");
    expect(() => parseAaveReserveData(`0x${words.join("")}`)).toThrow();
  });

  it("parses a pendle market and rejects missing fields", () => {
    const parsed = parsePendleMarket(PENDLE_MARKET);
    expect(parsed.implied_pct).toBeCloseTo(IMPLIED_PCT, 10);
    expect(parsed.underlying_pct).toBeCloseTo(UNDERLYING_PCT, 10);
    expect(parsed.expiry).toBe("2026-09-17T00:00:00.000Z");

    expect(() => parsePendleMarket('{"impliedApy": 0.04}')).toThrow();
    expect(() => parsePendleMarket("[]")).toThrow();
  });

  it("formats an expiry from an explicit month table", () => {
    // Not locale-dependent formatting: the table is fixed, so this cannot drift.
    expect(expiryShort("2026-09-17T00:00:00.000Z")).toBe("SEP17");
    expect(expiryShort("2026-01-05T00:00:00.000Z")).toBe("JAN05");
  });

  it("annualizes binance funding and rejects a missing rate", () => {
    const parsed = parseFundingPremium(BINANCE_PREMIUM);
    expect(parsed.value_pct).toBeCloseTo(FUNDING_PCT, 10);
    expect(parsed.rate_8h).toBeCloseTo(0.00000199, 12);
    expect(() => parseFundingPremium('{"markPrice": "1"}')).toThrow();
  });

  it("derives the original aave ids and labels", () => {
    // BASE/USDC must derive the ORIGINAL ids: they carry accumulated history
    expect(aaveSupplyId(BASE_USDC)).toBe("aave-base-usdc-supply");
    expect(aaveBorrowId(BASE_USDC)).toBe("aave-base-usdc-borrow");
    expect(aaveSupplyLabel(BASE_USDC)).toBe("AAVE USDC BASE SUP");
    expect(aaveBorrowId(ETH_USDT)).toBe("aave-eth-usdt-borrow");
    expect(aaveBorrowLabel(ETH_USDT)).toBe("AAVE USDT ETH BOR");
  });

  it("keeps row order stable when one aave market fails", async () => {
    const refs: RefsCfg = { ...REFS, aave: [BASE_USDC, ETH_USDT], llama_chart: [] };
    const ethRpcFails = async (url: string) => {
      if (url.includes("base-rpc.publicnode.com")) return AAVE_RPC;
      throw new Error("publicnode down");
    };

    await fetchRefs(refs, store(), fakeGet, ethRpcFails);

    // the failed market has no previous doc to carry forward, so its rows are
    // simply absent; order stays stable
    expect((await refRows()).map((r) => r.id)).toEqual([
      "aave-base-usdc-supply",
      "aave-base-usdc-borrow",
      "pendle-pt-cbbtc-usdc",
      "pendle-underlying-cbbtc-usdc",
      "funding-binance-btc",
    ]);
    expect((await refRows())[0]?.label).toBe("AAVE USDC BASE SUP");
    expect((await refRows())[0]?.value_pct).toBeCloseTo(SUPPLY_PCT, 10);
  });

  it("orders rows and labels the PT row with its expiry", async () => {
    expect(await fetchRefs(REFS, store(), fakeGet, fakePost)).toBe("refs");

    const rows = await refRows();
    expect(rows.map((r) => r.id)).toEqual([
      "aave-base-usdc-supply",
      "aave-base-usdc-borrow",
      "pendle-pt-cbbtc-usdc",
      "pendle-underlying-cbbtc-usdc",
      "funding-binance-btc",
    ]);
    expect(rows[2]?.label).toBe("PENDLE PT SEP17");
    expect(rows[2]?.extra).toEqual({ expiry: "2026-09-17T00:00:00.000Z" });
    expect(rows[3]?.extra).toBeNull();
    expect(rows[0]?.value_pct).toBeCloseTo(SUPPLY_PCT, 10);
    expect(rows[1]?.value_pct).toBeCloseTo(BORROW_PCT, 10);
    expect((rows[4]?.extra as { rate_8h: number }).rate_8h).toBeCloseTo(0.00000199, 12);
    expect((await store().doc("rate_refs"))?.source).toBe("refs");
  });

  it("records a daily point for every fresh row", async () => {
    await fetchRefs(REFS, store(), fakeGet, fakePost);
    const d = today();

    expect((await store().points("ref:aave-base-usdc-supply")).get(d)).toBeCloseTo(SUPPLY_PCT, 10);
    expect((await store().points("ref:aave-base-usdc-borrow")).get(d)).toBeCloseTo(BORROW_PCT, 10);
    expect((await store().points("ref:pendle-pt-cbbtc-usdc")).get(d)).toBeCloseTo(IMPLIED_PCT, 10);
    expect((await store().points("ref:pendle-underlying-cbbtc-usdc")).get(d)).toBeCloseTo(
      UNDERLYING_PCT,
      10,
    );
    expect((await store().points("ref:funding-binance-btc")).get(d)).toBeCloseTo(FUNDING_PCT, 10);
  });

  it("carries a failed source forward and leaves its series untouched", async () => {
    const d = today();
    const oldImplied: RefRow = {
      id: "pendle-pt-cbbtc-usdc",
      label: "PENDLE PT OLD",
      value_pct: 1.23,
      extra: { expiry: "2025-01-01T00:00:00.000Z" },
    };
    const oldUnderlying: RefRow = {
      id: "pendle-underlying-cbbtc-usdc",
      label: "PENDLE UNDERLY",
      value_pct: 4.0,
      extra: null,
    };
    await store().putDoc(
      "rate_refs",
      {
        rows: [
          { id: "aave-base-usdc-supply", label: "AAVE SUPPLY", value_pct: 0.0, extra: null },
          { id: "aave-base-usdc-borrow", label: "AAVE BORROW", value_pct: 0.0, extra: null },
          oldImplied,
          oldUnderlying,
          { id: "funding-binance-btc", label: "BTC FUND ANN", value_pct: 0.0, extra: null },
        ],
      },
      "refs",
    );
    await store().upsertPoints("ref:pendle-pt-cbbtc-usdc", [[d, 1.23]]);

    const pendleFails = async (url: string) => {
      if (url.includes("pendle.finance")) throw new Error("pendle down");
      if (url.includes("premiumIndex")) return BINANCE_PREMIUM;
      throw new Error(`unexpected url: ${url}`);
    };

    expect(await fetchRefs(REFS, store(), pendleFails, fakePost)).toBe("refs");

    const byId = new Map((await refRows()).map((r) => [r.id, r]));
    // carried forward unchanged -- stale beats gone
    expect(byId.get("pendle-pt-cbbtc-usdc")).toEqual(oldImplied);
    expect(byId.get("pendle-underlying-cbbtc-usdc")).toEqual(oldUnderlying);
    // fresh sources updated
    expect(byId.get("aave-base-usdc-supply")?.value_pct).toBeCloseTo(SUPPLY_PCT, 10);
    expect(byId.get("funding-binance-btc")?.value_pct).toBeCloseTo(FUNDING_PCT, 10);
    // only fresh rows get a new daily point -- carried-forward series untouched
    expect(Object.fromEntries(await store().points("ref:pendle-pt-cbbtc-usdc"))).toEqual({
      [d]: 1.23,
    });
    expect((await store().points("ref:aave-base-usdc-supply")).get(d)).toBeCloseTo(SUPPLY_PCT, 10);
  });

  it("raises when every source fails and writes no doc", async () => {
    const failing = async () => {
      throw new Error("down");
    };
    await expect(fetchRefs(REFS, store(), failing, failing)).rejects.toThrow(
      /all refs sources failed/,
    );
    expect(await store().doc("rate_refs")).toBeNull();
  });
});
