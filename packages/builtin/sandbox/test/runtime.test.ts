import { EventEmitter } from "node:events";
import type { ChildProcess, spawn as spawnType } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { SandboxCommand, SandboxPolicy } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntimeSandbox, runtimeSharedWritePaths, type SandboxRuntimeManager } from "../src/runtime.js";

const temp = temporaryDirectories();
afterEach(() => temp.cleanup());

/**
 * Real `SandboxPort` adapter over `@anthropic-ai/sandbox-runtime`.
 * Every test injects a fake `manager` and a
 * fake `spawn` — the real library's actual OS-level sandboxing is never
 * invoked, and no real process is ever spawned. See runtime.ts's own
 * header comment for what this leaves unverified.
 */

const policy: SandboxPolicy = {
  filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace/out"] },
  network: { allow: false },
  resources: { timeoutMs: 5_000, maxOutputBytes: 1024 },
};

const command: SandboxCommand = { command: "echo", args: ["hello"] };

/** A path as the kernel spells it, as far as it exists. */
function spelled(path: string): string {
  const missing: string[] = [];
  for (let existing = path; ; existing = dirname(existing)) {
    try {
      return join(realpathSync(existing), ...missing);
    } catch {
      missing.unshift(basename(existing));
    }
  }
}

/** The runtime's own shared write paths, appended to every run's `denyWrite` whatever the policy says (these tests compile for macOS, on any host). */
const sharedWritePaths = (): string[] => [...new Set(runtimeSharedWritePaths(homedir(), "darwin").map(spelled))];

function fakeManager(overrides: Partial<SandboxRuntimeManager> = {}): SandboxRuntimeManager {
  return {
    isSupportedPlatform: () => true,
    initialize: async () => {},
    cleanupAfterCommand: () => {},
    updateConfig: () => {},
    wrapWithSandboxArgv: async () => ({ argv: ["/usr/bin/true"], env: {} }),
    ...overrides,
  };
}

/** A minimal fake `ChildProcess`: an EventEmitter with `stdout`/`stderr` sub-emitters, matching the surface `runProcess` actually reads. */
function fakeChild(): {
  child: ChildProcess;
  emitStdout: (chunk: string) => void;
  emitStderr: (chunk: string) => void;
  close: (code: number | null) => void;
  error: (error: Error) => void;
} {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.assign(child, { stdout, stderr });
  return {
    child,
    emitStdout: (chunk) => stdout.emit("data", Buffer.from(chunk, "utf8")),
    emitStderr: (chunk) => stderr.emit("data", Buffer.from(chunk, "utf8")),
    close: (code) => child.emit("close", code),
    error: (error) => child.emit("error", error),
  };
}

function fakeSpawn(build: () => ReturnType<typeof fakeChild>): typeof spawnType {
  return ((..._args: unknown[]) => build().child) as unknown as typeof spawnType;
}

describe("createRuntimeSandbox — real manager default", () => {
  it("constructs with the real SandboxManager default and reports a well-formed capabilities object on this platform", () => {
    const sandbox = createRuntimeSandbox();
    const caps = sandbox.capabilities();
    expect(caps.platforms).toEqual(["darwin", "linux"]);
    expect(typeof caps.available).toBe("boolean");
    // This CI/dev environment is Linux, so the real SandboxManager import
    // itself is exercised (no throw at module load), even though
    // available is necessarily false here — see runtime.ts's own header
    // comment on what this does and doesn't verify.
    if (process.platform !== "darwin") expect(caps.available).toBe(false);
  });
});

