import { MemoryService, SkillService, SkillRolloutService } from "../src/persistence/service-facades.js";
import Database from "better-sqlite3";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SerializableAdmitRequest } from "@tavi/contracts";
import { sleep } from "@tavi/node-kit";
import { temporaryDirectories } from "@tavi/test-support";
import { DatabaseClient, type OpenDatabaseOptions } from "../src/persistence/client.js";

const directories = temporaryDirectories();
const clients: DatabaseClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  directories.cleanup();
});
async function open(limits?: OpenDatabaseOptions["limits"]): Promise<DatabaseClient> {
  const directory = directories.create("tavi-async-repositories-");
  const client = await DatabaseClient.open({ databasePath: join(directory, "tavi.sqlite"), ...(limits === undefined ? {} : { limits }) });
  clients.push(client);
  return client;
}
const time = "2026-09-28T00:00:00.000Z";
function request(key: string): SerializableAdmitRequest {
  return {
    workspaceId: "workspace",
    principalId: "operator",
    operationKey: key,
    kind: "start",
    intent: { prompt: "hello" },
    checkpointNamespace: "",
    newTaskId: `task-${key}`,
    newAdmissionId: `admission-${key}`,
    newThreadId: `thread-${key}`,
    now: time,
    prompt: { builtin: { text: "Built in", version: "test-v1" } },
  };
}

