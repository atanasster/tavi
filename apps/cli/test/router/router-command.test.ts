import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi, afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import {
  RouterPayloadSchema,
  RouterSettingsSchema,
  RouterReceiptSchema,
  ContextProjectionSnapshotSchema,
  encodeFrame,
  parseCommandPayload,
} from "@tavi/contracts";
import { ModelAccounting, RouterRepository } from "@tavi/runtime";
import { SqliteStore } from "../support/database-fixture.js";
import { routerCommand } from "../../src/features/router/owner.js";
import { parseArgs } from "../../src/cli/parse.js";
import { main } from "../../src/main.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

it("validates CLI and IPC router payloads without accepting embedded secrets", () => {
  expect(parseArgs(["router", "set-mode", "tools", "shadow", "--revision", "2"]).router).toMatchObject({
    feature: "tools",
    mode: "shadow",
    expectedRevision: 2,
  });
  expect(() => parseArgs(["router", "set-mode", "tools", "active"])).toThrow("--revision");
  expect(() => parseArgs(["router", "status", "extra"])).toThrow();
  expect(parseCommandPayload("router", { action: "status" }).ok).toBe(true);
  expect(parseCommandPayload("router", { action: "configure", expectedRevision: 0, settings: { apiKey: "secret" } }).ok).toBe(false);
});
it("owns offline configuration and explains missing credentials without revealing values", async () => {
  const directory = directories.create("tavi-router-command-");
  const output: string[] = [];
  const errors: string[] = [];
  const io = { isTty: false, stdout: (text: string) => output.push(text), stderr: (text: string) => errors.push(text) };
  expect(await main(["router", "status", "--data-dir", directory], { io })).toBe(0);
  expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({
    configuration: { revision: 0, settings: { enabled: false } },
    credentialPresence: "not-configured",
  });
  const file = join(directory, "router.json");
  writeFileSync(
    file,
    JSON.stringify({
      settings: { enabled: true, providerSettings: { "tavi.router": { credentialRef: "jev.key" } }, modes: { tools: "shadow" } },
    }),
  );
  expect(await main(["router", "configure", "--file", file, "--revision", "0", "--data-dir", directory], { io })).toBe(0);
  expect(await main(["router", "status", "--data-dir", directory], { io })).toBe(0);
  expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({
    credentialPresence: "missing",
    liveCredentialValidity: "not-tested",
    priceReady: false,
  });
  // A stale revision is the operator's input, exit 2 as on a live owner, and names the current one.
  expect(await main(["router", "set-mode", "tools", "active", "--revision", "0", "--data-dir", directory], { io })).toBe(2);
  expect(errors.join("")).toContain(
    "router failed: REVISION_CONFLICT: The router configuration changed: revision 0 is stale, it is now at revision 1",
  );
  // A file that is no JSON is a usage error too, never the internal-error exit.
  writeFileSync(file, "");
  expect(await main(["router", "configure", "--file", file, "--revision", "1", "--data-dir", directory], { io })).toBe(2);
  expect(errors.join("")).toContain("router failed: INVALID_INPUT: Router configuration is not valid JSON");
});
it("rolls back prices on configuration conflicts, scopes explanations, and labels unknown cost", async () => {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  const scope = { workspaceId: "default", principalId: "operator" };
  const repository = new RouterRepository(store, (actor) => actor.principalId === "operator");
  const accounting = new ModelAccounting(store.asPort());
  const disable = vi.fn();
  const deps = {
    repository,
    accounting,
    service: { disable },
    readSecret: async () => "never-output-this",
    transaction: <T>(body: () => T) => store.handle.transaction(body)(),
    now: () => "2026-09-25T00:00:00.000Z",
  };
  try {
    const p = store.asPort().repositories;
    await p.tasks.admit({
      prompt: fixturePromptPolicy,
      ...scope,
      operationKey: "start",
      kind: "start",
      intent: { prompt: "hello" },
      checkpointNamespace: "",
      newTaskId: (() => "task")(),
      newThreadId: (() => "thread")(),
      newAdmissionId: (() => "admission")(),
      now: deps.now(),
    });
    await accounting.begin({
      callId: "call",
      runId: "task",
      attemptId: "attempt",
      ownerSession: "owner",
      connectionId: "main",
      model: "m",
      purpose: "generation",
      startedAt: deps.now(),
    });
    const explained = await routerCommand(deps, RouterPayloadSchema.parse({ action: "explain", taskId: "task" }));
    expect(explained).toMatchObject({
      route: null,
      cost: { complete: false, knownEstimatedUsd: 0, unknownAttempts: 1, attempts: 1 },
      truncated: { attempts: false },
    });
    // Attempts are listed as summaries: never with the request each one stored.
    expect((explained as { attempts: unknown[] }).attempts).toEqual([
      {
        callId: "call",
        attemptId: "attempt",
        connectionId: "main",
        model: "m",
        state: "started",
        purpose: "generation",
        usage: {},
        startedAt: deps.now(),
      },
    ]);
    await expect(
      routerCommand(deps, RouterPayloadSchema.parse({ action: "explain", taskId: "task", workspaceId: "other" })),
    ).rejects.toThrow("outside this scope");
    await routerCommand(deps, {
      ...scope,
      action: "configure",
      expectedRevision: 0,
      settings: RouterSettingsSchema.parse({ providerSettings: { "tavi.router": { credentialRef: "jev.key" } } }),
      priceSheets: [],
    });
    expect(disable).toHaveBeenCalledOnce();
    expect(JSON.stringify(await routerCommand(deps, { ...scope, action: "status" }))).not.toContain("never-output-this");
    const price = {
      revision: "r",
      connectionId: "jev",
      model: "jev-1.13.0",
      effectiveAt: deps.now(),
      currency: "USD" as const,
      input: 1,
      cacheRead: 1,
      cacheWrite: 1,
      output: 0,
    };
    await expect(
      routerCommand(deps, {
        ...scope,
        action: "configure",
        expectedRevision: 0,
        settings: RouterSettingsSchema.parse({}),
        priceSheets: [price],
      }),
    ).rejects.toThrow("configuration changed");
    expect(await accounting.price("jev", price.model, deps.now())).toBeUndefined();
  } finally {
    store.close();
  }
});

