import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  UNATTENDED_TASK_POLICY,
  evaluateGate,
  provenanceChips,
  refEstablished,
  toolResultLabel,
  type McpToolRecord,
  type SessionGrant,
} from "@tavi/contracts";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { ToolRegistry } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { mcpCommand, pluginsCommand } from "../../src/server/config-commands.js";
import { EXIT, main } from "../../src/main.js";
import { McpBridge, argumentFloor, mcpAssessment, mcpToolOutput, mcpToolSink, signInForChat } from "../../src/features/mcp/bridge.js";
import { loginRequired } from "../../src/features/mcp/oauth-provider.js";
import { McpSupervisor } from "../../src/features/mcp/supervisor.js";
import { taskContextLabel } from "../../src/features/doctor/reports.js";
import { capture } from "../support/attached-owner.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/** MCP tools in Tavi's registry and at the gate. */

const RAW = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mcp"), "raw-server.mjs");
const directories = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  directories.cleanup();
});

const record = (
  effect: McpToolRecord["suggestedEffect"],
  extra: Partial<NonNullable<McpToolRecord["decision"]>> = {},
  name = "HassTurnOn",
): McpToolRecord => ({
  pluginId: "mcp.home",
  version: "1.0.0",
  name,
  toolId: `mcp.home.${name.toLowerCase()}`,
  observedDefHash: "x",
  observedDef: { name, inputSchema: { type: "object" } },
  suggestedEffect: effect,
  doubtful: false,
  flagged: false,
  state: "approved",
  decision: { effect, timeoutMs: 60_000, askTainted: false, ...extra },
});

describe("the reading of one call", () => {
  it("declares its sink: a payload to the network, else none for a read and persist for a write", () => {
    expect(mcpToolSink("read-only", true)).toEqual({ sink: "network", urlOnly: false });
    expect(mcpToolSink("read-only", false)).toEqual({ sink: "none" });
    expect(mcpToolSink("mutating", false)).toEqual({ sink: "persist" });
    expect(mcpToolSink("external", false)).toEqual({ sink: "persist" });
  });

  it("an argument floor fails closed: only a safe value named by its argument escapes it", () => {
    const floors = [{ risk: "critical" as const, identify: ["domain"], safe: ["light"] }];
    expect(argumentFloor(floors, { domain: "light" })).toBe("low");
    expect(argumentFloor(floors, { domain: "lock" })).toBe("critical");
    expect(argumentFloor(floors, {})).toBe("critical");
    // Every identifying argument the call names counts, not only the first.
    const two = [{ risk: "critical" as const, identify: ["domain", "entity_id"], safe: ["light", "light.kitchen"] }];
    expect(argumentFloor(two, { domain: "light", entity_id: "lock.front" })).toBe("critical");
    expect(argumentFloor(two, { domain: "light", entity_id: "light.kitchen" })).toBe("low");
  });

  it("names the server, never subjects, asks under taint unless its sink is none, and a critical floor is once only", () => {
    const read = mcpAssessment({ serverName: "Home", tool: record("read-only"), sink: "none" }, { entity: "kitchen" });
    expect(read).toMatchObject({ display: { title: "Home: HassTurnOn" }, subjects: [], risk: "low", alwaysAnyCall: false });
    expect(read.askWhenTainted).toBeUndefined();
    expect(mcpAssessment({ serverName: "Home", tool: record("read-only"), sink: "network", host: "ha.local" }, {})).toMatchObject({
      askWhenTainted: true,
      display: { host: "ha.local" },
    });
    expect(mcpAssessment({ serverName: "Home", tool: record("mutating"), sink: "persist" }, {})).toMatchObject({
      askWhenTainted: true,
      risk: "medium",
    });
    // The account it acts as is on the card: two Calendar accounts are told apart.
    expect(
      mcpAssessment({ serverName: "Calendar", tool: record("mutating"), sink: "persist", identity: "work@example.com" }, {}).display.title,
    ).toMatch(/^Calendar \(work@example\.com\): /);
    expect(mcpAssessment({ serverName: "Home", tool: record("external", { minRisk: "critical" }), sink: "persist" }, {})).toMatchObject({
      risk: "critical",
      onceOnly: true,
    });
    // Long arguments are shown by digest.
    expect(
      mcpAssessment({ serverName: "Home", tool: record("read-only"), sink: "none" }, { text: "x".repeat(400) }).display.detail,
    ).toMatch(/^arguments \d+ characters, sha256 [a-f0-9]{16}$/);
    // Tavi's own words in the workspace's language; the server's name and tool as the server says them.
    const floored = { serverName: "Home", tool: record("external", { minRisk: "high" }), sink: "persist" as const };
    expect(mcpAssessment(floored, {}).reasons).toEqual(["an MCP tool of Home, approved as external with a high floor"]);
    expect(mcpAssessment(floored, {}, { locale: "bg" })).toMatchObject({
      display: { title: "Home: HassTurnOn" },
      reasons: ["MCP инструмент на Home, одобрен като външен с риск поне висок"],
    });
    expect(
      mcpAssessment({ serverName: "Home", tool: record("read-only"), sink: "none" }, { text: "x".repeat(400) }, { locale: "bg" }).display
        .detail,
    ).toMatch(/^аргументи: \d+\u00a0знака, sha256 [a-f0-9]{16}$/);
  });

  it("passes content on, with links listed and images noted", () => {
    expect(mcpToolOutput({ content: { ok: 1 }, images: [], links: [] })).toEqual({ ok: 1 });
    expect(mcpToolOutput({ content: "a", images: [{ mimeType: "image/png", data: "" }], links: [{ uri: "https://x" }] })).toEqual({
      content: "a",
      links: [{ uri: "https://x" }],
      images: "1 image(s) not shown",
    });
  });
});

