import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  RoutineCreateSchema,
  TaviError,
  routineDefaults,
  type ChatFolderRow,
  type ModelPort,
  type InvocationContext,
  type RoutinesPayload,
  type SandboxCommand,
  type SandboxPolicy,
  type WriteChatFolderInput,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { createFixtureSandbox } from "@tavi/test-support/sandbox";
import { AsyncCheckpointSaver } from "@tavi/agent-host/checkpoint";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { z } from "zod";
import {
  ChatFolders,
  FolderSpace,
  RoutineControlService,
  ToolRegistry,
  acquireDataDirectoryOwnership,
  type ChatFolderTask,
} from "@tavi/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { messagingProfileRules } from "../../src/runtime/messaging-rules.js";
import { folderCommand } from "../../src/features/folders/owner.js";
import { folderReadScope, registerFsTools } from "../../src/features/folders/fs-tools.js";
import { EXIT, main } from "../../src/main.js";
import { registerSandboxTools, type SandboxToolOptions } from "../../src/features/sandbox/tools.js";
import { executeRoutineWorkflow, type RoutineFolderPinner } from "../../src/features/routines/workflow.js";
import { EPOCH_FLUSH_ATTEMPT_NUMBER, buildEpochRolloverFold } from "@tavi/agent-host/workflow";
import { capture, waitFor, temporaryDirectories } from "@tavi/test-support";
import { refuseBridgeRoutineFolder } from "../../src/server/serve.js";
import { SqliteStore } from "../support/database-fixture.js";
import { executionFixture, routineFixture } from "../routines/routine-fixture.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Messaging turns, fires and retention in the working folder: a turn held to a messaging channel sees the
 * managed folder only, whatever `--messaging-allow-tool` lets through; a
 * schedule's fire and a routine's run work in their own folder or a pinned
 * one checked at creation and at each fire; the budget and the free-space
 * floor refuse writes and shell runs; `.tmp/` is emptied when a turn ends;
 * and `tavi tasks folders prune` moves old runs' folders into the trash.
 */

const AT = "2026-10-10T00:00:00.000Z";
const scope = { workspaceId: "default", principalId: "operator" };
const local = { frontEnd: "local" } as const;

const cleanups: (() => Promise<void> | void)[] = [];
const directories = temporaryDirectories();
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  directories.cleanup();
});

/** A fresh directory, as the filesystem spells it (`/var` is `/private/var` on macOS). */
function directory(prefix = "tavi-w6-"): string {
  return realpathSync(directories.create(prefix));
}

/** An owner's layout: a data directory, a fake `$HOME`, an `--fs-root` with a project in it, and another with a library. */
function layout() {
  const base = directory();
  const data = join(base, "data");
  const home = join(base, "home");
  const root = join(base, "root");
  const project = join(root, "project");
  const lib = join(base, "other", "lib");
  for (const path of [data, home, project, lib]) mkdirSync(path, { recursive: true });
  writeFileSync(join(project, "plan.md"), "the plan");
  writeFileSync(join(lib, "secret.txt"), "attached, not for a channel");
  return { base, data, home, root, project, lib };
}

/** `ChatFolders` over in-memory tasks and rows, with a compare-and-set as the store's. */
function chatFolders(data: string, home: string, roots: readonly string[]) {
  const tasks = new Map<string, ChatFolderTask>();
  const rows = new Map<string, ChatFolderRow>();
  const service = new ChatFolders({
    dataDirectory: data,
    fsRoots: roots,
    homeDirectory: home,
    repository: {
      get: (taskId) => rows.get(taskId),
      revision: (taskId) => rows.get(taskId)?.revision ?? 0,
      write: (input: WriteChatFolderInput): ChatFolderRow => {
        const current = rows.get(input.taskId)?.revision ?? 0;
        if (current !== input.expectedRevision) throw new TaviError("CONFLICT", "changed");
        const row: ChatFolderRow = {
          taskId: input.taskId,
          workspaceId: input.workspaceId,
          primaryKind: input.primaryKind,
          ...(input.primaryPath === undefined ? {} : { primaryPath: input.primaryPath }),
          attachments: [...input.attachments],
          revision: current + 1,
          updatedAt: input.now,
        };
        rows.set(input.taskId, row);
        return row;
      },
    },
    tasks: { get: (taskId) => tasks.get(taskId) },
    agentDelegations: { getByWorkerTaskId: () => undefined },
    now: () => AT,
  });
  const task = (taskId: string, fields: Partial<ChatFolderTask> = {}): void => {
    tasks.set(taskId, { taskId, workspaceId: "default", principalId: "operator", origin: "ipc", ...fields });
  };
  return { service, task, tasks };
}

function contextIn(folder: InvocationContext["folder"], runId: string): InvocationContext {
  return { workspaceId: "default", principalId: "operator", runId, caller: "test", ...(folder === undefined ? {} : { folder }) };
}

