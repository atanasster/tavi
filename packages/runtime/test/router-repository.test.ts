import { RouterRepository } from "../src/router/repository.js";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RouterSettingsSchema, type RouterReceipt } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { APPLICATION_TABLES } from "../src/index.js";
import { SqliteStore } from "../src/persistence/store.js";

const at = "2026-09-25T00:00:00.000Z";
const scope = { workspaceId: "default", principalId: "alice" };
const cleanup: (() => void)[] = [];
const directories = temporaryDirectories();
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  directories.cleanup();
});
function fixture(path = ":memory:") {
  const store = new SqliteStore({ databasePath: path, ...(path === ":memory:" ? { inMemory: true } : {}) });
  cleanup.push(() => store.close());
  let authorized = true;
  const repo = new RouterRepository(
    store,
    (actor) => authorized && actor.workspaceId === scope.workspaceId && actor.principalId === scope.principalId,
  );
  const p = store.asPort().repositories;
  const { task, admission } = p.tasks.admit({
    ...scope,
    operationKey: "start",
    kind: "start",
    intent: { prompt: "hello" },
    checkpointNamespace: "",
    newTaskId: () => "task-1",
    newThreadId: () => "thread-1",
    newAdmissionId: () => "admission-1",
    now: () => at,
  });
  const lease = p.executions.acquire({
    taskId: task.taskId,
    admissionId: admission.admissionId,
    ownerSession: "owner",
    leaseMs: 60_000,
    now: () => at,
  });
  const fence = { taskId: task.taskId, generation: lease.generation, ownerSession: "owner" };
  const settings = RouterSettingsSchema.parse({ enabled: true, modes: { model: "shadow" }, maxTaskUsd: 0.01, maxWorkspaceUsd: 0.02 });
  repo.configure(scope, settings, 0);
  const receipt = (operationId = "operation-1"): RouterReceipt => ({
    decisionId: `decision-${operationId}`,
    operationId,
    taskId: task.taskId,
    turnId: "turn-1",
    feature: "model",
    mode: "shadow",
    providerId: "tavi.router",
    configRevision: 1,
    policyVersion: "v1",
    candidateHash: "a".repeat(64),
    permissionRevision: "1",
    state: "pending",
    reason: "selected",
    selectedIds: [],
    probabilities: {},
    cacheHit: false,
    elapsedMs: 0,
    startedAt: at,
    callId: `call-${operationId}`,
  });
  return {
    store,
    repo,
    fence,
    settings,
    receipt,
    revoke: () => {
      authorized = false;
    },
  };
}

describe("router configuration and authority", () => {
  it("defaults to no egress and no enabled features, with explicit revision updates", () => {
    const f = fixture();
    expect(RouterSettingsSchema.parse({})).toMatchObject({
      enabled: false,
      modes: { model: "off", memory: "off", tools: "off", skills: "off" },
      egress: { taskText: false, memoryExcerpts: false, skillMetadata: false, toolDescriptions: false },
    });
    expect(() => f.repo.configure(scope, f.settings, 0)).toThrow("configuration changed");
    // A stale revision names the current one, and where to read it.
    expect(() => f.repo.configure(scope, f.settings, 0)).toThrow(
      /revision 0 is stale, it is now at revision \d+; read it with `tavi router status`/,
    );
    expect(RouterSettingsSchema.safeParse({ credentialRef: "../../secret" }).success).toBe(false);
    expect(RouterSettingsSchema.safeParse({ endpoint: "https://attacker.example" }).success).toBe(false);
    f.revoke();
    expect(() => f.repo.configuration(scope)).toThrow("not authorized");
  });
  it("refuses cross-principal reads and superseded generation writes", () => {
    const f = fixture();
    expect(() => f.repo.receipts({ ...scope, principalId: "bob" }, "task-1")).toThrow("not authorized");
    expect(() => f.repo.reserve(scope, { ...f.fence, generation: 99 }, f.receipt(), 0.002)).toThrow();
    expect(f.repo.spent(scope)).toBe(0);
    expect(f.repo.reserve(scope, f.fence, f.receipt(), 0.002)).toBe(true);
    f.store.asPort().repositories.executions.release({ ...f.fence, now: () => at });
    expect(() => f.repo.finish(scope, f.fence, { ...f.receipt(), state: "finished" }, 0)).toThrow();
    expect(f.repo.spent(scope)).toBe(0.002);
  });
});

