import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  FAILED_PROBE_TTL_MS,
  classifySandboxFailure,
  createSandboxHost,
  hostChecks,
  hostFacts,
  probeSandbox,
  runSrt,
  srtInstalledUnder,
  type HostFacts,
  type ProbeResult,
} from "../src/host.js";
import { helperPath, srtHelperConfig } from "../src/paths.js";

const temp = temporaryDirectories();
afterEach(() => temp.cleanup());

/** Host detection: the cause table, hard errors against warnings, and one cached answer. */

/** A Linux host with every tool, `overrides` laid over it and the `missing` facts left out. */
const linux = (overrides: Partial<HostFacts> = {}, missing: readonly (keyof HostFacts)[] = []): HostFacts => {
  const facts: Record<string, unknown> = { ...LINUX, ...overrides };
  for (const key of missing) delete facts[key];
  return facts as unknown as HostFacts;
};

const LINUX: HostFacts = {
  platform: "linux",
  inContainer: false,
  appArmorRestrictsUserNamespaces: false,
  userNamespacesDisabled: false,
  bwrap: { path: "/usr/bin/bwrap", version: "bubblewrap 0.9.0", owner: "distribution" },
  socat: "/usr/bin/socat",
  rg: "/usr/bin/rg",
  seccompAvailable: true,
};

describe("the cause table", () => {
  it("names WSL2 as the fix on Windows, and another host elsewhere", () => {
    const windows = classifySandboxFailure("", { ...linux({}), platform: "win32" });
    expect(windows.cause).toMatch(/runs on macOS and Linux, not win32/);
    expect(windows.fix).toMatch(/^run Tavi inside WSL2/);
    expect(classifySandboxFailure("", { ...linux({}), platform: "freebsd" }).fix).toBe("run Tavi on a Linux or macOS host");
  });

  it("names each cause with the fix printed for it", () => {
    const missing = classifySandboxFailure("", linux({}, ["bwrap", "socat"]));
    expect(missing.cause).toBe("bubblewrap, socat are not installed");
    expect(missing.fix).toMatch(/tavi sandbox setup.*apt install bubblewrap socat ripgrep/);
    expect(
      classifySandboxFailure("bwrap: setting up uid map: Permission denied", linux({ appArmorRestrictsUserNamespaces: true })),
    ).toEqual({
      cause: expect.stringMatching(/AppArmor limits unprivileged user namespaces/),
      fix: expect.stringMatching(/^tavi sandbox setup/),
    });
    expect(
      classifySandboxFailure(
        "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted",
        linux({ appArmorRestrictsUserNamespaces: true }),
      ).cause,
    ).toMatch(/AppArmor/);
    // Ubuntu 25.04+: bwrap runs, apply-seccomp is denied by unpriv_bwrap.
    expect(
      classifySandboxFailure("apply-seccomp: prctl: Operation not permitted", linux({ distribution: { id: "ubuntu", version: "26.04" } }))
        .cause,
    ).toMatch(/unpriv_bwrap/);
    expect(classifySandboxFailure("", linux({ userNamespacesDisabled: true })).cause).toMatch(/user namespaces are disabled/);
    expect(classifySandboxFailure("", linux({ euid: 0, capSetfcapInBounding: false })).fix).toMatch(/tavi service unit --user/);
    expect(classifySandboxFailure("bwrap: No permissions to create new namespace", linux({ inContainer: true })).fix).toMatch(
      /seccomp=unconfined/,
    );
    expect(
      classifySandboxFailure("bwrap: Can't mount proc on /newroot/proc: Operation not permitted", linux({ inContainer: true })).fix,
    ).toMatch(/--sandbox-nested/);
    expect(classifySandboxFailure("", linux({ seccompAvailable: false })).cause).toMatch(/seccomp is unavailable/);
    expect(classifySandboxFailure("", linux({ wsl: 1 })).fix).toMatch(/WSL2|wsl --set-version/);
    expect(
      classifySandboxFailure("", {
        platform: "win32",
        inContainer: false,
        appArmorRestrictsUserNamespaces: false,
        userNamespacesDisabled: false,
      }).fix,
    ).toMatch(/WSL2/);
    // The host's facts never explain a failure that is not about namespaces.
    expect(
      classifySandboxFailure("Error: the sandbox probe did not finish", linux({ appArmorRestrictsUserNamespaces: true, inContainer: true }))
        .cause,
    ).toMatch(/^the sandbox could not run here: Error: the sandbox probe did not finish/);
  });

  it("lists missing tools as hard errors and the rest as warnings", () => {
    const checks = hostChecks(
      linux(
        { bwrap: { path: "/usr/bin/bwrap", version: "bubblewrap 0.4.0", owner: "distribution" }, socketFamiliesRestricted: false, euid: 0 },
        ["rg"],
      ),
    );
    expect(checks.find((check) => check.name === "rg")).toMatchObject({ ok: false, severity: "error" });
    expect(checks.find((check) => check.name === "bwrap version")).toMatchObject({ ok: false, severity: "warning" });
    expect(checks.find((check) => check.name === "socket families")).toMatchObject({
      ok: false,
      severity: "warning",
      detail: expect.stringContaining("CVE-2026-31431"),
    });
    expect(checks.find((check) => check.name === "user")).toMatchObject({ severity: "warning" });
    expect(
      hostChecks({ platform: "darwin", inContainer: false, appArmorRestrictsUserNamespaces: false, userNamespacesDisabled: false }),
    ).toEqual([]);
  });

  it("warns when nothing could try AF_ALG (no python3), with the seccomp filters Tavi runs under", () => {
    const families = (facts: Partial<HostFacts>) => hostChecks(linux(facts)).find((check) => check.name === "socket families");
    expect(families({})).toMatchObject({ ok: false, severity: "warning", detail: expect.stringContaining("python3 is not installed") });
    expect(families({ seccompFilters: 0 })).toMatchObject({
      severity: "warning",
      detail: expect.stringMatching(/no seccomp filter.*generated unit/),
    });
    expect(families({ seccompFilters: 2 })).toMatchObject({ severity: "warning", detail: expect.stringContaining("2 seccomp filter(s)") });
  });

  it("gives its facts through the port, from the source its checks read", async () => {
    const facts = linux({ kernelRelease: "6.8.0-test" });
    expect(await createSandboxHost({ dataDirectory: "/data", facts: () => facts }).facts()).toBe(facts);
  });

  it("reads this host's facts", async () => {
    const facts = await hostFacts();
    expect(facts.platform).toBe(process.platform);
    expect(typeof facts.kernelRelease).toBe("string");
  });
});