/** The file tools and the shell, the shell's policies kept for the test to read. */
function tools(data: string, home: string, roots: readonly string[], space?: FolderSpace) {
  const registry = new ToolRegistry();
  registerFsTools(registry, { dataDirectory: data, ...(space === undefined ? {} : { space }) });
  const fixture = createFixtureSandbox({ mode: "echo" });
  const seen: { policy: SandboxPolicy; command: SandboxCommand }[] = [];
  const options: SandboxToolOptions = {
    dataDirectory: data,
    fsRoots: roots,
    homeDirectory: home,
    ownerEnv: { PATH: "/usr/bin:/bin" },
    gitIdentity: () => ({ name: "Owner", email: "owner@example.com" }),
    ...(space === undefined ? {} : { space }),
  };
  registerSandboxTools(
    registry,
    { ...fixture, run: (policy, command) => (seen.push({ policy, command }), fixture.run(policy, command)) },
    options,
  );
  const call = async (id: string, input: unknown, context: InvocationContext) =>
    registry.get(id)!.handler({ input, context, signal: new AbortController().signal });
  const assess = (id: string, input: unknown, context: InvocationContext) => registry.get(id)!.assess!(input, context);
  return { call, assess, seen };
}

describe("a turn held to a messaging channel (I-messaging)", () => {
  async function dmIntoHome() {
    const owner = layout();
    const { service, task } = chatFolders(owner.data, owner.home, [owner.root, join(owner.base, "other")]);
    task("home", { chatKind: "home" });
    await service.set(scope, "home", { kind: "attach", path: owner.lib, mode: "rw" }, local);
    const terminal = await service.resolve(scope, "home");
    const held = await service.resolve(scope, "home", { heldChannel: "messaging" });
    return { ...owner, service, terminal, held };
  }

  it("cannot read a Home's attachments with fs.*, sandbox.run or the folder's files, and writes only its managed folder", async () => {
    const { data, home, root, lib, project, service, terminal, held } = await dmIntoHome();
    expect(terminal.attachments.map((attachment) => attachment.path)).toEqual([root, lib]);
    expect(held).toMatchObject({ primary: held.managed, primaryKind: "managed", attachments: [] });
    const { call, seen } = tools(data, home, [root]);
    // The terminal's turn reads the attachment; the channel's does not.
    expect(await call("fs.read", { path: join(lib, "secret.txt") }, contextIn(terminal, "home"))).toMatchObject({
      content: "attached, not for a channel",
    });
    await expect(call("fs.read", { path: join(lib, "secret.txt") }, contextIn(held, "home"))).rejects.toThrow();
    await expect(call("fs.list", { path: project }, contextIn(held, "home"))).rejects.toThrow();
    await expect(call("fs.grep", { pattern: "attached", path: root }, contextIn(held, "home"))).rejects.toThrow();
    expect(await call("fs.write", { path: "reply.md", content: "drafted" }, contextIn(held, "home"))).toMatchObject({ bytes: 7 });
    expect(readFileSync(join(held.managed, "reply.md"), "utf8")).toBe("drafted");
    // The shell: writes the managed folder alone, reads no attachment, and cannot run in one.
    await call("sandbox.run", { command: "ls" }, contextIn(held, "home"));
    expect(seen[0]?.policy.filesystem.allowWrite).toEqual([held.managed]);
    // …but not its downloads/: what is read there is the browser's download, never the shell's words.
    expect(seen[0]?.policy.filesystem.denyWrite).toEqual(expect.arrayContaining([join(held.managed, "downloads")]));
    expect(seen[0]?.policy.filesystem.allowRead ?? []).not.toEqual(expect.arrayContaining([lib]));
    expect(seen[0]?.policy.filesystem.allowRead ?? []).not.toEqual(expect.arrayContaining([root]));
    expect(seen[0]?.policy.filesystem.denyRead).toEqual(expect.arrayContaining([root]));
    await expect(call("sandbox.run", { command: "ls", cwd: lib }, contextIn(held, "home"))).rejects.toThrow();
    // What the folder's file listing and download reach for that folder: no attachment.
    const reads = folderReadScope({ dataDirectory: data })(held);
    expect(() => reads.resolve(join(lib, "secret.txt"))).toThrow();
    const listed = await folderCommand(
      {
        folders: {
          ...service,
          resolve: async () => held,
          set: service.set.bind(service),
          managedFolderPath: service.managedFolderPath.bind(service),
          revisionOf: service.revisionOf.bind(service),
          attachableRoots: () => [],
          refusalOf: () => undefined,
        },
        repositories: { tasks: { get: async () => ({ taskId: "home", workspaceId: "default", principalId: "operator" }) } } as never,
        principalOf: () => "operator",
        frontEnd: "ipc",
        readScope: folderReadScope({ dataDirectory: data }),
      },
      { action: "files", taskId: "home", root: "attachment:lib" },
    );
    expect(listed).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    // Downloads and reports a channel's turn approves are copied into that same managed folder.
    expect(await service.managedFolderOf("default", "home")).toBe(held.managed);
  });

  it("sees only the managed folder where --messaging-allow-tool lifts the profile's deny", async () => {
    const { data, home, root, lib, held } = await dmIntoHome();
    const lifted = messagingProfileRules(["fs.write", "fs.edit", "sandbox.run"]).map((rule) => rule.toolPattern);
    expect(lifted).not.toEqual(expect.arrayContaining(["fs.write", "fs.edit", "sandbox.run"]));
    expect(messagingProfileRules([]).map((rule) => rule.toolPattern)).toEqual(
      expect.arrayContaining(["fs.write", "fs.edit", "sandbox.run"]),
    );
    // Allowed past the profile, the tools still confine the call to the held turn's folder.
    const { call, assess, seen } = tools(data, home, [root]);
    expect(assess("fs.write", { path: join(lib, "planted.txt"), content: "x" }, contextIn(held, "home")).hardDeny).toBeDefined();
    await expect(call("fs.write", { path: join(lib, "planted.txt"), content: "x" }, contextIn(held, "home"))).rejects.toThrow();
    await expect(
      call("fs.edit", { path: join(lib, "secret.txt"), oldText: "attached", newText: "changed" }, contextIn(held, "home")),
    ).rejects.toThrow();
    expect(existsSync(join(lib, "planted.txt"))).toBe(false);
    expect(readFileSync(join(lib, "secret.txt"), "utf8")).toBe("attached, not for a channel");
    await call("sandbox.run", { command: "touch", args: ["x"] }, contextIn(held, "home"));
    expect(seen[0]?.policy.filesystem.allowWrite).toEqual([held.managed]);
  });
});

