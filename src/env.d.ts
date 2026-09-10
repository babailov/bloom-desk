// Secrets are not declared in wrangler.jsonc, so `wrangler types` cannot see
// them. Declare them here, on both the worker-facing `Env` and the
// `Cloudflare.Env` that `cloudflare:test` exposes to tests.
declare global {
  interface Env {
    FRED_API_KEY: string;
    /** Access team domain, e.g. "myteam.cloudflareaccess.com". */
    ACCESS_TEAM_DOMAIN?: string;
    /** Access application audience tag. */
    ACCESS_AUD?: string;
    /** Optional comma-separated email allow list, checked after Access. */
    ACCESS_ALLOWED_EMAILS?: string;
  }
  namespace Cloudflare {
    interface Env {
      FRED_API_KEY: string;
      ACCESS_TEAM_DOMAIN?: string;
      ACCESS_AUD?: string;
      ACCESS_ALLOWED_EMAILS?: string;
    }
  }
}

export {};
