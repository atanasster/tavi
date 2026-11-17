import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { inspectDatabase } from "../support/database-fixture.js";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { nodeScheduler, openConnection, openSocket, readOwner } from "@tavi/client/node";
import {
  AGENTS_MAILBOX_LIMIT,
  nextOccurrence,
  type AgentsListResult,
  type ModelOutcome,
  type ModelPort,
  type SchedulePreviewResult,
  type ScheduleToolsResult,
} from "@tavi/contracts";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { temporaryDirectories, waitFor } from "@tavi/test-support";
import { startOpenAiStub, type OpenAiStub } from "@tavi/test-support/openai-stub";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { CliIo } from "../../src/cli/io.js";
import type { OwnerModelTarget } from "../../src/features/run/owner.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";

/**
 * The configuration commands under a live owner: `agents`
 * read-only, `models` with `restartRequired`, `credentials` through the local
 * store, `projects`, and `schedules` including a fire now.
 */

const directories = temporaryDirectories({ prefix: "tavi-config-ipc-" });
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];

/** An OpenAI-compatible endpoint that records the credential each request carried. */
let endpoint: { readonly baseUrl: string; readonly authorizations: readonly string[] } | undefined;
let stub: OpenAiStub | undefined;

beforeAll(async () => {
  const started = await startOpenAiStub({ models: ["stub-model"] });
  stub = started;
  endpoint = {
    baseUrl: started.baseUrl,
    get authorizations() {
      return started.requests.map((request) => request.authorization ?? "(none)");
    },
  };
});

afterAll(async () => {
  await stub?.close();
});

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

const quietIo: CliIo = { stdout: () => {}, stderr: () => {}, isTty: false };

/** A model that answers — held until `until` settles, when given. */
function answering(until?: Promise<void>): ModelPort {
  return {
    async stream(request, options): Promise<ModelOutcome> {
      if (until !== undefined) await until;
      options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text: "brief" });
      return { status: "completed", attemptId: request.attemptId, text: "brief", toolCalls: [], usage: {} };
    },
  };
}

const resolvedFromDefault: OwnerModelTarget = {
  source: "default",
  connectionId: "running-conn",
  model: "running-model",
  workspaceId: "default",
};