describe("a schedule's fire", () => {
  it("works in its own managed folder: an --allow fs.write or sandbox.run writes only there", async () => {
    const { data, home, root, project } = layout();
    const { service, task } = chatFolders(data, home, [root]);
    task("fire-1", { origin: "schedule", chatKind: "run" });
    task("fire-2", { origin: "schedule", chatKind: "run" });
    const first = await service.resolve(scope, "fire-1");
    const second = await service.resolve(scope, "fire-2");
    expect(first).toMatchObject({ primary: first.managed, attachments: [] });
    expect(second.managed).not.toBe(first.managed);
    // A call `--allow` lets through without a round reaches the same confinement at dispatch.
    const { call, seen } = tools(data, home, [root]);
    expect(await call("fs.write", { path: "report.md", content: "fired" }, contextIn(first, "fire-1"))).toMatchObject({
      path: "report.md",
    });
    expect(readFileSync(join(first.managed, "report.md"), "utf8")).toBe("fired");
    await expect(
      call("fs.write", { path: join(project, "plan.md"), content: "overwritten" }, contextIn(first, "fire-1")),
    ).rejects.toThrow();
    expect(readFileSync(join(project, "plan.md"), "utf8")).toBe("the plan");
    // Nor does one fire reach another's folder.
    await expect(call("fs.read", { path: join(first.managed, "report.md") }, contextIn(second, "fire-2"))).rejects.toThrow();
    await call("sandbox.run", { command: "touch", args: ["out.txt"] }, contextIn(first, "fire-1"));
    expect(seen[0]?.policy.filesystem.allowWrite).toEqual([first.managed]);
    expect(seen[0]?.command.cwd).toBe(first.managed);
  });
});

describe("a routine's pinned folder", () => {
  /** The owner's routine control, with the store side stubbed to record what it was sent. */
  function control(checkFolder?: (path: string) => string) {
    const sent: RoutinesPayload[] = [];
    const routines = {
      call: async (_operation: string, input: { readonly payload: RoutinesPayload }) => (sent.push(input.payload), { ok: true }),
    };
    const service = new RoutineControlService({
      routines: routines as never,
      runs: {} as never,
      news: {} as never,
      delivery: {} as never,
      publication: {} as never,
      defaultModels: () => undefined,
      allowedHosts: [],
      wake: () => undefined,
      ...(checkFolder === undefined ? {} : { checkFolder }),
    });
    return { service, sent };
  }
  const create = (path: string): RoutinesPayload => ({
    action: "create",
    workspaceId: "default",
    principalId: "operator",
    create: { folder: { path } } as never,
  });

  it("is checked against the --fs-root set when the routine is created or updated, and stored as its real path", async () => {
    const { data, home, root, project, base } = layout();
    const { service: folders } = chatFolders(data, home, [root]);
    const { service, sent } = control((path) => folders.checkPrimary(path));
    await expect(service.execute(create(base))).rejects.toThrow(/is not under an --fs-root/);
    await expect(service.execute(create(join(data, "chats")))).rejects.toThrow(/inside the tavi data directory/);
    await expect(service.execute(create(join(root, "gone")))).rejects.toThrow(/does not exist/);
    expect(sent).toEqual([]);
    // A link is taken where it resolves.
    symlinkSync(base, join(root, "escape"));
    await expect(service.execute(create(join(root, "escape")))).rejects.toThrow(/is not under an --fs-root/);
    symlinkSync(project, join(base, "alias"));
    await service.execute(create(join(base, "alias")));
    expect(sent[0]?.create?.folder).toEqual({ path: project });
    await service.execute({
      action: "update",
      workspaceId: "default",
      principalId: "operator",
      update: { snapshot: { folder: { path: project } } } as never,
    });
    expect(sent[1]?.update?.snapshot.folder).toEqual({ path: project });
    // Without a check (no owner), a folder is refused rather than stored unchecked.
    await expect(control().service.execute(create(project))).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    // A routine without one, and every other action, passes through unchanged.
    await service.execute({ action: "list", workspaceId: "default", principalId: "operator" });
    expect(sent[2]).toEqual({ action: "list", workspaceId: "default", principalId: "operator" });
  });

  it("is never named from the canvas (I-web): a create or a changed folder is refused, an unchanged one kept", async () => {
    const runtime = { routines: { get: async () => ({ revision: { snapshot: { folder: { path: "/work/app" } } } }) } } as never;
    await expect(refuseBridgeRoutineFolder(runtime, create("/work/app"))).rejects.toThrow(/canvas cannot name a host folder/);
    const update = (path: string): RoutinesPayload => ({
      action: "update",
      workspaceId: "default",
      principalId: "operator",
      update: { routineId: "r", snapshot: { folder: { path } } } as never,
    });
    await expect(refuseBridgeRoutineFolder(runtime, update("/work/app"))).resolves.toBeUndefined();
    await expect(refuseBridgeRoutineFolder(runtime, update("/elsewhere"))).rejects.toThrow(/canvas cannot name a host folder/);
    await expect(
      refuseBridgeRoutineFolder(runtime, { action: "list", workspaceId: "default", principalId: "operator" }),
    ).resolves.toBeUndefined();
  });
});

