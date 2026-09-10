import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";

import FRED_JSON from "./fixtures/fred_dgs10.json?raw";
import YAHOO_SPX from "./fixtures/yahoo_spx.json?raw";

import { config } from "../src/config.data";
import { ALL_JOB_NAMES, CRON_JOBS, CRON_SECONDS, cronJobs, runCronGroup } from "../src/jobs";
import { FETCH_RETRIES, runMacroHistory, type WorkflowDeps } from "../src/workflows";
import { DASHBOARD_DOC } from "../src/panels";
import { Store } from "../src/store";
import worker from "../src/index";

// Ports collector/tests/test_scheduler.py, and covers the cron/Workflow split
// that replaced APScheduler.

const store = () => new Store(env.DB);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM series_points"),
    env.DB.prepare("DELETE FROM docs"),
    env.DB.prepare("DELETE FROM fetcher_status"),
  ]);
});

/**
 * A WorkflowStep that models the two semantics this code depends on: results
 * are memoized across a replay, and a failing step is retried up to its limit.
 *
 * It is deliberately not a stand-in for the real engine. What it pins is that
 * the run functions do no work outside a step, so a replay cannot redo it.
 * The real resume behaviour is a deploy-time check.
 */
class FakeStep {
  readonly completed = new Map<string, unknown>();
  readonly attempts: string[] = [];

  async do<T>(name: string, ...rest: unknown[]): Promise<T> {
    const fn = rest[rest.length - 1] as () => Promise<T>;
    const cfg = rest.length > 1 ? (rest[0] as typeof FETCH_RETRIES) : undefined;
    const limit = cfg?.retries.limit ?? 0;

    if (this.completed.has(name)) return this.completed.get(name) as T;

    let lastError: unknown;
    for (let attempt = 0; attempt <= limit; attempt++) {
      this.attempts.push(name);
      try {
        const result = await fn();
        this.completed.set(name, result);
        return result;
      } catch (exc) {
        lastError = exc;
      }
    }
    throw lastError;
  }

  asStep(): WorkflowStep {
    return this as unknown as WorkflowStep;
  }
}

describe("job registration", () => {
  it("covers the same eleven jobs the Python scheduler registered", () => {
    const cron = Object.values(CRON_JOBS).flat();
    const workflows = ["cycle", "macro_history", "refs_history"];
    expect(new Set([...cron, ...workflows])).toEqual(new Set(ALL_JOB_NAMES));
  });

  it("splits cron and Workflow jobs without overlap", () => {
    const cron = Object.values(CRON_JOBS).flat();
    expect(new Set(cron).size).toBe(cron.length); // no job on two expressions
    for (const name of ["cycle", "macro_history", "refs_history"]) {
      expect(cron).not.toContain(name);
    }
  });

  it("maps every cron expression to the cadence config.yaml declares", () => {
    // The cadences are the contract the Python scheduler encoded as interval
    // seconds; drifting from them silently changes how often upstreams are hit.
    for (const [cron, names] of Object.entries(CRON_JOBS)) {
      const seconds = CRON_SECONDS[cron]!;
      for (const name of names) {
        expect(config.cadences[name], `${name} cadence`).toBe(seconds);
      }
    }
    expect(CRON_SECONDS).toEqual({
      "*/5 * * * *": 300,
      "*/10 * * * *": 600,
      "*/15 * * * *": 900,
      "0 * * * *": 3600,
    });
  });

  it("keeps the daily jobs on the cadences config.yaml declares", () => {
    expect(config.cadences["cycle"]).toBe(86400);
    expect(config.cadences["refs_history"]).toBe(86400);
  });

  it("builds a callable for every cron job name", () => {
    const jobs = cronJobs({
      store: store(),
      getText: async () => "",
      getBytes: async () => new ArrayBuffer(0),
      postJson: async () => ({}),
      fredApiKey: "k",
    });
    expect(new Set(Object.keys(jobs))).toEqual(new Set(Object.values(CRON_JOBS).flat()));
  });

  it("exports scheduled and fetch handlers", () => {
    expect(typeof worker.scheduled).toBe("function");
    expect(typeof worker.fetch).toBe("function");
  });
});

