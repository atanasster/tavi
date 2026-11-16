import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { parseArgs as parse } from "../../src/cli/parse.js";

import type { SandboxHostFacts as HostFacts } from "@tavi/contracts";
import { SANDBOX_USAGE } from "../../src/features/sandbox/parse.js";
import { SERVE_USAGE } from "../../src/server/parse.js";
import {
  hardeningHints,
  parentProxyChecks,
  sandboxDoctorSection,
  sandboxSectionText,
  setupPlan,
  verifyBwrapCopy,
} from "../../src/features/sandbox/setup.js";

/** `tavi sandbox setup` and the doctor's section. */

const ubuntu = (version: string, overrides: Partial<HostFacts> = {}): HostFacts => ({
  platform: "linux",
  inContainer: false,
  appArmorRestrictsUserNamespaces: version === "24.04",
  userNamespacesDisabled: false,
  kernelRelease: "6.8.0-45-generic",
  distribution: { id: "ubuntu", version },
  lsm: ["lockdown", "capability", "apparmor"],
  bwrap: { path: "/usr/bin/bwrap", version: "bubblewrap 0.9.0", owner: "distribution" },
  socat: "/usr/bin/socat",
  rg: "/usr/bin/rg",
  ...overrides,
});

describe("the setup block", () => {
  it("on restricted Ubuntu copies the package-owned bwrap under its own unconfined profile, never touching /usr/bin/bwrap's", () => {
    for (const version of ["24.04", "26.04"]) {
      const plan = setupPlan(ubuntu(version), { group: "tavi" });
      expect(plan.needed).toBe(true);
      expect(plan.script).toContain("install -o root -g 'tavi' -m 0750 \"$src\" /opt/tavi/libexec/bwrap");
      expect(plan.script).toContain('dpkg -S "$src"');
      expect(plan.script).toContain("profile tavi-bwrap /opt/tavi/libexec/bwrap flags=(unconfined) {");
      expect(plan.script).toContain("  userns,");
      expect(plan.script).toContain("apparmor_parser -r /etc/apparmor.d/tavi-bwrap");
      expect(plan.script).toContain("${Version}");
      // Never a profile for the distribution's binary, never a sysctl, never a copy from PATH.
      expect(plan.script).not.toMatch(/profile [^\n]*\/usr\/bin\/bwrap/);
      expect(plan.script).not.toContain("sysctl");
      expect(plan.script).not.toContain("command -v bwrap");
    }
  });

  it("installs only what is missing, and says when a host needs nothing", () => {
    const debian: HostFacts = {
      ...ubuntu("12"),
      distribution: { id: "debian", version: "12" },
      lsm: ["apparmor"],
      appArmorRestrictsUserNamespaces: false,
    };
    expect(setupPlan(debian, { group: "tavi" })).toEqual({ needed: false, steps: [expect.stringContaining("needs no setup")], script: "" });
    const bare = { ...debian } as Record<string, unknown>;
    delete bare["socat"];
    const plan = setupPlan(bare as unknown as HostFacts, { group: "tavi" });
    expect(plan.script).toContain("apt-get install -y socat");
    expect(plan.script).not.toContain("/opt/tavi");
  });

  it("on SELinux makes no copy unless asked, and then labels it bin_t with semanage before restorecon", () => {
    const fedora: HostFacts = {
      ...ubuntu("40"),
      distribution: { id: "fedora", version: "40" },
      lsm: ["selinux"],
      appArmorRestrictsUserNamespaces: false,
    };
    expect(setupPlan(fedora, { group: "tavi" }).needed).toBe(false);
    const copied = setupPlan(fedora, { group: "tavi", copy: true }).script;
    expect(copied).toContain("rpm -qf");
    expect(copied.indexOf("semanage fcontext -a -t bin_t")).toBeLessThan(copied.indexOf("restorecon -v"));
    expect(copied).not.toContain("apparmor");
  });

  it("removes what it made, and the apt hook only on request", () => {
    expect(setupPlan(ubuntu("24.04"), { group: "tavi" }).script).not.toContain("DPkg::Post-Invoke");
    expect(setupPlan(ubuntu("24.04"), { group: "tavi", refreshHook: true }).script).toContain("DPkg::Post-Invoke");
    const removal = setupPlan(ubuntu("24.04"), { group: "tavi", remove: true }).script;
    expect(removal).toContain("apparmor_parser -R /etc/apparmor.d/tavi-bwrap");
    expect(removal).toContain(
      "rm -f /etc/apt/apt.conf.d/99tavi-bwrap /opt/tavi/libexec/refresh-bwrap /opt/tavi/libexec/bwrap.source /opt/tavi/libexec/bwrap",
    );
  });

  it("quotes the group as one word for the root shell", () => {
    expect(setupPlan(ubuntu("24.04"), { group: "a'b" }).script).toContain("-g 'a'\\''b'");
  });

  it("needs nothing on macOS", () => {
    expect(
      setupPlan(
        { platform: "darwin", inContainer: false, appArmorRestrictsUserNamespaces: false, userNamespacesDisabled: false },
        { group: "staff" },
      ).needed,
    ).toBe(false);
  });
});