describe("a routine's fire", () => {
  it("works in its pinned folder, checked again at the fire: one that no longer passes fails the run, naming why, before it starts", async () => {
    const owner = layout();
    const store = await SqliteStore.open({ databasePath: join(owner.data, "tavi.sqlite") });
    cleanups.push(async () => void (await store.close()));
    const routines = await routineFixture(store, { executionAvailable: true });
    const database = routines.store;
    const p = database.asPort().repositories;
    const folders = new ChatFolders({
      dataDirectory: owner.data,
      fsRoots: [owner.root],
      homeDirectory: owner.home,
      repository: p.taskFolders,
      tasks: p.tasks,
      agentDelegations: p.agentDelegations,
    });
    const pinner: { -readonly [K in keyof RoutineFolderPinner]: RoutineFolderPinner[K] } = {
      check: (path) => folders.checkPrimary(path),
      begin: async (pinScope, taskId, path) => void (await folders.begin(pinScope, taskId, path, local)),
    };
    const created = async (key: string, path: string) => {
      const detail = await routines.create(
        scope,
        RoutineCreateSchema.parse({
          ...routineDefaults("Europe/Sofia"),
          operationKey: key,
          name: key,
          objective: "Find news",
          agent: { agentId: "news", name: "News", instructions: "Find evidence" },
          triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
          skills: [],
          models: {
            research: { primary: { connectionId: "research", model: "r1" }, fallbacks: [] },
            synthesis: { primary: { connectionId: "summary", model: "s1" }, fallbacks: [] },
          },
          permissions: { revision: 1, researchTools: ["web_search"], allowedHosts: ["example.com"], networkMode: "allowlist" },
          folder: { path },
        }),
      );
      await routines.finishEvaluation(scope, detail.routine.routineId, 1, true, "pass");
      return detail.routine.routineId;
    };
    const runs = await executionFixture(routines, { ownerEpoch: "owner" });
    const registry = new ToolRegistry();
    registry.register({
      id: "web_search",
      sink: "search",
      version: "1.0.0",
      description: "Fixture search",
      effect: "read-only",
      requiredPermissions: [],
      inputSchema: z.strictObject({}),
      handler: async () => ({ title: "Release", url: "https://example.com/release" }),
    });
    let calls = 0;
    let rootCalls = 0;
    const model: ModelPort = {
      async stream(request) {
        calls += 1;
        const base = { attemptId: request.attemptId, usage: { totalTokens: 1 }, text: "", toolCalls: [], status: "completed" as const };
        if (request.connectionId !== "summary") return { ...base, text: "WORKER_EVIDENCE" };
        if (rootCalls++ === 0)
          return {
            ...base,
            toolCalls: [
              { id: "spawn", name: "agents.spawn", input: { agentDefinitionId: "news", input: "Find evidence", operationKey: "research" } },
            ],
          };
        return { ...base, text: "Summary" };
      },
    };
    const fire = async (routineId: string, key: string) => {
      const run = await runs.request(scope, routineId, key);
      const fence = (await runs.start(scope, run.runId))!;
      // As the pipeline records a fire that threw: failed, with its reason.
      return executeRoutineWorkflow(
        {
          checkpointSaver: new AsyncCheckpointSaver(database.checkpoints),
          models: model,
          tools: registry,
          connectionId: "wrong",
          model: "wrong",
          ownerSession: "owner",
          access: { resolveWorkspace: () => ({ principalId: "operator" }), missingPermissions: () => [] },
          tasks: p.tasks,
          promptSettings: p.systemPrompts,
          executions: p.executions,
          effects: p.effects,
          approvals: p.approvals,
          cancellations: p.cancellations,
          receipts: p.receipts,
          turnFolder: (invocation, turn) =>
            folders.resolve({ workspaceId: invocation.workspaceId, principalId: invocation.principalId }, invocation.runId, turn),
        },
        runs,
        run,
        fence,
        "Return a linked summary.",
        undefined,
        undefined,
        undefined,
        pinner,
      ).catch(async (error: unknown) => {
        await runs.finish(fence, "failed");
        throw error;
      });
    };
    const gone = join(owner.root, "gone");
    mkdirSync(gone);
    const refusedRoutine = await created("refused", gone);
    rmSync(gone, { recursive: true });
    await expect(fire(refusedRoutine, "manual-1")).rejects.toThrow(/This routine's folder .*gone cannot be used: .*does not exist/);
    expect(calls).toBe(0);
    // Gone between the fire's check and its task's admission: refused the same way, before the first turn.
    const racing = join(owner.root, "racing");
    mkdirSync(racing);
    const racingRoutine = await created("racing", racing);
    const check = pinner.check;
    pinner.check = (path) => {
      const real = check(path);
      rmSync(racing, { recursive: true });
      return real;
    };
    await expect(fire(racingRoutine, "manual-race")).rejects.toThrow(/This routine's folder .*racing cannot be used: .*does not exist/);
    pinner.check = check;
    expect(calls).toBe(0);

    const result = await fire(await created("pinned", owner.project), "manual-2");
    expect(result.outcome.status).toBe("completed");
    const resolved = await folders.resolve(scope, result.taskId);
    expect(resolved).toMatchObject({ primary: owner.project, primaryKind: "host", managed: folders.managedPath("default", result.taskId) });
    // Its research worker works in the run's folder too.
    const [worker] = await p.agentDelegations.listChildren("default", result.taskId, 10);
    expect((await folders.resolve(scope, worker!.workerTaskId)).primary).toBe(owner.project);
  });
});

describe("the budget and the free-space floor at the tools", () => {
  it("refuses fs.write into the managed folder and a new sandbox.run under the floor, and past the budget once .tmp/ is emptied", async () => {
    const { data, home, root } = layout();
    const { service, task } = chatFolders(data, home, [root]);
    task("chat");
    const folder = await service.resolve(scope, "chat");
    let free: number | undefined = 1024;
    const space = new FolderSpace({
      dataDirectory: data,
      folderCapBytes: 1_000,
      freeSpaceFloorBytes: 1024 * 1024,
      measureTtlMs: 0,
      freeBytes: () => free,
      freeBytesTtlMs: 0,
    });
    const { call, seen } = tools(data, home, [root], space);
    await expect(call("sandbox.run", { command: "ls" }, contextIn(folder, "chat"))).rejects.toThrow(/free-space-floor/);
    await expect(call("fs.write", { path: "a.txt", content: "a" }, contextIn(folder, "chat"))).rejects.toThrow(/free-space-floor/);
    expect(seen).toEqual([]);
    free = undefined;
    writeFileSync(join(folder.scratch, "scratch.bin"), "x".repeat(600));
    writeFileSync(join(folder.managed, "kept.bin"), "x".repeat(1_000));
    await expect(call("sandbox.run", { command: "ls" }, contextIn(folder, "chat"))).rejects.toThrow(
      /holds 1000 B, its whole 1000 B budget.*tavi tasks folders prune --chat chat/,
    );
    // `.tmp/` went first; what is left still fills the budget.
    expect(readdirSync(folder.scratch)).toEqual([]);
    await expect(call("fs.write", { path: "b.txt", content: "b" }, contextIn(folder, "chat"))).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });
    expect(seen).toEqual([]);
    rmSync(join(folder.managed, "kept.bin"));
    expect(await call("fs.write", { path: "b.txt", content: "b" }, contextIn(folder, "chat"))).toMatchObject({ bytes: 1 });
  });
});

