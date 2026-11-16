import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import type { ChildProcess, spawn as spawnType } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  LIMITS_ENTRY_FAILED,
  LIMITS_ENTRY_FAILED_EXIT,
  SANDBOX_REACHED_NETWORK_DETAIL,
  TaviError,
  type ResourceLimitPort,
  type SandboxHostPort,
  type SandboxPolicy,
  type SandboxStatus,
} from "@tavi/contracts";
import { LinuxSandboxProfileError } from "@anthropic-ai/sandbox-runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { srtHelpersDirectory } from "../src/srt-cli.js";
import {
  createRuntimeSandbox,
  hostProcessEnvironment,
  holdersOf,
  runSurvivors,
  firstAbsent,
  isStalePlaceholder,
  makePlaceholders,
  placeholdersFor,
  removePlaceholders,
  sweepOrphanedBridges,
  sweepStalePlaceholders,
  violationOf,
  type ProcessTable,
  type SandboxRuntimeManager,
} from "../src/runtime.js";

/** The adapter's tier, lifecycle and errors, against a fake manager and spawn. */

const policy: SandboxPolicy = {
  filesystem: { allowRead: ["/nonexistent-tavi-w"], allowWrite: ["/nonexistent-tavi-w"] },
  network: { allow: false },
  resources: { timeoutMs: 5_000, maxOutputBytes: 1_024 },
};
const command = { command: "true" };
const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

function manager(overrides: Partial<SandboxRuntimeManager> = {}): SandboxRuntimeManager & { cleanups: number } {
  const fake = {
    cleanups: 0,
    isSupportedPlatform: () => true,
    initialize: async () => {},
    updateConfig: () => {},
    wrapWithSandboxArgv: async () => ({ argv: ["/usr/bin/true"], env: {} }),
    cleanupAfterCommand: () => {
      fake.cleanups += 1;
    },
    ...overrides,
  };
  return fake;
}

/** A spawn whose child closes at once, or errors. */
function spawnThat(outcome: "close" | "error" | "hang"): typeof spawnType {
  return (() => {
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: undefined });
    if (outcome === "close") queueMicrotask(() => child.emit("close", 0));
    if (outcome === "error") queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
    return child;
  }) as unknown as typeof spawnType;
}

const FACTS = { platform: "linux", inContainer: false, appArmorRestrictsUserNamespaces: false, userNamespacesDisabled: false };

function host(statuses: readonly SandboxStatus[]): SandboxHostPort & { checks: number } {
  let current: SandboxStatus = { tier: "checking", checks: [] };
  const fake = {
    checks: 0,
    current: () => current,
    check: async () => {
      current = statuses[Math.min(fake.checks, statuses.length - 1)] ?? current;
      fake.checks += 1;
      return current;
    },
    facts: async () => FACTS,
  };
  return fake;
}

describe("the tier", () => {
  it("lets a run through while the host is checking, and the run waits for the answer", async () => {
    const detection = host([{ tier: "full", mechanism: "bubblewrap", checks: [] }]);
    const sandbox = createRuntimeSandbox({ manager: manager(), spawn: spawnThat("close"), platform: "linux", host: detection });
    expect(sandbox.capabilities()).toMatchObject({ available: true, detail: expect.stringContaining("in progress") });
    const result = await sandbox.run(policy, command);
    expect(detection.checks).toBe(1);
    expect(result).toMatchObject({ tier: "full", mechanism: "bubblewrap", violationsComplete: false });
    expect(sandbox.capabilities()).toMatchObject({ available: true, tier: "full", platforms: ["darwin", "linux"] });
  });

  it("refuses with the host's cause and fix, and never wraps", async () => {
    const wrap = vi.fn();
    const sandbox = createRuntimeSandbox({
      manager: manager({ wrapWithSandboxArgv: wrap }),
      platform: "linux",
      host: host([
        { tier: "unavailable", checks: [], cause: "Ubuntu's AppArmor limits unprivileged user namespaces", fix: "tavi sandbox setup" },
      ]),
    });
    const error = await sandbox.run(policy, command).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaviError);
    expect((error as TaviError).message).toContain("AppArmor");
    expect((error as TaviError).details).toMatchObject({ fix: "tavi sandbox setup" });
    expect(wrap).not.toHaveBeenCalled();
    expect(sandbox.capabilities()).toMatchObject({ available: false, tier: "unavailable", fix: "tavi sandbox setup" });
  });

  it("checks a host refused a while ago again before refusing, and runs once it has been fixed", async () => {
    const detection = host([
      { tier: "unavailable", checks: [], cause: "bubblewrap is not installed", fix: "tavi sandbox setup" },
      { tier: "full", mechanism: "bubblewrap", checks: [] },
    ]);
    await detection.check();
    let asked: number | undefined;
    const fixed: SandboxHostPort = { ...detection, recheck: (olderThanMs) => ((asked = olderThanMs), detection.check()) };
    const sandbox = createRuntimeSandbox({ manager: manager(), spawn: spawnThat("close"), platform: "linux", host: fixed });
    expect(await sandbox.run(policy, command)).toMatchObject({ tier: "full" });
    expect(asked).toBe(30_000);
    expect(detection.checks).toBe(2);
  });

  it("is cancelled while it waits for a fresh check of a refused host", async () => {
    const detection = host([{ tier: "unavailable", checks: [], cause: "broken", fix: "fix it" }]);
    await detection.check();
    const slow: SandboxHostPort = { ...detection, recheck: () => new Promise<SandboxStatus>(() => {}) };
    const sandbox = createRuntimeSandbox({ manager: manager(), spawn: spawnThat("close"), platform: "linux", host: slow });
    const pending = sandbox.run(policy, command).catch((caught: unknown) => caught);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await sandbox.close?.();
    expect(await pending).toBeDefined();
  });

  it("refuses on the old answer when the fresh check is still running after its wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const detection = host([{ tier: "unavailable", checks: [], cause: "broken", fix: "fix it" }]);
      await detection.check();
      const slow: SandboxHostPort = { ...detection, recheck: () => new Promise<SandboxStatus>(() => {}) };
      const sandbox = createRuntimeSandbox({ manager: manager(), spawn: spawnThat("close"), platform: "linux", host: slow });
      // A run timeout longer than the wait, so the refusal is the host's.
      const refused = sandbox
        .run({ ...policy, resources: { ...policy.resources, timeoutMs: 60_000 } }, command)
        .catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await refused).toMatchObject({ code: "UNAVAILABLE", message: expect.stringContaining("broken") });
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands srt its Linux helpers by absolute path, so a narrow service PATH still runs them", async () => {
    const configs: unknown[] = [];
    const sandbox = createRuntimeSandbox({
      manager: manager({ initialize: async (config: unknown) => void configs.push(config) }),
      spawn: spawnThat("close"),
      platform: "linux",
      host: host([{ tier: "full", mechanism: "bubblewrap", checks: [] }]),
      helperPath: (name) => (name === "rg" ? "/usr/local/bin/rg" : "/usr/bin/socat"),
    });
    await sandbox.run(policy, command);
    expect(configs[0]).toMatchObject({ socatPath: "/usr/bin/socat", ripgrep: { command: "/usr/local/bin/rg" } });
  });

  it("takes the nested tier only with the flag, and says so on every result", async () => {
    const nested: SandboxStatus = { tier: "nested", mechanism: "bubblewrap", checks: [] };
    const without = createRuntimeSandbox({ manager: manager(), platform: "linux", host: host([nested]) });
    await expect(without.run(policy, command)).rejects.toThrow(/nested/);
    const withFlag = createRuntimeSandbox({
      manager: manager(),
      spawn: spawnThat("close"),
      platform: "linux",
      host: host([nested]),
      nested: true,
    });
    expect((await withFlag.run(policy, command)).tier).toBe("nested");
  });

  it("is refused while the operator pins it off, whatever the host could do", async () => {
    const sandbox = createRuntimeSandbox({
      manager: manager(),
      platform: "darwin",
      pinnedOff: true,
      host: host([{ tier: "full", checks: [] }]),
    });
    expect(sandbox.capabilities()).toMatchObject({ available: false, tier: "unavailable", detail: expect.stringContaining("pinned") });
    await expect(sandbox.run(policy, command)).rejects.toThrow(/pinned the sandbox off/);
  });
});

