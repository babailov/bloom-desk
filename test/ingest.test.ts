import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { DASHBOARD_DOC } from "../src/panels";
import { Store } from "../src/store";
import type { Release } from "../src/fetchers/macro";

// The push path that replaced the Worker's own calendar fetch (issue #2). These
// go through the real worker entry point, because half of what is being tested
// is that the Access gate lets this prefix through on a bearer token and
// nothing else -- which is a property of the middleware order, not of the
// route.

const TOKEN = "s3cret-ingest-token";
const store = () => new Store(env.DB);

/**
 * A ForexFactory body for the week around now.
 *
 * The shared fixture is dated July 2026 and history prunes at 30 days, so it
 * would arrive already expired: these tests are about the transport, and want a
 * body that behaves the way a real one does on the day it is posted. Filtering
 * and series mapping are the fetcher's own tests, in macro-cycle.test.ts.
 */
function calendarBody(now: Date = new Date()): string {
  const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();
  return JSON.stringify([
    { title: "Core CPI m/m", country: "USD", date: at(-2), impact: "High", forecast: "0.3%", previous: "0.2%", actual: "0.4%" },
    { title: "CPI y/y", country: "USD", date: at(-1), impact: "High", forecast: "2.3%", previous: "2.4%", actual: "2.3%" },
    { title: "Main Refinancing Rate", country: "EUR", date: at(2), impact: "High", forecast: "2.65%", previous: "2.40%" },
    { title: "French Trade Balance", country: "EUR", date: at(-3), impact: "Low", previous: "-7.6B" },
    { title: "BOJ Policy Rate", country: "JPY", date: at(1), impact: "High", previous: "0.75%" },
  ]);
}

const FF_JSON = calendarBody();

/** The live ACCESS_* vars are irrelevant here; the ingest prefix never sees them. */
function ingestEnv(over: Partial<Env> = {}): Env {
  return { ...env, MACRO_INGEST_TOKEN: TOKEN, ...over } as Env;
}

function post(
  body: string,
  headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` },
  e: Env = ingestEnv(),
) {
  return worker.fetch!(
    new Request("https://bloom.babailov.dev/api/ingest/macro", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    }),
    e,
    {} as ExecutionContext,
  );
}

async function releases(key: string): Promise<Release[]> {
  const doc = await store().doc<{ releases: Release[] }>(key);
  return doc?.payload.releases ?? [];
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM series_points"),
    env.DB.prepare("DELETE FROM docs"),
    env.DB.prepare("DELETE FROM fetcher_status"),
  ]);
});

describe("the ingest credential", () => {
  it("refuses a request with no Authorization header", async () => {
    const resp = await post(FF_JSON, {});
    expect(resp.status).toBe(403);
    expect(await releases("macro_calendar")).toEqual([]);
  });

  it("refuses a wrong token", async () => {
    const resp = await post(FF_JSON, { Authorization: "Bearer not-the-token" });
    expect(resp.status).toBe(403);
  });

  it("refuses a token of the right length but the wrong bytes", async () => {
    // The constant-time compare returns on length first; this is the case that
    // actually exercises the byte loop.
    const wrong = `${"x".repeat(TOKEN.length - 1)}y`;
    expect(wrong.length).toBe(TOKEN.length);
    expect((await post(FF_JSON, { Authorization: `Bearer ${wrong}` })).status).toBe(403);
  });

  it("refuses another scheme carrying the right secret", async () => {
    expect((await post(FF_JSON, { Authorization: `Basic ${TOKEN}` })).status).toBe(403);
  });

  it("fails closed when no ingest token is configured", async () => {
    // Not "anyone may post": with nothing to compare against there is no value
    // a caller could send that matches, including no value at all.
    const unset = { ...env, MACRO_INGEST_TOKEN: undefined } as Env;
    expect((await post(FF_JSON, { Authorization: `Bearer ${TOKEN}` }, unset)).status).toBe(403);
    expect((await post(FF_JSON, {}, unset)).status).toBe(403);
  });

  it("does not admit an Access identity, only the bearer token", async () => {
    // A signed-in browser has a valid Access JWT for everything else. It is
    // still not what authenticates this route.
    const resp = await post(FF_JSON, { "Cf-Access-Jwt-Assertion": "irrelevant" });
    expect(resp.status).toBe(403);
  });

  it("buys access to the ingest prefix and nothing else", async () => {
    const resp = await worker.fetch!(
      new Request("https://bloom.babailov.dev/api/dashboard", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      ingestEnv(),
      {} as ExecutionContext,
    );
    // Refused by the Access gate, which is the only thing that guards /api/*.
    expect(resp.status).toBe(401);
  });
});

describe("posting a calendar", () => {
  it("writes the calendar and the history from the posted body", async () => {
    const resp = await post(FF_JSON);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, releases: 3 });

    const cal = await releases("macro_calendar");
    // The same filter the cron path applies: USD/EUR, High impact only.
    expect(cal.map((r) => r.name)).toEqual(["Core CPI m/m", "CPI y/y", "Main Refinancing Rate"]);
    expect(cal[0]!.series_id).toBe("us-core-cpi-yoy");

    // History is seeded by the same write, which is what fills the panel's
    // past-7-days section: ForexFactory only ever serves the current week.
    expect((await releases("macro_history")).length).toBe(3);
  });

  it("records the run under the same fetcher name the cron fallback uses", async () => {
    await post(FF_JSON);
    const status = await store().status("macro");
    expect(status?.active_source).toBe("forexfactory");
    expect(status?.last_success).not.toBeNull();
    expect(status?.last_error_at).toBeNull();
  });

  it("rebuilds the dashboard, so the panel is current when this returns", async () => {
    await post(FF_JSON);
    const doc = await store().doc<{ panels: Record<string, unknown> }>(DASHBOARD_DOC);
    expect(doc).not.toBeNull();

    // Split the way the panel splits it: two events are behind us, one ahead.
    const macro = doc!.payload.panels["macro"] as { past: unknown[]; releases: unknown[] };
    expect(macro.past).toHaveLength(2);
    expect(macro.releases).toHaveLength(1);
  });

  it("refuses a body that is not the calendar, and says so", async () => {
    // The failure this exists for: ForexFactory answers a blocked caller with
    // an HTML rate-limit page. Reading that as zero releases would blank the
    // panel and record a success.
    const resp = await post("<!DOCTYPE html><html>rate limited</html>");
    expect(resp.status).toBe(422);
    expect(await releases("macro_calendar")).toEqual([]);

    const status = await store().status("macro");
    expect(status?.last_error_at).not.toBeNull();
    expect(status?.last_success).toBeNull();
  });

  it("refuses a body over the size ceiling on its declared length alone", async () => {
    const resp = await post(FF_JSON, {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Length": "999999999",
    });
    expect(resp.status).toBe(413);
  });

  it("is idempotent: posting the same week twice leaves one copy of each row", async () => {
    await post(FF_JSON);
    await post(FF_JSON);
    expect((await releases("macro_calendar")).length).toBe(3);
    expect((await releases("macro_history")).length).toBe(3);
  });
});
