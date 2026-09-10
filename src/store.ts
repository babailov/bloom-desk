/**
 * D1 persistence. Port of collector/src/collector/store.py.
 *
 * Three tables, schema unchanged (see migrations/0001_init.sql) so the parity
 * diff against the Python collector stays meaningful.
 *
 * Two deliberate departures from the Python original:
 *
 * 1. Dates are ISO `YYYY-MM-DD` strings, never `Date`. That is exactly what the
 *    `d` column holds, it compares and sorts correctly as a string, and it
 *    avoids the timezone trap where `new Date("2026-01-01")` is UTC midnight
 *    but `.getDate()` reads it in local time.
 * 2. Writes are batched and bounded. D1 caps a query at 100 bound parameters
 *    and a batch at 30 seconds, neither of which `executemany` had to care
 *    about. See upsertPoints and upsertRecentPoints.
 */

/** A stored JSON document with its provenance. Mirrors store.py's `Doc`. */
export interface Doc<T = unknown> {
  payload: T;
  updated_at: string;
  source: string;
}

export interface FetcherStatus {
  name: string;
  last_success: string | null;
  last_error: string | null;
  last_error_at: string | null;
  active_source: string | null;
}

/** An ISO `YYYY-MM-DD` date and its value. */
export type Point = readonly [date: string, value: number];

/**
 * Rows per INSERT statement. D1 allows 100 bound parameters per query and each
 * row costs three, so 33 is the ceiling. Exceeding it fails at runtime, not at
 * compile time, which is why this is a named constant and not a literal.
 */
const ROWS_PER_STATEMENT = 33;

/**
 * Statements per batch. The whole batch must resolve within 30 seconds, so this
 * trades round trips against that ceiling. 20 x 33 = 660 rows per batch puts a
 * 2,600-point FRED history in four batches.
 */
const STATEMENTS_PER_BATCH = 20;

/**
 * How far back to re-send points that already exist.
 *
 * The Python collector re-upserts a series' entire history on every run. That
 * is correct, because upstreams revise published data and a blind
 * "only rows newer than the newest stored" filter would never see a revision.
 * It is also up to 100k row-writes a day across the 39 cycle series, which on
 * D1 is a metered cost for almost no new information.
 *
 * The compromise: always re-send a trailing window, which catches the revisions
 * that actually happen (most upstreams revise the last month or two), and let a
 * periodic full refresh via upsertPoints catch anything deeper.
 */
const REVISION_WINDOW_DAYS = 120;

function nowIso(): string {
  // Python writes microseconds, this writes milliseconds. Both are ISO-8601
  // UTC ending in Z, so lexicographic ordering across the two is preserved.
  return new Date().toISOString();
}

