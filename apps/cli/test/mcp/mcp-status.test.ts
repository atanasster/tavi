import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { mcpCommand, pluginsCommand } from "../../src/server/config-commands.js";
import { createLocalCredentialStore } from "../../src/features/credentials/store.js";
import { EXIT, main } from "../../src/main.js";
import { serverListText, type McpServerList } from "../../src/features/mcp/actions.js";
import { buildDoctorDocument } from "../../src/features/doctor/reports.js";
import { capture } from "../support/attached-owner.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/** Status, the kill switch and removal. */

const RAW = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mcp"), "raw-server.mjs");
const directories = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  directories.cleanup();
});

async function tavi(argv: readonly string[]) {
  const out = capture();
  const code = await main([...argv], { io: out.io });
  return { code, stdout: out.stdout(), stderr: out.stderr() };
}

const compose = async (data: string): Promise<TaviRuntime> => {
  const runtime = await composeTaviRuntime(fixtureRuntimeOptions(data), {
    modelOverride: createFixtureModel({ turns: [{ text: "done" }] }),
  });
  runtimes.push(runtime);
  return runtime;
};

/** A raw server added unsandboxed, with a credential setting, approved and enabled. */
async function installed(): Promise<{ readonly data: string; readonly at: readonly string[]; readonly changes: string }> {
  const data = directories.create("tavi-mcp-status-");
  const at = ["--data-dir", data];
  const server = directories.create("tavi-mcp-raw-");
  writeFileSync(join(server, "raw.mjs"), readFileSync(RAW));
  const changes = join(directories.create("tavi-mcp-raw-tools-"), "tools.json");
  writeFileSync(changes, "{}");
  expect(
    (
      await tavi([
        "mcp",
        "add",
        "raw",
        "--dir",
        server,
        "--env",
        `RAW_TOOLS=${changes}`,
        "--env",
        "RAW_TOKEN=@token",
        "--no-probe",
        ...at,
        "--",
        "node",
        "raw.mjs",
      ])
    ).code,
  ).toBe(EXIT.ok);
  const token = join(data, "token-file");
  writeFileSync(token, "raw-secret", { mode: 0o600 });
  expect((await tavi(["credentials", "set", "plugins.mcp.raw.token", "--file", token, ...at])).code).toBe(EXIT.ok);
  expect((await tavi(["plugins", "config", "mcp.raw", "--set", "token=plugins.mcp.raw.token", ...at])).code).toBe(EXIT.ok);
  expect((await tavi(["mcp", "probe", "mcp.raw", "--unsandboxed", ...at])).code).toBe(EXIT.ok);
  expect((await tavi(["mcp", "approve", "mcp.raw", "1.0.0", "--unsandboxed", "--effect", "connect=external", ...at])).code).toBe(EXIT.ok);
  expect((await tavi(["plugins", "enable", "mcp.raw", ...at])).code).toBe(EXIT.ok);
  return { data, at, changes };
}

