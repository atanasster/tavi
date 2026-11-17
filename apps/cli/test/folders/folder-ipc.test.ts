import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeScheduler, openConnection, openSocket, readOwner } from "@tavi/client/node";
import {
  FOLDER_READ_CHUNK_BYTES,
  type BrowseAnswer,
  type ChatFolder,
  type FolderFilesAnswer,
  type FolderReadAnswer,
  type FolderView,
  type ModelOutcome,
  type ModelPort,
  type RunResult,
} from "@tavi/contracts";
import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { capture, temporaryDirectories, waitFor } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { UsageError, parseArgs } from "../../src/cli/parse.js";
import { readChunk } from "../../src/features/folders/owner.js";
import { folderNoteOf } from "../../src/features/run/owner.js";
import { EXIT, main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { inspectDatabase } from "../support/database-fixture.js";
import { ended, requestWithSubscription } from "../support/ipc-run.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * A chat's working folder over IPC: `run`'s
 * `folder` and `clientCwd`, the `folder` command's every action, `browse` and
 * its per-connection tokens, and what the web bridge may never do (I-web).
 */

const directories = temporaryDirectories();
const handles: ServeHandle[] = [];
const clients: IpcClient[] = [];
const closers: (() => void)[] = [];

afterEach(async () => {
  while (closers.length > 0) closers.pop()?.();
  while (clients.length > 0) clients.pop()?.close();
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

const quietIo: CliIo = { stdout: () => {}, stderr: () => {}, isTty: false };

/** A model that answers every call at once. */
const answering: ModelPort = {
  async stream(request, options): Promise<ModelOutcome> {
    options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text: "done" });
    return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
  },
};

/**
 * An owner whose one root holds its own data directory — so `browse` must
 * leave that out — and two folders a chat may use.
 */
async function owner(
  extraRoots: readonly string[] = [],
  options: { readonly rootless?: true; readonly model?: ModelPort } = {},
): Promise<{ readonly handle: ServeHandle; readonly root: string; readonly data: string; readonly work: string; readonly lib: string }> {
  const root = realpathSync(directories.create("tfi-"));
  const data = join(root, "d");
  mkdirSync(data, { mode: 0o700 });
  chmodSync(data, 0o700);
  const work = join(root, "work");
  const lib = join(root, "lib");
  mkdirSync(join(work, "sub"), { recursive: true });
  mkdirSync(lib);
  const handle = await serve(
    fixtureServeOptions(data, {
      defaultConnectionId: "fixture-conn",
      ...(options.rootless === true ? {} : { fsRoots: [root, ...extraRoots] }),
    }),
    { dataDirectory: data, drainDeadlineMs: 5_000 },
    quietIo,
    { modelOverride: options.model ?? answering, browserOverride: createFixtureBrowser() },
  );
  handles.push(handle);
  return { handle, root, data, work, lib };
}

async function terminal(data: string): Promise<IpcClient> {
  const found = await findLiveOwner(data);
  if (found === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(found);
  clients.push(client);
  return client;
}

/** A connection as `tavi ui`'s bridge opens one: what it forwards is a page's. */
async function page(data: string) {
  const address = readOwner(data);
  if (address === undefined) throw new Error("no owner published");
  const connection = await openConnection(await openSocket(address.endpoint), address, { scheduler: nodeScheduler, client: "bridge" });
  closers.push(() => connection.close());
  return connection;
}

const run = (client: IpcClient, payload: Record<string, unknown>, requestId: string) =>
  requestWithSubscription(client, "run", { workspaceId: "default", principal: "operator", approval: "client", ...payload }, requestId);

/** A chat begun by a terminal run, settled. */
async function chatIn(
  client: IpcClient,
  payload: Record<string, unknown>,
  key: string,
): Promise<{ readonly taskId: string; readonly result: RunResult }> {
  const started = await run(client, { prompt: "say done", operationKey: key, ...payload }, `run-${key}`);
  expect(started.response.ok, JSON.stringify(started.response.error)).toBe(true);
  await waitFor(() => ended(started.events));
  const result = started.response.result as RunResult;
  return { taskId: result.taskId, result };
}

async function homeOn(handle: ServeHandle): Promise<void> {
  const settings = handle.runtime.store.asPort().repositories.workspaceSettings;
  const current = await settings.get("default");
  await settings.set({
    workspaceId: "default",
    settings: { ...current.settings, homeChat: true },
    expectedRevision: current.revision,
    actor: "operator",
    now: "2026-01-01T00:00:00.000Z",
  });
}

/** A file read whole through `folder read`, chunk by chunk, as the canvas reads it. */
async function download(
  client: IpcClient,
  taskId: string,
  path: string,
  root = "primary",
  between?: () => void,
): Promise<{ readonly bytes: Buffer; readonly hash: string } | { readonly error: string }> {
  const parts: Buffer[] = [];
  let hash: string | undefined;
  for (let offset: number | null = 0, index = 0; offset !== null; index += 1) {
    if (index === 1) between?.();
    const answer = await client.request(
      "folder",
      { action: "read", workspaceId: "default", taskId, root, path, offset, ...(hash === undefined ? {} : { sha256: hash }) },
      `read-${path}-${offset}`,
    );
    if (!answer.ok) return { error: `${answer.error?.code}: ${answer.error?.message}` };
    const chunk = answer.result as FolderReadAnswer;
    hash ??= chunk.hash;
    parts.push(Buffer.from(chunk.base64, "base64"));
    offset = chunk.nextOffset;
  }
  return { bytes: Buffer.concat(parts), hash: hash as string };
}

describe("folder over IPC", () => {
  it("starts a terminal's run in its directory under a root, and round-trips every folder action", async () => {
    const { handle, work, lib, root } = await owner();
    const client = await terminal(handle.runtime.dataDirectory);
    const { taskId, result } = await chatIn(client, { clientCwd: work }, "cwd-1");
    expect(result.folder).toEqual({ kind: "host", path: work });
    const target = { workspaceId: "default", taskId };
    const ask = async (payload: Record<string, unknown>, id: string) => client.request("folder", { ...target, ...payload }, id);

    // show: the directory is the primary; the first root, which held it, gave way.
    const shown = (await ask({ action: "show" }, "show")).result as FolderView;
    expect(shown).toMatchObject({ taskId, revision: 1, primary: { kind: "host", path: work, label: "work" }, attachments: [] });
    // attach, read-write; detach; set to the managed folder and back; reset to the defaults.
    expect(((await ask({ action: "attach", folder: { path: lib }, mode: "rw" }, "attach")).result as FolderView).attachments).toEqual([
      { path: lib, mode: "rw", label: "lib" },
    ]);

    // files: a level at a time, folders first; the managed folder too, without its scratch.
    writeFileSync(join(work, "a.txt"), "hello");
    writeFileSync(join(work, "sub", "b.txt"), "inner");
    const listed = (await ask({ action: "files" }, "files")).result as FolderFilesAnswer;
    expect(listed.entries.map((entry) => [entry.name, entry.kind, entry.size])).toEqual([
      ["sub", "directory", 0],
      ["a.txt", "file", 5],
    ]);
    expect(listed.roots.map((entry) => entry.id)).toEqual(["primary", "managed", "attachment:lib"]);
    expect(
      ((await ask({ action: "files", dir: "sub" }, "files-sub")).result as FolderFilesAnswer).entries.map((entry) => entry.name),
    ).toEqual(["b.txt"]);
    expect(((await ask({ action: "files", root: "managed" }, "files-managed")).result as FolderFilesAnswer).entries).toEqual([]);
    expect((await ask({ action: "files", dir: "../x" }, "files-up")).error?.code).toBe("INVALID_INPUT");

    // read: one chunk; and a file of several, whose hash every later chunk names.
    const small = await download(client, taskId, "a.txt");
    expect("bytes" in small && small.bytes.toString()).toBe("hello");
    const body = Buffer.alloc(FOLDER_READ_CHUNK_BYTES * 2 + 17, 7);
    writeFileSync(join(work, "big.bin"), body);
    const big = await download(client, taskId, "big.bin");
    expect("bytes" in big && big.bytes.equals(body)).toBe(true);
    expect("hash" in big && big.hash).toBe(createHash("sha256").update(body).digest("hex"));
    // A later chunk that names no hash is refused.
    expect((await ask({ action: "read", path: "big.bin", offset: FOLDER_READ_CHUNK_BYTES }, "read-nohash")).error?.code).toBe(
      "INVALID_INPUT",
    );

    expect(((await ask({ action: "detach", label: "lib" }, "detach")).result as FolderView).attachments).toEqual([]);
    expect(((await ask({ action: "set", folder: { managed: true } }, "set-managed")).result as FolderView).primary).toMatchObject({
      kind: "managed",
      label: "Chat files",
    });
    expect(((await ask({ action: "set", folder: { path: lib } }, "set-path")).result as FolderView).primary).toMatchObject({
      kind: "host",
      path: lib,
    });
    const reset = (await ask({ action: "reset" }, "reset")).result as FolderView;
    expect(reset).toMatchObject({ primary: { kind: "managed" }, attachments: [{ path: root, mode: "ro" }] });
    expect(reset.revision).toBeGreaterThan(shown.revision);
  });

  it("refuses a download whose file changed between its first chunk and its last, and a path out of the folder", async () => {
    const { handle, work, root } = await owner();
    const client = await terminal(handle.runtime.dataDirectory);
    const { taskId } = await chatIn(client, { clientCwd: work }, "cwd-2");
    writeFileSync(join(work, "big.bin"), Buffer.alloc(FOLDER_READ_CHUNK_BYTES + 5, 1));
    const changed = await download(client, taskId, "big.bin", "primary", () =>
      writeFileSync(join(work, "big.bin"), Buffer.alloc(FOLDER_READ_CHUNK_BYTES + 5, 2)),
    );
    expect(changed).toEqual({ error: "CONFLICT: big.bin changed while it was downloaded; download it again" });
    // A link out of the folder is not followed out of it.
    writeFileSync(join(root, "outside.txt"), "secret");
    symlinkSync(join(root, "outside.txt"), join(work, "leak.txt"));
    expect(await download(client, taskId, "leak.txt")).toMatchObject({
      error: expect.stringMatching(/^NOT_AUTHORIZED: .*leak\.txt is outside your working folder and attached folders/),
    });
  });

  it("refuses a hard-linked file in a managed folder", async () => {
    const { handle, root } = await owner();
    const client = await terminal(handle.runtime.dataDirectory);
    const { taskId } = await chatIn(client, { folder: { managed: true } }, "managed-1");
    const view = (await client.request("folder", { action: "show", workspaceId: "default", taskId }, "show")).result as FolderView;
    writeFileSync(join(root, "host.txt"), "host");
    linkSync(join(root, "host.txt"), join(view.managed, "linked.txt"));
    writeFileSync(join(view.managed, "own.txt"), "own");
    expect(await download(client, taskId, "own.txt")).toMatchObject({ bytes: Buffer.from("own") });
    expect(await download(client, taskId, "linked.txt")).toMatchObject({ error: expect.stringMatching(/^NOT_AUTHORIZED: .*hard link/) });
  });

  it("works in its own folder, and says so, when the terminal's directory is under no root; a named folder outside is refused", async () => {
    const { handle } = await owner();
    const elsewhere = realpathSync(directories.create("tavi-folder-elsewhere-"));
    const client = await terminal(handle.runtime.dataDirectory);
    const { result } = await chatIn(client, { clientCwd: elsewhere }, "outside-1");
    expect(result.folder).toEqual({
      kind: "managed",
      note: `This chat works in its own folder, not ${elsewhere}: ${elsewhere} is not under an --fs-root`,
    });
    const named = await run(client, { prompt: "say done", operationKey: "outside-2", folder: { path: elsewhere } }, "run-outside-2");
    expect(named.response.error).toMatchObject({ code: "NOT_AUTHORIZED", message: `${elsewhere} is not under an --fs-root` });
    // Refused before anything was admitted: the first run is the only task.
    const listed = (await client.request("tasks", { action: "list", workspaceId: "default" }, "list")).result as { rows: unknown[] };
    expect(listed.rows).toHaveLength(1);
  });

  it("keeps Home's folder whatever directory it is messaged from", async () => {
    const { handle, work, lib } = await owner();
    await homeOn(handle);
    const client = await terminal(handle.runtime.dataDirectory);
    const first = await chatIn(client, { target: "home", clientCwd: work }, "home-1");
    const second = await chatIn(client, { target: "home", clientCwd: lib }, "home-2");
    expect(second.taskId).toBe(first.taskId);
    expect(first.result.folder).toBeUndefined();
    expect(second.result.folder).toBeUndefined();
    const view = (await client.request("folder", { action: "show", workspaceId: "default", taskId: first.taskId }, "show"))
      .result as FolderView;
    expect(view).toMatchObject({ revision: 0, primary: { kind: "managed" } });
    const refused = await run(client, { prompt: "hi", operationKey: "home-3", target: "home", folder: { path: work } }, "run-home-3");
    expect(refused.response.error?.code).toBe("INVALID_INPUT");
  });

  it("recovers a chat whose folder is gone with reset", async () => {
    const { handle, root } = await owner();
    const client = await terminal(handle.runtime.dataDirectory);
    const gone = join(root, "gone");
    mkdirSync(gone);
    const { taskId } = await chatIn(client, { clientCwd: gone }, "gone-1");
    rmSync(gone, { recursive: true });
    const shown = (await client.request("folder", { action: "show", workspaceId: "default", taskId }, "show")).result as FolderView;
    expect(shown.primary).toBeUndefined();
    expect(shown.unavailable).toMatch(/no longer exists\. Run \/folder reset/);
    expect(
      ((await client.request("folder", { action: "reset", workspaceId: "default", taskId }, "reset")).result as FolderView).primary?.kind,
    ).toBe("managed");
  });

  it("shows a folder record that no longer reads as unavailable, so the canvas offers Reset, which recovers it", async () => {
    const { handle } = await owner();
    const client = await terminal(handle.runtime.dataDirectory);
    const { taskId } = await chatIn(client, { folder: { managed: true } }, "torn-1");
    expect((await client.request("folder", { action: "reset", workspaceId: "default", taskId }, "first")).ok).toBe(true);
    inspectDatabase(handle.runtime.store)
      .prepare("UPDATE tavi_task_folders SET attachments_json = 'not json' WHERE task_id = ?")
      .run(taskId);
    const shown = await client.request("folder", { action: "show", workspaceId: "default", taskId }, "show");
    expect(shown.error).toBeUndefined();
    expect((shown.result as FolderView).primary).toBeUndefined();
    expect((shown.result as FolderView).unavailable).toMatch(/cannot be read\. Run \/folder reset/);
    expect(
      ((await client.request("folder", { action: "reset", workspaceId: "default", taskId }, "reset")).result as FolderView).primary?.kind,
    ).toBe("managed");
  });
});

describe("folder files and read under fs.read's confinement (I-isolate)", () => {
  it("never lists or serves the data directory or another chat's folder inside an attached root, from a page or a terminal", async () => {
    const { handle, root, data } = await owner();
    const canvas = await page(handle.runtime.dataDirectory);
    const client = await terminal(handle.runtime.dataDirectory);
    // Two chats, each with the first root — which holds the data directory — attached read-only.
    const mine = await chatIn(client, { folder: { managed: true } }, "conf-1");
    const theirs = await chatIn(client, { folder: { managed: true } }, "conf-2");
    const label = `attachment:${root.split("/").pop() as string}`;
    const target = { workspaceId: "default", taskId: mine.taskId };
    const listed = (await canvas.request("folder", { ...target, action: "files", root: label }, "files-root")).result as FolderFilesAnswer;
    expect(listed.entries.map((entry) => entry.name)).not.toContain("d");
    for (const path of ["d/tavi.sqlite", `d/chats/default/${theirs.taskId}`]) {
      expect(
        (
          await canvas.request(
            "folder",
            { ...target, action: "files", root: label, dir: path.endsWith(".sqlite") ? "d" : path },
            `files-${path}`,
          )
        ).error?.code,
      ).toBe("NOT_AUTHORIZED");
    }
    expect(
      (await canvas.request("folder", { ...target, action: "read", root: label, path: "d/tavi.sqlite", offset: 0 }, "read-db")).error?.code,
    ).toBe("NOT_AUTHORIZED");
    writeFileSync(join(data, "chats", "default", theirs.taskId, "secret.txt"), "theirs");
    expect(
      (
        await canvas.request(
          "folder",
          { ...target, action: "read", root: label, path: `d/chats/default/${theirs.taskId}/secret.txt`, offset: 0 },
          "read-theirs",
        )
      ).error?.code,
    ).toBe("NOT_AUTHORIZED");
    // The chat's own folder is the one carve-out.
    writeFileSync(join(data, "chats", "default", mine.taskId, "own.txt"), "mine");
    expect(await download(client, mine.taskId, "own.txt")).toMatchObject({ bytes: Buffer.from("mine") });
  });

  it("refuses a credential home inside an attached home folder", async () => {
    const previousHome = process.env["HOME"];
    const home = realpathSync(directories.create("tfh-"));
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE KEY");
    writeFileSync(join(home, ".netrc"), "machine x password y");
    writeFileSync(join(home, "notes.txt"), "fine");
    process.env["HOME"] = home;
    let made: Awaited<ReturnType<typeof owner>>;
    try {
      made = await owner([home]);
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
    }
    const client = await terminal(made.handle.runtime.dataDirectory);
    const { taskId } = await chatIn(client, { folder: { managed: true } }, "home-attach");
    // The owner's home may be attached: only a primary may not be it.
    expect(
      (await client.request("folder", { workspaceId: "default", taskId, action: "attach", folder: { path: home } }, "attach")).ok,
    ).toBe(true);
    const label = `attachment:${home.split("/").pop() as string}`;
    const listed = (await client.request("folder", { workspaceId: "default", taskId, action: "files", root: label }, "files"))
      .result as FolderFilesAnswer;
    expect(listed.entries.map((entry) => entry.name)).toEqual(["notes.txt"]);
    expect(
      (
        await client.request(
          "folder",
          { workspaceId: "default", taskId, action: "read", root: label, path: ".ssh/id_ed25519", offset: 0 },
          "read-key",
        )
      ).error?.code,
    ).toBe("NOT_AUTHORIZED");
    expect(
      (
        await client.request(
          "folder",
          { workspaceId: "default", taskId, action: "read", root: label, path: ".netrc", offset: 0 },
          "read-netrc",
        )
      ).error?.code,
    ).toBe("NOT_AUTHORIZED");
    expect(
      (await client.request("folder", { workspaceId: "default", taskId, action: "files", root: label, dir: ".ssh" }, "files-ssh")).error
        ?.code,
    ).toBe("NOT_AUTHORIZED");
  });

  it("never lists or serves a file that holds keys or tokens inside an attached home folder, as fs.read refuses it", async () => {
    const previousHome = process.env["HOME"];
    const home = realpathSync(directories.create("tfk-"));
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    writeFileSync(join(home, ".config", "gh", "hosts.yml"), "oauth_token: gho_secret");
    writeFileSync(join(home, ".git-credentials"), "https://user:token@example.com");
    writeFileSync(join(home, "notes.txt"), "fine");
    process.env["HOME"] = home;
    let made: Awaited<ReturnType<typeof owner>>;
    try {
      made = await owner([home]);
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
    }
    const client = await terminal(made.handle.runtime.dataDirectory);
    const { taskId } = await chatIn(client, { folder: { managed: true } }, "home-keys");
    expect(
      (await client.request("folder", { workspaceId: "default", taskId, action: "attach", folder: { path: home } }, "attach")).ok,
    ).toBe(true);
    const label = `attachment:${home.split("/").pop() as string}`;
    const listed = (await client.request("folder", { workspaceId: "default", taskId, action: "files", root: label }, "files"))
      .result as FolderFilesAnswer;
    expect(listed.entries.map((entry) => entry.name)).toEqual([".config", "notes.txt"]);
    expect(
      (
        await client.request(
          "folder",
          { workspaceId: "default", taskId, action: "read", root: label, path: ".git-credentials", offset: 0 },
          "read-credentials",
        )
      ).error?.code,
    ).toBe("NOT_AUTHORIZED");
    expect(
      (
        await client.request(
          "folder",
          { workspaceId: "default", taskId, action: "read", root: label, path: ".config/gh/hosts.yml", offset: 0 },
          "read-gh",
        )
      ).error?.code,
    ).toBe("NOT_AUTHORIZED");
    expect(
      (await client.request("folder", { workspaceId: "default", taskId, action: "files", root: label, dir: ".config" }, "files-config"))
        .result as FolderFilesAnswer,
    ).toMatchObject({ entries: [] });
  });

  it("refuses a download whose folder became a link after it was resolved: an ancestor swap is caught once the file is open", async () => {
    const base = realpathSync(directories.create("tfs-"));
    const root = join(base, "root");
    const elsewhere = join(base, "elsewhere");
    mkdirSync(root);
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "id_ed25519"), "PRIVATE KEY");
    // `docs` is a link now, though the path was resolved — and confined — while it was a folder.
    symlinkSync(elsewhere, join(root, "docs"));
    const folder: ChatFolder = {
      primary: root,
      primaryKind: "host",
      managed: join(base, "managed"),
      scratch: join(base, "managed", ".tmp"),
      home: join(base, "managed", ".home"),
      attachments: [],
      revision: 1,
    };
    // The scope answers the path as it resolved before the swap.
    const resolvedBefore = { resolve: (path: string) => path, hidden: () => false, inManagedFolder: () => false };
    await expect(readChunk("chat-1", folder, resolvedBefore, undefined, "docs/id_ed25519", 0, undefined)).rejects.toThrow(
      /changed while it was opened; download it again/,
    );
  });
});

