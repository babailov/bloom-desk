import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// ESM: no __dirname. Derive the directory from import.meta.url instead.
const here = path.dirname(fileURLToPath(import.meta.url));

// Tests run against a real D1 in the Workers runtime, not a mock, so the
// migrations are applied exactly the way production applies them.
const migrations = await readD1Migrations(path.join(here, "migrations"));

export default defineConfig({
  // The AAII fixture is a binary .xls. Declaring it an asset lets tests
  // import it with ?inline as a data URI, since workerd has no fs.
  assetsInclude: ["**/*.xls"],
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
