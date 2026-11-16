import {
  DEFAULT_MEMORY_RETENTION_DAYS,
  MEMORY_PROPOSAL_TTL_DAYS,
  memoryQuotasOf,
  memoryScopeKey,
  effectiveMemorySettings,
  type MemoryActor,
  type MemoryListAnswer,
  type MemoryRecord,
  type MemoryUsageAnswer,
  type ModelPort,
  type ModelRequest,
  type WorkspaceSettingsAnswer,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { DEFAULT_CONTEXT_MAX_TOKENS } from "@tavi/agent-host/context";
import { createFixtureModel, instructionsAndContextOf } from "@tavi/test-support/fakes";
import { DEFAULT_MEMORY_QUOTAS, createIpcClient, type IpcClient } from "@tavi/runtime";
import { capture, temporaryDirectories, delay } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { UsageError, parseArgs } from "../../src/cli/parse.js";
import { applyWorkspaceSetting } from "../../src/server/workspace-settings-commands.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { EXIT, main } from "../../src/main.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureRuntimeOptions, fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * The workspace's `memory` settings section: one section of the workspace settings, written with compare-and-set
 * by the operator, read per model call — paused memory recalls and captures
 * nothing, capture off withdraws `memory.propose` and the flush, and the
 * limits reach the quotas, the sweep and the context budget.
 */

const directories = temporaryDirectories({ prefix: "tavi-memory-settings-" });
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];
const runtimes: TaviRuntime[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

const OPERATOR: MemoryActor = { principalId: "operator", workspaceId: "default", caller: "test", authority: "operator" };
const AGENT: MemoryActor = { ...OPERATOR, caller: "agent", authority: "model" };
const PERSONAL = { kind: "personal", principalId: "operator" } as const;

async function owner(
  extra: { readonly retentionSweepEnabled?: boolean; readonly retentionSweepIntervalMs?: number } = {},
): Promise<{ readonly handle: ServeHandle; readonly client: IpcClient; readonly directory: string }> {
  const dataDirectory = directories.create();
  const handle = await serve(
    fixtureServeOptions(dataDirectory, { ...extra }),
    { dataDirectory, drainDeadlineMs: 5_000 },
    { stdout: () => {}, stderr: () => {}, isTty: false },
  );
  handles.push(handle);
  const discovered = await findLiveOwner(dataDirectory);
  if (discovered === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(discovered);
  clients.push(client);
  return { handle, client, directory: dataDirectory };
}

/** A proposal recorded `at`, written straight into the store. */
async function proposedAt(handle: ServeHandle, recordId: string, at: string): Promise<void> {
  const record: MemoryRecord = {
    recordId,
    kind: "fact",
    scope: PERSONAL,
    scopeKey: memoryScopeKey(PERSONAL),
    status: "proposed",
    sensitivity: "normal",
    revocationGeneration: 0,
    recordedAt: at,
    updatedAt: at,
  };
  await handle.runtime.store.asPort().repositories.memory.insertRecord({
    record,
    revision: {
      revisionId: `${recordId}-rev`,
      recordId,
      revisionNumber: 1,
      schemaVersion: 1,
      body: recordId,
      contentHash: "hash",
      author: "agent",
      sourceIds: [],
      recordedAt: at,
      sensitivity: "normal",
      status: "active",
    },
  });
}

async function settingsCall(client: IpcClient, payload: Record<string, unknown>) {
  return client.request("workspace-settings", { workspaceId: "default", ...payload }, `ws-${Math.random().toString(36).slice(2)}`);
}

describe("parsing tavi memory config", () => {
  it("reads the listing, one key, and a change held to a revision; refuses a key no step added", () => {
    expect(parseArgs(["memory", "config"])).toMatchObject({ command: "memory", memory: { action: "config" } });
    expect(parseArgs(["memory", "config", "limits.maxRecords"])).toMatchObject({
      memory: { action: "config", configKey: "limits.maxRecords" },
    });
    expect(parseArgs(["memory", "config", "enabled", "off", "--revision", "3"])).toMatchObject({
      memory: { action: "config", configKey: "enabled", configValue: "off", expectedRevision: 3 },
    });
    // The digest is a key too.
    expect(parseArgs(["memory", "config", "digest", "off"])).toMatchObject({
      memory: { action: "config", configKey: "digest", configValue: "off" },
    });
    // Sensitive topics too.
    expect(parseArgs(["memory", "config", "sensitive", "suggest"])).toMatchObject({
      memory: { action: "config", configKey: "sensitive", configValue: "suggest" },
    });
    // Retrieval too, with --yes for the disclosure of a remote embedding connection.
    expect(parseArgs(["memory", "config", "retrieval", "hybrid"])).toMatchObject({
      memory: { action: "config", configKey: "retrieval", configValue: "hybrid" },
    });
    expect(parseArgs(["memory", "config", "retrieval", "hybrid", "--yes"])).toMatchObject({
      memory: { configKey: "retrieval", confirmed: true },
    });
    // --yes=<connection>: the connection whose disclosure was accepted (only with retrieval hybrid).
    expect(parseArgs(["memory", "config", "retrieval", "hybrid", "--yes=cloud"])).toMatchObject({
      memory: { configKey: "retrieval", confirmed: true, confirmedConnection: "cloud" },
    });
    expect(() => parseArgs(["memory", "config", "capture", "off", "--yes=cloud"])).toThrow(
      /--yes=<connection> goes only with memory config retrieval hybrid/,
    );
    expect(() => parseArgs(["memory", "config", "retrieval", "hybrid", "--yes="])).toThrow(UsageError);
    expect(() => parseArgs(["memory", "egress", "records", "on", "--yes=cloud"])).toThrow(UsageError);
    // `retrieval hybrid` says the whole choice for personal memory: --include-personal on, without it off.
    expect(parseArgs(["memory", "config", "retrieval", "hybrid"])).toMatchObject({ memory: { retrievalPersonal: false } });
    expect(parseArgs(["memory", "config", "retrieval", "hybrid", "--include-personal", "--yes"])).toMatchObject({
      memory: { configKey: "retrieval", confirmed: true, retrievalPersonal: true },
    });
    expect(parseArgs(["memory", "config", "capture", "off"]).memory).not.toHaveProperty("retrievalPersonal");
    expect(() => parseArgs(["memory", "config", "retrieval", "lexical", "--include-personal"])).toThrow(
      /--include-personal goes only with memory config retrieval hybrid/,
    );
    expect(() => parseArgs(["memory", "list", "--include-personal"])).toThrow(UsageError);
    expect(() => parseArgs(["memory", "list", "--yes"])).toThrow(UsageError);
    // Auto-approve is a key too; an unknown key is refused.
    expect(parseArgs(["memory", "config", "auto-approve", "fact,lesson"])).toMatchObject({
      memory: { action: "config", configKey: "auto-approve", configValue: "fact,lesson" },
    });
    expect(() => parseArgs(["memory", "config", "auto-keep", "fact"])).toThrow(/Unknown memory setting/);
    expect(() => parseArgs(["memory", "config", "enabled", "--revision", "3"])).toThrow(/--revision applies only to a change/);
    expect(() => parseArgs(["memory", "config", "enabled", "off", "extra"])).toThrow(/at most a key and a value/);
    expect(() => parseArgs(["memory", "config", "--principal", "bob"])).toThrow(/does not accept --principal/);
  });
});

describe("the memory section on a live owner", () => {
  it("round-trips with compare-and-set: a stale revision is a conflict", async () => {
    const { client } = await owner();
    const read = (await settingsCall(client, { action: "get" })).result as WorkspaceSettingsAnswer;
    expect(read.effective.memory).toEqual(effectiveMemorySettings(undefined));
    const written = await settingsCall(client, {
      action: "set",
      key: "memory",
      value: JSON.stringify({ enabled: false, limits: { evidence: 4 } }),
      expectedRevision: read.revision,
    });
    expect(written.ok).toBe(true);
    const answer = written.result as WorkspaceSettingsAnswer;
    expect(answer.settings.memory).toEqual({ enabled: false, limits: { evidence: 4 } });
    expect(answer.effective.memory).toMatchObject({ enabled: false, capture: "suggest", limits: { evidence: 4, maxRecords: 5_000 } });
    const stale = await settingsCall(client, { action: "set", key: "memory", value: JSON.stringify({}), expectedRevision: read.revision });
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe("CONFLICT");
  });

  it("refuses a key no step added and a limit out of bounds, and takes auto-approve", async () => {
    const { client } = await owner();
    for (const section of [
      { retrieval: "vector" },
      { autoApprove: ["summary"] },
      { autoKeep: ["fact"] },
      { limits: { maxRecords: 9 } },
      { limits: { proposalDays: 91 } },
      { limits: { contextTokens: 1_999 } },
      { limits: { evidence: 21 } },
    ]) {
      const refused = await settingsCall(client, { action: "set", key: "memory", value: JSON.stringify(section) });
      expect(refused.ok, JSON.stringify(section)).toBe(false);
      expect(refused.error?.code).toBe("INVALID_INPUT");
    }
    const read = (await settingsCall(client, { action: "get" })).result as WorkspaceSettingsAnswer;
    expect(read.settings.memory).toBeUndefined();
    expect(read.effective.memory?.autoApprove).toEqual([]);
    // Auto-approve: kinds the operator ticks, in effect in canonical order.
    const ticked = await settingsCall(client, {
      action: "set",
      key: "memory",
      value: JSON.stringify({ autoApprove: ["lesson", "fact"] }),
      expectedRevision: read.revision,
    });
    expect(ticked.ok).toBe(true);
    expect((ticked.result as WorkspaceSettingsAnswer).effective.memory?.autoApprove).toEqual(["fact", "lesson"]);
  });

  it("memory invariant 14: hybrid recall needs an embedding model, and a remote one's disclosure — naming the record count — accepted first", async () => {
    const { handle, client, directory: dataDirectory } = await owner();
    const hybrid = JSON.stringify({ retrieval: "hybrid" });
    // No embedding model bound: refused, saying how to bind one.
    const unbound = await settingsCall(client, { action: "set", key: "memory", value: hybrid });
    expect(unbound.error?.code).toBe("NOT_CONFIGURED");
    expect(unbound.error?.message).toMatch(/tavi models set-role embedding/);
    const models = handle.runtime.store.services.modelConfig;
    await models.putConnection({
      connectionId: "cloud",
      label: "cloud",
      baseUrl: "https://api.example.com/v1",
      credentialRef: "cloud.key",
    });
    await models.setRoleBinding({
      workspaceId: "default",
      role: "embedding",
      target: { connectionId: "cloud", model: "text-embedding-3-small" },
    });
    await handle.runtime.memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body: "Based in Lisbon" });
    await handle.runtime.memory.remember({
      actor: OPERATOR,
      scope: PERSONAL,
      kind: "fact",
      body: "Takes insulin",
      sensitivity: "sensitive",
    });
    // Remote: the disclosure first, naming where and how many (the sensitive record is never sent, so not counted;
    // nor is personal memory, which has its own opt-in).
    const asked = await settingsCall(client, { action: "set", key: "memory", value: hybrid });
    expect(asked.error?.code).toBe("APPROVAL_REQUIRED");
    expect(asked.error?.message).toContain(
      "Memory text and each message's retrieval query will be sent to cloud to compute embeddings: 0 approved memories of this workspace now, and each new one as it is approved. Personal memory is not sent unless you turn on personal memory too",
    );
    expect(((await settingsCall(client, { action: "get" })).result as WorkspaceSettingsAnswer).settings.memory).toBeUndefined();
    // The CLI says how to accept it — for the connection the disclosure named — and --yes=<that connection> does.
    const cli = async (...argv: string[]) => {
      const captured = capture();
      const code = await main(["memory", "config", ...argv, "--data-dir", dataDirectory], { io: captured.io });
      return { code, out: captured.out(), err: captured.err() };
    };
    const refused = await cli("retrieval", "hybrid");
    expect(refused.code).not.toBe(EXIT.ok);
    expect(refused.err).toContain("sent to cloud");
    expect(refused.err).toContain("Run it again with --yes=cloud to confirm.");
    // A bare --yes names no connection, so accepts none.
    const bare = await cli("retrieval", "hybrid", "--yes");
    expect(bare.code).not.toBe(EXIT.ok);
    expect(bare.err).toContain("--yes=cloud");
    expect(((await settingsCall(client, { action: "get" })).result as WorkspaceSettingsAnswer).settings.memory).toBeUndefined();
    const accepted = await cli("retrieval", "hybrid", "--yes=cloud");
    expect(accepted.code, accepted.err).toBe(EXIT.ok);
    expect(accepted.out).toBe("retrieval = hybrid (set)\n");
    // The connection whose disclosure was accepted is remembered, by the owner.
    const memory = async () => ((await settingsCall(client, { action: "get" })).result as WorkspaceSettingsAnswer).settings.memory;
    expect(await memory()).toEqual({ retrieval: "hybrid", retrievalConnection: "cloud" });
    // Personal memory has its own disclosure: a client cannot write the opt-in itself, …
    expect(
      (
        await settingsCall(client, {
          action: "set",
          key: "memory",
          value: JSON.stringify({ retrieval: "hybrid", retrievalPersonal: "cloud" }),
        })
      ).ok,
    ).toBe(true);
    expect(await memory()).toEqual({ retrieval: "hybrid", retrievalConnection: "cloud" });
    // … asking for it without the yes is refused with its disclosure, and with it on a non-memory key is malformed.
    const personalAsked = await settingsCall(client, { action: "set", key: "memory", value: hybrid, retrievalPersonal: true });
    expect(personalAsked.error?.code).toBe("APPROVAL_REQUIRED");
    expect(personalAsked.error?.message).toContain(
      "Your personal memory is shared by all your workspaces: turning this on sends 1 of your approved personal memories (never sensitive ones) to cloud",
    );
    expect((await settingsCall(client, { action: "set", key: "timezone", value: "UTC", retrievalPersonal: true })).ok).toBe(false);
    const personalRefused = await cli("retrieval", "hybrid", "--include-personal");
    expect(personalRefused.code).not.toBe(EXIT.ok);
    expect(personalRefused.err).toContain("Your personal memory is shared");
    expect(personalRefused.err).toContain("--yes=cloud");
    expect((await cli("retrieval", "hybrid", "--include-personal", "--yes=cloud")).code).toBe(EXIT.ok);
    expect(await memory()).toEqual({ retrieval: "hybrid", retrievalConnection: "cloud", retrievalPersonal: "cloud" });
    // `retrieval hybrid` without the flag turns it off again; hybrid stays accepted.
    expect((await cli("retrieval", "hybrid")).code).toBe(EXIT.ok);
    expect(await memory()).toEqual({ retrieval: "hybrid", retrievalConnection: "cloud" });
    // Back to lexical needs nothing; a local connection needs no disclosure.
    expect((await cli("retrieval", "lexical")).code).toBe(EXIT.ok);
    await models.putConnection({
      connectionId: "ollama",
      label: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      credentialRef: "ollama.key",
      localOnly: true,
    });
    await models.setRoleBinding({
      workspaceId: "default",
      role: "embedding",
      target: { connectionId: "ollama", model: "nomic-embed-text" },
    });
    expect((await settingsCall(client, { action: "set", key: "memory", value: hybrid })).ok).toBe(true);
  });

  it("memory invariant 14: a personal-memory opt-out prunes that person's vectors of the workspace's model with the write, with no memory tick running", async () => {
    // No memory host here, so no tick: only the write can prune.
    const { handle, client } = await owner();
    const models = handle.runtime.store.services.modelConfig;
    await models.putConnection({
      connectionId: "cloud",
      label: "cloud",
      baseUrl: "https://api.example.com/v1",
      credentialRef: "cloud.key",
    });
    await models.setRoleBinding({ workspaceId: "default", role: "embedding", target: { connectionId: "cloud", model: "embed-1" } });
    await handle.runtime.memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body: "Based in Lisbon" });
    await handle.runtime.memory.remember({
      actor: OPERATOR,
      scope: { kind: "personal_workspace", principalId: "operator", workspaceId: "default" },
      kind: "fact",
      body: "Works as a nurse",
    });
    const hybrid = JSON.stringify({ retrieval: "hybrid" });
    expect(
      (
        await settingsCall(client, {
          action: "set",
          key: "memory",
          value: hybrid,
          confirmed: true,
          confirmedConnection: "cloud",
          retrievalPersonal: true,
        })
      ).ok,
    ).toBe(true);
    // The vectors a backfill would have stored, the personal record's among them.
    const memory = handle.runtime.store.asPort().repositories.memory;
    const now = nowTimestamp();
    const due = await memory.vectorBacklog({
      workspaceId: "default",
      principalIds: ["operator"],
      modelKey: "cloud/embed-1",
      now,
      limit: 10,
      maxFailures: 3,
    });
    expect(due).toHaveLength(2);
    await memory.putVectors({
      vectors: due.map((entry) => ({ revisionId: entry.revisionId, modelKey: "cloud/embed-1", vector: [1, 0] })),
      now,
    });
    const stats = async () =>
      await memory.vectorStats({
        workspaceId: "default",
        principalIds: ["operator"],
        modelKey: "cloud/embed-1",
        now: nowTimestamp(),
        maxFailures: 3,
      });
    expect((await stats()).indexed).toBe(2);
    // Opted out (`retrieval hybrid` without --include-personal): the personal vector goes now, the workspace's stays.
    expect((await settingsCall(client, { action: "set", key: "memory", value: hybrid, retrievalPersonal: false })).ok).toBe(true);
    expect((await stats()).indexed).toBe(1);
  });

  it("is shown and changed by tavi memory config, one key at a time", async () => {
    const { directory: dataDirectory } = await owner();
    const run = async (...argv: string[]) => {
      const captured = capture();
      const code = await main(["memory", "config", ...argv, "--data-dir", dataDirectory], { io: captured.io });
      return { code, out: captured.out(), err: captured.err() };
    };
    const shown = await run();
    expect(shown.code, shown.err).toBe(EXIT.ok);
    expect(shown.out).toContain("enabled = on (default)");
    expect(shown.out).toContain("limits.maxRecords = 5000 (default)");
    expect(shown.out).toContain("revision 0");
    expect((await run("enabled", "off")).code).toBe(EXIT.ok);
    expect((await run("limits.proposalDays", "14")).code).toBe(EXIT.ok);
    const after = await run("--format", "json");
    expect(JSON.parse(after.out)).toMatchObject({
      revision: 2,
      settings: { enabled: false, limits: { proposalDays: 14 } },
      effective: { enabled: false, limits: { proposalDays: 14 } },
    });
    expect((await run("enabled")).out).toBe("enabled = off (set)\n");
    // Out of bounds: refused with what was typed, nothing written.
    const refused = await run("limits.maxRecords", "9");
    expect(refused.code).not.toBe(EXIT.ok);
    expect(refused.err).toContain('"9" is not a value for memory limits.maxRecords');
    // Held to a revision that moved: a conflict, nothing written.
    const stale = await run("capture", "off", "--revision", "1");
    expect(stale.code).not.toBe(EXIT.ok);
    expect(JSON.parse((await run("--format", "json")).out)).toMatchObject({
      revision: 2,
      settings: { enabled: false, limits: { proposalDays: 14 } },
    });
    expect((await run("enabled", "default")).code).toBe(EXIT.ok);
    expect((await run("enabled")).out).toBe("enabled = on (default)\n");
    // Auto-approve: a comma list of kinds, or none.
    expect((await run("auto-approve")).out).toBe("auto-approve = none (default)\n");
    expect((await run("auto-approve", "facts,preferences")).code).toBe(EXIT.ok);
    expect((await run("auto-approve")).out).toBe("auto-approve = preference,fact (set)\n");
    const wrong = await run("auto-approve", "summaries");
    expect(wrong.code).not.toBe(EXIT.ok);
    expect(wrong.err).toContain("expected a comma list of preference, fact and lesson, or none");
    expect((await run("auto-approve", "none")).code).toBe(EXIT.ok);
    expect((await run("auto-approve")).out).toBe("auto-approve = none (default)\n");
  });

  it("maxRecords: 10 refuses the 11th proposal with QUOTA_EXCEEDED, and the byte quota scales with it", async () => {
    const { handle, client } = await owner();
    await settingsCall(client, { action: "set", key: "memory", value: JSON.stringify({ limits: { maxRecords: 10 } }) });
    for (let index = 0; index < 10; index += 1)
      await handle.runtime.memory.propose({ actor: AGENT, scope: PERSONAL, kind: "fact", body: `fact ${index}` });
    await expect(
      handle.runtime.memory.propose({ actor: AGENT, scope: PERSONAL, kind: "fact", body: "the eleventh" }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    const usage = (await client.request("memory", { action: "usage" }, "usage")).result as MemoryUsageAnswer;
    expect(usage.quota).toMatchObject({ records: 10, ...memoryQuotasOf(effectiveMemorySettings({ limits: { maxRecords: 10 } })) });
    expect(usage.quota?.maxBytes).toBeLessThan(DEFAULT_MEMORY_QUOTAS.maxBytes / 100);
    // Raised again, the next proposal fits: read per call.
    await settingsCall(client, { action: "set", key: "memory", value: JSON.stringify({}) });
    await expect(
      handle.runtime.memory.propose({ actor: AGENT, scope: PERSONAL, kind: "fact", body: "the eleventh" }),
    ).resolves.toMatchObject({ status: "proposed" });
  });

  it("proposalDays: 7 expires an 8-day-old proposal in the sweep, and dates a waiting one by it", async () => {
    const { handle, client } = await owner({ retentionSweepEnabled: true, retentionSweepIntervalMs: 100 });
    await settingsCall(client, { action: "set", key: "memory", value: JSON.stringify({ limits: { proposalDays: 7 } }) });
    await proposedAt(handle, "eight-days", new Date(Date.now() - 8 * 86_400_000).toISOString());
    const sixAt = new Date(Date.now() - 6 * 86_400_000).toISOString();
    await proposedAt(handle, "six-days", sixAt);
    const repository = handle.runtime.store.asPort().repositories.memory;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await repository.getRecord("eight-days"))?.status !== "expired") await delay(50);
    expect((await repository.getRecord("eight-days"))?.status).toBe("expired");
    expect((await repository.getRecord("six-days"))?.status).toBe("proposed");
    const listed = (await client.request("memory", { action: "list", statuses: ["proposed"] }, "proposals")).result as MemoryListAnswer;
    expect(listed.records.find((record) => record.recordId === "six-days")?.expiresAt).toBe(
      new Date(Date.parse(sixAt) + 7 * 86_400_000).toISOString(),
    );
  }, 20_000);

  it("an absent section gives exactly today's quotas, budget and proposal lifetime (a directory from before the step)", async () => {
    const { handle } = await owner();
    // Settings saved before the section existed: another key, no `memory`.
    await applyWorkspaceSetting(handle.runtime.store.asPort().repositories.workspaceSettings, {
      workspaceId: "default",
      key: "timezone",
      value: "Europe/Berlin",
      actor: "operator",
      now: nowTimestamp(),
    });
    const effective = await handle.runtime.memorySettings("default");
    expect(memoryQuotasOf(effective)).toEqual(DEFAULT_MEMORY_QUOTAS);
    expect(effective.limits.contextTokens).toBe(DEFAULT_CONTEXT_MAX_TOKENS);
    expect(effective.limits.proposalDays).toBe(MEMORY_PROPOSAL_TTL_DAYS);
    expect(DEFAULT_MEMORY_RETENTION_DAYS.proposedOrRejected).toBe(effective.limits.proposalDays);
    expect(effective).toMatchObject({ enabled: true, capture: "suggest", limits: { evidence: 10 } });
  });
});

