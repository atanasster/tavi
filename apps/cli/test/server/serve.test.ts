import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  IPC_COMMANDS,
  IPC_PROTOCOL_VERSION,
  RoutineCreateSchema,
  parseCommandPayload,
  routineDefaults,
  type IpcCommand,
} from "@tavi/contracts";
import { RoutineService, acquireDataDirectoryOwnership, createIpcClient, readDiscovery, readToken } from "@tavi/runtime";
import { capture, temporaryDirectories, delay } from "@tavi/test-support";
import { SqliteStore } from "../support/database-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { connectLiveOwner } from "../../src/cli/owner-connection.js";
import { EXIT, main } from "../../src/main.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";
import { ended, requestWithSubscription } from "../support/ipc-run.js";

/**
 * A payload each command's schema accepts, harmless against an empty owner: a
 * missing task, an unknown workspace, a list. Keyed by every command, so a
 * command added to the contract needs a probe before the parity test compiles.
 */
const PROBES: Record<IpcCommand, unknown> = {
  routines: { action: "list", workspaceId: "default", principalId: "operator" },
  artifacts: { workspaceId: "default" },
  tasks: {},
  cancel: { taskId: "task-probe", reason: "probe" },
  recover: { taskId: "task-probe", generation: 1 },
  doctor: {},
  approvals: { action: "list" },
  shutdown: { reason: "probe" },
  run: { prompt: "probe", workspaceId: "workspace-probe", principal: "operator", operationKey: "probe-run", approval: "deny" },
  subscribe: { taskId: "task-probe" },
  unsubscribe: { subscriptionId: "subscription-probe" },
  approve: { taskId: "task-probe", workspaceId: "default", verdict: "approve" },
  review: { taskId: "task-probe", workspaceId: "default", decisions: [{ artifactId: "artifact-probe", approved: true }] },
  reply: { workspaceId: "default", conversationId: "conversation-probe", text: "probe", clientMessageId: "message-probe" },
  abort: { taskId: "task-probe" },
  agents: {},
  models: { action: "list" },
  channels: { action: "catalog" },
  "ui-preferences": { action: "get", workspaceId: "default" },
  credentials: { action: "list" },
  projects: { action: "list" },
  reports: { action: "list", workspaceId: "default", limit: 12 },
  schedules: { action: "list" },
  search: { action: "list" },
  router: { action: "status" },
  "system-prompt": { action: "get", workspaceId: "default" },
  plugins: { action: "list" },
  mcp: { action: "show", pluginId: "mcp.probe" },
  apps: { action: "list", workspaceId: "default" },
  permissions: { action: "rules" },
  "workspace-settings": { action: "get", workspaceId: "default" },
  center: { action: "summary", workspaceId: "default" },
  memory: { action: "usage", workspaceId: "default" },
  skills: { action: "list", workspaceId: "default" },
  reminders: { action: "list", workspaceId: "default" },
  heartbeat: { action: "get", workspaceId: "default" },
  ideas: { action: "list", workspaceId: "default" },
  onboarding: { action: "status", workspaceId: "default" },
  browser: { action: "list", workspaceId: "default" },
  "chat-context": { action: "get", workspaceId: "default", taskId: "t-missing" },
  "browser-live": { action: "unwatch", subscriptionId: "live-probe" },
  "reset-instance": { confirm: "reset" },
  "plugin-commands": { action: "list" },
  folder: { action: "show", workspaceId: "default", taskId: "t-missing" },
  browse: { workspaceId: "default" },
};

const directories = temporaryDirectories({ prefix: "tavi-serve-" });
const handles: ServeHandle[] = [];

const serveOptions = (directory: string) => fixtureRuntimeOptions(directory);

async function startServe(directory: string): Promise<ServeHandle> {
  const handle = await serve(serveOptions(directory), { dataDirectory: directory, drainDeadlineMs: 2_000 }, capture().io);
  handles.push(handle);
  return handle;
}

/** Admit one task so a command has something real to act on. */
async function seedTask(directory: string, taskId: string): Promise<void> {
  const store = await SqliteStore.open({
    databasePath: join(directory, "tavi.sqlite"),
    artifactsDirectory: join(directory, "artifacts"),
  });
  try {
    await store.asPort().repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "default",
      principalId: "operator",
      operationKey: `op-${taskId}`,
      kind: "start",
      intent: { prompt: "hi" },
      checkpointNamespace: "",
      newTaskId: (() => taskId)(),
      newAdmissionId: (() => `adm-${taskId}`)(),
      newThreadId: (() => `thread-${taskId}`)(),
      now: (() => "2026-01-01T00:00:00.000Z")(),
    });
  } finally {
    store.close();
  }
}

/** Read a task's durable status without going through the CLI. */
async function readTaskStatus(directory: string, taskId: string): Promise<string | undefined> {
  const store = await SqliteStore.open({
    databasePath: join(directory, "tavi.sqlite"),
    artifactsDirectory: join(directory, "artifacts"),
  });
  try {
    return (await store.asPort().repositories.tasks.get(taskId))?.status;
  } finally {
    store.close();
  }
}

/**
 * Leave a socket file behind exactly as a SIGKILLed owner does.
 *
 * A child process binds the endpoint and is killed without a graceful close, so
 * Node never unlinks the socket.
 */
