// Secrets are not declared in wrangler.jsonc, so `wrangler types` cannot see
// them. Declare them here, on both the worker-facing `Env` and the
// `Cloudflare.Env` that `cloudflare:test` exposes to tests.
declare global {
  interface Env {
    FRED_API_KEY: string;
  }
  namespace Cloudflare {
    interface Env {
      FRED_API_KEY: string;
    }
  }
}

export {};
