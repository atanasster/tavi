#!/usr/bin/env bash
# The Home Assistant real run: a disposable Home Assistant in Docker with two
# lights (one in a Hallway area), a lock and a script exposed to Assist and its MCP server on, then
# apps/cli/test/mcp/mcp-homeassistant.live.test.ts against it. Everything it creates is test-only and removed after.
# Usage: scripts/mcp-homeassistant-live.sh [image tag, default 2026.10.1]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:-2026.10.1}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tavi-ha-live.XXXXXX")"
NAME="tavi-ha-live-$$"
PORT="${TAVI_HA_PORT:-18123}"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

mkdir -p "$WORK/config"
cp "$ROOT/scripts/mcp-homeassistant/configuration.yaml" "$ROOT/scripts/mcp-homeassistant/scripts.yaml" "$WORK/config/"
docker run -d --name "$NAME" -p "$PORT:8123" -v "$WORK/config:/config" "ghcr.io/home-assistant/home-assistant:$TAG" >/dev/null
for _ in $(seq 1 60); do
  curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/api/onboarding" | grep -q 200 && break
  sleep 3
done
TAVI_HA_URL="http://localhost:$PORT" node "$ROOT/scripts/mcp-homeassistant/setup.mjs" "$WORK/secrets.json"
cd "$ROOT/apps/cli"
TAVI_REAL_TESTS=1 TAVI_LIVE_HA="$WORK/secrets.json" TAVI_LIVE_HA_URL="http://localhost:$PORT/api/mcp" pnpm exec vitest run test/mcp/mcp-homeassistant.live.test.ts