async function leaveStaleSocket(endpoint: string): Promise<void> {
  const script =
    'const net = require("node:net");' +
    "const server = net.createServer();" +
    `server.listen(${JSON.stringify(endpoint)}, () => process.stdout.write("bound"));`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("bound")) resolve();
    });
    child.once("error", reject);
  });
  child.kill("SIGKILL");
  await once(child, "exit");
}

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop();
    if (handle !== undefined) await handle.shutdown("test cleanup");
  }
  directories.cleanup();
});

describe("tavi serve", () => {
  it("takes ownership and publishes discovery and a cookie for the bound endpoint", async () => {
    const directory = directories.create();
    const captured = capture();
    const handle = await serve(serveOptions(directory), { dataDirectory: directory, drainDeadlineMs: 2_000 }, captured.io);
    handles.push(handle);

    const discovery = readDiscovery(directory);
    expect(discovery?.protocolVersion).toBe(IPC_PROTOCOL_VERSION);
    expect(discovery?.pid).toBe(process.pid);
    expect(readToken(directory)).toBeDefined();
    expect(captured.stdout()).toContain("serving");
  });

  it("answers an authenticated client, and refuses an unauthenticated one", async () => {
    const directory = directories.create();
    await startServe(directory);

    const owner = await findLiveOwner(directory);
    expect(owner).toBeDefined();
    if (owner === undefined) throw new Error("serve did not publish discovery");
    const tunnel = await createIpcClient(owner);
    try {
      const response = await tunnel.request("tasks", {}, "r1");
      expect(response.ok).toBe(true);
      // The owner answering names itself: its lock is its own, so it is never read as "no owner".
      expect((response.result as { owner: unknown }).owner).toMatchObject({ session_id: expect.any(String), pid: process.pid });
    } finally {
      tunnel.close();
    }

    await expect(createIpcClient({ ...owner, token: "not-the-cookie" })).rejects.toThrowError();
    // The refusal is the endpoint's authentication, recorded as an auth failure —
    // not an incidental connect error that would pass a bare `rejects` check.
    expect(handles[handles.length - 1]?.server.authFailures()).toBeGreaterThan(0);
  });

  it("finds a live owner without waiting out the launchers' ownership retry", async () => {
    const directory = directories.create();
    await startServe(directory);

    // `findLiveOwner` probes the ownership lock to tell a live owner from a dead
    // one's leftover discovery. The probe used to spend the whole upgrade retry
    // (≈1 s) against the held lock, and every attached command paid it.
    const started = performance.now();
    const owner = await findLiveOwner(directory);
    const probeMs = performance.now() - started;
    expect(owner?.sessionId).toBe(readDiscovery(directory)?.sessionId);

    // The yardstick is that very retry, measured here under the same load: an
    // acquisition at the default timeout against the held lock spends all of it
    // (its sleeps alone sum to ≈0.8 s). A fixed bound flakes on a loaded machine;
    // half the retry still fails the moment the probe waits it out again.
    const forced = performance.now();
    await expect(acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "forced-retry" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const retryMs = performance.now() - forced;
    expect(retryMs).toBeGreaterThan(800);
    expect(probeMs).toBeLessThan(retryMs / 2);
  });

  it("closes the endpoint and clears discovery on shutdown", async () => {
    const directory = directories.create();
    const handle = await startServe(directory);
    expect(readDiscovery(directory)).toBeDefined();

    await handle.shutdown("test");
    expect(readDiscovery(directory)).toBeUndefined();
    // Discovery is gone, so nothing points a client at a dead endpoint.
    expect(await findLiveOwner(directory)).toBeUndefined();
    // And the ephemeral cookie is not left behind for a successor process.
    expect(readToken(directory)).toBeUndefined();
  });

  it("lists every routine in the workspace, a person's included, and opens one by its id as its owner's", async () => {
    const directory = directories.create();
    // Ana, allowed under a principal of her own, and a routine of hers and of the operator's, before the owner starts.
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    let hers = "";
    try {
      await store.asPort().repositories.messagingIdentityBindings.bind({
        connectionId: "tg",
        externalSenderId: "42",
        workspaceId: "default",
        principalId: "ana",
        approvedBy: "operator",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const routines = new RoutineService(store, {});
      const policy = { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] };
      const create = (principalId: string, name: string) =>
        routines.create(
          { workspaceId: "default", principalId },
          RoutineCreateSchema.parse({
            ...routineDefaults("UTC"),
            operationKey: `create-${principalId}`,
            name,
            objective: "Find news",
            agent: { agentId: "news", name: "News", instructions: "Research" },
            models: { research: policy, synthesis: policy },
            skills: [],
            triggers: [{ id: "daily", kind: "daily", at: "09:00", timezone: "UTC" }],
            permissions: { revision: 1, researchTools: ["web_search"], allowedHosts: [], networkMode: "open_web" },
          }),
        );
      hers = (await create("ana", "Ana's news")).routine.routineId;
      await create("operator", "My news");
    } finally {
      store.close();
    }
    await startServe(directory);
    const owner = await findLiveOwner(directory);
    if (owner === undefined) throw new Error("serve did not publish discovery");
    const tunnel = await createIpcClient(owner);
    try {
      // The page names no principal: the list is the workspace's, each row its owner's.
      const listed = (await tunnel.request("routines", { action: "list", workspaceId: "default" }, "list-all")).result as {
        routines: { name: string; principalId: string }[];
      };
      expect(listed.routines.map((routine) => [routine.name, routine.principalId]).sort()).toEqual([
        ["Ana's news", "ana"],
        ["My news", "operator"],
      ]);
      // Her routine, named by id alone, is opened as hers.
      const opened = await tunnel.request("routines", { action: "get", workspaceId: "default", routineId: hers }, "get-hers");
      expect(opened.ok).toBe(true);
      expect((opened.result as { routine: { principalId: string } }).routine.principalId).toBe("ana");

      // Revoked, her routine is kept and marked: it can be looked at and archived, not run.
      expect(
        (await tunnel.request("channels", { action: "revoke", workspaceId: "default", connectionId: "tg", sender: "42" }, "revoke-ana")).ok,
      ).toBe(true);
      const kept = (await tunnel.request("routines", { action: "list", workspaceId: "default" }, "list-after")).result as {
        routines: { name: string; ownerRevoked?: boolean }[];
      };
      expect(kept.routines.map((routine) => [routine.name, routine.ownerRevoked === true]).sort()).toEqual([
        ["Ana's news", true],
        ["My news", false],
      ]);
      const reopened = (await tunnel.request("routines", { action: "get", workspaceId: "default", routineId: hers }, "get-revoked"))
        .result as { ownerRevoked?: boolean; routine: { version: number } };
      expect(reopened.ownerRevoked).toBe(true);
      const run = await tunnel.request(
        "routines",
        { action: "run", workspaceId: "default", routineId: hers, operationKey: "run-revoked" },
        "run-revoked",
      );
      expect(run.error).toMatchObject({ code: "NOT_AUTHORIZED", message: expect.stringMatching(/no longer allowed/) });
      // A copy of it is hers too, so it is refused as she is.
      const copy = await tunnel.request(
        "routines",
        {
          action: "create",
          workspaceId: "default",
          copyOf: hers,
          operationKey: "copy-revoked",
          setup: { name: "Ana's news (copy)", objective: "Find news", timezone: "UTC" },
        },
        "copy-revoked",
      );
      expect(copy.error).toMatchObject({ code: "NOT_AUTHORIZED", message: expect.stringMatching(/no longer allowed/) });
      // Not through its schedule either: shown or paused, never resumed.
      const listedSchedules = (await tunnel.request("schedules", { action: "list", workspaceId: "default" }, "schedules-revoked"))
        .result as { schedules: { scheduleId: string; routineId?: string }[] };
      const herSchedule = listedSchedules.schedules.find((schedule) => schedule.routineId === hers)?.scheduleId ?? "";
      expect(
        (await tunnel.request("schedules", { action: "enable", workspaceId: "default", scheduleId: herSchedule }, "enable-revoked")).error,
      ).toMatchObject({ code: "NOT_AUTHORIZED", message: expect.stringMatching(/no longer allowed/) });
      // A principal named outright must act in the workspace: nothing is made for, or run as, anyone else.
      expect(
        (
          await tunnel.request(
            "routines",
            { action: "run", workspaceId: "default", principalId: "ana", routineId: hers, operationKey: "run-named" },
            "run-named",
          )
        ).error,
      ).toMatchObject({ code: "NOT_AUTHORIZED" });
      expect(
        (
          await tunnel.request(
            "schedules",
            { action: "add", workspaceId: "default", principalId: "mallory", name: "x", prompt: "y", at: "07:00", timezone: "UTC" },
            "add-stranger",
          )
        ).error,
      ).toMatchObject({ code: "NOT_AUTHORIZED" });
      const archived = await tunnel.request(
        "routines",
        { action: "archive", workspaceId: "default", routineId: hers, expectedVersion: reopened.routine.version },
        "archive-revoked",
      );
      expect(archived.ok).toBe(true);
      expect(
        (
          (await tunnel.request("routines", { action: "get", workspaceId: "default", routineId: hers }, "get-archived")).result as {
            routine: { status: string };
          }
        ).routine.status,
      ).toBe("archived");
    } finally {
      tunnel.close();
    }
  });

  it("refuses a second owner on the same data directory", async () => {
    const directory = directories.create();
    await startServe(directory);
    // One process owns a data directory; the second is refused before it can
    // publish credentials.
    await expect(startServe(directory)).rejects.toThrowError(/already owned by another process/);
  });

  it("configures router through authenticated owner IPC and rejects stale or foreign scope writes", async () => {
    const directory = directories.create();
    await startServe(directory);
    const io = capture();
    expect(await main(["router", "status", "--data-dir", directory], { io: io.io })).toBe(0);
    const owner = await findLiveOwner(directory);
    if (owner === undefined) throw new Error("serve did not publish discovery");
    const tunnel = await createIpcClient(owner);
    try {
      expect(
        (
          await tunnel.request(
            "router",
            { action: "configure", expectedRevision: 0, settings: { enabled: true, modes: { tools: "shadow" } } },
            "configure",
          )
        ).ok,
      ).toBe(true);
      expect(
        (await tunnel.request("router", { action: "set-mode", expectedRevision: 0, feature: "tools", mode: "active" }, "stale")).error
          ?.code,
      ).toBe("REVISION_CONFLICT");
      expect((await tunnel.request("router", { action: "status", principalId: "foreign" }, "foreign")).error?.code).toBe("NOT_AUTHORIZED");
      expect((await tunnel.request("router", { action: "status" }, "status")).result).toMatchObject({
        configuration: { revision: 1 },
        effectiveModes: { tools: "shadow" },
      });
    } finally {
      tunnel.close();
    }
  });

  it("sends cancel through the owner and reports NOT_FOUND for an unknown task", async () => {
    const directory = directories.create();
    const handle = await startServe(directory);
    const owner = await findLiveOwner(directory);
    if (owner === undefined) throw new Error("serve did not publish discovery");
    const tunnel = await createIpcClient(owner);
    const response = await tunnel.request("cancel", { taskId: "missing", reason: "x" }, "r1");
    // The owner is the authority: the command is answered by it, not by a second
    // direct database writer.
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("NOT_FOUND");
    tunnel.close();
    await handle.shutdown("done");
  });

  it("lists plugins' slash commands and answers NOT_FOUND for one no plugin adds", async () => {
    const directory = directories.create();
    const handle = await startServe(directory);
    const owner = await findLiveOwner(directory);
    if (owner === undefined) throw new Error("serve did not publish discovery");
    const tunnel = await createIpcClient(owner);
    expect(await tunnel.request("plugin-commands", { action: "list" }, "r1")).toMatchObject({ ok: true, result: { commands: [] } });
    const run = await tunnel.request("plugin-commands", { action: "run", name: "tally", args: "now" }, "r2");
    expect(run.ok).toBe(false);
    expect(run.error).toMatchObject({ code: "NOT_FOUND", message: "no plugin adds /tally" });
    tunnel.close();
    await handle.shutdown("done");
  });

  it("refuses an unknown command without harming the owner", async () => {
    const directory = directories.create();
    await startServe(directory);
    const owner = await findLiveOwner(directory);
    if (owner === undefined) throw new Error("serve did not publish discovery");
    const tunnel = await createIpcClient(owner);
    try {
      // An unknown command is refused without harming the owner.
      const bad = await tunnel.request("nonsense", {}, "r1");
      expect(bad.ok).toBe(false);
      const good = await tunnel.request("tasks", {}, "r2");
      expect(good.ok).toBe(true);
    } finally {
      tunnel.close();
    }
  });

  it("refuses a command the owner does not advertise, without a protocol break", async () => {
    // Additive compatibility, and why it needs no version bump: a client asks the
    // owner only for commands the owner *advertises*, so a command a newer CLI
    // knows and an older owner does not is refused before it is sent
    // (`UNAVAILABLE`, exit 4) while the protocol version stays equal — the version
    // is reserved for breaking changes. `features/run/attached.ts`'s capability check is
    // that gate, and this pins it against a real owner.
    const directory = directories.create();
    await startServe(directory);
    const owner = await findLiveOwner(directory);
    if (owner === undefined) throw new Error("serve did not publish discovery");
    // Same protocol on both sides, so neither refusal below can be a version
    // mismatch — the constant is pinned here deliberately.
    expect(owner.protocolVersion).toBe(IPC_PROTOCOL_VERSION);
    // A name this build's owner does not implement, as a later build's command
    // would appear to it.
    await expect(connectLiveOwner(directory, ["tasks", "tasks-v2"])).rejects.toThrow(/does not implement .*tasks-v2/);
    // The owner is unharmed: a command it does advertise still attaches.
    const client = await connectLiveOwner(directory, ["tasks"]);
    expect(client).toBeDefined();
    client?.close();
  });
});

describe("tavi serve durability and parity", () => {
  it("refuses to write directly when a live owner does not answer", async () => {
    const directory = directories.create();
    const handle = await startServe(directory);
    await seedTask(directory, "task-live");
    // Simulate any connect failure against a live owner: the endpoint is gone
    // while discovery and the ownership lock remain.
    rmSync(join(directory, "runtime", "ipc.sock"), { force: true });

    const captured = capture();
    const code = await main(["cancel", "task-live", "--reason", "second writer probe", "--data-dir", directory], { io: captured.io });
    // A foreground command attaches to the owner or fails clearly; it never
    // becomes a second SQLite writer.
    expect(code).not.toBe(EXIT.ok);
    expect(captured.stderr()).toContain("Refusing to open its database directly");
    expect(await readTaskStatus(directory, "task-live")).toBe("admitted");
    await handle.shutdown("test");
  });

  it("names the protocol mismatch and its remedy, exit 4, instead of 'did not answer'", async () => {
    const directory = directories.create();
    const handle = await startServe(directory);
    // The owner is healthy; only the version it published differs — the
    // upgrade-day shape, where a new CLI meets an old daemon still running.
    const discoveryPath = join(directory, "runtime", "ipc.json");
    const discovery = readDiscovery(directory);
    expect(discovery).toBeDefined();
    writeFileSync(discoveryPath, JSON.stringify({ ...discovery, protocolVersion: 1 }), { mode: 0o600 });
    chmodSync(discoveryPath, 0o600);

    const captured = capture();
    const code = await main(["tasks", "--data-dir", directory], { io: captured.io });
    expect(code).toBe(EXIT.unavailable);
    expect(captured.stderr()).toContain(`speaks protocol 1; this CLI speaks ${IPC_PROTOCOL_VERSION} — restart the service`);
    // The remedy is reported as itself, not folded into a connect failure.
    expect(captured.stderr()).not.toContain("did not answer");
    await handle.shutdown("test");
  });

  it("starts over a socket file left behind by a crashed owner", async () => {
    const directory = directories.create();
    const runtimeDirectory = join(directory, "runtime");
    mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
    const endpoint = join(runtimeDirectory, "ipc.sock");
    await leaveStaleSocket(endpoint);
    expect(existsSync(endpoint)).toBe(true);

    // Restart must not require an operator to delete the artifact by hand: a
    // stale socket file is reclaimed once ownership is held.
    const handle = await startServe(directory);
    expect(readDiscovery(directory)?.sessionId).toBe(handle.runtime.ownerSession);
  });

  it("refuses a non-socket object at the endpoint path and releases the directory", async () => {
    const directory = directories.create();
    const runtimeDirectory = join(directory, "runtime");
    mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
    const endpoint = join(runtimeDirectory, "ipc.sock");
    writeFileSync(endpoint, "not a socket");

    await expect(startServe(directory)).rejects.toThrowError(/is not a socket/);
    // The refusal must not leave the directory owned by a process that exited.
    rmSync(endpoint, { force: true });
    const handle = await startServe(directory);
    expect(readDiscovery(directory)?.sessionId).toBe(handle.runtime.ownerSession);
  });

  it("returns the same tasks document with and without an owner running", async () => {
    const directory = directories.create();
    await seedTask(directory, "task-parity");
    const handle = await startServe(directory);

    // With an owner: the command attaches and the owner answers.
    const attachedCapture = capture();
    const attachedCode = await main(["tasks", "--data-dir", directory], { io: attachedCapture.io });
    expect(attachedCode).toBe(EXIT.ok);
    const attached = JSON.parse(attachedCapture.stdout()) as Record<string, unknown>;

    await handle.shutdown("test");

    // Without an owner: the command reads the database directly.
    const directCapture = capture();
    const directCode = await main(["tasks", "--data-dir", directory], { io: directCapture.io });
    expect(directCode).toBe(EXIT.ok);
    const direct = JSON.parse(directCapture.stdout()) as Record<string, unknown>;

    // Same keys in the same order, so a script cannot receive a different document
    // depending on whether a service happens to be running.
    expect(Object.keys(attached)).toEqual(Object.keys(direct));
    expect(Object.keys(direct)).toEqual([
      "dataDirectory",
      "owner",
      "tasks",
      "expiredLeases",
      "cancellations",
      "pendingApprovals",
      "unresolvedEffects",
      // A messaging effect that began but never resolved — a delivery whose
      // fate the workflow cannot see.
      "pendingDeliveries",
    ]);
    expect(Object.keys(attached["tasks"] as object[] | Record<string, object>)).toEqual(
      Object.keys(direct["tasks"] as object[] | Record<string, object>),
    );
    expect((attached["tasks"] as { taskId: string }[])[0]?.taskId).toBe("task-parity");
  });

  it("shows one task the same way whether attached or direct, and refuses an unknown id identically", async () => {
    const directory = directories.create();
    await seedTask(directory, "task-show-parity");
    const handle = await startServe(directory);

    const attachedShown = capture();
    expect(await main(["tasks", "task-show-parity", "--data-dir", directory], { io: attachedShown.io })).toBe(EXIT.ok);
    const attachedDoc = JSON.parse(attachedShown.stdout()) as Record<string, unknown>;

    const attachedMissing = capture();
    const attachedMissingCode = await main(["tasks", "no-such-task", "--data-dir", directory], { io: attachedMissing.io });

    await handle.shutdown("test");

    const directShown = capture();
    expect(await main(["tasks", "task-show-parity", "--data-dir", directory], { io: directShown.io })).toBe(EXIT.ok);
    const directDoc = JSON.parse(directShown.stdout()) as Record<string, unknown>;

    const directMissing = capture();
    const directMissingCode = await main(["tasks", "no-such-task", "--data-dir", directory], { io: directMissing.io });

    expect(Object.keys(attachedDoc)).toEqual(Object.keys(directDoc));
    expect((attachedDoc["task"] as { taskId: string } | null)?.taskId).toBe("task-show-parity");
    expect((directDoc["task"] as { taskId: string } | null)?.taskId).toBe("task-show-parity");
    expect(attachedMissingCode).toBe(directMissingCode);
    expect(attachedMissingCode).toBe(EXIT.unavailable);
  });

  it("answers a missing task through the attached (live-owner) path as NOT_FOUND, like the direct path", async () => {
    const directory = directories.create();
    const handle = await startServe(directory);
    const attachedMissing = capture();
    expect(await main(["tasks", "no-such-task", "--data-dir", directory], { io: attachedMissing.io })).toBe(EXIT.unavailable);
    expect(attachedMissing.stderr()).toContain("NOT_FOUND");
    await handle.shutdown("test");
  });

  it("returns the same doctor document shape with and without an owner running", async () => {
    const directory = directories.create();
    const handle = await startServe(directory);
    const attachedCapture = capture();
    expect(await main(["doctor", "--data-dir", directory], { io: attachedCapture.io })).toBe(EXIT.ok);
    const attached = JSON.parse(attachedCapture.stdout()) as Record<string, unknown>;
    await handle.shutdown("test");

    const directCapture = capture();
    expect(await main(["doctor", "--data-dir", directory], { io: directCapture.io })).toBe(EXIT.ok);
    const direct = JSON.parse(directCapture.stdout()) as Record<string, unknown>;
    expect(Object.keys(attached)).toEqual(Object.keys(direct));
    expect(Object.keys(direct)).toContain("checkpoints");
  });

  it("recovers a dead generation and refuses a blank cancellation reason over IPC", async () => {
    const directory = directories.create();
    const handle = await startServe(directory);
    await seedTask(directory, "task-ipc");
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    await store.asPort().repositories.executions.acquire({
      taskId: "task-ipc",
      ownerSession: "session-that-died",
      admissionId: "adm-task-ipc",
      leaseMs: 1_000,
      now: { fixed: (() => "2026-01-01T00:00:00.000Z")() },
    });
    store.close();

    const owner = await findLiveOwner(directory);
    if (owner === undefined) throw new Error("serve did not publish discovery");
    const tunnel = await createIpcClient(owner);
    try {
      // The advertised command set is what the handler implements.
      const blank = await tunnel.request("cancel", { taskId: "task-ipc", reason: "   " }, "r1");
      expect(blank.ok).toBe(false);
      expect(blank.error?.code).toBe("INVALID_INPUT");

      const recovered = await tunnel.request(
        "recover",
        { taskId: "task-ipc", generation: 1, reason: "operator confirmed", operator: "tester" },
        "r2",
      );
      expect(recovered.ok).toBe(true);
      expect((recovered.result as { next: string }).next).toContain("new generation");
    } finally {
      tunnel.close();
    }
    await handle.shutdown("test");
  });

  it("implements exactly the commands the handshake advertises", async () => {
    const directory = directories.create();
    const handle = await startServe(directory);
    const owner = await findLiveOwner(directory);
    if (owner === undefined) throw new Error("serve did not publish discovery");
    const tunnel = await createIpcClient(owner);
    try {
      // `DISPATCHED_IPC_COMMANDS` is the one registry the compiler does *not*
      // gate: omitting a command from it is a silent `UNSUPPORTED` at runtime,
      // and the probe loop below cannot catch that because it iterates
      // the advertised set itself. Pinning the advertised set against the
      // contract is what makes a future omission fail here instead.
      expect([...tunnel.features].sort()).toEqual([...IPC_COMMANDS].sort());
      // The advertised set is the owner's own, and the owner must not answer
      // UNSUPPORTED for any member of it (a one-directional
      // invariant). Advertising *less* than the contract allows is correct
      // while a contract lands ahead of its implementation, so this asserts
      // containment rather than equality. `shutdown` is handled last because it
      // ends the owner.
      expect(tunnel.features.length).toBeGreaterThan(0);
      for (const command of tunnel.features) {
        expect(IPC_COMMANDS as readonly string[]).toContain(command);
      }
      // `reply` is the local connection's inbound transport.
      expect(tunnel.features).toContain("reply");
      for (const command of tunnel.features) {
        // Both end the owner; `reset-instance` has its own test below.
        if (command === "shutdown" || command === "reset-instance") continue;
        // A payload its schema accepts, so the probe reaches the dispatch
        // switch: an empty one is refused INVALID_INPUT before it, which would
        // hide a command advertised with no handler.
        const probe = PROBES[command as IpcCommand];
        expect(parseCommandPayload(command as IpcCommand, probe).ok, `${command}'s probe must parse`).toBe(true);
        const response = await tunnel.request(command, probe, `probe-${command}`);
        expect(response.error?.code, `${command} must not be UNSUPPORTED`).not.toBe("UNSUPPORTED");
      }
      const scopedRoutines = await tunnel.request("routines", { action: "list", workspaceId: "default" }, "routine-ui-scope");
      expect(scopedRoutines.ok).toBe(true);
      // The answer itself, not a serialized pending promise (`{}`), which blanked the canvas's Routines page.
      expect(scopedRoutines.result).toEqual({ routines: [] });
      const reserved = await tunnel.request(
        "routines",
        { action: "create", create: { execution: { overlap: "queue" } } },
        "reserved-routine-policy",
      );
      expect(reserved.error?.code).toBe("UNSUPPORTED");
      const shutdown = await tunnel.request("shutdown", { reason: "parity probe" }, "probe-shutdown");
      expect(shutdown.ok).toBe(true);
    } finally {
      tunnel.close();
    }
    await handle.stopped;
  });

  it("serves the subscription and abort commands", async () => {
    const directory = directories.create();
    const handle = await startServe(directory);
    await seedTask(directory, "task-1");
    const owner = await findLiveOwner(directory);
    if (owner === undefined) throw new Error("serve did not publish discovery");
    const tunnel = await createIpcClient(owner);
    try {
      // The implemented set is advertised, and the contract's list is a superset
      // of it — the one-directional invariant.
      for (const command of ["subscribe", "unsubscribe", "abort"]) {
        expect(tunnel.features).toContain(command);
      }

      // A subscription answers with the id `unsubscribe` takes, and says whether
      // the caller's cursor could be answered.
      const subscribed = await tunnel.request("subscribe", { taskId: "task-1" }, "sub-1");
      expect(subscribed.ok).toBe(true);
      const subscriptionId = (subscribed.result as { subscriptionId?: string }).subscriptionId;
      expect(typeof subscriptionId).toBe("string");

      const again = await tunnel.request("subscribe", { taskId: "task-1", from: "beginning" }, "sub-2");
      expect(again.ok).toBe(true);

      const unsubscribed = await tunnel.request("unsubscribe", { subscriptionId }, "unsub-1");
      expect(unsubscribed.ok).toBe(true);

      // `abort` distinguishes "no such task" from "nothing running", because the
      // remedy differs: the first is a typo, the second is `tavi cancel`.
      const missing = await tunnel.request("abort", { taskId: "task-nope" }, "abort-1");
      expect(missing.ok).toBe(false);
      expect(missing.error?.code).toBe("NOT_FOUND");

      const idle = await tunnel.request("abort", { taskId: "task-1" }, "abort-2");
      expect(idle.ok).toBe(false);
      expect(idle.error?.code).toBe("NOT_RUNNING");
      expect(idle.error?.message).toContain("tavi cancel");
    } finally {
      tunnel.close();
    }
    await handle.shutdown("test complete");
  });

  it("reports the shutdown outcome and stops when a client asks it to", async () => {
    const directory = directories.create();
    const handle = await startServe(directory);
    const owner = await findLiveOwner(directory);
    if (owner === undefined) throw new Error("serve did not publish discovery");
    const tunnel = await createIpcClient(owner);
    const response = await tunnel.request("shutdown", { reason: "operator request" }, "r1");
    expect(response.ok).toBe(true);
    tunnel.close();

    // The caller learns whether the drain was clean, because the exit code is
    // derived from it.
    const outcome = await handle.stopped;
    expect(outcome.clean).toBe(true);
    expect(readDiscovery(directory)).toBeUndefined();
  });

  it("stops for a confirmed reset-instance and says the stop was a reset", async () => {
    const directory = directories.create();
    const handle = await startServe(directory);
    const owner = await findLiveOwner(directory);
    if (owner === undefined) throw new Error("serve did not publish discovery");
    const tunnel = await createIpcClient(owner);
    // Without the typed word it is refused before the dispatcher, and the owner keeps running.
    const unconfirmed = await tunnel.request("reset-instance", { confirm: "yes" }, "r0");
    expect(unconfirmed.error?.code).toBe("INVALID_INPUT");
    const response = await tunnel.request("reset-instance", { confirm: "reset" }, "r1");
    expect(response.result).toEqual({ resetting: true });
    tunnel.close();

    const outcome = await handle.stopped;
    expect(outcome).toMatchObject({ clean: true, reset: true });
    // The owner only stops; `serveCommand` deletes once ownership is released.
    expect(existsSync(join(directory, "tavi.sqlite"))).toBe(true);
  });
});

describe("tavi serve through the CLI", () => {
  it("deletes the data directory's state on reset-instance and serves again on the empty directory", async () => {
    const directory = directories.create();
    const captured = capture();
    const served = main(["serve", "--data-dir", directory], { io: captured.io });
    const ownerOf = async (other?: string) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const found = await findLiveOwner(directory);
        if (found !== undefined && found.sessionId !== other) return found;
        await delay(50);
      }
      throw new Error(`no owner: ${captured.stderr()}`);
    };
    const first = await ownerOf();
    mkdirSync(join(directory, "artifacts", "default"), { recursive: true });
    writeFileSync(join(directory, "artifacts", "default", "art-1.bin"), "old");
    writeFileSync(join(directory, "notes.txt"), "mine");
    const tunnel = await createIpcClient(first);
    expect((await tunnel.request("reset-instance", { confirm: "reset" }, "r1")).ok).toBe(true);
    tunnel.close();

    const second = await ownerOf(first.sessionId);
    expect(existsSync(join(directory, "artifacts", "default", "art-1.bin"))).toBe(false);
    expect(existsSync(join(directory, "notes.txt"))).toBe(true);
    expect(captured.stderr()).toContain("left in place (not tavi's): notes.txt");
    const again = await createIpcClient(second);
    expect((await again.request("shutdown", { reason: "test complete" }, "r2")).ok).toBe(true);
    again.close();
    expect(await served).toBe(EXIT.ok);
  });

  it("lets a chat's own model choice stand under an owner started with --connection and --model", async () => {
    const directory = directories.create();
    const offline = capture();
    expect(
      await main(
        ["models", "add", "c1", "--base-url", "http://127.0.0.1:1/v1", "--model", "m1", "--credential", "c1", "--data-dir", directory],
        { io: offline.io },
      ),
      offline.stderr(),
    ).toBe(EXIT.ok);
    const captured = capture();
    const served = main(["serve", "--data-dir", directory, "--connection", "c1", "--model", "m1"], { io: captured.io });
    let owner = await findLiveOwner(directory);
    for (let attempt = 0; owner === undefined && attempt < 200; attempt += 1) {
      await delay(50);
      owner = await findLiveOwner(directory);
    }
    if (owner === undefined) throw new Error(`no owner: ${captured.stderr()}`);
    const client = await createIpcClient(owner);
    try {
      const first = await requestWithSubscription(
        client,
        "run",
        { workspaceId: "default", principal: "operator", approval: "client", prompt: "hi", operationKey: "pinned-1" },
        "run-1",
      );
      expect(first.response.ok, JSON.stringify(first.response.error)).toBe(true);
      const { taskId } = first.response.result as { taskId: string };
      for (let attempt = 0; !ended(first.events) && attempt < 200; attempt += 1) await delay(50);
      expect(ended(first.events)).toBe(true);
      const chosen = await client.request("models", { action: "set-chat", taskId, connectionId: "c1", model: "m2" }, "set-chat");
      expect(chosen.ok, JSON.stringify(chosen.error)).toBe(true);
      // The chat's next turn is admitted on its own choice: the owner's flags pick new chats' model, not this one's.
      const reply = await client.request(
        "reply",
        { workspaceId: "default", conversationId: "pinned-1", text: "again", clientMessageId: "again-1" },
        "reply",
      );
      expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
      const admissions = async (): Promise<readonly { readonly kind: string }[]> =>
        ((await client.request("tasks", { taskId }, `record-${Date.now()}`)).result as { admissions: { kind: string }[] }).admissions;
      for (let attempt = 0; (await admissions()).length < 2 && attempt < 100; attempt += 1) await delay(50);
      expect((await admissions()).map((admission) => admission.kind)).toEqual(["start", "reply"]);
      expect((await client.request("models", { action: "chat", taskId }, "chat-model")).result).toMatchObject({
        target: { connectionId: "c1", model: "m2" },
      });
    } finally {
      await client.request("shutdown", { reason: "test complete" }, "stop").catch(() => undefined);
      client.close();
    }
    expect(await served).toBe(EXIT.ok);
  });

  it("says a second owner is refused because the directory is owned, not as a model problem (exit 5)", async () => {
    const directory = directories.create();
    const captured = capture();
    const served = main(["serve", "--data-dir", directory], { io: captured.io });
    let owner = await findLiveOwner(directory);
    for (let attempt = 0; owner === undefined && attempt < 200; attempt += 1) {
      await delay(50);
      owner = await findLiveOwner(directory);
    }
    if (owner === undefined) throw new Error(`no owner: ${captured.stderr()}`);
    const second = capture();
    expect(await main(["serve", "--data-dir", directory], { io: second.io })).toBe(EXIT.alreadyOwned);
    // The owner holding it is named, as every command that needs the directory to itself names it.
    expect(second.stderr()).toMatch(/^`tavi serve` \(pid \d+\) already owns .*\. Stop it first/);
    expect(second.stderr()).not.toContain("could not resolve the model target");
    const client = await createIpcClient(owner);
    expect((await client.request("shutdown", { reason: "test complete" }, "stop")).ok).toBe(true);
    client.close();
    expect(await served).toBe(EXIT.ok);
  });

  it("logs an unhandled rejection through the owner logger, then drains, releases ownership and exits non-zero", async () => {
    const directory = directories.create();
    const captured = capture();
    const served = main(["serve", "--data-dir", directory], { io: captured.io });
    let owner = await findLiveOwner(directory);
    for (let attempt = 0; owner === undefined && attempt < 200; attempt += 1) {
      await delay(50);
      owner = await findLiveOwner(directory);
    }
    if (owner === undefined) throw new Error(`no owner: ${captured.stderr()}`);
    // Only the owner's handler sees this one: the test runner's own would fail the run.
    const runners = process.listeners("unhandledRejection").slice(0, -1);
    for (const listener of runners) process.removeListener("unhandledRejection", listener);
    try {
      process.emit("unhandledRejection", new Error("a stray rejection"), Promise.resolve());
    } finally {
      for (const listener of runners) process.on("unhandledRejection", listener);
    }
    expect(await served).toBe(EXIT.internal);
    expect(await findLiveOwner(directory)).toBeUndefined();
    expect(readFileSync(join(directory, "logs", "tavi.log"), "utf8")).toMatch(
      /an unhandled rejection stopped the owner.*a stray rejection/,
    );
    expect(process.listeners("unhandledRejection")).toEqual(runners);
  });

  it("says a fault during startup on stderr with its stack, sets exit code 70, and still releases ownership", {
    timeout: 20_000,
  }, async () => {
    const directory = directories.create();
    const captured = capture();
    const before = process.listeners("unhandledRejection").length;
    const previousExitCode = process.exitCode;
    const served = main(["serve", "--data-dir", directory], { io: captured.io });
    // The owner's handler is installed before composition begins; the fault lands while the owner starts. A slow
    // start (a loaded machine, a cold import) takes longer to get there: a fault emitted before it would miss it.
    await vi.waitFor(
      () =>
        expect(
          process.listeners("unhandledRejection").length,
          `the owner's rejection handler; serve said: ${captured.stderr()}`,
        ).toBeGreaterThan(before),
      {
        timeout: 10_000,
        interval: 5,
      },
    );
    const runners = process.listeners("unhandledRejection").slice(0, -1);
    for (const listener of runners) process.removeListener("unhandledRejection", listener);
    try {
      process.emit("unhandledRejection", new Error("a stray rejection at startup"), Promise.resolve());
    } finally {
      for (const listener of runners) process.on("unhandledRejection", listener);
    }
    try {
      expect(process.exitCode).toBe(EXIT.internal);
      expect(await served).toBe(EXIT.internal);
      expect(captured.stderr()).toMatch(
        /tavi serve: an unhandled rejection: a stray rejection at startup\nError: a stray rejection at startup\n\s+at /,
      );
      expect(await findLiveOwner(directory)).toBeUndefined();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("validates the drain deadline option", async () => {
    const captured = capture();
    expect(await main(["serve", "--drain-deadline", "-5"], { io: captured.io })).toBe(EXIT.usage);
    expect(captured.stderr()).toContain("non-negative integer");
  });

  it("is discoverable in the help text, including its platform qualification", async () => {
    const captured = capture();
    await main(["--help"], { io: captured.io });
    expect(captured.stdout()).toContain("tavi serve");
    // The platform limit must be where an operator looks for it: serving is
    // refused on Windows.
    expect(captured.stdout()).toContain("qualified on macOS and Linux only");
    expect(captured.stdout()).toContain("$TAVI_DATA_DIR");
  });
});