describe("cleanup once per successful wrap", () => {
  it("runs after an exit, a spawn error and an abort, never after a wrap that threw", async () => {
    const closes = manager();
    await createRuntimeSandbox({ manager: closes, spawn: spawnThat("close"), platform: "darwin" }).run(policy, command);
    expect(closes.cleanups).toBe(1);
    const errors = manager();
    await expect(
      createRuntimeSandbox({ manager: errors, spawn: spawnThat("error"), platform: "darwin" }).run(policy, command),
    ).rejects.toThrow(/ENOENT/);
    expect(errors.cleanups).toBe(1);
    const aborted = manager();
    const sandbox = createRuntimeSandbox({
      manager: aborted,
      spawn: (() => {
        const child = new EventEmitter() as unknown as ChildProcess;
        Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: undefined });
        setTimeout(() => child.emit("close", null), 30);
        return child;
      }) as unknown as typeof spawnType,
      platform: "darwin",
      killGraceMs: 1,
    });
    const result = await sandbox.run({ ...policy, resources: { ...policy.resources, timeoutMs: 1 } }, command);
    expect(result.session.state).toBe("cancelled");
    expect(aborted.cleanups).toBe(1);
    const threw = manager({
      wrapWithSandboxArgv: async () => {
        throw new Error("no shell");
      },
    });
    await expect(createRuntimeSandbox({ manager: threw, platform: "darwin" }).run(policy, command)).rejects.toThrow(/no shell/);
    expect(threw.cleanups).toBe(0);
  });
});

describe("errors", () => {
  it("maps srt's profile errors to the caller's input or the host's limit, with the code", async () => {
    const tooLong = manager({
      wrapWithSandboxArgv: async () => {
        throw new LinuxSandboxProfileError("command_too_long", "too long");
      },
    });
    await expect(createRuntimeSandbox({ manager: tooLong, platform: "darwin" }).run(policy, command)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { profileError: "command_too_long" },
    });
    const tooMany = manager({
      wrapWithSandboxArgv: async () => {
        throw new LinuxSandboxProfileError("too_many_arguments", "too many");
      },
    });
    await expect(createRuntimeSandbox({ manager: tooMany, platform: "darwin" }).run(policy, command)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: { profileError: "too_many_arguments" },
    });
  });
});

describe("violations", () => {
  it("reads srt's lines as kind and target, and puts this run's on its result", async () => {
    expect(violationOf("Sandbox: sh(123) deny(1) file-read-data /Users/me/.ssh/id_ed25519")).toEqual({
      kind: "read",
      target: "/Users/me/.ssh/id_ed25519",
    });
    expect(violationOf("deny file-write-create /work/.git/hooks/x")).toEqual({ kind: "write", target: "/work/.git/hooks/x" });
    expect(violationOf("deny network-outbound 1.1.1.1:443 (blocked)")).toEqual({ kind: "network", target: "1.1.1.1:443" });
    expect(violationOf("nothing here")).toBeUndefined();
    // A sysctl read Seatbelt refuses as many tools start (git log reads kern.iossupportversion) stops nothing: not reported.
    expect(violationOf("Sandbox: git(123) deny(1) sysctl-read kern.iossupportversion")).toBeUndefined();
    // Nor is the system-info read git and Python make as they start (the operation macOS's log names for it).
    expect(violationOf("Sandbox: git(123) deny(1) system-info vfs.disk-space")).toBeUndefined();
    expect(violationOf("deny(1) mach-lookup com.apple.x")).toEqual({ kind: "socket", target: "com.apple.x" });
    // srt files a run's violations under the wrap's commandId, never under the shell line.
    const store = {
      getViolationsForCommand: (key: string) => (key.startsWith("sandbox-run-") ? [{ line: "deny(1) file-read-data /secret" }] : []),
    };
    const result = await createRuntimeSandbox({
      manager: manager({ getSandboxViolationStore: () => store }),
      spawn: spawnThat("close"),
      platform: "darwin",
    }).run(policy, command);
    expect(result.violations).toEqual([{ kind: "read", target: "/secret" }]);
    expect(result.violationsComplete).toBe(true);
  });
});

describe("two engines in one process", () => {
  it("never give two runs one id, so neither reads the other's violations from srt's shared store", async () => {
    const asked: string[] = [];
    const shared = manager({ getSandboxViolationStore: () => ({ getViolationsForCommand: (key: string) => (asked.push(key), []) }) });
    const first = await createRuntimeSandbox({ manager: shared, spawn: spawnThat("close"), platform: "darwin" }).run(policy, command);
    const second = await createRuntimeSandbox({ manager: shared, spawn: spawnThat("close"), platform: "darwin" }).run(policy, command);
    expect(first.session.sessionId).not.toBe(second.session.sessionId);
    expect(asked).toEqual([first.session.sessionId, second.session.sessionId]);
  });
});

describe("the bubblewrap, read at each run (a fixed host needs no restart)", () => {
  it("moves srt's config to the copy `tavi sandbox setup` made while the owner runs, and back when it is removed", async () => {
    const configs: (string | undefined)[] = [];
    const fake = manager({
      initialize: async (config) => void configs.push(config.bwrapPath),
      updateConfig: (config) => void configs.push(config.bwrapPath),
    });
    let installed: string | undefined;
    const sandbox = createRuntimeSandbox({
      manager: fake,
      spawn: spawnThat("close"),
      platform: "linux",
      host: host([{ tier: "full", mechanism: "bubblewrap", checks: [] }]),
      bwrapPath: () => installed,
    });
    await sandbox.run(policy, command);
    installed = "/opt/tavi/libexec/bwrap";
    await sandbox.run(policy, command);
    await sandbox.run(policy, command);
    installed = undefined;
    await sandbox.run(policy, command);
    // Initialized with none, moved once to the copy, once back: never rewritten while it holds.
    expect(configs).toEqual([undefined, "/opt/tavi/libexec/bwrap", undefined]);
  });
});

describe("what the engine cannot express", () => {
  it("logs srt's glob warnings at start and a compile's dropped entry once, shows both to doctor, and puts the run's on its result", async () => {
    const logged: string[] = [];
    const sandbox = createRuntimeSandbox({
      manager: manager({ getLinuxGlobPatternWarnings: () => ["/**/*.pem"] }),
      spawn: spawnThat("close"),
      platform: "linux",
      host: host([{ tier: "full", mechanism: "bubblewrap", checks: [] }]),
      onWarning: (message) => logged.push(message),
    });
    const dropping: SandboxPolicy = { ...policy, filesystem: { ...policy.filesystem, denyWrite: ["/nonexistent-tavi-data/*/x"] } };
    const result = await sandbox.run(dropping, command);
    await sandbox.run(dropping, command);
    expect(result.warnings).toEqual([expect.stringContaining("/nonexistent-tavi-data/*/x")]);
    expect(logged).toEqual([expect.stringContaining("/**/*.pem"), expect.stringContaining("/nonexistent-tavi-data/*/x")]);
    expect(sandbox.capabilities().checks).toEqual([
      { name: "policy compile", ok: false, severity: "warning", detail: expect.stringContaining("/**/*.pem") },
      { name: "policy compile", ok: false, severity: "warning", detail: expect.stringContaining("/nonexistent-tavi-data/*/x") },
    ]);
    expect((await sandbox.run(policy, command)).warnings).toBeUndefined();
  });
});

