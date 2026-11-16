#!/usr/bin/env bash
# The sandbox matrix. It runs each job on this machine and keeps what it found under
# reports/sandbox-matrix/<job>/ (facts.txt: kernel, sysctls, bwrap; log.txt; result).
# .github/workflows/sandbox.yml calls it per job, unchanged.
#
#   typecheck            the workspace's typecheck and tests
#   macos-arm64          Seatbelt: the sandbox suite on this Mac
#   macos-x64            the same on an Intel Mac (pending elsewhere)
#   docker-default       Docker's default seccomp profile: the refused tier
#   docker-nested        user namespaces allowed, /proc masked: `nested` only with the flag
#   docker-unconfined    every namespace bubblewrap needs: `full` in a container
#   docker-cgroup        resource limits on a real cgroup v2: a privileged container, as root
#   arm64                docker-unconfined on linux/arm64 (srt's vendored arm64 filter)
#   ubuntu-24.04-restricted  apparmor_restrict_unprivileged_userns=1: refused, AppArmor cause
#   ubuntu-24.04-setup   the same after `tavi sandbox setup --apply`: full
#   ubuntu-26.04         stock (refused, unpriv_bwrap cause), then after setup (full)
#   debian-12            Debian's bwrap on 6.1: full
#   fedora-latest        SELinux enforcing; recorded, not gating
#   unit                 `tavi serve` under the generated unit (scripts/sandbox-matrix/unit.sh)
#
# VM jobs run in Lima (`brew install lima`; QEMU, with KVM or HVF where there is one) from
# the digest-pinned images in scripts/sandbox-matrix/images.conf.
#
# Usage: scripts/sandbox-matrix.sh list
#        scripts/sandbox-matrix.sh run <job>... | all
#        scripts/sandbox-matrix.sh pin <image> <arch> [url]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERE="$ROOT/scripts/sandbox-matrix"
REPORTS="${REPORTS:-$ROOT/reports/sandbox-matrix}"
IMAGES="$HERE/images.conf"
NODE_VERSION="22.21.0"
PNPM_VERSION="12.16.1"
JOBS="typecheck macos-arm64 macos-x64 docker-default docker-nested docker-unconfined docker-cgroup arm64 ubuntu-24.04-restricted ubuntu-24.04-setup ubuntu-26.04 debian-12 fedora-latest unit"
# Jobs whose failure is recorded but does not fail the run.
NOT_GATING="fedora-latest"

# A job that cannot run here yet says why in $PENDING (its exit status could be any command's).
pending() {
  echo "pending: $*" | tee "$PENDING"
}

host_arch() {
  case "$(uname -m)" in
    arm64 | aarch64) echo aarch64 ;;
    *) echo x86_64 ;;
  esac
}

# The pinned image line for <image> on this host's architecture: "<url> <sha256>".
image_of() {
  local image="$1" arch
  arch="$(host_arch)"
  awk -v image="$image" -v arch="$arch" '$1 == image && $2 == arch { print $3, $4 }' "$IMAGES"
}

pin() {
  local image="$1" arch="$2" url="${3:-}" line digest file
  line="$(awk -v image="$image" -v arch="$arch" '$1 == image && $2 == arch { print $3 }' "$IMAGES")"
  [[ -z "$url" ]] && url="$line"
  [[ -z "$url" ]] && { echo "no URL for $image $arch: give one" >&2; return 2; }
  file="$(mktemp)"
  curl -fL --retry 3 -o "$file" "$url"
  digest="$(shasum -a 256 "$file" | awk '{ print $1 }')"
  rm -f "$file"
  if [[ -n "$line" ]]; then
    awk -v image="$image" -v arch="$arch" -v url="$url" -v digest="$digest" '$1 == image && $2 == arch { print image, arch, url, digest; next } { print }' "$IMAGES" >"$IMAGES.new"
    mv "$IMAGES.new" "$IMAGES"
  else
    echo "$image $arch $url $digest" >>"$IMAGES"
  fi
  echo "$image $arch pinned at sha256:$digest"
}

