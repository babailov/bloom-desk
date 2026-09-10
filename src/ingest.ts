/**
 * The push path for data the Worker cannot fetch itself.
 *
 * ForexFactory rate-limits its calendar feed per client IP, and Cloudflare's
 * shared Workers egress address is permanently over that quota: the same URL
 * with the same User-Agent returns 200 from an ordinary host and 429 from a
 * Worker, every time, in every colo (issue #2). Nothing about our cadence
 * changes that, so the retrieval moves off Cloudflare -- a scheduled GitHub
 * Actions job fetches the feed and posts the body here, and the Worker does
 * everything else exactly as before.
 *
 * ## Why a shared secret rather than Access
 *
 * Cloudflare Access would be the obvious credential, and a service token is
 * what it offers machines. But Access now covers exactly `/enter` at the edge
 * (see gate.ts), so it never sees a request to an API path and never exchanges
 * a service token for the JWT that auth.ts verifies. Putting Access back in
 * front of this route means a second Access application with its own audience
 * tag, and a gate that accepts either one -- more moving parts, and more ways
 * to misconfigure the thing that protects the data, than a single bearer token
 * checked in one place.
 *
 * So: one secret, `MACRO_INGEST_TOKEN`, compared in constant time. It admits a
 * caller to this prefix and nothing else. It cannot read anything -- every
 * route under it is a POST that writes one doc pair -- and the data it carries
 * is a public calendar. **Fails closed**: with the secret unset there is no
 * value a caller could send that matches, so the route refuses everyone, the
 * same way the Access gate refuses everyone when it is unconfigured.
 */
import { Hono } from "hono";

import { config } from "./config.data";
import { ingestCalendar } from "./fetchers/macro";
import { rebuildDashboard } from "./jobs";
import { runFetcher } from "./runner";
import { Store } from "./store";

/**
 * Requests under this prefix are authenticated by the bearer token instead of
 * an Access JWT. It is an exact prefix test on an already-normalized pathname,
 * and every route below it is registered in this file.
 */
const INGEST_PREFIX = "/api/ingest/";

export function isIngestPath(pathname: string): boolean {
  return pathname.startsWith(INGEST_PREFIX);
}

/**
 * A ceiling on the body we will read. The real feed is ~11KB; a week with an
 * unusually crowded calendar is not going to be a hundred times that, and an
 * upstream that starts returning something enormous should be refused rather
 * than parsed.
 */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Compare without leaking where two strings first differ.
 *
 * The length check is not constant time and does not need to be: the length of
 * the expected secret is not the secret. Everything after it compares every
 * byte regardless of the first mismatch.
 */
function secretsMatch(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function bearerFrom(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (header === null) return null;
  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || rest.length === 0) return null;
  return rest.join(" ").trim() || null;
}

/** Is this request carrying the ingest credential? Fails closed when unset. */
export function ingestAuthorized(request: Request, env: Env): boolean {
  const expected = env.MACRO_INGEST_TOKEN;
  if (!expected) return false;
  const presented = bearerFrom(request);
  if (presented === null) return false;
  return secretsMatch(presented, expected);
}

export function createIngest() {
  const app = new Hono<{ Bindings: Env }>();

  /**
   * Take a ForexFactory calendar body and write the calendar and history docs.
   *
   * Wrapped in runFetcher so this path records `fetcher_status` under the same
   * name the cron fallback uses: /healthz keeps reporting one 'macro' fetcher,
   * whichever transport last moved it. Unlike the cron path, a failure here is
   * also returned to the caller, so the Actions run goes red rather than
   * failing silently into a table nobody is watching.
   */
  app.post("/api/ingest/macro", async (c) => {
    const declared = Number(c.req.header("Content-Length") ?? "0");
    if (declared > MAX_BODY_BYTES) {
      return c.json({ detail: "body too large" }, 413);
    }

    const body = await c.req.text();
    if (body.length > MAX_BODY_BYTES) {
      return c.json({ detail: "body too large" }, 413);
    }

    const store = new Store(c.env.DB);
    let failure: unknown = null;
    await runFetcher("macro", store, async () => {
      try {
        return await ingestCalendar(body, config.calendar_map, store);
      } catch (exc) {
        failure = exc;
        throw exc;
      }
    });

    if (failure !== null) {
      // 422, not 500: the body we were handed is the thing that was wrong.
      const detail = failure instanceof Error ? failure.message : String(failure);
      return c.json({ detail: `could not ingest calendar: ${detail}` }, 422);
    }

    // The dashboard doc is built by the job path, so a push that did not
    // rebuild it would sit invisible until the next cron tick. Cheap, and it
    // makes the panel current the moment this returns.
    await rebuildDashboard(store);

    const doc = await store.doc<{ releases?: unknown[] }>("macro_calendar");
    return c.json({ ok: true, releases: doc?.payload.releases?.length ?? 0 });
  });

  return app;
}