describe("srt's bridge helpers a killed owner left", () => {
  const bridge = [
    "socat",
    "UNIX-LISTEN:/run/user/1000/tavi/srt/sandbox-run-3-abc123/claude-http-0123456789abcdef.sock,fork,reuseaddr",
    "TCP:localhost:41234,keepalive,keepidle=10,keepintvl=5,keepcnt=3",
  ];
  function table(
    processes: Record<number, { argv: readonly string[]; ppid: number; uid?: number; comm?: string }>,
  ): ProcessTable & { killed: number[] } {
    const killed: number[] = [];
    return {
      killed,
      pids: () => Object.keys(processes).map(Number),
      read: (pid) => {
        const entry = processes[pid];
        return entry === undefined
          ? undefined
          : { argv: entry.argv, ppid: entry.ppid, uid: entry.uid ?? 1000, comm: entry.comm ?? entry.argv[0] ?? "" };
      },
      kill: (pid) => void killed.push(pid),
    };
  }

  it("stops only this user's srt bridges whose parent is gone (init or a subreaper), never a live owner's or anyone else's socat", () => {
    const processes = table({
      10: { argv: ["/lib/systemd/systemd", "--user"], ppid: 1, comm: "systemd" },
      20: { argv: ["node", "tavi", "serve"], ppid: 10, comm: "node" },
      101: { argv: bridge, ppid: 1 },
      102: { argv: bridge, ppid: 10 },
      103: { argv: bridge, ppid: 20 },
      104: { argv: bridge, ppid: 1, uid: 1001 },
      105: { argv: ["socat", "UNIX-LISTEN:/tmp/mine.sock,fork,reuseaddr", "TCP:localhost:80"], ppid: 1 },
      106: { argv: [...bridge, "-v"], ppid: 1 },
    });
    expect(sweepOrphanedBridges(processes, 1000)).toEqual([101, 102]);
    expect(processes.killed).toEqual([101, 102]);
  });
});

describe("placeholders a killed owner left", () => {
  it("removes only a recorded path that still passes srt's own test", () => {
    const root = directories.create("tavi-placeholders-");
    const stale = join(root, "stale");
    const written = join(root, "written");
    const mine = join(root, "mine");
    writeFileSync(stale, "");
    chmodSync(stale, 0o444);
    writeFileSync(written, "content");
    chmodSync(written, 0o444);
    writeFileSync(mine, "");
    chmodSync(mine, 0o444);
    expect(isStalePlaceholder(stale)).toBe(true);
    expect(isStalePlaceholder(written)).toBe(false);
    const state = join(root, "state");
    mkdirSync(join(state, "placeholders"), { recursive: true });
    // Its owner (no process has pid 2^22 + 7 by default) is gone; a live owner's record stays.
    writeFileSync(join(state, "placeholders", "4194311-run.json"), JSON.stringify([stale, written]));
    writeFileSync(join(state, "placeholders", `${String(process.ppid)}-run.json`), JSON.stringify([mine]));
    sweepStalePlaceholders(state);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(written)).toBe(true);
    // Never recorded, so never touched, though it looks the same.
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(join(state, "placeholders", "4194311-run.json"))).toBe(false);
    expect(existsSync(join(state, "placeholders", `${String(process.ppid)}-run.json`))).toBe(true);
  });

  it("takes an empty read-only file or an empty folder made by the run's end for one, never a link or what came later", () => {
    const root = directories.create("tavi-placeholders-");
    const file = join(root, "file");
    writeFileSync(file, "");
    chmodSync(file, 0o444);
    const writable = join(root, "writable");
    writeFileSync(writable, "");
    const folder = join(root, "folder");
    mkdirSync(join(folder, "inner"), { recursive: true });
    const kept = join(root, "kept");
    mkdirSync(kept);
    writeFileSync(join(kept, "x"), "mine");
    const link = join(root, "link");
    symlinkSync(kept, link);
    expect(isStalePlaceholder(file)).toBe(true);
    // A person's own empty file, made writable as any is.
    expect(isStalePlaceholder(writable)).toBe(false);
    expect(isStalePlaceholder(join(folder, "inner"))).toBe(true);
    expect(isStalePlaceholder(folder)).toBe(false);
    expect(isStalePlaceholder(kept)).toBe(false);
    expect(isStalePlaceholder(link)).toBe(false);
    // Changed after the run's end: not the run's.
    expect(isStalePlaceholder(file, Date.now() - 60_000)).toBe(false);
    const now = Date.now() + 1_000;
    removePlaceholders([folder, join(folder, "inner"), file, kept, link].map((path) => ({ path, until: now })));
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(kept, "x"))).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(firstAbsent(join(root, "nope", "deeper", "x"))).toBe(join(root, "nope"));
    expect(firstAbsent(kept)).toBe(kept);
  });

  it("makes every missing component of an absent deny path, as srt would, so no srt run ever removes one", () => {
    const root = directories.create("tavi-placeholders-");
    const deny = join(root, "a", "b", ".bashrc");
    const sibling = join(root, "a", "b", ".envrc");
    const below = join(root, "c");
    const placeholders = placeholdersFor([deny, sibling, below, join(below, "d"), root]);
    expect(placeholders).toEqual(
      expect.arrayContaining([
        { path: join(root, "a"), kind: "directory" },
        { path: join(root, "a", "b"), kind: "directory" },
        { path: deny, kind: "file" },
        { path: sibling, kind: "file" },
        // A deny with another below it is a folder.
        { path: below, kind: "directory" },
        { path: join(below, "d"), kind: "file" },
      ]),
    );
    expect(placeholders.map((placeholder) => placeholder.path)).not.toContain(root);
    makePlaceholders(placeholders);
    expect(statSync(deny).mode & 0o777).toBe(0o444);
    expect(isStalePlaceholder(deny)).toBe(true);
    removePlaceholders(placeholders.map(({ path }) => ({ path, until: Date.now() + 1_000 })));
    expect(readdirSync(root)).toEqual([]);
  });

  it("leaves a path another live owner recorded too", () => {
    const root = directories.create("tavi-placeholders-");
    const shared = join(root, "shared");
    mkdirSync(shared);
    const state = join(root, "state");
    mkdirSync(join(state, "placeholders"), { recursive: true });
    const until = Date.now() + 60_000;
    writeFileSync(join(state, "placeholders", "4194311-gone.json"), JSON.stringify({ paths: [shared], until }));
    writeFileSync(join(state, "placeholders", `${String(process.ppid)}-alive.json`), JSON.stringify({ paths: [shared], until }));
    sweepStalePlaceholders(state);
    expect(existsSync(shared)).toBe(true);
  });

  it("sweeps a folder one record named after a path inside it another named", () => {
    const root = directories.create("tavi-placeholders-");
    const outer = join(root, "outer");
    const inner = join(outer, "inner");
    mkdirSync(inner, { recursive: true });
    const state = join(root, "state");
    mkdirSync(join(state, "placeholders"), { recursive: true });
    const until = Date.now() + 60_000;
    writeFileSync(join(state, "placeholders", "4194311-a.json"), JSON.stringify({ paths: [outer], until }));
    writeFileSync(join(state, "placeholders", "4194311-b.json"), JSON.stringify({ paths: [inner], until }));
    sweepStalePlaceholders(state);
    expect(existsSync(outer)).toBe(false);
    expect(readdirSync(join(state, "placeholders"))).toEqual([]);
  });
});

describe("graceful shutdown", () => {
  it("cancels what runs and waits for its cleanup", async () => {
    const closes = manager();
    const sandbox = createRuntimeSandbox({
      manager: closes,
      spawn: (() => {
        const child = new EventEmitter() as unknown as ChildProcess;
        Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: undefined });
        setTimeout(() => child.emit("close", null), 20);
        return child;
      }) as unknown as typeof spawnType,
      platform: "darwin",
      killGraceMs: 1,
    });
    const pending = sandbox.run({ ...policy, resources: { ...policy.resources, timeoutMs: 60_000 } }, command);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sandbox.close?.();
    // Cleaned up before close() resolved, not only by the time the run's own promise settles.
    expect(closes.cleanups).toBe(1);
    expect((await pending).session.state).toBe("cancelled");
    await expect(sandbox.run(policy, command)).rejects.toThrow(/shutting down/);
  });
});

