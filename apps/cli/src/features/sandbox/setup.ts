import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";

import type {
  LimitWorkload,
  ResourceLimitCapabilities,
  ResourceLimits,
  SandboxHostCheck,
  SandboxHostFacts as HostFacts,
  SandboxPort,
  SandboxStatus,
} from "@tavi/contracts";
import { sha256Hex, WSL_KEEP_RUNNING } from "@tavi/node-kit";

import { TAVI_BWRAP, WORKLOAD_DEFAULTS } from "./host.js";
import { redactedUrl } from "./parent-proxy.js";

/** Each workload's caps in force, the operator's over the defaults, as doctor prints them (`pids.max` counts threads, so it is set per workload). */
function workloadLines(overrides: Partial<Record<LimitWorkload, ResourceLimits>> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(WORKLOAD_DEFAULTS).map(([workload, defaults]) => {
      const caps = { ...defaults, ...overrides[workload as LimitWorkload] };
      return [
        workload,
        `${String(Math.round(caps.memoryBytes / 1024 / 1024))} MiB, ${String(caps.processes)} pids, ${String(caps.cpuPercent)}% of a core`,
      ];
    }),
  );
}

/**
 * `tavi sandbox setup` and the doctor's `sandbox` section. Setup is one idempotent root block the
 * operator reads before anything runs: the tools srt needs, and on Ubuntu with
 * the user-namespace restriction a Tavi-owned copy of the distribution's
 * bubblewrap under its own unconfined AppArmor profile — never a profile for
 * `/usr/bin/bwrap` (LP#2046844), never a sysctl change.
 */

const DISTRIBUTION_BWRAP = "/usr/bin/bwrap";
const PROFILE = "/etc/apparmor.d/tavi-bwrap";
const SOURCE_RECORD = `${TAVI_BWRAP}.source`;
const APT_HOOK = "/etc/apt/apt.conf.d/99tavi-bwrap";
const REFRESH_SCRIPT = "/opt/tavi/libexec/refresh-bwrap";

export interface SetupOptions {
  /** The service account's group, which may run the copy (mode 0750). */
  readonly group: string;
  /** Undo what setup did. */
  readonly remove?: boolean;
  /** Make the copy even where no AppArmor restriction needs it (an SELinux host's operator choice). */
  readonly copy?: boolean;
  /** Re-copy after every apt run (persistent package-manager configuration, so only on request). */
  readonly refreshHook?: boolean;
}

export interface SetupPlan {
  /** Whether this host needs anything at all. */
  readonly needed: boolean;
  /** What the block does, one line each, for the operator to read first. */
  readonly steps: readonly string[];
  /** The block, for `sudo sh -c`; empty when nothing is needed. */
  readonly script: string;
  /** Whether the block makes the Tavi-owned bubblewrap copy, the one thing `--group` is for. */
  readonly copies?: boolean;
}

const restricted = (facts: HostFacts): boolean =>
  facts.appArmorRestrictsUserNamespaces ||
  (facts.distribution?.id === "ubuntu" && (facts.lsm ?? []).includes("apparmor") && ubuntuAtLeast(facts, 25, 4));

function ubuntuAtLeast(facts: HostFacts, major: number, minor: number): boolean {
  const [year = 0, month = 0] = (facts.distribution?.version ?? "").split(".").map(Number);
  return year > major || (year === major && month >= minor);
}

const selinux = (facts: HostFacts): boolean => (facts.lsm ?? []).includes("selinux");
const apt = (facts: HostFacts): boolean =>
  ["ubuntu", "debian"].includes(facts.distribution?.id ?? "") || facts.distribution?.id === undefined;

