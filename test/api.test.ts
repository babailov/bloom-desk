import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createApi } from "../src/api";
import { rebuildDashboard, rebuildRecessions } from "../src/jobs";
import { Store, type Point } from "../src/store";

// Ports collector/tests/test_api.py.
//
// One test does not port: test_cors_header_present. The permissive CORS
// middleware is deliberately gone, because the UI is same-origin here and an
// open policy behind Cloudflare Access would be a hole.

const app = createApi();
const store = () => new Store(env.DB);

async function get(path: string): Promise<Response> {
  return app.fetch(new Request(`https://bloom.test${path}`), env);
}

async function json<T = Record<string, never>>(path: string): Promise<T> {
  return (await get(path)).json() as Promise<T>;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM series_points"),
    env.DB.prepare("DELETE FROM docs"),
    env.DB.prepare("DELETE FROM fetcher_status"),
  ]);
});

interface Dashboard {
  as_of: string;
  panels: Record<string, Record<string, unknown>>;
}

describe("/api/dashboard", () => {
  it("returns the full panel shape on an empty store", async () => {
    const body = await json<Dashboard>("/api/dashboard");
    expect(new Set(Object.keys(body.panels))).toEqual(
      new Set(["macro", "equity", "bonds", "news", "defi", "midnight", "morpho", "refs", "cycle"]),
    );
    const cycle = body.panels["cycle"] as { tabs: { id: string }[] };
    expect(cycle.tabs.map((t) => t.id)).toEqual(["risk", "econ", "credit", "profit", "pos"]);
  });

  it("serves the precomputed doc once a job has written one", async () => {
    await rebuildDashboard(store(), new Date("2026-07-08T12:00:00Z"));

    const body = await json<Dashboard>("/api/dashboard");
    expect(body.as_of).toBe("2026-07-08T12:00:00.000Z");
    expect(Object.keys(body.panels)).toHaveLength(9);
  });

  it("does not 500 on a corrupted doc", async () => {
    await env.DB.prepare("INSERT INTO docs(key, payload, updated_at, source) VALUES(?,?,?,?)")
      .bind("news", "{not json", "2026-07-08T00:00:00Z", "rss")
      .run();

    const resp = await get("/api/dashboard");
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Dashboard;
    expect((body.panels["news"] as { items: unknown[] }).items).toEqual([]);
  });
});

