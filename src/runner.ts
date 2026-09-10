/**
 * Wraps every fetcher run: status recording + total error isolation.
 * Port of collector/src/collector/runner.py.
 *
 * Under Workflows a step's own retry handles transient failure, but this stays
 * the thing that writes fetcher_status, which is what /healthz reads.
 */
import type { Store } from "./store";

/** Returns the active source label on success. */
export type FetchFn = () => Promise<string>;

export async function runFetcher(name: string, store: Store, fn: FetchFn): Promise<void> {
  try {
    const activeSource = await fn();
    await store.recordSuccess(name, activeSource);
  } catch (exc) {
    // isolation is the contract
    const msg = exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc);
    console.warn(`fetcher ${name} failed: ${msg}`);
    await store.recordError(name, msg);
  }
}