async function owner(
  options: {
    readonly target?: OwnerModelTarget;
    readonly model?: ModelPort;
    readonly providers?: readonly { readonly baseUrl: string; readonly credentialRef: string }[];
    /** Launcher bindings, reference → file (a bot token's, say). */
    readonly bindings?: Readonly<Record<string, string>>;
  } = {},
): Promise<{ readonly handle: ServeHandle; readonly client: IpcClient; readonly directory: string }> {
  const directory = directories.create();
  const handle = await serve(
    {
      dataDirectory: directory,
      workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      providers: (options.providers ?? []).map((provider, index) => ({
        connectionId: `launch-${index}`,
        kind: "openai-compatible" as const,
        baseUrl: provider.baseUrl,
        credentialRef: provider.credentialRef,
      })),
      credentials: Object.fromEntries(Object.entries(options.bindings ?? {}).map(([reference, file]) => [reference, { fromFile: file }])),
      defaultConnectionId: "running-conn",
      defaultModel: "running-model",
      logger: { level: "error", sink: () => {} },
      scheduleSweepEnabled: false,
    },
    { dataDirectory: directory, drainDeadlineMs: 5_000, ...(options.target === undefined ? {} : { modelTarget: options.target }) },
    quietIo,
    { modelOverride: options.model ?? answering() },
  );
  handles.push(handle);
  const discovered = await findLiveOwner(directory);
  if (discovered === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(discovered);
  clients.push(client);
  return { handle, client, directory };
}

const schedule = (scheduleId: string, name: string, workspaceId = "default") => ({
  scheduleId,
  workspaceId,
  principalId: "operator",
  name,
  prompt: "write the brief",
  spec: { at: "07:00", timezone: "UTC" },
  missedRunPolicy: "skip" as const,
  autoApproveTools: [],
  enabled: true,
  nextRunAt: "2030-01-01T07:00:00.000Z",
  now: "2026-01-01T00:00:00.000Z",
});

describe("configuration commands under an owner", () => {
  it("lists agents read-only, without the prompts that would not fit a frame", async () => {
    const { handle, client } = await owner();
    await handle.runtime.store.asPort().repositories.agents.create({
      agentId: "brief",
      workspaceId: "default",
      name: "Brief writer",
      systemPrompt: "Write briefs.",
      enabled: true,
      now: "2026-01-01T00:00:00.000Z",
    });
    const listed = await client.request("agents", {}, "agents");
    expect(listed.result).toMatchObject({ agents: [{ agentId: "brief", name: "Brief writer" }], truncated: false });
    expect(JSON.stringify(listed.result)).not.toContain("Write briefs.");
    // One definition is shown whole, instructions included.
    expect((await client.request("agents", { action: "show", agentId: "brief" }, "agents-show")).result).toMatchObject({
      agentId: "brief",
      systemPrompt: "Write briefs.",
    });
    expect((await client.request("agents", { action: "show", agentId: "nobody" }, "agents-none")).error?.code).toBe("NOT_FOUND");
    // A write action is refused by the contract rather than ignored.
    expect((await client.request("agents", { action: "add" }, "agents-add")).error?.code).toBe("INVALID_INPUT");
    // An id another differs from only in case, a name another has, or a name with a control
    // character is refused: nobody could tell the two apart (Mac mini adversarial tests).
    const add = async (agentId: string, name: string, key: string) =>
      (await client.request("agents", { action: "add", agentId, name, prompt: "Help." }, key)).error;
    expect(await add("BRIEF", "Other", "a1")).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("only in case") });
    expect(await add("second", "brief WRITER", "a2")).toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("already named Brief writer"),
    });
    expect((await add("third", "Evil\u001b[2Jname", "a3"))?.code).toBe("INVALID_INPUT");
    expect(await add("second", "Second writer", "a4")).toBe(undefined);
    expect((await client.request("agents", { action: "update", agentId: "second", name: "Brief Writer" }, "a5")).error?.code).toBe(
      "CONFLICT",
    );
  });

  it("reports a task's mailbox beside the agents: addressing only, bounded, and only in the task's workspace", async () => {
    const { handle, client } = await owner();
    const repositories = handle.runtime.store.asPort().repositories;
    const admit = async (taskId: string) =>
      await repositories.tasks.admit({
        prompt: fixturePromptPolicy,
        workspaceId: "default",
        principalId: "operator",
        operationKey: `op-${taskId}`,
        kind: "start",
        intent: { prompt: "hello" },
        checkpointNamespace: "",
        newTaskId: (() => taskId)(),
        newAdmissionId: (() => `adm-${taskId}`)(),
        newThreadId: (() => `thread-${taskId}`)(),
        now: (() => "2026-01-01T00:00:00.000Z")(),
      });
    await admit("task-lead");
    await admit("task-worker");
    const envelope = async (messageId: string, second: number, overrides: Record<string, unknown> = {}) =>
      await repositories.agentMailbox.insertEnvelope({
        messageId,
        protocolVersion: 1,
        workspaceId: "default",
        senderAgentId: "researcher",
        senderTaskId: "task-worker",
        recipientAgentId: "lead",
        recipientTaskId: "task-lead",
        kind: "result",
        content: "the private findings",
        createdAt: `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`,
        deliveryState: "pending",
        retentionState: "active",
        ...overrides,
      });
    // Inserted newest first, so "oldest first" is the answer's order and not the insertion's.
    for (let index = AGENTS_MAILBOX_LIMIT + 1; index >= 0; index -= 1) await envelope(`m-${String(index).padStart(2, "0")}`, index + 1);
    // Received already, or another task's: not in this mailbox.
    await envelope("m-received", 0, { deliveryState: "acknowledged" });
    await envelope("m-elsewhere", 0, { recipientTaskId: "task-worker", recipientAgentId: "researcher" });
    const listed = await client.request("agents", { action: "list", taskId: "task-lead" }, "agents-mailbox");
    const mailbox = (listed.result as AgentsListResult).mailbox;
    expect(mailbox).toMatchObject({ taskId: "task-lead", truncated: true });
    expect(mailbox?.pending).toHaveLength(AGENTS_MAILBOX_LIMIT);
    expect(mailbox?.pending[0]).toEqual({
      messageId: "m-00",
      kind: "result",
      senderAgentId: "researcher",
      senderTaskId: "task-worker",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    expect(mailbox?.pending.map((entry) => entry.messageId)).toEqual(
      Array.from({ length: AGENTS_MAILBOX_LIMIT }, (_, index) => `m-${String(index).padStart(2, "0")}`),
    );
    expect(JSON.stringify(listed.result)).not.toContain("the private findings");
    // An empty mailbox is reported, not left out.
    const worker = ((await client.request("agents", { taskId: "task-worker" }, "agents-worker")).result as AgentsListResult).mailbox;
    expect(worker?.pending.map((entry) => entry.messageId)).toEqual(["m-elsewhere"]);
    await admit("task-idle");
    expect(((await client.request("agents", { taskId: "task-idle" }, "agents-empty")).result as AgentsListResult).mailbox).toEqual({
      taskId: "task-idle",
      pending: [],
      truncated: false,
    });
    // `show` takes no task: refused, not ignored.
    expect(
      (await client.request("agents", { action: "show", agentId: "brief", taskId: "task-lead" }, "agents-show-task")).error?.code,
    ).toBe("INVALID_INPUT");
    // Another workspace's task, or none at all, is not found.
    expect((await client.request("agents", { taskId: "task-lead", workspaceId: "other" }, "agents-other")).error?.code).toBe("NOT_FOUND");
    expect((await client.request("agents", { taskId: "task-nobody" }, "agents-nobody")).error?.code).toBe("NOT_FOUND");
  });

  it("never asks a role-main owner for a restart: writes reach the next turn", async () => {
    const { client } = await owner({
      target: { source: "role", connectionId: "running-conn", model: "running-model", workspaceId: "default" },
    });
    const models = (payload: Record<string, unknown>, requestId: string) => client.request("models", payload, requestId);
    await models(
      { action: "add", connectionId: "running-conn", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "openai.apiKey" },
      "add-running",
    );
    await models(
      { action: "add", connectionId: "other-conn", baseUrl: "http://127.0.0.1:2/v1", credentialRef: "other.apiKey", model: "other-model" },
      "add-other",
    );
    expect(
      (await models({ action: "set-role", role: "main", connectionId: "running-conn", model: "running-model" }, "bind")).result,
    ).toMatchObject({
      restartRequired: false,
    });
    // Connections are read at each call: a rebind reaches the next one.
    expect(
      (await models({ action: "rebind", connectionId: "running-conn", credentialRef: "rotated.apiKey" }, "rebind")).result,
    ).toMatchObject({ restartRequired: false });
    expect((await models({ action: "set-default", connectionId: "other-conn" }, "default")).result).toMatchObject({
      restartRequired: false,
    });
    // Clearing the binding leaves the default, which the owner runs from then on.
    expect((await models({ action: "clear-role", role: "main" }, "clear")).result).toMatchObject({ restartRequired: false });
    expect((await models({ action: "roles" }, "roles")).result).toMatchObject({
      activeTarget: { connectionId: "other-conn", model: "other-model" },
      restartRequired: false,
    });
  });

  it("answers a default or role naming a model the catalog does not list with a warning beside the saved write", async () => {
    const { handle, client } = await owner();
    const models = (payload: Record<string, unknown>, requestId: string) => client.request("models", payload, requestId);
    await models(
      { action: "add", connectionId: "lumen", baseUrl: "http://127.0.0.1:3/v1", credentialRef: "lumen.apiKey", model: "lumen-chat-1" },
      "add-lumen",
    );
    await handle.runtime.store.services.modelConfig.replaceCatalog("lumen", [
      { modelId: "lumen-chat-1", provenance: "live", state: "available", capabilities: [] },
    ]);
    const typo = await models({ action: "set-default", connectionId: "lumen", model: "lumen-chat-l" }, "typo");
    expect(typo.result).toMatchObject({
      result: { target: { connectionId: "lumen", model: "lumen-chat-l" } },
      warning: expect.stringContaining("lumen does not list the model lumen-chat-l; did you mean lumen-chat-1?"),
    });
    const listed = await models({ action: "set-role", role: "fast", connectionId: "lumen", model: "lumen-chat-1" }, "listed");
    expect(listed.result).not.toHaveProperty("warning");
  });

  it("warns when a key another connection uses at another origin is shared, and a refused test names both and the way out", async () => {
    const { client } = await owner();
    const models = (payload: Record<string, unknown>, requestId: string) => client.request("models", payload, requestId);
    const first = await models({ action: "add", connectionId: "local", baseUrl: "http://127.0.0.1:18088/v1", credentialRef: "local" }, "a");
    expect(first.result).not.toHaveProperty("warning");
    const second = await models(
      { action: "add", connectionId: "other", baseUrl: "http://localhost:18088/v1", credentialRef: "local" },
      "b",
    );
    expect(second.result).toMatchObject({
      warning: expect.stringContaining(
        "credential local is also used by the connection local at http://127.0.0.1:18088; while `tavi serve` runs, `tavi models test` refuses a key shared across addresses",
      ),
    });
    const refused = await models({ action: "test", connectionId: "local" }, "t");
    expect(refused.error?.code).toBe("NOT_AUTHORIZED");
    expect(refused.error?.message).toBe(
      "credential local is used by the connection other at http://localhost:18088 too, not only at http://127.0.0.1:18088, " +
        "so a test may not send it: give each connection a credential of its own (`tavi credentials set <name> --file <path>`, " +
        "then `tavi models rebind <id> --credential <name>`)",
    );
  });

  it("adds a local connection that names no key under a placeholder of its own, and refuses a remote one", async () => {
    const { client } = await owner();
    const models = (payload: Record<string, unknown>, requestId: string) => client.request("models", payload, requestId);
    const added = await models({ action: "add", connectionId: "llama", baseUrl: "http://127.0.0.1:18088/v1" }, "a");
    expect(added.result).toMatchObject({ result: { connectionId: "llama", credentialRef: "llama", local: true } });
    const lan = await models({ action: "add", connectionId: "lan", baseUrl: "http://192.168.1.9:8080/v1", localOnly: true }, "b");
    expect(lan.result).toMatchObject({ result: { credentialRef: "lan" } });
    expect((await client.request("credentials", { action: "list" }, "list")).result).toMatchObject({ credentials: ["lan", "llama"] });
    const remote = await models({ action: "add", connectionId: "cloud", baseUrl: "https://api.example.test/v1" }, "c");
    expect(remote.error).toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("models add needs --credential <name>") });
    // A rebind with no key gives a local connection one of its own, never another connection's.
    await models({ action: "add", connectionId: "other", baseUrl: "http://localhost:1/v1", credentialRef: "spare" }, "d");
    await models({ action: "rebind", connectionId: "llama", credentialRef: "spare" }, "e");
    const rebound = await models({ action: "rebind", connectionId: "llama" }, "f");
    expect(rebound.result).toMatchObject({ result: { credentialRef: "llama" } });
  });

  it("runs a changed fallback chain without a restart", async () => {
    const { client } = await owner({
      target: {
        source: "role",
        connectionId: "running-conn",
        model: "running-model",
        fallback: [{ connectionId: "backup-conn", model: "backup-model" }],
        workspaceId: "default",
      },
    });
    const models = (payload: Record<string, unknown>, requestId: string) => client.request("models", payload, requestId);
    for (const connectionId of ["running-conn", "backup-conn", "other-conn"]) {
      await models(
        { action: "add", connectionId, baseUrl: "http://127.0.0.1:1/v1", credentialRef: `${connectionId}.key` },
        `add-${connectionId}`,
      );
    }
    const bind = (fallback: readonly { connectionId: string; model: string }[], requestId: string) =>
      models({ action: "set-role", role: "main", connectionId: "running-conn", model: "running-model", fallback }, requestId);
    expect((await bind([{ connectionId: "backup-conn", model: "backup-model" }], "same")).result).toMatchObject({ restartRequired: false });
    // Another fallback, the same target: the next turn fails over along it.
    expect((await bind([{ connectionId: "other-conn", model: "other-model" }], "other")).result).toMatchObject({ restartRequired: false });
    await bind([{ connectionId: "backup-conn", model: "backup-model" }], "back");
    expect((await models({ action: "rebind", connectionId: "backup-conn", credentialRef: "rotated.key" }, "rebind")).result).toMatchObject({
      restartRequired: false,
    });
    expect(
      (await models({ action: "rebind", connectionId: "other-conn", credentialRef: "rotated.key" }, "rebind-other")).result,
    ).toMatchObject({ restartRequired: false });
  });

  it("answers every model write without a restart, and roles with what runs now", async () => {
    const { client } = await owner({ target: resolvedFromDefault });
    const add = (connectionId: string, requestId: string) =>
      client.request(
        "models",
        { action: "add", connectionId, baseUrl: "http://127.0.0.1:1/v1", credentialRef: "openai.apiKey", model: "running-model" },
        requestId,
      );
    expect((await add("other-conn", "add-other")).result).toMatchObject({ restartRequired: false, result: { connectionId: "other-conn" } });
    expect((await add("running-conn", "add-running")).result).toMatchObject({ restartRequired: false });
    expect((await client.request("models", { action: "show", connectionId: "running-conn" }, "show")).result).toMatchObject({
      connection: { connectionId: "running-conn" },
      catalog: [],
    });

    const moved = await client.request("models", { action: "set-default", connectionId: "other-conn" }, "default-other");
    expect(moved.result).toMatchObject({ restartRequired: false });
    // `roles` says what runs now: the moved default.
    expect((await client.request("models", { action: "roles" }, "roles-moved")).result).toMatchObject({
      activeTarget: { connectionId: "other-conn", model: "running-model" },
      restartRequired: false,
    });
    const back = await client.request(
      "models",
      { action: "set-default", connectionId: "running-conn", model: "running-model" },
      "default-back",
    );
    expect(back.result).toMatchObject({ restartRequired: false });
    // Another workspace's default is not the one this owner resolves from.
    const elsewhere = await client.request(
      "models",
      { action: "set-default", connectionId: "other-conn", workspaceId: "team" },
      "default-elsewhere",
    );
    expect(elsewhere.result).toMatchObject({ restartRequired: false });
    // What runs is resolved in the workspace asked about.
    expect((await client.request("models", { action: "roles", workspaceId: "team" }, "roles-elsewhere")).result).toMatchObject({
      activeTarget: { connectionId: "other-conn", model: "running-model" },
    });
    const role = await client.request("models", { action: "set-role", role: "compaction", connectionId: "other-conn" }, "role");
    expect(role.result).toMatchObject({ restartRequired: false });
    // Role main is resolved first, at the next turn.
    const main = await client.request("models", { action: "set-role", role: "main", connectionId: "other-conn" }, "role-main");
    expect(main.result).toMatchObject({ restartRequired: false });
    expect((await client.request("models", { action: "clear-role", role: "main" }, "role-main-clear")).result).toMatchObject({
      restartRequired: false,
    });
    const same = await client.request(
      "models",
      { action: "set-role", role: "main", connectionId: "running-conn", model: "running-model" },
      "role-main-same",
    );
    expect(same.result).toMatchObject({ restartRequired: false });
    await client.request("models", { action: "clear-role", role: "main" }, "role-main-clear-again");
    const roles = (await client.request("models", { action: "roles" }, "roles")).result as {
      workspaceDefault: unknown;
      resolved: { role: string; source: string | null; target?: { connectionId: string } }[];
    };
    expect(roles).toMatchObject({
      workspaceDefault: { target: { connectionId: "running-conn" } },
      restartTarget: { connectionId: "running-conn", model: "running-model" },
      restartRequired: false,
    });
    // Every role, resolved in the workspace asked about.
    expect(roles.resolved.map((entry) => [entry.role, entry.source, entry.target?.connectionId])).toEqual([
      ["main", "workspace-default", "running-conn"],
      ["extraction", "workspace-default", "running-conn"],
      ["compaction", "role-override", "other-conn"],
      ["fast", "workspace-default", "running-conn"],
      // Only its own binding serves embedding, never the default.
      ["embedding", null, undefined],
    ]);
    const team = (await client.request("models", { action: "roles", workspaceId: "team" }, "roles-team")).result as typeof roles;
    expect(
      team.resolved
        .filter((entry) => entry.role !== "embedding")
        .every((entry) => entry.source === "workspace-default" && entry.target?.connectionId === "other-conn"),
    ).toBe(true);
    // A workspace with no default of its own resolves no role — role resolution does not borrow the default workspace's.
    const bare = (await client.request("models", { action: "roles", workspaceId: "bare" }, "roles-bare")).result as typeof roles;
    expect(bare.resolved.map((entry) => entry.source)).toEqual(Array(5).fill(null));

    // Validated by the contract before the store.
    for (const [payload, requestId] of [
      [{ action: "set-role", role: "summarizer", connectionId: "other-conn" }, "bad-role"],
      [{ action: "add", connectionId: "x", baseUrl: "http://h/v1", credentialRef: "k.key", kind: "nope" }, "bad-kind"],
    ] as const) {
      expect((await client.request("models", payload, requestId)).error?.code).toBe("INVALID_INPUT");
    }
    expect((await client.request("models", { action: "add", connectionId: "x", credentialRef: "k.key" }, "no-url")).error?.code).toBe(
      "INVALID_INPUT",
    );
    // Still referenced by a role binding.
    expect((await client.request("models", { action: "remove", connectionId: "other-conn" }, "remove")).error?.code).toBe("CONFLICT");

    // A role binding is never consulted by a running owner, fallbacks included.
    const withFallback = await client.request(
      "models",
      { action: "set-role", role: "extraction", connectionId: "other-conn", fallback: [{ connectionId: "running-conn", model: "m2" }] },
      "role-fallback",
    );
    expect(withFallback.result).toMatchObject({
      restartRequired: false,
      result: { fallback: [{ connectionId: "running-conn", model: "m2" }] },
    });
    expect((await client.request("models", { action: "clear-role", role: "compaction" }, "clear-role")).result).toEqual({
      result: { cleared: "compaction" },
      restartRequired: false,
    });
    const rebound = await client.request(
      "models",
      { action: "rebind", connectionId: "running-conn", credentialRef: "other.key" },
      "rebind-running",
    );
    expect(rebound.result).toMatchObject({ restartRequired: false, result: { credentialRef: "other.key" } });
    const reboundOther = await client.request(
      "models",
      { action: "rebind", connectionId: "other-conn", credentialRef: "other.key" },
      "rebind-other",
    );
    expect(reboundOther.result).toMatchObject({ restartRequired: false });
    expect((await client.request("models", { action: "clear-default", workspaceId: "team" }, "clear-team")).result).toMatchObject({
      restartRequired: false,
    });
    expect((await client.request("models", { action: "clear-default" }, "clear-own")).result).toEqual({
      result: { cleared: "default" },
      restartRequired: false,
    });
  });

  it("runs another model on a pinned connection without a restart", async () => {
    // `--connection running-conn` pinned; the model came from the connection's own default.
    const { client } = await owner({
      target: {
        source: "connection",
        connectionId: "running-conn",
        model: "running-model",
        workspaceId: "default",
        flags: { connectionId: "running-conn" },
      },
    });
    await client.request(
      "models",
      {
        action: "add",
        connectionId: "running-conn",
        baseUrl: "http://127.0.0.1:1/v1",
        credentialRef: "openai.apiKey",
        model: "running-model",
      },
      "add",
    );
    // A default on the pinned connection with no model: still the connection's own default model.
    expect((await client.request("models", { action: "set-default", connectionId: "running-conn" }, "set")).result).toMatchObject({
      restartRequired: false,
    });
    expect((await client.request("models", { action: "clear-default" }, "clear")).result).toMatchObject({ restartRequired: false });
    // One naming another model on it runs from the next turn.
    expect(
      (await client.request("models", { action: "set-default", connectionId: "running-conn", model: "m2" }, "set-m2")).result,
    ).toMatchObject({
      restartRequired: false,
    });
    expect((await client.request("models", { action: "roles" }, "roles-m2")).result).toMatchObject({
      activeTarget: { connectionId: "running-conn", model: "m2" },
    });
    // Cleared again: back on the connection's own model.
    expect((await client.request("models", { action: "clear-default" }, "clear-m2")).result).toMatchObject({ restartRequired: false });
  });

  it("lets a placeholder owner run a default configured after it started", async () => {
    const { client } = await owner({
      target: { source: "placeholder", connectionId: "default", model: "default", workspaceId: "default" },
    });
    await client.request("models", { action: "add", connectionId: "c1", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "c1.key" }, "add");
    expect((await client.request("models", { action: "set-default", connectionId: "c1", model: "m1" }, "model")).result).toMatchObject({
      restartRequired: false,
    });
    expect((await client.request("models", { action: "roles" }, "roles")).result).toMatchObject({
      activeTarget: { connectionId: "c1", model: "m1" },
    });
    // Cleared, nothing resolves again: the placeholders, which run nothing.
    expect((await client.request("models", { action: "clear-default" }, "clear")).result).toMatchObject({ restartRequired: false });
    expect((await client.request("models", { action: "roles" }, "roles-cleared")).result).toMatchObject({ activeTarget: null });
  });

  it("never asks for a restart when flags fixed the target", async () => {
    const { client } = await owner();
    const added = await client.request(
      "models",
      { action: "add", connectionId: "running-conn", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "openai.apiKey", model: "m2" },
      "add",
    );
    expect(added.result).toMatchObject({ restartRequired: false });
    const moved = await client.request("models", { action: "set-default", connectionId: "running-conn", model: "m2" }, "default");
    expect(moved.result).toMatchObject({ restartRequired: false });
    expect((await client.request("models", { action: "clear-default" }, "clear")).result).toMatchObject({ restartRequired: false });
    expect(
      (await client.request("models", { action: "rebind", connectionId: "running-conn", credentialRef: "other.key" }, "rebind")).result,
    ).toMatchObject({ restartRequired: false });
  });

  it("tests and discovers through the owner's credential chain, recording the result and never answering the value", async () => {
    const { client } = await owner();
    const baseUrl = endpoint?.baseUrl ?? "";
    await client.request("credentials", { action: "set", reference: "openai.apiKey", value: "sk-owner-secret" }, "cred");
    await client.request(
      "models",
      { action: "add", connectionId: "stub", baseUrl, credentialRef: "openai.apiKey", model: "stub-model" },
      "add",
    );
    const before = endpoint?.authorizations.length ?? 0;

    const tested = await client.request("models", { action: "test", connectionId: "stub" }, "test", { timeoutMs: 15_000 });
    expect(tested.result).toMatchObject({ ok: true, capabilities: expect.arrayContaining(["chat"]) });
    expect(endpoint?.authorizations.slice(before)).toContain("Bearer sk-owner-secret");
    expect(JSON.stringify(tested)).not.toContain("sk-owner-secret");
    const shown = await client.request("models", { action: "show", connectionId: "stub" }, "show");
    expect(shown.result).toMatchObject({ catalog: [{ modelId: "stub-model", state: "capable" }] });

    const discovered = await client.request("models", { action: "discover", connectionId: "stub" }, "discover", { timeoutMs: 15_000 });
    expect(discovered.result).toMatchObject({ connectionId: "stub", models: [{ modelId: "stub-model" }] });
  });

  it("will not send a credential to an origin it is not bound to", async () => {
    // The confused deputy: `add` can point a connection anywhere and name any
    // reference, and `test` would send the credential there.
    const { client } = await owner({ providers: [{ baseUrl: "https://api.example.com/v1", credentialRef: "launch.key" }] });
    const baseUrl = endpoint?.baseUrl ?? "";
    await client.request(
      "models",
      { action: "add", connectionId: "home", baseUrl: "https://provider.example/v1", credentialRef: "shared.key" },
      "a",
    );
    await client.request("models", { action: "add", connectionId: "away", baseUrl, credentialRef: "shared.key" }, "b");
    // A launched connection's key is refused at `add` already: it is the launcher's.
    expect(
      (await client.request("models", { action: "add", connectionId: "borrowed", baseUrl, credentialRef: "launch.key" }, "c")).error?.code,
    ).toBe("NOT_AUTHORIZED");
    const before = endpoint?.authorizations.length ?? 0;
    for (const connectionId of ["away"]) {
      for (const action of ["test", "discover"]) {
        const refused = await client.request("models", { action, connectionId, model: "m" }, `${action}-${connectionId}`);
        expect(refused.error?.code, `${action} ${connectionId}`).toBe("NOT_AUTHORIZED");
      }
    }
    expect(endpoint?.authorizations.length).toBe(before);
  });

  it("will not let a model connection name a search provider's key or one the launcher bound for another use", async () => {
    // The other direction of the search key guard: `add` then `test` would send a bot token, or a search key, to an origin a page chose.
    const tokenFile = join(directories.create(), "bot.token");
    writeFileSync(tokenFile, "bot-secret\n", { mode: 0o600 });
    const { client } = await owner({
      bindings: { "telegram.botToken": tokenFile },
      providers: [{ baseUrl: "https://api.example.com/v1", credentialRef: "launch.key" }],
    });
    const baseUrl = endpoint?.baseUrl ?? "";
    await client.request("search", { action: "add", providerId: "brave", kind: "brave", credentialRef: "brave.apiKey" }, "search");
    const before = endpoint?.authorizations.length ?? 0;
    // A plugin's key is its own too.
    for (const [index, credentialRef] of ["telegram.botToken", "search.anything", "brave.apiKey", "plugins.acme.weather.key"].entries()) {
      const added = await client.request(
        "models",
        { action: "add", connectionId: `grab-${index}`, baseUrl, credentialRef, model: "m" },
        `grab-${index}`,
      );
      expect(added.error?.code, credentialRef).toBe("NOT_AUTHORIZED");
    }
    // Nor rebound onto such a key, and a launched connection's own key only at its own origin.
    await client.request("models", { action: "add", connectionId: "mine", baseUrl, credentialRef: "mine.key", model: "m" }, "mine");
    expect(
      (await client.request("models", { action: "rebind", connectionId: "mine", credentialRef: "telegram.botToken" }, "rebind")).error
        ?.code,
    ).toBe("NOT_AUTHORIZED");
    expect(
      (await client.request("models", { action: "add", connectionId: "away", baseUrl, credentialRef: "launch.key", model: "m" }, "away"))
        .error?.code,
    ).toBe("NOT_AUTHORIZED");
    expect(
      (
        await client.request(
          "models",
          { action: "add", connectionId: "home", baseUrl: "https://api.example.com/v1", credentialRef: "launch.key", model: "m" },
          "home",
        )
      ).ok,
    ).toBe(true);
    expect(endpoint?.authorizations.length).toBe(before);
  });

  it("will not let a page move a stored key to an origin nothing binds it to, nor name a search key under its kind's prefix", async () => {
    const { client, directory } = await owner();
    const baseUrl = endpoint?.baseUrl ?? "";
    // Keys the operator stored offline: the page never saw their values.
    mkdirSync(join(directory, "credentials"), { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "credentials", "anthropic.key"), "sk-ant-SECRET\n", { mode: 0o600 });
    writeFileSync(join(directory, "credentials", "brave.apiKey"), "BRAVE-SECRET\n", { mode: 0o600 });
    expect(
      (
        await client.request(
          "models",
          {
            action: "add",
            connectionId: "anthropic",
            baseUrl: "https://api.anthropic.example/v1",
            credentialRef: "anthropic.key",
            model: "m",
          },
          "a",
        )
      ).ok,
    ).toBe(true);

    // The page, through the bridge (it says so in its hello).
    const address = readOwner(directory);
    if (address === undefined) throw new Error("no owner published");
    const page = await openConnection(await openSocket(address.endpoint), address, { scheduler: nodeScheduler, client: "bridge" });
    try {
      const ask = (payload: Record<string, unknown>, id: string) => page.request("models", payload, id);
      // The existing connection pointed somewhere else, under its own key: refused.
      expect((await ask({ action: "add", connectionId: "anthropic", baseUrl, credentialRef: "anthropic.key" }, "p1")).error?.code).toBe(
        "NOT_AUTHORIZED",
      );
      // Removed, then added again elsewhere under the key it leaves behind: refused.
      expect((await ask({ action: "remove", connectionId: "anthropic" }, "p2")).ok).toBe(true);
      expect(
        (await ask({ action: "add", connectionId: "evil", baseUrl, credentialRef: "anthropic.key", model: "m" }, "p3")).error?.code,
      ).toBe("NOT_AUTHORIZED");
      // A key the page wrote through this owner is its own: allowed anywhere — but not rebound onto the stored one.
      expect((await page.request("credentials", { action: "set", reference: "mine.key", value: "page-known" }, "p4")).ok).toBe(true);
      expect((await ask({ action: "add", connectionId: "mine", baseUrl, credentialRef: "mine.key", model: "m" }, "p5")).ok).toBe(true);
      expect((await ask({ action: "rebind", connectionId: "mine", credentialRef: "anthropic.key" }, "p6")).error?.code).toBe(
        "NOT_AUTHORIZED",
      );
      // A search key under its kind's own prefix, with no provider naming it now (after `search remove`, say): refused.
      expect(
        (await ask({ action: "add", connectionId: "grab", baseUrl, credentialRef: "brave.apiKey", model: "m" }, "p7")).error?.code,
      ).toBe("NOT_AUTHORIZED");
      // Nothing sent: no request to the stub carried either stored key.
      await ask({ action: "test", connectionId: "mine", model: "m" }, "p8");
      expect(endpoint?.authorizations.some((header) => header.includes("sk-ant-SECRET") || header.includes("BRAVE-SECRET"))).toBe(false);
      // Ciphertext is no value, and a temporary file's shape no name.
      expect((await page.request("credentials", { action: "set", reference: "x.key", value: "tavi-enc:v1:abc" }, "p9")).error?.code).toBe(
        "INVALID_INPUT",
      );
      expect((await page.request("credentials", { action: "set", reference: "x.tmp-0123456789ab", value: "v" }, "p10")).error?.code).toBe(
        "INVALID_INPUT",
      );
    } finally {
      page.close();
    }
    // A local client — a terminal's `tavi models add` — holds the cookie and the directory: the page's rule is not its.
    expect(
      (
        await client.request(
          "models",
          { action: "add", connectionId: "moved", baseUrl, credentialRef: "anthropic.key", model: "m" },
          "local",
        )
      ).ok,
    ).toBe(true);
  });

  it("stores a credential 0600 through the local store, lists and deletes it, and never answers the value", async () => {
    const { client, directory } = await owner();
    const stored = await client.request("credentials", { action: "set", reference: "stripe.apiKey", value: " sk-live-123 \n" }, "set");
    expect(stored.result).toEqual({ stored: "stripe.apiKey" });
    expect(JSON.stringify(stored)).not.toContain("sk-live-123");
    expect(statSync(join(directory, "credentials", "stripe.apiKey")).mode & 0o777).toBe(0o600);
    expect((await client.request("credentials", { action: "list" }, "list")).result).toMatchObject({ credentials: ["stripe.apiKey"] });
    // Where the at-rest key is kept, never the key: what Settings → Credentials says.
    expect((await client.request("credentials", { action: "list" }, "where")).result).toMatchObject({
      encryption: { kept: expect.stringMatching(/^(none|file|keychain)$/) },
    });
    expect((await client.request("credentials", { action: "delete", reference: "stripe.apiKey" }, "delete")).result).toEqual({
      deleted: "stripe.apiKey",
      namedBy: [],
    });
    expect((await client.request("credentials", { action: "list" }, "relist")).result).toMatchObject({ credentials: [] });
    expect((await client.request("credentials", { action: "set", reference: "../escape", value: "x" }, "bad")).error?.code).toBe(
      "INVALID_INPUT",
    );
    expect((await client.request("credentials", { action: "set", reference: "blank.key", value: "  \n " }, "blank")).error?.code).toBe(
      "INVALID_INPUT",
    );
    // Encrypted at rest on the owner, as offline: idempotent, the values still resolved.
    await client.request("credentials", { action: "set", reference: "kept.apiKey", value: "sk-kept" }, "kept");
    expect((await client.request("credentials", { action: "encrypt" }, "encrypt")).result).toMatchObject({
      keyCreated: true,
      encrypted: ["kept.apiKey"],
    });
    expect((await client.request("credentials", { action: "encrypt" }, "encrypt-again")).result).toMatchObject({
      keyCreated: false,
      encrypted: [],
      alreadyEncrypted: ["kept.apiKey"],
    });
    expect(readFileSync(join(directory, "credentials", "kept.apiKey"), "utf8")).not.toContain("sk-kept");
  });

  it("adds, shows, lists and removes a project through the registry's own schema", async () => {
    const { client } = await owner();
    const project = { id: "ai-crucible", name: "AI Crucible", keywords: ["ai"] };
    expect((await client.request("projects", { action: "add", project }, "add")).result).toMatchObject({
      id: "ai-crucible",
      enabled: true,
    });
    expect((await client.request("projects", { action: "add", project }, "again")).ok).toBe(false);
    expect((await client.request("projects", { action: "show", projectId: "ai-crucible" }, "show")).result).toMatchObject({
      name: "AI Crucible",
    });
    expect((await client.request("projects", { action: "list" }, "list")).result).toMatchObject({
      projects: [{ id: "ai-crucible" }],
      truncated: false,
    });
    expect((await client.request("projects", { action: "remove", projectId: "ai-crucible" }, "remove")).result).toEqual({
      removed: "ai-crucible",
    });
    expect((await client.request("projects", { action: "show", projectId: "ai-crucible" }, "gone")).error?.code).toBe("NOT_FOUND");
    // A project is its sources: an unknown field is refused, not stored.
    expect((await client.request("projects", { action: "add", project: { id: "p", root: "/srv" } }, "shape")).error?.code).toBe(
      "INVALID_INPUT",
    );
  });

  it("shares add/update validation and preserves unspecified schedule fields", async () => {
    const { handle, client } = await owner();
    const payload = {
      action: "add",
      workspaceId: "default",
      name: "new",
      at: "09:00",
      timezone: "UTC",
      prompt: "brief",
      allow: ["reports.*"],
      days: [1, 2],
    };
    const added = await client.request("schedules", payload, "create");
    expect(added.ok).toBe(true);
    const before = (await handle.runtime.store.asPort().repositories.schedules.list("default")).find((row) => row.name === "new")!;
    expect((await client.request("schedules", payload, "duplicate")).error?.code).toBe("CONFLICT");
    expect((await client.request("schedules", { ...payload, name: "wild", allow: ["*"] }, "wild")).error?.message).toContain(
      "Name the tools instead",
    );
    expect((await client.request("schedules", { ...payload, name: "bad", timezone: "Nowhere/Nope" }, "zone")).error?.code).toBe(
      "INVALID_INPUT",
    );
    expect((await client.request("schedules", { ...payload, name: "bad", agentId: "missing" }, "agent")).error?.code).toBe("INVALID_INPUT");
    expect(
      (await client.request("schedules", { action: "update", scheduleId: before.scheduleId, prompt: "new prompt" }, "patch")).result,
    ).toMatchObject({ prompt: "new prompt", nextRunAt: before.nextRunAt, autoApproveTools: ["reports.*"], spec: before.spec });
    expect(
      (await client.request("schedules", { action: "update", scheduleId: before.scheduleId, at: "10:00", days: null, allow: [] }, "timing"))
        .result,
    ).toMatchObject({ spec: { at: "10:00", timezone: "UTC" }, autoApproveTools: [] });
    const after = (await handle.runtime.store.asPort().repositories.schedules.get(before.scheduleId))!;
    expect(after.spec.daysOfWeek).toBeUndefined();
    expect(after.nextRunAt).not.toBe(before.nextRunAt);
    expect(
      (await client.request("schedules", { action: "update", scheduleId: before.scheduleId, workspaceId: "other", prompt: "no" }, "scope"))
        .error?.code,
    ).toBe("NOT_FOUND");
  });

  it("previews a cadence's next runs without saving anything", async () => {
    const { handle, client } = await owner();
    const saved = await handle.runtime.store.asPort().repositories.schedules.list("default");
    const preview = await client.request(
      "schedules",
      { action: "preview", at: "07:00", timezone: "Europe/Sofia", days: [1, 2, 3, 4, 5] },
      "preview",
    );
    expect(preview.ok, preview.error?.message).toBe(true);
    const answer = preview.result as SchedulePreviewResult;
    expect(answer.timezone).toBe("Europe/Sofia");
    expect(answer.text).toBe("every Mon–Fri at 07:00 (Europe/Sofia)");
    expect(answer.runs).toHaveLength(3);
    const spec = { at: "07:00", timezone: "Europe/Sofia", daysOfWeek: [1, 2, 3, 4, 5] };
    // Each run is the engine's next after the one before: the first after now, then on.
    for (const [index, run] of answer.runs.entries()) {
      if (index > 0) expect(run).toBe(nextOccurrence(spec, new Date(answer.runs[index - 1]!))!.toISOString());
      expect(Date.parse(run)).toBeGreaterThan(Date.now() - 60_000);
    }
    expect((await client.request("schedules", { action: "preview", at: "07:00", limit: 5 }, "workspace-zone")).result).toMatchObject({
      runs: expect.any(Array),
    });
    const refused = await client.request("schedules", { action: "preview", times: ["07:00", "07:00"], timezone: "UTC" }, "twice");
    expect(refused.error?.code).toBe("INVALID_INPUT");
    expect(refused.error?.message).toContain("Each time may be named only once");
    expect(await handle.runtime.store.asPort().repositories.schedules.list("default")).toEqual(saved);
  });

  it("lists the registered tools a schedule may name, the families and read-only tools among them, writing nothing", async () => {
    const { handle, client } = await owner();
    const answer = await client.request("schedules", { action: "tools" }, "tools");
    expect(answer.ok, answer.error?.message).toBe(true);
    const { tools, families, readOnly } = answer.result as ScheduleToolsResult;
    const definitions = handle.runtime.tools.list();
    const registered = new Set(definitions.map((tool) => tool.id));
    expect(tools.length).toBeGreaterThan(0);
    expect([...tools].sort()).toEqual(tools);
    for (const id of tools) expect(registered.has(id)).toBe(true);
    // The read-only ones are named, and only those: a writing tool is never among them.
    expect(readOnly).toEqual(tools.filter((id) => definitions.find((tool) => tool.id === id)?.effect === "read-only"));
    expect(readOnly.length).toBeLessThan(tools.length);
    for (const family of families) {
      const members = definitions.filter((tool) => tool.id.startsWith(family.slice(0, -1)));
      expect(members.length).toBeGreaterThan(0);
      expect(members.every((tool) => tool.effect === "read-only")).toBe(true);
    }
    // Each is one a schedule's list takes: adding them all is accepted.
    const added = await client.request(
      "schedules",
      { action: "add", name: "Every tool", prompt: "Brief", at: "07:00", timezone: "UTC", allow: [...families, ...tools] },
      "add",
    );
    expect(added.ok, added.error?.message).toBe(true);
    expect(tools).not.toContain("pdf.fill");
    expect(families).not.toContain("schedules.*");
  });

  it("reads and toggles schedules within the workspace, by id or name", async () => {
    const { handle, client } = await owner();
    const repositories = handle.runtime.store.asPort().repositories;
    await repositories.schedules.create(schedule("sched-1", "morning-brief"));
    await repositories.schedules.create(schedule("sched-team", "team-brief", "team"));

    const listed = await client.request("schedules", { action: "list" }, "list");
    expect(listed.result).toMatchObject({ schedules: [{ scheduleId: "sched-1" }], truncated: false });
    expect(JSON.stringify(listed.result)).not.toContain("write the brief");
    expect((await client.request("schedules", { action: "show", scheduleId: "morning-brief" }, "show")).result).toMatchObject({
      scheduleId: "sched-1",
      prompt: "write the brief",
      recentFires: [],
    });
    for (const [index, reasonCode] of (["missed", "overlap", "ok"] as const).entries()) {
      await repositories.schedules.recordRun({
        scheduleId: "sched-1",
        taskId: null,
        outcome: reasonCode,
        outcomeKind: reasonCode === "ok" ? "succeeded" : "skipped",
        fire: { fireTime: `2026-04-0${index + 1}T04:00:00.000Z`, reasonCode },
        now: `2026-04-0${index + 1}T04:01:00.000Z`,
      });
    }
    const history = await client.request("schedules", { action: "history", scheduleId: "morning-brief", limit: 2 }, "history");
    expect(history.result).toMatchObject({ scheduleId: "sched-1", name: "morning-brief", timezone: expect.any(String) });
    expect((history.result as { fires: { reasonCode: string }[] }).fires.map((fire) => fire.reasonCode)).toEqual(["ok", "overlap"]);
    expect((await client.request("schedules", { action: "history", scheduleId: "sched-team" }, "history-other")).error?.code).toBe(
      "NOT_FOUND",
    );
    const disabled = await client.request("schedules", { action: "disable", scheduleId: "sched-1" }, "disable");
    expect(disabled.result).toMatchObject({ enabled: false, nextRunAt: null });
    const enabled = await client.request("schedules", { action: "enable", scheduleId: "sched-1" }, "enable");
    expect((enabled.result as { enabled: boolean; nextRunAt: string | null }).nextRunAt).not.toBeNull();

    // Another workspace's schedule is not found by its id.
    expect((await client.request("schedules", { action: "show", scheduleId: "sched-team" }, "other")).error?.code).toBe("NOT_FOUND");
    expect((await client.request("schedules", { action: "show" }, "no-id")).error?.code).toBe("INVALID_INPUT");

    // Removed by name, within the workspace.
    expect((await client.request("schedules", { action: "remove", scheduleId: "sched-team" }, "remove-other")).error?.code).toBe(
      "NOT_FOUND",
    );
    expect((await client.request("schedules", { action: "remove", scheduleId: "morning-brief" }, "remove")).result).toEqual({
      removed: "sched-1",
    });
    expect(await repositories.schedules.get("sched-1")).toBeUndefined();
    expect(await repositories.schedules.get("sched-team")).toBeDefined();
  });

  it("enables and disables a project, answering the record read back", async () => {
    const { client } = await owner();
    await client.request("projects", { action: "add", project: { id: "acme", name: "Acme" } }, "add");
    expect((await client.request("projects", { action: "disable", projectId: "acme" }, "disable")).result).toMatchObject({
      id: "acme",
      enabled: false,
    });
    expect((await client.request("projects", { action: "enable", projectId: "acme" }, "enable")).result).toMatchObject({
      id: "acme",
      enabled: true,
    });
    expect((await client.request("projects", { action: "disable", projectId: "nothing" }, "unknown")).error?.code).toBe("NOT_FOUND");
    expect((await client.request("agents", { action: "show" }, "agent-no-id")).error?.code).toBe("INVALID_INPUT");
    // Clearing a role with no binding is not an error.
    expect((await client.request("models", { action: "clear-role", role: "fast" }, "clear-role")).result).toEqual({
      result: { cleared: "fast" },
      restartRequired: false,
    });
  });

  it("fires a schedule now, once at a time, recording its task as the fire's while it runs", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { handle, client } = await owner({ target: resolvedFromDefault, model: answering(held) });
    const repositories = handle.runtime.store.asPort().repositories;
    await repositories.schedules.create(schedule("sched-1", "morning-brief"));

    const fired = await client.request("schedules", { action: "run", scheduleId: "sched-1" }, "run", { timeoutMs: 15_000 });
    expect(fired.ok, JSON.stringify(fired.error)).toBe(true);
    const { taskId } = fired.result as { taskId: string };
    expect((await repositories.tasks.get(taskId))?.origin).toBe("schedule");
    expect(handle.runtime.scheduleFires.scheduleOf(taskId)).toBe("sched-1");
    // A subscriber is told whose fire answers the task's rounds, by name.
    const watching = await client.request("subscribe", { taskId }, "watch-fire");
    expect(watching.result).toMatchObject({ roundsAnsweredBy: "owner", schedule: { scheduleId: "sched-1", name: "morning-brief" } });
    // A second "run now" while the first is in flight fires nothing.
    const again = await client.request("schedules", { action: "run", scheduleId: "sched-1" }, "again", { timeoutMs: 15_000 });
    expect(again.result).toEqual({ outcome: { kind: "skipped", reason: "overlap" } });

    // Nor may it be removed mid-fire: the fire's outcome would be recorded nowhere.
    const removal = await client.request("schedules", { action: "remove", scheduleId: "sched-1" }, "remove-mid-fire");
    expect(removal.error).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("fire in flight") });
    expect(await repositories.schedules.get("sched-1")).toBeDefined();
    expect(
      (await client.request("schedules", { action: "update", scheduleId: "sched-1", prompt: "changed" }, "edit-mid-fire")).error?.code,
    ).toBe("CONFLICT");

    release();
    await waitFor(async () => (await repositories.schedules.get("sched-1"))?.lastRunTaskId === taskId);
    expect(handle.runtime.scheduleFires.scheduleOf(taskId)).toBeUndefined();
    expect((await repositories.tasks.list(10)).filter((task) => task.origin === "schedule")).toHaveLength(1);
  });

  it("refuses a fire asserting another target, admitting nothing", async () => {
    const { handle, client } = await owner({ target: resolvedFromDefault });
    await handle.runtime.store.asPort().repositories.schedules.create(schedule("sched-1", "morning-brief"));
    const refused = await client.request("schedules", { action: "run", scheduleId: "sched-1", expectTarget: { model: "other" } }, "run");
    expect(refused.error).toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("running-conn/running-model") });
    expect(await handle.runtime.store.asPort().repositories.tasks.list(10)).toEqual([]);
  });

  it("refuses to fire a schedule under an unconfigured owner", async () => {
    const { handle, client } = await owner({
      target: { source: "placeholder", connectionId: "default", model: "default", workspaceId: "default" },
    });
    await handle.runtime.store.asPort().repositories.schedules.create(schedule("sched-1", "morning-brief"));
    const refused = await client.request("schedules", { action: "run", scheduleId: "sched-1" }, "run");
    expect(refused.error).toMatchObject({ code: "NOT_CONFIGURED", message: expect.stringContaining("default/default") });
    expect(await handle.runtime.store.asPort().repositories.tasks.list(10)).toEqual([]);
  });
});

