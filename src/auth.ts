/**
 * Cloudflare Access gate.
 *
 * Access covers one path at the edge, `/enter`, and signing in there sets the
 * CF_Authorization cookie for the whole hostname. Every other request arrives
 * here unfiltered, so this middleware is what stands between the data and the
 * internet: a request gets nothing until it carries a valid, signed, unexpired
 * Access JWT for this exact application.
 *
 * That was true before the front door existed too -- the verification never
 * relied on the edge -- but it used to be the second of two layers and is now
 * the only one. See gate.ts for why, and for how to undo it.
 *
 * **Fails closed.** With no team domain or audience configured there is no way
 * to verify anything, so every request is refused. That is deliberate: the
 * failure mode of a misconfigured gate must be "nobody gets in", never
 * "everybody gets in". It also means this is safe to deploy before the Access
 * application exists.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Context, Next } from "hono";

import { gateHtml, isPublicPath, type GateReason } from "./gate";

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
 * A refusal aimed at whoever asked.
 *
 * The status is the same either way -- what changes is the body. A browser
 * asking for a page gets the front door in gate.ts; anything under /api or
 * /healthz gets the JSON it was parsing before this page existed. Deciding on
 * the path rather than the Accept header keeps the two callers apart even when
 * the client sends no Accept at all, which is most non-browser clients.
 */
function refuse(
  c: Context<{ Bindings: Env; Variables: { identity: AccessIdentity } }>,
  path: string,
  cfg: AccessConfig,
  reason: GateReason,
  status: 401 | 403,
  detail: string,
) {
  if (path.startsWith("/api/") || path === "/healthz") return c.json({ detail }, status);
  return c.html(gateHtml({ reason, teamDomain: cfg.teamDomain }), status);
}

/**
 * Hono middleware. Refuses anything without a valid Access JWT.
 *
 * 503 rather than 403 when unconfigured, because "this gate is not set up yet"
 * is an operator problem, not a caller problem, and the two should not look
 * alike in logs. It stays JSON on every path: an operator reading a 503 is
 * reading logs, not admiring a sign-in page.
 */
export function requireAccess() {
  return async (c: Context<{ Bindings: Env; Variables: { identity: AccessIdentity } }>, next: Next) => {
    const cfg = readAccessConfig(c.env);
    if (cfg === null) {
      console.error("Access gate unconfigured: ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set");
      return c.json({ detail: "access gate not configured" }, 503);
    }

    // Checked after the configuration, never before: an unconfigured gate must
    // still refuse everything, artwork included.
    const path = new URL(c.req.url).pathname;
    if (isPublicPath(path)) return await next();

    const token = tokenFrom(c.req.raw);
    if (token === null) return refuse(c, path, cfg, "signed-out", 401, "missing Access token");

    try {
      c.set("identity", await verifyAccessJwt(token, cfg));
    } catch (exc) {
      console.warn(`Access token rejected: ${String(exc)}`);
      return refuse(c, path, cfg, "denied", 403, "invalid Access token");
    }

    await next();
  };
}
