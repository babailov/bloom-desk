/**
 * Live reference-rate values for the DEFI tab RATE REFS panel.
 * Port of collector/src/collector/fetchers/refs.py.
 *
 * Mirrors the macro / macro_history split: this is the 'refs' half (live values
 * + a daily point per row); 'refs_history' backfills the full series into the
 * same 'ref:{id}' keys. Live rows: aave supply/borrow per configured market
 * (one eth_call each, decoded here), pendle implied/underlying (one GET per
 * configured market), and funding annualized (one GET per configured symbol).
 *
 * Writes doc 'rate_refs' {"rows": [{id, label, value_pct, extra}]} (source
 * "refs"). Per-ref degradation: a failed source logs a warning and its rows are
 * carried forward from the previous doc, keyed by id (stale beats gone); total
 * failure raises. Only rows fetched fresh this run get a new point in their
 * 'ref:{id}' series -- carried-forward rows keep whatever history they have.
 *
 * Note on RPCs: mainnet.base.org rate-limits Cloudflare egress (429, verified
 * 2026-09-10), which is why config.yaml points Base at publicnode. Public RPCs
 * bucket by IP and Workers egress is shared platform-wide.
 */
import type {
  AaveRefCfg,
  FundingRefCfg,
  PendleRefCfg,
  RefsCfg,
} from "../config";
import { aaveBorrowId, aaveBorrowLabel, aaveSupplyId, aaveSupplyLabel } from "../config";
import type { GetText, PostJson } from "../http";
import type { Store } from "../store";

const AAVE_SELECTOR = "0x35ea6a75"; // getReserveData(address)
const AAVE_RATE_SANITY_MAX = 1000.0; // percent; anything at/above this is garbage, not a yield

const PENDLE_MARKET_BASE = "https://api-v2.pendle.finance/core/v1";
const FUNDING_PREMIUM_URL = "https://fapi.binance.com/fapi/v1/premiumIndex";

const RAY = 1e27;

export interface RefRow {
  id: string;
  label: string;
  value_pct: number;
  extra: Record<string, unknown> | null;
}

/** Build the `eth_call` calldata: selector + asset left-padded to a 32-byte word. */
export function aaveCallData(asset: string): string {
  const hex = asset.toLowerCase().startsWith("0x") ? asset.slice(2) : asset;
  return AAVE_SELECTOR + hex.toLowerCase().padStart(64, "0");
}

/**
 * Decode `getReserveData`'s ABI-encoded return blob into [supplyPct, borrowPct].
 *
 * Word 2 is the current liquidity (supply) rate, word 4 the current variable
 * borrow rate, both RAY (1e27) scaled. Throws if the blob has fewer than 5
 * words or either decoded rate falls outside the [0, 1000) percent band.
 */
export function parseAaveReserveData(resultHex: string): [number, number] {
  const hexstr = resultHex.startsWith("0x") ? resultHex.slice(2) : resultHex;
  const words: string[] = [];
  for (let i = 0; i < hexstr.length; i += 64) words.push(hexstr.slice(i, i + 64));

  if (words.length < 5) {
    throw new Error(`aave reserve data has ${words.length} words, need >= 5`);
  }

  // BigInt, not parseInt: a 256-bit word exceeds Number's exact integer range.
  const supplyPct = (Number(BigInt(`0x${words[2]!}`)) / RAY) * 100;
  const borrowPct = (Number(BigInt(`0x${words[4]!}`)) / RAY) * 100;

  if (!(supplyPct >= 0 && supplyPct < AAVE_RATE_SANITY_MAX)) {
    throw new Error(`aave supply rate out of sanity band: ${supplyPct}`);
  }
  if (!(borrowPct >= 0 && borrowPct < AAVE_RATE_SANITY_MAX)) {
    throw new Error(`aave borrow rate out of sanity band: ${borrowPct}`);
  }
  return [supplyPct, borrowPct];
}

async function fetchAaveRows(cfg: AaveRefCfg, postJson: PostJson): Promise<RefRow[]> {
  const body = await postJson(cfg.rpc, {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: cfg.pool, data: aaveCallData(cfg.asset) }, "latest"],
  });

  if (body["error"] !== undefined && body["error"] !== null) {
    throw new Error(`aave RPC error: ${JSON.stringify(body["error"])}`);
  }
  const result = body["result"];
  if (typeof result !== "string") throw new Error("aave RPC response missing result");

  const [supplyPct, borrowPct] = parseAaveReserveData(result);
  return [
    { id: aaveSupplyId(cfg), label: aaveSupplyLabel(cfg), value_pct: supplyPct, extra: null },
    { id: aaveBorrowId(cfg), label: aaveBorrowLabel(cfg), value_pct: borrowPct, extra: null },
  ];
}

/** Explicit month table: locale-dependent month formatting is not reproducible. */
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** '2026-09-17T00:00:00.000Z' -> 'SEP17' (label suffix for a Pendle PT row). */
export function expiryShort(expiryIso: string): string {
  const iso = expiryIso.slice(0, 10);
  const month = Number(iso.slice(5, 7));
  const day = iso.slice(8, 10);
  const name = MONTHS[month - 1];
  if (name === undefined) throw new Error(`bad expiry month in ${expiryIso}`);
  return `${name}${day}`;
}

