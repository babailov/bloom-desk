"""Compare the two dashboard payloads, with a tolerance for float formatting.

Exact equality is the wrong bar: the two runtimes round and serialize floats
differently at the last bit. Anything above that is a real divergence.
"""
import json
import math
import re
import sys
from datetime import datetime

TOLERANCE = 1e-9

ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$")


def same_instant(a, b) -> bool:
    """Timestamps compare as instants, not strings.

    Python's isoformat() drops sub-second digits when they are zero and
    otherwise writes microseconds; JavaScript's toISOString() always writes
    exactly three. Both are ISO-8601 UTC and both parse to the same moment, so
    string equality is the wrong test for a timestamp field.
    """
    if not (isinstance(a, str) and isinstance(b, str)):
        return False
    if not (ISO.match(a) and ISO.match(b)):
        return False
    try:
        return datetime.fromisoformat(a.replace("Z", "+00:00")) == datetime.fromisoformat(
            b.replace("Z", "+00:00")
        )
    except ValueError:
        return False

diffs: list[str] = []


def walk(path: str, a, b) -> None:
    if isinstance(a, dict) and isinstance(b, dict):
        for key in sorted(set(a) | set(b)):
            if key not in a:
                diffs.append(f"{path}.{key}: missing in python")
            elif key not in b:
                diffs.append(f"{path}.{key}: missing in typescript")
            else:
                walk(f"{path}.{key}", a[key], b[key])
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            diffs.append(f"{path}: length {len(a)} (python) vs {len(b)} (typescript)")
        for i, (x, y) in enumerate(zip(a, b)):
            walk(f"{path}[{i}]", x, y)
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)) \
            and not isinstance(a, bool) and not isinstance(b, bool):
        if not math.isclose(a, b, rel_tol=TOLERANCE, abs_tol=TOLERANCE):
            diffs.append(f"{path}: {a!r} (python) vs {b!r} (typescript)")
    elif a != b and not same_instant(a, b):
        diffs.append(f"{path}: {a!r} (python) vs {b!r} (typescript)")


py = json.load(open("parity/out/python.json"))
ts = json.load(open("parity/out/ts.json"))
walk("dashboard", py, ts)

if diffs:
    print(f"PARITY DIFF: {len(diffs)} difference(s)\n")
    for d in diffs[:60]:
        print("  " + d)
    if len(diffs) > 60:
        print(f"  ... and {len(diffs) - 60} more")
    sys.exit(1)

print("PARITY OK: payloads identical within tolerance")
print(f"  panels: {sorted(py['panels'])}")
print(f"  equity rows: {len(py['panels']['equity']['rows'])}")
print(f"  bond rows: {len(py['panels']['bonds']['rows'])}")
print(f"  cycle rows: {sum(len(p['rows']) for t in py['panels']['cycle']['tabs'] for p in t['panels'])}")
