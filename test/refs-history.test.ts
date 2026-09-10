import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import LLAMA_CHART from "./fixtures/llama_chart.json?raw";
import PENDLE_APY_HISTORY from "./fixtures/pendle_apy_history.json?raw";
import FUNDING_PAGE_JSON from "./fixtures/binance_funding_page.json?raw";

import {
  dailyMeanAnnualized,
  fetchRefsHistory,
  parseLlamaChart,
  parsePendleApyHistory,
} from "../src/fetchers/refs-history";
import type { FundingRefCfg, LlamaChartCfg, PendleRefCfg, RefsCfg } from "../src/config";
import { Store } from "../src/store";

// Ports collector/tests/test_refs_history.py.

const store = () => new Store(env.DB);
const FUNDING_PAGE = JSON.parse(FUNDING_PAGE_JSON) as Record<string, unknown>[];

const AAVE = {
  chain: "BASE",
  rpc: "https://base-rpc.publicnode.com",
  pool: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5",
  asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  symbol: "USDC",
};
const LLAMA: LlamaChartCfg = {
  pool: "7e0661bf-8cf3-45e6-9424-31916d4c7b84",
  series: "aave-base-usdc-supply",
};
const PENDLE: PendleRefCfg = {
  chain_id: 8453,
  address: "0xa97bb0de338b23c088dba9bf8c948da726e49033",
  implied_id: "pendle-pt-cbbtc-usdc",
  implied_label: "PENDLE PT",
  underlying_id: "pendle-underlying-cbbtc-usdc",
  underlying_label: "PENDLE UNDERLY",
};
const FUNDING: FundingRefCfg = {
  symbol: "BTCUSDT",
  id: "funding-binance-btc",
  label: "BTC FUND ANN",
};

const makeRefs = (over: Partial<RefsCfg> = {}): RefsCfg => ({
  aave: [AAVE],
  llama_chart: [LLAMA],
  pendle: [PENDLE],
  funding: [FUNDING],
  ...over,
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM series_points"),
    env.DB.prepare("DELETE FROM docs"),
  ]);
});

describe("parsing", () => {
  it("skips llama entries with a null apyBase", () => {
    const points = new Map(parseLlamaChart(LLAMA_CHART));
    expect(points.size).toBe(6); // 7 rows in the fixture, one null apyBase skipped
    expect(points.has("2024-06-01")).toBe(false);
    expect(points.get("2024-03-10")).toBeCloseTo(13.42682, 8);
    expect(points.get("2026-07-23")).toBeCloseTo(2.7346, 8);
  });

  it("raises when the llama payload has no data list", () => {
    expect(() => parseLlamaChart('{"status": "error"}')).toThrow();
    expect(() => parseLlamaChart("[]")).toThrow();
  });

  it("parses the pendle CSV-inside-JSON results field", () => {
    const hist = parsePendleApyHistory(PENDLE_APY_HISTORY);
    const implied = new Map(hist.implied);
    const underlying = new Map(hist.underlying);

    expect(implied.size).toBe(8);
    expect(underlying.size).toBe(8);
    expect(implied.get("2026-07-16")).toBeCloseTo(4.8, 8);
    expect(underlying.get("2026-07-16")).toBeCloseTo(4.32, 8);
    expect(implied.get("2026-07-23")).toBeCloseTo(4.48, 8);
    expect(underlying.get("2026-07-23")).toBeCloseTo(4.35, 8);
  });

  it("raises when the pendle payload has no results CSV", () => {
    expect(() => parsePendleApyHistory('{"total": 0}')).toThrow();
  });

  it("annualizes the daily mean of 8h funding rates", () => {
    const points = new Map(dailyMeanAnnualized(FUNDING_PAGE));
    expect(points.get("2026-03-12")).toBeCloseTo(-7.5099, 3);
    expect(points.get("2026-03-13")).toBeCloseTo(0.3051, 3);
  });

  it("skips malformed funding rows", () => {
    expect(dailyMeanAnnualized([{ fundingTime: "not-a-number", fundingRate: "0.0001" }])).toEqual(
      [],
    );
  });
});

