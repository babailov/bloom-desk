/**
 * Morpho Midnight fixed-rate books -> implied USDC term structure.
 * Port of collector/src/collector/fetchers/midnight.py.
 *
 * Books quote zero-coupon unit prices (18-decimal WAD): pay p now, receive 1 at
 * maturity. Implied annualized yield over d days is (1/p)^(365/d) - 1 (ACT/365,
 * compounded). Lenders buy credit units at the ask; borrowers sell debt units
 * at the bid, so lend APY < borrow APY is the normal spread. Best level is
 * chosen by price (min ask / max bid), not by API ordering.
 *
 * Writes the 'midnight_curve' doc. No history series: maturities roll off, so
 * per-market series would be short-lived orphans.
 *
 * Base URL note: /v0/ is the real API (found in @morpho-org/midnight-sdk); the
 * docs site advertises /v1/ which 404s. Pagination: {cursor, data}, page size
 * capped at 20 by the server, cursor echoed as a query param.
 */
import type { ChainCfg, DefiCfg } from "../config";
import type { GetText } from "../http";
import type { Store } from "../store";

const WAD = 10 ** 18;
const MAX_PAGES = 10; // cursor-loop hard cap; Base has ~5 books today
const PRICE_SANITY_MAX = 1.5; // unit price above this (or <= 0) is garbage, not a yield

export interface MidnightRow {
  chain: string;
  market_id: string;
  maturity: string;
  days: number;
  lend_apy: number | null;
  borrow_apy: number | null;
  ask_depth_usd: number;
  bid_depth_usd: number;
  collateral: string;
}

export function parseBooks(text: string): [string | null, Record<string, unknown>[]] {
  const body: unknown = JSON.parse(text);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("midnight payload is not a JSON object");
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error("midnight payload has no data list");
  const cursor = (body as { cursor?: unknown }).cursor;
  return [
    typeof cursor === "string" && cursor !== "" ? cursor : null,
    data.filter((b): b is Record<string, unknown> => b !== null && typeof b === "object"),
  ];
}

export function impliedApy(
  priceWad: bigint | number | string,
  maturityTs: number,
  now: Date,
): number | null {
  const days = (maturityTs - now.getTime() / 1000) / 86400;
  if (days <= 0) return null;

  const price = Number(BigInt(String(priceWad))) / WAD;
  if (!(price > 0 && price <= PRICE_SANITY_MAX)) return null;

  const apy = ((1 / price) ** (365 / days) - 1) * 100;
  // Sub-hour horizons annualize to astronomically large figures. Python raises
  // OverflowError there; JS returns Infinity, so it is checked explicitly.
  return Number.isFinite(apy) ? apy : null;
}

function bookRow(
  book: Record<string, unknown>,
  chain: ChainCfg,
  symbols: Record<string, string>,
  now: Date,
): MidnightRow | null {
  try {
    const maturityTs = Number(book["maturity"]);
    if (!Number.isFinite(maturityTs)) return null;

    const days = (maturityTs - now.getTime() / 1000) / 86400;
    // matured book still listed by the API, not part of the curve
    if (days <= 0) return null;

    const levels = (key: string): Record<string, unknown>[] => {
      const raw = book[key];
      return Array.isArray(raw)
        ? raw.filter((l): l is Record<string, unknown> => l !== null && typeof l === "object")
        : [];
    };
    const asks = levels("asks");
    const bids = levels("bids");

    const askPrices = asks.map((l) => BigInt(String(l["price"])));
    const bidPrices = bids.map((l) => BigInt(String(l["price"])));
    const bestAsk = askPrices.length ? askPrices.reduce((a, b) => (b < a ? b : a)) : null;
    const bestBid = bidPrices.length ? bidPrices.reduce((a, b) => (b > a ? b : a)) : null;

    const rawCollats = Array.isArray(book["collaterals"]) ? book["collaterals"] : [];
    const collats = (rawCollats as { token?: unknown }[]).map((c) => {
      const token = String(c.token);
      return symbols[token.toLowerCase()] ?? `${token.slice(0, 6)}…`;
    });

    const sumAssets = (ls: Record<string, unknown>[]): number =>
      // USDC: 6 decimals
      Number(ls.reduce((acc, l) => acc + BigInt(String(l["assets"])), 0n)) / 1e6;

    return {
      chain: chain.name,
      market_id: String(book["market_id"]),
      maturity: new Date(maturityTs * 1000).toISOString().slice(0, 10),
      days,
      lend_apy: bestAsk ? impliedApy(bestAsk, maturityTs, now) : null,
      borrow_apy: bestBid ? impliedApy(bestBid, maturityTs, now) : null,
      ask_depth_usd: sumAssets(asks),
      bid_depth_usd: sumAssets(bids),
      collateral: collats.join("+") || "—",
    };
  } catch {
    return null;
  }
}

async function fetchAllBooks(
  baseUrl: string,
  chainId: number,
  getText: GetText,
): Promise<Record<string, unknown>[]> {
  const books: Record<string, unknown>[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = { chain_ids: String(chainId), limit: "20" };
    if (cursor) params["cursor"] = cursor;

    const [nextCursor, pageBooks] = parseBooks(await getText(`${baseUrl}/books`, params));
    books.push(...pageBooks);
    cursor = nextCursor;
    if (!cursor) return books;
  }

  console.warn("midnight pagination hit MAX_PAGES with cursor still live; books truncated");
  return books;
}

export async function fetchMidnight(
  defi: DefiCfg,
  baseUrl: string,
  store: Store,
  getText: GetText,
  now: Date = new Date(),
): Promise<string> {
  let chainsAttempted = 0;
  let chainsOk = 0;
  const errors: string[] = [];
  const rows: MidnightRow[] = [];

  for (const chain of defi.chains) {
    if (!defi.midnight_chains.includes(chain.id)) continue;
    chainsAttempted++;

    let books: Record<string, unknown>[];
    try {
      books = await fetchAllBooks(baseUrl, chain.id, getText);
      chainsOk++;
    } catch (exc) {
      // one dead chain degrades, not kills
      errors.push(`${chain.name}: ${String(exc)}`);
      console.warn(`midnight ${chain.name} failed: ${String(exc)}`);
      continue;
    }

    for (const book of books) {
      // USDC term structure only
      if (String(book["loan_token"] ?? "").toLowerCase() !== chain.usdc) continue;
      const row = bookRow(book, chain, defi.token_symbols, now);
      if (row !== null) rows.push(row);
    }
  }

  if (chainsAttempted > 0 && chainsOk === 0) {
    throw new Error(`all midnight chains failed: ${errors.join("; ")}`);
  }

  rows.sort((a, b) => (a.maturity < b.maturity ? -1 : a.maturity > b.maturity ? 1 : 0));
  await store.putDoc("midnight_curve", { rows }, "morpho");
  return "morpho";
}