/** Answers every turn with "Done", recording each request. */
function recordingModel(requests: ModelRequest[]): ModelPort {
  return {
    async stream(request) {
      requests.push(request);
      return {
        attemptId: request.attemptId,
        status: "completed",
        text: "Done.",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      };
    },
  };
}

describe("memory settings reach the next model call", () => {
  async function composed(): Promise<{
    readonly runtime: TaviRuntime;
    readonly turn: (prompt: string) => Promise<{ readonly instructionsAndContext: string; readonly tools: readonly string[] }>;
    readonly set: (section: Record<string, unknown>) => Promise<void>;
  }> {
    const requests: ModelRequest[] = [];
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directories.create(), { approvalRequiredFor: [] }), {
      modelOverride: recordingModel(requests),
    });
    runtimes.push(runtime);
    let count = 0;
    const turn = async (prompt: string) => {
      count += 1;
      const before = requests.length;
      await runtime.workflow?.admit({
        context: { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "cli" },
        operationKey: `turn-${count}`,
        kind: "start",
        prompt,
      });
      const request = requests.slice(before).find((entry) => entry.purpose === undefined || entry.purpose === "generation");
      if (request === undefined) throw new Error("the turn made no model call");
      // The system text and the call's context block, where the manifest goes.
      return { instructionsAndContext: instructionsAndContextOf(request), tools: request.tools.map((tool) => tool.id) };
    };
    const set = async (section: Record<string, unknown>) => {
      await applyWorkspaceSetting(runtime.store.asPort().repositories.workspaceSettings, {
        workspaceId: "default",
        key: "memory",
        value: JSON.stringify(section),
        actor: "operator",
        now: nowTimestamp(),
      });
    };
    return { runtime, turn, set };
  }

  it("memory invariant 13: paused, the next turn has no manifest and no memory.* or sessions.search tool, deleting nothing; resuming restores all of it", async () => {
    const { runtime, turn, set } = await composed();
    await runtime.memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body: "The person is vegetarian" });
    const on = await turn("ideas for a vegetarian dinner");
    expect(on.instructionsAndContext).toMatch(/The person is \[?vegetarian/);
    expect(on.tools).toEqual(expect.arrayContaining(["memory.search", "memory.get", "memory.propose", "sessions.search"]));

    await set({ enabled: false });
    const paused = await turn("ideas for a vegetarian dinner");
    expect(paused.instructionsAndContext).not.toMatch(/The person is \[?vegetarian/);
    expect(paused.instructionsAndContext).not.toContain("Retrieved memory evidence");
    expect(paused.tools.filter((id) => id.startsWith("memory.") || id === "sessions.search")).toEqual([]);
    // Nothing was deleted.
    expect(await runtime.memory.list({ actor: OPERATOR, statuses: ["approved"] })).toHaveLength(1);

    await set({});
    const resumed = await turn("ideas for a vegetarian dinner");
    expect(resumed.instructionsAndContext).toMatch(/The person is \[?vegetarian/);
    expect(resumed.tools).toEqual(expect.arrayContaining(["memory.search", "memory.get", "memory.propose", "sessions.search"]));
  }, 60_000);

  it("capture off: the next turn offers no memory.propose but still recalls; evidence 0 recalls nothing by search", async () => {
    const { runtime, turn, set } = await composed();
    await runtime.memory.remember({ actor: OPERATOR, scope: PERSONAL, kind: "fact", body: "The person is vegetarian" });
    await set({ capture: "off" });
    const off = await turn("ideas for a vegetarian dinner");
    expect(off.tools).not.toContain("memory.propose");
    expect(off.tools).toEqual(expect.arrayContaining(["memory.search", "memory.get", "sessions.search"]));
    expect(off.instructionsAndContext).toMatch(/The person is \[?vegetarian/);
    await set({ limits: { evidence: 0 } });
    const none = await turn("ideas for a vegetarian dinner");
    expect(none.instructionsAndContext).not.toMatch(/The person is \[?vegetarian/);
    expect(none.tools).toContain("memory.propose");
  }, 60_000);

  it("limits.contextTokens is the next call's budget: a smaller one carries less retrieved evidence", async () => {
    const { runtime, turn, set } = await composed();
    // Distinct notes that each match two of the query's words, so neither the relevance floor nor the
    // near-duplicate drop trims them: only the budget does.
    for (let index = 0; index < 10; index += 1) {
      const padding = Array.from({ length: 48 }, (_, word) => `n${index}w${word}`).join(" ");
      await runtime.memory.remember({
        actor: OPERATOR,
        scope: PERSONAL,
        kind: "fact",
        body: `The person is vegetarian and plans dinner (note ${index}): ${padding}`,
      });
    }
    const evidenceIn = (system: string): number => system.match(/The person is \[?vegetarian/g)?.length ?? 0;
    const roomy = await turn("ideas for a vegetarian dinner");
    // Tight enough to trim the evidence, room enough for the fixed instructions and tool schemas, which the video
    // tools (where FFmpeg is found) and their guidance lengthen.
    await set({ limits: { contextTokens: 2500 } });
    const tight = await turn("ideas for a vegetarian dinner");
    expect(evidenceIn(tight.instructionsAndContext)).toBeLessThan(evidenceIn(roomy.instructionsAndContext));
    expect(tight.instructionsAndContext.length).toBeLessThan(roomy.instructionsAndContext.length);
  }, 60_000);

  it("refuses a call to a withheld memory tool, not only leaves it unoffered", async () => {
    const model = createFixtureModel({
      turns: [{ toolCall: { id: "p1", name: "memory.propose", input: { kind: "fact", body: "The person likes tea" } } }, { text: "Done." }],
    });
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(directories.create(), { approvalRequiredFor: [] }), {
      modelOverride: model,
    });
    runtimes.push(runtime);
    await applyWorkspaceSetting(runtime.store.asPort().repositories.workspaceSettings, {
      workspaceId: "default",
      key: "memory",
      value: JSON.stringify({ capture: "off" }),
      actor: "operator",
      now: nowTimestamp(),
    });
    await runtime.workflow?.admit({
      context: { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "cli" },
      operationKey: "withheld",
      kind: "start",
      prompt: "remember I like tea",
    });
    const result = model.calls
      .at(-1)
      ?.messages.flatMap((message) => message.toolResults ?? [])
      .find((entry) => entry.toolCallId === "p1");
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result?.output)).toContain("Learning from chats is off");
    expect(await runtime.memory.list({ actor: OPERATOR, statuses: ["proposed"] })).toEqual([]);
  }, 60_000);
});
