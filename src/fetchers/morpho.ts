/**
 * Morpho Blue GraphQL markets: the underlying isolated lending markets that
 * Midnight's fixed-rate books quote against -- the cleanest floating comparable
 * for the term structure.
 *
 * Port of collector/src/collector/fetchers/morpho.py.
 *
 * One POST covers every configured chain and the USDC loan asset. `listed:
 * true` is essential: without it the API returns exploit-bait / unlisted
 * markets (one seen at ~297,892% APY, not a real yield). It is not sufficient
 * either: some Ethereum markets are `listed: true` and still broken, reporting
 * ~298,000% supply/borrow APY at 100% utilization (msY, AZND -- observed live
 * 2026-07-23). An APY sanity band catches those too. Values are fractions
 * (x100 for a percent); `lltv` is an 18-decimal WAD ratio. Markets with a null
 * collateralAsset are idle and skipped; markets on an unrecognized chain id are
 * skipped with a warning.
 */
import type { DefiCfg } from "../config";
import type { PostJson } from "../http";
import type { Store } from "../store";

const WAD = 10n ** 18n;
const APY_SANITY_MIN = -100.0; // percent; a rate can't shrink principal by more than 100%
const APY_SANITY_MAX = 200.0; // percent; real markets don't clear this

export interface MorphoRow {
  chain: string;
  chain_id: number;
  market_id: string;
  collateral: string;
  lltv_pct: number;
  supply_apy: number;
  borrow_apy: number;
  utilization_pct: number;
  tvl_usd: number;
}

export function buildQuery(
  chainIds: readonly number[],
  usdcAddresses: readonly string[],
  first: number,
): string {
  const ids = chainIds.join(", ");
  const addrs = usdcAddresses.map((a) => `"${a.toLowerCase()}"`).join(", ");
  // Braces are literal here. The Python original doubles them only because
  // f-strings escape them; the rendered query has single braces throughout.
  return `{ markets(first: ${first}, where: { chainId_in: [${ids}],
    loanAssetAddress_in: [${addrs}],
    listed: true },
    orderBy: SupplyAssetsUsd, orderDirection: Desc) {
  items { marketId lltv chain { id }
          loanAsset { symbol } collateralAsset { symbol }
          state { supplyApy borrowApy utilization supplyAssetsUsd } } } }`;
}

export function parseMarkets(body: Record<string, unknown>): Record<string, unknown>[] {
  if ("errors" in body) {
    throw new Error(`morpho graphql errors: ${JSON.stringify(body["errors"])}`);
  }
  const items = (body as { data?: { markets?: { items?: unknown } } }).data?.markets?.items;
  if (items === undefined) throw new Error("morpho payload missing data.markets.items");
  if (!Array.isArray(items)) throw new Error("morpho payload data.markets.items is not a list");
  return items.filter((i): i is Record<string, unknown> => i !== null && typeof i === "object");
}

/** lltv is an 18-decimal WAD; BigInt keeps full precision before scaling. */
function lltvPercent(raw: unknown): number {
  const asBig = BigInt(String(raw));
  return (Number(asBig) / Number(WAD)) * 100;
}

/** Exported for tests, mirroring the Python suite's use of `_row`. */
export function buildRow(
  item: Record<string, unknown>,
  chainNames: Map<number, string>,
): MorphoRow | null {
  try {
    const collateralAsset = item["collateralAsset"] as { symbol?: unknown } | null | undefined;
    // idle market: no collateral configured, nothing to show
    if (collateralAsset === null || collateralAsset === undefined) return null;

    const chainId = Number((item["chain"] as { id?: unknown })?.id);
    const chainName = chainNames.get(chainId);
    if (chainName === undefined) {
      console.warn(`skipping morpho market on unknown chain id ${chainId}`);
      return null;
    }

    const marketId = String(item["marketId"]);
    const state = item["state"] as Record<string, unknown>;
    const supplyApy = Number(state["supplyApy"]) * 100;
    const borrowApy = Number(state["borrowApy"]) * 100;

    if (
      !(supplyApy > APY_SANITY_MIN && supplyApy < APY_SANITY_MAX) ||
      !(borrowApy > APY_SANITY_MIN && borrowApy < APY_SANITY_MAX)
    ) {
      console.warn(`skipping morpho market ${marketId}: apy out of sanity band`);
      return null;
    }

    const row: MorphoRow = {
      chain: chainName,
      chain_id: chainId,
      market_id: marketId,
      collateral: String(collateralAsset.symbol),
      lltv_pct: lltvPercent(item["lltv"]),
      supply_apy: supplyApy,
      borrow_apy: borrowApy,
      utilization_pct: Number(state["utilization"]) * 100,
      tvl_usd: Number(state["supplyAssetsUsd"]),
    };
    if (!Number.isFinite(row.lltv_pct) || !Number.isFinite(row.tvl_usd)) return null;
    if (!Number.isFinite(row.utilization_pct)) return null;
    return row;
  } catch {
    return null;
  }
}

export async function fetchMorpho(
  defi: DefiCfg,
  store: Store,
  postJson: PostJson,
): Promise<string> {
  const chainNames = new Map(defi.chains.map((c) => [c.id, c.name]));
  const query = buildQuery(
    defi.chains.map((c) => c.id),
    defi.chains.map((c) => c.usdc),
    defi.morpho_first,
  );

  let items: Record<string, unknown>[];
  try {
    // request/parse failure must raise, so the previous doc survives
    items = parseMarkets(await postJson(defi.morpho_graphql, { query }));
  } catch (exc) {
    throw new Error(`morpho request/parse failed: ${String(exc)}`);
  }

  const rows: MorphoRow[] = [];
  for (const item of items) {
    const row = buildRow(item, chainNames);
    if (row !== null) rows.push(row);
  }
  rows.sort((a, b) => b.tvl_usd - a.tvl_usd); // API already sorts TVL-desc; sort anyway

  if (rows.length === 0) {
    const prev = await store.doc<{ rows?: MorphoRow[] }>("morpho_markets");
    if (prev?.payload.rows?.length) {
      console.warn("morpho returned zero markets; keeping previous doc");
      return "morpho-blue";
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    await store.upsertPoints(`mkt-supply:${row.chain_id}:${row.market_id}`, [
      [today, row.supply_apy],
    ]);
    await store.upsertPoints(`mkt-borrow:${row.chain_id}:${row.market_id}`, [
      [today, row.borrow_apy],
    ]);
  }
  await store.putDoc("morpho_markets", { rows }, "morpho-blue");
  return "morpho-blue";
}
