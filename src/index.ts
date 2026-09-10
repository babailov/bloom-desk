/**
 * Worker entry point.
 *
 * `fetch` gates every request behind Cloudflare Access, then serves the JSON
 * API and falls through to the static UI.
 *
 * `scheduled` runs the cron-driven fetchers, dispatching on which expression
 * fired. The three daily jobs are Workflows with schedules attached to their
 * bindings, so they never reach this handler. Neither handler depends on a
 * route existing, which is why disabling the workers.dev route stops serving
 * without stopping collection.
 *
 * `Env` is generated into worker-configuration.d.ts by `wrangler types`, and
 * extended with secrets in src/env.d.ts.
 */
import { Hono } from "hono";

import { createApi } from "./api";
import { requireAccess } from "./auth";
import { getBytes, getText, postJson } from "./http";
import { runCronGroup } from "./jobs";
import { Store } from "./store";

export { CycleWorkflow, MacroHistoryWorkflow, RefsHistoryWorkflow } from "./workflows";

const app = new Hono<{ Bindings: Env }>();

// Order is load-bearing. Hono runs middleware in registration order, so the
// gate must be registered before anything it protects; registering it after the
// routes leaves them wide open. There is a test for exactly that.
app.use("*", requireAccess());

// The JSON API.
app.route("/", createApi());

// Anything the API does not claim is a UI request. Gated too: the terminal is
// the data.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,

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