describe("at the gate", () => {
  const gate = (
    tool: McpToolRecord,
    sink: "none" | "persist" | "network",
    tainted: boolean,
    options: { readonly taintMode?: "off" | "observe" | "enforce"; readonly grants?: readonly SessionGrant[] } = {},
  ) =>
    evaluateGate({
      toolId: tool.toolId,
      effect: tool.decision?.effect ?? "external",
      assessment: mcpAssessment({ serverName: "Home", tool, sink }, {}),
      rules: [],
      sessionGrants: options.grants ?? [],
      gatedEffects: new Set(["mutating", "external"]),
      tainted,
      sink,
      ...(sink === "network" ? { urlOnly: false } : {}),
      taintMode: options.taintMode ?? "observe",
    });
  const grant = (toolId: string): SessionGrant => ({
    grantId: "g1",
    taskId: "t1",
    workspaceId: "default",
    toolId,
    approvalId: "a1",
    createdBy: "operator",
    createdAt: "2026-10-14T00:00:00.000Z",
  });

  it("a mutating tool asks; a bare approval is once or session, never always", () => {
    const verdict = gate(record("mutating"), "persist", false);
    expect(verdict.decision).toBe("ask");
    expect(verdict.allowedScopes).not.toContain("always");
  });

  it("a session grant covers that one tool: HassTurnOn's does not allow HassTurnOff", () => {
    const on = record("mutating");
    const off = record("mutating", {}, "HassTurnOff");
    expect(gate(on, "persist", false, { grants: [grant(on.toolId)] }).decision).toBe("allow");
    expect(gate(off, "persist", false, { grants: [grant(on.toolId)] }).decision).toBe("ask");
  });

  it("a critical tool asks every time, once only, even with a grant", () => {
    const tool = record("external", { minRisk: "critical" });
    const verdict = gate(tool, "persist", false, { grants: [grant(tool.toolId)] });
    expect(verdict.decision).toBe("ask");
    expect(verdict.allowedScopes).toEqual(["once"]);
  });

  it("a read-only no-network tool never asks, tainted or not", () => {
    expect(gate(record("read-only"), "none", false).decision).toBe("allow");
    expect(gate(record("read-only"), "none", true).decision).toBe("allow");
  });

  it("a mutating no-network tool asks once in a tainted chat, a grant notwithstanding", () => {
    const tool = record("mutating");
    const verdict = gate(tool, "persist", true, { grants: [grant(tool.toolId)] });
    expect(verdict.decision).toBe("ask");
    expect(verdict.allowedScopes).toEqual(["once"]);
  });

  // In every taint mode, `off` included: an MCP tool's ask under taint is its own, not the mode's.
  for (const taintMode of ["off", "observe", "enforce"] as const) {
    it(`a read-only remote tool asks once after an untrusted result and not before, under ${taintMode}, with a grant too`, () => {
      const tool = record("read-only");
      expect(gate(tool, "network", false, { taintMode }).decision).toBe("allow");
      const tainted = gate(tool, "network", true, { taintMode, grants: [grant(tool.toolId)] });
      expect(tainted.decision).toBe("ask");
      expect(tainted.allowedScopes).toEqual(["once"]);
    });
  }
});