# A Lima VM for <image>, its tree mounted read-only, Node and pnpm installed; prints its name.
vm_up() {
  local image="$1" name="tavi-sbx-$1" pinned url digest config
  command -v limactl >/dev/null || { echo "the VM jobs need Lima: brew install lima" >&2; return 2; }
  pinned="$(image_of "$image")"
  if [[ -z "$pinned" ]]; then pending "$image has no image for $(host_arch) in $IMAGES: scripts/sandbox-matrix.sh pin $image $(host_arch) <url>"; return 0; fi
  url="${pinned% *}"
  digest="${pinned#* }"
  if [[ "$digest" == "-" ]]; then pending "$image's image is not pinned: scripts/sandbox-matrix.sh pin $image $(host_arch)"; return 0; fi
  # A directory, not a file: GNU and BSD mktemp agree on a template ending in X.
  config="$(mktemp -d "${TMPDIR:-/tmp}/tavi-lima.XXXXXX")/$name.yaml"
  cat >"$config" <<YAML
images:
  - location: "$url"
    arch: "$(host_arch)"
    digest: "sha256:$digest"
cpus: 1
memory: "1GiB"
mounts:
  - location: "$ROOT"
    mountPoint: "/src"
    writable: false
containerd:
  system: false
  user: false
YAML
  limactl delete -f "$name" >/dev/null 2>&1 || true
  limactl start --tty=false --name="$name" "$config" >&2 || { rm -rf "$(dirname "$config")"; return 1; }
  rm -rf "$(dirname "$config")"
  limactl shell "$name" sudo sh -euc "
    if command -v apt-get >/dev/null; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap socat ripgrep curl xz-utils procps >/dev/null;
    else dnf install -y -q bubblewrap socat ripgrep curl xz procps-ng >/dev/null; fi
    arch=\$(uname -m); case \$arch in aarch64) node=arm64 ;; *) node=x64 ;; esac
    cd /tmp && curl -fsSLO https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-\$node.tar.xz && curl -fsSLO https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt
    grep \" node-v$NODE_VERSION-linux-\$node.tar.xz\$\" SHASUMS256.txt | sha256sum -c - >/dev/null
    tar -C /usr/local --strip-components=1 -xJf node-v$NODE_VERSION-linux-\$node.tar.xz
    npm install -g pnpm@$PNPM_VERSION >/dev/null
    # Chromium's system libraries, for the confined browser's suite, as the container image installs them.
    npx -y playwright@1.65.1 install-deps chromium >/dev/null" >&2 || return 1
  echo "$name"
}

vm_down() {
  [[ "${KEEP_VM:-}" == "1" ]] || limactl delete -f "$1" >/dev/null 2>&1 || true
}

# Inside a VM: the facts, then the sandbox suite expecting <mode>.
vm_suite() {
  local name="$1" mode="$2"
  limactl shell "$name" sh /src/scripts/sandbox-matrix/facts.sh
  limactl shell "$name" env TAVI_SANDBOX_MATRIX="$mode" CI=1 COREPACK_ENABLE_STRICT=0 bash /src/scripts/sandbox-matrix/suite.sh sandbox
}

# Inside a VM: the CLI built from the suite's copy, then `tavi sandbox setup --apply` as root.
vm_setup() {
  limactl shell "$1" bash -euc 'cd "$HOME/work/tavi" && pnpm exec turbo run build --filter=@tavi/cli >/dev/null' || return 1
  limactl shell "$1" bash -euc 'cd "$HOME/work/tavi" && sudo -E TAVI_NO_REBUILD=1 "$(command -v node)" scripts/tavi.mjs sandbox setup --apply'
}

# Whether the job is pending (a step said so): its later steps do not run.
is_pending() {
  [[ -s "$PENDING" ]]
}

