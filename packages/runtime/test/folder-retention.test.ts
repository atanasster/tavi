import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TaviError, type ArtifactRecord, type ChatFolder, type ChatKind, type TaskStatus } from "@tavi/contracts";
import {
  FolderSpace,
  applyFolderPrune,
  createArtifactMaterializer,
  emptyFolderTrash,
  emptyScratch,
  planFolderPrune,
  type FolderPruneDependencies,
  type FolderPruneTask,
} from "@tavi/runtime";
import { sha256Hex } from "@tavi/node-kit";
import { temporaryDirectories } from "@tavi/test-support";

/**
 * Folder retention: the budget
 * that warns at 80% and refuses at the cap once `.tmp/` is emptied, the
 * free-space floor, scratch emptied without following a link, and prune into
 * a seven-day trash.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-10T12:00:00.000Z");

const cleanup: (() => void)[] = [];
const directories = temporaryDirectories();
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
  directories.cleanup();
});

/** A scratch directory, real (macOS's `/var` is `/private/var`), removed after the test. */
function scratch(): string {
  return realpathSync(directories.create("tavi-folder-retention-"));
}

/** A chat's managed folder as the owner makes it, under `<data>/chats/default/<task-id>`. */
function managed(data: string, taskId: string): string {
  const path = join(data, "chats", "default", taskId);
  mkdirSync(join(path, ".tmp"), { recursive: true });
  mkdirSync(join(path, ".home"), { recursive: true });
  return path;
}

function folderOf(path: string): ChatFolder {
  return {
    primary: path,
    primaryKind: "managed",
    managed: path,
    scratch: join(path, ".tmp"),
    home: join(path, ".home"),
    attachments: [],
    revision: 0,
  };
}

const bytes = (count: number): string => "x".repeat(count);