describe("one cached answer", () => {
  const works: ProbeResult = { works: true, checks: [{ name: "live probe", ok: true }] };

  it("is checking before the first probe, then the probe's tier; a hard error never probes", async () => {
    let probes = 0;
    const host = createSandboxHost({ dataDirectory: "/data", facts: () => linux(), probe: async () => ((probes += 1), works) });
    expect(host.current().tier).toBe("checking");
    expect((await host.check()).tier).toBe("full");
    // A probe of the other mode (an MCP server approved --nested) answers its caller and leaves the owner's tier alone.
    expect((await host.check({ nested: true })).tier).toBe("nested");
    expect(host.current()).toMatchObject({ tier: "full", mechanism: "bubblewrap" });
    const broken = createSandboxHost({
      dataDirectory: "/data",
      facts: () => linux({}, ["bwrap"]),
      probe: async () => ((probes += 1), works),
    });
    expect(await broken.check()).toMatchObject({ tier: "unavailable", cause: "bubblewrap is not installed" });
    expect(probes).toBe(2);
  });

  it("probes a failure again in the background once it is older than ten minutes", async () => {
    let clock = 0;
    let fixed = false;
    const host = createSandboxHost({
      dataDirectory: "/data",
      now: () => clock,
      facts: () => linux(),
      probe: async () => (fixed ? works : { works: false, checks: [], failure: { cause: "broken", fix: "fix it" } }),
    });
    expect((await host.check()).tier).toBe("unavailable");
    fixed = true;
    expect(host.current().tier).toBe("unavailable");
    clock = FAILED_PROBE_TTL_MS + 1;
    expect(host.current().tier).toBe("unavailable");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.current().tier).toBe("full");
  });

  it("checks a failure again on demand once it is older than asked, sharing one check between callers", async () => {
    let clock = 0;
    let fixed = false;
    let probes = 0;
    const host = createSandboxHost({
      dataDirectory: "/data",
      now: () => clock,
      facts: () => linux(),
      probe: async () => ((probes += 1), fixed ? works : { works: false, checks: [], failure: { cause: "broken", fix: "fix it" } }),
    });
    expect((await host.check()).tier).toBe("unavailable");
    fixed = true;
    // Too fresh: nothing to wait for.
    clock = 10_000;
    expect(host.recheck?.(30_000)).toBeUndefined();
    clock = 31_000;
    const first = host.recheck?.(30_000);
    const second = host.recheck?.(30_000);
    expect(first).toBe(second);
    expect((await first)?.tier).toBe("full");
    expect(probes).toBe(2);
    expect(host.current().tier).toBe("full");
    // A working host is never checked again this way.
    expect(host.recheck?.(0)).toBeUndefined();
    // A background check `current()` started is the one a recheck waits for.
    fixed = false;
    expect((await host.check()).tier).toBe("unavailable");
    clock = 31_000 + 11 * 60_000;
    host.current();
    const shared = host.recheck?.(30_000);
    expect(host.recheck?.(30_000)).toBe(shared);
    await shared;
    expect(probes).toBe(4);
  });
});