describe("folder and browse from the web bridge (I-web)", () => {
  it("never takes a path or a directory of its own from a page; it redeems the tokens browse issued on its own connection", async () => {
    const { handle, root, work, lib } = await owner();
    const canvas = await page(handle.runtime.dataDirectory);
    const pageRun = (payload: Record<string, unknown>, key: string) =>
      canvas.request(
        "run",
        { workspaceId: "default", principal: "operator", approval: "client", prompt: "say done", operationKey: key, ...payload },
        `run-${key}`,
      );
    expect((await pageRun({ folder: { path: work } }, "web-path")).error?.code).toBe("NOT_AUTHORIZED");
    expect((await pageRun({ clientCwd: work }, "web-cwd")).error?.code).toBe("NOT_AUTHORIZED");

    // browse: the roots, then inside one — never the data directory inside it, nor a hidden folder.
    mkdirSync(join(root, ".hidden"));
    const top = (await canvas.request("browse", { workspaceId: "default" }, "browse-top")).result as BrowseAnswer;
    expect(top.entries.map((entry) => entry.path)).toEqual([root]);
    const inside = (await canvas.request("browse", { workspaceId: "default", under: top.entries[0]?.token }, "browse-root"))
      .result as BrowseAnswer;
    expect(inside.entries.map((entry) => entry.name)).toEqual(["lib", "work"]);
    expect(inside.at?.path).toBe(root);
    expect(inside.parent).toBeUndefined();
    const workToken = inside.entries.find((entry) => entry.name === "work")?.token as string;
    const libToken = inside.entries.find((entry) => entry.name === "lib")?.token as string;

    // A run started in a picked folder.
    const picked = await pageRun({ folder: { pick: workToken } }, "web-pick");
    expect(picked.ok, JSON.stringify(picked.error)).toBe(true);
    const taskId = (picked.result as RunResult).taskId;
    expect((picked.result as RunResult).folder).toEqual({ kind: "host", path: work });
    await waitFor(async () => (await handle.runtime.store.asPort().repositories.tasks.get(taskId))?.status === "completed");

    const target = { workspaceId: "default", taskId };
    expect((await canvas.request("folder", { ...target, action: "set", folder: { path: lib } }, "web-set-path")).error?.code).toBe(
      "NOT_AUTHORIZED",
    );
    expect((await canvas.request("folder", { ...target, action: "attach", folder: { path: lib } }, "web-attach-path")).error?.code).toBe(
      "NOT_AUTHORIZED",
    );
    const attached = await canvas.request("folder", { ...target, action: "attach", folder: { pick: libToken } }, "web-attach-pick");
    expect((attached.result as FolderView).attachments).toEqual([{ path: lib, mode: "ro", label: "lib" }]);

    // A token is worth nothing on another connection: another page's, or a terminal's.
    const other = await page(handle.runtime.dataDirectory);
    expect((await other.request("folder", { ...target, action: "set", folder: { pick: workToken } }, "other-set")).error?.code).toBe(
      "NOT_FOUND",
    );
    expect((await other.request("browse", { workspaceId: "default", under: workToken }, "other-browse")).error?.code).toBe("NOT_FOUND");
    const client = await terminal(handle.runtime.dataDirectory);
    expect((await client.request("folder", { ...target, action: "set", folder: { pick: workToken } }, "terminal-set")).error?.code).toBe(
      "NOT_FOUND",
    );
    // A page may still list and download the chat's files, and reset it.
    writeFileSync(join(work, "page.html"), "<script>alert(1)</script>");
    expect(
      ((await canvas.request("folder", { ...target, action: "files" }, "web-files")).result as FolderFilesAnswer).entries.map(
        (entry) => entry.name,
      ),
    ).toContain("page.html");
    expect(((await canvas.request("folder", { ...target, action: "reset" }, "web-reset")).result as FolderView).primary?.kind).toBe(
      "managed",
    );
  });
});

