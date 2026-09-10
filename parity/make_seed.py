"""Emit parity/seed.sql: one deterministic dataset both stacks load.

The parity diff is only meaningful if every input is identical, including the
timestamps panels read. put_doc stamps updated_at with wall-clock time, so the
docs are inserted as raw SQL with fixed values instead.

Dates are anchored to NOW below, not to today, so the diff is reproducible on
any day.
"""
import json
from datetime import date, timedelta

import yaml

NOW = "2026-07-08T14:30:00+00:00"          # what both stacks pass as `now`
DOC_TS = "2026-07-08T14:00:00.000000Z"      # fixed updated_at for every doc
ANCHOR = date(2026, 7, 8)

rows: list[str] = []


def q(v) -> str:
    return "'" + str(v).replace("'", "''") + "'"


def points(series_id: str, pts: list[tuple[date, float]]) -> None:
    for d, v in pts:
        rows.append(
            f"INSERT INTO series_points(series_id, d, value) VALUES({q(series_id)}, {q(d.isoformat())}, {v!r});"
        )


def doc(key: str, payload, source: str) -> None:
    rows.append(
        "INSERT INTO docs(key, payload, updated_at, source) VALUES("
        f"{q(key)}, {q(json.dumps(payload, sort_keys=True))}, {q(DOC_TS)}, {q(source)});"
    )


def back(days: int) -> date:
    return ANCHOR - timedelta(days=days)


# --- equity: enough history for 1d / 1w / ytd, deliberately none for 1y ------
points("idx:SPX", [
    (date(2025, 12, 31), 5800.0), (date(2026, 6, 30), 6100.0),
    (date(2026, 7, 1), 6150.0), (date(2026, 7, 7), 6200.0), (date(2026, 7, 8), 6234.5),
])
points("idx:NDX", [(date(2026, 7, 7), 22000.0), (date(2026, 7, 8), 22150.25)])
doc("equity_quotes", {
    "SPX": {"last": 6234.5, "ts": "2026-07-08T14:00:00Z", "source": "yahoo", "delayed": True},
    "NDX": {"last": 22150.25, "ts": "2026-07-08T14:00:00Z", "source": "yahoo", "delayed": True},
}, "yahoo")

# --- bonds: a fully-populated country and a partial one ----------------------
points("yield:US10Y", [
    (date(2026, 7, 1), 4.20), (date(2026, 7, 7), 4.15), (date(2026, 7, 8), 4.12),
])
points("yield:US3M", [(date(2026, 7, 8), 3.89)])
points("cb:US", [(date(2026, 7, 8), 3.75)])
doc("bond_quotes", {
    "US10Y": {"country": "US", "tenor": "10Y", "yield_pct": 4.12,
              "ts": "2026-07-08T00:00:00Z", "source": "fred"},
    "US3M": {"country": "US", "tenor": "3M", "yield_pct": 3.89,
             "ts": "2026-07-08T00:00:00Z", "source": "fred"},
    "USCB": {"country": "US", "label": "FED", "yield_pct": 3.75,
             "ts": "2026-07-08T00:00:00Z", "source": "fred"},
    "DE10Y": {"country": "DE", "tenor": "10Y", "yield_pct": 3.17,
              "ts": "2026-07-08T00:00:00Z", "source": "bundesbank"},
}, "bundesbank+fred")

# --- macro: one upcoming, one already released, one outside the 7d window ----
doc("macro_calendar", {"releases": [
    {"name": "CPI y/y", "country": "USD", "time": "2026-07-10T12:30:00-04:00",
     "impact": "High", "previous": "2.4%", "consensus": "2.3%", "actual": None,
     "series_id": "us-cpi-yoy"},
    {"name": "Retail Sales m/m", "country": "USD", "time": "2026-07-08T08:30:00-04:00",
     "impact": "High", "previous": "0.2%", "consensus": "0.3%", "actual": "0.4%",
     "series_id": "us-retail"},
    {"name": "TBD Event", "country": "EUR", "time": "TBD", "impact": "High",
     "previous": None, "consensus": None, "actual": None, "series_id": None},
]}, "forexfactory")
doc("macro_history", {"releases": [
    {"name": "Old GDP q/q", "country": "USD", "time": "2026-06-20T08:30:00-04:00",
     "impact": "High", "actual": "2.1%", "series_id": "us-gdp"},
    {"name": "Non-Farm Payrolls", "country": "USD", "time": "2026-07-03T08:30:00-04:00",
     "impact": "High", "actual": "185k", "series_id": "us-nfp"},
    {"name": "Retail Sales m/m", "country": "USD", "time": "2026-07-08T08:30:00-04:00",
     "impact": "High", "actual": "0.4%", "series_id": "us-retail"},
]}, "forexfactory")

