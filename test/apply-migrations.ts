import { applyD1Migrations, env } from "cloudflare:test";

// Runs once per test worker, before any test file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