describe("folders picked before a chat's first message (run.folderAttachments)", () => {
  it("attaches a page's picked folders when its first message starts the chat or Home, so the first turn sees them", async () => {
    const asked: string[] = [];
    const recording: ModelPort = {
      stream(request, options) {
        asked.push(JSON.stringify(request));
        return answering.stream(request, options);
      },
    };
    const { handle, work, lib } = await owner([], { model: recording });
    await homeOn(handle);
    const canvas = await page(handle.runtime.dataDirectory);
    const top = (await canvas.request("browse", { workspaceId: "default" }, "browse-top")).result as BrowseAnswer;
    const inside = (await canvas.request("browse", { workspaceId: "default", under: top.entries[0]?.token }, "browse-root"))
      .result as BrowseAnswer;
    const token = (name: string) => inside.entries.find((entry) => entry.name === name)?.token as string;
    const pageRun = (payload: Record<string, unknown>, key: string) =>
      canvas.request(
        "run",
        { workspaceId: "default", principal: "operator", approval: "client", prompt: "say done", operationKey: key, ...payload },
        `run-${key}`,
      );
    const show = async (taskId: string) =>
      (await canvas.request("folder", { action: "show", workspaceId: "default", taskId }, `show-${taskId}`)).result as FolderView;
    const tasks = handle.runtime.store.asPort().repositories.tasks;

    // Refused before anything is admitted: a path from a page, a token this connection was never given, a folder out of reach.
    const refusedPath = await pageRun({ folderAttachments: [{ folder: { path: work }, mode: "rw" }] }, "draft-path");
    expect(refusedPath.error?.code).toBe("NOT_AUTHORIZED");
    const stale = await pageRun({ folderAttachments: [{ folder: { pick: "x".repeat(24) }, mode: "rw" }] }, "draft-stale");
    expect(stale.error?.code).toBe("NOT_FOUND");
    const listed = (await canvas.request("tasks", { action: "list", workspaceId: "default" }, "list")).result as { rows: unknown[] };
    expect(listed.rows).toHaveLength(0);

    // A new chat: both attached, read-write and read-only, before its first turn ran.
    const started = await pageRun(
      {
        folderAttachments: [
          { folder: { pick: token("work") }, mode: "rw" },
          { folder: { pick: token("lib") }, mode: "ro" },
        ],
      },
      "draft-chat",
    );
    expect(started.ok, JSON.stringify(started.error)).toBe(true);
    const chat = (started.result as RunResult).taskId;
    expect((started.result as RunResult).folder).toBeUndefined();
    await waitFor(async () => (await tasks.get(chat))?.status === "completed");
    expect((await show(chat)).attachments).toEqual([
      { path: work, mode: "rw", label: "work" },
      { path: lib, mode: "ro", label: "lib" },
    ]);
    expect(asked[0]).toContain(work);

    // Home, begun by this message: attached too. A message to the Home that exists attaches nothing, and says so.
    const home = await pageRun({ target: "home", folderAttachments: [{ folder: { pick: token("lib") }, mode: "rw" }] }, "draft-home");
    expect(home.ok, JSON.stringify(home.error)).toBe(true);
    const homeId = (home.result as RunResult).taskId;
    await waitFor(async () => (await tasks.get(homeId))?.status === "completed");
    expect((await show(homeId)).attachments).toContainEqual({ path: lib, mode: "rw", label: "lib" });
    const again = await pageRun({ target: "home", folderAttachments: [{ folder: { pick: token("work") }, mode: "ro" }] }, "draft-home-2");
    expect((again.result as RunResult).folder?.note).toMatch(/not attached/);
    expect((await show(homeId)).attachments.map((attachment) => attachment.path)).not.toContain(work);
  });
});