# --- pass-through doc panels -------------------------------------------------
doc("news", {"items": [
    {"headline": "ECB signals pause", "url": "https://ft.com/a", "feed": "FT",
     "published_at": "2026-07-08T13:00:00Z", "source": "rss"},
]}, "rss")
doc("defi_pools", {"rows": [
    {"tier": "Conservative", "chain": "Base", "chain_id": 8453, "pool_address": "0x91c0",
     "protocol": "Morpho", "pool": "Clearstar", "apy": 7.98, "apy_7d": 6.54,
     "apy_30d": 7.03, "tvl_usd": 10732971.3, "url": "https://app.morpho.org/x"},
]}, "zyfai")
doc("midnight_curve", {"rows": [
    {"chain": "Base", "market_id": "0x0595", "maturity": "2026-08-28", "days": 37.625,
     "lend_apy": 4.0925361830999485, "borrow_apy": 4.53047561440989,
     "ask_depth_usd": 100699.339381, "bid_depth_usd": 318.754794, "collateral": "cbBTC"},
]}, "morpho")
doc("morpho_markets", {"rows": [
    {"chain": "Base", "chain_id": 8453, "market_id": "0x9103", "collateral": "cbBTC",
     "lltv_pct": 86.0, "supply_apy": 4.89, "borrow_apy": 5.43,
     "utilization_pct": 90.41, "tvl_usd": 1413119205.7988927},
]}, "morpho-blue")

# --- refs: one with history, one without -------------------------------------
points("ref:aave-base-usdc-supply", [
    (back(7), 2.60), (back(1), 2.69), (ANCHOR, 2.71),
])
doc("rate_refs", {"rows": [
    {"id": "aave-base-usdc-supply", "label": "AAVE USDC BASE SUP",
     "value_pct": 2.71, "extra": None},
    {"id": "aave-base-usdc-borrow", "label": "AAVE USDC BASE BOR",
     "value_pct": 3.88, "extra": None},
    {"id": "pendle-pt-cbbtc-usdc", "label": "PENDLE PT SEP17", "value_pct": 4.475867335355943,
     "extra": {"expiry": "2026-09-17T00:00:00.000Z"}},
]}, "refs")

# --- cycle: every transform kind, plus series left empty on purpose ----------
cfg = yaml.safe_load(open("config.yaml"))
for i, s in enumerate(cfg["cycle_series"]):
    if i % 5 == 4:
        continue  # leave every fifth series empty: exercises the null-cell path
    transform = s.get("transform", "none")
    base = 20.0 + i
    if transform == "yoy":
        # needs a same-day point 1 and 2 years back for the 1y change to resolve
        pts = [
            (date(2024, 8, 20), base), (date(2025, 7, 20), base * 1.02),
            (date(2025, 8, 20), base * 1.05), (date(2026, 7, 20), base * 1.08),
            (date(2026, 8, 20), base * 1.11),
        ]
    else:
        pts = [
            (date(2025, 8, 20), base * 1.5), (date(2026, 7, 20), base * 1.2),
            (date(2026, 8, 20), base),
        ]
    points(f"cycle:{s['id']}", pts)

# usrec drives the recession bands
points("cycle:usrec", [
    (date(2020, 1, 1), 0.0), (date(2020, 3, 1), 1.0),
    (date(2020, 4, 1), 1.0), (date(2020, 5, 1), 0.0),
])

with open("parity/seed.sql", "w") as fh:
    fh.write("-- GENERATED by parity/make_seed.py. Do not edit.\n")
    fh.write("\n".join(rows) + "\n")

print(f"wrote parity/seed.sql: {len(rows)} statements, now={NOW}")
