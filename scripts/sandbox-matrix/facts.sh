#!/bin/sh
# What a sandbox-matrix job ran on:
# the kernel, the sysctls that decide user namespaces, the LSMs, and which
# bubblewrap, socat and ripgrep are found. Printed as `name: value` lines.
# POSIX sh: it runs inside containers and fresh VMs before anything is installed.
fact() { printf '%s: %s\n' "$1" "$2"; }
read_or() { if [ -r "$1" ]; then tr -d '\n' <"$1"; else printf '%s' "$2"; fi; }
fact uname "$(uname -srm)"
if [ -r /etc/os-release ]; then fact os "$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-unknown}")"; fi
fact kernel.apparmor_restrict_unprivileged_userns "$(read_or /proc/sys/kernel/apparmor_restrict_unprivileged_userns absent)"
fact kernel.unprivileged_userns_clone "$(read_or /proc/sys/kernel/unprivileged_userns_clone absent)"
fact user.max_user_namespaces "$(read_or /proc/sys/user/max_user_namespaces absent)"
fact kernel.io_uring_disabled "$(read_or /proc/sys/kernel/io_uring_disabled absent)"
fact lsm "$(read_or /sys/kernel/security/lsm unreadable)"
fact cgroup "$(if [ -f /sys/fs/cgroup/cgroup.controllers ]; then printf 'v2 (%s)' "$(tr -d '\n' </sys/fs/cgroup/cgroup.controllers)"; else printf 'not v2'; fi)"
seccomp="$(grep -m1 '^Seccomp:' /proc/self/status 2>/dev/null | awk '{print $2}')"
fact seccomp "${seccomp:-unknown}"
fact uid "$(id -u)"
for tool in bwrap socat rg node; do
  path="$(command -v "$tool" 2>/dev/null || true)"
  if [ -z "$path" ]; then fact "$tool" missing; continue; fi
  version="$("$path" --version 2>/dev/null | head -n1)"
  fact "$tool" "$path ${version:-}"
done
if [ -x /opt/tavi/libexec/bwrap ]; then fact tavi-bwrap "/opt/tavi/libexec/bwrap $(/opt/tavi/libexec/bwrap --version 2>/dev/null | head -n1)"; fi
