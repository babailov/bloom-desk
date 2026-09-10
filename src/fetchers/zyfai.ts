/**
 * Zyfai DeFi yield opportunities: USDC pools across risk tiers and chains.
 * Port of collector/src/collector/fetchers/zyfai.py.
 *
 * Tiers are nested (safe within degen within async): a pool is listed once,
 * under the most conservative tier that contains it -- strategies iterate in
 * config order, first listing wins. Writes the 'defi_pools' doc and records one
 * daily combined-APY point per pool to series 'defi:{chain_id}:{pool_address}'.
 *
 * Undocumented public API: shape changes surface as parse failures. On total
 * endpoint failure the run raises and the previous doc survives; a run where
 * every endpoint answers but returns zero pools also keeps the previous
 * non-empty doc (its aging timestamp marks the panel stale).
 */
import type { DefiCfg } from "../config";
import type { GetText } from "../http";
import type { Store } from "../store";

export interface DefiRow {
  tier: string;
  chain: string;
  chain_id: number;
  pool_address: string;
  protocol: string;
  pool: string;
  apy: number;
  apy_7d: number | null;
  apy_30d: number | null;
  tvl_usd: number | null;
  url: string | null;
}

export function parseOpportunities(text: string): Record<string, unknown>[] {
  const body: unknown = JSON.parse(text);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("zyfai payload is not a JSON object");
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error("zyfai payload has no data list");
  return data.filter((o): o is Record<string, unknown> => o !== null && typeof o === "object");
}

function optFloat(x: unknown): number | null {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function requiredString(x: unknown): string {
  if (x === null || x === undefined) throw new Error("missing field");
  return String(x);
}

function buildRow(
  opp: Record<string, unknown>,
  tier: string,
  chainId: number,
  chainName: string,
): DefiRow | null {
  try {
    const apy = Number(opp["combined_apy"]);
    if (!Number.isFinite(apy)) return null;
    return {
      tier,
      chain: chainName,
      chain_id: chainId,
      pool_address: requiredString(opp["pool_address"]),
      protocol: requiredString(opp["protocol_name"]),
      pool: requiredString(opp["pool_name"]),
      apy,
      apy_7d: optFloat(opp["averageCombinedApy7Days"]),
      apy_30d: optFloat(opp["averageCombinedApy30Days"]),
      tvl_usd: optFloat(opp["tvlUsd"]),
      url: (opp["url"] as string | undefined) ?? null,
    };
  } catch {
    return null;
  }
}

export async function fetchDefi(
  defi: DefiCfg,
  baseUrl: string,
  store: Store,
  getText: GetText,
): Promise<string> {
  const rows: DefiRow[] = [];
  const seen = new Set<string>();
  let ok = 0;
  const errors: string[] = [];

  // strategy-major: the most conservative tier claims the pool
  for (const strat of defi.strategies) {
    for (const chain of defi.chains) {
      let opps: Record<string, unknown>[];
      try {
        opps = parseOpportunities(
          await getText(`${baseUrl}/${strat.id}`, {
            asset: defi.asset,
            chainId: String(chain.id),
            status: "live",
          }),
        );
        ok++;
      } catch (exc) {
        // one dead endpoint degrades, not kills
        errors.push(`${strat.id}/${chain.name}: ${String(exc)}`);
        console.warn(`zyfai ${strat.id}/${chain.name} failed: ${String(exc)}`);
        continue;
      }

      for (const opp of opps) {
        const row = buildRow(opp, strat.label, chain.id, chain.name);
        if (row === null) {
          console.warn(`skipping malformed zyfai opportunity in ${strat.id}/${chain.name}`);
          continue;
        }
        const key = `${chain.id}:${row.pool_address.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
      }
    }
  }

  if (ok === 0) throw new Error(`all zyfai endpoints failed: ${errors.join("; ")}`);

  if (rows.length === 0) {
    const prev = await store.doc<{ rows?: DefiRow[] }>("defi_pools");
    if (prev?.payload.rows?.length) {
      // all endpoints answered but with zero pools -- likely an API-side
      // outage; keep the last good rows and let the stale footer show it
      console.warn("zyfai returned zero pools everywhere; keeping previous doc");
      return "zyfai";
    }
  }

  const tierRank = new Map(defi.strategies.map((s, i) => [s.label, i]));
  rows.sort((a, b) => {
    const rank = (tierRank.get(a.tier) ?? 0) - (tierRank.get(b.tier) ?? 0);
    return rank !== 0 ? rank : b.apy - a.apy;
  });

  const today = new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    await store.upsertPoints(`defi:${row.chain_id}:${row.pool_address.toLowerCase()}`, [
      [today, row.apy],
    ]);
  }
  await store.putDoc("defi_pools", { rows }, "zyfai");
  return "zyfai";
}