describe("fetchRefsHistory", () => {
  it("backfills llama and pendle into the ref series", async () => {
    const fakeGet = async (url: string) => {
      if (url.includes("yields.llama.fi")) return LLAMA_CHART;
      if (url.includes("apy-history")) return PENDLE_APY_HISTORY;
      throw new Error(`unexpected url: ${url}`);
    };

    expect(await fetchRefsHistory(makeRefs({ funding: [] }), store(), fakeGet)).toBe(
      "refs-history",
    );

    expect((await store().points("ref:aave-base-usdc-supply")).get("2026-07-23")).toBeCloseTo(
      2.7346,
      8,
    );
    expect((await store().points("ref:pendle-pt-cbbtc-usdc")).get("2026-07-16")).toBeCloseTo(
      4.8,
      8,
    );
    expect(
      (await store().points("ref:pendle-underlying-cbbtc-usdc")).get("2026-07-16"),
    ).toBeCloseTo(4.32, 8);
  });

  it("is idempotent across reruns", async () => {
    const refs = makeRefs({ pendle: [], funding: [] });
    const fakeGet = async () => LLAMA_CHART;

    await fetchRefsHistory(refs, store(), fakeGet);
    const first = Object.fromEntries(await store().points("ref:aave-base-usdc-supply"));
    await fetchRefsHistory(refs, store(), fakeGet);
    const second = Object.fromEntries(await store().points("ref:aave-base-usdc-supply"));

    expect(first).toEqual(second);
  });

  it("paginates funding by startTime until a short page", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      symbol: "BTCUSDT",
      fundingTime: 1_000_000_000_000 + i * 28_800_000,
      fundingRate: "0.00010000",
      markPrice: "1",
    }));
    const calls: Record<string, string>[] = [];

    const fakeGet = async (_url: string, params?: Record<string, string>) => {
      calls.push({ ...params });
      if (calls.length === 1) {
        expect(params?.["startTime"]).toBe("0");
        return JSON.stringify(fullPage);
      }
      expect(params?.["startTime"]).toBe(String(fullPage[fullPage.length - 1]!.fundingTime + 1));
      return FUNDING_PAGE_JSON;
    };

    expect(
      await fetchRefsHistory(makeRefs({ llama_chart: [], pendle: [] }), store(), fakeGet),
    ).toBe("refs-history");
    expect(calls).toHaveLength(2); // stopped once a short (<1000) page came back

    const points = await store().points("ref:funding-binance-btc");
    expect(points.get("2026-03-12")).toBeCloseTo(-7.5099, 3);
    expect(points.get("2026-03-13")).toBeCloseTo(0.3051, 3);
  });

  it("hard-caps funding pagination at 20 pages", async () => {
    const calls: Record<string, string>[] = [];
    const alwaysFullPage = async (_url: string, params?: Record<string, string>) => {
      calls.push({ ...params });
      const base = calls.length * 10_000_000_000;
      return JSON.stringify(
        Array.from({ length: 1000 }, (_, i) => ({
          symbol: "BTCUSDT",
          fundingTime: base + i * 28_800_000,
          fundingRate: "0.0001",
          markPrice: "1",
        })),
      );
    };

    await fetchRefsHistory(makeRefs({ llama_chart: [], pendle: [] }), store(), alwaysFullPage);
    expect(calls).toHaveLength(20); // hard cap, even though every page is "full"
  });

  it("degrades per source", async () => {
    const llamaFails = async (url: string) => {
      if (url.includes("yields.llama.fi")) throw new Error("llama down");
      if (url.includes("apy-history")) return PENDLE_APY_HISTORY;
      throw new Error(`unexpected url: ${url}`);
    };

    expect(await fetchRefsHistory(makeRefs({ funding: [] }), store(), llamaFails)).toBe(
      "refs-history",
    );
    expect((await store().points("ref:aave-base-usdc-supply")).size).toBe(0);
    expect((await store().points("ref:pendle-pt-cbbtc-usdc")).size).toBeGreaterThan(0);
  });

  it("raises when every source fails", async () => {
    await expect(
      fetchRefsHistory(makeRefs(), store(), async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow(/all refs-history sources failed/);
  });
});