describe("where srt is installed", () => {
  it("refuses a host whose srt lies in a folder the sandbox may write", async () => {
    expect(srtInstalledUnder(["/home/me/projects"], "/home/me/projects/tavi/node_modules/srt/vendor")).toBe("/home/me/projects");
    expect(srtInstalledUnder(["/home/me/projects"], "/opt/tavi/vendor")).toBeUndefined();
    const status = await createSandboxHost({
      dataDirectory: "/data",
      writableRoots: ["/"],
      facts: () => linux(),
      probe: async () => ({ works: true, checks: [] }),
    }).check();
    expect(status).toMatchObject({ tier: "unavailable", fix: "install Tavi outside every --fs-root" });
  });
});

describe("the probe's verdict", () => {
  const all = {
    read: "denied",
    ownerTemporary: "denied",
    write: "denied",
    gitHooks: "denied",
    connect: "denied",
    node: "works",
    unixSocket: "denied",
    afAlg: "denied",
  };
  const probe = async (found: Record<string, string> | string, facts: HostFacts = linux()): Promise<ProbeResult> => {
    const data = temp.create("tavi-probe-verdict-");
    return await probeSandbox({
      dataDirectory: data,
      home: "/nonexistent-home",
      facts,
      run: async () => ({
        stdout: typeof found === "string" ? found : JSON.stringify(found),
        stderr: "bwrap: setting up uid map: Permission denied",
      }),
    });
  };

  it("works only when every attempt was refused and Node still runs", async () => {
    expect((await probe(all)).works).toBe(true);
    for (const [name, value] of [
      ["read", "allowed"],
      ["write", "allowed"],
      ["gitHooks", "allowed"],
      ["node", "failed: 1"],
      ["unixSocket", "allowed"],
    ] as const) {
      expect((await probe({ ...all, [name]: value })).works, name).toBe(false);
    }
  });

  it("counts a connect that only timed out as a leak, not a refusal", async () => {
    const result = await probe({ ...all, connect: "timed out" });
    expect(result.works).toBe(false);
    expect(result.failure?.cause).toMatch(/network/);
  });

  it("warns, never refuses, when AF_ALG is open or untried", async () => {
    const open = await probe({ ...all, afAlg: "allowed" });
    expect(open.works).toBe(true);
    expect(open.checks.find((check) => check.name === "AF_ALG in the sandbox")).toMatchObject({
      ok: false,
      severity: "warning",
      detail: expect.stringContaining("CVE-2026-31431"),
    });
    expect((await probe({ ...all, afAlg: "untried" })).checks.find((check) => check.name === "AF_ALG in the sandbox")?.detail).toMatch(
      /python3/,
    );
  });

  it("runs Tavi's own bubblewrap when the facts found it, not the one on PATH", async () => {
    const settingsOf = async (facts: HostFacts): Promise<Record<string, unknown>> => {
      const data = temp.create("tavi-probe-bwrap-");
      let settings: Record<string, unknown> = {};
      await probeSandbox({
        dataDirectory: data,
        home: "/nonexistent-home",
        facts,
        run: async (_command, args) => {
          const file = args.find((arg) => arg.endsWith("srt.json"));
          settings = JSON.parse(readFileSync(file ?? "", "utf8")) as Record<string, unknown>;
          return { stdout: JSON.stringify(all), stderr: "" };
        },
      });
      return settings;
    };
    expect(
      (await settingsOf(linux({ bwrap: { path: "/opt/tavi/libexec/bwrap", version: "bubblewrap 0.11.0", owner: "tavi" } })))["bwrapPath"],
    ).toBe("/opt/tavi/libexec/bwrap");
    // The distribution's copy is what srt finds on PATH anyway.
    expect((await settingsOf(linux()))["bwrapPath"]).toBeUndefined();
  });

  it("on WSL2 denies /mnt and fails when a Windows drive's file was readable", async () => {
    const windowsFile = join(temp.create("tavi-probe-windows-"), "win.ini");
    writeFileSync(windowsFile, "[fonts]\n");
    const run = async (found: Record<string, string>, facts: HostFacts) => {
      const seen: { settings: Record<string, unknown>; args: readonly string[] } = { settings: {}, args: [] };
      const result = await probeSandbox({
        dataDirectory: temp.create("tavi-probe-wsl-"),
        home: "/nonexistent-home",
        facts,
        windowsFile,
        run: async (_command, args) => {
          seen.args = args;
          seen.settings = JSON.parse(readFileSync(args.find((arg) => arg.endsWith("srt.json")) ?? "", "utf8")) as Record<string, unknown>;
          return { stdout: JSON.stringify(found), stderr: "" };
        },
      });
      const denyRead = (seen.settings["filesystem"] as { denyRead?: string[] } | undefined)?.denyRead ?? [];
      return { result, denyRead, args: seen.args };
    };
    const wsl = await run({ ...all, windowsDrives: "denied" }, linux({ wsl: 2 }));
    expect(wsl.result.works).toBe(true);
    expect(wsl.denyRead).toContain("/mnt");
    expect(wsl.args.at(-1)).toBe(windowsFile);
    expect(wsl.result.checks.find((check) => check.name === "Windows drives")).toMatchObject({ ok: true });
    const leaked = await run({ ...all, windowsDrives: "allowed" }, linux({ wsl: 2 }));
    expect(leaked.result.works).toBe(false);
    expect(leaked.result.failure?.cause).toMatch(/Windows drives/);
    // An error other than "gone" (DrvFs refusing, a 9p I/O error) is not counted as the sandbox's refusal.
    expect((await run({ ...all, windowsDrives: "failed: EACCES" }, linux({ wsl: 2 }))).result.works).toBe(false);
    // On WSL2 with no Windows file the owner can read, nothing about /mnt is tried.
    rmSync(windowsFile);
    const unseen = await run(all, linux({ wsl: 2 }));
    expect(unseen.result.works).toBe(true);
    expect(unseen.denyRead).not.toContain("/mnt");
    expect(unseen.args.at(-1)).toBe("");
    expect(unseen.result.checks.some((check) => check.name === "Windows drives")).toBe(false);
    writeFileSync(windowsFile, "[fonts]\n");
    // Off WSL nothing about /mnt is tried, so no answer is expected.
    const plain = await run(all, linux());
    expect(plain.result.works).toBe(true);
    expect(plain.args.at(-1)).toBe("");
    expect(plain.result.checks.some((check) => check.name === "Windows drives")).toBe(false);
  });

  it("reads output that is not the probe's as srt's failure, classified", async () => {
    const result = await probe("", linux({ appArmorRestrictsUserNamespaces: true }));
    expect(result.works).toBe(false);
    expect(result.failure?.cause).toMatch(/AppArmor/);
  });
});

