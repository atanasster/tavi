import {
  memoryScopeKey,
  type CenterSummaryAnswer,
  type MemoryActor,
  type MemoryGetAnswer,
  type MemoryItem,
  type MemoryListAnswer,
  type MemoryRecord,
  type MemoryScope,
  type MemoryUsageAnswer,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { DEFAULT_MEMORY_QUOTAS, createIpcClient, type IpcClient } from "@tavi/runtime";
import { capture, temporaryDirectories, delay } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { UsageError, parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * The `memory` command on a live owner: whose
 * memory the operator sees, redaction, proposal review, and `tavi memory`
 * through the owner.
 */

const directories = temporaryDirectories();
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

async function owner(
  extra: { readonly retentionSweepEnabled?: boolean; readonly retentionSweepIntervalMs?: number } = {},
): Promise<{ readonly handle: ServeHandle; readonly client: IpcClient; readonly directory: string }> {
  const directory = directories.create("tavi-memory-ipc-");
  const handle = await serve(
    fixtureServeOptions(directory, { ...extra }),
    { dataDirectory: directory, drainDeadlineMs: 5_000 },
    { stdout: () => {}, stderr: () => {}, isTty: false },
  );
  handles.push(handle);
  const discovered = await findLiveOwner(directory);
  if (discovered === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(discovered);
  clients.push(client);
  return { handle, client, directory };
}

/** What the agent's `memory.propose` tool runs as, for the person a task is for. */
const agentFor = (principalId: string): MemoryActor => ({ principalId, workspaceId: "default", caller: "agent", authority: "model" });

/** A task for `principalId` in the workspace: what ties a person to it, as a chat message would. */
async function admit(handle: ServeHandle, principalId: string): Promise<void> {
  const taskId = `task-${principalId}`;
  await handle.runtime.store.asPort().repositories.tasks.admit({
    prompt: fixturePromptPolicy,
    workspaceId: "default",
    principalId,
    operationKey: `op-${taskId}`,
    kind: "start",
    intent: { prompt: "hi" },
    checkpointNamespace: "",
    newTaskId: taskId,
    newAdmissionId: `adm-${taskId}`,
    newThreadId: `thread-${taskId}`,
    now: nowTimestamp(),
  });
}

/**
 * A record written straight into the store: for a scope no service call
 * writes (the shared scope), or a proposal made long ago.
 */
async function insert(
  handle: ServeHandle,
  recordId: string,
  scope: MemoryScope,
  body: string,
  options: { readonly status?: "approved" | "proposed"; readonly at?: string } = {},
): Promise<void> {
  const at = options.at ?? nowTimestamp();
  const status = options.status ?? "approved";
  const record: MemoryRecord = {
    recordId,
    kind: "fact",
    scope,
    scopeKey: memoryScopeKey(scope),
    status,
    sensitivity: "normal",
    ...(status === "approved" ? { currentRevisionId: `${recordId}-rev` } : {}),
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
      body,
      contentHash: "hash",
      author: "share",
      sourceIds: ["source-1", "source-2"],
      recordedAt: at,
      sensitivity: "normal",
      status: "active",
    },
  });
}

describe("parsing tavi memory review actions", () => {
  it("reads approve, reject and proposals", () => {
    expect(parseArgs(["memory", "approve", "mem-1"])).toMatchObject({
      command: "memory",
      memory: { action: "approve", recordId: "mem-1" },
    });
    expect(parseArgs(["memory", "reject", "mem-1", "--note", "not true"])).toMatchObject({
      command: "memory",
      memory: { action: "reject", recordId: "mem-1", note: "not true" },
    });
    expect(parseArgs(["memory", "proposals", "--kind", "fact", "--limit", "5"])).toMatchObject({
      command: "memory",
      memory: { action: "proposals", kind: "fact", limit: 5 },
    });
    expect(() => parseArgs(["memory", "approve"])).toThrow(UsageError);
    expect(() => parseArgs(["memory", "reject"])).toThrow(/needs a record id/);
    expect(() => parseArgs(["memory", "proposals", "extra"])).toThrow(UsageError);
    expect(() => parseArgs(["memory", "approve", "mem-1", "--reason", "x"])).toThrow(/does not accept --reason/);
    expect(() => parseArgs(["memory", "forget", "mem-1", "--note", "x"])).toThrow(/does not accept --note/);
  });
});

describe("memory on a live owner", () => {
  it("lists the operator's and the shared memory, counts other people's, and hides their records", async () => {
    const { handle, client } = await owner();
    const memory = handle.runtime.memory;
    const mine = await memory.propose({
      actor: agentFor("operator"),
      scope: { kind: "personal", principalId: "operator" },
      kind: "fact",
      body: "Prefers mornings",
    });
    await admit(handle, "bob");
    // Carol's memory names no workspace, and she has nothing in this one: not counted.
    await memory.propose({ actor: agentFor("carol"), scope: { kind: "personal", principalId: "carol" }, kind: "fact", body: "Carol's" });
    const theirs = await memory.propose({
      actor: agentFor("bob"),
      scope: { kind: "personal", principalId: "bob" },
      kind: "fact",
      body: "Bob's secret",
    });
    await memory.propose({ actor: agentFor("bob"), scope: { kind: "personal", principalId: "bob" }, kind: "lesson", body: "Bob's lesson" });
    await insert(handle, "shared-1", { kind: "shared_workspace", workspaceId: "default" }, "The office closes at six");
    await insert(handle, "elsewhere-1", { kind: "shared_workspace", workspaceId: "other" }, "Not this workspace");

    const listed = await client.request("memory", { action: "list" }, "list");
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    const answer = listed.result as MemoryListAnswer;
    expect(answer.records.map((record) => record.recordId).sort()).toEqual([mine.recordId, "shared-1"].sort());
    expect(answer.otherPeople).toEqual([{ principalId: "bob", count: 2 }]);
    // Both of bob's wait for review: counted as proposals whatever the list asked for.
    expect(answer.otherProposals).toEqual([{ principalId: "bob", count: 2 }]);
    const approvedOnly = (await client.request("memory", { action: "list", statuses: ["approved"] }, "approved-only"))
      .result as MemoryListAnswer;
    expect(approvedOnly).toMatchObject({ otherPeople: [], otherProposals: [{ principalId: "bob", count: 2 }] });
    const shared = answer.records.find((record) => record.recordId === "shared-1") as MemoryItem;
    // Evidence is a count, never the sources.
    expect(shared).toMatchObject({ target: "shared", body: "The office closes at six", sourceCount: 2, redacted: false });
    expect(JSON.stringify(answer)).not.toContain("source-1");
    const proposal = answer.records.find((record) => record.recordId === mine.recordId) as MemoryItem;
    expect(proposal).toMatchObject({ status: "proposed", target: "personal", body: "Prefers mornings" });
    expect(Date.parse(proposal.expiresAt ?? "") - Date.parse(proposal.recordedAt)).toBe(30 * 86_400_000);

    const foreign = await client.request("memory", { action: "get", recordId: theirs.recordId }, "foreign");
    expect(foreign.error?.code).toBe("NOT_FOUND");
    expect(foreign.error?.message).not.toContain("bob");
    const approveForeign = await client.request("memory", { action: "approve", recordId: theirs.recordId }, "approve-foreign");
    expect(approveForeign.error?.code).toBe("NOT_FOUND");
    for (const payload of [
      { action: "reject", recordId: theirs.recordId },
      { action: "correct", recordId: theirs.recordId, body: "overwritten" },
      { action: "forget", recordId: theirs.recordId },
    ]) {
      expect((await client.request("memory", payload, `foreign-${payload.action}`)).error?.code, payload.action).toBe("NOT_FOUND");
    }
    expect(await handle.runtime.store.asPort().repositories.memory.getRecord(theirs.recordId)).toMatchObject({ status: "proposed" });
    expect((await client.request("memory", { action: "get", recordId: "elsewhere-1" }, "elsewhere")).error?.code).toBe("NOT_FOUND");
    expect((await client.request("memory", { action: "get", recordId: "shared-1" }, "shared")).ok).toBe(true);
    // The shared scope is read-only here.
    expect((await client.request("memory", { action: "forget", recordId: "shared-1" }, "forget-shared")).error?.code).toBe(
      "NOT_AUTHORIZED",
    );

    // The center counts the same proposals the list shows.
    const summary = (await client.request("center", { action: "summary" }, "summary")).result as CenterSummaryAnswer;
    expect(summary.counts.memoryProposals).toBe(1);

    const scoped = (await client.request("memory", { action: "list", scopes: ["shared"] }, "scoped")).result as MemoryListAnswer;
    expect(scoped.records.map((record) => record.recordId)).toEqual(["shared-1"]);
    const page = (await client.request("memory", { action: "list", limit: 1 }, "page")).result as MemoryListAnswer;
    expect(page.records).toHaveLength(1);
    const next = (await client.request("memory", { action: "list", limit: 1, cursor: page.nextCursor }, "next")).result as MemoryListAnswer;
    expect(next.records).toHaveLength(1);
    expect(next.nextCursor).toBeUndefined();
    expect(next.records[0]?.recordId).not.toBe(page.records[0]?.recordId);

    const found = (await client.request("memory", { action: "list", query: "office" }, "search")).result as MemoryListAnswer;
    expect(found).toMatchObject({ coverage: "complete", records: [{ recordId: "shared-1" }] });
    expect(found.records[0]?.snippet).toContain("office");

    const usage = (await client.request("memory", { action: "usage" }, "usage")).result as MemoryUsageAnswer;
    expect(usage.records).toBe(2);
    // The quota a record the operator writes is checked against: the operator's
    // own personal memory, not the shared record counted above. A proposal
    // takes a record slot; its bytes count once it is approved.
    const limits = { maxRecords: DEFAULT_MEMORY_QUOTAS.maxRecords, maxBytes: DEFAULT_MEMORY_QUOTAS.maxBytes };
    expect(usage.quota).toEqual({ records: 1, bytes: 0, ...limits });
    expect((await client.request("memory", { action: "approve", recordId: mine.recordId }, "approve-mine")).ok).toBe(true);
    const charged = (await client.request("memory", { action: "usage" }, "usage-after")).result as MemoryUsageAnswer;
    expect(charged.quota).toEqual({ records: 1, bytes: Buffer.byteLength("Prefers mornings"), ...limits });

    expect((await client.request("memory", { action: "list", workspaceId: "elsewhere" }, "unserved")).error?.code).toBe("NOT_FOUND");
  });

  it("searches for every word, and when no record holds them all answers partial matches, labelled as such", async () => {
    const { client } = await owner();
    for (const [index, body] of ["The Lisbon flat has a balcony", "Rent is due on the first"].entries()) {
      expect((await client.request("memory", { action: "remember", kind: "fact", scope: "personal", body }, `remember-${index}`)).ok).toBe(
        true,
      );
    }
    const exact = (await client.request("memory", { action: "list", query: "Lisbon flat" }, "exact")).result as MemoryListAnswer;
    expect(exact).toMatchObject({ coverage: "complete", match: "all" });
    expect(exact.records).toHaveLength(1);
    const partial = (await client.request("memory", { action: "list", query: "Lisbon flat rent" }, "partial")).result as MemoryListAnswer;
    expect(partial).toMatchObject({ coverage: "complete", match: "any" });
    expect(partial.records).toHaveLength(2);
    const none = (await client.request("memory", { action: "list", query: "Porto garden" }, "none")).result as MemoryListAnswer;
    expect(none).toMatchObject({ coverage: "complete", match: "all", records: [] });
  });

  it("redacts a sensitive record unless a get reveals it", async () => {
    const { client } = await owner();
    const remembered = await client.request(
      "memory",
      {
        action: "remember",
        kind: "fact",
        scope: "personal",
        title: "Doctor",
        body: "Sees Dr. Lee on Tuesdays",
        sensitivity: "sensitive",
        topicKey: "health.doctor",
      },
      "remember",
    );
    const record = remembered.result as MemoryItem;
    expect(record).toMatchObject({ status: "approved", sensitivity: "sensitive", title: null, body: null, redacted: true });

    const listed = (await client.request("memory", { action: "list" }, "list")).result as MemoryListAnswer;
    expect(listed.records[0]).toMatchObject({ title: null, body: null, redacted: true });
    expect(JSON.stringify(listed)).not.toContain("Dr. Lee");
    expect(JSON.stringify(listed)).not.toContain("health.doctor");
    expect(record).not.toHaveProperty("topicKey");
    // A search hit on it carries no snippet either.
    const found = (await client.request("memory", { action: "list", query: "Tuesdays" }, "search")).result as MemoryListAnswer;
    expect(found.records.map((hit) => hit.recordId)).toEqual([record.recordId]);
    expect(found.records[0]).not.toHaveProperty("snippet");
    expect(JSON.stringify(found)).not.toContain("Dr. Lee");
    expect(JSON.stringify(found)).not.toContain("health.doctor");
    const hidden = (await client.request("memory", { action: "get", recordId: record.recordId }, "get")).result as MemoryGetAnswer;
    expect(hidden.record).toMatchObject({ body: null, redacted: true });
    const shown = (await client.request("memory", { action: "get", recordId: record.recordId, reveal: true }, "reveal"))
      .result as MemoryGetAnswer;
    expect(shown.record).toMatchObject({ title: "Doctor", body: "Sees Dr. Lee on Tuesdays", topicKey: "health.doctor", redacted: false });
  });

  it("approves and rejects the agent's proposals as the operator", async () => {
    const { handle, client } = await owner();
    const personal = { kind: "personal", principalId: "operator" } as const;
    const first = await handle.runtime.memory.propose({
      actor: agentFor("operator"),
      scope: personal,
      kind: "fact",
      body: "Lives in Lisbon",
    });
    const second = await handle.runtime.memory.propose({ actor: agentFor("operator"), scope: personal, kind: "fact", body: "Hates tea" });

    const approved = await client.request("memory", { action: "approve", recordId: first.recordId, note: "right" }, "approve");
    expect(approved.result).toMatchObject({ recordId: first.recordId, status: "approved", body: "Lives in Lisbon" });
    const rejected = await client.request("memory", { action: "reject", recordId: second.recordId, note: "wrong" }, "reject");
    expect(rejected.result).toMatchObject({ status: "rejected" });
    // A decided proposal is not decided again the other way.
    expect((await client.request("memory", { action: "approve", recordId: second.recordId }, "again")).error?.code).toBe("CONFLICT");

    const detail = (await client.request("memory", { action: "get", recordId: first.recordId }, "get")).result as MemoryGetAnswer;
    expect(detail.reviews).toEqual([expect.objectContaining({ decision: "approved", reviewerPrincipalId: "operator", reason: "right" })]);
    expect(detail.revisions).toEqual([expect.objectContaining({ revisionNumber: 1, author: "agent", status: "active" })]);

    // Default statuses are approved and proposed: the rejection drops out.
    const listed = (await client.request("memory", { action: "list" }, "list")).result as MemoryListAnswer;
    expect(listed.records.map((record) => record.recordId)).toEqual([first.recordId]);
    const history = (await client.request("memory", { action: "list", statuses: ["rejected"] }, "rejected")).result as MemoryListAnswer;
    expect(history.records.map((record) => record.recordId)).toEqual([second.recordId]);
  });

  it("remembers into each scope target, corrects as a new revision by the operator, and forgets", async () => {
    const { handle, client } = await owner();
    const write = async (scope: string) =>
      await client.request("memory", { action: "remember", kind: "fact", scope, body: `in ${scope}` }, `remember-${scope}`);
    expect((await write("personal")).result).toMatchObject({ target: "personal", scope: { kind: "personal", principalId: "operator" } });
    expect((await write("workspace")).result).toMatchObject({
      target: "workspace",
      scope: { kind: "personal_workspace", workspaceId: "default" },
    });
    const agent = (await write("agent:chief")).result as MemoryItem;
    expect(agent).toMatchObject({ target: "agent:chief", scope: { kind: "personal_agent", agentId: "chief", workspaceId: "default" } });
    expect((await write("shared")).error?.code).toBe("NOT_AUTHORIZED");
    const preference = await client.request(
      "memory",
      { action: "remember", kind: "fact", scope: "personal", body: "x", preferenceKey: "k" },
      "bad",
    );
    expect(preference.error?.code).toBe("INVALID_INPUT");

    const agentOnly = (await client.request("memory", { action: "list", scopes: ["agent:chief"] }, "agent")).result as MemoryListAnswer;
    expect(agentOnly.records.map((record) => record.recordId)).toEqual([agent.recordId]);

    const corrected = await client.request(
      "memory",
      { action: "correct", recordId: agent.recordId, body: "in the chief's memory" },
      "correct",
    );
    expect(corrected.result).toMatchObject({ body: "in the chief's memory", status: "approved" });
    const stale = await client.request(
      "memory",
      { action: "correct", recordId: agent.recordId, body: "late", expectedRevisionId: agent.currentRevisionId },
      "stale",
    );
    expect(stale.error?.code).toBe("REVISION_CONFLICT");
    const detail = (await client.request("memory", { action: "get", recordId: agent.recordId }, "get")).result as MemoryGetAnswer;
    expect(detail.revisionCount).toBe(2);
    expect(detail.revisions[0]).toMatchObject({ revisionNumber: 2, author: "operator:cli", status: "active" });
    expect(detail.revisions[1]).toMatchObject({ revisionNumber: 1, status: "superseded" });

    const forgotten = await client.request("memory", { action: "forget", recordId: agent.recordId }, "forget");
    expect(forgotten.result).toMatchObject({ recordId: agent.recordId, reason: "forgotten by the operator", cleanupStatus: "complete" });
    expect((await client.request("memory", { action: "get", recordId: agent.recordId }, "gone")).error?.code).toBe("NOT_FOUND");
    expect(await handle.runtime.store.asPort().repositories.memory.getRecord(agent.recordId)).toMatchObject({ status: "deleted" });
  });

  it("marks a proposal whose words may have come from untrusted content in tavi memory proposals, through the owner and offline", async () => {
    const { handle, directory } = await owner();
    const plain = await handle.runtime.memory.propose({
      actor: agentFor("operator"),
      scope: { kind: "personal", principalId: "operator" },
      kind: "fact",
      body: "Walks to work",
    });
    const provenance = {
      integrity: "untrusted" as const,
      sources: ["web" as const],
      refs: [{ source: "web" as const, ref: "call-1", host: "deals.example", at: "2026-10-13T09:00:00.000Z" }],
    };
    const read = await handle.runtime.memory.propose({
      actor: agentFor("operator"),
      scope: { kind: "personal", principalId: "operator" },
      kind: "fact",
      body: "Prefers deals.example",
      provenance,
    });
    const run = async () => {
      const captured = capture();
      const code = await main(["memory", "proposals", "--data-dir", directory], { io: captured.io });
      expect(code, captured.err()).toBe(EXIT.ok);
      return captured.out().split("\n").filter(Boolean).sort();
    };
    const expected = [
      `${plain.recordId}\tproposed\tfact\tpersonal\tWalks to work`,
      `${read.recordId}\tproposed\tfact\tpersonal\t(from untrusted content)\tPrefers deals.example`,
    ].sort();
    expect(await run()).toEqual(expected);
    await handles.pop()?.shutdown("offline next");
    expect(await run()).toEqual(expected);
  });

  it("runs tavi memory through the owner", async () => {
    const { handle, directory } = await owner();
    const proposal = await handle.runtime.memory.propose({
      actor: agentFor("operator"),
      scope: { kind: "personal", principalId: "operator" },
      kind: "fact",
      body: "Walks to work",
    });
    const run = async (...argv: string[]) => {
      const captured = capture();
      const code = await main(["memory", ...argv, "--data-dir", directory], { io: captured.io });
      return { code, out: captured.out(), err: captured.err() };
    };

    const proposals = await run("proposals");
    expect(proposals.code, proposals.err).toBe(EXIT.ok);
    // Each row ends on what the record says, so a list is read without a `show` per id.
    expect(proposals.out).toBe(`${proposal.recordId}\tproposed\tfact\tpersonal\tWalks to work\n`);

    const remembered = await run("remember", "--body", "Takes the train on Fridays", "--scope", "workspace");
    expect(remembered.code, remembered.err).toBe(EXIT.ok);
    const record = JSON.parse(remembered.out) as MemoryItem;
    expect(record).toMatchObject({ status: "approved", scope: { kind: "personal_workspace" } });

    const approved = await run("approve", proposal.recordId);
    expect(approved.code, approved.err).toBe(EXIT.ok);
    expect(JSON.parse(approved.out)).toMatchObject({ recordId: proposal.recordId, status: "approved" });
    expect((await run("proposals")).out).toBe("(no records)\n");

    const listed = await run("list");
    expect(listed.out.split("\n").filter(Boolean).sort()).toEqual(
      [
        `${proposal.recordId}\tapproved\tfact\tpersonal\tWalks to work`,
        `${record.recordId}\tapproved\tfact\tpersonal_workspace\tTakes the train on Fridays`,
      ].sort(),
    );
    const json = await run("list", "--format", "json", "--scope", "workspace");
    expect((JSON.parse(json.out) as MemoryItem[]).map((row) => row.recordId)).toEqual([record.recordId]);

    const found = await run("search", "train");
    expect(found.out).toContain(`${record.recordId}\tfact\t`);
    const shown = await run("show", record.recordId);
    expect(JSON.parse(shown.out)).toMatchObject({ recordId: record.recordId, body: "Takes the train on Fridays" });

    const corrected = await run("correct", record.recordId, "--body", "Takes the bus on Fridays");
    expect(JSON.parse(corrected.out)).toMatchObject({ body: "Takes the bus on Fridays" });

    const rejectedTwice = await run("reject", proposal.recordId, "--note", "changed my mind");
    expect(rejectedTwice.code).toBe(EXIT.usage);
    const missing = await run("show", "mem-nope");
    expect(missing.code).toBe(EXIT.unavailable);

    const forgotten = await run("forget", record.recordId, "--reason", "moved");
    expect(forgotten.code, forgotten.err).toBe(EXIT.ok);
    expect(JSON.parse(forgotten.out)).toMatchObject({ recordId: record.recordId, reason: "moved" });

    const exported = await run("export");
    expect(exported.code).toBe(EXIT.alreadyOwned);
    expect(exported.err).toContain("not available on a live owner");
  });

  it("expires the operator's and other people's unreviewed proposals from the retention sweep", async () => {
    const { handle } = await owner({ retentionSweepEnabled: true, retentionSweepIntervalMs: 100 });
    const longAgo = new Date(Date.now() - 31 * 86_400_000).toISOString();
    await insert(handle, "old-mine", { kind: "personal", principalId: "operator" }, "stale", { status: "proposed", at: longAgo });
    await admit(handle, "bob");
    await insert(handle, "old-bob", { kind: "personal", principalId: "bob" }, "stale too", { status: "proposed", at: longAgo });
    await insert(handle, "new-mine", { kind: "personal", principalId: "operator" }, "fresh", { status: "proposed" });
    const repository = handle.runtime.store.asPort().repositories.memory;
    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      ((await repository.getRecord("old-mine"))?.status !== "expired" || (await repository.getRecord("old-bob"))?.status !== "expired")
    ) {
      await delay(50);
    }
    expect((await repository.getRecord("old-mine"))?.status).toBe("expired");
    expect((await repository.getRecord("old-bob"))?.status).toBe("expired");
    expect((await repository.getRecord("new-mine"))?.status).toBe("proposed");
  }, 20_000);
});
