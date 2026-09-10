/**
 * The three daily jobs that run as Workflows rather than plain cron.
 *
 * Why these three: they each make many upstream calls, and re-running the whole
 * list to recover one failure is waste. `step.do()` gives durable memoization
 * plus retries with backoff, so a failure at series 30 of 39 resumes at 30
 * instead of refetching the 29 that already succeeded. It also lifts the
 * 15-minute wall-clock ceiling that applies to a scheduled handler.
 *
 * Three rules hold throughout:
 *
 *   1. A step never returns a series or any other bulk payload. Step results
 *      are capped at 1 MiB, so each step writes to D1 and returns a small
 *      summary.
 *   2. Steps run sequentially. Workers cap simultaneous outgoing connections at
 *      six, and CONTRIBUTING.md forbids parallel hammering of upstreams.
 *   3. HTTP is injected, never imported into the run functions. That is the
 *      same seam register_jobs used in Python, and it is what lets these run
 *      offline against recorded fixtures.
 *
 * Schedules are attached to the Workflow bindings in wrangler.jsonc, so no
 * dispatcher Worker with a scheduled handler is involved.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { config } from "./config.data";
import { fetchCycleSeries } from "./fetchers/cycle";
import { fetchMacroSeries } from "./fetchers/fred";
import { fetchRefsHistory } from "./fetchers/refs-history";
import { getBytes, getText, type GetBytes, type GetText } from "./http";
import { rebuildDashboard, rebuildRecessions } from "./jobs";
import { Store } from "./store";

export interface WorkflowDeps {
  store: Store;
  getText: GetText;
  getBytes: GetBytes;
  fredApiKey: string;
}

/**
 * Retry policy for one upstream fetch. Three attempts over ~30s absorbs a blip;
 * beyond that the series is genuinely broken and should surface on /healthz
 * rather than being retried into the next scheduled run.
 */
export const FETCH_RETRIES = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

/** Summary a per-series step returns. Small on purpose: see rule 1 above. */
export interface SeriesResult {
  id: string;
  points?: number;
  error?: string;
}

/**
 * Record the run's outcome the way runner.py does, so /healthz reads the same
 * shape whether a job came from cron or from a Workflow.
 */
async function recordOutcome(
  store: Store,
  name: string,
  activeSource: string,
  results: readonly SeriesResult[],
): Promise<void> {
  const failed = results.filter((r) => r.error !== undefined);
  if (failed.length === 0) {
    await store.recordSuccess(name, activeSource);
    return;
  }
  const detail = failed.map((r) => `${r.id}: ${r.error}`).join("; ");
  await store.recordError(name, `${failed.length}/${results.length} failed: ${detail}`);
}

/** Shared shape of the two per-series workflows. */
async function runPerSeries<T extends { id: string }>(
  step: WorkflowStep,
  items: readonly T[],
  prefix: string,
  jobName: string,
  activeSource: string,
  store: Store,
  fetchOne: (item: T) => Promise<number>,
): Promise<{ series: number; failed: number }> {
  const results: SeriesResult[] = [];

  for (const item of items) {
    try {
      const points = await step.do(`${prefix}:${item.id}`, FETCH_RETRIES, async () =>
        fetchOne(item),
      );
      results.push({ id: item.id, points });
    } catch (exc) {
      // Retries are exhausted by here. Per-series isolation, as the Python has
      // it: a bad id degrades that series only.
      results.push({ id: item.id, error: String(exc) });
    }
  }

  await step.do("record-status", async () => {
    await recordOutcome(store, jobName, activeSource, results);
    return null;
  });

  await step.do("rebuild-dashboard", async () => {
    await rebuildDashboard(store);
    return null;
  });

  return { series: results.length, failed: results.filter((r) => r.error !== undefined).length };
}

export async function runCycle(step: WorkflowStep, deps: WorkflowDeps) {
  const out = await runPerSeries(
    step,
    config.cycle_series,
    "cycle",
    "cycle",
    "cycle",
    deps.store,
    (cfg) => fetchCycleSeries(cfg, deps.store, deps.fredApiKey, deps.getText, deps.getBytes),
  );

  // cycle:usrec only moves here, so the recession bands rebuild here too rather
  // than on every cron tick.
  await step.do("rebuild-recessions", async () => {
    await rebuildRecessions(deps.store);
    return null;
  });

  return out;
}

export function runMacroHistory(step: WorkflowStep, deps: WorkflowDeps) {
  return runPerSeries(step, config.series, "macro", "macro_history", "fred", deps.store, (cfg) =>
    fetchMacroSeries(cfg, deps.store, deps.fredApiKey, deps.getText),
  );
}

/**
 * refs_history is a single step, unlike the other two.
 *
 * It makes seven upstream calls across three source families and already
 * isolates them internally, raising only when every one fails. Splitting it
 * into steps would buy retry granularity it does not need, at the cost of
 * unpicking that isolation.
 */
export async function runRefsHistory(step: WorkflowStep, deps: WorkflowDeps) {
  const outcome = await step.do("refs-history", FETCH_RETRIES, async () => {
    try {
      return { source: await fetchRefsHistory(config.refs, deps.store, deps.getText), error: null };
    } catch (exc) {
      // Returned rather than thrown: a total failure is a real result to record
      // on /healthz, not something a retry will fix.
      return { source: null, error: String(exc) };
    }
  });

  await step.do("record-status", async () => {
    if (outcome.error === null) {
      await deps.store.recordSuccess("refs_history", outcome.source ?? "refs-history");
    } else {
      await deps.store.recordError("refs_history", outcome.error);
    }
    return null;
  });

  return outcome;
}

/** Real dependencies, used by the deployed Workflow classes. */
function liveDeps(env: Env): WorkflowDeps {
  return {
    store: new Store(env.DB),
    getText,
    getBytes,
    fredApiKey: env.FRED_API_KEY,
  };
}

export class CycleWorkflow extends WorkflowEntrypoint<Env> {
  override run(_event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<unknown> {
    return runCycle(step, liveDeps(this.env));
  }
}

export class MacroHistoryWorkflow extends WorkflowEntrypoint<Env> {
  override run(_event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<unknown> {
    return runMacroHistory(step, liveDeps(this.env));
  }
}

export class RefsHistoryWorkflow extends WorkflowEntrypoint<Env> {
  override run(_event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<unknown> {
    return runRefsHistory(step, liveDeps(this.env));
  }
}
