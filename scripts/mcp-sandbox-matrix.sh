#!/usr/bin/env bash
# The MCP sandbox matrix. The repository
# has no CI, so this stands in: it runs apps/cli/test/mcp/mcp-sandbox-matrix.test.ts
# on this Mac, then on Linux in Docker three ways:
#   bwrap    bubblewrap with the namespaces it needs (seccomp and AppArmor unconfined)
#   refused  Docker's default seccomp profile, where bubblewrap cannot create user namespaces
#   nested   user namespaces allowed but /proc masked (unprivileged), under srt's weaker nested mode
# The sandboxed cases also run the supervisor suite; with TAVI_LIVE_NETWORK=1 that
# includes the per-server network proof, which needs the network and Node 22.21+.
# The `sandbox` suite runs the sandbox's own tests in the same cases instead
# (scripts/sandbox-matrix.sh drives it per job).
# DOCKER_PLATFORM (e.g. linux/arm64) picks the containers' architecture.
# Each case's output goes to $OUT (default $TMPDIR/tavi-mcp-sandbox-matrix).
# Usage: scripts/mcp-sandbox-matrix.sh [mac|linux|linux-bwrap|linux-refused|linux-nested|all] [mcp|sandbox]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT:-${TMPDIR:-/tmp}/tavi-mcp-sandbox-matrix}"
IMAGE="tavi-mcp-sandbox-matrix:node22.21${DOCKER_PLATFORM:+-${DOCKER_PLATFORM//\//-}}"
WHICH="${1:-all}"
SUITE="${2:-mcp}"
case "$WHICH" in mac | linux | linux-bwrap | linux-refused | linux-nested | linux-cgroup | all) ;; *) echo "unknown case: $WHICH" >&2; exit 2 ;; esac
case "$SUITE" in mcp | sandbox | limits) ;; *) echo "unknown suite: $SUITE (mcp, sandbox or limits)" >&2; exit 2 ;; esac
mkdir -p "$OUT"

run_case() {
  local name="$1"; shift
  echo "== $name"
  if "$@" >"$OUT/$name.txt" 2>&1; then echo "   passed ($OUT/$name.txt)"; else echo "   FAILED ($OUT/$name.txt)"; FAILED=1; fi
}

FAILED=0

if [[ "$WHICH" == "mac" || "$WHICH" == "all" ]]; then
  if [[ "$(uname)" == "Darwin" ]]; then
    if [[ "$SUITE" == "sandbox" ]]; then
      run_case macos-srt env TAVI_SANDBOX_MATRIX=srt IN_PLACE=1 SRC="$ROOT" bash "$ROOT/scripts/sandbox-matrix/suite.sh" sandbox
    else
      run_case macos-srt env TAVI_SANDBOX_MATRIX=srt pnpm --dir "$ROOT/apps/cli" exec vitest run test/mcp/mcp-sandbox-matrix.test.ts test/mcp/mcp-supervisor.test.ts
    fi
  else
    echo "== macos-srt skipped: not on macOS"
  fi
fi

if [[ "$WHICH" == linux* || "$WHICH" == "all" ]]; then
  # One word or none (macOS ships bash 3.2, where an empty array trips `set -u`).
  PLATFORM="${DOCKER_PLATFORM:+--platform=$DOCKER_PLATFORM}"
  # Linux packages and a Linux node_modules of its own, so this tree's (macOS) native modules stay untouched.
  docker build -q $PLATFORM -t "$IMAGE" - <<'DOCKERFILE' >/dev/null
FROM node:22.21.0-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap socat ripgrep procps && rm -rf /var/lib/apt/lists/*
# Chromium's system libraries, for the confined browser's tests; the browser itself is in the module volume.
RUN npx -y playwright@1.65.1 install-deps chromium && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_BROWSERS_PATH=/home/runner/work/ms-playwright
RUN npm install -g pnpm@12.16.1 && useradd -m runner && mkdir -p /home/runner/work && chown runner /home/runner/work
USER runner
DOCKERFILE
  linux() {
    local mode="$1"; shift
    docker run --rm $PLATFORM "$@" -e TAVI_SANDBOX_MATRIX="$mode" -e TAVI_LIVE_NETWORK="${TAVI_LIVE_NETWORK:-}" -e CI=1 -e COREPACK_ENABLE_STRICT=0 \
      -v "$ROOT:/src:ro" -v "tavi-mcp-matrix-modules${DOCKER_PLATFORM:+-${DOCKER_PLATFORM//\//-}}:/home/runner/work" "$IMAGE" bash -euc "
        sh /src/scripts/sandbox-matrix/facts.sh
        bash /src/scripts/sandbox-matrix/suite.sh $SUITE"
  }
  wanted() { [[ "$WHICH" == "linux" || "$WHICH" == "all" || "$WHICH" == "$1" ]]; }
  if wanted linux-bwrap; then run_case linux-bwrap linux srt --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined; fi
  if wanted linux-refused; then run_case linux-refused linux refused; fi
  if wanted linux-nested; then run_case linux-nested linux nested --security-opt seccomp=unconfined --security-opt apparmor=unconfined; fi
  # Resource limits: root in a privileged container with a cgroup namespace of its own, so it may delegate its cgroup.
  if [[ "$WHICH" == "linux-cgroup" ]]; then run_case linux-cgroup linux srt --privileged --cgroupns=private -u 0; fi
fi

exit "$FAILED"