/** A word a root shell takes as one argument. */
function shellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The setup block for this host: only what it needs; idempotent; `--remove` undoes it. */
export function setupPlan(facts: HostFacts, options: SetupOptions): SetupPlan {
  if (facts.platform !== "linux")
    return { needed: false, steps: [`${facts.platform} needs no setup: the sandbox is Seatbelt, part of the system`], script: "" };
  const group = shellWord(options.group);
  if (options.remove === true) {
    const script = [
      "set -eu",
      `if [ -f ${PROFILE} ]; then apparmor_parser -R ${PROFILE} 2>/dev/null || true; rm -f ${PROFILE}; fi`,
      `rm -f ${APT_HOOK} ${REFRESH_SCRIPT} ${SOURCE_RECORD} ${TAVI_BWRAP}`,
      "rmdir /opt/tavi/libexec /opt/tavi 2>/dev/null || true",
      "if command -v semanage >/dev/null 2>&1; then semanage fcontext -d /opt/tavi/libexec/bwrap 2>/dev/null || true; fi",
    ].join("\n");
    return { needed: true, steps: [`remove ${PROFILE}, ${TAVI_BWRAP} and its record, and the apt hook if there is one`], script };
  }
  const steps: string[] = [];
  const lines = ["set -eu"];
  const missing = [
    facts.bwrap === undefined ? "bubblewrap" : undefined,
    facts.socat === undefined ? "socat" : undefined,
    facts.rg === undefined ? "ripgrep" : undefined,
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) {
    steps.push(`install ${missing.join(", ")}`);
    lines.push(
      apt(facts) ? `DEBIAN_FRONTEND=noninteractive apt-get install -y ${missing.join(" ")}` : `dnf install -y ${missing.join(" ")}`,
    );
  }
  const copy = restricted(facts) || options.copy === true;
  if (copy) {
    steps.push(
      `copy the package-owned ${DISTRIBUTION_BWRAP} to ${TAVI_BWRAP} (root, group ${options.group}, mode 0750), recording its package version and SHA-256 in ${SOURCE_RECORD}`,
    );
    lines.push(
      `src=${DISTRIBUTION_BWRAP}`,
      // Only the package-owned binary: never one found on PATH, which a user could have planted.
      `[ "$(stat -c %u "$src")" = 0 ] || { echo "$src is not owned by root" >&2; exit 1; }`,
      `case "$(stat -c %A "$src")" in ?????w????|????????w?) echo "$src is group- or world-writable" >&2; exit 1;; esac`,
      // The package that owns it, failing the block when none does; its files must match the package's own record.
      apt(facts) ? `owner_package=$(dpkg -S "$src")` : `owner_package=$(rpm -qf "$src")`,
      apt(facts) ? `owner_package=\${owner_package%%:*}` : ":",
      apt(facts)
        ? `[ -z "$(dpkg --verify "$owner_package" 2>&1 | grep " $src$" || true)" ] || { echo "$src does not match its package" >&2; exit 1; }`
        : `rpm -V "$owner_package" | grep -q " $src$" && { echo "$src does not match its package" >&2; exit 1; } || true`,
      apt(facts)
        ? `version=$(dpkg-query -W -f='\${Version}' "$owner_package")`
        : `version=$(rpm -q --qf '%{VERSION}-%{RELEASE}' "$owner_package")`,
      // Root-owned all the way down: the profile attaches by path, so whoever could write /opt/tavi could swap the binary it covers.
      "install -d -o root -g root -m 0755 /opt/tavi /opt/tavi/libexec",
      "chown root:root /opt/tavi /opt/tavi/libexec && chmod 0755 /opt/tavi /opt/tavi/libexec",
      // A real copy: a hard link cannot carry its own owner and mode.
      `install -o root -g ${group} -m 0750 "$src" ${TAVI_BWRAP}`,
      `printf 'package=%s\\nversion=%s\\nsha256=%s\\n' "$owner_package" "$version" "$(sha256sum ${TAVI_BWRAP} | cut -d' ' -f1)" > ${SOURCE_RECORD}`,
      `chmod 0644 ${SOURCE_RECORD}`,
    );
    if (restricted(facts)) {
      steps.push(`write ${PROFILE}, an unconfined AppArmor profile with userns for ${TAVI_BWRAP} alone, and load it`);
      lines.push(
        `cat > ${PROFILE} <<'PROFILE'`,
        "abi <abi/4.0>,",
        "include <tunables/global>",
        `profile tavi-bwrap ${TAVI_BWRAP} flags=(unconfined) {`,
        "  userns,",
        "  include if exists <local/tavi-bwrap>",
        "}",
        "PROFILE",
        `apparmor_parser -r ${PROFILE}`,
      );
    }
    if (selinux(facts)) {
      // restorecon alone re-applies /opt's default label.
      steps.push(`label ${TAVI_BWRAP} bin_t for SELinux`);
      lines.push(
        `semanage fcontext -a -t bin_t ${TAVI_BWRAP} 2>/dev/null || semanage fcontext -m -t bin_t ${TAVI_BWRAP}`,
        `restorecon -v ${TAVI_BWRAP}`,
      );
    }
    if (options.refreshHook === true && apt(facts)) {
      // A script of its own: it compares contents (dpkg sets a package's build time as a file's mtime) and rewrites the record doctor checks.
      steps.push(`add ${APT_HOOK} and ${REFRESH_SCRIPT}, which re-copy bubblewrap and its record when an apt run changed it`);
      lines.push(
        `cat > ${REFRESH_SCRIPT} <<'REFRESH'`,
        "#!/bin/sh",
        "set -eu",
        `[ -x ${TAVI_BWRAP} ] || exit 0`,
        `cmp -s ${DISTRIBUTION_BWRAP} ${TAVI_BWRAP} && exit 0`,
        `owner_package=$(dpkg -S ${DISTRIBUTION_BWRAP}); owner_package=\${owner_package%%:*}`,
        `install -o root -g "$(stat -c %G ${TAVI_BWRAP})" -m 0750 ${DISTRIBUTION_BWRAP} ${TAVI_BWRAP}`,
        `printf 'package=%s\\nversion=%s\\nsha256=%s\\n' "$owner_package" "$(dpkg-query -W -f='\${Version}' "$owner_package")" "$(sha256sum ${TAVI_BWRAP} | cut -d' ' -f1)" > ${SOURCE_RECORD}`,
        "REFRESH",
        `chown root:root ${REFRESH_SCRIPT} && chmod 0755 ${REFRESH_SCRIPT}`,
        `cat > ${APT_HOOK} <<'HOOK'`,
        `DPkg::Post-Invoke { "${REFRESH_SCRIPT}"; };`,
        "HOOK",
      );
    }
  }
  if (steps.length === 0)
    return {
      needed: false,
      steps: ["this host needs no setup: bubblewrap, socat and ripgrep are installed, and nothing restricts user namespaces"],
      script: "",
    };
  return { needed: true, steps, script: lines.join("\n"), ...(copy ? { copies: true } : {}) };
}

