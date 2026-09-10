/**
 * Full-history backfill for the RATE REFS panel (daily job).
 * Port of collector/src/collector/fetchers/refs_history.py.
 *
 * Mirrors the macro / macro_history split: this is the 'refs_history' half of
 * the live 'refs' fetcher. Upserts into the same 'ref:{id}' series so the chart
 * overlay and the panel's bp-change math work unchanged for both live and
 * backfilled points. Idempotent; each source degrades independently; total
 * failure raises.
 *
 * Aave borrow has no free backfill source (DefiLlama's borrow-APY endpoints
 * started returning HTTP 402 on 2026-07-22). It simply accumulates from the
 * daily point fetchRefs records each run.
 */
import { parseDicts } from "../csv";
import type { FundingRefCfg, LlamaChartCfg, PendleRefCfg, RefsCfg } from "../config";
import type { GetText } from "../http";
import type { Point, Store } from "../store";

const LLAMA_CHART_BASE = "https://yields.llama.fi/chart";
const PENDLE_APY_HISTORY_BASE = "https://api-v2.pendle.finance/core/v2";
const FUNDING_RATE_URL = "https://fapi.binance.com/fapi/v1/fundingRate";
const FUNDING_PAGE_LIMIT = 1000;
const FUNDING_MAX_PAGES = 20;

/**
 * Parse a DefiLlama `/chart/{pool}` response into daily (date, apyBase) points.
 *
 * Entries with a null apyBase (no data that day) are skipped; a malformed
 * individual point is skipped rather than failing the whole series.
 */
export function parseLlamaChart(text: string): Point[] {
  const body: unknown = JSON.parse(text);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("llama chart payload is not a JSON object");
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error("llama chart payload has no data list");

  const out: Point[] = [];
  for (const pt of data as Record<string, unknown>[]) {
    const apyBase = pt?.["apyBase"];
    if (apyBase === null || apyBase === undefined) continue;

    const ts = pt["timestamp"];
    if (typeof ts !== "string") continue;
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) continue;

    const value = Number(apyBase);
    if (!Number.isFinite(value)) continue;

    out.push([new Date(ms).toISOString().slice(0, 10), value]);
  }
  return out;
}

async function fetchLlamaPoints(entry: LlamaChartCfg, getText: GetText): Promise<Point[]> {
  return parseLlamaChart(await getText(`${LLAMA_CHART_BASE}/${entry.pool}`));
}

/**
 * Parse a Pendle `apy-history` response: `results` is a CSV STRING with header
 * `timestamp,underlyingApy,impliedApy`. Values are fractions (0.0447 -> 4.47%);
 * a malformed row is skipped rather than failing the whole series.
 */
export function parsePendleApyHistory(text: string): { implied: Point[]; underlying: Point[] } {
  const body: unknown = JSON.parse(text);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("pendle apy-history payload is not a JSON object");
  }
  const results = (body as { results?: unknown }).results;
  if (typeof results !== "string") {
    throw new Error("pendle apy-history payload missing results CSV");
  }

  const implied: Point[] = [];
  const underlying: Point[] = [];
  for (const row of parseDicts(results)) {
    const ts = Number(row["timestamp"]);
    const impliedApy = Number(row["impliedApy"]);
    const underlyingApy = Number(row["underlyingApy"]);
    if (!Number.isFinite(ts) || !Number.isFinite(impliedApy) || !Number.isFinite(underlyingApy)) {
      continue;
    }
    const d = new Date(ts * 1000).toISOString().slice(0, 10);
    implied.push([d, impliedApy * 100]);
    underlying.push([d, underlyingApy * 100]);
  }
  return { implied, underlying };
}

async function fetchPendleHistory(
  entry: PendleRefCfg,
  getText: GetText,
): Promise<{ implied: Point[]; underlying: Point[] }> {
  const url = `${PENDLE_APY_HISTORY_BASE}/${entry.chain_id}/markets/${entry.address}/apy-history`;
  return parsePendleApyHistory(await getText(url, { time_frame: "day" }));
}

/**
 * Group raw 8h Binance funding rates by UTC date and annualize the daily mean:
 * Binance settles 3x/day, so mean(rate) * 3 * 365 * 100. A malformed row is
 * skipped rather than failing the whole batch.
 */
export function dailyMeanAnnualized(rows: readonly Record<string, unknown>[]): Point[] {
  const byDay = new Map<string, number[]>();

  for (const row of rows) {
    const ms = Number(row?.["fundingTime"]);
    const rate = Number(row?.["fundingRate"]);
    if (!Number.isFinite(ms) || !Number.isFinite(rate)) continue;

    const d = new Date(ms).toISOString().slice(0, 10);
    const bucket = byDay.get(d);
    if (bucket) bucket.push(rate);
    else byDay.set(d, [rate]);
  }

  return [...byDay.entries()].map(([d, rates]) => [
    d,
    (rates.reduce((a, b) => a + b, 0) / rates.length) * 3 * 365 * 100,
  ]);
}

/**
 * Paginate `fundingRate` by `startTime` until a short or empty page ends the
 * series, hard-capped at FUNDING_MAX_PAGES pages.
 */
async function fetchFundingHistory(entry: FundingRefCfg, getText: GetText): Promise<Point[]> {
  const allRows: Record<string, unknown>[] = [];
  let startTime = 0;

  for (let page = 0; page < FUNDING_MAX_PAGES; page++) {
    const body: unknown = JSON.parse(
      await getText(FUNDING_RATE_URL, {
        symbol: entry.symbol,
        limit: String(FUNDING_PAGE_LIMIT),
        startTime: String(startTime),
      }),
    );
    if (!Array.isArray(body)) throw new Error("binance fundingRate payload is not a JSON array");
    if (body.length === 0) break;

    allRows.push(...(body as Record<string, unknown>[]));
    if (body.length < FUNDING_PAGE_LIMIT) break;

    startTime = Number(body[body.length - 1]["fundingTime"]) + 1;
  }

  return dailyMeanAnnualized(allRows);
}

export async function fetchRefsHistory(
  refs: RefsCfg,
  store: Store,
  getText: GetText,
): Promise<string> {
  let ok = 0;
  const errors: string[] = [];

  for (const entry of refs.llama_chart) {
    try {
      await store.upsertPoints(`ref:${entry.series}`, await fetchLlamaPoints(entry, getText));
      ok++;
    } catch (exc) {
      // per-source isolation
      console.warn(`refs_history llama ${entry.pool} failed: ${String(exc)}`);
      errors.push(`llama ${entry.pool}: ${String(exc)}`);
    }
  }

  for (const entry of refs.pendle) {
    try {
      const history = await fetchPendleHistory(entry, getText);
      await store.upsertPoints(`ref:${entry.implied_id}`, history.implied);
      await store.upsertPoints(`ref:${entry.underlying_id}`, history.underlying);
      ok++;
    } catch (exc) {
      console.warn(`refs_history pendle ${entry.address} failed: ${String(exc)}`);
      errors.push(`pendle ${entry.address}: ${String(exc)}`);
    }
  }

  for (const entry of refs.funding) {
    try {
      await store.upsertPoints(`ref:${entry.id}`, await fetchFundingHistory(entry, getText));
      ok++;
    } catch (exc) {
      console.warn(`refs_history funding ${entry.symbol} failed: ${String(exc)}`);
      errors.push(`funding ${entry.symbol}: ${String(exc)}`);
    }
  }

  if (ok === 0) throw new Error(`all refs-history sources failed: ${errors.join("; ")}`);
  return "refs-history";
}