/**
 * Parse one `markets/{address}` response into implied/underlying pct + expiry.
 * Throws if the payload is not an object or is missing any of the three.
 */
export function parsePendleMarket(text: string): {
  implied_pct: number;
  underlying_pct: number;
  expiry: string;
} {
  const body: unknown = JSON.parse(text);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("pendle payload is not a JSON object");
  }
  const { impliedApy, underlyingApy, expiry } = body as Record<string, unknown>;

  if (typeof impliedApy !== "number") throw new Error("pendle payload missing impliedApy");
  if (typeof underlyingApy !== "number") throw new Error("pendle payload missing underlyingApy");
  if (typeof expiry !== "string") throw new Error("pendle payload missing expiry");

  return { implied_pct: impliedApy * 100, underlying_pct: underlyingApy * 100, expiry };
}

async function fetchPendleRows(entry: PendleRefCfg, getText: GetText): Promise<RefRow[]> {
  const url = `${PENDLE_MARKET_BASE}/${entry.chain_id}/markets/${entry.address}`;
  const parsed = parsePendleMarket(await getText(url));
  return [
    {
      id: entry.implied_id,
      label: `${entry.implied_label} ${expiryShort(parsed.expiry)}`,
      value_pct: parsed.implied_pct,
      extra: { expiry: parsed.expiry },
    },
    {
      id: entry.underlying_id,
      label: entry.underlying_label,
      value_pct: parsed.underlying_pct,
      extra: null,
    },
  ];
}

/**
 * Parse one `premiumIndex` response into annualized pct + the raw 8h rate.
 * Funding pays three times a day, hence rate * 3 * 365.
 */
export function parseFundingPremium(text: string): { value_pct: number; rate_8h: number } {
  const body: unknown = JSON.parse(text);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("binance funding payload is not a JSON object");
  }
  const raw = (body as Record<string, unknown>)["lastFundingRate"];
  if (raw === null || raw === undefined) {
    throw new Error("binance funding payload missing lastFundingRate");
  }
  const rate = Number(raw);
  if (!Number.isFinite(rate)) throw new Error("binance funding lastFundingRate is not numeric");

  return { value_pct: rate * 3 * 365 * 100, rate_8h: rate };
}

async function fetchFundingRows(entry: FundingRefCfg, getText: GetText): Promise<RefRow[]> {
  const parsed = parseFundingPremium(await getText(FUNDING_PREMIUM_URL, { symbol: entry.symbol }));
  return [
    {
      id: entry.id,
      label: entry.label,
      value_pct: parsed.value_pct,
      extra: { rate_8h: parsed.rate_8h },
    },
  ];
}

export async function fetchRefs(
  refs: RefsCfg,
  store: Store,
  getText: GetText,
  postJson: PostJson,
): Promise<string> {
  const prev = await store.doc<{ rows?: RefRow[] }>("rate_refs");
  const prevById = new Map((prev?.payload.rows ?? []).map((r) => [r.id, r]));

  const fresh = new Map<string, RefRow>();
  const errors: string[] = [];

  for (const market of refs.aave) {
    try {
      for (const row of await fetchAaveRows(market, postJson)) fresh.set(row.id, row);
    } catch (exc) {
      // per-source isolation
      console.warn(`refs aave ${market.chain} ${market.symbol} failed: ${String(exc)}`);
      errors.push(`aave ${market.chain} ${market.symbol}: ${String(exc)}`);
    }
  }

  for (const entry of refs.pendle) {
    try {
      for (const row of await fetchPendleRows(entry, getText)) fresh.set(row.id, row);
    } catch (exc) {
      console.warn(`refs pendle ${entry.address} failed: ${String(exc)}`);
      errors.push(`pendle ${entry.address}: ${String(exc)}`);
    }
  }

  for (const entry of refs.funding) {
    try {
      for (const row of await fetchFundingRows(entry, getText)) fresh.set(row.id, row);
    } catch (exc) {
      console.warn(`refs funding ${entry.symbol} failed: ${String(exc)}`);
      errors.push(`funding ${entry.symbol}: ${String(exc)}`);
    }
  }

  if (fresh.size === 0) throw new Error(`all refs sources failed: ${errors.join("; ")}`);

  // stable row order: aave markets (config order, supply then borrow),
  // pendle rows (config order), funding rows
  const order: string[] = [];
  for (const market of refs.aave) order.push(aaveSupplyId(market), aaveBorrowId(market));
  for (const entry of refs.pendle) order.push(entry.implied_id, entry.underlying_id);
  for (const entry of refs.funding) order.push(entry.id);

  const rows: RefRow[] = [];
  for (const id of order) {
    const row = fresh.get(id) ?? prevById.get(id); // stale beats gone
    if (row !== undefined) rows.push(row);
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    // only fresh rows get a new daily point
    if (fresh.has(row.id)) await store.upsertPoints(`ref:${row.id}`, [[today, row.value_pct]]);
  }

  await store.putDoc("rate_refs", { rows }, "refs");
  return "refs";
}