describe("the kill switch", () => {
  it("is on by default; `tavi mcp off` and `on` with no owner apply at the next start", async () => {
    const { data, at } = await installed();
    expect((await tavi(["mcp", "list", ...at])).stdout).toMatch(/^MCP is on\nmcp\.raw@1\.0\.0 \(raw\): state unknown/);
    expect((await tavi(["mcp", "off", ...at])).stdout).toContain("MCP is off");
    expect((await tavi(["mcp", "list", ...at])).stdout).toMatch(/^MCP is off \(tavi mcp on\)\nmcp\.raw@1\.0\.0 \(raw\): off/);
    const off = await compose(data);
    expect(off.tools.list().filter((tool) => tool.id.startsWith("mcp."))).toEqual([]);
    await off.close();
    runtimes.splice(runtimes.indexOf(off), 1);
    expect((await tavi(["mcp", "on", ...at])).stdout).toContain("MCP is on");
    const on = await compose(data);
    expect(on.tools.get("mcp.raw.echo")).toBeDefined();
    const doctor = (await buildDoctorDocument(on, { integrity: "skip" }))["mcp"] as Record<string, unknown>;
    expect(doctor).toMatchObject({
      enabled: true,
      servers: [{ pluginId: "mcp.raw", enabled: true, openNotices: [], files: { ok: true } }],
      tools: { registered: 6, listed: 6 },
      taintObserved: { calls: 0 },
    });
    expect((doctor["tools"] as { schemaTokens: number }).schemaTokens).toBeGreaterThan(0);
    // Whether uv is there for Python servers: found with its path, or a note saying how to get it.
    expect(doctor["uv"]).toEqual(expect.objectContaining({ found: expect.any(Boolean) }));
    // Its size on disk, per version and its home, and the Node in use against the 22.21 floor.
    const disk = (doctor["servers"] as { disk: { versions: { version: string; bytes: number }[]; homeBytes: number } }[])[0]?.disk;
    expect(disk?.versions).toEqual([{ version: "1.0.0", bytes: expect.any(Number) }]);
    expect(disk?.versions[0]?.bytes).toBeGreaterThan(0);
    expect(doctor["node"]).toMatchObject({ version: process.versions.node });
    // Per surface: what the workspace's listed MCP tools cost each call, under the warning.
    const surfaces = (doctor["tools"] as { surfaces: readonly { workspaceId: string; schemaTokens: number; warning?: string }[] }).surfaces;
    expect(surfaces).toEqual([{ workspaceId: "default", schemaTokens: (doctor["tools"] as { schemaTokens: number }).schemaTokens }]);
    // A page (the canvas) may make things safer, never weaker: no weaker sandbox, and not MCP on.
    expect(await mcpCommand(on, { action: "probe", pluginId: "mcp.raw", sandbox: "none" }, "operator:ui")).toMatchObject({
      ok: false,
      error: { code: "NOT_AUTHORIZED" },
    });
    expect(await mcpCommand(on, { action: "probe", pluginId: "mcp.raw", sandbox: "nested" }, "operator:ui")).toMatchObject({
      ok: false,
      error: { code: "NOT_AUTHORIZED" },
    });
    expect(
      await mcpCommand(
        on,
        { action: "approve", pluginId: "mcp.raw", version: "1.0.0", effects: {}, floors: {}, timeouts: {}, disabled: [], sandbox: "none" },
        "operator:ui",
      ),
    ).toMatchObject({ ok: false, error: { code: "NOT_AUTHORIZED" } });
    expect(await mcpCommand(on, { action: "switch", on: true }, "operator:ui")).toMatchObject({
      ok: false,
      error: { code: "NOT_AUTHORIZED" },
    });
    // Off on a running owner: every server stopped, every tool withdrawn, at once.
    expect((await mcpCommand(on, { action: "switch", on: false }, "operator")).ok).toBe(true);
    expect(on.tools.list().filter((tool) => tool.id.startsWith("mcp."))).toEqual([]);
    await expect(on.mcp.supervisor.call("mcp.raw", "echo", { text: "x" }, { timeoutMs: 5_000 })).rejects.toThrow(
      /not enabled and approved/,
    );
  }, 120_000);
});