describe("the folder budget", () => {
  it("forgets one folder's size without walking every chat's again: a run's end measures its own folder anew, the total within its 30 s", async () => {
    const data = scratch();
    const chat = managed(data, "task-a");
    const other = managed(data, "task-b");
    const space = new FolderSpace({ dataDirectory: data, folderCapBytes: 1_000_000, chatsCapBytes: 1_000_000, freeBytes: () => undefined });
    expect(await space.usage(chat)).toMatchObject({ bytes: 0, chatsBytes: 0 });
    writeFileSync(join(chat, "out.bin"), bytes(300));
    writeFileSync(join(other, "theirs.bin"), bytes(200));
    space.forgetFolder(chat);
    expect(await space.usage(chat)).toMatchObject({ bytes: 300, chatsBytes: 0 });
    // `forget` (a removal, a copy) takes the total again too.
    space.forget(chat);
    expect(await space.usage(chat)).toMatchObject({ bytes: 300, chatsBytes: 500 });
  });

  it("warns once when a folder crosses 80% of its cap, and again only after it fell back and crossed again", async () => {
    const data = scratch();
    const chat = managed(data, "task-a");
    const space = new FolderSpace({
      dataDirectory: data,
      folderCapBytes: 1_000,
      chatsCapBytes: 1_000_000,
      measureTtlMs: 0,
      freeBytes: () => undefined,
    });
    writeFileSync(join(chat, "notes.txt"), bytes(700));
    expect(await space.crossing(chat, "task-a")).toBeUndefined();
    // `.home/` counts toward the budget, as everything in the folder does.
    writeFileSync(join(chat, ".home", "cache.bin"), bytes(150));
    const warning = await space.crossing(chat, "task-a");
    expect(warning).toMatch(/holds 850 B of its 1000 B budget/);
    expect(warning).toContain("tavi tasks folders prune --chat task-a");
    // Not again on the next turn while it stays past 80%.
    expect(await space.crossing(chat, "task-a")).toBeUndefined();
    expect((await space.usage(chat)).warning).toBeDefined();
    rmSync(join(chat, "notes.txt"));
    expect(await space.crossing(chat, "task-a")).toBeUndefined();
    writeFileSync(join(chat, "notes.txt"), bytes(700));
    expect(await space.crossing(chat, "task-a")).toMatch(/of its 1000 B budget/);
  });

  it("at the cap empties .tmp/ first and admits the write when that was enough", async () => {
    const data = scratch();
    const chat = managed(data, "task-a");
    const space = new FolderSpace({ dataDirectory: data, folderCapBytes: 1_000, measureTtlMs: 60_000, freeBytes: () => undefined });
    writeFileSync(join(chat, "keep.txt"), bytes(400));
    writeFileSync(join(chat, ".tmp", "scratch.bin"), bytes(700));
    writeFileSync(join(chat, ".home", "kept.bin"), bytes(100));
    await space.admitRun(folderOf(chat), "task-a");
    await space.admitWrite(folderOf(chat), join(chat, "next.txt"), "task-a");
    expect(readdirSync(join(chat, ".tmp"))).toEqual([]);
    // `.home/` is kept.
    expect(readFileSync(join(chat, ".home", "kept.bin"), "utf8")).toHaveLength(100);
  });

  it("refuses writes into the managed folder and new runs once emptying .tmp/ is not enough, naming the size and the prune command", async () => {
    const data = scratch();
    const chat = managed(data, "task-a");
    const host = scratch();
    const space = new FolderSpace({ dataDirectory: data, folderCapBytes: 1_000, measureTtlMs: 60_000, freeBytes: () => undefined });
    writeFileSync(join(chat, "big.bin"), bytes(1_200));
    writeFileSync(join(chat, ".tmp", "scratch.bin"), bytes(10));
    const refused = space.admitRun(folderOf(chat), "task-a");
    await expect(refused).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await expect(refused).rejects.toThrow(
      /holds 1\.2 KB, its whole 1000 B budget \(tavi serve --folder-cap\).*tavi tasks folders prune --chat task-a/,
    );
    expect(readdirSync(join(chat, ".tmp"))).toEqual([]);
    await expect(space.admitWrite(folderOf(chat), join(chat, "more.txt"), "task-a")).rejects.toThrow(/its whole 1000 B budget/);
    // A host folder is the person's: no budget there.
    const withHost = { ...folderOf(chat), primary: host, primaryKind: "host" as const };
    await expect(space.admitWrite(withHost, join(host, "fine.txt"), "task-a")).resolves.toBeUndefined();
    // Room made again: admitted, once the size is taken again.
    rmSync(join(chat, "big.bin"));
    space.forget(chat);
    await expect(space.admitRun(folderOf(chat), "task-a")).resolves.toBeUndefined();
  });

  it("counts every chat's folder and the trash toward the total cap", async () => {
    const data = scratch();
    const mine = managed(data, "task-a");
    const theirs = managed(data, "task-b");
    mkdirSync(join(data, "chats", ".trash", "task-c-20261001T000000Z"), { recursive: true });
    writeFileSync(join(theirs, "data.bin"), bytes(500));
    writeFileSync(join(data, "chats", ".trash", "task-c-20261001T000000Z", "old.bin"), bytes(600));
    const space = new FolderSpace({
      dataDirectory: data,
      folderCapBytes: 10_000,
      chatsCapBytes: 1_000,
      measureTtlMs: 0,
      freeBytes: () => undefined,
    });
    expect((await space.usage(mine)).chatsBytes).toBe(1_100);
    await expect(space.admitRun(folderOf(mine))).rejects.toThrow(
      /Every chat's folder together holds 1\.1 KB, the whole 1000 B budget \(tavi serve --chats-cap\).*tavi tasks folders prune/,
    );
  });

  it("refuses under the free-space floor, and never on a free space it cannot read", async () => {
    const data = scratch();
    const chat = managed(data, "task-a");
    let free: number | undefined = 10 * 1024 * 1024;
    const space = new FolderSpace({ dataDirectory: data, freeSpaceFloorBytes: 64 * 1024 * 1024, freeBytes: () => free, freeBytesTtlMs: 0 });
    await expect(space.admitRun(folderOf(chat))).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await expect(space.admitRun(folderOf(chat))).rejects.toThrow(
      /Only 10 MB is free on the disk that holds the tavi data directory, under its 64 MB floor \(tavi serve --free-space-floor\).*tavi tasks folders prune/,
    );
    await expect(space.admitWrite(folderOf(chat), join(chat, "a.txt"))).rejects.toThrow(/under its 64 MB floor/);
    expect(() => space.checkFloor()).toThrow(TaviError);
    free = undefined;
    await expect(space.admitRun(folderOf(chat))).resolves.toBeUndefined();
    free = 128 * 1024 * 1024;
    await expect(space.admitWrite(folderOf(chat), join(chat, "a.txt"))).resolves.toBeUndefined();
  });

  it("reads the free space for the floor at most once a second, however many writes it admits", () => {
    const data = scratch();
    let now = 0;
    let reads = 0;
    const space = new FolderSpace({
      dataDirectory: data,
      freeSpaceFloorBytes: 64 * 1024 * 1024,
      freeBytes: () => ((reads += 1), 10 * 1024 * 1024),
      now: () => now,
    });
    for (let call = 0; call < 5; call += 1) expect(() => space.checkFloor()).toThrow(/stored files .*are refused/);
    expect(reads).toBe(1);
    now += 1_000;
    expect(() => space.checkFloor()).toThrow(/free-space-floor/);
    expect(reads).toBe(2);
  });

  it("never empties a chat's .tmp/ while a worker of the chat still runs in it: not at a turn's end, a rollover or the budget", async () => {
    const data = scratch();
    const chat = managed(data, "task-a");
    let running = true;
    const asked: string[] = [];
    const space = new FolderSpace({
      dataDirectory: data,
      folderCapBytes: 1_000,
      measureTtlMs: 0,
      freeBytes: () => undefined,
      scratchInUse: (folder) => {
        asked.push(folder);
        return running;
      },
    });
    writeFileSync(join(chat, ".tmp", "worker-build.bin"), bytes(600));
    writeFileSync(join(chat, "keep.txt"), bytes(500));
    await space.emptyScratch(chat);
    expect(readdirSync(join(chat, ".tmp"))).toEqual(["worker-build.bin"]);
    // At the budget the scratch is not emptied under the worker either: the write is refused instead.
    await expect(space.admitRun(folderOf(chat), "task-a")).rejects.toThrow(/its whole 1000 B budget/);
    expect(readdirSync(join(chat, ".tmp"))).toEqual(["worker-build.bin"]);
    expect(asked.every((folder) => folder === chat)).toBe(true);
    // Once the worker ends, it is emptied as before; one that cannot be told counts as running.
    running = false;
    await space.admitRun(folderOf(chat), "task-a");
    expect(readdirSync(join(chat, ".tmp"))).toEqual([]);
    writeFileSync(join(chat, ".tmp", "again.bin"), bytes(10));
    await new FolderSpace({
      dataDirectory: data,
      scratchInUse: () => {
        throw new Error("the store is closed");
      },
    }).emptyScratch(chat);
    expect(readdirSync(join(chat, ".tmp"))).toEqual(["again.bin"]);
  });

  it("copies no approved download into a folder past its budget: the copy fails, the approval stands", async () => {
    const data = scratch();
    const chat = managed(data, "task-a");
    const body = Buffer.from("a,b\n");
    const record = {
      artifactId: "art-0123456789",
      workspaceId: "default",
      runId: "task-a",
      reviewState: "approved",
      folderCopy: "downloads",
      fileName: "t.csv",
      relativePath: "x.csv",
      byteSize: body.byteLength,
      sha256: "b0a4c7c8f6a5e4ccf2d6d3b8f6c0a1f7c0a2a7d0f7b1c43a5b6a6cbd0c6de1d2",
    } as unknown as ArtifactRecord;
    const sha256 = sha256Hex(body);
    const materialize = createArtifactMaterializer({
      artifacts: { getArtifact: async () => ({ ...record, sha256 }), readArtifactBody: async () => body },
      folders: { managedFolderOf: async () => chat },
      space: {
        admitManagedWrite: async () => {
          throw new TaviError("QUOTA_EXCEEDED", "This chat's folder holds 2 GB, its whole budget");
        },
      },
    });
    expect(await materialize("art-0123456789")).toEqual({ status: "failed", reason: "This chat's folder holds 2 GB, its whole budget" });
    expect(existsSync(join(chat, "downloads"))).toBe(false);
    // Refused by the budget itself, the reason names the prune that clears this chat's folder.
    writeFileSync(join(chat, "kept.bin"), "x".repeat(1_000));
    const budgeted = createArtifactMaterializer({
      artifacts: { getArtifact: async () => ({ ...record, sha256 }), readArtifactBody: async () => body },
      folders: { managedFolderOf: async () => chat },
      space: new FolderSpace({ dataDirectory: data, folderCapBytes: 1_000, freeBytes: () => undefined }),
    });
    expect(await budgeted("art-0123456789")).toEqual({
      status: "failed",
      reason: expect.stringMatching(/its whole 1000 B budget .*clear it with `tavi tasks folders prune --chat task-a`/),
    });
    expect(existsSync(join(chat, "downloads"))).toBe(false);
  });
});