describe("a sign-in error in a chat", () => {
  const attended = { mode: "attended", humanQuestionsAllowed: true, workerWaitsAllowed: true } as const;
  it("tells the model the person was shown a Connect button, in a run a person attends", () => {
    const rewritten = signInForChat(loginRequired("mcp.gcal", "it is not signed in"), "Google Calendar", "mcp.gcal", attended);
    expect(rewritten).toMatchObject({
      code: "NOT_AUTHORIZED",
      message:
        "Google Calendar needs the person to sign in again. Tavi has shown them a Connect button in this chat; tell them, and continue once they say it's done.",
      details: { mcpFailure: "login", pluginId: "mcp.gcal", connectCard: true },
    });
  });

  it("keeps today's error in a run nobody attends, and every other error as it came", () => {
    const login = loginRequired("mcp.gcal", "it is not signed in");
    expect(signInForChat(login, "Google Calendar", "mcp.gcal", UNATTENDED_TASK_POLICY)).toBe(login);
    expect(signInForChat(login, "Google Calendar", "mcp.gcal", undefined)).toBe(login);
    expect(login.details).toMatchObject({ mcpFailure: "login", pluginId: "mcp.gcal" });
    const other = new Error("boom");
    expect(signInForChat(other, "Google Calendar", "mcp.gcal", attended)).toBe(other);
  });
});

describe("labels", () => {
  it("a result is untrusted, from mcp, said by tool:<name>, and its card names the server", () => {
    const label = toolResultLabel(
      { untrustedOutput: true, outputSource: "mcp", outputPrincipal: "tool:home" },
      { id: "call-1", input: { entity: "kitchen" } },
      { untrusted: false },
      "2026-10-14T00:00:00.000Z",
    );
    expect(label).toMatchObject({ integrity: "untrusted", sources: ["mcp"], principals: ["tool:home"] });
    expect(refEstablished({ source: "mcp", host: "home" })).toBe("the MCP server home");
    expect(provenanceChips(label).map((chip) => chip.established)).toContain("the MCP server home");
    // A handler cannot name another principal: an external tool's own label keeps only integrity and confidentiality.
    const claimed = toolResultLabel(
      { untrustedOutput: true, outputSource: "mcp", outputPrincipal: "tool:home" },
      { id: "call-2", input: {} },
      { untrusted: true, label: { principals: ["operator"], source: "web" } },
      "2026-10-14T00:00:00.000Z",
    );
    expect(claimed.principals).toEqual(["tool:home"]);
    expect(claimed.sources).toEqual(["mcp"]);
    // A URL the model put in the arguments never names the server.
    const urlArgument = toolResultLabel(
      { untrustedOutput: true, outputSource: "mcp", outputPrincipal: "tool:home" },
      { id: "call-3", input: { url: "https://attacker.example/x" } },
      { untrusted: false },
      "2026-10-14T00:00:00.000Z",
    );
    expect(provenanceChips(urlArgument).map((chip) => chip.established)).toEqual(["the MCP server home"]);
  });
});

