#!/usr/bin/env bash
# The sandbox under the generated systemd unit,
# inside a Linux VM with systemd, as root (scripts/sandbox-matrix.sh's `unit` job runs it).
#
# 1. Renders `tavi service unit --kind systemd` for the VM's ordinary user and reads back its
#    hardening directives.
# 2. Runs the sandbox package's suite (the live probe, E1-E19, F-N1, F-N2) under exactly those
#    directives with `systemd-run`, as that user: the baseline, which must pass, with AF_ALG
#    refused (E17 under the unit).
# 3. Adds each directive the unit leaves out, one at a time, and records how the live probe fares
#    under it, so the unit's "never" list is evidence, not belief.
# Usage (root, in the VM): unit.sh <user> <work tree>
set -euo pipefail

USER_NAME="${1:?usage: unit.sh <user> <work tree>}"
SOURCE="${2:?usage: unit.sh <user> <work tree>}"
# Outside /home, so the unit renders with ProtectHome=read-only, as a default install would.
WORK=/srv/tavi-unit-work
rm -rf "$WORK" && mkdir -p "$WORK" && cp -a "$SOURCE/." "$WORK/" && chown -R "$USER_NAME" "$WORK"
DATA="$(mktemp -d /var/tmp/tavi-unit-data.XXXXXX)"
chown "$USER_NAME" "$DATA"
NODE_BIN="$(command -v node)"
cd "$WORK"

unit="$(sudo -u "$USER_NAME" env TAVI_NO_REBUILD=1 "$NODE_BIN" scripts/tavi.mjs service unit --kind systemd --user "$USER_NAME" --data-dir "$DATA" --serve-arg=--fs-root --serve-arg="$WORK")"
echo "== the generated unit"
echo "$unit"

# The [Service] directives that confine: everything but how the process starts and logs.
properties=()
while IFS= read -r line; do
  case "$line" in
    ""|"#"*|"["*|ExecStart=*|Type=*|Restart=*|RestartSec=*|Environment=*|StandardOutput=*|StandardError=*|User=*|Group=*|WantedBy=*|Description=*|After=*) ;;
    *) properties+=(-p "$line") ;;
  esac
done <<<"$unit"

run_suite() {
  local label="$1"; shift
  echo "== $label"
  systemd-run --wait --pipe --collect --quiet -p User="$USER_NAME" -p WorkingDirectory="$WORK/packages/builtin/sandbox" "${properties[@]}" "$@" \
    /usr/bin/env PATH="$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin" HOME="$WORK" TAVI_SANDBOX_MATRIX=srt TAVI_REAL_TESTS=1 TAVI_UNDER_UNIT=1 CI=1 \
    "$NODE_BIN" "$WORK/node_modules/.bin/vitest" run ${TESTS:-}
}

# The baseline: the whole package suite under the unit.
status=0
run_suite "baseline: the sandbox suite under the generated unit" || status=$?
echo "baseline exit: $status"

# Each directive the unit leaves out, alone, against the live probe.
echo "== the directives the unit leaves out, one at a time"
printf '| Directive | Live probe under it |\n|---|---|\n' >/tmp/tavi-unit-negative.md
for directive in "RestrictNamespaces=yes" "PrivateUsers=yes" "MemoryDenyWriteExecute=yes" "ProtectControlGroups=yes" \
  "SystemCallFilter=@system-service" "SystemCallFilter=~@aio" "ProtectKernelTunables=yes" "ProtectKernelLogs=yes" \
  "ProtectProc=invisible" "ProcSubset=pid"; do
  set +e
  output="$(TESTS="test/host.real.test.ts" run_suite "with $directive" -p "$directive" 2>&1)"
  code=$?
  set -e
  echo "$output" | tail -n 15
  verdict="passes"
  if [[ "$code" != 0 ]]; then
    reason="$(echo "$output" | grep -m1 -E 'Error|denied|EPERM|SIGSYS|not permitted|uid map' || true)"
    verdict="fails (exit $code): $(echo "${reason:-no message}" | tr '|' '/' | cut -c1-160)"
  fi
  printf '| `%s` | %s |\n' "$directive" "$verdict" >>/tmp/tavi-unit-negative.md
done
cat /tmp/tavi-unit-negative.md
rm -rf "$DATA" "$WORK"
exit "$status"