describe("the copy's verification", () => {
  const read = (overrides: Partial<Parameters<typeof verifyBwrapCopy>[0]> = {}): Parameters<typeof verifyBwrapCopy>[0] => ({
    exists: () => true,
    stat: () => ({ uid: 0, mode: 0o100750 }),
    sha256: () => "aa",
    record: () => ({ package: "bubblewrap", version: "0.9.0-1", sha256: "aa" }),
    profiles: () => "tavi-bwrap (unconfined)\n",
    executable: () => true,
    label: () => undefined,
    ...overrides,
  });

  it("passes a root-owned 0750 copy with its profile loaded and the distribution's bytes", () => {
    expect(verifyBwrapCopy(read()).every((check) => check.ok)).toBe(true);
    expect(verifyBwrapCopy(read({ exists: () => false }))).toEqual([]);
  });

  it("names each way it can go wrong, with the fix", () => {
    expect(
      verifyBwrapCopy(read({ stat: () => ({ uid: 1000, mode: 0o100755 }) })).find((check) => check.name === "bwrap copy"),
    ).toMatchObject({ ok: false, severity: "error" });
    expect(verifyBwrapCopy(read({ profiles: () => "" })).find((check) => check.name === "bwrap profile")).toMatchObject({
      ok: false,
      severity: "error",
    });
    expect(
      verifyBwrapCopy(read({ sha256: (path) => (path.startsWith("/opt") ? "aa" : "bb") })).find((check) => check.name === "bwrap drift"),
    ).toMatchObject({ ok: false, severity: "warning", detail: expect.not.stringMatching(/\(F\d+\)/) });
    expect(
      verifyBwrapCopy(read({ sha256: (path) => (path.startsWith("/opt") ? "aa" : "bb") })).find((check) => check.name === "bwrap drift"),
    ).toMatchObject({ detail: expect.stringContaining("tavi sandbox setup --apply") });
    expect(
      verifyBwrapCopy(read({ sha256: (path) => (path.startsWith("/opt") ? "cc" : "aa") })).find((check) => check.name === "bwrap drift"),
    ).toMatchObject({ ok: false, severity: "error" });
  });
});

describe("the doctor's section", () => {
  it("carries the tier, the platform, every check, the cause and fix, and what it affects", () => {
    const section = sandboxDoctorSection(
      {
        tier: "unavailable",
        mechanism: "bubblewrap",
        checks: [{ name: "live probe", ok: false, severity: "error", detail: "bwrap: setting up uid map: Permission denied" }],
        cause: "Ubuntu's AppArmor limits unprivileged user namespaces",
        fix: "tavi sandbox setup",
      },
      ubuntu("24.04"),
      [],
    );
    expect(section).toMatchObject({
      tier: "unavailable",
      mechanism: "bubblewrap",
      platform: "linux 6.8.0-45-generic (ubuntu 24.04)",
      fix: "tavi sandbox setup",
      affects: ["sandbox.run", "MCP stdio servers", "PDF parser and OCR children"],
    });
    expect(sandboxSectionText(section)).toMatch(/FAIL live probe: bwrap: setting up uid map/);
    expect(sandboxSectionText(section)).toMatch(/^fix: {3}tavi sandbox setup$/m);
  });

  it("carries the options the owner was started with, each only when it is on", () => {
    const section = sandboxDoctorSection({ tier: "full", checks: [] }, ubuntu("24.04"), [], undefined, undefined, {
      pinnedOff: true,
      localBind: true,
      pty: false,
    });
    expect(section["options"]).toEqual({ pinnedOff: true, localBind: true });
    expect(sandboxDoctorSection({ tier: "full", checks: [] }, ubuntu("24.04"), [])).not.toHaveProperty("options");
  });

  it("prints the caps in force: serve's --sandbox-memory, --sandbox-pids and --sandbox-cpu over the defaults", () => {
    const limits = { memory: "enforced", pids: "enforced", cpu: "enforced", rung: "delegated" } as const;
    const section = sandboxDoctorSection({ tier: "full", checks: [] }, ubuntu("24.04"), [], limits, {
      run: { memoryBytes: 128 * 1024 * 1024, processes: 64, cpuPercent: 50 },
    });
    expect(section["limits"]).toMatchObject({
      workloads: { run: "128 MiB, 64 pids, 50% of a core", worker: "256 MiB, 256 pids, 80% of a core" },
    });
  });
});