describe("the registry", () => {
  it("refuses an enable that overflows the budget, naming the count; a server that may be deferred always fits", async () => {
    const registry = new ToolRegistry();
    registry.registerBatch(
      Array.from({ length: 100 }, (_, index) => ({
        id: `core.t${String(index)}`,
        version: "1",
        description: "t",
        effect: "read-only" as const,
        requiredPermissions: [],
        inputSchema: z.object({}),
        sink: "none" as const,
        handler: async () => "",
      })),
    );
    const bridge = new McpBridge({
      registry: {} as never,
      mcp: {} as never,
      tools: registry,
      supervisor: new McpSupervisor({ dataDirectory: directories.create("tavi-mcp-bridge-"), spec: async () => undefined }),
      workspaceSettings: async () => ({}),
      allWorkspaceSettings: async () => [],
      operatorOf: () => "operator",
      now: () => "2026-10-14T00:00:00.000Z",
      enabled: async () => true,
    });
    // 128 − (100 built-ins + tools.search) − 8 = 19.
    expect(bridge.limit()).toBe(19);
    // A built-in family a list past 128 defers on every surface (`ATTENDED_DEFERRED_FAMILIES`) takes no room.
    registry.registerBatch(
      ["pdf.read", "routines.list", "todos.update"].map((id) => ({
        id,
        version: "1",
        description: "t",
        effect: "read-only" as const,
        requiredPermissions: [],
        inputSchema: z.object({}),
        sink: "none" as const,
        handler: async () => "",
      })),
    );
    expect(bridge.limit()).toBe(19);
    const block = (exposure: "always" | "auto") =>
      ({ abi: "tavi.mcp/1", transport: "stdio", auth: "none", exposure, maxMessageBytes: 1, concurrency: 1 }) as never;
    await expect(bridge.checkEnable("default", "mcp.big", block("always"), 20)).rejects.toThrow(
      /20 tools, which would make 20 MCP tools listed in default where 19 fit/,
    );
    await expect(bridge.checkEnable("default", "mcp.big", block("always"), 19)).resolves.toBeUndefined();
    await expect(bridge.checkEnable("default", "mcp.big", block("auto"), 50)).resolves.toBeUndefined();
  });

  it("the registry keeps deferred and outputPrincipal", () => {
    const registry = new ToolRegistry();
    registry.registerExternal({
      id: "mcp.docs.search",
      version: "1.0.0",
      description: "d",
      effect: "read-only",
      requiredPermissions: [],
      inputSchema: z.object({}),
      sink: "none",
      deferred: true,
      outputPrincipal: "tool:docs",
      outputSource: "mcp",
      handler: async () => "",
    });
    expect(registry.list()[0]).toMatchObject({ deferred: true, outputPrincipal: "tool:docs", outputSource: "mcp" });
  });
});

