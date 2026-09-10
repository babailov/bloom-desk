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

/**
 * A base env with the real Access settings stripped.
 *
 * wrangler.jsonc carries the live ACCESS_* vars, and vitest surfaces them on
 * `env`. Spreading that directly made these tests assert against deployment
 * config rather than their own fixtures: the "unconfigured" case silently
 * became configured, and the real allow list rejected the test identity.
 */
function baseEnv(): Env {
  const { ACCESS_TEAM_DOMAIN, ACCESS_AUD, ACCESS_ALLOWED_EMAILS, ...rest } = env;
  void ACCESS_TEAM_DOMAIN;
  void ACCESS_AUD;
  void ACCESS_ALLOWED_EMAILS;
  return rest as Env;
}

const configured = { ...baseEnv(), ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

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
      const resp = await call(path, {}, baseEnv());
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

  it("gates /enter too, so the front door cannot be walked through", async () => {
    // Access guards this path at the edge, but the edge is not what is trusted
    // here: without a token the Worker must refuse it like any other page.
    expect((await call("/enter")).status).toBe(401);
  });

  it("sends an authenticated visitor from /enter to the terminal", async () => {
    const resp = await call("/enter", { "Cf-Access-Jwt-Assertion": await token() });
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/");
  });
});

describe("the signed-out front door", () => {
  // The page exists so a browser sees os-bloom rather than Cloudflare's login
  // screen. What must not drift is which callers get it: a machine parsing
  // /api/* JSON should never start receiving HTML.
  it("answers a page request with the sign-in page, not JSON", async () => {
    const resp = await call("/");
    expect(resp.status).toBe(401);
    expect(resp.headers.get("Content-Type")).toMatch(/text\/html/);

    const body = await resp.text();
    expect(body).toContain("OS-BLOOM");
    expect(body).toContain('href="/enter"');
  });

  it("tells a rejected identity why, and offers a way back out", async () => {
    const resp = await call("/", { "Cf-Access-Jwt-Assertion": await token({ aud: "someone-elses-app" }) });
    expect(resp.status).toBe(403);

    const body = await resp.text();
    expect(body).toContain("NOT ADMITTED");
    expect(body).toContain(`${TEAM}/cdn-cgi/access/logout`);
  });

  it("keeps answering the API and healthz in JSON", async () => {
    for (const path of ["/api/dashboard", "/healthz"]) {
      const resp = await call(path);
      expect(resp.headers.get("Content-Type"), path).toMatch(/application\/json/);
      expect(await resp.json(), path).toEqual({ detail: "missing Access token" });
    }
  });

  it("serves its artwork without a token, and nothing else", async () => {
    // /gate/* is the one hole in the gate. It must stay exactly that wide: the
    // artwork through, and no path that merely mentions it.
    // 404 until the artwork is added, 200 once it is. What is asserted is the
    // only part that is this test's business: the gate did not refuse it.
    expect([401, 403]).not.toContain((await call("/gate/hero.jpg")).status);

    for (const path of ["/gate", "/index.html?x=/gate/", "/api/gate/hero.jpg"]) {
      expect((await call(path)).status, `${path} must stay gated`).toBe(401);
    }
  });

  it("stays JSON on every path while the gate is unconfigured", async () => {
    // An operator staring at a 503 is reading logs, not admiring a page -- and
    // an unconfigured gate must refuse the artwork too.
    for (const path of ["/", "/gate/hero.jpg", "/api/dashboard"]) {
      const resp = await call(path, {}, baseEnv());
      expect(resp.status, path).toBe(503);
      expect(resp.headers.get("Content-Type"), path).toMatch(/application\/json/);
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
    expect(readAccessConfig(baseEnv())).toBeNull();
    expect(readAccessConfig({ ...baseEnv(), ACCESS_TEAM_DOMAIN: TEAM })).toBeNull();
    expect(readAccessConfig({ ...baseEnv(), ACCESS_AUD: AUD })).toBeNull();
  });

  it("normalizes a bare team domain to an https origin", () => {
    const cfg = readAccessConfig({
      ...baseEnv(),
      ACCESS_TEAM_DOMAIN: "bloom.cloudflareaccess.com/",
      ACCESS_AUD: AUD,
    });
    expect(cfg?.teamDomain).toBe("https://bloom.cloudflareaccess.com");
  });
});