it("keeps escaped maximum-length explanation identifiers inside the IPC byte limit", async () => {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  const repository = new RouterRepository(store, () => true);
  const at = "2026-09-25T00:00:00.000Z";
  const ids = Array.from({ length: 32 }, (_, i) => `${i}`.padEnd(128, "\u0001"));
  const receipts = Array.from({ length: 20 }, (_, i) =>
    RouterReceiptSchema.parse({
      decisionId: `d${i}`,
      operationId: `o${i}`,
      taskId: "task",
      turnId: "turn",
      feature: "skills",
      mode: "active",
      providerId: "tavi.router",
      configRevision: 1,
      policyVersion: "v1",
      candidateHash: "a".repeat(64),
      permissionRevision: "1",
      state: "finished",
      reason: "selected",
      selectedIds: ids,
      probabilities: Object.fromEntries(ids.map((id) => [id, 0.99])),
      cacheHit: false,
      elapsedMs: 1,
      startedAt: at,
    }),
  );
  const projections = Array.from({ length: 5 }, (_, i) =>
    ContextProjectionSnapshotSchema.parse({
      taskId: "task",
      attemptId: `a${i}`,
      turnId: "turn",
      step: i,
      configRevision: 1,
      createdAt: at,
      memoryCandidates: [],
      memoryExposed: [],
      retrievalCoverage: "complete",
      recommendedSkills: ids.map((id) => ({ skillId: id, version: "\u0001".repeat(64) })),
      exposedSkills: ids.map((id) => ({ skillId: id, version: "\u0001".repeat(64) })),
    }),
  );
  vi.spyOn(repository, "route").mockResolvedValue(undefined);
  vi.spyOn(repository, "receipts").mockResolvedValue(receipts);
  vi.spyOn(repository, "contextProjections").mockResolvedValue(projections);
  vi.spyOn(repository, "spent").mockResolvedValue(0);
  try {
    const result = await routerCommand(
      { repository, accounting: new ModelAccounting(store.asPort()), readSecret: async () => null, now: () => at },
      RouterPayloadSchema.parse({ action: "explain", taskId: "task" }),
    );
    expect(result).toMatchObject({ truncated: { receipts: true } });
    expect(() => encodeFrame({ type: "response", requestId: "r".repeat(128), ok: true, result })).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(512 * 1024);
  } finally {
    store.close();
  }
});
