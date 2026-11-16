import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ChatFolder, SandboxHostPort, SandboxPort, SandboxStatus } from "@tavi/contracts";
import { createFixtureSandbox } from "@tavi/test-support/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { buildDoctorDocument } from "../../src/features/doctor/reports.js";
import { withOwnerSandbox } from "../../src/features/sandbox/host.js";

/**
 * One engine inside `serve`: `plugins.validate` runs
 * in composition's engine — its tier, its
 * `--sandbox-nested`, its `--fs-root` check, its shutdown — and a CLI
 * command's own engine is closed when the command is done, so srt is reset.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const cleanups: (() => Promise<void> | void)[] = [];
const directories = temporaryDirectories();
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  directories.cleanup();
});

function directory(): string {
  return realpathSync(directories.create("tavi-engine-sharing-"));
}

/** serve's engine, unavailable with a cause of its own: an answer that names it came from this engine. */
const servesEngine = (): SandboxPort => ({
  ...createFixtureSandbox(),
  capabilities: () => ({ available: false, platforms: ["darwin", "linux"], tier: "unavailable", detail: "serve's own engine says no" }),
});

describe("an engine of a command's own", () => {
  function counted(): { readonly make: () => SandboxPort; readonly closed: () => number } {
    let closed = 0;
    return { make: () => ({ ...createFixtureSandbox({ mode: "echo" }), close: async () => void (closed += 1) }), closed: () => closed };
  }

  it("is closed when the work is done, or throws; the caller's is used as is and left open", async () => {
    const own = counted();
    expect(await withOwnerSandbox(undefined, async () => "done", own.make)).toBe("done");
    await expect(
      withOwnerSandbox(
        undefined,
        async () => {
          throw new Error("failed");
        },
        own.make,
      ),
    ).rejects.toThrow("failed");
    expect(own.closed()).toBe(2);
    const given = counted();
    const port = given.make();
    let used: SandboxPort | undefined;
    await withOwnerSandbox(port, async (sandbox) => void (used = sandbox), own.make);
    expect(used).toBe(port);
    expect(given.closed() + own.closed()).toBe(2);
  });
});

describe("inside serve", () => {
  it("runs plugins.validate in composition's engine", async () => {
    const data = directory();
    const runtime = await composeTaviRuntime(
      {
        dataDirectory: data,
        workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke"] }],
        providers: [],
        credentials: {},
        defaultConnectionId: "none",
        defaultModel: "none",
        logger: { level: "error", sink: () => undefined },
        scheduleSweepEnabled: false,
      },
      { requireModelTransport: false, sandboxOverride: servesEngine() },
    );
    cleanups.push(async () => void (await runtime.close()));
    const primary = join(repo, "examples", "mods");
    const managed = join(data, "chats", "default", "t1");
    const folder: ChatFolder = {
      primary,
      primaryKind: "host",
      managed,
      scratch: join(managed, ".tmp"),
      home: join(managed, ".home"),
      attachments: [],
      revision: 1,
    };
    const report = await runtime.tools.get("plugins.validate")?.handler({
      input: { path: "acme-guard" },
      context: { workspaceId: "default", principalId: "operator", runId: "t1", caller: "test", folder },
      signal: new AbortController().signal,
    });
    expect(report).toMatchObject({ pluginId: "acme.guard", skipped: "the sandbox is unavailable: serve's own engine says no" });
  });
});

describe("doctor's sandbox section", () => {
  it("reads the host's facts through its port, and lists what the engine could not express", async () => {
    const data = directory();
    const status: SandboxStatus = { tier: "unavailable", mechanism: "bubblewrap", checks: [], cause: "a test host", fix: "none" };
    const host: SandboxHostPort = {
      current: () => status,
      check: async () => status,
      facts: async () => ({
        platform: "linux",
        kernelRelease: "6.8.0-port",
        distribution: { id: "portdistro", version: "9" },
        inContainer: false,
        appArmorRestrictsUserNamespaces: false,
        userNamespacesDisabled: false,
      }),
    };
    const warning = {
      name: "policy compile",
      ok: false,
      severity: "warning" as const,
      detail: "a run's policy entry was left out: /data/*/x",
    };
    const engine: SandboxPort = {
      ...createFixtureSandbox(),
      capabilities: () => ({ available: false, platforms: ["linux"], checks: [warning] }),
    };
    const runtime = await composeTaviRuntime(
      {
        dataDirectory: data,
        workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke"] }],
        providers: [],
        credentials: {},
        defaultConnectionId: "none",
        defaultModel: "none",
        logger: { level: "error", sink: () => undefined },
        scheduleSweepEnabled: false,
      },
      { requireModelTransport: false, sandboxOverride: engine, sandboxHostOverride: host },
    );
    cleanups.push(async () => void (await runtime.close()));
    const section = (await buildDoctorDocument(runtime, { integrity: "skip" }))["sandbox"] as {
      platform: string;
      checks: readonly unknown[];
    };
    expect(section.platform).toBe("linux 6.8.0-port (portdistro 9)");
    expect(section.checks).toContainEqual(warning);
  });
});
