/**
 * Job wiring. Replaces collector/src/collector/scheduler.py.
 *
 * The Python original registered all 11 fetchers as APScheduler interval jobs.
 * Here they split by how expensive a failure is:
 *
 *   Cron Triggers (8) -- equity, news, defi, midnight, refs, morpho, bonds,
 *   macro. High frequency, idempotent, and they self-heal on the next tick
 *   minutes later, so per-step durability buys nothing and the step billing
 *   would be real: the 5-minute equity job alone is ~104k steps a month.
 *
 *   Workflows (3) -- cycle, macro_history, refs_history. Daily, many upstream
 *   calls each, and re-running the whole list to recover one series is waste.
 *   See src/workflows.ts.
 *
 * Cadences come from config.yaml unchanged; CRON_JOBS maps each expression to
 * the jobs whose cadence it represents. A test asserts the two against each
 * other, so a hand-edited expression that changes how often an upstream is hit
 * fails the suite rather than shipping.
 */
import { toBands } from "./changes";
import { config } from "./config.data";
import { fetchBonds } from "./fetchers/bonds";
import { fetchDefi } from "./fetchers/zyfai";
import { fetchEquity } from "./fetchers/equity";
import { fetchCalendarIfDue } from "./fetchers/macro";
import { fetchMidnight } from "./fetchers/midnight";
import { fetchMorpho } from "./fetchers/morpho";
import { fetchNews } from "./fetchers/news";
import { fetchRefs } from "./fetchers/refs";
import type { GetBytes, GetText, PostJson } from "./http";
import { DASHBOARD_DOC, RECESSIONS_DOC, buildDashboard } from "./panels";
import { runFetcher, type FetchFn } from "./runner";
import type { Store } from "./store";

export interface JobDeps {
  store: Store;
  getText: GetText;
  getBytes: GetBytes;
  postJson: PostJson;
  fredApiKey: string;
}

/**
 * Cron expression -> job names, matching the cadences in config.yaml:
 * 300s, 600s, 900s and 3600s. Cloudflare dispatches one invocation per matching
 * expression, so the :00 minute fires each of these separately rather than
 * collapsing them.
 */
export const CRON_JOBS: Record<string, readonly string[]> = {
  "*/5 * * * *": ["equity"],
  "*/10 * * * *": ["news"],
  "*/15 * * * *": ["defi", "midnight", "refs", "morpho"],
  "0 * * * *": ["bonds", "macro"],
};

/** The cadence, in seconds, that each cron expression stands for. */
export const CRON_SECONDS: Record<string, number> = {
  "*/5 * * * *": 300,
  "*/10 * * * *": 600,
  "*/15 * * * *": 900,
  "0 * * * *": 3600,
};

/** Every cron-driven fetcher, by name. */
export function cronJobs(deps: JobDeps): Record<string, FetchFn> {
  const { store, getText, getBytes, postJson, fredApiKey } = deps;
  void getBytes; // only the daily cycle job reads bytes; it runs as a Workflow

  return {
    equity: () => fetchEquity(config.indexes, store, getText),
    news: () => fetchNews(config.feeds, store, getText, config.max_news),
    defi: () => fetchDefi(config.defi, config.zyfai_base, store, getText),
    midnight: () => fetchMidnight(config.defi, config.midnight_base, store, getText),
    refs: () => fetchRefs(config.refs, store, getText, postJson),
    morpho: () => fetchMorpho(config.defi, store, postJson),
    bonds: () => fetchBonds(config.bonds, config.cb_rates, store, getText, fredApiKey),
    macro: () => fetchCalendarIfDue(config.calendar_url, config.calendar_map, store, getText),
  };
}

/**
 * Run every job attached to one cron expression, sequentially.
 *
 * Sequential on purpose. Workers cap simultaneous outgoing connections at six,
 * and CONTRIBUTING.md forbids parallel hammering of upstreams; the 15-minute
 * group is four jobs, each of which makes several calls of its own.
 *
 * runFetcher swallows failures into fetcher_status, so one dead upstream never
 * stops the rest of the group.
 */
export async function runCronGroup(cron: string, deps: JobDeps): Promise<string[]> {
  const names = CRON_JOBS[cron];
  if (names === undefined) {
    console.warn(`no jobs registered for cron ${cron}`);
    return [];
  }

  const jobs = cronJobs(deps);
  for (const name of names) {
    const fn = jobs[name];
    if (fn === undefined) {
      console.warn(`cron ${cron} names unknown job ${name}`);
      continue;
    }
    await runFetcher(name, deps.store, fn);
  }

  // Derived docs follow the data that just landed. Outside runFetcher on
  // purpose: a rebuild failure is a bug in our own code, not an upstream
  // outage, and should not be filed against a fetcher's health.
  await rebuildDashboard(deps.store);

  return [...names];
}

/**
 * Recompute the dashboard doc that /api/dashboard serves.
 *
 * The Python built this per request. Moving it here is the single biggest
 * latency and cost decision in the port: the request path now reads one row
 * instead of scanning every index and every cycle series.
 *
 * The cost lands here instead, on every cron group, because equity quotes move
 * every five minutes and the panel has to follow them. That is roughly 2% of
 * the included D1 read allowance. If it ever matters, the cycle panel is the
 * expensive half and only changes daily, so it could be cached separately.
 */
export async function rebuildDashboard(store: Store, now: Date = new Date()): Promise<void> {
  const payload = await buildDashboard(
    store,
    config.indexes,
    now,
    config.cycle_series,
    config.cycle_tabs,
  );
  await store.putDoc(DASHBOARD_DOC, payload, "dashboard");
}

/**
 * Recompute the NBER recession bands /api/recessions serves.
 *
 * Only the daily cycle job moves cycle:usrec, so this runs there rather than on
 * every cron tick.
 */
export async function rebuildRecessions(store: Store): Promise<void> {
  const bands = toBands(await store.points("cycle:usrec"));
  await store.putDoc(RECESSIONS_DOC, { bands }, "cycle");
}

/**
 * Every job name the port runs, cron and Workflow alike. Same set as the
 * Python scheduler registered.
 */
export const ALL_JOB_NAMES = [
  "equity",
  "bonds",
  "macro",
  "news",
  "macro_history",
  "defi",
  "midnight",
  "refs",
  "refs_history",
  "morpho",
  "cycle",
] as const;