describe("the root blocks are valid shell", () => {
  it("parses every block this module writes", () => {
    const fedora: HostFacts = {
      ...ubuntu("40"),
      distribution: { id: "fedora", version: "40" },
      lsm: ["selinux"],
      appArmorRestrictsUserNamespaces: false,
    };
    for (const plan of [
      setupPlan(ubuntu("24.04"), { group: "tavi", refreshHook: true }),
      setupPlan(ubuntu("26.04"), { group: "tavi", remove: true }),
      setupPlan(fedora, { group: "tavi", copy: true }),
    ]) {
      const checked = spawnSync("sh", ["-n"], { input: plan.script, encoding: "utf8" });
      expect(checked.stderr).toBe("");
      expect(checked.status).toBe(0);
    }
  });

  it("says it makes the copy (the one thing --group is for) only when its block does", () => {
    expect(setupPlan(ubuntu("24.04"), { group: "tavi" }).copies).toBe(true);
    const { bwrap: _bwrap, ...noBwrap } = ubuntu("22.04");
    expect(setupPlan(noBwrap, { group: "tavi" })).toMatchObject({ needed: true, steps: ["install bubblewrap"] });
    expect(setupPlan(noBwrap, { group: "tavi" }).copies).toBeUndefined();
    expect(setupPlan({ ...ubuntu("22.04"), platform: "darwin" }, { group: "staff" }).copies).toBeUndefined();
    expect(setupPlan(ubuntu("24.04"), { group: "tavi", remove: true }).copies).toBeUndefined();
  });

  it("suggests closing io_uring in reader-facing words", () => {
    const [hint] = hardeningHints(ubuntu("24.04"), () => "0");
    expect(hint).toMatch(/^sysctl kernel\.io_uring_disabled=2 /);
    expect(hint).not.toMatch(/\(F\d+\)/);
    expect(hardeningHints(ubuntu("24.04"), () => "2")).toEqual([]);
  });

  it("on WSL2 says what keeps the distribution, and serve, running", () => {
    expect(hardeningHints(ubuntu("24.04", { wsl: 2 }), () => "2")).toEqual([expect.stringContaining("instanceIdleTimeout=-1")]);
  });

  it("makes the copy's folders root-owned and checks the source against its package", () => {
    const script = setupPlan(ubuntu("24.04"), { group: "tavi" }).script;
    expect(script).toContain("install -d -o root -g root -m 0755 /opt/tavi /opt/tavi/libexec");
    expect(script).toContain("dpkg --verify");
  });
});

describe("tavi sandbox", () => {
  it("parses its actions and refuses flags that do not go together", () => {
    expect(parse(["sandbox", "check", "--nested", "--format", "json"])).toMatchObject({
      command: "sandbox",
      sandbox: { action: "check", nested: true, format: "json" },
    });
    expect(parse(["sandbox", "setup", "--apply", "--group", "tavi", "--refresh-hook"])).toMatchObject({
      command: "sandbox",
      sandbox: { action: "setup", apply: true, group: "tavi", refreshHook: true },
    });
    expect(() => parse(["sandbox", "setup", "--remove", "--copy"])).toThrow(/--remove undoes setup/);
    expect(() => parse(["sandbox", "setup", "--data-dir", "/x"])).toThrow(/does not accept --data-dir/);
    // The usage marks it as check's alone, like the other action-specific options.
    expect(SANDBOX_USAGE).toMatch(/^ {2}--data-dir <path> +\(check\) /m);
    expect(() => parse(["sandbox", "check", "--apply"])).toThrow(/does not accept --apply/);
    expect(() => parse(["sandbox", "setup", "--group", "a b"])).toThrow(/group name/);
    expect(() => parse(["sandbox", "fix"])).toThrow(/Unknown sandbox action/);
  });

  it("parses a unit's credentials as name=absolute path", () => {
    expect(parse(["service", "unit", "--kind", "systemd", "--credential", "model-key=/etc/tavi/model.key"])).toMatchObject({
      service: { credentials: [{ name: "model-key", path: "/etc/tavi/model.key" }] },
    });
    expect(() => parse(["service", "unit", "--credential", "model-key=relative"])).toThrow(/<name>=<absolute path>/);
  });
});