describe("createRuntimeSandbox — capabilities", () => {
  it("is unavailable on Linux without host detection, regardless of what the manager reports", () => {
    const sandbox = createRuntimeSandbox({ manager: fakeManager(), platform: "linux" });
    const caps = sandbox.capabilities();
    expect(caps.available).toBe(false);
    expect(caps.detail).toContain("no host detection");
  });

  it("is unavailable on Windows, naming WSL2 as the fix", () => {
    const sandbox = createRuntimeSandbox({ manager: fakeManager(), platform: "win32" });
    const caps = sandbox.capabilities();
    expect(caps).toMatchObject({ available: false, tier: "unavailable" });
    expect(caps.detail).toMatch(/runs on macOS and Linux, not win32/);
    expect(caps.fix).toMatch(/WSL2/);
  });

  it("is unavailable on macOS when the manager itself reports the host unsupported", () => {
    const sandbox = createRuntimeSandbox({ manager: fakeManager({ isSupportedPlatform: () => false }), platform: "darwin" });
    const caps = sandbox.capabilities();
    expect(caps.available).toBe(false);
    expect(caps.detail).toContain("unsupported");
  });

  it("is available on macOS when the manager reports the host supported", () => {
    const sandbox = createRuntimeSandbox({ manager: fakeManager(), platform: "darwin" });
    expect(sandbox.capabilities()).toEqual({
      available: true,
      installProbe: true,
      platforms: ["darwin", "linux"],
      tier: "full",
      mechanism: "seatbelt",
      limits: { memory: "advisory", pids: "unavailable", cpu: "unavailable" },
    });
  });
});