describe("a server's tools in the owner", () => {
  async function tavi(argv: readonly string[]) {
    const out = capture();
    const code = await main([...argv], { io: out.io });
    return { code, stdout: out.stdout(), stderr: out.stderr() };
  }

  it("offering a server's tools leaves a clean chat clean: its approved descriptions add nothing to the chat's label", async () => {
    const data = directories.create("tavi-mcp-bridge-");
    const at = ["--data-dir", data];
    const server = directories.create("tavi-mcp-raw-");
    writeFileSync(join(server, "raw.mjs"), readFileSync(RAW));
    expect((await tavi(["mcp", "add", "raw", "--dir", server, "--unsandboxed", ...at, "--", "node", "raw.mjs"])).code).toBe(EXIT.ok);
    expect(
      (await tavi(["mcp", "approve", "mcp.raw", "1.0.0", "--unsandboxed", "--effect", "connect=external", "--disable", "write", ...at]))
        .code,
    ).toBe(EXIT.ok);
    expect((await tavi(["plugins", "enable", "mcp.raw", ...at])).code).toBe(EXIT.ok);
    const model = createFixtureModel({ turns: [{ text: "done" }] });
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(data), { modelOverride: model });
    runtimes.push(runtime);
    const workflow =
      runtime.workflow ??
      (() => {
        throw new Error("no workflow");
      })();
    const turn = await workflow.admit({
      context: { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" },
      operationKey: "clean-1",
      kind: "start",
      prompt: "hello",
      origin: "web",
    });
    expect(turn.outcome.status).toBe("completed");
    // Its tools were offered, descriptions and all…
    expect(model.calls[0]?.tools.map((tool) => tool.id)).toContain("mcp.raw.echo");
    // …and the chat stays trusted: a later persist call such as routines.resume is not asked about for taint.
    const task = await runtime.store.asPort().repositories.tasks.get(turn.taskId);
    if (task === undefined) throw new Error("no task");
    const label = await taskContextLabel(runtime, task);
    expect(label === null || label.integrity === "trusted").toBe(true);
  }, 60_000);

  it("offers an enabled server's approved tools in its workspace, to its operator, calls them, and reconciles live", async () => {
    const data = directories.create("tavi-mcp-bridge-");
    const at = ["--data-dir", data];
    const server = directories.create("tavi-mcp-raw-");
    writeFileSync(join(server, "raw.mjs"), readFileSync(RAW));
    // Unsandboxed, so this runs on every platform: the bridge does not care which state was approved.
    expect((await tavi(["mcp", "add", "raw", "--dir", server, "--unsandboxed", ...at, "--", "node", "raw.mjs"])).code).toBe(EXIT.ok);
    const approved = await tavi([
      "mcp",
      "approve",
      "mcp.raw",
      "1.0.0",
      "--unsandboxed",
      "--effect",
      "connect=external",
      "--disable",
      "write",
      ...at,
    ]);
    expect(approved.code, approved.stderr).toBe(EXIT.ok);
    expect((await tavi(["plugins", "enable", "mcp.raw", ...at])).code).toBe(EXIT.ok);
    // Turned on explicitly, whatever the default.
    expect((await tavi(["mcp", "on", ...at])).code).toBe(EXIT.ok);
    expect((await tavi(["config", "get", "mcp.servers", ...at])).stdout).toContain("mcp.servers = mcp.raw (set)");

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
    const offered = async (context: { workspaceId: string; operator?: boolean }) =>
      (await runtime.tools.listOffered(context)).map((tool) => tool.id).filter((id) => id.startsWith("mcp."));
    expect(await offered({ workspaceId: "default", operator: true })).toEqual([
      "mcp.raw.connect",
      "mcp.raw.echo",
      "mcp.raw.env",
      "mcp.raw.fetch",
      "mcp.raw.read",
    ]);
    // A workspace whose mcp.servers does not list it, and another person's chat, are offered nothing.
    expect(await offered({ workspaceId: "other", operator: true })).toEqual([]);
    expect(await offered({ workspaceId: "default", operator: false })).toEqual([]);
    const echo = runtime.tools.get("mcp.raw.echo");
    // Unsandboxed, the server reaches any network: even its reads are egress-capable and ask under taint.
    expect(echo).toMatchObject({
      untrustedOutput: true,
      outputSource: "mcp",
      outputPrincipal: "tool:raw",
      sink: "network",
      urlOnly: false,
      effect: "read-only",
    });
    expect(echo?.assess?.({ text: "x" }, { workspaceId: "default", principalId: "operator", runId: "t", caller: "test" })).toMatchObject({
      askWhenTainted: true,
    });
    expect(echo?.description).toMatch(/^\[raw\] /);
    expect(runtime.tools.get("mcp.raw.connect")).toMatchObject({ effect: "external", sink: "network" });
    // A list assembled without knowing the person offers none.
    expect(await offered({ workspaceId: "default" })).toEqual([]);
    const context = { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "test" };
    expect(await echo?.handler({ input: { text: "hello" }, context, signal: new AbortController().signal })).toBe("hello");
    // Another person, before and after `tavi mcp people … on`.
    await expect(
      echo?.handler({ input: { text: "x" }, context: { ...context, principalId: "bob" }, signal: new AbortController().signal }),
    ).rejects.toThrow(/not offered here/);
    expect((await mcpCommand(runtime, { action: "people", pluginId: "mcp.raw", on: true, workspaceId: "default" }, "operator")).ok).toBe(
      true,
    );
    expect(await offered({ workspaceId: "default", operator: false })).toContain("mcp.raw.echo");
    // Disabled while the owner runs: withdrawn at once; enabled again: back, without a restart.
    expect((await pluginsCommand(runtime, { action: "disable", pluginId: "mcp.raw" }, "operator")).ok).toBe(true);
    expect(runtime.tools.get("mcp.raw.echo")).toBeUndefined();
    expect((await pluginsCommand(runtime, { action: "enable", pluginId: "mcp.raw" }, "operator")).ok).toBe(true);
    expect(await offered({ workspaceId: "default", operator: true })).toContain("mcp.raw.echo");
    expect(runtime.mcp.bridge.registered().get("mcp.raw")).toMatchObject({ listed: 5, deferred: false });
  }, 120_000);
});

