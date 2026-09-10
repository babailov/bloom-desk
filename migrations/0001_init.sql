-- Lifted verbatim from collector/src/collector/store.py SCHEMA.
-- Deliberately unchanged: the parity diff between the Python collector and this
-- Worker is only meaningful if both read and write the same shape.
CREATE TABLE IF NOT EXISTS series_points(
  series_id TEXT NOT NULL,
  d         TEXT NOT NULL,
  value     REAL NOT NULL,
  PRIMARY KEY(series_id, d)
);
CREATE TABLE IF NOT EXISTS docs(
  key        TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fetcher_status(
  name          TEXT PRIMARY KEY,
  last_success  TEXT,
  last_error    TEXT,
  last_error_at TEXT,
  active_source TEXT
);