describe("createRuntimeSandbox — run", () => {
  it("throws UNAVAILABLE and never calls the manager when unavailable", async () => {
    const wrapWithSandboxArgv = vi.fn();
    const sandbox = createRuntimeSandbox({ manager: fakeManager({ wrapWithSandboxArgv }), platform: "linux" });
    await expect(sandbox.run(policy, command)).rejects.toThrow(/unavailable/);
    expect(wrapWithSandboxArgv).not.toHaveBeenCalled();
  });

  it("initializes the manager exactly once across multiple run() calls", async () => {
    const initialize = vi.fn(async () => {});
    const emitters: ReturnType<typeof fakeChild>[] = [];
    const spawn = fakeSpawn(() => {
      const emitter = fakeChild();
      emitters.push(emitter);
      queueMicrotask(() => emitter.close(0));
      return emitter;
    });
    const sandbox = createRuntimeSandbox({ manager: fakeManager({ initialize }), spawn, platform: "darwin" });
    await sandbox.run(policy, command);
    await sandbox.run(policy, command);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("assigns a caller's TMPDIR inside the wrapped shell line, where the runtime's own TMPDIR cannot override it", async () => {
    const lines: string[] = [];
    const wrapWithSandboxArgv = vi.fn(async (line: string) => {
      lines.push(line);
      return { argv: ["/usr/bin/true"], env: {} };
    });
    const spawn = fakeSpawn(() => {
      const emitter = fakeChild();
      queueMicrotask(() => emitter.close(0));
      return emitter;
    });
    const sandbox = createRuntimeSandbox({ manager: fakeManager({ wrapWithSandboxArgv }), spawn, platform: "darwin" });
    await sandbox.run(policy, { ...command, env: { TMPDIR: "/scratch/it's" }, inheritEnv: false });
    await sandbox.run(policy, command);
    expect(lines).toEqual([`TMPDIR='/scratch/it'\\''s' 'echo' 'hello'`, `'echo' 'hello'`]);
  });

  it("maps policy.network.allow=false to an empty allowedDomains with strictAllowlist, denying everything", async () => {
    let capturedConfig: unknown;
    const wrapWithSandboxArgv = vi.fn(async (_cmd, _shell, customConfig) => {
      capturedConfig = customConfig;
      return { argv: ["/usr/bin/true"], env: {} };
    });
    const spawn = fakeSpawn(() => {
      const emitter = fakeChild();
      queueMicrotask(() => emitter.close(0));
      return emitter;
    });
    const sandbox = createRuntimeSandbox({ manager: fakeManager({ wrapWithSandboxArgv }), spawn, platform: "darwin" });
    await sandbox.run(policy, command);
    expect(capturedConfig).toMatchObject({ network: { allowedDomains: [], strictAllowlist: true } });
  });

  it("network.allow=true with no allowedHosts still denies everything — no unlimited-access escape hatch", async () => {
    let capturedConfig: unknown;
    const wrapWithSandboxArgv = vi.fn(async (_cmd, _shell, customConfig) => {
      capturedConfig = customConfig;
      return { argv: ["/usr/bin/true"], env: {} };
    });
    const spawn = fakeSpawn(() => {
      const emitter = fakeChild();
      queueMicrotask(() => emitter.close(0));
      return emitter;
    });
    const sandbox = createRuntimeSandbox({ manager: fakeManager({ wrapWithSandboxArgv }), spawn, platform: "darwin" });
    await sandbox.run({ ...policy, network: { allow: true } }, command);
    expect(capturedConfig).toMatchObject({ network: { allowedDomains: [], strictAllowlist: true } });
  });

  it("maps denyPaths to both denyRead and denyWrite", async () => {
    let capturedConfig: unknown;
    const wrapWithSandboxArgv = vi.fn(async (_cmd, _shell, customConfig) => {
      capturedConfig = customConfig;
      return { argv: ["/usr/bin/true"], env: {} };
    });
    const spawn = fakeSpawn(() => {
      const emitter = fakeChild();
      queueMicrotask(() => emitter.close(0));
      return emitter;
    });
    const sandbox = createRuntimeSandbox({ manager: fakeManager({ wrapWithSandboxArgv }), spawn, platform: "darwin" });
    // A fully synthetic, guaranteed-nonexistent path — `canonicalize`
    // (below) leaves any path with no existing ancestor untouched, so
    // this test stays platform-independent rather than depending on
    // whether some real ancestor directory happens to be a symlink.
    await sandbox.run({ ...policy, filesystem: { ...policy.filesystem, denyPaths: ["/nonexistent-tavi-test-root/secrets"] } }, command);
    expect(capturedConfig).toMatchObject({
      filesystem: {
        denyRead: ["/nonexistent-tavi-test-root/secrets"],
        denyWrite: ["/nonexistent-tavi-test-root/secrets", ...sharedWritePaths()],
      },
    });
  });

  it("maps denyRead and denyWrite each to its own side, and lets allowRead carve into denyRead", async () => {
    let capturedConfig: unknown;
    const wrapWithSandboxArgv = vi.fn(async (_cmd, _shell, customConfig) => {
      capturedConfig = customConfig;
      return { argv: ["/usr/bin/true"], env: {} };
    });
    const spawn = fakeSpawn(() => {
      const emitter = fakeChild();
      queueMicrotask(() => emitter.close(0));
      return emitter;
    });
    const sandbox = createRuntimeSandbox({ manager: fakeManager({ wrapWithSandboxArgv }), spawn, platform: "darwin" });
    await sandbox.run(
      {
        ...policy,
        filesystem: {
          allowRead: ["/nonexistent-tavi-test-root/home/chat"],
          allowWrite: ["/nonexistent-tavi-test-root/home/chat"],
          denyRead: ["/nonexistent-tavi-test-root/home"],
          denyWrite: ["/nonexistent-tavi-test-root/plugin"],
        },
      },
      command,
    );
    expect(capturedConfig).toMatchObject({
      filesystem: {
        denyRead: ["/nonexistent-tavi-test-root/home"],
        allowRead: ["/nonexistent-tavi-test-root/home/chat"],
        allowWrite: ["/nonexistent-tavi-test-root/home/chat"],
        denyWrite: ["/nonexistent-tavi-test-root/plugin", ...sharedWritePaths()],
      },
    });
  });

  it("never lets a run reach the runtime without its shared default write paths denied, whatever the policy omits", async () => {
    const configs: { readonly filesystem: { readonly denyWrite: readonly string[] } }[] = [];
    const wrapWithSandboxArgv = vi.fn(async (_cmd, _shell, customConfig) => {
      configs.push(customConfig as (typeof configs)[number]);
      return { argv: ["/usr/bin/true"], env: {} };
    });
    const spawn = fakeSpawn(() => {
      const emitter = fakeChild();
      queueMicrotask(() => emitter.close(0));
      return emitter;
    });
    const sandbox = createRuntimeSandbox({ manager: fakeManager({ wrapWithSandboxArgv }), spawn, platform: "darwin" });
    await sandbox.run(policy, command);
    await sandbox.run({ ...policy, filesystem: { ...policy.filesystem, denyWrite: ["/nonexistent-tavi-test-root/x"] } }, command);
    for (const config of configs)
      expect(config.filesystem.denyWrite).toEqual(expect.arrayContaining(["/private/tmp/claude", ...sharedWritePaths()]));
  });

  it("with inheritEnv: false, assigns the whole environment inside the line, and hands denyEnv to the runtime as denied credentials", async () => {
    const calls: { readonly line: string; readonly config: unknown }[] = [];
    const wrapWithSandboxArgv = vi.fn(async (line: string, _shell, customConfig) => {
      calls.push({ line, config: customConfig });
      return { argv: ["/usr/bin/true"], env: {} };
    });
    const spawn = fakeSpawn(() => {
      const emitter = fakeChild();
      queueMicrotask(() => emitter.close(0));
      return emitter;
    });
    const sandbox = createRuntimeSandbox({ manager: fakeManager({ wrapWithSandboxArgv }), spawn, platform: "darwin" });
    await sandbox.run(policy, { ...command, env: { HOME: "/h", TMPDIR: "/t" }, inheritEnv: false, denyEnv: ["ANTHROPIC_API_KEY"] });
    expect(calls[0]?.line).toBe(`HOME='/h' TMPDIR='/t' 'echo' 'hello'`);
    expect(calls[0]?.config).toMatchObject({ credentials: { envVars: [{ name: "ANTHROPIC_API_KEY", mode: "deny" }] } });
    await expect(sandbox.run(policy, { ...command, env: { "BAD NAME": "x" }, inheritEnv: false })).rejects.toThrow(/not an identifier/);
    await expect(sandbox.run(policy, { ...command, denyEnv: ["$(id)"] })).rejects.toThrow(/not an identifier/);
  });

  it("strips an allowRead entry that collides with denyPaths — the real library's allowRead carves exceptions out of denyRead for reads, the opposite of write's deny-wins precedence", async () => {
    let capturedConfig: unknown;
    const wrapWithSandboxArgv = vi.fn(async (_cmd, _shell, customConfig) => {
      capturedConfig = customConfig;
      return { argv: ["/usr/bin/true"], env: {} };
    });
    const spawn = fakeSpawn(() => {
      const emitter = fakeChild();
      queueMicrotask(() => emitter.close(0));
      return emitter;
    });
    const sandbox = createRuntimeSandbox({ manager: fakeManager({ wrapWithSandboxArgv }), spawn, platform: "darwin" });
    await sandbox.run(
      {
        ...policy,
        filesystem: {
          allowRead: ["/workspace", "/nonexistent-tavi-test-root/secrets"],
          allowWrite: [],
          denyPaths: ["/nonexistent-tavi-test-root/secrets"],
        },
      },
      command,
    );
    expect(capturedConfig).toMatchObject({
      filesystem: { allowRead: ["/workspace"], denyRead: ["/nonexistent-tavi-test-root/secrets"] },
    });
  });

  it("canonicalizes every filesystem policy path to what the kernel actually resolves, closing a confirmed real bug: macOS Seatbelt matches the symlink-resolved path, not the caller's literal spelling (e.g. /etc -> /private/etc, /tmp -> /private/tmp, and therefore os.tmpdir()'s own result on macOS)", async () => {
    const root = temp.create("tavi-sandbox-canon-");
    const real = join(root, "real");
    mkdirSync(real);
    const link = join(root, "link");
    symlinkSync(real, link);
    const denyTarget = join(link, "secret.txt"); // does not exist — the deny is preemptive
    const allowTarget = join(link, "public"); // does not exist either — same shape

    let capturedConfig: unknown;
    const wrapWithSandboxArgv = vi.fn(async (_cmd, _shell, customConfig) => {
      capturedConfig = customConfig;
      return { argv: ["/usr/bin/true"], env: {} };
    });
    const spawn = fakeSpawn(() => {
      const emitter = fakeChild();
      queueMicrotask(() => emitter.close(0));
      return emitter;
    });
    const sandbox = createRuntimeSandbox({ manager: fakeManager({ wrapWithSandboxArgv }), spawn, platform: "darwin" });
    await sandbox.run({ ...policy, filesystem: { allowRead: [allowTarget], allowWrite: [], denyPaths: [denyTarget] } }, command);
    const expectedDeny = join(realpathSync(real), "secret.txt");
    const expectedAllow = join(realpathSync(real), "public");
    expect(denyTarget).not.toBe(expectedDeny); // the symlink really did change the string
    expect(capturedConfig).toMatchObject({
      filesystem: { denyRead: [expectedDeny], denyWrite: [expectedDeny, ...sharedWritePaths()], allowRead: [expectedAllow] },
    });
  });

  it("degrades a symlink loop to 'stop resolution here' rather than throwing", async () => {
    const root = temp.create("tavi-sandbox-loop-");
    const a = join(root, "a");
    const b = join(root, "b");
    symlinkSync(b, a); // a -> b
    symlinkSync(a, b); // b -> a (a loop; realpathSync throws ELOOP on either)
    const denyTarget = join(a, "secret.txt");

    let capturedConfig: unknown;
    const wrapWithSandboxArgv = vi.fn(async (_cmd, _shell, customConfig) => {
      capturedConfig = customConfig;
      return { argv: ["/usr/bin/true"], env: {} };
    });
    const spawn = fakeSpawn(() => {
      const emitter = fakeChild();
      queueMicrotask(() => emitter.close(0));
      return emitter;
    });
    const sandbox = createRuntimeSandbox({ manager: fakeManager({ wrapWithSandboxArgv }), spawn, platform: "darwin" });
    await expect(sandbox.run({ ...policy, filesystem: { ...policy.filesystem, denyPaths: [denyTarget] } }, command)).resolves.toBeDefined();
    // Resolution can't get past the loop, so it stops at the last
    // real ancestor (`root`) and appends the rest literally — exactly
    // the same degrade-gracefully behavior a genuinely nonexistent
    // segment gets, never a thrown ELOOP.
    expect(capturedConfig).toMatchObject({
      filesystem: { denyRead: [join(realpathSync(root), "a", "secret.txt")] },
    });
  });

  it("rejects a relative filesystem policy path with INVALID_INPUT instead of silently resolving it as root-relative", async () => {
    const sandbox = createRuntimeSandbox({ manager: fakeManager(), platform: "darwin" });
    await expect(
      sandbox.run({ ...policy, filesystem: { allowRead: [], allowWrite: [], denyPaths: ["relative/secret.txt"] } }, command),
    ).rejects.toThrow(/absolute/);
  });

  it("forwards the split argv, cwd, merged env, and abort signal to spawn", async () => {
    let capturedArgs: unknown[] = [];
    const spawn = ((...args: unknown[]) => {
      capturedArgs = args;
      const emitter = fakeChild();
      queueMicrotask(() => emitter.close(0));
      return emitter.child;
    }) as unknown as typeof spawnType;
    const wrapWithSandboxArgv = async () => ({ argv: ["/bin/echo", "hi"], env: { FOO: "bar" } });
    const sandbox = createRuntimeSandbox({ manager: fakeManager({ wrapWithSandboxArgv }), spawn, platform: "darwin" });
    await sandbox.run(policy, { ...command, cwd: "/workspace", env: { BAZ: "qux" } });
    const [executable, args, spawnOptions] = capturedArgs as [
      string,
      readonly string[],
      { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly signal?: AbortSignal; readonly detached?: boolean },
    ];
    expect(executable).toBe("/bin/echo");
    expect(args).toEqual(["hi"]);
    expect(spawnOptions.cwd).toBe("/workspace");
    expect(spawnOptions.env).toMatchObject({ FOO: "bar", BAZ: "qux" });
    // The abort is the cancellation ladder's, on the whole group, never `spawn`'s own SIGTERM to the wrapper alone.
    expect(spawnOptions.signal).toBeUndefined();
    expect(spawnOptions.detached).toBe(true);
  });

  it("with inheritEnv: false, starts the child from command.env alone, never the caller's environment", async () => {
    let spawnOptions: { readonly env?: NodeJS.ProcessEnv; readonly detached?: boolean } = {};
    const spawn = ((...args: unknown[]) => {
      spawnOptions = args[2] as typeof spawnOptions;
      const emitter = fakeChild();
      queueMicrotask(() => emitter.close(0));
      return emitter.child;
    }) as unknown as typeof spawnType;
    const wrapWithSandboxArgv = async () => ({ argv: ["/bin/echo"], env: { SECRET_TOKEN: "owner-only", PATH: "/usr/bin" } });
    const sandbox = createRuntimeSandbox({ manager: fakeManager({ wrapWithSandboxArgv }), spawn, platform: "darwin" });
    await sandbox.run(policy, { ...command, env: { ONLY: "this" }, inheritEnv: false });
    // Nothing of the caller's: only the run's tag, by which macOS finds what the run left behind.
    expect(spawnOptions.env).toEqual({ ONLY: "this", TAVI_RUN: expect.any(String) });
    await sandbox.run(policy, { ...command, env: {}, inheritEnv: false });
    expect(spawnOptions.env).toEqual({ TAVI_RUN: expect.any(String) });
  });

  it("stops a run aborted by its timeout with SIGTERM to its whole group, then SIGKILL after the grace", async () => {
    const killed: Array<[number, string | number | undefined]> = [];
    let exit: (() => void) | undefined;
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      killed.push([pid, signal]);
      return true;
    }) as typeof process.kill);
    try {
      let spawnOptions: { readonly detached?: boolean } = {};
      const spawn = ((...args: unknown[]) => {
        spawnOptions = args[2] as typeof spawnOptions;
        const emitter = fakeChild();
        Object.assign(emitter.child, { pid: 4242 });
        // A wrapper that ignores SIGTERM: it goes only when the grace runs out.
        exit = () => emitter.close(null);
        return emitter.child;
      }) as unknown as typeof spawnType;
      const sandbox = createRuntimeSandbox({ manager: fakeManager(), spawn, platform: "darwin", killGraceMs: 20 });
      const pending = sandbox.run({ ...policy, resources: { ...policy.resources, timeoutMs: 5 } }, command);
      await vi.waitFor(() => expect(killed).toContainEqual([-4242, "SIGKILL"]));
      expect(killed[0]).toEqual([-4242, "SIGTERM"]);
      exit?.();
      const result = await pending;
      expect(result.session.state).toBe("cancelled");
      // Its timeout stopped it, not a cancel: the caller can ask for longer.
      expect(result.timedOut).toBe(true);
      expect(spawnOptions.detached).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });

  it("captures real stdout/stderr and a real exit code from the spawned process", async () => {
    const spawn = fakeSpawn(() => {
      const emitter = fakeChild();
      queueMicrotask(() => {
        emitter.emitStdout("hello from sandbox");
        emitter.emitStderr("a warning");
        emitter.close(0);
      });
      return emitter;
    });
    const sandbox = createRuntimeSandbox({ manager: fakeManager(), spawn, platform: "darwin" });
    const result = await sandbox.run(policy, command);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from sandbox");
    expect(result.stderr).toBe("a warning");
    expect(result.truncated).toBe(false);
    expect(result.session.state).toBe("completed");
  });

  it("keeps a long stdout's head and tail at character boundaries, never overshooting for multi-byte content", async () => {
    // 3-byte prefix + a 4-byte emoji, bound at exactly 3 bytes: the head keeps
    // two ASCII bytes, and the tail's one byte would be part of the emoji, so it
    // is left out with the rest: no partial multi-byte character leaks through.
    const spawn = fakeSpawn(() => {
      const emitter = fakeChild();
      queueMicrotask(() => {
        emitter.emitStdout("abc\u{1F600}");
        emitter.close(0);
      });
      return emitter;
    });
    const sandbox = createRuntimeSandbox({ manager: fakeManager(), spawn, platform: "darwin" });
    const result = await sandbox.run({ ...policy, resources: { ...policy.resources, maxOutputBytes: 3 } }, command);
    expect(result.stdout).toBe("ab\n…[5 bytes left out]…\n");
    expect(result.truncated).toBe(true);
  });

  it("propagates a non-zero exit code without treating it as a thrown error", async () => {
    const spawn = fakeSpawn(() => {
      const emitter = fakeChild();
      queueMicrotask(() => emitter.close(1));
      return emitter;
    });
    const sandbox = createRuntimeSandbox({ manager: fakeManager(), spawn, platform: "darwin" });
    const result = await sandbox.run(policy, command);
    expect(result.exitCode).toBe(1);
  });

  it("rejects run() when the child process itself errors to spawn", async () => {
    const spawn = fakeSpawn(() => {
      const emitter = fakeChild();
      queueMicrotask(() => emitter.error(new Error("spawn ENOENT")));
      return emitter;
    });
    const sandbox = createRuntimeSandbox({ manager: fakeManager(), spawn, platform: "darwin" });
    await expect(sandbox.run(policy, command)).rejects.toThrow(/ENOENT/);
  });

  it("throws INTERNAL when the sandbox runtime returns an empty argv", async () => {
    const sandbox = createRuntimeSandbox({
      manager: fakeManager({ wrapWithSandboxArgv: async () => ({ argv: [], env: {} }) }),
      platform: "darwin",
    });
    await expect(sandbox.run(policy, command)).rejects.toThrow(/empty argv/);
  });
});