/** Shift an ISO date string by whole days, staying in UTC. */
export function shiftIsoDate(iso: string, days: number): string {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

export class Store {
  constructor(private readonly db: D1Database) {}

  /**
   * Insert or overwrite points. Chunked to stay under D1's parameter cap.
   *
   * Callers with a full history should prefer upsertRecentPoints; this is for
   * small payloads and for the periodic deep refresh.
   */
  async upsertPoints(seriesId: string, points: readonly Point[]): Promise<void> {
    if (points.length === 0) return;

    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < points.length; i += ROWS_PER_STATEMENT) {
      const chunk = points.slice(i, i + ROWS_PER_STATEMENT);
      const placeholders = chunk.map(() => "(?,?,?)").join(",");
      const bindings = chunk.flatMap(([d, value]) => [seriesId, d, value]);
      statements.push(
        this.db
          .prepare(
            `INSERT INTO series_points(series_id, d, value) VALUES${placeholders} ` +
              "ON CONFLICT(series_id, d) DO UPDATE SET value=excluded.value",
          )
          .bind(...bindings),
      );
    }

    for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) {
      await this.db.batch(statements.slice(i, i + STATEMENTS_PER_BATCH));
    }
  }

  /**
   * Upsert only what is plausibly new or revised: everything on or after
   * (newest stored date - REVISION_WINDOW_DAYS). An empty series takes the
   * whole payload.
   *
   * Returns the number of points actually written, so callers can log the
   * saving and so a regression back to full-history writes is visible.
   */
  async upsertRecentPoints(
    seriesId: string,
    points: readonly Point[],
    windowDays: number = REVISION_WINDOW_DAYS,
  ): Promise<number> {
    if (points.length === 0) return 0;

    const newest = await this.maxPointDate(seriesId);
    const fresh =
      newest === null ? points : points.filter(([d]) => d >= shiftIsoDate(newest, -windowDays));

    await this.upsertPoints(seriesId, fresh);
    return fresh.length;
  }

  /** Newest stored date for a series, or null when it has no points. */
  async maxPointDate(seriesId: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT MAX(d) AS d FROM series_points WHERE series_id=?")
      .bind(seriesId)
      .first<{ d: string | null }>();
    return row?.d ?? null;
  }

  /**
   * Points for a series, keyed by ISO date, oldest first.
   *
   * Non-numeric values are skipped rather than surfaced. SQLite's dynamic
   * typing lets a TEXT value sit in a REAL column, and one corrupt row must not
   * poison a whole series.
   */
  async points(seriesId: string, since?: string): Promise<Map<string, number>> {
    const sql = since
      ? "SELECT d, value FROM series_points WHERE series_id=? AND d >= ? ORDER BY d"
      : "SELECT d, value FROM series_points WHERE series_id=? ORDER BY d";
    const args = since ? [seriesId, since] : [seriesId];

    const { results } = await this.db
      .prepare(sql)
      .bind(...args)
      .all<{ d: string; value: unknown }>();

    const out = new Map<string, number>();
    for (const { d, value } of results) {
      if (typeof value === "number" && Number.isFinite(value)) out.set(d, value);
    }
    return out;
  }

  async putDoc(key: string, payload: unknown, source: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO docs(key, payload, updated_at, source) VALUES(?,?,?,?) " +
          "ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, " +
          "updated_at=excluded.updated_at, source=excluded.source",
      )
      .bind(key, JSON.stringify(payload), nowIso(), source)
      .run();
  }

  /** A stored doc, or null when missing or corrupt. */
  async doc<T = unknown>(key: string): Promise<Doc<T> | null> {
    const row = await this.db
      .prepare("SELECT payload, updated_at, source FROM docs WHERE key=?")
      .bind(key)
      .first<{ payload: string; updated_at: string; source: string }>();
    if (row === null) return null;

    let payload: T;
    try {
      payload = JSON.parse(row.payload) as T;
    } catch {
      // A corrupted doc must behave like a missing doc, never 500 the API.
      console.warn(`dropping corrupted doc ${JSON.stringify(key)}`);
      return null;
    }
    return { payload, updated_at: row.updated_at, source: row.source };
  }

  /** Record a success without disturbing the recorded error history. */
  async recordSuccess(name: string, activeSource: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO fetcher_status(name, last_success, active_source) VALUES(?,?,?) " +
          "ON CONFLICT(name) DO UPDATE SET last_success=excluded.last_success, " +
          "active_source=excluded.active_source",
      )
      .bind(name, nowIso(), activeSource)
      .run();
  }

  /** Record an error without disturbing the recorded last success. */
  async recordError(name: string, error: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO fetcher_status(name, last_error, last_error_at) VALUES(?,?,?) " +
          "ON CONFLICT(name) DO UPDATE SET last_error=excluded.last_error, " +
          "last_error_at=excluded.last_error_at",
      )
      .bind(name, error, nowIso())
      .run();
  }

  /**
   * Delete stored points outside [lo, hi]. Cleanup for feeds that once served
   * corrupt values, which upsert alone never removes.
   */
  async pruneOutsideRange(seriesId: string, lo: number, hi: number): Promise<void> {
    await this.db
      .prepare("DELETE FROM series_points WHERE series_id=? AND (value < ? OR value > ?)")
      .bind(seriesId, lo, hi)
      .run();
  }

  async status(name: string): Promise<FetcherStatus | null> {
    const row = await this.db
      .prepare(
        "SELECT name, last_success, last_error, last_error_at, active_source " +
          "FROM fetcher_status WHERE name=?",
      )
      .bind(name)
      .first<FetcherStatus>();
    return row ?? null;
  }

  async statuses(): Promise<FetcherStatus[]> {
    const { results } = await this.db
      .prepare(
        "SELECT name, last_success, last_error, last_error_at, active_source " +
          "FROM fetcher_status ORDER BY name",
      )
      .all<FetcherStatus>();
    return results;
  }
}