describe("runs that wait", () => {
  it("share one host check while it is still checking", async () => {
    let release: (() => void) | undefined;
    let checks = 0;
    let current: SandboxStatus = { tier: "checking", checks: [] };
    const detection: SandboxHostPort = {
      current: () => current,
      check: async () => {
        checks += 1;
        await new Promise<void>((resolve) => (release = resolve));
        current = { tier: "full", checks: [] };
        return current;
      },
      facts: async () => FACTS,
    };
    const sandbox = createRuntimeSandbox({ manager: manager(), spawn: spawnThat("close"), platform: "linux", host: detection });
    const first = sandbox.run(policy, command);
    const second = sandbox.run(policy, command);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release?.();
    expect((await first).tier).toBe("full");
    expect((await second).tier).toBe("full");
    expect(checks).toBe(1);
  });

  it("is cancelled by close() while it waits for the host", async () => {
    const detection: SandboxHostPort = {
      current: () => ({ tier: "checking", checks: [] }),
      check: () => new Promise(() => {}),
      facts: async () => FACTS,
    };
    let spawned = 0;
    const spawn = ((...args: Parameters<typeof spawnType>) => ((spawned += 1), spawnThat("close")(...args))) as unknown as typeof spawnType;
    const sandbox = createRuntimeSandbox({ manager: manager(), spawn, platform: "linux", host: detection });
    const pending = sandbox.run(policy, command).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await sandbox.close?.();
    // The host never answered: nothing was spawned, and the run ended with the shutdown rather than its timeout.
    expect(spawned).toBe(0);
    expect(await pending).toBeDefined();
  });

  it("never leaves a session running when its command cannot be rendered", async () => {
    const sandbox = createRuntimeSandbox({ manager: manager(), spawn: spawnThat("close"), platform: "darwin" });
    // Run ids are counted per process: the next one follows this run's.
    const previous = Number(/(\d+)$/.exec((await sandbox.run(policy, command)).session.sessionId)?.[1]);
    await expect(sandbox.run(policy, { command: "true", env: { "1BAD": "x" }, inheritEnv: false })).rejects.toThrow(/not an identifier/);
    await expect(sandbox.cancel(`sandbox-run-${String(previous + 1)}`)).resolves.toBeUndefined();
  });
});

describe("placeholder records on Linux", () => {
  it("records what does not exist yet before the wrap, and forgets it once nothing stale is left", async () => {
    const state = directories.create("tavi-placeholder-state-");
    let seen: string[] = [];
    const wrap = async () => {
      seen = readdirSync(join(state, "placeholders"));
      return { argv: ["/usr/bin/true"], env: {} };
    };
    const linux = createRuntimeSandbox({
      manager: manager({ wrapWithSandboxArgv: wrap }),
      spawn: spawnThat("close"),
      platform: "linux",
      stateDirectory: state,
      host: host([{ tier: "full", checks: [] }]),
      fs: {
        kind: () => undefined,
        list: () => [],
        link: () => undefined,
        read: () => undefined,
        real: () => undefined,
        foldsCase: () => false,
      },
    });
    await linux.run(
      { ...policy, filesystem: { ...policy.filesystem, protectedNames: [{ root: "/nonexistent-tavi-w", names: [".bashrc"] }] } },
      command,
    );
    expect(seen).toHaveLength(1);
    expect(readdirSync(join(state, "placeholders"))).toEqual([]);
  });
});

describe("resource limits", () => {
  /** A limits port that records what it was asked, and answers `outcome` as told. */
  function limits(outcome: "oom" | undefined = undefined): ResourceLimitPort & { readonly calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      capabilities: () => ({ memory: "enforced", pids: "enforced", cpu: "enforced", rung: "delegated" }),
      place: (argv, workload, caps) => (
        calls.push(`place ${workload} ${JSON.stringify(caps)}`),
        { argv: ["/bin/sh", "-c", "enter", "sh", "/group", ...argv], groupId: "g1" }
      ),
      kill: (id) => void calls.push(`kill ${id}`),
      outcome: () => outcome,
      release: (id) => void calls.push(`release ${id}`),
    };
  }

  it("places each run in its own group, outermost, with the policy's caps, and releases it", async () => {
    const port = limits();
    let spawned: readonly string[] = [];
    const spawn = ((command: string, args: readonly string[]) => {
      spawned = [command, ...args];
      return spawnThat("close")(command, [...args]);
    }) as unknown as typeof spawnType;
    const sandbox = createRuntimeSandbox({
      manager: manager({ wrapWithSandboxArgv: async () => ({ argv: ["/usr/bin/sandbox-exec", "-p", "x", "sh"], env: {} }) }),
      spawn,
      platform: "darwin",
      limits: port,
    });
    await sandbox.run(
      { ...policy, resources: { ...policy.resources, maxMemoryBytes: 64 * 1024 * 1024, maxProcesses: 32, cpuQuotaPercent: 50 } },
      command,
    );
    expect(spawned).toEqual(["/bin/sh", "-c", "enter", "sh", "/group", "/usr/bin/sandbox-exec", "-p", "x", "sh"]);
    // At exit, whatever the run left in its group goes too, then the group itself.
    expect(port.calls).toEqual([
      `place run ${JSON.stringify({ memoryBytes: 64 * 1024 * 1024, processes: 32, cpuPercent: 50 })}`,
      "kill g1",
      "release g1",
    ]);
    expect(sandbox.capabilities().limits).toEqual({ memory: "enforced", pids: "enforced", cpu: "enforced" });
  });

  it("reads an OOM kill as a quota, and a failed entry as unavailable, not as the command's own exit", async () => {
    await expect(
      createRuntimeSandbox({ manager: manager(), spawn: spawnThat("close"), platform: "darwin", limits: limits("oom") }).run(
        policy,
        command,
      ),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", details: { reason: "memory" } });
    const entryFailed = (() => {
      const child = new EventEmitter() as unknown as ChildProcess;
      const stderr = new EventEmitter();
      Object.assign(child, { stdout: new EventEmitter(), stderr, pid: undefined });
      queueMicrotask(() => {
        stderr.emit("data", Buffer.from("tavi-limits: could not enter /group\n"));
        child.emit("close", 125);
      });
      return child;
    }) as unknown as typeof spawnType;
    await expect(
      createRuntimeSandbox({ manager: manager(), spawn: entryFailed, platform: "darwin", limits: limits() }).run(policy, command),
    ).rejects.toMatchObject({ code: "UNAVAILABLE", details: { reason: "limits" } });
  });

  it("kills the group as the ladder's last rung", async () => {
    const port = limits();
    const sandbox = createRuntimeSandbox({
      manager: manager(),
      spawn: (() => {
        const child = new EventEmitter() as unknown as ChildProcess;
        Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: undefined });
        setTimeout(() => child.emit("close", null), 40);
        return child;
      }) as unknown as typeof spawnType,
      platform: "darwin",
      killGraceMs: 1,
      limits: port,
    });
    await sandbox.run({ ...policy, resources: { ...policy.resources, timeoutMs: 1 } }, command);
    expect(port.calls).toContain("kill g1");
  });
});

describe("the install probe and Linux's read list", () => {
  it("says installProbe only once the tier has settled, and ready() waits for it", async () => {
    const detection = host([{ tier: "full", checks: [] }]);
    const sandbox = createRuntimeSandbox({ manager: manager(), platform: "linux", host: detection });
    expect(sandbox.capabilities()).toMatchObject({ available: true, installProbe: false });
    expect(await sandbox.ready?.()).toMatchObject({ available: true, installProbe: true, tier: "full" });
    const broken = createRuntimeSandbox({
      manager: manager(),
      platform: "linux",
      host: host([{ tier: "unavailable", checks: [], cause: "no bwrap", fix: "install it" }]),
    });
    expect(await broken.ready?.()).toMatchObject({ available: false, fix: "install it" });
    expect((await broken.ready?.())?.installProbe).toBeUndefined();
  });

  it("keeps srt's seccomp helper readable on Linux whatever the policy denies", async () => {
    let config: { filesystem: { allowRead: readonly (string | { path: string })[] } } | undefined;
    const sandbox = createRuntimeSandbox({
      manager: manager({
        wrapWithSandboxArgv: async (_line, _shell, custom) => ((config = custom as typeof config), { argv: ["/usr/bin/true"], env: {} }),
      }),
      spawn: spawnThat("close"),
      platform: "linux",
      host: host([{ tier: "full", checks: [] }]),
      fs: {
        kind: () => undefined,
        list: () => [],
        link: () => undefined,
        read: () => undefined,
        real: () => undefined,
        foldsCase: () => false,
      },
    });
    await sandbox.run({ ...policy, filesystem: { ...policy.filesystem, denyPaths: ["/"] } }, command);
    expect(config?.filesystem.allowRead).toContain(srtHelpersDirectory());
  });
});