describe("the budget across sandbox.run calls", () => {
  it("admits the next run against what the last one wrote, not a size measured before it", async () => {
    const { data, home, root } = layout();
    const { service, task } = chatFolders(data, home, [root]);
    task("chat");
    const folder = await service.resolve(scope, "chat");
    // Sizes are kept the default 30 s: only a run's end makes the next admission measure again.
    const space = new FolderSpace({ dataDirectory: data, folderCapBytes: 1_000, freeBytes: () => undefined });
    const fixture = createFixtureSandbox({ mode: "echo" });
    let runs = 0;
    const registry = new ToolRegistry();
    registerSandboxTools(
      registry,
      {
        ...fixture,
        run: (policy, command) => {
          runs += 1;
          // The command fills the chat's folder past its budget.
          writeFileSync(join(folder.managed, `out-${runs}.bin`), "x".repeat(1_000));
          return fixture.run(policy, command);
        },
      },
      {
        dataDirectory: data,
        fsRoots: [root],
        homeDirectory: home,
        ownerEnv: { PATH: "/usr/bin:/bin" },
        gitIdentity: () => ({ name: "Owner", email: "owner@example.com" }),
        space,
      },
    );
    const run = () =>
      registry
        .get("sandbox.run")!
        .handler({ input: { command: "make" }, context: contextIn(folder, "chat"), signal: new AbortController().signal });
    await run();
    await expect(run()).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
      message: expect.stringMatching(/holds 1000 B, its whole 1000 B budget/),
    });
    expect(runs).toBe(1);
  });
});

