/**
 * Config for the parity dumper only. The main config excludes parity/ so the
 * dumper stays out of `pnpm test`; this one includes just that file.
 *
 * disableConsoleIntercept is what makes this work: without it vitest swallows
 * workerd's console output entirely, and workerd has no filesystem to write to
 * instead. The dumper prints the payload in chunks and run.sh reassembles it.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = await readD1Migrations(path.join(here, "migrations"));

export default defineConfig({
  assetsInclude: ["**/*.xls"],
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    include: ["parity/dump.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
    disableConsoleIntercept: true,
  },
});