describe("tavi run --folder, --managed and the terminal's directory; tavi tasks folder", () => {
  it("starts a run in the folder named, or in its own folder with a line saying why the directory was not used", async () => {
    const { handle, work, lib } = await owner();
    const data = handle.runtime.dataDirectory;
    const tasks = handle.runtime.store.asPort().repositories.tasks;
    const folderOf = async (operationKey: string) => {
      const listed = (await (await terminal(data)).request("tasks", { action: "list", workspaceId: "default" }, `list-${operationKey}`))
        .result as { rows: { taskId: string }[] };
      for (const row of listed.rows) {
        const admissions = await tasks.listAdmissions(row.taskId);
        if (admissions.some((admission) => admission.operationKey === operationKey))
          return (
            await (
              await terminal(data)
            ).request("folder", { action: "show", workspaceId: "default", taskId: row.taskId }, `show-${operationKey}`)
          ).result as FolderView;
      }
      throw new Error(`no task for ${operationKey}`);
    };

    const named = capture();
    expect(
      await main(["run", "say done", "--folder", lib, "--operation-key", "cli-folder", "--approval", "deny", "--data-dir", data], {
        io: named.io,
      }),
    ).toBe(EXIT.ok);
    expect((await folderOf("cli-folder")).primary).toMatchObject({ kind: "host", path: lib });
    expect(named.stderr()).not.toContain("works in its own folder");

    // This test's own directory is under no root: its own folder, and one line saying so.
    const fromHere = capture();
    expect(
      await main(["run", "say done", "--operation-key", "cli-cwd", "--approval", "deny", "--data-dir", data], { io: fromHere.io }),
    ).toBe(EXIT.ok);
    expect(fromHere.stderr()).toContain(`This chat works in its own folder, not ${process.cwd()}:`);
    expect((await folderOf("cli-cwd")).primary?.kind).toBe("managed");
    // --quiet: no diagnostic on stderr, this one included.
    const quiet = capture();
    expect(
      await main(["run", "say done", "--quiet", "--operation-key", "cli-quiet", "--approval", "deny", "--data-dir", data], {
        io: quiet.io,
      }),
    ).toBe(EXIT.ok);
    expect(quiet.stderr()).not.toContain("works in its own folder");

    const managed = capture();
    expect(
      await main(["run", "say done", "--managed", "--operation-key", "cli-managed", "--approval", "deny", "--data-dir", data], {
        io: managed.io,
      }),
    ).toBe(EXIT.ok);
    expect(managed.stderr()).not.toContain("works in its own folder, not");
    expect((await folderOf("cli-managed")).primary?.kind).toBe("managed");

    // A folder under no root is refused before anything runs.
    const refused = capture();
    expect(
      await main(["run", "say done", "--folder", tmpdir(), "--operation-key", "cli-refused", "--data-dir", data], { io: refused.io }),
    ).not.toBe(EXIT.ok);
    expect(refused.stderr()).toMatch(/is not under an --fs-root/);
    expect(work).toBeDefined();
  });

  it("shows and changes a chat's folder with tavi tasks folder, as /folder does", async () => {
    const { handle, work, lib } = await owner();
    const data = handle.runtime.dataDirectory;
    const { taskId } = await chatIn(await terminal(data), { clientCwd: work }, "tasks-folder");
    const ran = async (...argv: string[]) => {
      const io = capture();
      const code = await main(["tasks", "folder", taskId, ...argv, "--data-dir", data], { io: io.io });
      return { code, out: io.stdout(), err: io.stderr() };
    };
    expect(await ran()).toMatchObject({
      code: EXIT.ok,
      out: `… this chat works in ${work}\n  its own folder: ${join(data, "chats", "default", taskId)}\n  size: 0 B of its 2.0 GB budget\n`,
    });
    // --format json gives the owner's view, not the text.
    expect(JSON.parse((await ran("--format", "json")).out)).toMatchObject({ primary: { kind: "host", path: work }, attachments: [] });
    expect((await ran("attach", lib, "--rw")).out).toContain(`  lib (read-write): ${lib}`);
    expect((await ran("detach", "lib")).out).not.toContain("  lib (");
    expect((await ran("detach", "nope")).err).toContain('This chat has no attached folder "nope"');
    expect((await ran("reset")).out).toContain("… from its next message, this chat works in its own folder");
    // Back to the defaults, the first root is attached read-only again: a folder in it overlaps it.
    expect(await ran("set", lib)).toMatchObject({ code: EXIT.usage, err: expect.stringContaining("overlaps the attached folder") });
  });
});