describe("doctor's schema tokens per surface", () => {
  it("counts only the servers a workspace allows, and warns past 20,000", async () => {
    const { data } = await installed();
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(data, {
        workspaces: [
          { workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] },
          { workspaceId: "other", principalId: "operator", permissions: ["tools.invoke"] },
        ],
      }),
      { modelOverride: createFixtureModel({ turns: [{ text: "done" }] }) },
    );
    runtimes.push(runtime);
    expect(runtime.mcp.bridge.registered().get("mcp.raw")).toMatchObject({ deferred: false });
    // A listed tool of that server with an input schema of about 100,000 characters (a registered description is cut
    // at 2,000, so only a schema gets there).
    const properties = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, index) => [
        `field_${String(index)}`,
        { type: "string", description: "A field of a very large form." },
      ]),
    );
    runtime.tools.registerExternal({
      id: "mcp.raw.huge",
      version: "1.0.0",
      description: "[raw] Huge.",
      effect: "read-only",
      requiredPermissions: ["tools.invoke"],
      inputSchema: z.object({}).passthrough(),
      inputJsonSchema: { type: "object", properties },
      sink: "none",
      outputSource: "mcp",
      handler: async () => "",
    });
    const tools = (
      (await buildDoctorDocument(runtime, { integrity: "skip" }))["mcp"] as {
        tools: { surfaces: readonly { workspaceId: string; schemaTokens: number; warning?: string }[] };
      }
    ).tools;
    const [allowed, other] = tools.surfaces;
    expect(allowed).toMatchObject({ workspaceId: "default", warning: expect.stringContaining("tokens of every model call in default") });
    expect(allowed?.schemaTokens).toBeGreaterThan(20_000);
    expect(other).toEqual({ workspaceId: "other", schemaTokens: 0 });
  }, 120_000);
});

describe("tavi mcp list", () => {
  it("shows each state for a server forced into it", async () => {
    const { data, at, changes } = await installed();
    expect((await tavi(["mcp", "on", ...at])).code).toBe(EXIT.ok);
    const runtime = await compose(data);
    const list = async (): Promise<McpServerList> => {
      const answer = await mcpCommand(runtime, { action: "list", workspaceId: "default" }, "operator");
      if (!answer.ok) throw new Error(JSON.stringify(answer));
      return (answer.result as { servers: McpServerList }).servers;
    };
    const stateOf = async () => (await list()).servers[0]?.state;
    expect(await stateOf()).toBe("stopped");
    await runtime.mcp.supervisor.call("mcp.raw", "echo", { text: "x" }, { timeoutMs: 5_000 });
    expect(await stateOf()).toBe("running");
    const text = serverListText(await list());
    expect(text).toMatch(/^MCP is on; default lists 6 of \d+ MCP tools\n/);
    expect(text).toMatch(/mcp\.raw@1\.0\.0 \(raw\): running, not sandboxed, exposure auto, 6 tools listed, in default/);
    // A listing the server cannot answer crashes it: backing off.
    writeFileSync(changes, "not json");
    await runtime.mcp.supervisor.list("mcp.raw").catch(() => undefined);
    expect(await stateOf()).toBe("backing-off");
    runtime.mcp.supervisor.loginRequired("mcp.raw", "its token expired");
    expect((await list()).servers[0]).toMatchObject({ state: "login-required", reason: "its token expired" });
    await runtime.mcp.supervisor.markFailed("mcp.raw", "it kept crashing");
    expect((await list()).servers[0]).toMatchObject({ state: "failed", openNotices: ["failed"] });
    await runtime.mcp.supervisor.stop("mcp.raw");
    expect(await stateOf()).toBe("stopped");
  }, 120_000);
});