describe("runCronGroup", () => {
  const deps = (getText: (url: string) => Promise<string>): Parameters<typeof runCronGroup>[1] => ({
    store: store(),
    getText,
    getBytes: async () => new ArrayBuffer(0),
    postJson: async () => ({}),
    fredApiKey: "k",
  });

  it("runs the hourly group and records status for each job", async () => {
    const ran = await runCronGroup("0 * * * *", deps(async (url) => {
      if (url.includes("stlouisfed")) return FRED_JSON;
      if (url.includes("faireconomy")) return "[]";
      throw new Error(`unexpected url: ${url}`);
    }));

    expect(ran).toEqual(["bonds", "macro"]);
    const names = (await store().statuses()).map((s) => s.name);
    expect(names).toEqual(["bonds", "macro"]);
  });

  it("keeps going when one job in the group fails", async () => {
    // runFetcher swallows into fetcher_status, so a dead upstream must not stop
    // the rest of the group.
    await runCronGroup("0 * * * *", deps(async (url) => {
      if (url.includes("faireconomy")) return "[]";
      throw new Error("upstream down");
    }));

    const byName = new Map((await store().statuses()).map((s) => [s.name, s]));
    expect(byName.get("bonds")?.last_error).toContain("all bonds failed");
    expect(byName.get("bonds")?.last_success).toBeNull();
    expect(byName.get("macro")?.last_success).not.toBeNull();
  });

  it("ignores an unregistered cron expression", async () => {
    expect(await runCronGroup("7 * * * *", deps(async () => ""))).toEqual([]);
  });

  it("runs the five-minute group", async () => {
    const ran = await runCronGroup("*/5 * * * *", deps(async () => YAHOO_SPX));
    expect(ran).toEqual(["equity"]);
    expect((await store().status("equity"))?.active_source).toBe("yahoo");
  });
});

describe("per-series workflow", () => {
  function deps(getText: () => Promise<string>): WorkflowDeps {
    return {
      store: store(),
      getText,
      getBytes: async () => new ArrayBuffer(0),
      fredApiKey: "k",
    };
  }

  it("makes one step per series and records success", async () => {
    const step = new FakeStep();
    const out = await runMacroHistory(step.asStep(), deps(async () => FRED_JSON));

    expect(out).toEqual({ series: config.series.length, failed: 0 });
    // one step per series, plus record-status and rebuild-dashboard
    expect(step.completed.size).toBe(config.series.length + 2);
    expect([...step.completed.keys()]).toContain(`macro:${config.series[0]!.id}`);
    expect([...step.completed.keys()]).toContain("rebuild-dashboard");
    expect((await store().status("macro_history"))?.last_success).not.toBeNull();

    // the dashboard doc the API serves now exists
    expect(await store().doc(DASHBOARD_DOC)).not.toBeNull();
  });

  it("isolates a failing series and records the failure count", async () => {
    const bad = config.series[1]!;

    const out = await runMacroHistory(new FakeStep().asStep(), {
      ...deps(async () => FRED_JSON),
      getText: async (_url: string, params?: Record<string, string>) => {
        if (params?.["series_id"] === bad.fred) throw new Error("HTTP 400");
        return FRED_JSON;
      },
    });

    expect(out).toEqual({ series: config.series.length, failed: 1 });
    const status = await store().status("macro_history");
    expect(status?.last_error).toContain("1/");
    expect(status?.last_error).toContain(bad.id);
    // the surviving series still landed
    expect((await store().points(`macro:${config.series[0]!.id}`)).size).toBeGreaterThan(0);
  });

  it("retries a step up to its limit before giving up", async () => {
    const step = new FakeStep();
    const target = config.series[0]!;
    let attempts = 0;

    await runMacroHistory(step.asStep(), {
      ...deps(async () => FRED_JSON),
      getText: async (url: string, params?: Record<string, string>) => {
        if (params?.["series_id"] === target.fred) {
          attempts++;
          if (attempts <= 2) throw new Error("flaky"); // fails twice, then succeeds
        }
        return FRED_JSON;
      },
    });

    // limit 2 means three attempts, so the third succeeds
    expect(attempts).toBe(3);
    expect(step.attempts.filter((n) => n === `macro:${target.id}`)).toHaveLength(3);
    expect((await store().status("macro_history"))?.last_success).not.toBeNull();
  });

  it("does not redo completed steps on a replay", async () => {
    // This is what "resumes at series 30 rather than refetching the 29" has to
    // mean for this code: no work happens outside a step, so a replay with the
    // same memo re-executes only what had not completed.
    const failing = config.series[2]!;
    const fetched: string[] = [];

    const getText = (dead: boolean) => async (_url: string, params?: Record<string, string>) => {
      const id = params?.["series_id"] ?? "";
      if (dead && id === failing.fred) throw new Error("upstream down");
      fetched.push(id);
      return FRED_JSON;
    };

    const step = new FakeStep();
    const first = await runMacroHistory(step.asStep(), {
      ...deps(async () => FRED_JSON),
      getText: getText(true),
    });
    expect(first.failed).toBe(1);

    const afterFirst = [...fetched];
    expect(afterFirst).toContain(config.series[0]!.fred);
    expect(afterFirst).not.toContain(failing.fred);

    // Replay against the same memo, upstream now healthy.
    fetched.length = 0;
    const second = await runMacroHistory(step.asStep(), {
      ...deps(async () => FRED_JSON),
      getText: getText(false),
    });

    expect(second.failed).toBe(0);
    // Only the previously failed series was fetched again.
    expect(fetched).toEqual([failing.fred]);
  });
});
