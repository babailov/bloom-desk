/**
 * Typed config. Port of collector/src/collector/config.py.
 *
 * config.yaml stays the single source of truth: `pnpm gen:config` reads it and
 * emits src/config.data.ts, which is what the Worker imports. Workers have no
 * filesystem and no reason to parse YAML at runtime, but keeping the YAML
 * authoritative preserves the property CONTRIBUTING.md leans on -- that adding
 * a series is a config edit, not a code change.
 *
 * Secrets come from the environment, never from YAML.
 */

export interface IndexCfg {
  symbol: string;
  name: string;
  yahoo?: string;
}

export interface BondCfg {
  country: string;
  tenor: string;
  fred?: string;
  bundesbank?: string;
  ecb?: string;
}

export interface CbRateCfg {
  country: string; // must match a bonds country so the matrix row lines up
  label: string;
  fred?: string;
}

export interface SeriesCfg {
  id: string;
  name: string;
  fred: string;
  unit: string;
  transform: string;
}

/** One market-cycle series; exactly one source field is set per entry. */
export interface CycleSeriesCfg {
  id: string;
  name: string;
  unit: string;
  transform?: string;
  hidden?: boolean; // fetched + chartable but never a panel row (usrec)
  valid_range?: [number, number]; // drop points outside [min, max] (corrupt feeds)
  fred?: string;
  dbnomics?: string; // "PROVIDER/dataset/series"
  oecd?: string; // "{flow}/{key}" under the OECD rest/data base
  cftc?: string; // CFTC contract market code
  cboe?: string; // exact ratio name in the CBOE daily JSON
  aaii?: string; // "bull_bear_spread"
  yahoo_ratio?: [string, string]; // [numerator, denominator] yahoo symbols
}

export interface CycleRowCfg {
  series: string;
  overlay?: string; // right-axis series on the click-through chart
}

export interface CyclePanelCfg {
  title: string;
  rows: CycleRowCfg[];
}

export interface CycleTabCfg {
  id: string;
  label: string;
  panels: CyclePanelCfg[];
}

export interface CalendarMapEntry {
  country: string;
  match: string;
  series: string;
}

export interface FeedCfg {
  name: string;
  url: string;
}

export interface StrategyCfg {
  id: string;
  label: string;
}

export interface ChainCfg {
  id: number;
  name: string;
  usdc: string; // USDC token address on this chain, lowercase
}

export interface DefiCfg {
  asset: string;
  strategies: StrategyCfg[]; // config order == dedupe priority (most conservative first)
  chains: ChainCfg[];
  midnight_chains: number[]; // subset of chain ids that have Midnight deployments
  token_symbols: Record<string, string>; // lowercase collateral address -> display symbol
  morpho_graphql: string;
  morpho_first: number;
}

export interface AaveRefCfg {
  chain: string; // display abbr (BASE/ETH/ARB); also the id token, so keep it stable
  rpc: string;
  pool: string; // lowercase
  asset: string; // lowercase
  symbol: string; // asset display symbol (USDC/USDT); also the id token
}

/**
 * Derived, not configured: the BASE/USDC ids resolve to the original
 * aave-base-usdc-* series, preserving their accumulated history.
 */
export const aaveSupplyId = (c: AaveRefCfg): string =>
  `aave-${c.chain.toLowerCase()}-${c.symbol.toLowerCase()}-supply`;
export const aaveBorrowId = (c: AaveRefCfg): string =>
  `aave-${c.chain.toLowerCase()}-${c.symbol.toLowerCase()}-borrow`;
export const aaveSupplyLabel = (c: AaveRefCfg): string => `AAVE ${c.symbol} ${c.chain} SUP`;
export const aaveBorrowLabel = (c: AaveRefCfg): string => `AAVE ${c.symbol} ${c.chain} BOR`;

export interface LlamaChartCfg {
  pool: string;
  series: string;
}

export interface PendleRefCfg {
  chain_id: number;
  address: string; // lowercase
  implied_id: string;
  implied_label: string;
  underlying_id: string;
  underlying_label: string;
}

export interface FundingRefCfg {
  symbol: string;
  id: string;
  label: string;
}

export interface RefsCfg {
  aave: AaveRefCfg[];
  llama_chart: LlamaChartCfg[];
  pendle: PendleRefCfg[];
  funding: FundingRefCfg[];
}

export interface Config {
  calendar_url: string;
  max_news: number;
  cadences: Record<string, number>;
  indexes: IndexCfg[];
  bonds: BondCfg[];
  cb_rates: CbRateCfg[];
  series: SeriesCfg[];
  cycle_series: CycleSeriesCfg[];
  cycle_tabs: CycleTabCfg[];
  calendar_map: CalendarMapEntry[];
  feeds: FeedCfg[];
  zyfai_base: string;
  midnight_base: string;
  defi: DefiCfg;
  refs: RefsCfg;
}
