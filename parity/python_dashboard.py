"""Dump the Python collector's /api/dashboard payload from the parity seed."""
import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "collector" / "src"))

from collector.config import load_config          # noqa: E402
from collector.panels import build_dashboard      # noqa: E402
from collector.store import SCHEMA, Store         # noqa: E402

NOW = datetime.fromisoformat("2026-07-08T14:30:00+00:00")

db = Path("parity/out/python.db")
db.parent.mkdir(parents=True, exist_ok=True)
db.unlink(missing_ok=True)

conn = sqlite3.connect(db)
conn.executescript(SCHEMA)
conn.executescript(Path("parity/seed.sql").read_text())
conn.commit()
conn.close()

cfg = load_config("config.yaml")
store = Store(db)
dash = build_dashboard(
    store, cfg.indexes, now=NOW,
    cycle_series=cfg.cycle_series, cycle_tabs=cfg.cycle_tabs,
)

Path("parity/out/python.json").write_text(json.dumps(dash, indent=2, sort_keys=True))
print("wrote parity/out/python.json")