describe("parsing the folder flags and commands", () => {
  it("takes --folder or --managed for a run of its own, and refuses them for Home, --attach, together, and --folder in memory", () => {
    expect(parseArgs(["run", "hi", "--folder", "~/work"])).toMatchObject({ options: { folder: "~/work" } });
    expect(parseArgs(["run", "hi", "--managed"])).toMatchObject({ options: { managed: true } });
    expect(() => parseArgs(["run", "hi", "--folder", "a", "--managed"])).toThrow(UsageError);
    // An empty one (an unset variable) is refused, not read as the current directory (Mac mini adversarial tests).
    expect(() => parseArgs(["run", "hi", "--folder", ""])).toThrow(/--folder needs a folder/);
    expect(() => parseArgs(["run", "hi", "--home", "--managed"])).toThrow(/Home keeps its own/);
    expect(() => parseArgs(["run", "--attach", "t1", "--folder", "a"])).toThrow(UsageError);
    expect(() => parseArgs(["run", "hi", "--folder", "a", "--in-memory"])).toThrow(/needs a live owner/);
  });

  it("says a run's folder usage error in a few lines, not under the whole run help", async () => {
    for (const flags of [
      ["--folder", "a", "--managed"],
      ["--home", "--managed"],
      ["--folder", "a", "--in-memory"],
    ]) {
      let err = "";
      expect(
        await main(["run", "hi", ...flags], { io: { stdout: () => undefined, stderr: (chunk) => void (err += chunk), isTty: false } }),
        flags.join(" "),
      ).toBe(EXIT.usage);
      expect(err.split("\n").length, err).toBeLessThan(8);
      expect(err).toContain("tavi run --help");
      expect(err).not.toContain("Run one task");
    }
  });

  it("refuses an --fs-root spelled with a glob character before the owner starts, naming why", () => {
    expect(() => parseArgs(["serve", "--fs-root", "/work/site[1]"])).toThrow(
      /--fs-root "\/work\/site\[1\]" has \*, \?, \[ or \] in its path, which the sandbox reads as a pattern/,
    );
    expect(parseArgs(["serve", "--fs-root", "/work/site"])).toMatchObject({ serve: { fsRoots: ["/work/site"] } });
  });

  it("takes --sandbox-read more than once, and refuses a relative one with a usage error (exit 2) before the owner starts", async () => {
    expect(parseArgs(["serve", "--sandbox-read", "/opt/tools", "--sandbox-read", "/usr/local/share/sdk"])).toMatchObject({
      serve: { sandboxRead: ["/opt/tools", "/usr/local/share/sdk"] },
    });
    expect(parseArgs(["serve"])).not.toHaveProperty("serve.sandboxRead");
    expect(() => parseArgs(["serve", "--sandbox-read", "tools"])).toThrow(UsageError);
    expect(() => parseArgs(["serve", "--sandbox-read", "./tools"])).toThrow(
      /--sandbox-read must be an absolute path, received "\.\/tools"/,
    );
    let err = "";
    expect(
      await main(["serve", "--sandbox-read", "tools"], {
        io: { stdout: () => undefined, stderr: (chunk) => void (err += chunk), isTty: false },
      }),
    ).toBe(EXIT.usage);
    expect(err).toContain("--sandbox-read must be an absolute path");
  });

  it("takes --sandbox-domain more than once in stored form, and refuses a bare * with a usage error", () => {
    expect(
      parseArgs(["serve", "--sandbox-domain", "PyPI.org", "--sandbox-domain", "*.pythonhosted.org", "--sandbox-domain", "pypi.org"]),
    ).toMatchObject({ serve: { sandboxDomains: ["pypi.org", "*.pythonhosted.org"] } });
    expect(parseArgs(["serve"])).not.toHaveProperty("serve.sandboxDomains");
    expect(() => parseArgs(["serve", "--sandbox-domain", "*"])).toThrow(/--sandbox-domain takes a host or \*\.domain/);
    expect(() => parseArgs(["serve", "--sandbox-domain", "http://x.com"])).toThrow(UsageError);
  });

  it("takes --sandbox-credential <VAR>=<ref>, refusing a bad name or the same variable twice", () => {
    expect(parseArgs(["serve", "--sandbox-credential", "GH_TOKEN=github.token"])).toMatchObject({
      serve: { sandboxCredentials: ["GH_TOKEN=github.token"] },
    });
    expect(() => parseArgs(["serve", "--sandbox-credential", "1BAD=x"])).toThrow(/expects <VAR>=<credential-reference>/);
    expect(() => parseArgs(["serve", "--sandbox-credential", "GH_TOKEN"])).toThrow(UsageError);
    expect(() => parseArgs(["serve", "--sandbox-credential", "A=x", "--sandbox-credential", "A=y"])).toThrow(/names A twice/);
  });

  it("parses tavi tasks folder's actions", () => {
    expect(parseArgs(["tasks", "folder", "t1"])).toMatchObject({ taskFolder: { action: "show", taskId: "t1", workspaceId: "default" } });
    expect(parseArgs(["tasks", "folder", "t1", "attach", "~/lib", "--rw", "--workspace", "team"])).toMatchObject({
      taskFolder: { action: "attach", path: "~/lib", rw: true, workspaceId: "team" },
    });
    expect(parseArgs(["tasks", "folder", "t1", "detach", "lib"])).toMatchObject({ taskFolder: { action: "detach", label: "lib" } });
    expect(() => parseArgs(["tasks", "folder", "t1", "set"])).toThrow(/needs a folder/);
    expect(() => parseArgs(["tasks", "folder", "t1", "reset", "x"])).toThrow(/Unexpected argument/);
    expect(() => parseArgs(["tasks", "folder", "t1", "set", "a", "--rw"])).toThrow(/--rw applies to tasks folder attach only/);
    expect(() => parseArgs(["tasks", "folder", "t1", "move"])).toThrow(/Unknown tasks folder action/);
  });
});

describe("folderNoteOf", () => {
  it("says plainly why a new chat works in its own folder, naming no directory when the owner allows none", () => {
    expect(folderNoteOf("/Users/me/site", "This owner has no --fs-root, so a chat works only in its own folder", true)).toBe(
      "This chat works in its own folder. Start tavi serve with --fs-root <path> to let chats work in your folders.",
    );
    expect(folderNoteOf("/tmp/x", "/tmp/x is not under an --fs-root", false)).toBe(
      "This chat works in its own folder, not /tmp/x: /tmp/x is not under an --fs-root",
    );
  });
});