describe("exposure and search everywhere", () => {
  async function tavi(argv: readonly string[]) {
    const out = capture();
    const code = await main([...argv], { io: out.io });
    return { code, stdout: out.stdout(), stderr: out.stderr() };
  }

  it("a 40-tool server waits behind tools.search: a channel turn's first call carries none of its schemas, and finds and calls one within two generations", async () => {
    const data = directories.create("tavi-mcp-bridge-");
    const at = ["--data-dir", data];
    const server = directories.create("tavi-mcp-big-");
    writeFileSync(join(server, "raw.mjs"), readFileSync(RAW));
    // 6 tools of its own and 34 more: 40 in all.
    const changes = join(server, "tools.json");
    writeFileSync(
      changes,
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 34 }, (_, index) => [
            `bin${String(index + 1).padStart(2, "0")}`,
            `Counts the widgets in bin ${String(index + 1)}.`,
          ]),
        ),
      ),
    );
    expect(
      (await tavi(["mcp", "add", "big", "--dir", server, "--unsandboxed", "--env", `RAW_TOOLS=${changes}`, ...at, "--", "node", "raw.mjs"]))
        .code,
    ).toBe(EXIT.ok);
    const approved = await tavi(["mcp", "approve", "mcp.big", "1.0.0", "--unsandboxed", ...at]);
    expect(approved.code, approved.stderr).toBe(EXIT.ok);
    expect((await tavi(["plugins", "enable", "mcp.big", ...at])).code).toBe(EXIT.ok);
    // The review counts what offering it costs, and shows Tavi's own line until the operator writes one.
    const shown = await tavi(["mcp", "show", "mcp.big", ...at]);
    expect(shown.stdout).toMatch(
      /tools\.search line \(Tavi's own; yours with `tavi mcp line`\): big: 40 tools \(bin01, bin02, .*, write\)/,
    );
    expect(shown.stdout).toMatch(/schema tokens: \d{3,} for its approved tools/);

    const model = createFixtureModel({
      turns: [
        { toolCall: { id: "call-1", name: "tools.search", input: { query: "widgets bin 17" } } },
        { toolCall: { id: "call-2", name: "mcp.big.bin17", input: {} } },
        { text: "bin 17 counted" },
      ],
    });
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(data), { modelOverride: model });
    runtimes.push(runtime);
    expect(runtime.mcp.bridge.registered().get("mcp.big")).toMatchObject({ listed: 0, deferred: true });
    const workflow =
      runtime.workflow ??
      (() => {
        throw new Error("no workflow");
      })();
    const turn = await workflow.admit({
      context: { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "test" },
      operationKey: "big-1",
      kind: "start",
      prompt: "How many widgets are in bin 17?",
      origin: "messaging",
    });
    expect([turn.outcome.status, turn.outcome.finalText]).toEqual(["completed", "bin 17 counted"]);
    const first = model.calls[0]?.tools ?? [];
    expect(first.filter((tool) => tool.id.startsWith("mcp."))).toEqual([]);
    expect(first.find((tool) => tool.id === "tools.search")?.description).toContain("- big: 40 tools (");
    expect(model.calls[1]?.tools.map((tool) => tool.id)).toContain("mcp.big.bin17");
    // The call reached the server (the fake answers an added tool it has no handler for with an error).
    expect(JSON.stringify(model.calls[2]?.messages)).toContain("unknown tool bin17");
    expect(model.calls).toHaveLength(3);

    // Another person's chat sees no line for it until the operator opens it to them.
    const bob = { workspaceId: "default", principalId: "bob", operator: false };
    expect(await runtime.mcp.bridge.searchLines(bob)).toEqual([]);
    expect((await mcpCommand(runtime, { action: "people", pluginId: "mcp.big", on: true, workspaceId: "default" }, "operator")).ok).toBe(
      true,
    );
    expect(await runtime.mcp.bridge.searchLines(bob)).toEqual([expect.stringMatching(/^big: 40 tools/)]);
    // The operator's own line replaces Tavi's on the next turn, and --clear brings Tavi's back.
    expect((await mcpCommand(runtime, { action: "line", pluginId: "mcp.big", text: "Widget bins: counts per bin" }, "operator")).ok).toBe(
      true,
    );
    expect(await runtime.mcp.bridge.searchLines({ workspaceId: "default", principalId: "operator", operator: true })).toEqual([
      "Widget bins: counts per bin",
    ]);
    expect((await mcpCommand(runtime, { action: "line", pluginId: "mcp.big" }, "operator")).ok).toBe(true);
    expect(await runtime.mcp.bridge.searchLines({ workspaceId: "default", principalId: "operator", operator: true })).toEqual([
      expect.stringMatching(/^big: 40 tools/),
    ]);
  }, 120_000);

  it("an offline overflow raises a budget notice at start; allowing it again is refused, and the notice closes once it fits", async () => {
    const data = directories.create("tavi-mcp-bridge-");
    const at = ["--data-dir", data];
    const server = directories.create("tavi-mcp-over-");
    writeFileSync(join(server, "raw.mjs"), readFileSync(RAW));
    // 6 tools of its own and 114 more, always listed: more than any workspace fits beside Tavi's own.
    const changes = join(server, "tools.json");
    writeFileSync(
      changes,
      JSON.stringify(Object.fromEntries(Array.from({ length: 114 }, (_, index) => [`t${String(index)}`, `Tool ${String(index)}.`]))),
    );
    expect(
      (
        await tavi([
          "mcp",
          "add",
          "over",
          "--dir",
          server,
          "--unsandboxed",
          "--exposure",
          "always",
          "--env",
          `RAW_TOOLS=${changes}`,
          ...at,
          "--",
          "node",
          "raw.mjs",
        ])
      ).code,
    ).toBe(EXIT.ok);
    expect((await tavi(["mcp", "approve", "mcp.over", "1.0.0", "--unsandboxed", ...at])).code).toBe(EXIT.ok);
    // Offline, nothing checks the budget: the owner's start does.
    expect((await tavi(["plugins", "enable", "mcp.over", ...at])).code).toBe(EXIT.ok);
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(data), {
      modelOverride: createFixtureModel({ turns: [{ text: "done" }] }),
    });
    runtimes.push(runtime);
    const repositories = runtime.store.asPort().repositories;
    const open = async () =>
      (await repositories.mcp.listNotices({ pluginId: "mcp.over", open: true })).map((notice) => [notice.kind, notice.detail]);
    expect(await open()).toEqual([["budget", { workspaces: [{ workspaceId: "default", used: 120, limit: runtime.mcp.bridge.limit() }] }]]);
    // Taken out of the workspace, it fits again: the notice closes on the next check.
    const current = await repositories.workspaceSettings.get("default");
    await repositories.workspaceSettings.set({
      workspaceId: "default",
      settings: { ...current.settings, mcpServers: [] },
      expectedRevision: current.revision,
      actor: "operator",
      now: "2026-10-14T00:00:00.000Z",
    });
    await runtime.mcp.checkBudget();
    expect(await open()).toEqual([]);
    // Allowing it again, as `config set mcp.servers` or an enable does, is refused, naming the count.
    await expect(runtime.mcp.checkEnable("mcp.over", undefined, "default")).rejects.toThrow(
      /mcp\.over has 120 tools, which would make 120 MCP tools listed in default where \d+ fit/,
    );
  }, 120_000);

  it("auto lists a server of at most eight tools, and search-defers a larger one", async () => {
    const data = directories.create("tavi-mcp-bridge-");
    const at = ["--data-dir", data];
    const server = directories.create("tavi-mcp-nine-");
    writeFileSync(join(server, "raw.mjs"), readFileSync(RAW));
    const changes = join(server, "tools.json");
    writeFileSync(changes, JSON.stringify({ two: "Two.", three: "Three." }));
    expect(
      (
        await tavi([
          "mcp",
          "add",
          "eight",
          "--dir",
          server,
          "--unsandboxed",
          "--env",
          `RAW_TOOLS=${changes}`,
          ...at,
          "--",
          "node",
          "raw.mjs",
        ])
      ).code,
    ).toBe(EXIT.ok);
    expect((await tavi(["mcp", "approve", "mcp.eight", "1.0.0", "--unsandboxed", ...at])).code).toBe(EXIT.ok);
    expect((await tavi(["plugins", "enable", "mcp.eight", ...at])).code).toBe(EXIT.ok);
    writeFileSync(changes, JSON.stringify({ two: "Two.", three: "Three.", four: "Four." }));
    expect(
      (
        await tavi([
          "mcp",
          "add",
          "nine",
          "--dir",
          server,
          "--unsandboxed",
          "--env",
          `RAW_TOOLS=${changes}`,
          ...at,
          "--",
          "node",
          "raw.mjs",
        ])
      ).code,
    ).toBe(EXIT.ok);
    expect((await tavi(["mcp", "approve", "mcp.nine", "1.0.0", "--unsandboxed", ...at])).code).toBe(EXIT.ok);
    expect((await tavi(["plugins", "enable", "mcp.nine", ...at])).code).toBe(EXIT.ok);
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(data), {
      modelOverride: createFixtureModel({ turns: [{ text: "done" }] }),
    });
    runtimes.push(runtime);
    expect(runtime.mcp.bridge.registered().get("mcp.eight")).toMatchObject({ listed: 8, deferred: false });
    expect(runtime.mcp.bridge.registered().get("mcp.nine")).toMatchObject({ listed: 0, deferred: true });
    expect(await runtime.mcp.bridge.searchLines({ workspaceId: "default", principalId: "operator", operator: true })).toEqual([
      expect.stringMatching(/^nine: 9 tools/),
    ]);
  }, 120_000);
});