describe("the free-space floor where artifacts are stored", () => {
  it("refuses at the owner's artifact store, under the floor, every file for a person or the model, and still keeps a fold's archive and a thumbnail", async () => {
    const data = directory("tavi-w6-floor-");
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(data, {
        scheduleSweepEnabled: false,
        approvalRequiredFor: [],
        // No disk has this much free: the floor is always crossed.
        folderRetention: { freeSpaceFloorBytes: Number.MAX_SAFE_INTEGER },
      }),
      { modelOverride: createFixtureModel({ turns: [] }) },
    );
    cleanups.push(async () => void (await runtime.close()));
    const artifacts = runtime.store.asPort().repositories.artifacts;
    const refused = expect.objectContaining({
      code: "QUOTA_EXCEEDED",
      message: expect.stringMatching(/under its .* floor \(tavi serve --free-space-floor\): .*stored files/),
    });
    for (const put of [
      // A report, a download, a screenshot for the model, inbound media and an oversized tool result.
      {
        workspaceId: "default",
        contentType: "application/pdf",
        body: "%PDF-",
        extension: "pdf",
        reviewState: "approved",
        reviewedBy: "test",
        folderCopy: "reports",
        fileName: "brief.pdf",
      },
      {
        workspaceId: "default",
        contentType: "application/octet-stream",
        body: "a,b",
        extension: "csv",
        reviewState: "pending",
        folderCopy: "downloads",
        fileName: "table.csv",
      },
      { workspaceId: "default", contentType: "image/jpeg", body: "jpeg", extension: "jpg" },
      { workspaceId: "default", contentType: "image/png", body: "png", extension: "png", untrusted: true },
      { workspaceId: "default", contentType: "application/json", body: "{}", reviewState: "pending" },
    ] as const)
      await expect(artifacts.putArtifact(put), put.contentType).rejects.toEqual(refused);
    expect((await runtime.store.listArtifacts({ workspaceId: "default", limit: 10 })).rows).toEqual([]);
    // A conversation still folds, its archive kept: refusing it would free nothing and stop the chat compacting.
    const conversation = ["m1", "m2", "m3"].map((id) => ({ id, role: "user" as const, text: `message ${id}`, createdAt: AT }));
    const fold = await buildEpochRolloverFold(
      artifacts,
      { workspaceId: "default", principalId: "operator", runId: "chat-1", caller: "test" },
      conversation,
      ["m1", "m2"],
      (prefix) => `${prefix}-1`,
      () => AT,
    );
    expect(fold?.removeIds).toEqual(["m1", "m2"]);
    const archived = /art-[0-9a-f-]+/.exec(fold?.summary.text ?? "")?.[0];
    expect(archived, fold?.summary.text).toBeDefined();
    expect(JSON.parse(Buffer.from((await artifacts.readArtifactBody(archived!))!).toString("utf8"))).toHaveLength(2);
    // A browser session's thumbnail, the person's own view of the page, is kept too.
    expect(
      await artifacts.putArtifact({
        workspaceId: "default",
        contentType: "image/jpeg",
        body: "thumb",
        extension: "jpg",
        reviewState: "approved",
        purpose: "thumbnail",
      }),
    ).toMatchObject({ purpose: "thumbnail" });
  });
});

describe("a turn's end", () => {
  it("empties the chat's .tmp/ without following a link, keeps .home/, and warns once its folder crosses 80% of the budget", async () => {
    const data = directory("tavi-w6-turn-");
    const outside = directory("tavi-w6-outside-");
    writeFileSync(join(outside, "precious.txt"), "keep me");
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(data, { scheduleSweepEnabled: false, approvalRequiredFor: [], folderRetention: { folderCapBytes: 1_000 } }),
      {
        modelOverride: createFixtureModel({
          turns: [
            { toolCall: { id: "w1", name: "fs.write", input: { path: ".tmp/scratch.txt", content: "scratch" } } },
            { toolCall: { id: "w2", name: "fs.write", input: { path: ".home/cache.txt", content: "x".repeat(850) } } },
            { text: "one" },
            { text: "two" },
          ],
        }),
      },
    );
    cleanups.push(async () => void (await runtime.close()));
    const workflow = runtime.workflow!;
    const context = { workspaceId: "default", principalId: "operator", runId: "pending", caller: "test" };
    const first = await workflow.admit({ context, operationKey: "turn-1", kind: "start", prompt: "write scratch" });
    expect(first.outcome.status).toBe("completed");
    const managed = join(realpathSync(data), "chats", "default", first.taskId);
    // The turn wrote its scratch, and its end emptied it; `.home/` stays.
    expect(readdirSync(join(managed, ".tmp"))).toEqual([]);
    expect(readFileSync(join(managed, ".home", "cache.txt"), "utf8")).toHaveLength(850);
    // A link the shell left in scratch goes, never what it points at.
    symlinkSync(outside, join(managed, ".tmp", "to-outside"));
    const second = await workflow.admit({
      context: { ...context, runId: first.taskId },
      taskId: first.taskId,
      operationKey: "turn-2",
      kind: "reply",
      prompt: "again",
    });
    expect(second.outcome.status).toBe("completed");
    expect(readdirSync(join(managed, ".tmp"))).toEqual([]);
    expect(lstatSync(join(managed, ".tmp")).isDirectory()).toBe(true);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me");
    // 850 of 1000 bytes: the second turn found it past 80% and told the chat, once.
    const third = await workflow.admit({
      context: { ...context, runId: first.taskId },
      taskId: first.taskId,
      operationKey: "turn-3",
      kind: "reply",
      prompt: "and again",
    });
    expect(third.outcome.status).toBe("completed");
    // Posted off the turn's path, so it is waited for.
    const folderNotices = async () =>
      (await runtime.store.asPort().repositories.transcripts.notices(first.taskId, { limit: 20 })).filter(
        (notice) => notice.kind === "folder",
      );
    await waitFor(async () => (await folderNotices()).length > 0);
    const notices = await folderNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.summary).toMatch(/holds \d+ B of its 1000 B budget.*tavi tasks folders prune --chat /);
  });
});