describe("worker-backed repository contracts", () => {
  it("deduplicates concurrent admissions and preserves one immutable prompt snapshot", async () => {
    const db = await open();
    const tasks = db.repositories.tasks;
    const input = request("same");
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => tasks.admit({ ...input, newTaskId: `task-${index}` })));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.task.taskId)).size).toBe(1);
    const first = results[0];
    if (first === undefined) throw new Error("No admission result");
    expect(await tasks.getPromptSnapshot(first.task.taskId)).toMatchObject({
      source: "builtin",
      text: "Built in",
      templateVersion: "test-v1",
    });
    expect(await tasks.listAdmissions(first.task.taskId)).toHaveLength(1);
  });

  it("pins a chat's base per prompt only when it changed, and a resume keeps its turn's", async () => {
    const db = await open();
    const tasks = db.repositories.tasks;
    const created = await tasks.admit(request("pin"));
    const taskId = created.task.taskId;
    const followUp = (key: string, kind: "reply" | "approval", builtin = "Built in", version = "test-v1"): SerializableAdmitRequest => ({
      ...request(key),
      taskId,
      kind,
      intent: kind === "reply" ? { prompt: key } : { resume: key },
      prompt: { builtin: { text: builtin, version } },
    });
    const pins = () => new Database(db.databasePath, { readonly: true });
    const pinCount = (): number => {
      const handle = pins();
      try {
        return (handle.prepare("SELECT count(*) AS n FROM tavi_task_prompt_pins").get() as { n: number }).n;
      } finally {
        handle.close();
      }
    };

    // Unchanged: nothing is pinned, and the turn reads the task's own snapshot.
    const same = await tasks.admit(followUp("same", "reply"));
    expect(pinCount()).toBe(0);
    expect(await tasks.getPromptSnapshot(taskId, same.admission.admissionId)).toMatchObject({
      text: "Built in",
      templateVersion: "test-v1",
    });

    // A newer shipped template: a chat on one keeps it, so nothing is pinned.
    await tasks.admit(followUp("newer", "reply", "Built in, newer", "test-v9"));
    expect(pinCount()).toBe(0);

    // Changed: the prompt pins the new base; the task's own snapshot is untouched.
    const changed = await tasks.admit(followUp("changed", "reply", "Built in v2", "test-v1"));
    expect(pinCount()).toBe(1);
    expect(await tasks.getPromptSnapshot(taskId, changed.admission.admissionId)).toMatchObject({
      source: "builtin",
      text: "Built in v2",
      templateVersion: "test-v1",
    });
    expect(await tasks.getPromptSnapshot(taskId)).toMatchObject({ text: "Built in", templateVersion: "test-v1" });

    // The turn suspends; a later edit does not reach its resume, which keeps the turn's pin.
    await tasks.commitAdmission({
      admissionId: changed.admission.admissionId,
      taskId,
      state: "committed",
      result: { status: "waiting", finalText: "" },
    });
    const resumed = await tasks.admit(followUp("resume", "approval", "Built in v3", "test-v1"));
    expect(pinCount()).toBe(1);
    expect(await tasks.getPromptSnapshot(taskId, resumed.admission.admissionId)).toMatchObject({ text: "Built in v2" });

    // The same base again reuses the latest pin rather than writing another.
    const again = await tasks.admit(followUp("again", "reply", "Built in v2", "test-v1"));
    expect(pinCount()).toBe(1);
    expect(await tasks.getPromptSnapshot(taskId, again.admission.admissionId)).toMatchObject({ text: "Built in v2" });
  });

  it("never re-pins an explicit base, and a task with no snapshot still answers none", async () => {
    const db = await open();
    const tasks = db.repositories.tasks;
    const input = request("explicit");
    const created = await tasks.admit({ ...input, prompt: { ...input.prompt, explicitPrompt: "Routine pinned" } });
    const reply = await tasks.admit({
      ...request("explicit-reply"),
      taskId: created.task.taskId,
      kind: "reply",
      intent: { prompt: "next" },
    });
    expect(await tasks.getPromptSnapshot(created.task.taskId, reply.admission.admissionId)).toMatchObject({
      source: "explicit",
      text: "Routine pinned",
    });

    const plain = await tasks.admit(request("orphan"));
    const changed = await tasks.admit({
      ...request("orphan-reply"),
      taskId: plain.task.taskId,
      kind: "reply",
      intent: { prompt: "next" },
      prompt: { builtin: { text: "Other", version: "test-v2" } },
    });
    const handle = new Database(db.databasePath);
    try {
      handle.prepare("DELETE FROM tavi_task_prompt_snapshots WHERE task_id = ?").run(plain.task.taskId);
    } finally {
      handle.close();
    }
    expect(await tasks.getPromptSnapshot(plain.task.taskId, changed.admission.admissionId)).toBeUndefined();
  });

  it("rolls back task creation when the admission prompt snapshot is invalid", async () => {
    const db = await open();
    const input = request("invalid");
    await expect(
      db.repositories.tasks.admit({ ...input, prompt: { ...input.prompt, builtin: { text: "", version: "invalid" } } }),
    ).rejects.toMatchObject({ details: { mutationOutcome: "rolled-back" } });
    expect(await db.repositories.tasks.get(input.newTaskId)).toBeUndefined();
    expect((await db.repositories.tasks.admit(input)).created).toBe(true);
  });

  it("allows only one execution owner and atomically closes approvals when cancelling", async () => {
    const db = await open();
    const admitted = await db.repositories.tasks.admit(request("claim"));
    const input = {
      taskId: admitted.task.taskId,
      admissionId: admitted.admission.admissionId,
      leaseMs: 10_000,
      now: { execution: true } as const,
    };
    const results = await Promise.allSettled(
      ["one", "two"].map((ownerSession) => db.repositories.executions.acquire({ ...input, ownerSession })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await db.repositories.approvals.request({
      approvalId: "approval-one",
      taskId: input.taskId,
      admissionId: input.admissionId,
      toolId: "tool",
      callId: "call",
      steps: 1,
      inputs: {},
      now: { fixed: time },
    });
    expect(
      await db.cancelTask({ taskId: input.taskId, reason: "operator cancelled", operator: "operator", now: { fixed: time } }),
    ).toMatchObject({ cancelledApprovals: 1 });
    expect(await db.repositories.tasks.get(input.taskId)).toMatchObject({ status: "cancelled" });
    expect(await db.repositories.approvals.get("approval-one")).toMatchObject({ state: "cancelled" });
    await expect(
      db.repositories.approvals.decide({ approvalId: "approval-one", state: "granted", decidedBy: "operator", now: { fixed: time } }),
    ).rejects.toThrow();
  });

  it("starts an execution lease after queued contention clears", async () => {
    const db = await open();
    const admitted = await db.repositories.tasks.admit(request("lease"));
    const holder = new Database(db.databasePath);
    holder.exec("BEGIN IMMEDIATE");
    const startedAt = Date.now();
    const claim = db.repositories.executions.acquire({
      taskId: admitted.task.taskId,
      admissionId: admitted.admission.admissionId,
      ownerSession: "owner",
      leaseMs: 10_000,
      now: { execution: true },
    });
    try {
      await sleep(50);
      holder.exec("ROLLBACK");
      const lease = await claim;
      expect(Date.parse(lease.leaseExpiresAt)).toBeGreaterThanOrEqual(startedAt + 10_000);
    } finally {
      holder.close();
    }
  });
  it("replays artifact publication by identity and refuses different bytes under the same identity", async () => {
    const db = await open();
    const input = { artifactId: "art-stable-publication", workspaceId: "workspace", contentType: "text/plain", body: "original" };
    const [first, replay] = await Promise.all([db.repositories.artifacts.putArtifact(input), db.repositories.artifacts.putArtifact(input)]);
    expect(replay).toEqual(first);
    await expect(db.repositories.artifacts.putArtifact({ ...input, body: "different" })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { artifactId: input.artifactId },
    });
    expect(Buffer.from((await db.repositories.artifacts.readArtifactBody(input.artifactId)) ?? []).toString()).toBe("original");
  });
});

