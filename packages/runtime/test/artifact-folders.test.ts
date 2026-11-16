import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FOLDER_FILE_NAME_MAX_BYTES, folderFileName, folderFileNameVariant, type ArtifactFolderCopy } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { ChatFolders, createArtifactMaterializer, type ChatFolderTask } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * Approved artifacts copied into their chat's managed folder: downloads into `downloads/`, reports into
 * `reports/`, never anything pending (I-pending), never through a link
 * (I-nofollow), under a safe name.
 */

const cleanup: (() => void)[] = [];
const directories = temporaryDirectories();
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
  directories.cleanup();
});

function scratch(): string {
  return realpathSync(directories.create("tavi-artifact-folders-"));
}

/** A store with an artifacts directory, `ChatFolders` over in-memory tasks, and the materializer over both. */
function owner(beforeOpen?: () => Promise<void>) {
  const base = scratch();
  const data = join(base, "data");
  mkdirSync(data);
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true, artifactsDirectory: join(data, "artifacts") });
  cleanup.push(() => store.close());
  const tasks = new Map<string, ChatFolderTask>();
  const delegations = new Map<string, { rootTaskId?: string }>();
  const folders = new ChatFolders({
    dataDirectory: data,
    fsRoots: [],
    homeDirectory: join(base, "home"),
    repository: {
      get: () => undefined,
      revision: () => 0,
      write: () => {
        throw new Error("unused");
      },
    },
    tasks: { get: (taskId) => tasks.get(taskId) },
    agentDelegations: { getByWorkerTaskId: (taskId) => delegations.get(taskId) },
  });
  const logged: unknown[] = [];
  const materialize = createArtifactMaterializer({
    artifacts: {
      getArtifact: async (artifactId) => store.getArtifact(artifactId),
      readArtifactBody: async (artifactId) => store.readArtifactBody(artifactId),
    },
    folders,
    log: (message, fields) => logged.push({ message, fields }),
    ...(beforeOpen === undefined ? {} : { beforeOpen: () => beforeOpen() }),
  });
  const task = (taskId: string, fields: Partial<ChatFolderTask> = {}) =>
    tasks.set(taskId, { taskId, workspaceId: "default", principalId: "operator", origin: "ipc", ...fields });
  const put = (input: {
    runId?: string;
    body?: string;
    fileName?: string;
    folderCopy?: ArtifactFolderCopy;
    reviewState?: "pending" | "approved";
    untrusted?: boolean;
  }) =>
    store.putArtifact({
      workspaceId: "default",
      contentType: "application/octet-stream",
      body: input.body ?? "downloaded bytes",
      ...definedOnly({
        runId: input.runId,
        fileName: input.fileName,
        folderCopy: input.folderCopy,
        untrusted: input.untrusted,
      }),
      reviewState: input.reviewState ?? "approved",
    });
  const approve = (artifactId: string) =>
    store.setReviewState({ artifactId, reviewState: "approved", reviewedBy: "operator", reviewedAt: "2026-10-10T00:00:00.000Z" });
  const managed = (taskId: string) => join(data, "chats", "default", taskId);
  return { base, data, store, task, delegations, put, approve, materialize, managed, logged };
}

