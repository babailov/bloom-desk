/**
 * Worker entry point.
 *
 * `fetch` serves the API and the static UI (Phase 4 fills in the routes).
 * `scheduled` runs the cron-driven fetchers, dispatching on which expression
 * fired. The three daily jobs are Workflows with schedules attached to their
 * bindings, so they never reach this handler.
 *
 * `Env` is generated into worker-configuration.d.ts by `wrangler types`, and
 * extended with secrets in src/env.d.ts.
 */
import { runCronGroup } from "./jobs";
import { getBytes, getText, postJson } from "./http";
import { Store } from "./store";

export { CycleWorkflow, MacroHistoryWorkflow, RefsHistoryWorkflow } from "./workflows";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return env.ASSETS.fetch(request);
  },

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