it("reserves queue capacity for a messaging receipt after the ordinary queue fills", async () => {
  const db = await open({ requests: 1, controlRequests: 1, bytes: 32 * 1024 * 1024, controlBytes: 4 * 1024 * 1024 });
  await db.repositories.messagingOutbox.begin({
    effectId: "sent",
    connectionId: "connection",
    message: { effectId: "sent", connectionId: "connection", destination: { chatId: "chat" }, parts: [{ content: "hello" }] },
    now: { execution: true },
  });
  const ordinary = db.setMeta("busy", "value", time);
  const receipt = db.repositories.messagingOutbox.resolve({
    effectId: "sent",
    outcome: { status: "accepted", retryable: false, parts: [] },
    now: { execution: true },
  });
  await Promise.all([ordinary, receipt]);
  expect(await db.repositories.messagingOutbox.get("sent")).toMatchObject({ state: "resolved", outcome: { status: "accepted" } });
});

it("allocates custom service identifiers only for mutations and preserves every supplied identifier", async () => {
  const db = await open();
  const calls: string[] = [];
  const options = {
    newId: (prefix: string) => {
      calls.push(prefix);
      return `${prefix}-custom-${calls.length * 7}`;
    },
  };
  const actor = { workspaceId: "workspace", principalId: "operator", caller: "cli", authority: "operator" as const };
  const memory = new MemoryService(db, options);
  expect(await memory.list({ actor })).toEqual([]);
  expect(calls).toEqual([]);
  const record = await memory.remember({
    actor,
    scope: { kind: "personal", principalId: "operator" },
    kind: "fact",
    body: "Remember this fact",
  });
  expect(record.recordId).toBe("mem-custom-7");
  expect(calls).toEqual(["mem", "memrev", "memreview"]);

  const skills = new SkillService(db, options);
  const rollout = new SkillRolloutService(db, options);
  await skills.import({
    actor,
    skillId: "test",
    version: "1.0.0",
    manifest: { name: "Test", supportedRuntimeVersions: ["1.0"], supportedToolContractVersions: ["1.0"] },
    packageBody: new TextEncoder().encode("test skill"),
    provenance: "operator",
  });
  await skills.approve({ actor, skillId: "test", version: "1.0.0" });
  await skills.activate({ actor, skillId: "test", version: "1.0.0" });
  await rollout.pinRollout({ actor, skillId: "test", taskIds: ["first", "second"] });
  const allowed = await db.repositories.skillRollout.listAllowed({ scopeKey: "workspace", skillId: "test", version: "1.0.0" });
  expect(allowed.map((row) => row.entryId).sort()).toEqual(["rollout-custom-35", "rollout-custom-42"]);
  await skills.disable({ actor, skillId: "test" });
  expect(await skills.listActive({ actor })).toEqual([]);
});
