import { env } from "cloudflare:test";
import { it } from "vitest";

import SEED_SQL from "./seed.sql?raw";
import { config } from "../src/config.data";
import { buildDashboard } from "../src/panels";
import { Store } from "../src/store";

// Not a test so much as a dumper: it loads the shared parity seed, builds the
// dashboard with the same fixed `now` the Python side uses, and emits the JSON
// for parity/diff.py to compare. Excluded from `pnpm test`.
//
// workerd has no filesystem, so the payload comes out through console.log in
// chunks, reassembled by parity/run.sh.

const NOW = new Date("2026-07-08T14:30:00Z");
const CHUNK = 1500;

it("dumps the dashboard built from the parity seed", async () => {
  for (const stmt of SEED_SQL.split("\n")) {
    const sql = stmt.trim();
    if (sql === "" || sql.startsWith("--")) continue;
    await env.DB.prepare(sql).run();
  }

  const dash = await buildDashboard(
    new Store(env.DB),
    config.indexes,
    NOW,
    config.cycle_series,
    config.cycle_tabs,
  );

  const json = JSON.stringify(dash);
  console.log("__PARITY_BEGIN__");
  for (let i = 0; i < json.length; i += CHUNK) {
    console.log(`__PARITY__${json.slice(i, i + CHUNK)}`);
  }
  console.log("__PARITY_END__");
});