it("says what each worker did last and an ended worker's final text in its tree row", async () => {
  const { handle, client } = await owner();
  const repos = handle.runtime.store.asPort().repositories;
  const create = async (id: string) =>
    await repos.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: id,
      kind: "start",
      intent: {},
      checkpointNamespace: "",
      newTaskId: (() => id)(),
      newAdmissionId: (() => `adm-${id}`)(),
      newThreadId: (() => `thread-${id}`)(),
      now: (() => "2026-01-01T00:00:00Z")(),
    });
  const spawn = async (id: string) => {
    await create(id);
    await repos.agentDelegations.recordSpawn({
      operationKey: id,
      workspaceId: "default",
      principalId: "operator",
      workerTaskId: id,
      workerAgentId: `agent-${id}`,
      parentTaskId: "root",
      rootTaskId: "root",
      depth: 1,
      createdAt: "2026-01-01T00:00:00Z",
    });
  };
  await create("root");
  await spawn("live");
  await spawn("saved");
  await spawn("done");
  // A running worker's live stream: its newest tool call, then the tail of its newest text.
  const bus = handle.runtime.runEventBus;
  bus.publish("live", {
    kind: "tool.started",
    runId: "live",
    attemptId: "a",
    blockId: "b0",
    callId: "c1",
    toolName: "web.search",
    input: {},
  } as never);
  expect(bus.latestActivity("live", 200)).toEqual({ kind: "tool", text: "web.search" });
  bus.publish("live", { kind: "text.delta", runId: "live", attemptId: "a", blockId: "b1", text: "Comparing  the\nfares" } as never);
  // One with no stream held (the owner restarted): its newest saved turn's last item.
  await repos.transcripts.append({
    taskId: "saved",
    admissionId: "adm-saved",
    turn: {
      admissionKind: "start",
      prompt: "p",
      items: [
        { kind: "text", text: "Looked." },
        { kind: "tool", callId: "c", toolName: "files.read", status: "completed" },
      ],
      outcome: { status: "waiting" },
    },
    createdAt: "2026-01-01T00:00:00Z",
  });
  await repos.tasks.updateStatus("done", "completed", "x".repeat(5_000));
  const answer = await client.request("agents", { action: "tree", workspaceId: "default", taskId: "root" }, "activity");
  const nodes = (answer.result as { nodes: { taskId: string; activity?: unknown; finalText?: string }[] }).nodes;
  const byId = new Map(nodes.map((node) => [node.taskId, node]));
  expect(byId.get("root")?.activity).toBeUndefined();
  expect(byId.get("live")?.activity).toEqual({ kind: "text", text: "Comparing the fares" });
  expect(byId.get("saved")?.activity).toEqual({ kind: "tool", text: "files.read" });
  expect(byId.get("done")?.activity).toBeUndefined();
  expect(byId.get("done")?.finalText).toHaveLength(4_000);
  expect(byId.get("live")?.finalText).toBeUndefined();
  // `detail: false`: names and statuses only, no activity or final text read or sent.
  const bare = (await client.request("agents", { action: "tree", workspaceId: "default", taskId: "root", detail: false }, "bare"))
    .result as { nodes: Record<string, unknown>[] };
  expect(bare.nodes.map((node) => node["taskId"]).sort()).toEqual(["done", "live", "root", "saved"]);
  expect(bare.nodes.some((node) => "activity" in node || "finalText" in node)).toBe(false);
});