describe("an epoch rollover", () => {
  it("empties the chat's .tmp/ when its conversation folds, before the turn's model call, and keeps .home/", async () => {
    const data = directory("tavi-w6-epoch-");
    const seen: { readonly scratch: readonly string[]; readonly home: readonly string[] }[] = [];
    let managed = "";
    const model: ModelPort = {
      async stream(request, options) {
        // What the chat's folder holds when the model is asked (the flush before a fold is a call of its own).
        if (managed !== "" && request.attemptNumber !== EPOCH_FLUSH_ATTEMPT_NUMBER)
          seen.push({ scratch: readdirSync(join(managed, ".tmp")), home: readdirSync(join(managed, ".home")) });
        const text = request.attemptNumber === EPOCH_FLUSH_ATTEMPT_NUMBER ? JSON.stringify({ memories: [] }) : "ok";
        options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: `b-${request.attemptId}`, text });
        return { status: "completed", attemptId: request.attemptId, text, toolCalls: [], usage: {} };
      },
    };
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(data, { scheduleSweepEnabled: false, approvalRequiredFor: [] }), {
      modelOverride: model,
    });
    cleanups.push(async () => void (await runtime.close()));
    const workflow = runtime.workflow!;
    const context = { workspaceId: "default", principalId: "operator", runId: "pending", caller: "test" };
    const first = await workflow.admit({ context, operationKey: "turn-1", kind: "start", prompt: "hello" });
    expect(first.outcome.status).toBe("completed");
    managed = join(realpathSync(data), "chats", "default", first.taskId);
    // Scratch a command left running past its turn wrote; a cache the chat keeps.
    writeFileSync(join(managed, ".tmp", "left.txt"), "scratch");
    writeFileSync(join(managed, ".home", "cache.txt"), "cache");
    const reply = { context: { ...context, runId: first.taskId }, taskId: first.taskId, kind: "reply" as const };
    // A message with no rollover finds the scratch still there: only a turn's end empties it.
    expect((await workflow.admit({ ...reply, operationKey: "turn-2", prompt: "again" })).outcome.status).toBe("completed");
    writeFileSync(join(managed, ".tmp", "left.txt"), "scratch");
    await runtime.requestFreshContext(first.taskId);
    expect((await workflow.admit({ ...reply, operationKey: "turn-3", prompt: "fresh" })).outcome.status).toBe("completed");
    expect(seen).toEqual([
      { scratch: ["left.txt"], home: ["cache.txt"] },
      { scratch: [], home: ["cache.txt"] },
    ]);
    expect(await runtime.store.asPort().repositories.transcripts.notices(first.taskId, { limit: 10 })).toEqual([
      expect.objectContaining({ kind: "epoch" }),
    ]);
  });
});

describe("the trash at the owner's start", () => {
  it("deletes what waited in chats/.trash/ seven days when an owner starts, and keeps what is younger", async () => {
    const data = directory("tavi-w6-trash-");
    const trash = join(data, "chats", ".trash");
    const stamp = (daysAgo: number) =>
      new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "");
    const old = join(trash, `task-old-${stamp(8)}`);
    const young = join(trash, `task-young-${stamp(1)}`);
    for (const folder of [old, young]) {
      mkdirSync(join(folder, "nested"), { recursive: true });
      writeFileSync(join(folder, "nested", "file.txt"), "x");
    }
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
      { requireModelTransport: false },
    );
    cleanups.push(async () => void (await runtime.close()));
    // Emptied off the start's path, so it is waited for.
    await waitFor(() => !existsSync(old));
    expect(readdirSync(trash)).toEqual([basename(young)]);
    expect(readFileSync(join(young, "nested", "file.txt"), "utf8")).toBe("x");
  });
});