describe("heartbeat and schedules", () => {
  async function tavi(argv: readonly string[]) {
    const out = capture();
    const code = await main([...argv], { io: out.io });
    return { code, stdout: out.stdout(), stderr: out.stderr() };
  }

  it("a heartbeat may choose an MCP server's read-only tools and no other; a schedule may list one only by its exact id", async () => {
    const data = directories.create("tavi-mcp-bridge-");
    const at = ["--data-dir", data];
    const server = directories.create("tavi-mcp-raw-");
    writeFileSync(join(server, "raw.mjs"), readFileSync(RAW));
    expect((await tavi(["mcp", "add", "raw", "--dir", server, "--unsandboxed", ...at, "--", "node", "raw.mjs"])).code).toBe(EXIT.ok);
    expect((await tavi(["mcp", "approve", "mcp.raw", "1.0.0", "--unsandboxed", ...at])).code).toBe(EXIT.ok);
    expect((await tavi(["plugins", "enable", "mcp.raw", ...at])).code).toBe(EXIT.ok);

    // A schedule: a read-only MCP tool by its id; never a write, a wildcard over the server, or a tool not approved.
    const schedule = ["schedules", "add", "--name", "docs", "--at", "07:00", "--timezone", "UTC", "--prompt", "check", ...at];
    expect((await tavi([...schedule, "--allow", "mcp.raw.echo"])).code).toBe(EXIT.ok);
    const write = await tavi([...schedule.map((arg) => (arg === "docs" ? "docs2" : arg)), "--allow", "mcp.raw.write"]);
    expect(write.stderr).toContain("a schedule may list only read-only MCP tools, and it is external");
    const wildcard = await tavi([...schedule.map((arg) => (arg === "docs" ? "docs3" : arg)), "--allow", "mcp.raw.*"]);
    expect(wildcard.stderr).toContain("name each read-only MCP tool a schedule may use");
    const unknown = await tavi([...schedule.map((arg) => (arg === "docs" ? "docs4" : arg)), "--allow", "mcp.raw.nothing"]);
    expect(unknown.stderr).toContain("is not an approved MCP tool");

    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(data), {
      modelOverride: createFixtureModel({ turns: [{ text: "done" }] }),
    });
    runtimes.push(runtime);
    const choices = runtime.heartbeat
      .toolChoices()
      .map((choice) => choice.id)
      .filter((id) => id.startsWith("mcp."));
    expect(choices.sort()).toEqual(["mcp.raw.echo", "mcp.raw.env", "mcp.raw.read"]);
  }, 120_000);
});