describe("createRuntimeSandbox — cancel/dispose", () => {
  it("cancel on an unknown session throws NOT_FOUND", async () => {
    const sandbox = createRuntimeSandbox({ manager: fakeManager(), platform: "darwin" });
    await expect(sandbox.cancel("no-such-session")).rejects.toThrow(/No sandbox session/);
  });

  it("dispose on an unknown session throws NOT_FOUND; on a known one, removes it", async () => {
    const spawn = fakeSpawn(() => {
      const emitter = fakeChild();
      queueMicrotask(() => emitter.close(0));
      return emitter;
    });
    const sandbox = createRuntimeSandbox({ manager: fakeManager(), spawn, platform: "darwin" });
    const result = await sandbox.run(policy, command);
    await expect(sandbox.dispose("no-such-session")).rejects.toThrow(/No sandbox session/);
    await expect(sandbox.dispose(result.session.sessionId)).resolves.toBeUndefined();
    // A second dispose of the same (now-removed) session is a NOT_FOUND, not a silent no-op.
    await expect(sandbox.dispose(result.session.sessionId)).rejects.toThrow(/No sandbox session/);
  });

  it("a run past its resources.timeoutMs is aborted automatically, rejecting rather than hanging", async () => {
    // `wrapWithSandboxArgv` never resolves on its own — only the
    // adapter's own timeout-driven `controller.abort()` can end this
    // run, proving the timeout wiring actually reaches the sandbox
    // runtime call, not just the later spawned process.
    const wrapWithSandboxArgv = vi.fn(
      (_cmd: string, _shell: unknown, _config: unknown, abortSignal: AbortSignal | undefined) =>
        new Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>((_resolve, reject) => {
          abortSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const sandbox = createRuntimeSandbox({ manager: fakeManager({ wrapWithSandboxArgv }), platform: "darwin" });
    // The timeout ran out before the command started: said as such, so the caller can try again.
    await expect(sandbox.run({ ...policy, resources: { ...policy.resources, timeoutMs: 5 } }, command)).rejects.toMatchObject({
      code: "CANCELLED",
      message: expect.stringMatching(/did not start within its 0 s timeout/),
      details: { timedOut: true },
    });
  });

  it("cancel is a NOT_FOUND on an unknown session, and a safe no-op on an already-completed one", async () => {
    // Mirrors the fixture's own disclosed limitation
    // (`@tavi/test-support/sandbox`): `run()` only returns
    // the session id once it has already settled, so no caller can ever
    // obtain a running session's id to cancel it mid-flight through this
    // contract alone — only the not-found and already-completed paths
    // are exercisable here.
    const spawn = fakeSpawn(() => {
      const emitter = fakeChild();
      queueMicrotask(() => emitter.close(0));
      return emitter;
    });
    const sandbox = createRuntimeSandbox({ manager: fakeManager(), spawn, platform: "darwin" });
    const result = await sandbox.run(policy, command);
    await expect(sandbox.cancel(result.session.sessionId)).resolves.toBeUndefined();
  });
});
