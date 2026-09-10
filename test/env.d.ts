import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// TEST_MIGRATIONS is injected by the test pool, not by wrangler, so it is not
// in the generated Cloudflare.Env.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
