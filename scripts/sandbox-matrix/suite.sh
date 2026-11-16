#!/usr/bin/env bash
# One sandbox-matrix suite inside a Linux container or VM: copies the read-only tree at $SRC (default /src) to a work directory of its own (so
# this host's native modules stay untouched), installs, builds what the tests import, and runs
# the suite with TAVI_SANDBOX_MATRIX naming the case the tests expect (srt, refused or nested).
#   mcp      the MCP stdio launcher's matrix
#   sandbox  sandbox.run, the policy compiler, host detection and the escape cases
#   limits   resource limits on a real cgroup v2 (root in a privileged container)
# IN_PLACE=1 runs in $SRC itself instead of a copy (the macOS job).
# Usage: suite.sh <mcp|sandbox>
set -euo pipefail

SUITE="${1:?usage: suite.sh <mcp|sandbox>}"
SRC="${SRC:-/src}"
WORK="${WORK:-$HOME/work/tavi}"
: "${TAVI_SANDBOX_MATRIX:?TAVI_SANDBOX_MATRIX names the expected case (srt, refused or nested)}"
case "$SUITE" in mcp | sandbox | limits) ;; *) echo "unknown suite: $SUITE (mcp, sandbox or limits)" >&2; exit 2 ;; esac
case "$TAVI_SANDBOX_MATRIX" in srt | refused | nested) ;; *) echo "unknown case: $TAVI_SANDBOX_MATRIX (srt, refused or nested)" >&2; exit 2 ;; esac
# The real-sandbox suites are opt-in outside the matrix.
export TAVI_REAL_TESTS=1

if [[ "${IN_PLACE:-}" == "1" ]]; then
  # This machine's own tree (the macOS job): its install, as it is.
  cd "$SRC"
else
  mkdir -p "$WORK" && cd "$WORK"
  tar -C "$SRC" --exclude=node_modules --exclude=.git --exclude="*/dist" --exclude=.turbo --exclude=reports -cf - . | tar -xf -
  pnpm install --frozen-lockfile --prefer-offline >/dev/null
fi

case "$SUITE" in
  mcp)
    pnpm --filter @tavi/contracts build >/dev/null
    tests="test/mcp/mcp-sandbox-matrix.test.ts"
    [[ "$TAVI_SANDBOX_MATRIX" == "srt" ]] && tests="$tests test/mcp/mcp-supervisor.test.ts"
    (cd apps/cli && pnpm exec vitest run $tests)
    ;;
  sandbox)
    # The owner's tests compose the runtime, which starts workers from the packages' builds.
    pnpm exec turbo run build --filter='@tavi/cli^...' >/dev/null
    # The sandbox package's own suites (the real-library and escape tests decide by platform and mode), then the owner's.
    (cd packages/builtin/sandbox && pnpm exec vitest run)
    # The PDF children under the owner's ConfinementPort: a stand-in child's escapes, and a real pdf.read.
    pnpm exec vitest run tests/integration/pdf-confined.real.test.ts
    # Plugin workers under the real srt: the escape cases from inside a worker.
    (cd packages/builtin/worker && pnpm exec vitest run)
    pnpm exec vitest run tests/integration/worker-sandbox.real.test.ts
    # The browser confined, with Playwright's Chromium kept in the module volume.
    (cd packages/builtin/browser && pnpm exec playwright install chromium >/dev/null)
    pnpm exec vitest run tests/integration/browser-confined.real.test.ts
    (cd apps/cli && pnpm exec vitest run test/sandbox/sandbox-host.test.ts test/sandbox/sandbox-isolation.test.ts test/mcp/mcp-sandbox-matrix.test.ts test/plugins/plugin-validate.test.ts)
    ;;
  limits)
    # Resource limits against a real cgroup v2 this process may delegate: root, with a cgroup namespace of its own.
    (cd packages/builtin/limits && TAVI_LIMITS_REAL=1 pnpm exec vitest run)
    ;;
esac