/** The Tavi-owned copy's record, if setup wrote one. */
function sourceRecord(): Record<string, string> | undefined {
  try {
    return Object.fromEntries(
      readFileSync(SOURCE_RECORD, "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
  } catch {
    return undefined;
  }
}

const sha256Of = (path: string): string | undefined => {
  try {
    return sha256Hex(readFileSync(path));
  } catch {
    return undefined;
  }
};

/**
 * The Tavi-owned copy, checked: root-owned, 0750, its profile
 * loaded, and the same bytes as both its record and the distribution's current
 * bubblewrap. Drift after an upgrade is a warning, with the fix.
 */
export interface CopyReader {
  readonly exists: (path: string) => boolean;
  readonly stat: (path: string) => { readonly uid: number; readonly mode: number } | undefined;
  readonly sha256: (path: string) => string | undefined;
  readonly record: () => Record<string, string> | undefined;
  /** The loaded AppArmor profiles; undefined when this process cannot read them (root only). */
  readonly profiles: () => string | undefined;
  /** Whether this process may execute `path` (the service account must). */
  readonly executable: (path: string) => boolean;
  /** The file's SELinux label, where there is one. */
  readonly label: (path: string) => string | undefined;
}

const nodeCopyReader: CopyReader = {
  exists: existsSync,
  stat: (path) => {
    try {
      const stat = statSync(path);
      return { uid: stat.uid, mode: stat.mode };
    } catch {
      return undefined;
    }
  },
  sha256: sha256Of,
  record: sourceRecord,
  profiles: () => {
    try {
      return readFileSync("/sys/kernel/security/apparmor/profiles", "utf8");
    } catch {
      return undefined;
    }
  },
  executable: (path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  label: (path) => {
    const read = spawnSync("stat", ["-c", "%C", path], { encoding: "utf8", timeout: 2_000 });
    return read.status === 0 ? read.stdout.trim() : undefined;
  },
};

/**
 * The Tavi-owned copy, checked: root-owned, 0750, in
 * root-owned folders, executable by this (the service) account, its profile
 * loaded, on SELinux labelled `bin_t`, and the same bytes as both its record
 * and the distribution's current bubblewrap. Drift after an upgrade is a
 * warning, with the fix.
 */
export function verifyBwrapCopy(read: CopyReader = nodeCopyReader, facts?: Pick<HostFacts, "lsm">): readonly SandboxHostCheck[] {
  if (!read.exists(TAVI_BWRAP)) return [];
  const fix = "tavi sandbox setup --apply  (re-copies it from the distribution's bubblewrap)";
  const checks: SandboxHostCheck[] = [];
  const stat = read.stat(TAVI_BWRAP);
  const folders = ["/opt/tavi", "/opt/tavi/libexec"].map((path) => read.stat(path));
  const safeFolders = folders.every((folder) => folder !== undefined && folder.uid === 0 && (folder.mode & 0o022) === 0);
  checks.push(
    stat !== undefined && stat.uid === 0 && (stat.mode & 0o777) === 0o750 && safeFolders
      ? { name: "bwrap copy", ok: true, detail: `${TAVI_BWRAP} root-owned, 0750` }
      : {
          name: "bwrap copy",
          ok: false,
          severity: "error",
          detail: `${TAVI_BWRAP} must be root-owned with mode 0750, in root-owned folders nobody else can write; ${fix}`,
        },
  );
  if (!read.executable(TAVI_BWRAP))
    checks.push({
      name: "bwrap access",
      ok: false,
      severity: "error",
      detail: `this account cannot run ${TAVI_BWRAP}: its group is not one of yours; tavi sandbox setup --apply --group <the service's group>`,
    });
  const profiles = read.profiles();
  checks.push(
    profiles === undefined
      ? {
          name: "bwrap profile",
          ok: true,
          detail:
            "loaded profiles are readable by root only; the live probe shows whether the copy works (sudo aa-status lists tavi-bwrap)",
        }
      : profiles.includes("tavi-bwrap")
        ? { name: "bwrap profile", ok: true }
        : { name: "bwrap profile", ok: false, severity: "error", detail: `the tavi-bwrap AppArmor profile is not loaded; ${fix}` },
  );
  if ((facts?.lsm ?? []).includes("selinux")) {
    const label = read.label(TAVI_BWRAP);
    checks.push(
      label?.includes(":bin_t:") === true
        ? { name: "bwrap label", ok: true, detail: label }
        : {
            name: "bwrap label",
            ok: false,
            severity: "error",
            detail: `${TAVI_BWRAP} is labelled ${label ?? "unknown"}, not bin_t; tavi sandbox setup --apply --copy`,
          },
    );
  }
  const record = read.record();
  const copied = read.sha256(TAVI_BWRAP);
  const current = read.sha256(DISTRIBUTION_BWRAP);
  if (record === undefined || copied === undefined)
    checks.push({ name: "bwrap drift", ok: false, severity: "warning", detail: `no record of where ${TAVI_BWRAP} came from; ${fix}` });
  else if (record["sha256"] !== copied)
    checks.push({ name: "bwrap drift", ok: false, severity: "error", detail: `${TAVI_BWRAP} is not the binary setup copied; ${fix}` });
  else if (current !== undefined && current !== copied)
    checks.push({
      name: "bwrap drift",
      ok: false,
      severity: "warning",
      detail: `the distribution's bubblewrap changed since setup copied ${record["version"] ?? "it"}: the copy misses its updates; ${fix}`,
    });
  else
    checks.push({
      name: "bwrap drift",
      ok: true,
      detail: `copied from ${record["package"] ?? "bubblewrap"} ${record["version"] ?? ""}`.trim(),
    });
  return checks;
}

/** Host hardening and upkeep `doctor` may suggest, never require (on WSL2, what keeps it running); `ioUringDisabled` reads the kernel's setting. */
export function hardeningHints(facts: HostFacts, ioUringDisabled: () => string | undefined = readIoUringDisabled): readonly string[] {
  if (facts.platform !== "linux") return [];
  return [
    ...(ioUringDisabled() === "0" ? ["sysctl kernel.io_uring_disabled=2 closes io_uring to the whole host; Node falls back to epoll"] : []),
    ...(facts.wsl === 2 ? [WSL_KEEP_RUNNING] : []),
  ];
}

function readIoUringDisabled(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/io_uring_disabled", "utf8").trim();
  } catch {
    return undefined;
  }
}

/** What the engine could not express here (srt's glob warnings, an entry a run's compile dropped), as the doctor lists it. */
export function engineWarnings(sandbox: Pick<SandboxPort, "capabilities">): readonly SandboxHostCheck[] {
  return (sandbox.capabilities().checks ?? []).filter((check) => check.name === "policy compile");
}

/** The sandbox options a `serve` was started with, for `doctor`: each one only when it is on. */
export interface SandboxOwnerOptions {
  /** `--sandbox-tier unavailable` or `TAVI_SANDBOX=off`: `sandbox.run` is refused whatever the host could do. */
  readonly pinnedOff?: boolean;
  readonly nested?: boolean;
  readonly pty?: boolean;
  readonly localBind?: boolean;
  readonly inspectTls?: boolean;
  readonly cache?: boolean;
}

/** Each option's flag, as `doctor --format text` names it. */
export const SANDBOX_OPTION_FLAGS: Readonly<Record<keyof SandboxOwnerOptions, string>> = {
  pinnedOff: "--sandbox-tier unavailable",
  nested: "--sandbox-nested",
  pty: "--sandbox-pty",
  localBind: "--sandbox-local-bind",
  inspectTls: "--sandbox-inspect-tls",
  cache: "--sandbox-cache",
};

/** The doctor's `sandbox` section: one answer for every consumer, with its cause, fix and what it affects. */
export function sandboxDoctorSection(
  status: SandboxStatus,
  facts: HostFacts,
  copyChecks: readonly SandboxHostCheck[] = verifyBwrapCopy(nodeCopyReader, facts),
  limits?: ResourceLimitCapabilities,
  overrides?: Partial<Record<LimitWorkload, ResourceLimits>>,
  ownerOptions?: SandboxOwnerOptions,
): Record<string, unknown> {
  const distribution =
    facts.distribution === undefined
      ? ""
      : ` (${facts.distribution.id}${facts.distribution.version === undefined ? "" : ` ${facts.distribution.version}`})`;
  const hints = hardeningHints(facts);
  return {
    tier: status.tier,
    ...(status.mechanism === undefined ? {} : { mechanism: status.mechanism }),
    platform: `${facts.platform} ${facts.kernelRelease ?? ""}${distribution}`.trim(),
    checks: [...status.checks, ...copyChecks],
    ...(status.cause === undefined ? {} : { cause: status.cause }),
    ...(status.fix === undefined ? {} : { fix: status.fix }),
    affects: ["sandbox.run", "MCP stdio servers", "PDF parser and OCR children"],
    // How each child is bounded here, and each workload's caps.
    ...(limits === undefined
      ? {}
      : {
          limits: {
            ...limits,
            ...(limits.aggregateMemoryBytes === undefined
              ? {}
              : { aggregateMemoryMiB: Math.round(limits.aggregateMemoryBytes / 1024 / 1024) }),
            workloads: workloadLines(overrides),
          },
        }),
    ...(hints.length === 0 ? {} : { hardening: hints }),
    // What the owner was started with: the off switch above all, which refuses sandbox.run whatever the tier says.
    ...(ownerOptions === undefined ? {} : { options: Object.fromEntries(Object.entries(ownerOptions).filter(([, on]) => on === true)) }),
  };
}

/**
 * What the owner's proxy settings mean for a networked `sandbox.run`: a proxy
 * in the owner's environment is never used (granted connections dial out
 * directly), so a host that can only reach out through one needs
 * `serve --sandbox-parent-proxy`.
 */
export function parentProxyChecks(env: Readonly<Record<string, string | undefined>>, parentProxy: string | undefined): SandboxHostCheck[] {
  if (parentProxy !== undefined)
    return [
      {
        name: "parent proxy",
        ok: true,
        detail: `granted connections leave through ${redactedUrl(parentProxy)}; a credential host's are dialed directly (srt does not yet send those through a parent proxy)`,
      },
    ];
  const named = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].find((name) => (env[name] ?? "") !== "");
  if (named === undefined) return [];
  return [
    {
      name: "parent proxy",
      ok: false,
      severity: "warning",
      detail: `${named} is set for the owner, but sandbox.run's granted connections dial out directly; if this host reaches the web only through it, start serve with --sandbox-parent-proxy ${redactedUrl(env[named] ?? "")}`,
    },
  ];
}

/** The section as text, for `tavi sandbox check`. */
export function sandboxSectionText(section: Record<string, unknown>): string {
  const lines = [
    `sandbox: ${String(section["tier"])}${section["mechanism"] === undefined ? "" : ` (${String(section["mechanism"])})`} on ${String(section["platform"])}`,
  ];
  for (const check of (section["checks"] as readonly SandboxHostCheck[] | undefined) ?? []) {
    lines.push(
      `  ${check.ok ? "ok  " : check.severity === "warning" ? "warn" : "FAIL"} ${check.name}${check.detail === undefined ? "" : `: ${check.detail}`}`,
    );
  }
  if (section["cause"] !== undefined) lines.push(`cause: ${String(section["cause"])}`);
  if (section["fix"] !== undefined) lines.push(`fix:   ${String(section["fix"])}`);
  for (const hint of (section["hardening"] as readonly string[] | undefined) ?? []) lines.push(`hint:  ${hint}`);
  return `${lines.join("\n")}\n`;
}
