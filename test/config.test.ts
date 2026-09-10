import { describe, expect, it } from "vitest";
import { config } from "../src/config.data";
import { aaveBorrowId, aaveSupplyId } from "../src/config";

// The generated module has to reproduce what load_config does while loading,
// not just what config.yaml says. This caught a live bug: without lowercasing,
// midnight compares `loan_token.toLowerCase()` against a checksummed
// chain.usdc, matches nothing, and silently serves an empty curve.

const isLowerHexAddress = (s: string) => /^0x[0-9a-f]{40}$/.test(s);

describe("generated config normalization", () => {
  it("lowercases every chain USDC address", () => {
    for (const chain of config.defi.chains) {
      expect(isLowerHexAddress(chain.usdc), `${chain.name} usdc`).toBe(true);
    }
  });

  it("lowercases every token_symbols key", () => {
    for (const key of Object.keys(config.defi.token_symbols)) {
      expect(isLowerHexAddress(key), key).toBe(true);
    }
  });

  it("lowercases every aave pool and asset address", () => {
    for (const a of config.refs.aave) {
      expect(isLowerHexAddress(a.pool), `${a.chain} pool`).toBe(true);
      expect(isLowerHexAddress(a.asset), `${a.chain} asset`).toBe(true);
    }
  });

  it("lowercases every pendle market address", () => {
    for (const p of config.refs.pendle) {
      expect(isLowerHexAddress(p.address), p.implied_id).toBe(true);
    }
  });
});

describe("config invariants the Python suite also asserts", () => {
  it("keeps the aave market list and its derived ids", () => {
    expect(config.refs.aave.map((a) => [a.chain, a.symbol])).toEqual([
      ["BASE", "USDC"],
      ["ETH", "USDC"],
      ["ETH", "USDT"],
      ["ARB", "USDC"],
      ["ARB", "USDT"],
    ]); // Base USDT deliberately absent: not listed on Aave v3 Base

    const base = config.refs.aave[0]!;
    expect(aaveSupplyId(base)).toBe("aave-base-usdc-supply");
    expect(aaveBorrowId(base)).toBe("aave-base-usdc-borrow");
    // publicnode, not mainnet.base.org: the latter 429s Cloudflare egress
    expect(base.rpc).toBe("https://base-rpc.publicnode.com");
  });

  it("gives every aave market a supply-side llama backfill entry", () => {
    expect(config.refs.llama_chart.map((c) => c.series)).toEqual(
      config.refs.aave.map((a) => aaveSupplyId(a)),
    );
  });

  it("keeps every cycle_tabs row pointing at a real cycle series", () => {
    const ids = new Set(config.cycle_series.map((s) => s.id));
    for (const tab of config.cycle_tabs) {
      for (const panel of tab.panels) {
        for (const row of panel.rows) {
          expect(ids.has(row.series), `${tab.id}/${row.series}`).toBe(true);
          if (row.overlay) expect(ids.has(row.overlay), `overlay ${row.overlay}`).toBe(true);
        }
      }
    }
  });
});