describe("serve's sandbox flags", () => {
  it("gives --sandbox-credential's CA the lifetime it has: 30 days", () => {
    const help = SERVE_USAGE.replace(/\s+/g, " ");
    expect(help).toContain("their TLS alone is decrypted, with a 30-day CA of this owner's");
  });

  it("parses the nested mode, the off switch and sandbox.run's caps", () => {
    expect(
      parse([
        "serve",
        "--sandbox-nested",
        "--sandbox-tier",
        "unavailable",
        "--sandbox-memory",
        "128M",
        "--sandbox-pids",
        "64",
        "--sandbox-cpu",
        "50",
      ]),
    ).toMatchObject({
      serve: {
        sandboxNested: true,
        sandboxPinnedOff: true,
        sandboxLimits: { memoryBytes: 128 * 1024 * 1024, processes: 64, cpuPercent: 50 },
      },
    });
    // The video tools' FFmpeg and its confinement: absolute paths only.
    expect(
      parse(["serve", "--video-ffmpeg", "/opt/ff/ffmpeg", "--video-ffprobe=/opt/ff/ffprobe", "--video-allow-unconfined"]),
    ).toMatchObject({ serve: { video: { ffmpeg: "/opt/ff/ffmpeg", ffprobe: "/opt/ff/ffprobe", allowUnconfined: true } } });
    expect(() => parse(["serve", "--video-ffmpeg", "ffmpeg"])).toThrow(/absolute path/);
    expect(parse(["serve"])).not.toHaveProperty("serve.video");
    // The PDF children's: bare where the sandbox is unavailable only when the owner says so.
    expect(parse(["serve", "--pdf-allow-unconfined"])).toMatchObject({ serve: { pdf: { allowUnconfined: true } } });
    expect(parse(["serve"])).not.toHaveProperty("serve.pdf");
    expect(() => parse(["serve", "--sandbox-tier", "full"])).toThrow(/only "unavailable"/);
    expect(() => parse(["serve", "--sandbox-pids", "0"])).toThrow(/whole number from 1/);
  });

  it("parses the parent proxy sandbox.run's granted connections leave through, and says when one is set but unused", () => {
    expect(parse(["serve", "--sandbox-parent-proxy", "http://proxy.example:3128"])).toMatchObject({
      serve: { sandboxParentProxy: "http://proxy.example:3128" },
    });
    expect(() => parse(["serve", "--sandbox-parent-proxy", "proxy:3128"])).toThrow(/http:\/\/ or https:\/\//);
    expect(parentProxyChecks({ HTTPS_PROXY: "http://corp:3128" }, undefined)).toEqual([
      expect.objectContaining({
        ok: false,
        severity: "warning",
        detail: expect.stringContaining("--sandbox-parent-proxy http://corp:3128"),
      }),
    ]);
    expect(parentProxyChecks({}, undefined)).toEqual([]);
    // A password in the URL is never printed.
    expect(JSON.stringify(parentProxyChecks({ HTTPS_PROXY: "http://me:secret@corp:3128" }, undefined))).not.toContain("secret");
    expect(JSON.stringify(parentProxyChecks({}, "http://me:secret@corp:3128"))).not.toContain("secret");
    expect(parentProxyChecks({ HTTPS_PROXY: "x" }, "http://proxy:3128")).toEqual([expect.objectContaining({ ok: true })]);
  });

  it("parses the shared package cache and the registries preset", () => {
    expect(parse(["serve", "--sandbox-cache"])).toMatchObject({ serve: { sandboxCache: true } });
    expect(parse(["serve", "--sandbox-inspect-tls"])).toMatchObject({ serve: { sandboxInspectTls: true } });
    expect(parse(["serve"])).toEqual({ command: "serve", serve: { drainDeadlineMs: 10_000 } });
    expect(() => parse(["serve", "--sandbox-inspect-tls", "--sandbox-parent-proxy", "http://proxy.corp:3128"])).toThrow(
      /cannot be used with --sandbox-parent-proxy/,
    );
    expect(parse(["serve"])).not.toHaveProperty("serve.sandboxCache");
    expect(parse(["serve", "--sandbox-domain", "@registries"])).toMatchObject({ serve: { sandboxDomains: ["@registries"] } });
  });

  it("parses the macOS opt-ins: a pty and localhost for sandbox.run", () => {
    expect(parse(["serve", "--sandbox-pty", "--sandbox-local-bind"])).toMatchObject({
      serve: { sandboxLocal: { pty: true, localBind: true } },
    });
    expect(parse(["serve"])).not.toHaveProperty("serve.sandboxLocal");
  });

  it("parses sandbox.run's default and longest run time, in seconds", () => {
    expect(parse(["serve", "--sandbox-timeout", "300", "--sandbox-max-timeout", "1800"])).toMatchObject({
      serve: { sandboxTimeouts: { defaultMs: 300_000, maxMs: 1_800_000 } },
    });
    expect(parse(["serve"])).not.toHaveProperty("serve.sandboxTimeouts");
    expect(() => parse(["serve", "--sandbox-timeout", "900", "--sandbox-max-timeout", "600"])).toThrow(/cannot be longer/);
    expect(() => parse(["serve", "--sandbox-timeout", "900"])).toThrow(/cannot be longer.*default 600/);
    expect(() => parse(["serve", "--sandbox-timeout", "0"])).toThrow(/whole number from 1/);
  });
});
