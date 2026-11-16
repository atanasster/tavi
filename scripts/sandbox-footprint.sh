#!/usr/bin/env bash
# The sandbox's footprint: builds the sandbox
# package, then measures with scripts/sandbox-footprint.mjs. On the 1 vCPU / 1 GiB VM for the
# recorded numbers; RUNS sets the warm runs per command (default 50).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pnpm --dir "$ROOT" --filter @tavi/contracts --filter @tavi/plugin-sandbox build >/dev/null
node "$ROOT/scripts/sandbox-footprint.mjs"
