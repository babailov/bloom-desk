import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";

import WRANGLER_JSONC from "../wrangler.jsonc?raw";
import worker from "../src/index";
import { readAccessConfig, verifyAccessJwt } from "../src/auth";

// The gate is the only thing standing between this data and the internet, so
// these tests exercise the real middleware through the real worker entry point
// rather than the middleware in isolation. The route-ordering test in
// particular exists because Hono runs middleware in registration order: an
// earlier version registered the gate after the routes, which left every one of
// them open.

const TEAM = "https://bloom.cloudflareaccess.com";
const AUD = "test-audience-tag";
const EMAIL = "owner@example.com";

let privateKey: CryptoKey;
let publicJwk: JWK;

/** A JWKS endpoint standing in for the team's, so no network is needed. */
function stubJwks(jwk: JWK): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(`${TEAM}/cdn-cgi/access/certs`)) {
      return Response.json({ keys: [jwk] });
    }
    return original(input as RequestInfo, init);
  }) as typeof fetch;
}

async function token(over: {
  aud?: string;
  iss?: string;
  email?: string;
  expiresIn?: string;
} = {}): Promise<string> {
  return new SignJWT({ email: over.email ?? EMAIL })
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
    .setIssuedAt()
    .setIssuer(over.iss ?? TEAM)
    .setAudience(over.aud ?? AUD)
    .setExpirationTime(over.expiresIn ?? "1h")
    .setSubject("user-123")
    .sign(privateKey);
}

const configured = { ...env, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

function call(path: string, headers: Record<string, string> = {}, e: unknown = configured) {
  return worker.fetch!(
    new Request(`https://bloom.babailov.dev${path}`, { headers }),
    e as Env,
    {} as ExecutionContext,
  );
}

// Once, not per test. jose caches a remote JWKS per team domain and only
// refetches on an unknown kid, so minting a fresh key under the same kid each
// test would verify against the stale one. Real rotation changes the kid.
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  stubJwks(publicJwk);
});

describe("fails closed", () => {
  it("refuses every route when the gate is unconfigured", async () => {
    // Unconfigured must mean nobody gets in, never everybody.
    for (const path of ["/", "/healthz", "/api/dashboard", "/api/series/SPX"]) {
      const resp = await call(path, {}, { ...env });
      expect(resp.status, path).toBe(503);
    }
  });

  it("refuses a request with no token", async () => {
    expect((await call("/api/dashboard")).status).toBe(401);
  });

  it("refuses a malformed token", async () => {
    expect((await call("/api/dashboard", { "Cf-Access-Jwt-Assertion": "not.a.jwt" })).status).toBe(403);
  });
});

describe("static assets cannot outrun the gate", () => {
  // Static assets are matched before the Worker unless run_worker_first is set,
  // so / and /index.html were served unauthenticated in production while
  // /api/* was correctly refused. Found by curling the deployment.
  //
  // This asserts the config, not the behaviour, and that is a deliberate
  // limit: an earlier version of this test drove SELF.fetch and passed just as
  // happily with run_worker_first turned off, because miniflare does not
  // emulate asset-first routing. A test that cannot fail is worse than no test,
  // so what is checked here is the one thing that can regress in this repo --
  // the setting itself. The routing semantics are verified by curling the
  // deployment after every config change.
  it("keeps run_worker_first on, so the Worker sees every request", () => {
    const cfg = JSON.parse(
      WRANGLER_JSONC.replace(/^\s*\/\/.*$/gm, ""), // strip line comments
    ) as { assets?: { run_worker_first?: boolean } };

    expect(cfg.assets?.run_worker_first).toBe(true);
  });
});

describe("route coverage", () => {
  it("gates the API, healthz and the static UI alike", async () => {
    // Regression: the gate used to be registered after the routes, so none of
    // these were protected. Every path must refuse an unauthenticated caller.
    for (const path of ["/", "/index.html", "/healthz", "/api/dashboard", "/api/recessions"]) {
      const resp = await call(path);
      expect(resp.status, `${path} should be gated`).toBe(401);
    }
  });
});

describe("token validation", () => {
  const cfg = { teamDomain: TEAM, aud: AUD };

  it("accepts a well-formed token and passes the request through", async () => {
    const resp = await call("/api/recessions", { "Cf-Access-Jwt-Assertion": await token() });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ bands: [] });
  });

  it("accepts the token from the CF_Authorization cookie", async () => {
    const resp = await call("/api/recessions", { Cookie: `CF_Authorization=${await token()}` });
    expect(resp.status).toBe(200);
  });

  it("is not fooled by a cookie whose name merely ends in CF_Authorization", async () => {
    const resp = await call("/api/recessions", { Cookie: `NOT_CF_Authorization=${await token()}` });
    expect(resp.status).toBe(401);
  });

  it("rejects a token for a different application", async () => {
    await expect(verifyAccessJwt(await token({ aud: "someone-elses-app" }), cfg)).rejects.toThrow();
    expect((await call("/api/dashboard", {
      "Cf-Access-Jwt-Assertion": await token({ aud: "someone-elses-app" }),
    })).status).toBe(403);
  });

  it("rejects a token from a different team", async () => {
    expect((await call("/api/dashboard", {
      "Cf-Access-Jwt-Assertion": await token({ iss: "https://evil.cloudflareaccess.com" }),
    })).status).toBe(403);
  });

  it("rejects an expired token", async () => {
    expect((await call("/api/dashboard", {
      "Cf-Access-Jwt-Assertion": await token({ expiresIn: "-1h" }),
    })).status).toBe(403);
  });

  it("rejects a token signed by an unknown key", async () => {
    const other = await generateKeyPair("RS256", { extractable: true });
    const forged = await new SignJWT({ email: EMAIL })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuedAt()
      .setIssuer(TEAM)
      .setAudience(AUD)
      .setExpirationTime("1h")
      .sign(other.privateKey);

    expect((await call("/api/dashboard", { "Cf-Access-Jwt-Assertion": forged })).status).toBe(403);
  });
});

describe("email allow list", () => {
  it("refuses an identity Access let through but the list does not name", async () => {
    const e = { ...configured, ACCESS_ALLOWED_EMAILS: "someone@else.com" };
    expect((await call("/api/dashboard", { "Cf-Access-Jwt-Assertion": await token() }, e)).status).toBe(403);
  });

  it("admits a listed identity, case-insensitively", async () => {
    const e = { ...configured, ACCESS_ALLOWED_EMAILS: " OWNER@example.com , other@x.com " };
    expect((await call("/api/recessions", { "Cf-Access-Jwt-Assertion": await token() }, e)).status).toBe(200);
  });
});

describe("readAccessConfig", () => {
  it("returns null unless both team domain and audience are set", () => {
    expect(readAccessConfig({ ...env } as Env)).toBeNull();
    expect(readAccessConfig({ ...env, ACCESS_TEAM_DOMAIN: TEAM } as Env)).toBeNull();
    expect(readAccessConfig({ ...env, ACCESS_AUD: AUD } as Env)).toBeNull();
  });

  it("normalizes a bare team domain to an https origin", () => {
    const cfg = readAccessConfig({
      ...env,
      ACCESS_TEAM_DOMAIN: "bloom.cloudflareaccess.com/",
      ACCESS_AUD: AUD,
    } as Env);
    expect(cfg?.teamDomain).toBe("https://bloom.cloudflareaccess.com");
  });
});