it("returns bounded delegation subtrees and scoped ancestry through IPC", async () => {
  const { handle, client } = await owner();
  const repos = handle.runtime.store.asPort().repositories;
  const create = async (id: string, workspaceId = "default") =>
    await repos.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId,
      principalId: "operator",
      operationKey: id,
      kind: "start",
      intent: {},
      checkpointNamespace: "",
      newTaskId: (() => id)(),
      newAdmissionId: (() => `adm-${id}`)(),
      newThreadId: (() => `thread-${id}`)(),
      now: (() => "2026-01-01T00:00:00Z")(),
    });
  await create("root");
  for (let i = 0; i < 205; i++) {
    const id = `child-${String(i).padStart(3, "0")}`;
    await create(id);
    await repos.agentDelegations.recordSpawn({
      operationKey: id,
      workspaceId: "default",
      principalId: "operator",
      workerTaskId: id,
      workerAgentId: id,
      parentTaskId: "root",
      rootTaskId: "root",
      depth: 1,
      createdAt: "2026-01-01T00:00:00Z",
    });
  }
  await create("grandchild");
  await repos.agentDelegations.recordSpawn({
    operationKey: "grandchild",
    workspaceId: "default",
    principalId: "operator",
    workerTaskId: "grandchild",
    workerAgentId: "grandchild",
    parentTaskId: "child-000",
    rootTaskId: "root",
    depth: 2,
    createdAt: "2026-01-01T00:00:00Z",
  });
  inspectDatabase(handle.runtime.store)
    .prepare(
      "INSERT INTO tavi_approvals(approval_id,task_id,admission_id,tool_id,call_id,steps,inputs,inputs_hash,state,created_at,updated_at) VALUES('tree-approval','grandchild','adm-grandchild','read','c',1,'{}','hash','pending','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
    )
    .run();
  const answer = await client.request("agents", { action: "tree", workspaceId: "default", taskId: "root" }, "tree");
  expect(answer.error).toBeUndefined();
  const tree = answer.result as { nodes: unknown[]; truncated: boolean };
  expect(tree.nodes).toHaveLength(200);
  expect(tree.truncated).toBe(true);
  expect(tree.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ taskId: "root", needs: ["approval"] }),
      expect.objectContaining({ taskId: "child-000", needs: ["approval"] }),
    ]),
  );
  expect(tree.nodes).not.toEqual(expect.arrayContaining([expect.objectContaining({ taskId: "grandchild" })]));
  expect(
    (await client.request("agents", { action: "tree", workspaceId: "default", taskId: "grandchild" }, "subtree")).result,
  ).toMatchObject({ ancestors: ["root", "child-000"], rootTaskId: "root", nodes: [{ taskId: "grandchild" }] });
  expect((await client.request("agents", { action: "tree", workspaceId: "foreign", taskId: "root" }, "foreign")).error?.code).toBe(
    "NOT_FOUND",
  );
  expect((await client.request("agents", { action: "tree", taskId: "root", limit: 201 }, "overlimit")).error?.code).toBe("INVALID_INPUT");
});