describe("the probe process", () => {
  it("is killed with its whole group when it outlives its time", async () => {
    const directory = temp.create("tavi-probe-kill-");
    const pidFile = join(directory, "pid");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    await expect(
      runSrt(process.execPath, ["-e", script], { env: { PATH: process.env["PATH"] ?? "" }, cwd: directory, timeoutMs: 500 }),
    ).rejects.toThrow(/did not finish/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("a check that throws, and checks that overlap", () => {
  it("answers unavailable with what threw, and probes again later", async () => {
    const host = createSandboxHost({
      dataDirectory: "/data",
      facts: () => linux(),
      probe: async () => {
        throw new Error("EACCES: the data directory");
      },
    });
    expect(await host.check()).toMatchObject({ tier: "unavailable", cause: expect.stringContaining("EACCES") });
    expect(host.current().tier).toBe("unavailable");
  });

  it("keeps the answer of the check started last", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const host = createSandboxHost({
      dataDirectory: "/data",
      facts: () => linux(),
      probe: async () => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => (release = resolve));
          return { works: false, checks: [], failure: { cause: "stale", fix: "none" } };
        }
        return { works: true, checks: [] };
      },
    });
    const first = host.check();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await host.check();
    release?.();
    await first;
    expect(host.current().tier).toBe("full");
  });
});

describe("srt's helpers", () => {
  it("finds a helper on PATH, else where distributions and Homebrew install it", () => {
    // Wherever this host keeps it (merged-/usr Linux has it in /usr/bin): absolute and runnable.
    expect(helperPath("sh", "/nonexistent")).toMatch(/^\/(usr\/)?bin\/sh$/);
    // A relative folder on PATH names a different file per working directory: never taken.
    expect(helperPath("sh", "bin")).toMatch(/^\//);
    expect(helperPath("no-such-helper-anywhere", "/nonexistent")).toBeUndefined();
  });

  it("gives srt the helpers it found, and says nothing of one it did not", () => {
    expect(srtHelperConfig((name) => (name === "rg" ? "/usr/local/bin/rg" : "/usr/bin/socat"))).toEqual({
      socatPath: "/usr/bin/socat",
      ripgrep: { command: "/usr/local/bin/rg" },
    });
    expect(srtHelperConfig(() => undefined)).toEqual({});
  });
});