describe("removal", () => {
  it("leaves no home, token, row, grant, notice or workspace entry", async () => {
    const { data, at } = await installed();
    expect((await tavi(["mcp", "on", ...at])).code).toBe(EXIT.ok);
    const runtime = await compose(data);
    const repositories = runtime.store.asPort().repositories;
    await runtime.mcp.supervisor.call("mcp.raw", "echo", { text: "x" }, { timeoutMs: 5_000 });
    expect(existsSync(join(data, "mcp", "mcp.raw", "home"))).toBe(true);
    await repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: "op-rm",
      kind: "start",
      origin: "ipc",
      chatKind: "home",
      intent: { prompt: "hello" },
      checkpointNamespace: "",
      newTaskId: "task-rm",
      newAdmissionId: "adm-rm",
      newThreadId: "thread-rm",
      now: "2026-10-14T00:00:00.000Z",
    });
    await repositories.toolPolicy.addSessionGrant({
      grantId: "grant-rm",
      taskId: "task-rm",
      workspaceId: "default",
      toolId: "mcp.raw.echo",
      approvalId: "approval-rm",
      createdBy: "operator",
      createdAt: "2026-10-14T00:00:00.000Z",
    });
    await runtime.mcp.raise("mcp.raw", "budget", { workspaces: [] });
    expect((await mcpCommand(runtime, { action: "people", pluginId: "mcp.raw", on: true, workspaceId: "default" }, "operator")).ok).toBe(
      true,
    );
    expect((await mcpCommand(runtime, { action: "line", pluginId: "mcp.raw", text: "Raw: the operator's words" }, "operator")).ok).toBe(
      true,
    );

    expect((await pluginsCommand(runtime, { action: "disable", pluginId: "mcp.raw" }, "operator")).ok).toBe(true);
    const removed = await pluginsCommand(runtime, { action: "remove", pluginId: "mcp.raw" }, "operator");
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(existsSync(join(data, "mcp", "mcp.raw"))).toBe(false);
    expect(existsSync(join(data, "plugins", "mcp.raw"))).toBe(false);
    expect(await createLocalCredentialStore(data).getSecret("plugins.mcp.raw.token")).toBeNull();
    expect(await repositories.mcp.listVersions("mcp.raw")).toEqual([]);
    expect(await repositories.mcp.listTools("mcp.raw")).toEqual([]);
    expect(await repositories.mcp.listNotices({ pluginId: "mcp.raw" })).toEqual([]);
    expect(await repositories.toolPolicy.listSessionGrants("task-rm")).toEqual([]);
    const settings = (await repositories.workspaceSettings.get("default")).settings;
    expect(settings.mcpServers ?? []).toEqual([]);
    expect(settings.mcpPeople ?? []).toEqual([]);
    expect(runtime.tools.list().filter((tool) => tool.id.startsWith("mcp."))).toEqual([]);
    // Its tools.search line too: a server added again under the name starts with Tavi's own.
    expect(await runtime.store.getMeta("mcp.searchLine.mcp.raw")).toBe("");
  }, 120_000);

  it("removing one of several versions removes only that version", async () => {
    const { data, at } = await installed();
    const server = directories.create("tavi-mcp-raw2-");
    writeFileSync(join(server, "raw.mjs"), readFileSync(RAW));
    expect(
      (await tavi(["mcp", "add", "raw", "--dir", server, "--version", "2.0.0", "--no-probe", ...at, "--", "node", "raw.mjs"])).code,
    ).toBe(EXIT.ok);
    const removed = await tavi(["plugins", "remove", "mcp.raw", "--version", "2.0.0", ...at]);
    expect(removed.code, removed.stderr).toBe(EXIT.ok);
    expect(removed.stdout).toBe("removed mcp.raw 2.0.0\n");
    expect(existsSync(join(data, "plugins", "mcp.raw", "1.0.0"))).toBe(true);
    expect(await createLocalCredentialStore(data).getSecret("plugins.mcp.raw.token")).toBe("raw-secret");
    expect((await tavi(["mcp", "list", ...at])).stdout).toContain("mcp.raw@1.0.0");
  }, 120_000);

  it("remove-all prints the commands, and with --yes runs them", async () => {
    const { at } = await installed();
    const printed = await tavi(["mcp", "remove-all", ...at]);
    expect(printed.stdout).toBe("tavi plugins disable mcp.raw\ntavi plugins remove mcp.raw\n(run them, or tavi mcp remove-all --yes)\n");
    expect((await tavi(["mcp", "remove-all", "--yes", ...at])).code).toBe(EXIT.ok);
    expect((await tavi(["mcp", "list", ...at])).stdout).toContain("no MCP servers");
  }, 120_000);
});