describe(".tmp/ emptied without following a link (I-nofollow)", () => {
  it("removes links the shell planted, never what they point at, and keeps .home/", async () => {
    const data = scratch();
    const chat = managed(data, "task-a");
    const outside = scratch();
    writeFileSync(join(outside, "precious.txt"), "keep me");
    mkdirSync(join(outside, "tree"));
    writeFileSync(join(outside, "tree", "deep.txt"), "keep me too");
    mkdirSync(join(chat, ".tmp", "nested", "deeper"), { recursive: true });
    writeFileSync(join(chat, ".tmp", "nested", "deeper", "f.txt"), "scratch");
    symlinkSync(outside, join(chat, ".tmp", "to-outside"));
    symlinkSync(join(outside, "precious.txt"), join(chat, ".tmp", "nested", "file-link"));
    symlinkSync(join(outside, "tree"), join(chat, ".tmp", "nested", "deeper", "dir-link"));
    writeFileSync(join(chat, ".home", ".cache"), "build cache");

    // A read-only folder a tool left in scratch goes too.
    mkdirSync(join(chat, ".tmp", "readonly", "inner"), { recursive: true });
    writeFileSync(join(chat, ".tmp", "readonly", "inner", "f.txt"), "x");
    chmodSync(join(chat, ".tmp", "readonly", "inner"), 0o555);
    chmodSync(join(chat, ".tmp", "readonly"), 0o555);

    expect(await emptyScratch(chat)).toEqual([]);

    expect(readdirSync(join(chat, ".tmp"))).toEqual([]);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me");
    expect(readFileSync(join(outside, "tree", "deep.txt"), "utf8")).toBe("keep me too");
    expect(readFileSync(join(chat, ".home", ".cache"), "utf8")).toBe("build cache");
  });

  it("removes read-only files, as Git leaves its packs (on Windows they cannot be deleted until made writable)", async () => {
    const data = scratch();
    const chat = managed(data, "task-a");
    const pack = join(chat, ".tmp", "repo", ".git", "objects", "pack");
    mkdirSync(pack, { recursive: true });
    for (const name of ["pack-1.pack", "pack-1.idx"]) {
      writeFileSync(join(pack, name), "git");
      chmodSync(join(pack, name), 0o444);
    }

    expect(await emptyScratch(chat)).toEqual([]);
    expect(readdirSync(join(chat, ".tmp"))).toEqual([]);
  });

  it("empties a folder the shell left with no permission bits at all (mode 000), and leaves a folder a link points at alone", async () => {
    const data = scratch();
    const chat = managed(data, "task-a");
    const outside = scratch();
    for (const mode of [0o000, 0o300, 0o100]) {
      const locked = join(chat, ".tmp", `locked-${mode.toString(8)}`);
      mkdirSync(locked);
      writeFileSync(join(locked, "f"), "scratch");
      chmodSync(locked, mode);
    }
    mkdirSync(join(outside, "theirs"));
    chmodSync(join(outside, "theirs"), 0o500);
    cleanup.push(() => chmodSync(join(outside, "theirs"), 0o700));
    symlinkSync(join(outside, "theirs"), join(chat, ".tmp", "to-theirs"));

    expect(await emptyScratch(chat)).toEqual([]);

    expect(readdirSync(join(chat, ".tmp"))).toEqual([]);
    expect(lstatSync(join(outside, "theirs")).mode & 0o777).toBe(0o500);
  });

  it("replaces a .tmp the shell swapped for a link with a plain folder, leaving the link's target alone", async () => {
    const data = scratch();
    const chat = managed(data, "task-a");
    const outside = scratch();
    writeFileSync(join(outside, "precious.txt"), "keep me");
    rmSync(join(chat, ".tmp"), { recursive: true });
    symlinkSync(outside, join(chat, ".tmp"));

    await emptyScratch(chat);

    expect(lstatSync(join(chat, ".tmp")).isDirectory()).toBe(true);
    expect(lstatSync(join(chat, ".tmp")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me");
  });
});

/** Prune's view of a store: tasks by id, which have a turn running, and which folder records cannot be read. */
function pruneDeps(
  data: string,
  tasks: readonly (Partial<FolderPruneTask> & { readonly taskId: string; readonly chatKind?: ChatKind })[],
  extra: {
    readonly running?: readonly string[];
    readonly unreadable?: readonly string[];
    readonly workers?: Readonly<Record<string, number>>;
    readonly sides?: Readonly<Record<string, readonly string[]>>;
  } = {},
): FolderPruneDependencies {
  const byId = new Map(
    tasks.map((task) => [
      task.taskId,
      { workspaceId: "default", status: "completed" as TaskStatus, updatedAt: new Date(NOW - 40 * DAY).toISOString(), ...task },
    ]),
  );
  return {
    dataDirectory: data,
    tasks: { get: (taskId) => byId.get(taskId), hasRunningAdmission: (taskId) => extra.running?.includes(taskId) === true },
    workersInProgress: (_workspaceId, taskId) => extra.workers?.[taskId] ?? 0,
    sideChats: (_workspaceId, taskId) => extra.sides?.[taskId] ?? [],
    folderRecord: (taskId) => {
      if (extra.unreadable?.includes(taskId) === true) throw new TaviError("INVALID_INPUT", "the stored folder does not parse");
      return undefined;
    },
    managedPath: (workspaceId, taskId) => join(data, "chats", workspaceId, taskId),
    chatOf: async (_workspaceId, taskId) => ({ taskId: taskId === "worker-1" ? "fire-old" : taskId, workspaceId: "default" }),
    now: () => NOW,
  };
}

describe("tavi tasks folders prune", () => {
  it("moves an old run's folder into the trash, leaves a recent one, a Home and a side chat, and skips one in progress or unreadable", async () => {
    const data = scratch();
    for (const taskId of ["fire-old", "fire-new", "fire-running", "fire-waiting", "fire-worker", "fire-broken", "home", "side"])
      writeFileSync(join(managed(data, taskId), "out.txt"), taskId);
    // A folder no chat is recorded for is left alone.
    managed(data, "stranger");
    const deps = pruneDeps(
      data,
      [
        { taskId: "fire-old", chatKind: "run" },
        { taskId: "fire-new", chatKind: "run", updatedAt: new Date(NOW - 2 * DAY).toISOString() },
        { taskId: "fire-running", chatKind: "run" },
        { taskId: "fire-waiting", chatKind: "run", status: "waiting" },
        // Settled itself, with a worker of its still working in its folder.
        { taskId: "fire-worker", chatKind: "run" },
        { taskId: "fire-broken", chatKind: "run" },
        { taskId: "home", chatKind: "home" },
        { taskId: "side", chatKind: "side" },
      ],
      { running: ["fire-running"], unreadable: ["fire-broken"], workers: { "fire-worker": 1 } },
    );

    const plan = await planFolderPrune(deps, { olderThanDays: 30 });
    expect(plan.folders.map((entry) => entry.taskId)).toEqual(["fire-old"]);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: "fire-running", reason: "a turn is in progress" }),
        expect.objectContaining({ taskId: "fire-waiting", reason: "a turn is in progress" }),
        expect.objectContaining({ taskId: "fire-worker", reason: "a turn is in progress" }),
        expect.objectContaining({
          taskId: "fire-broken",
          reason: expect.stringMatching(/configuration could not be read.*nothing of it is deleted/),
        }),
      ]),
    );
    // Planning moves nothing (--dry-run).
    expect(existsSync(join(data, "chats", "default", "fire-old"))).toBe(true);

    const result = await applyFolderPrune(deps, plan);
    expect(result.failed).toEqual([]);
    expect(result.moved).toEqual([
      {
        taskId: "fire-old",
        from: join(data, "chats", "default", "fire-old"),
        to: join(data, "chats", ".trash", "fire-old-20261010T120000Z"),
      },
    ]);
    expect(readFileSync(join(data, "chats", ".trash", "fire-old-20261010T120000Z", "out.txt"), "utf8")).toBe("fire-old");
    for (const kept of ["fire-new", "fire-running", "fire-waiting", "fire-worker", "fire-broken", "home", "side", "stranger"])
      expect(existsSync(join(data, "chats", "default", kept))).toBe(true);
  });

  it("clears a Home's folder only when named with --chat, a worker's as its chat's, and never one in progress", async () => {
    const data = scratch();
    writeFileSync(join(managed(data, "home"), "notes.md"), "home");
    managed(data, "fire-old");
    const deps = pruneDeps(data, [
      { taskId: "home", chatKind: "home", updatedAt: new Date(NOW - DAY).toISOString() },
      { taskId: "fire-old", chatKind: "run" },
      { taskId: "worker-1", chatKind: "worker" },
    ]);
    expect((await planFolderPrune(deps, { olderThanDays: 0 })).folders.map((entry) => entry.taskId)).toEqual(["fire-old"]);
    // Named, whatever its age — unless --older-than is given too.
    const named = await planFolderPrune(deps, { olderThanDays: 30, chat: { workspaceId: "default", taskId: "home" } });
    expect(named.folders.map((entry) => entry.taskId)).toEqual(["home"]);
    expect(
      (await planFolderPrune(deps, { olderThanDays: 30, olderThanGiven: true, chat: { workspaceId: "default", taskId: "home" } })).skipped,
    ).toEqual([expect.objectContaining({ taskId: "home", reason: "it was used within the last 30 days" })]);
    expect(
      (await planFolderPrune(deps, { olderThanDays: 30, chat: { workspaceId: "default", taskId: "worker-1" } })).folders.map(
        (entry) => entry.taskId,
      ),
    ).toEqual(["fire-old"]);
    const busy = pruneDeps(data, [{ taskId: "home", chatKind: "home", status: "running" }]);
    expect((await planFolderPrune(busy, { olderThanDays: 30, chat: { workspaceId: "default", taskId: "home" } })).folders).toEqual([]);
    await expect(planFolderPrune(deps, { olderThanDays: 30, chat: { workspaceId: "other", taskId: "home" } })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("never takes by age a folder a side chat reads, and with --chat only while no side chat of it has a turn in progress", async () => {
    const data = scratch();
    for (const taskId of ["fire-old", "fire-solo"]) managed(data, taskId);
    const tasks = [
      { taskId: "fire-old", chatKind: "run" as const },
      { taskId: "fire-solo", chatKind: "run" as const },
    ];
    const deps = pruneDeps(data, [...tasks, { taskId: "side-1", chatKind: "side" }], { sides: { "fire-old": ["side-1"] } });
    const plan = await planFolderPrune(deps, { olderThanDays: 30 });
    expect(plan.folders.map((entry) => entry.taskId)).toEqual(["fire-solo"]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ taskId: "fire-old", reason: "a side chat reads it (side-1): clear it with --chat fire-old" }),
    ]);
    expect(
      (await planFolderPrune(deps, { olderThanDays: 30, chat: { workspaceId: "default", taskId: "fire-old" } })).folders.map(
        (entry) => entry.taskId,
      ),
    ).toEqual(["fire-old"]);
    for (const busy of [
      pruneDeps(data, [...tasks, { taskId: "side-1", chatKind: "side", status: "running" }], { sides: { "fire-old": ["side-1"] } }),
      pruneDeps(data, [...tasks, { taskId: "side-1", chatKind: "side" }], { sides: { "fire-old": ["side-1"] }, workers: { "side-1": 1 } }),
    ]) {
      const named = await planFolderPrune(busy, { olderThanDays: 30, chat: { workspaceId: "default", taskId: "fire-old" } });
      expect(named.folders).toEqual([]);
      expect(named.skipped).toEqual([
        expect.objectContaining({ taskId: "fire-old", reason: "a side chat reading it (side-1) has a turn in progress" }),
      ]);
    }
  });

  it("empties what waited in the trash seven days, and nothing younger, never through a link", async () => {
    const data = scratch();
    const outside = scratch();
    writeFileSync(join(outside, "precious.txt"), "keep me");
    const trash = join(data, "chats", ".trash");
    mkdirSync(join(trash, "fire-a-20261001T000000Z"), { recursive: true });
    writeFileSync(join(trash, "fire-a-20261001T000000Z", "out.txt"), "old");
    symlinkSync(outside, join(trash, "fire-a-20261001T000000Z", "link"));
    mkdirSync(join(trash, "fire-b-20261008T000000Z"), { recursive: true });
    const removed = await emptyFolderTrash(data, NOW);
    expect(removed).toEqual({ removed: [join(trash, "fire-a-20261001T000000Z")], failed: [] });
    expect(readdirSync(trash)).toEqual(["fire-b-20261008T000000Z"]);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me");
    // Its eighth day: gone too.
    expect(await emptyFolderTrash(data, Date.parse("2026-10-15T00:00:00.000Z"))).toEqual({
      removed: [join(trash, "fire-b-20261008T000000Z")],
      failed: [],
    });
  });

  it("deletes read-only and unreadable folders left in a trash entry (Go's module cache, a mode-000 folder)", async () => {
    const data = scratch();
    const trash = join(data, "chats", ".trash");
    // As `go mod download` leaves `$HOME/go/pkg/mod`: folders and files without a write bit.
    const modcache = join(trash, "fire-a-20261001T000000Z", ".home", "go", "pkg", "mod", "example.com", "m@v1.0.0");
    mkdirSync(modcache, { recursive: true });
    writeFileSync(join(modcache, "go.mod"), "module example.com/m\n");
    chmodSync(join(modcache, "go.mod"), 0o444);
    for (const folder of [modcache, join(modcache, ".."), join(modcache, "..", "..")]) chmodSync(folder, 0o555);
    mkdirSync(join(trash, "fire-b-20261002T000000Z", "locked"), { recursive: true });
    writeFileSync(join(trash, "fire-b-20261002T000000Z", "locked", "f"), "x");
    // A folder with no permission bits at all, as a shell may leave one.
    chmodSync(join(trash, "fire-b-20261002T000000Z", "locked"), 0o000);
    expect(await emptyFolderTrash(data, NOW)).toEqual({
      removed: [join(trash, "fire-a-20261001T000000Z"), join(trash, "fire-b-20261002T000000Z")],
      failed: [],
    });
    expect(readdirSync(trash)).toEqual([]);
  });

  it.skipIf(process.platform !== "darwin")(
    "reports an entry it cannot delete, still deletes the others, and still reports what prune moved",
    async () => {
      const data = scratch();
      managed(data, "fire-old");
      const trash = join(data, "chats", ".trash");
      // A file its owner made immutable: no mode change lets it go.
      const pinned = join(trash, "fire-c-20261001T000000Z", "inner", "pinned.txt");
      mkdirSync(join(pinned, ".."), { recursive: true });
      writeFileSync(pinned, "x");
      execFileSync("chflags", ["uchg", pinned]);
      cleanup.push(() => execFileSync("chflags", ["nouchg", pinned]));
      mkdirSync(join(trash, "fire-d-20261002T000000Z"));
      const deps = pruneDeps(data, [{ taskId: "fire-old", chatKind: "run" }]);
      const result = await applyFolderPrune(deps, await planFolderPrune(deps, { olderThanDays: 30 }));
      expect(result.moved.map((entry) => entry.taskId)).toEqual(["fire-old"]);
      expect(result.removed).toEqual([join(trash, "fire-d-20261002T000000Z")]);
      expect(result.trashFailed).toEqual([{ path: join(trash, "fire-c-20261001T000000Z"), reason: expect.stringContaining("pinned.txt") }]);
      expect(existsSync(pinned)).toBe(true);
    },
  );
});