describe("folderFileName", () => {
  it.each([
    ["report.csv", "report.csv"],
    ["../x", "x"],
    ["..\\..\\windows\\x.bat", "x.bat"],
    [".bashrc", "bashrc"],
    ["...", "fallback"],
    ["", "fallback"],
    ["invoice\u202Efdp.exe", "invoicefdp.exe"],
    ["a\u2066b\u2069c.txt", "abc.txt"],
    ["line\nbreak\u0000\u007f.txt", "linebreak.txt"],
    ["C:evil.txt", "Cevil.txt"],
    ["  spaced.txt  ", "spaced.txt"],
    ["report\u2028evil\u2029.pdf", "reportevil.pdf"],
    ["pay\u200Bpal\u200C\u200D\u2060\uFEFF.pdf", "paypal.pdf"],
  ])("%j becomes %j", (suggested, safe) => {
    expect(folderFileName(suggested, "fallback")).toBe(safe);
  });

  it("caps a long name at the byte limit, keeping its extension and whole characters", () => {
    const long = folderFileName(`${"a".repeat(300)}.pdf`, "fallback");
    expect(Buffer.byteLength(long)).toBe(FOLDER_FILE_NAME_MAX_BYTES);
    expect(long.endsWith(".pdf")).toBe(true);
    const wide = folderFileName(`${"é".repeat(200)}.txt`, "fallback");
    expect(Buffer.byteLength(wide)).toBeLessThanOrEqual(FOLDER_FILE_NAME_MAX_BYTES);
    expect(wide).toMatch(/^é+\.txt$/);
  });

  it("names a collision ` (2)`, within the limit", () => {
    expect(folderFileNameVariant("report.pdf", 1)).toBe("report.pdf");
    expect(folderFileNameVariant("report.pdf", 2)).toBe("report (2).pdf");
    expect(folderFileNameVariant("README", 3)).toBe("README (3)");
    const variant = folderFileNameVariant(folderFileName(`${"b".repeat(300)}.pdf`, "x"), 12);
    expect(Buffer.byteLength(variant)).toBeLessThanOrEqual(FOLDER_FILE_NAME_MAX_BYTES);
    expect(variant.endsWith(" (12).pdf")).toBe(true);
    // An extension that fills the name is cut with the stem: never over the limit, never a leading space.
    const longExtension = `a.${"x".repeat(125)}`;
    expect(folderFileName(longExtension, "fallback")).toBe(longExtension);
    const second = folderFileNameVariant(longExtension, 2);
    expect(Buffer.byteLength(second)).toBeLessThanOrEqual(FOLDER_FILE_NAME_MAX_BYTES);
    expect(second).toMatch(/^a\.x+ \(2\)$/);
    const wideExtension = folderFileNameVariant(`b.${"x".repeat(120)}`, 3);
    expect(Buffer.byteLength(wideExtension)).toBeLessThanOrEqual(FOLDER_FILE_NAME_MAX_BYTES);
    expect(wideExtension.startsWith(" ")).toBe(false);
  });
});