describe("router reservations and recovery", () => {
  it("shares the workspace cap across principals without sharing task receipts", () => {
    const f = fixture();
    f.repo.configure(scope, { ...f.settings, maxWorkspaceUsd: 0.006 }, 1);
    expect(f.repo.reserve(scope, f.fence, { ...f.receipt(), configRevision: 2 }, 0.004)).toBe(true);
    const bob = { ...scope, principalId: "bob" };
    const repo = new RouterRepository(f.store, (actor) => actor.workspaceId === scope.workspaceId);
    repo.configure(bob, { ...f.settings, maxWorkspaceUsd: 0.02 }, 0);
    const p = f.store.asPort().repositories;
    const admitted = p.tasks.admit({
      ...bob,
      operationKey: "bob-start",
      kind: "start",
      intent: { prompt: "hello" },
      checkpointNamespace: "",
      newTaskId: () => "task-bob",
      newThreadId: () => "thread-bob",
      newAdmissionId: () => "admission-bob",
      now: () => at,
    });
    const lease = p.executions.acquire({
      taskId: admitted.task.taskId,
      admissionId: admitted.admission.admissionId,
      ownerSession: "owner",
      leaseMs: 60_000,
      now: () => at,
    });
    const fence = { taskId: admitted.task.taskId, generation: lease.generation, ownerSession: "owner" };
    const receipt = { ...f.receipt("bob"), taskId: admitted.task.taskId };
    expect(repo.spent(bob)).toBe(0.004);
    expect(repo.reserve(bob, fence, receipt, 0.004)).toBe(false);
    expect(repo.reserve(bob, fence, receipt, 0.002)).toBe(true);
    expect(f.repo.spent(scope)).toBe(0.006);
    expect(() => repo.receipts(bob, "task-1")).toThrow("outside this scope");
    f.store.handle.prepare("DELETE FROM tavi_tasks WHERE task_id=?").run("task-1");
    expect(repo.spent(bob)).toBe(0.006);
    expect(
      repo.reserve(bob, fence, { ...receipt, operationId: "bob-again", decisionId: "another-decision", callId: "another-call" }, 0.001),
    ).toBe(false);
  });
  it("reserves atomically, deduplicates an operation, and retains unknown charges", () => {
    const f = fixture();
    expect(f.repo.reserve(scope, f.fence, f.receipt(), 0.006)).toBe(true);
    expect(f.repo.reserve(scope, f.fence, f.receipt(), 0.006)).toBe(false);
    expect(f.repo.reserve(scope, f.fence, f.receipt("two"), 0.006)).toBe(false);
    f.repo.finish(scope, f.fence, { ...f.receipt(), state: "finished", reason: "deadline", finishedAt: at });
    expect(f.repo.spent(scope, "task-1")).toBe(0.006);
    expect(f.repo.reserve(scope, f.fence, f.receipt("two"), 0.004)).toBe(true);
    f.repo.finish(scope, f.fence, { ...f.receipt("two"), state: "finished", finishedAt: at }, 0.001);
    expect(f.repo.spent(scope)).toBe(0.007);
    expect(f.repo.reserve(scope, f.fence, f.receipt("three"), 0)).toBe(false);
    expect(f.repo.receipts(scope, "task-1")).toHaveLength(2);
  });
  it("blocks late selections after configuration changes and can record abstention", () => {
    const f = fixture();
    f.repo.reserve(scope, f.fence, f.receipt(), 0.002);
    f.repo.configure(scope, { ...f.settings, enabled: false }, 1);
    expect(() => f.repo.finish(scope, f.fence, { ...f.receipt(), state: "finished", selectedIds: ["fast"] }, 0.001)).toThrow(
      "configuration changed",
    );
    f.repo.finish(scope, f.fence, { ...f.receipt(), state: "finished", reason: "stale" }, 0.001);
    expect(f.repo.decision(scope, "task-1", "operation-1")?.reason).toBe("stale");
  });
  it("lets a chat's chosen model replace its saved route, unfenced", () => {
    const f = fixture();
    const route = {
      taskId: "task-1",
      target: { connectionId: "fast", model: "m" },
      fallback: [{ connectionId: "main", model: "x" }],
      origin: "router" as const,
      configRevision: 1,
      createdAt: at,
    };
    f.repo.saveRoute(scope, f.fence, route);
    const chosen = f.repo.chooseRoute(scope, "task-1", { connectionId: "main", model: "other" }, at);
    expect(chosen).toMatchObject({ taskId: "task-1", target: { connectionId: "main", model: "other" }, fallback: [], origin: "explicit" });
    expect(f.repo.route(scope, "task-1")).toEqual(chosen);
    expect(() =>
      f.repo.chooseRoute({ workspaceId: "other", principalId: "p" }, "task-1", { connectionId: "main", model: "m" }, at),
    ).toThrow(expect.objectContaining({ code: "NOT_AUTHORIZED" }));
  });
  it("counts the models people chose for their chats, never a route the router saved", () => {
    const f = fixture();
    f.repo.saveRoute(scope, f.fence, {
      taskId: "task-1",
      target: { connectionId: "fast", model: "m" },
      fallback: [],
      origin: "router",
      configRevision: 0,
      createdAt: at,
    });
    expect(f.repo.chosenTargets(scope)).toEqual([]);
    f.repo.chooseRoute(scope, "task-1", { connectionId: "main", model: "other" }, at);
    expect(f.repo.chosenTargets(scope)).toEqual([{ connectionId: "main", model: "other", chats: 1 }]);
    const p = f.store.asPort().repositories;
    const admit = (principalId: string, id: string): void => {
      p.tasks.admit({
        ...scope,
        principalId,
        operationKey: `start-${id}`,
        kind: "start",
        intent: { prompt: "hello" },
        checkpointNamespace: "",
        newTaskId: () => id,
        newThreadId: () => `thread-${id}`,
        newAdmissionId: () => `admission-${id}`,
        now: () => at,
      });
    };
    admit("alice", "task-2");
    admit("bob", "task-bob");
    const bob = { ...scope, principalId: "bob" };
    const workspace = new RouterRepository(f.store, (actor) => actor.workspaceId === scope.workspaceId);
    f.repo.chooseRoute(scope, "task-2", { connectionId: "main", model: "other" }, at);
    workspace.chooseRoute(bob, "task-bob", { connectionId: "main", model: "bobs" }, at);
    expect(f.repo.chosenTargets(scope)).toEqual([{ connectionId: "main", model: "other", chats: 2 }]);
    expect(workspace.chosenTargets(bob)).toEqual([{ connectionId: "main", model: "bobs", chats: 1 }]);
    expect(() => f.repo.chosenTargets({ workspaceId: "other", principalId: "p" })).toThrow(
      expect.objectContaining({ code: "NOT_AUTHORIZED" }),
    );
    // A model that retires: its chats move to another, only this person's, never a route the router saved.
    expect(f.repo.retargetChosen(scope, { connectionId: "main", model: "other" }, { connectionId: "next", model: "new" })).toBe(2);
    expect(f.repo.chosenTargets(scope)).toEqual([{ connectionId: "next", model: "new", chats: 2 }]);
    expect(f.repo.route(scope, "task-2")?.target).toEqual({ connectionId: "next", model: "new" });
    expect(workspace.retargetChosen(bob, { connectionId: "main", model: "other" }, { connectionId: "next", model: "new" })).toBe(0);
    expect(workspace.chosenTargets(bob)).toEqual([{ connectionId: "main", model: "bobs", chats: 1 }]);
    expect(() =>
      f.repo.retargetChosen(
        { workspaceId: "other", principalId: "p" },
        { connectionId: "main", model: "m" },
        { connectionId: "n", model: "m" },
      ),
    ).toThrow(expect.objectContaining({ code: "NOT_AUTHORIZED" }));
  });

  it("persists routes and reservations across a database restart without repeating decisions", () => {
    const directory = directories.create("tavi-router-");
    const path = join(directory, "tavi.sqlite");
    const f = fixture(path);
    f.repo.reserve(scope, f.fence, f.receipt(), 0.004);
    const route = {
      taskId: "task-1",
      target: { connectionId: "fast", model: "m" },
      fallback: [],
      origin: "router" as const,
      configRevision: 1,
      decisionId: "decision-operation-1",
      createdAt: at,
    };
    expect(f.repo.saveRoute(scope, f.fence, route)).toEqual(route);
    expect(f.repo.saveRoute(scope, f.fence, { ...route, target: { connectionId: "main", model: "other" } })).toEqual(route);
    f.repo.saveDisclosure(scope, f.fence, {
      taskId: "task-1",
      attemptId: "attempt-1",
      tools: [{ id: "fs.read", revision: "1" }],
      createdAt: at,
    });
    f.store.close();
    cleanup.pop();
    const reopened = new SqliteStore({ databasePath: path });
    cleanup.push(() => reopened.close());
    const restored = new RouterRepository(reopened, () => true);
    expect(restored.recoverPreviousOwner("new-owner", at)).toBe(1);
    expect(restored.recoverPreviousOwner("new-owner", at)).toBe(0);
    expect(restored.route(scope, "task-1")).toEqual(route);
    expect(restored.disclosure(scope, "task-1", "attempt-1")?.tools).toEqual([{ id: "fs.read", revision: "1" }]);
    expect(restored.decision(scope, "task-1", "operation-1")).toMatchObject({ state: "uncertain", selectedIds: [] });
    expect(restored.spent(scope)).toBe(0.004);
    expect(APPLICATION_TABLES).toContain("tavi_router_decisions");
    expect(APPLICATION_TABLES).toContain("tavi_router_budget_totals");
  });
});