describe("tavi tasks folders prune", () => {
  /** A data directory with an old run, a recent run, an old Home and one run with a turn waiting, and their folders. */
  async function seeded(sideOf?: string) {
    const data = directory("tavi-w6-prune-");
    const ownership = await acquireDataDirectoryOwnership({ dataDirectory: data, sessionId: `seed-${process.pid}` });
    const store = await SqliteStore.open({ databasePath: join(data, "tavi.sqlite"), artifactsDirectory: join(data, "artifacts") });
    const old = "2026-08-01T00:00:00.000Z";
    try {
      const insert = store.handle.prepare(
        "INSERT INTO tavi_tasks(task_id,workspace_id,principal_id,thread_id,checkpoint_namespace,status,created_at,updated_at,origin,chat_kind) VALUES(?,'default','operator',?,'',?,?,?,?,?)",
      );
      insert.run("fire-old", "thread-1", "completed", old, old, "schedule", "run");
      insert.run("fire-new", "thread-2", "completed", nowTimestamp(), nowTimestamp(), "schedule", "run");
      insert.run("fire-waiting", "thread-3", "waiting", old, old, "schedule", "run");
      insert.run("home", "thread-4", "completed", old, old, "ipc", "home");
      if (sideOf !== undefined)
        store.handle
          .prepare(
            "INSERT INTO tavi_tasks(task_id,workspace_id,principal_id,thread_id,checkpoint_namespace,status,created_at,updated_at,origin,chat_kind,parent_chat_id) VALUES('side-1','default','operator','thread-5','','completed',?,?,'ipc','side',?)",
          )
          .run(old, old, sideOf);
    } finally {
      await store.close();
      ownership.release();
    }
    const root = join(realpathSync(data), "chats", "default");
    for (const taskId of ["fire-old", "fire-new", "fire-waiting", "home"]) {
      mkdirSync(join(root, taskId, ".tmp"), { recursive: true });
      writeFileSync(join(root, taskId, "out.txt"), taskId);
    }
    return { data, root, trash: join(realpathSync(data), "chats", ".trash") };
  }

  it("prints its plan, moves nothing without --yes off a terminal or with --dry-run, and with --yes moves an old run's folder into the trash", async () => {
    const { data, root, trash } = await seeded();
    const refused = capture();
    expect(await main(["tasks", "folders", "prune", "--data-dir", data], { io: refused.io })).toBe(EXIT.usage);
    expect(refused.stdout()).toMatch(/To move to chats\/\.trash\/ \(deleted after 7 days\):\n {2}fire-old\trun\t/);
    expect(refused.stdout()).toMatch(/fire-waiting\ta turn is in progress/);
    expect(refused.stderr()).toMatch(/pass --yes/);
    const dry = capture(true);
    expect(await main(["tasks", "folders", "prune", "--dry-run", "--data-dir", data], { io: dry.io })).toBe(EXIT.ok);
    expect(dry.stdout()).toContain("Would move");
    expect(existsSync(trash)).toBe(false);
    for (const kept of ["fire-old", "fire-new", "fire-waiting", "home"]) expect(existsSync(join(root, kept, "out.txt"))).toBe(true);

    const done = capture();
    expect(await main(["tasks", "folders", "prune", "--yes", "--data-dir", data], { io: done.io }), done.stderr()).toBe(EXIT.ok);
    expect(done.stdout()).toMatch(/Moved fire-old's folder to .*chats\/\.trash\/fire-old-\d{8}T\d{6}Z/);
    expect(existsSync(join(root, "fire-old"))).toBe(false);
    const [moved] = readdirSync(trash);
    expect(readFileSync(join(trash, moved ?? "", "out.txt"), "utf8")).toBe("fire-old");
    // A Home is never taken by age, a recent run nor one with a turn in progress.
    for (const kept of ["fire-new", "fire-waiting", "home"]) expect(existsSync(join(root, kept, "out.txt"))).toBe(true);
  });

  it("clears a Home's folder only with --chat, and is refused while an owner holds the directory", async () => {
    const { data, root } = await seeded();
    const named = capture();
    expect(await main(["tasks", "folders", "prune", "--chat", "home", "--yes", "--data-dir", data], { io: named.io }), named.stderr()).toBe(
      EXIT.ok,
    );
    expect(existsSync(join(root, "home"))).toBe(false);
    const waiting = capture();
    expect(await main(["tasks", "folders", "prune", "--chat", "fire-waiting", "--yes", "--data-dir", data], { io: waiting.io })).toBe(
      EXIT.ok,
    );
    expect(waiting.stdout()).toMatch(/fire-waiting\ta turn is in progress/);
    expect(existsSync(join(root, "fire-waiting"))).toBe(true);
    const ownership = await acquireDataDirectoryOwnership({ dataDirectory: data, sessionId: `owner-${process.pid}` });
    try {
      const busy = capture();
      expect(await main(["tasks", "folders", "prune", "--yes", "--data-dir", data], { io: busy.io })).toBe(EXIT.alreadyOwned);
      expect(existsSync(join(root, "fire-old"))).toBe(true);
    } finally {
      ownership.release();
    }
  });

  it("never takes by age the folder of a run a side chat reads", async () => {
    const { data, root } = await seeded("fire-old");
    const done = capture();
    expect(await main(["tasks", "folders", "prune", "--yes", "--data-dir", data], { io: done.io }), done.stderr()).toBe(EXIT.ok);
    expect(done.stdout()).toContain("fire-old\ta side chat reads it (side-1): clear it with --chat fire-old\n");
    expect(existsSync(join(root, "fire-old", "out.txt"))).toBe(true);
  });

  it("parses its flags", async () => {
    const bad = capture();
    expect(await main(["tasks", "folders", "prune", "--older-than", "a week"], { io: bad.io })).toBe(EXIT.usage);
    expect(bad.stderr()).toMatch(/--older-than must be a whole number of days/);
    expect(await main(["tasks", "folders", "purge"], { io: capture().io })).toBe(EXIT.usage);
  });
});
