/**
 * Worker entry point. Fleshed out in Phase 4 (API) and Phase 3 (scheduling);
 * for now it exists so the wrangler config resolves.
 *
 * `Env` is generated into worker-configuration.d.ts by `wrangler types`, and
 * extended with secrets in src/env.d.ts.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
