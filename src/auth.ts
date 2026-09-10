/**
 * Cloudflare Access gate.
 *
 * Access sits in front of the hostname and only forwards requests it has
 * already authenticated. This verifies that independently, in the Worker, so
 * the data is not protected by routing alone: if the Access application is
 * removed, misconfigured, or the Worker is reached by some path that bypasses
 * it, requests still have to carry a valid, signed, unexpired Access JWT for
 * this exact application.
 *
 * **Fails closed.** With no team domain or audience configured there is no way
 * to verify anything, so every request is refused. That is deliberate: the
 * failure mode of a misconfigured gate must be "nobody gets in", never
 * "everybody gets in". It also means this is safe to deploy before the Access
 * application exists.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Context, Next } from "hono";

/** Access puts the token in this header, and in this cookie for browsers. */
const JWT_HEADER = "Cf-Access-Jwt-Assertion";
const JWT_COOKIE = "CF_Authorization";

export interface AccessIdentity {
  email?: string;
  sub?: string;
}

/**
 * JWKS fetches are cached per team domain for the isolate's lifetime. jose
 * handles the cache-control and rotation semantics; this map only avoids
 * rebuilding the fetcher on every request.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(teamDomain);
  if (jwks === undefined) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

function tokenFrom(request: Request): string | null {
  const header = request.headers.get(JWT_HEADER);
  if (header) return header;

  // Cookie parsing is deliberately strict: split on "; " and match the exact
  // name, so a cookie merely ending in CF_Authorization cannot be substituted.
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === JWT_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Normalize a team domain to an https origin with no trailing slash. */
function normalizeTeamDomain(raw: string): string {
  const withScheme = raw.startsWith("http") ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

export interface AccessConfig {
  teamDomain: string;
  aud: string;
  /** Optional extra check: only these emails, even if Access let them through. */
  allowedEmails?: string[];
}

export function readAccessConfig(env: Env): AccessConfig | null {
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  if (!teamDomain || !aud) return null;

  const allowed = (env.ACCESS_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "");

  return {
    teamDomain: normalizeTeamDomain(teamDomain),
    aud,
    allowedEmails: allowed.length > 0 ? allowed : undefined,
  };
}

/** Verify an Access JWT. Returns the identity, or throws with a reason. */
export async function verifyAccessJwt(
  token: string,
  cfg: AccessConfig,
): Promise<AccessIdentity> {
  const { payload }: { payload: JWTPayload } = await jwtVerify(token, jwksFor(cfg.teamDomain), {
    issuer: cfg.teamDomain,
    audience: cfg.aud,
    // jose enforces exp and nbf; Access tokens always carry exp.
  });

  const email = typeof payload["email"] === "string" ? payload["email"].toLowerCase() : undefined;

  if (cfg.allowedEmails && (email === undefined || !cfg.allowedEmails.includes(email))) {
    throw new Error(`identity ${email ?? "<no email>"} is not on the allow list`);
  }

  return { email, sub: payload.sub };
}

/**
 * Hono middleware. Refuses anything without a valid Access JWT.
 *
 * 503 rather than 403 when unconfigured, because "this gate is not set up yet"
 * is an operator problem, not a caller problem, and the two should not look
 * alike in logs.
 */
export function requireAccess() {
  return async (c: Context<{ Bindings: Env; Variables: { identity: AccessIdentity } }>, next: Next) => {
    const cfg = readAccessConfig(c.env);
    if (cfg === null) {
      console.error("Access gate unconfigured: ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set");
      return c.json({ detail: "access gate not configured" }, 503);
    }

    const token = tokenFrom(c.req.raw);
    if (token === null) return c.json({ detail: "missing Access token" }, 401);

    try {
      c.set("identity", await verifyAccessJwt(token, cfg));
    } catch (exc) {
      console.warn(`Access token rejected: ${String(exc)}`);
      return c.json({ detail: "invalid Access token" }, 403);
    }

    await next();
  };
}