it("persists immutable fenced context projections and deletes them with their task", () => {
  const f = fixture();
  const projection = {
    taskId: "task-1",
    attemptId: "attempt-1",
    turnId: "turn-1",
    configRevision: 1,
    step: 1,
    createdAt: at,
    memoryCandidates: [],
    memoryExposed: [],
    retrievalCoverage: "complete" as const,
    recommendedSkills: [{ skillId: "explicit", version: "v1" }],
    exposedSkills: [
      { skillId: "explicit", version: "v1" },
      { skillId: "other", version: "v1" },
    ],
  };
  f.repo.saveContextProjection(scope, f.fence, projection);
  const restored = new RouterRepository(f.store, () => true);
  expect(restored.contextProjections(scope, "task-1")).toEqual([projection]);
  expect(() =>
    restored.saveContextProjection(scope, { ...f.fence, generation: f.fence.generation + 1 }, { ...projection, attemptId: "attempt-2" }),
  ).toThrow();
  expect(() => restored.saveContextProjection(scope, f.fence, { ...projection, recommendedSkills: [] })).toThrow("immutable");
  expect(() => restored.contextProjections({ ...scope, principalId: "other" }, "task-1")).toThrow("outside this scope");
  f.store.handle.prepare("DELETE FROM tavi_tasks WHERE task_id=?").run("task-1");
  expect(f.store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_context_projections").get()).toEqual({ n: 0 });
});