describe("createArtifactMaterializer", () => {
  it("copies an approved download into the chat's downloads/ under its name — a copy, never a link", async () => {
    const { task, put, materialize, managed, store } = owner();
    task("chat-1");
    const record = put({ runId: "chat-1", fileName: "report.csv", folderCopy: "downloads" });
    const outcome = await materialize(record.artifactId);
    const copy = join(managed("chat-1"), "downloads", "report.csv");
    expect(outcome).toEqual({ status: "copied", path: copy });
    expect(readFileSync(copy, "utf8")).toBe("downloaded bytes");
    const body = statSync(store.resolveArtifactPath(record.relativePath));
    expect(lstatSync(copy).nlink).toBe(1);
    expect(lstatSync(copy).ino).not.toBe(body.ino);
  });

  it("I-pending: copies nothing pending, and copies it once it is approved", async () => {
    const { task, put, approve, materialize, managed } = owner();
    task("chat-1");
    const record = put({ runId: "chat-1", fileName: "page.html", folderCopy: "downloads", reviewState: "pending" });
    expect(await materialize(record.artifactId)).toEqual({ status: "skipped", reason: "the artifact is pending" });
    expect(existsSync(join(managed("chat-1"), "downloads"))).toBe(false);
    approve(record.artifactId);
    expect((await materialize(record.artifactId)).status).toBe("copied");
    expect(readdirSync(join(managed("chat-1"), "downloads"))).toEqual(["page.html"]);
  });

  it("copies a report into reports/", async () => {
    const { task, put, materialize, managed } = owner();
    task("chat-1");
    const record = put({ runId: "chat-1", body: "%PDF", fileName: "brief.pdf", folderCopy: "reports" });
    expect((await materialize(record.artifactId)).status).toBe("copied");
    expect(readFileSync(join(managed("chat-1"), "reports", "brief.pdf"), "utf8")).toBe("%PDF");
  });

  it("names a collision ` (2)`, and does not copy the same bytes twice", async () => {
    const { task, put, materialize, managed } = owner();
    task("chat-1");
    const downloads = join(managed("chat-1"), "downloads");
    const first = put({ runId: "chat-1", body: "one", fileName: "data.csv", folderCopy: "downloads" });
    const second = put({ runId: "chat-1", body: "two", fileName: "data.csv", folderCopy: "downloads" });
    expect((await materialize(first.artifactId)).status).toBe("copied");
    expect(await materialize(second.artifactId)).toEqual({ status: "copied", path: join(downloads, "data (2).csv") });
    expect(await materialize(second.artifactId)).toEqual({ status: "present", path: join(downloads, "data (2).csv") });
    expect(readdirSync(downloads).sort()).toEqual(["data (2).csv", "data.csv"]);
    expect(readFileSync(join(downloads, "data (2).csv"), "utf8")).toBe("two");
  });

  it("makes a hostile stored name safe again", async () => {
    const { task, store, materialize, managed } = owner();
    task("chat-1");
    const record = store.putArtifact({
      workspaceId: "default",
      runId: "chat-1",
      contentType: "text/plain",
      body: "x",
      fileName: "../../.ssh/authorized_keys",
      folderCopy: "downloads",
    });
    expect((await materialize(record.artifactId)).status).toBe("copied");
    expect(readdirSync(join(managed("chat-1"), "downloads"))).toEqual(["authorized_keys"]);
  });

  it("I-nofollow: a link planted at downloads/ is refused and nothing is written through it", async () => {
    const { base, task, put, materialize, managed, logged } = owner();
    task("chat-1");
    const outside = join(base, "outside");
    mkdirSync(outside);
    mkdirSync(managed("chat-1"), { recursive: true });
    symlinkSync(outside, join(managed("chat-1"), "downloads"));
    const record = put({ runId: "chat-1", fileName: "x.txt", folderCopy: "downloads" });
    const outcome = await materialize(record.artifactId);
    expect(outcome.status).toBe("failed");
    expect(readdirSync(outside)).toEqual([]);
    expect(logged).toHaveLength(1);
  });

  it("retries a copy that failed: once the planted link is gone, the next call copies", async () => {
    const { base, task, put, materialize, managed } = owner();
    task("chat-1");
    const outside = join(base, "outside");
    mkdirSync(outside);
    mkdirSync(managed("chat-1"), { recursive: true });
    symlinkSync(outside, join(managed("chat-1"), "downloads"));
    const record = put({ runId: "chat-1", fileName: "x.txt", folderCopy: "downloads" });
    expect((await materialize(record.artifactId)).status).toBe("failed");
    rmSync(join(managed("chat-1"), "downloads"));
    expect((await materialize(record.artifactId)).status).toBe("copied");
    expect((await materialize(record.artifactId)).status).toBe("present");
    expect(readdirSync(join(managed("chat-1"), "downloads"))).toEqual(["x.txt"]);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("I-nofollow: downloads/ swapped for a link between its check and the open writes nothing; at most an empty file is left at the link's target", async () => {
    let swap = async () => {};
    const { base, task, put, materialize, managed } = owner(() => swap());
    task("chat-1");
    const outside = join(base, "outside");
    mkdirSync(outside);
    const record = put({ runId: "chat-1", fileName: "x.txt", folderCopy: "downloads" });
    const downloads = join(managed("chat-1"), "downloads");
    swap = async () => {
      swap = async () => {};
      renameSync(downloads, join(managed("chat-1"), "moved"));
      symlinkSync(outside, downloads);
    };
    const outcome = await materialize(record.artifactId);
    expect(outcome.status).toBe("failed");
    // The residual Node cannot close without `openat`: the open followed the link, and the file it made holds nothing.
    expect(outcome).toMatchObject({ reason: expect.stringContaining("changed while a copy was being made") });
    for (const entry of readdirSync(outside)) expect(statSync(join(outside, entry)).size).toBe(0);
    expect(readdirSync(join(managed("chat-1"), "moved"))).toEqual([]);
  });

  it("I-nofollow: a link planted at the file's name is never written through; the copy takes the next name", async () => {
    const { base, task, put, materialize, managed } = owner();
    task("chat-1");
    const victim = join(base, "victim.txt");
    writeFileSync(victim, "keep");
    const downloads = join(managed("chat-1"), "downloads");
    mkdirSync(downloads, { recursive: true });
    symlinkSync(victim, join(downloads, "x.txt"));
    const record = put({ runId: "chat-1", fileName: "x.txt", folderCopy: "downloads" });
    expect(await materialize(record.artifactId)).toEqual({ status: "copied", path: join(downloads, "x (2).txt") });
    expect(readFileSync(victim, "utf8")).toBe("keep");
  });

  it("copies a worker's download into its root chat's folder", async () => {
    const { task, delegations, put, materialize, managed } = owner();
    task("root");
    task("worker", { origin: "agent", chatKind: "worker" });
    delegations.set("worker", { rootTaskId: "root" });
    const record = put({ runId: "worker", fileName: "w.txt", folderCopy: "downloads" });
    expect((await materialize(record.artifactId)).status).toBe("copied");
    expect(readdirSync(join(managed("root"), "downloads"))).toEqual(["w.txt"]);
    expect(existsSync(managed("worker"))).toBe(false);
  });

  it("never copies inbound messaging media: untrusted, with no chat and no folder", async () => {
    const { data, put, materialize } = owner();
    const record = put({ untrusted: true });
    expect((await materialize(record.artifactId)).status).toBe("skipped");
    expect(existsSync(join(data, "chats"))).toBe(false);
  });

  it("copies nothing that is not marked for a folder, and nothing whose body no longer matches its record", async () => {
    const { task, put, store, materialize, managed } = owner();
    task("chat-1");
    const plain = put({ runId: "chat-1" });
    expect(await materialize(plain.artifactId)).toEqual({ status: "skipped", reason: "not an artifact copied into a folder" });
    const record = put({ runId: "chat-1", fileName: "t.txt", folderCopy: "downloads" });
    writeFileSync(store.resolveArtifactPath(record.relativePath), "tampered bytes!!");
    expect((await materialize(record.artifactId)).status).toBe("failed");
    expect(existsSync(join(managed("chat-1"), "downloads", "t.txt"))).toBe(false);
  });
});

describe("putArtifact's folder-copy fields", () => {
  it("keeps the file's name, its folder and an outbound call's approver, and reads them back", () => {
    const { store } = owner();
    const record = store.putArtifact({
      workspaceId: "default",
      runId: "chat-1",
      contentType: "application/pdf",
      body: "%PDF",
      fileName: "report.pdf",
      reviewState: "approved",
      reviewedBy: "alice",
    });
    expect(store.getArtifact(record.artifactId)).toMatchObject({
      runId: "chat-1",
      fileName: "report.pdf",
      reviewState: "approved",
      reviewedBy: "alice",
      reviewedAt: expect.any(String),
    });
    expect(store.getArtifact(record.artifactId)).not.toHaveProperty("folderCopy");
    const download = store.putArtifact({
      workspaceId: "default",
      contentType: "text/plain",
      body: "x",
      fileName: "x.txt",
      folderCopy: "downloads",
      reviewState: "pending",
    });
    expect(store.getArtifact(download.artifactId)).toMatchObject({ folderCopy: "downloads", reviewedBy: null, reviewedAt: null });
    // A reviewer is recorded only with a decision.
    expect(() =>
      store.putArtifact({ workspaceId: "default", contentType: "text/plain", body: "y", reviewState: "pending", reviewedBy: "alice" }),
    ).toThrow(/decided review state/);
  });
});