job() {
  local job="$1" name
  case "$job" in
    typecheck)
      sh "$HERE/facts.sh"
      (cd "$ROOT" && pnpm typecheck && pnpm test)
      ;;
    macos-arm64 | macos-x64)
      local want=arm64
      [[ "$job" == "macos-x64" ]] && want=x86_64
      if [[ "$(uname)" != "Darwin" || "$(uname -m)" != "$want" ]]; then pending "needs a $want Mac"; return 0; fi
      sh "$HERE/facts.sh"
      OUT="$REPORTS/$job/cases" "$ROOT/scripts/mcp-sandbox-matrix.sh" mac sandbox
      ;;
    docker-default) OUT="$REPORTS/$job/cases" "$ROOT/scripts/mcp-sandbox-matrix.sh" linux-refused sandbox ;;
    docker-nested) OUT="$REPORTS/$job/cases" "$ROOT/scripts/mcp-sandbox-matrix.sh" linux-nested sandbox ;;
    docker-unconfined) OUT="$REPORTS/$job/cases" "$ROOT/scripts/mcp-sandbox-matrix.sh" linux-bwrap sandbox ;;
    docker-cgroup) OUT="$REPORTS/$job/cases" "$ROOT/scripts/mcp-sandbox-matrix.sh" linux-cgroup limits ;;
    arm64) DOCKER_PLATFORM=linux/arm64 OUT="$REPORTS/$job/cases" "$ROOT/scripts/mcp-sandbox-matrix.sh" linux-bwrap sandbox ;;
    ubuntu-24.04-restricted | ubuntu-24.04-setup)
      name="$(vm_up ubuntu-24.04)" || return $?
      is_pending && return 0
      local status=0
      # Forced and logged: a cloud image may ship it either way.
      limactl shell "$name" sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1 || status=$?
      if [[ "$status" == 0 ]]; then vm_suite "$name" refused || status=$?; fi
      if [[ "$status" == 0 && "$job" == "ubuntu-24.04-setup" ]]; then
        vm_setup "$name" || status=$?
        if [[ "$status" == 0 ]] && ! is_pending; then vm_suite "$name" srt || status=$?; fi
      fi
      vm_down "$name"
      return "$status"
      ;;
    ubuntu-26.04)
      name="$(vm_up ubuntu-26.04)" || return $?
      is_pending && return 0
      local status=0
      vm_suite "$name" refused || status=$?
      if [[ "$status" == 0 ]]; then vm_setup "$name" || status=$?; fi
      if [[ "$status" == 0 ]] && ! is_pending; then vm_suite "$name" srt || status=$?; fi
      vm_down "$name"
      return "$status"
      ;;
    debian-12 | fedora-latest)
      name="$(vm_up "$job")" || return $?
      is_pending && return 0
      local status=0
      if [[ "$job" == "fedora-latest" ]]; then limactl shell "$name" getenforce || status=$?; fi
      if [[ "$status" == 0 ]]; then vm_suite "$name" srt || status=$?; fi
      vm_down "$name"
      return "$status"
      ;;
    unit)
      # The generated unit on both systemd images: Ubuntu after setup, Debian as it is.
      local image status=0
      for image in ubuntu-24.04 debian-12; do
        name="$(vm_up "$image")" || return $?
        is_pending && return 0
        if [[ "$image" == "ubuntu-24.04" ]]; then
          # Forced, as in the restricted job: the image may ship it either way.
          limactl shell "$name" sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1 && vm_suite "$name" refused && vm_setup "$name" || status=$?
        else
          vm_suite "$name" srt || status=$?
          limactl shell "$name" bash -euc 'cd "$HOME/work/tavi" && pnpm exec turbo run build --filter=@tavi/cli >/dev/null' || status=$?
        fi
        if [[ "$status" == 0 ]] && ! is_pending; then
          limactl shell "$name" bash -euc 'sudo bash /src/scripts/sandbox-matrix/unit.sh "$(id -un)" "$HOME/work/tavi"' || status=$?
        fi
        vm_down "$name"
        [[ "$status" == 0 ]] || return "$status"
      done
      ;;
    *)
      echo "unknown job: $job (scripts/sandbox-matrix.sh list)" >&2
      return 2
      ;;
  esac
}

run() {
  local failed=0 job directory status
  for job in "$@"; do
    if [[ " $JOBS " != *" $job "* ]]; then echo "unknown job: $job (scripts/sandbox-matrix.sh list)" >&2; return 2; fi
  done
  for job in "$@"; do
    directory="$REPORTS/$job"
    rm -rf "$directory" && mkdir -p "$directory"
    echo "== $job"
    set +e
    (PENDING="$directory/pending" job "$job") >"$directory/log.txt" 2>&1
    status=$?
    set -e
    # The facts, as scripts/sandbox-matrix/facts.sh printed them, here or in a container's case log
    # (a two-phase job prints them twice).
    cat "$directory/log.txt" "$directory"/cases/*.txt 2>/dev/null | grep -E '^(uname|os|kernel\.[a-z_]+|user\.max_user_namespaces|lsm|cgroup|seccomp|uid|bwrap|socat|rg|node|tavi-bwrap): ' >"$directory/facts.txt" || true
    if [[ "$status" != 0 ]]; then echo "failed ($status)" >"$directory/result"
    elif [[ -s "$directory/pending" ]]; then cat "$directory/pending" >"$directory/result"
    else echo passed >"$directory/result"; fi
    echo "   $(cat "$directory/result") ($directory/log.txt)"
    if [[ "$status" != 0 && " $NOT_GATING " != *" $job "* ]]; then failed=1; fi
  done
  return "$failed"
}

case "${1:-list}" in
  list) for job in $JOBS; do echo "$job"; done ;;
  pin) shift; pin "$@" ;;
  run)
    shift
    [[ $# -eq 0 ]] && { echo "usage: scripts/sandbox-matrix.sh run <job>... | all" >&2; exit 2; }
    if [[ "$1" == "all" ]]; then set -- $JOBS; fi
    run "$@"
    ;;
  *)
    echo "usage: scripts/sandbox-matrix.sh list | run <job>... | all | pin <image> <arch> [url]" >&2
    exit 2
    ;;
esac