describe("network runs", () => {
  const networked: SandboxPolicy = { ...policy, network: { allow: true, allowedHosts: ["example.org"] } };

  /** A host process that answers its fd 3 request with `events`, then exits; what each spawn was given is kept. */
  function hostProcess(events: (request: Record<string, unknown>) => readonly Record<string, unknown>[]) {
    const spawns: {
      executable: string;
      args: readonly string[];
      env: NodeJS.ProcessEnv;
      cwd: string | undefined;
      request: Record<string, unknown>;
    }[] = [];
    const spawnImpl = ((executable: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; cwd?: string }) => {
      const child = new EventEmitter() as unknown as ChildProcess;
      const control = new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, callback) {
          const request = JSON.parse(chunk.toString("utf8")) as Record<string, unknown>;
          spawns.push({ executable, args, env: options.env, cwd: options.cwd, request });
          for (const event of events(request)) control.push(`${JSON.stringify(event)}\n`);
          setTimeout(() => child.emit("close", 0), 5);
          callback();
        },
      });
      Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: undefined, stdio: [null, null, null, control] });
      return child;
    }) as unknown as typeof spawnType;
    return { spawnImpl, spawns };
  }

  function runtimeDirectory(): string {
    const directory = directories.create("tavi-egress-");
    return directory;
  }

  it("starts the host process with none of the owner's keys or proxies, and hands it the operator's parent proxy", async () => {
    const { spawnImpl, spawns } = hostProcess(() => [{ type: "exit", code: 0, signal: null }]);
    const saved = { key: process.env["OPENAI_API_KEY"], proxy: process.env["HTTPS_PROXY"] };
    process.env["OPENAI_API_KEY"] = "sk-owner";
    process.env["HTTPS_PROXY"] = "http://owner-proxy:3128";
    try {
      const sandbox = createRuntimeSandbox({
        manager: manager(),
        spawn: spawnImpl,
        platform: "darwin",
        runtimeDirectory: runtimeDirectory(),
        parentProxy: "http://corp:3128",
      });
      await sandbox.run(networked, { command: "curl", args: ["https://example.org/"], env: { PATH: "/usr/bin" }, inheritEnv: false });
    } finally {
      for (const [name, value] of [
        ["OPENAI_API_KEY", saved.key],
        ["HTTPS_PROXY", saved.proxy],
      ] as const)
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    const [spawned] = spawns;
    expect(spawned?.env["OPENAI_API_KEY"]).toBeUndefined();
    expect(spawned?.env["HTTPS_PROXY"]).toBeUndefined();
    expect(spawned?.env["PATH"]).toBeDefined();
    expect(spawned?.request).toMatchObject({ parentProxy: "http://corp:3128" });
  });

  it("keeps Node's experimental-proxy warning out of a networked run's stderr, after the command's own NODE_OPTIONS", async () => {
    const { spawnImpl, spawns } = hostProcess(() => [{ type: "exit", code: 0, signal: null }]);
    const sandbox = createRuntimeSandbox({
      manager: manager(),
      spawn: spawnImpl,
      platform: "darwin",
      runtimeDirectory: runtimeDirectory(),
    });
    await sandbox.run(networked, {
      command: "node",
      env: { PATH: "/usr/bin", NODE_OPTIONS: "--max-old-space-size=512" },
      inheritEnv: false,
    });
    await sandbox.run(networked, { command: "node", env: { PATH: "/usr/bin" }, inheritEnv: false });
    const envOf = (index: number) => (spawns[index]?.request as { env: Record<string, string> }).env;
    expect(envOf(0)["NODE_OPTIONS"]).toBe("--max-old-space-size=512 --disable-warning=UNDICI-EHPA");
    expect(envOf(1)["NODE_OPTIONS"]).toBe("--disable-warning=UNDICI-EHPA");
  });

  it("runs in its own host process with the grants, the guards and a private TMPDIR, and reports each request", async () => {
    const directory = runtimeDirectory();
    const wrap = vi.fn();
    const { spawnImpl, spawns } = hostProcess(() => [
      { type: "request", host: "example.org", port: 443, allowed: true },
      { type: "request", host: "example.com", port: 443, allowed: false },
      { type: "exit", code: 0, signal: null },
    ]);
    const sandbox = createRuntimeSandbox({
      manager: manager({ wrapWithSandboxArgv: wrap }),
      spawn: spawnImpl,
      platform: "darwin",
      runtimeDirectory: directory,
    });
    const result = await sandbox.run(networked, {
      command: "curl",
      args: ["https://example.org/"],
      env: { PATH: "/usr/bin" },
      inheritEnv: false,
    });
    expect(wrap).not.toHaveBeenCalled();
    expect(result.requests).toEqual([
      { host: "example.org", port: 443, allowed: true, count: 1, allowedCount: 1 },
      { host: "example.com", port: 443, allowed: false, count: 1, allowedCount: 0 },
    ]);
    const [spawned] = spawns;
    expect(spawned?.executable).toBe(process.execPath);
    expect(spawned?.args[0]).toMatch(/host-process\.mjs$/);
    expect(spawned?.env["TMPDIR"]).toMatch(new RegExp(`^${directory}/srt/sandbox-run-\\d+-`));
    expect(spawned?.request).toMatchObject({
      grants: ["example.org"],
      inheritEnv: false,
      env: { PATH: "/usr/bin", NODE_USE_ENV_PROXY: "1" },
      config: {
        network: {
          deniedDomains: expect.arrayContaining(["pastebin.com", "webhook.site"]),
          deniedResolvedAddresses: expect.arrayContaining(["10.0.0.0/8", "fc00::/7"]),
        },
      },
    });
    // The run's directory goes with it.
    expect(readdirSync(join(directory, "srt"))).toEqual([]);
  });

  it("gives concurrent runs with different grants a host process each, at once", async () => {
    const { spawnImpl, spawns } = hostProcess((request) => [
      { type: "request", host: (request["grants"] as string[])[0], port: 80, allowed: true },
      { type: "exit", code: 0, signal: null },
    ]);
    const sandbox = createRuntimeSandbox({
      manager: manager(),
      spawn: spawnImpl,
      platform: "darwin",
      runtimeDirectory: runtimeDirectory(),
    });
    const [first, second] = await Promise.all([
      sandbox.run(networked, command),
      sandbox.run({ ...networked, network: { allow: true, allowedHosts: ["example.com"] } }, command),
    ]);
    expect(first.requests).toEqual([{ host: "example.org", port: 80, allowed: true, count: 1, allowedCount: 1 }]);
    expect(second.requests).toEqual([{ host: "example.com", port: 80, allowed: true, count: 1, allowedCount: 1 }]);
    expect(spawns.map((spawned) => spawned.request["grants"])).toEqual(expect.arrayContaining([["example.org"], ["example.com"]]));
  });

  it("audits what srt refused itself, counts repeats once per host, and stops at the cap", async () => {
    const refusal = (target: string, reason: string) => ({ type: "violation", line: `deny network-outbound ${target} (${reason})` });
    const { spawnImpl } = hostProcess(() => [
      // Granted twice, then refused at dial time for its address; denied by the grants (srt records that too); a deny-list hit never asks.
      { type: "request", host: "rebind.example.org", port: 80, allowed: true },
      { type: "request", host: "rebind.example.org", port: 80, allowed: true },
      { type: "request", host: "example.com", port: 80, allowed: false },
      refusal("rebind.example.org:80", "resolved to loopback"),
      refusal("rebind.example.org:80", "resolved to loopback"),
      refusal("example.com:80", "user denied"),
      refusal("pastebin.com:443", "a paste or file-drop site"),
      ...Array.from({ length: 253 }, (_, index) => ({ type: "request", host: `h${String(index)}.example.org`, port: 443, allowed: true })),
      { type: "request", host: "one-too-many.example.com", port: 443, allowed: false },
      { type: "exit", code: 0, signal: null },
    ]);
    const sandbox = createRuntimeSandbox({
      manager: manager(),
      spawn: spawnImpl,
      platform: "darwin",
      runtimeDirectory: runtimeDirectory(),
    });
    const result = await sandbox.run(networked, command);
    expect(result.requests?.slice(0, 4)).toEqual([
      { host: "rebind.example.org", port: 80, allowed: false, count: 2, allowedCount: 0 },
      { host: "example.com", port: 80, allowed: false, count: 1, allowedCount: 0 },
      { host: "pastebin.com", port: 443, allowed: false, count: 1, allowedCount: 0 },
      { host: "h0.example.org", port: 443, allowed: true, count: 1, allowedCount: 1 },
    ]);
    expect(result.requests).toHaveLength(256);
    expect(result.requestsTruncated).toBe(true);
    expect(result.violations).toContainEqual({ kind: "network", target: "pastebin.com:443" });
  });

  it("counts the requests that got through to a host:port that also refused one, and keeps it past the cap", async () => {
    const refusal = (target: string, reason: string) => ({ type: "violation", line: `deny network-outbound ${target} (${reason})` });
    const { spawnImpl } = hostProcess(() => [
      // Granted twice; the second dial was refused for its address. One got through, so the run reached the network.
      { type: "request", host: "example.org", port: 443, allowed: true },
      { type: "request", host: "example.org", port: 443, allowed: true },
      refusal("example.org:443", "resolved to private network"),
      ...Array.from({ length: 300 }, (_, index) => ({ type: "request", host: `r${String(index)}.example.com`, port: 443, allowed: false })),
      // Past the cap, a request that got through takes a refused-only entry's place, never example.org's.
      { type: "request", host: "late.example.net", port: 443, allowed: true },
      { type: "exit", code: 0, signal: null },
    ]);
    const result = await createRuntimeSandbox({
      manager: manager(),
      spawn: spawnImpl,
      platform: "darwin",
      runtimeDirectory: runtimeDirectory(),
    }).run(networked, command);
    expect(result.requests?.[0]).toEqual({ host: "example.org", port: 443, allowed: false, count: 2, allowedCount: 1 });
    expect(result.requests).toContainEqual({ host: "late.example.net", port: 443, allowed: true, count: 1, allowedCount: 1 });
    expect(result.requests).toHaveLength(256);
    expect(result.requestsTruncated).toBe(true);
  });

  it("says in its error that a run which failed had reached the network, and only then", async () => {
    const failing = (allowed: boolean) =>
      createRuntimeSandbox({
        manager: manager(),
        // The host process ends without reporting an exit: the run failed.
        spawn: hostProcess(() => [{ type: "request", host: "example.org", port: 443, allowed }]).spawnImpl,
        platform: "darwin",
        runtimeDirectory: runtimeDirectory(),
      }).run(networked, command);
    await expect(failing(true)).rejects.toMatchObject({ code: "UNAVAILABLE", details: { [SANDBOX_REACHED_NETWORK_DETAIL]: true } });
    const refused = await failing(false).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "UNAVAILABLE" });
    expect((refused as TaviError).details).not.toHaveProperty(SANDBOX_REACHED_NETWORK_DETAIL);
  });

  it("keeps every allowed request in the audit past the cap, dropping refused ones first", async () => {
    const { spawnImpl } = hostProcess(() => [
      ...Array.from({ length: 300 }, (_, index) => ({ type: "request", host: `r${String(index)}.example.com`, port: 443, allowed: false })),
      { type: "request", host: "example.org", port: 443, allowed: true },
      { type: "inject", host: "api.github.com", port: 443, credentials: ["GH_TOKEN"] },
      { type: "request", host: "api.github.com", port: 443, allowed: true },
      { type: "exit", code: 0, signal: null },
    ]);
    const result = await createRuntimeSandbox({
      manager: manager(),
      spawn: spawnImpl,
      platform: "darwin",
      runtimeDirectory: runtimeDirectory(),
    }).run(networked, command);
    expect(result.requests).toHaveLength(256);
    expect(result.requestsTruncated).toBe(true);
    expect(result.requests).toContainEqual({ host: "example.org", port: 443, allowed: true, count: 1, allowedCount: 1 });
    expect(result.requests).toContainEqual({
      host: "api.github.com",
      port: 443,
      allowed: true,
      count: 1,
      allowedCount: 1,
      credentials: ["GH_TOKEN"],
    });
  });

  it("starts the host process at the primary writable root, so srt's own deny scan covers it, and the command in its own folder", async () => {
    const root = runtimeDirectory();
    const { spawnImpl, spawns } = hostProcess(() => [{ type: "exit", code: 0, signal: null }]);
    const sandbox = createRuntimeSandbox({
      manager: manager(),
      spawn: spawnImpl,
      platform: "darwin",
      runtimeDirectory: runtimeDirectory(),
    });
    await sandbox.run(
      { ...networked, filesystem: { allowRead: [root], allowWrite: ["/nonexistent-tavi-other", root] } },
      { ...command, cwd: join(root, "sub") },
    );
    expect(spawns[0]?.cwd).toBe(root);
    expect(spawns[0]?.request["cwd"]).toBe(join(root, "sub"));
  });

  it("sweeps what a network run's host process left on Linux once it has exited, but not while another run may hold it", async () => {
    const state = directories.create("tavi-placeholder-state-");
    const project = directories.create("tavi-placeholder-w-");
    const placeholder = join(project, "absent");
    // The host process makes bubblewrap's placeholder and is gone without its cleanup (killed past its exit handler).
    let release: () => void = () => undefined;
    const gates: Promise<void>[] = [];
    const spawnImpl = ((_executable: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv; cwd?: string }) => {
      void options;
      const child = new EventEmitter() as unknown as ChildProcess;
      const gate = gates.shift() ?? Promise.resolve();
      const control = new Duplex({
        read() {},
        write(_chunk: Buffer, _encoding, callback) {
          mkdirSync(placeholder, { recursive: true });
          control.push(`${JSON.stringify({ type: "exit", code: 0, signal: null })}\n`);
          void gate.then(() => setTimeout(() => child.emit("close", 0), 5));
          callback();
        },
      });
      Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: undefined, stdio: [null, null, null, control] });
      return child;
    }) as unknown as typeof spawnType;
    const short = mkdtempSync("/tmp/tavi-e-");
    onTestFinished(() => rmSync(short, { recursive: true, force: true }));
    const linux = createRuntimeSandbox({
      manager: manager(),
      spawn: spawnImpl,
      platform: "linux",
      stateDirectory: state,
      runtimeDirectory: short,
      host: host([{ tier: "full", checks: [] }]),
    });
    const denying = { ...networked, filesystem: { ...networked.filesystem, denyWrite: [join(placeholder, "deeper", ".bashrc")] } };
    // One run holds on; another ends meanwhile: the placeholder may be the first's mount, so it stays.
    gates.push(new Promise<void>((resolve) => (release = resolve)));
    const holding = linux.run(denying, command);
    await vi.waitFor(() => expect(existsSync(placeholder)).toBe(true));
    await linux.run(denying, command);
    expect(existsSync(placeholder)).toBe(true);
    // Once the last ends, it goes.
    release();
    await holding;
    expect(existsSync(placeholder)).toBe(false);
    expect(readdirSync(join(state, "placeholders"))).toEqual([]);
  });

  it("records a network run's placeholders on Linux for the sweep, and forgets them after", async () => {
    const state = directories.create("tavi-placeholder-state-");
    let seen: string[] = [];
    const { spawnImpl } = hostProcess(() => {
      seen = readdirSync(join(state, "placeholders"));
      return [{ type: "exit", code: 0, signal: null }];
    });
    // A socket path holds 108 bytes: macOS's temporary directory is too deep for Linux's check.
    const short = mkdtempSync("/tmp/tavi-e-");
    onTestFinished(() => rmSync(short, { recursive: true, force: true }));
    const linux = createRuntimeSandbox({
      manager: manager(),
      spawn: spawnImpl,
      platform: "linux",
      stateDirectory: state,
      runtimeDirectory: short,
      host: host([{ tier: "full", checks: [] }]),
      fs: {
        kind: () => undefined,
        list: () => [],
        link: () => undefined,
        read: () => undefined,
        real: () => undefined,
        foldsCase: () => false,
      },
    });
    await linux.run(
      { ...networked, filesystem: { ...networked.filesystem, protectedNames: [{ root: "/nonexistent-tavi-w", names: [".bashrc"] }] } },
      command,
    );
    expect(seen).toHaveLength(1);
    expect(readdirSync(join(state, "placeholders"))).toEqual([]);
  });

  it("maps a profile bubblewrap refused, and a run that never entered its cgroup, as the in-process path does", async () => {
    const refused = hostProcess(() => [{ type: "error", message: "the command is too long", profileError: "command_too_long" }]);
    await expect(
      createRuntimeSandbox({ manager: manager(), spawn: refused.spawnImpl, platform: "darwin", runtimeDirectory: runtimeDirectory() }).run(
        networked,
        command,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", details: { profileError: "command_too_long" } });
    const spawnImpl = ((executable: string, args: readonly string[]) => {
      const child = new EventEmitter() as unknown as ChildProcess;
      const stderr = new EventEmitter();
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr,
        pid: undefined,
        stdio: [
          null,
          null,
          null,
          new Duplex({
            read() {},
            write(_chunk, _encoding, callback) {
              callback();
            },
          }),
        ],
      });
      expect([executable, ...args].join(" ")).toContain("host-process.mjs");
      setTimeout(() => {
        stderr.emit("data", Buffer.from(LIMITS_ENTRY_FAILED));
        child.emit("close", LIMITS_ENTRY_FAILED_EXIT);
      }, 5);
      return child;
    }) as unknown as typeof spawnType;
    const port: ResourceLimitPort = {
      capabilities: () => ({ memory: "enforced", pids: "enforced", cpu: "enforced", rung: "delegated" }),
      place: (argv) => ({ argv: [...argv], groupId: "g1" }),
      kill: () => undefined,
      outcome: () => undefined,
      release: () => undefined,
    };
    await expect(
      createRuntimeSandbox({
        manager: manager(),
        spawn: spawnImpl,
        platform: "darwin",
        runtimeDirectory: runtimeDirectory(),
        limits: port,
      }).run(networked, command),
    ).rejects.toMatchObject({ code: "UNAVAILABLE", details: { reason: "limits" } });
  });

  it("refuses when the host process never ran the command, with its reason", async () => {
    const { spawnImpl } = hostProcess(() => [{ type: "error", message: "spawn bwrap ENOENT" }]);
    const sandbox = createRuntimeSandbox({
      manager: manager(),
      spawn: spawnImpl,
      platform: "darwin",
      runtimeDirectory: runtimeDirectory(),
    });
    await expect(sandbox.run(networked, command)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("spawn bwrap ENOENT"),
    });
  });

  it("refuses on Linux without a private runtime directory, or with one too deep for the proxy's sockets, and re-opens one in a denied place", async () => {
    const cleanup: string[] = [];
    vi.stubEnv("RUNTIME_DIRECTORY", undefined);
    vi.stubEnv("XDG_RUNTIME_DIR", undefined);
    try {
      const ready = host([{ tier: "full", mechanism: "bubblewrap", checks: [] }]);
      const without = createRuntimeSandbox({ manager: manager(), spawn: spawnThat("close"), platform: "linux", host: ready });
      await expect(without.run(networked, command)).rejects.toMatchObject({
        code: "UNAVAILABLE",
        message: expect.stringContaining("RuntimeDirectory=tavi"),
      });
      const deep = createRuntimeSandbox({
        manager: manager(),
        spawn: spawnThat("close"),
        platform: "linux",
        host: ready,
        runtimeDirectory: `/run/${"d".repeat(60)}`,
      });
      await expect(deep.run(networked, command)).rejects.toMatchObject({
        code: "UNAVAILABLE",
        message: expect.stringContaining("too deep"),
      });
      // A runtime directory in a denied place (`$XDG_RUNTIME_DIR`) is re-opened for the run's own proxy folder alone.
      // Short, so its sockets fit Linux's 108 bytes wherever the temporary directory is.
      const runtime = realpathSync(mkdtempSync("/tmp/tavi-e-"));
      cleanup.push(runtime);
      const { spawnImpl, spawns } = hostProcess(() => [{ type: "exit", code: 0, signal: null }]);
      const reopened = createRuntimeSandbox({
        manager: manager(),
        spawn: spawnImpl,
        platform: "linux",
        host: ready,
        runtimeDirectory: runtime,
      });
      await reopened.run({ ...networked, filesystem: { ...networked.filesystem, denyRead: [runtime] } }, command);
      const config = spawns[0]?.request["config"] as { filesystem: { allowRead: readonly string[]; denyRead: readonly string[] } };
      expect(config.filesystem.denyRead).toContain(runtime);
      expect(config.filesystem.allowRead).toEqual(
        expect.arrayContaining([expect.stringMatching(new RegExp(`^${runtime}/srt/sandbox-run-`))]),
      );
      // And removed once the run is over.
      expect(readdirSync(join(runtime, "srt"))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
    }
  });

  it("hands an inspected run's host process the owner's CA, and refuses one with nowhere to keep it", async () => {
    const caDirectory = runtimeDirectory();
    const { spawnImpl, spawns } = hostProcess(() => [{ type: "exit", code: 0, signal: null }]);
    const granted: SandboxPolicy = { ...policy, network: { allow: true, allowedHosts: ["example.org"] } };
    const inspected = createRuntimeSandbox({
      manager: manager(),
      spawn: spawnImpl,
      platform: "darwin",
      runtimeDirectory: runtimeDirectory(),
      caDirectory,
      inspectTls: true,
    });
    await inspected.run(granted, { command: "curl", args: ["https://example.org"], inheritEnv: false });
    const sent = spawns[0]?.request["inspectTls"] as { caCertPath: string; caKeyPath: string };
    expect(sent.caCertPath.startsWith(caDirectory)).toBe(true);
    expect(sent.caKeyPath.startsWith(caDirectory)).toBe(true);
    const nowhere = createRuntimeSandbox({
      manager: manager(),
      spawn: spawnImpl,
      platform: "darwin",
      runtimeDirectory: runtimeDirectory(),
      inspectTls: true,
    });
    await expect(nowhere.run(granted, { command: "curl", args: ["https://example.org"], inheritEnv: false })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("--sandbox-inspect-tls needs a private folder"),
    });
  });

  it("passes credentials with their values and a CA it mints once, and keeps the values out of the command's environment", async () => {
    const caDirectory = runtimeDirectory();
    writeFileSync(join(caDirectory, "stale"), "old");
    const { spawnImpl, spawns } = hostProcess(() => [
      { type: "inject", host: "api.github.com", port: 443, credentials: ["GH_TOKEN"] },
      { type: "request", host: "api.github.com", port: 443, allowed: true },
      { type: "exit", code: 0, signal: null },
    ]);
    const sandbox = createRuntimeSandbox({
      manager: manager(),
      spawn: spawnImpl,
      platform: "darwin",
      runtimeDirectory: runtimeDirectory(),
      caDirectory,
    });
    const withToken: SandboxPolicy = {
      ...policy,
      network: { allow: true, allowedHosts: ["api.github.com"], credentials: [{ env: "GH_TOKEN", hosts: ["api.github.com"] }] },
    };
    const first = await sandbox.run(withToken, {
      command: "gh",
      env: { PATH: "/usr/bin" },
      inheritEnv: false,
      secrets: { GH_TOKEN: "ghp_real" },
    });
    await sandbox.run(withToken, { command: "gh", secrets: { GH_TOKEN: "ghp_real" } });
    expect(first.requests).toEqual([
      { host: "api.github.com", port: 443, allowed: true, count: 1, allowedCount: 1, credentials: ["GH_TOKEN"] },
    ]);
    const sent = spawns[0]?.request as {
      env: Record<string, string>;
      credentials: { secrets: Record<string, string>; caCertPath: string; caKeyPath: string };
    };
    // The run's tag (macOS) finds what it leaves behind; nothing else of the owner's.
    expect(sent.env).toEqual({
      PATH: "/usr/bin",
      NODE_USE_ENV_PROXY: "1",
      NODE_OPTIONS: "--disable-warning=UNDICI-EHPA",
      TAVI_RUN: expect.any(String),
    });
    expect(sent.credentials).toMatchObject({
      entries: [{ env: "GH_TOKEN", hosts: ["api.github.com"] }],
      secrets: { GH_TOKEN: "ghp_real" },
    });
    expect(sent.credentials.caCertPath.startsWith(caDirectory)).toBe(true);
    // One CA for the session, the stale entry swept.
    expect(readdirSync(caDirectory)).toHaveLength(1);
    expect(readdirSync(join(caDirectory, readdirSync(caDirectory)[0] ?? ""))).toEqual(["ca.crt", "ca.key"]);
    expect((spawns[1]?.request as typeof sent).credentials.caCertPath).toBe(sent.credentials.caCertPath);
  });

  it("refuses a credential without its value, with a host that is a pattern or not granted, or with no CA folder", async () => {
    const { spawnImpl } = hostProcess(() => [{ type: "exit", code: 0, signal: null }]);
    const sandbox = createRuntimeSandbox({
      manager: manager(),
      spawn: spawnImpl,
      platform: "darwin",
      runtimeDirectory: runtimeDirectory(),
      caDirectory: runtimeDirectory(),
    });
    const credentialed = (hosts: readonly string[], allowed: readonly string[]): SandboxPolicy => ({
      ...policy,
      network: { allow: true, allowedHosts: [...allowed], credentials: [{ env: "GH_TOKEN", hosts: [...hosts] }] },
    });
    await expect(sandbox.run(credentialed(["api.github.com"], ["api.github.com"]), command)).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
    await expect(
      sandbox.run(credentialed(["*.github.com"], ["*.github.com"]), { ...command, secrets: { GH_TOKEN: "x" } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      sandbox.run(credentialed(["api.github.com"], ["example.org"]), { ...command, secrets: { GH_TOKEN: "x" } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      sandbox.run(credentialed(["api.github.com:443"], ["api.github.com:443"]), { ...command, secrets: { GH_TOKEN: "x" } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("no port") });
    const noCa = createRuntimeSandbox({ manager: manager(), spawn: spawnImpl, platform: "darwin", runtimeDirectory: runtimeDirectory() });
    await expect(
      noCa.run(credentialed(["api.github.com"], ["api.github.com"]), { ...command, secrets: { GH_TOKEN: "x" } }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("keeps a run with no grants in the owner's own manager", async () => {
    const wrap = vi.fn(async () => ({ argv: ["/usr/bin/true"], env: {} }));
    const result = await createRuntimeSandbox({
      manager: manager({ wrapWithSandboxArgv: wrap }),
      spawn: spawnThat("close"),
      platform: "darwin",
    }).run({ ...policy, network: { allow: true, allowedHosts: [] } }, command);
    expect(wrap).toHaveBeenCalledTimes(1);
    expect(result.requests).toBeUndefined();
  });
});

describe("stdin", () => {
  /** A spawn whose child records what its stdin was given, then closes. */
  function spawnRecording(given: { text?: string; ended: boolean }): typeof spawnType {
    return (() => {
      const child = new EventEmitter() as unknown as ChildProcess;
      const stdin = Object.assign(new EventEmitter(), {
        end: (text: string) => {
          given.text = text;
          given.ended = true;
        },
      });
      Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin, pid: undefined });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }) as unknown as typeof spawnType;
  }

  it("writes a run's stdin to the command and closes it, and closes it empty when there is none", async () => {
    const given = { ended: false } as { text?: string; ended: boolean };
    await createRuntimeSandbox({ manager: manager(), spawn: spawnRecording(given), platform: "darwin" }).run(policy, {
      ...command,
      stdin: "a\nb\n",
    });
    expect(given).toEqual({ text: "a\nb\n", ended: true });
    const none = { ended: false } as { text?: string; ended: boolean };
    await createRuntimeSandbox({ manager: manager(), spawn: spawnRecording(none), platform: "darwin" }).run(policy, command);
    expect(none).toEqual({ text: "", ended: true });
  });
});

describe("the srt host process's environment", () => {
  it("takes the owner's variables by name, never a key or a proxy", () => {
    expect(
      hostProcessEnvironment({
        PATH: "/usr/bin",
        HOME: "/home/me",
        LANG: "C",
        LC_ALL: "C",
        OPENAI_API_KEY: "sk-x",
        HTTPS_PROXY: "http://corp:3128",
        https_proxy: "http://corp:3128",
        AWS_SECRET_ACCESS_KEY: "y",
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/home/me", LANG: "C", LC_ALL: "C" });
  });
});

describe("what a macOS run leaves behind", () => {
  it("finds the processes whose environment carries the run's tag, never another run's, an argument, this process or init", () => {
    const plain = [
      "  101 /usr/bin/python3 -c x",
      "  102 sleep 600",
      "    1 /sbin/launchd",
      `  ${String(process.pid)} node`,
      "  103 sleep 9",
      "  104 grep TAVI_RUN=42.sandbox-run-1.ab",
    ].join("\n");
    const withEnvironment = [
      "  101 /usr/bin/python3 -c x TAVI_RUN=42.sandbox-run-1.ab PATH=/usr/bin",
      "  102 sleep 600 TAVI_RUN=42.sandbox-run-2.cd",
      "    1 /sbin/launchd TAVI_RUN=42.sandbox-run-1.ab",
      `  ${String(process.pid)} node TAVI_RUN=42.sandbox-run-1.ab`,
      "  103 sleep 9 XTAVI_RUN=42.sandbox-run-1.ab",
      "  104 grep TAVI_RUN=42.sandbox-run-1.ab",
    ].join("\n");
    expect(runSurvivors(withEnvironment, plain, "42.sandbox-run-1.ab")).toEqual([101]);
  });

  it("finds who holds the run's marker, never this process or init", () => {
    expect(holdersOf(`501\n1\n${String(process.pid)}\n\n502\n`)).toEqual([501, 502]);
  });

  it("tags the run, sweeps what carries the tag or holds its marker until none is left, and settles though a leftover holds its output", async () => {
    const killed: number[] = [];
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      killed.push(pid);
      return true;
    }) as typeof process.kill);
    let env: NodeJS.ProcessEnv = {};
    let stdio: unknown;
    let marker: string | undefined;
    try {
      const spawn = ((_executable: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv; stdio?: unknown }) => {
        env = options.env;
        stdio = options.stdio;
        const child = new EventEmitter() as unknown as ChildProcess;
        // The command exits, but its output stays open (a daemon holds it) until it is let go.
        const stream = () => Object.assign(new EventEmitter(), { destroy: () => child.emit("close", 0) });
        Object.assign(child, { stdout: stream(), stderr: stream(), pid: 4242 });
        queueMicrotask(() => child.emit("exit", 0));
        return child;
      }) as unknown as typeof spawnType;
      // 777 carries the tag; 779, an Apple binary macOS shows no environment for, holds the marker; 780 forks late.
      let pass = 0;
      const sandbox = createRuntimeSandbox({
        manager: manager(),
        spawn,
        platform: "darwin",
        runLister: {
          processes: async (environment) =>
            killed.includes(777)
              ? "  778 other\n"
              : environment
                ? `  777 sleep 600 TAVI_RUN=${env["TAVI_RUN"] ?? ""}\n  778 other\n`
                : "  777 sleep 600\n  778 other\n",
          holders: async (path) => {
            marker = path;
            pass += 1;
            return pass === 1 ? "779\n" : pass === 2 ? "780\n" : "";
          },
        },
      });
      const started = Date.now();
      const result = await sandbox.run(policy, command);
      expect(result.exitCode).toBe(0);
      expect(result.warnings).toBeUndefined();
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
      expect(env["TAVI_RUN"]).toMatch(/^\d+\.sandbox-run-\d+\.[0-9a-f]{8}$/);
      expect(killed).toEqual(expect.arrayContaining([777, 779, 780]));
      expect(killed).not.toContain(778);
      expect(stdio).toEqual(["pipe", "pipe", "pipe", expect.any(Number)]);
      // The marker is gone once the run is.
      expect(marker !== undefined && existsSync(marker)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  }, 10_000);

  it("says so when it could not look for what the run left behind", async () => {
    const spawn = ((_executable: string, _args: readonly string[]) => {
      const child = new EventEmitter() as unknown as ChildProcess;
      Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4243 });
      queueMicrotask(() => {
        child.emit("exit", 0);
        child.emit("close", 0);
      });
      return child;
    }) as unknown as typeof spawnType;
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
    try {
      const sandbox = createRuntimeSandbox({
        manager: manager(),
        spawn,
        platform: "darwin",
        runLister: {
          processes: async () => {
            throw new Error("ps: not permitted");
          },
          holders: async () => "",
        },
      });
      const result = await sandbox.run(policy, command);
      expect(result.warnings).toEqual([expect.stringContaining("could not check for processes the run left behind")]);
    } finally {
      kill.mockRestore();
    }
  });
});