describe("/api/series", () => {
  interface SeriesBody {
    id: string;
    name: string;
    unit: string;
    points: Point[];
  }

  it("applies the transform and the range window", async () => {
    await store().upsertPoints("macro:us-cpi-yoy", [
      ["2010-06-01", 80.0],
      ["2025-06-01", 100.0],
      ["2026-06-01", 103.0],
    ]);

    const body = await json<SeriesBody>("/api/series/us-cpi-yoy?range=5y");
    expect(body.id).toBe("us-cpi-yoy");
    expect(body.unit).toBe("%");
    expect(body.points).toEqual([["2026-06-01", 3.0]]); // yoy transform, 5y window

    // yoy needs a prior-year point; 2010 has none
    const max = await json<SeriesBody>("/api/series/us-cpi-yoy?range=max");
    expect(max.points).toHaveLength(1);
  });

  it("keeps enough history for the transform when a range is given", async () => {
    // A point inside a 1y window whose yoy reference sits outside it. Filtering
    // the read to the window before transforming would silently drop the first
    // year of every yoy series.
    //
    // Dates are derived from today so this holds year-round; day 15 keeps the
    // yoy lookup off Feb 29, which has no prior-year counterpart.
    const p = new Date(Date.now() - 60 * 86_400_000);
    const month = String(p.getUTCMonth() + 1).padStart(2, "0");
    const inside = `${p.getUTCFullYear()}-${month}-15`; // ~60 days ago
    const reference = `${p.getUTCFullYear() - 1}-${month}-15`; // ~425 days ago

    await store().upsertPoints("macro:us-cpi-yoy", [
      [reference, 100.0],
      [inside, 104.0],
    ]);

    const body = await json<SeriesBody>("/api/series/us-cpi-yoy?range=1y");
    expect(body.points).toEqual([[inside, 4.0]]);
  });

  it("404s an unknown id", async () => {
    expect((await get("/api/series/nope")).status).toBe(404);
    expect((await get("/api/series/pendle-pt-cbbtc-usdc-typo")).status).toBe(404);
  });

  it("serves configured ref ids, including non-base markets", async () => {
    await store().upsertPoints("ref:aave-base-usdc-supply", [
      ["2026-07-01", 2.6],
      ["2026-07-08", 2.71],
    ]);
    const body = await json<SeriesBody>("/api/series/aave-base-usdc-supply?range=max");
    expect(body.name).toBe("AAVE USDC BASE SUP");
    expect(body.unit).toBe("%");
    expect(body.points).toEqual([
      ["2026-07-01", 2.6],
      ["2026-07-08", 2.71],
    ]); // raw, no transform

    await store().upsertPoints("ref:aave-arb-usdt-borrow", [["2026-07-08", 3.68]]);
    const arb = await json<SeriesBody>("/api/series/aave-arb-usdt-borrow?range=max");
    expect(arb.name).toBe("AAVE USDT ARB BOR");
    expect(arb.points).toEqual([["2026-07-08", 3.68]]);
  });

  it("serves an index symbol", async () => {
    await store().upsertPoints("idx:SPX", [
      ["2026-07-01", 6150.0],
      ["2026-07-08", 6234.5],
    ]);
    const body = await json<SeriesBody>("/api/series/SPX?range=max");
    expect(body.name).toBe("S&P 500");
    expect(body.unit).toBe("px");
    expect(body.points).toEqual([
      ["2026-07-01", 6150.0],
      ["2026-07-08", 6234.5],
    ]);
  });

  it("serves bond and central bank ids", async () => {
    await store().upsertPoints("yield:US3M", [["2026-07-08", 3.89]]);
    await store().upsertPoints("cb:US", [["2026-07-08", 3.75]]);

    const y3m = await json<SeriesBody>("/api/series/US3M?range=max");
    expect(y3m.unit).toBe("%");
    expect(y3m.points).toEqual([["2026-07-08", 3.89]]);

    const cb = await json<SeriesBody>("/api/series/USCB?range=max");
    expect(cb.name).toBe("FED");
    expect(cb.points).toEqual([["2026-07-08", 3.75]]);

    expect((await get("/api/series/JP10Y")).status).toBe(404); // not in config
  });

  it("applies a cycle series transform", async () => {
    await store().upsertPoints("cycle:m2-yoy", [
      ["2025-06-01", 100.0],
      ["2026-06-01", 106.0],
    ]);
    const body = await json<SeriesBody>("/api/series/m2-yoy?range=5y");
    expect(body.name).toBe("M2 YoY");
    expect(body.unit).toBe("%");
    expect(body.points).toEqual([["2026-06-01", 6.0]]);
  });

  it("422s a bad range", async () => {
    expect((await get("/api/series/us-cpi-yoy?range=2w")).status).toBe(422);
  });
});

describe("/api/recessions", () => {
  it("serves the precomputed bands", async () => {
    await store().upsertPoints("cycle:usrec", [
      ["2020-01-01", 0.0],
      ["2020-03-01", 1.0],
      ["2020-04-01", 1.0],
      ["2020-05-01", 0.0],
    ]);
    await rebuildRecessions(store());

    expect(await json("/api/recessions")).toEqual({ bands: [["2020-03-01", "2020-05-01"]] });
  });

  it("returns empty bands before the cycle job has run", async () => {
    expect(await json("/api/recessions")).toEqual({ bands: [] });
  });
});

describe("/healthz", () => {
  it("reports fetchers and overall health", async () => {
    await store().recordSuccess("equity", "yahoo");

    const body = await json<{ ok: boolean; fetchers: { name: string }[] }>("/healthz");
    expect(body.ok).toBe(true);
    expect(body.fetchers[0]?.name).toBe("equity");
  });

  it("is not ok when a fetcher has failed and never succeeded", async () => {
    await store().recordSuccess("equity", "yahoo");
    await store().recordError("news", "all feeds dead");

    expect((await json<{ ok: boolean }>("/healthz")).ok).toBe(false);
  });

  it("is ok again once a failing fetcher recovers", async () => {
    await store().recordError("news", "all feeds dead");
    await store().recordSuccess("news", "rss");

    expect((await json<{ ok: boolean }>("/healthz")).ok).toBe(true);
  });
});
