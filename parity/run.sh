#!/usr/bin/env bash
# Parity diff: same seed, same fixed `now`, both dashboard implementations.
#
# Time is the only thing that could make this differ for uninteresting reasons,
# so it is pinned everywhere: the seed carries fixed doc timestamps, and both
# stacks are handed 2026-07-08T14:30:00Z as `now`.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== regenerating seed =="
collector/.venv/bin/python parity/make_seed.py

echo "== python dashboard =="
collector/.venv/bin/python parity/python_dashboard.py

echo "== typescript dashboard =="
mkdir -p parity/out
pnpm exec vitest run --config vitest.parity.config.ts 2>&1 \
  | sed -n 's/^__PARITY__//p' | tr -d '\n' > parity/out/ts.raw.json
python3 -c "
import json
d = json.load(open('parity/out/ts.raw.json'))
json.dump(d, open('parity/out/ts.json','w'), indent=2, sort_keys=True)
print('wrote parity/out/ts.json')
"

echo "== diff =="
python3 parity/diff.py
