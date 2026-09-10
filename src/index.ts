/**
 * Worker entry point.
 *
 * `fetch` serves the JSON API and falls through to the static UI. Static assets
 * are matched first for paths that exist in ui/, so /api/* and /healthz reach
 * the Worker without needing run_worker_first.
 *
 * `scheduled` runs the cron-driven fetchers, dispatching on which expression
 * fired. The three daily jobs are Workflows with schedules attached to their
 * bindings, so they never reach this handler.
 *
 * `Env` is generated into worker-configuration.d.ts by `wrangler types`, and
 * extended with secrets in src/env.d.ts.
 */
import { createApi } from "./api";
import { getBytes, getText, postJson } from "./http";
import { runCronGroup } from "./jobs";
import { Store } from "./store";

export { CycleWorkflow, MacroHistoryWorkflow, RefsHistoryWorkflow } from "./workflows";

const api = createApi();

// Anything the API does not claim is a UI request.
api.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: api.fetch,

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // Awaited, not handed to waitUntil: runFetcher already records each job's
    // outcome to fetcher_status, and awaiting keeps the invocation alive for
    // the whole group rather than racing its own teardown.
    await runCronGroup(controller.cron, {
      store: new Store(env.DB),
      getText,
      getBytes,
      postJson,
      fredApiKey: env.FRED_API_KEY,
    });
  },
} satisfies ExportedHandler<Env>;
