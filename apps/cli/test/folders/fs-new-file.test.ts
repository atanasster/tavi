import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TaviError, untrustedLabel, type ChatFolder, type InvocationContext } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { folderFileWriter, writeContainedBytes, type FsToolOptions } from "../../src/features/folders/fs-tools.js";

/**
 * A new file's bytes, never over an existing one: the writer `pdf.fill` saves through.
 */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

function temporary(): string {
  const base = realpathSync(directories.create("tavi-newfile-"));
  return base;
}

function chat(options: Partial<FsToolOptions> = {}, host = false) {
  const base = temporary();
  const data = join(base, "data");
  const managed = join(data, "chats", "default", "task-a");
  mkdirSync(managed, { recursive: true });
  const project = join(base, "project");
  mkdirSync(project);
  const primary = host ? project : managed;
  const folder: ChatFolder = {
    primary,
    primaryKind: host ? "host" : "managed",
    managed,
    scratch: join(managed, ".tmp"),
    home: join(managed, ".home"),
    attachments: [],
    revision: 1,
  };
  const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "task-a", caller: "test", folder };
  const write = folderFileWriter({ dataDirectory: data, ...options });
  return { base, managed, project, context, write };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("writeContainedBytes", () => {
  it("refuses an existing target and leaves it as it was", async () => {
    const root = temporary();
    writeFileSync(join(root, "taken.pdf"), "mine");
    const contained = (real: string) => real === root || real.startsWith(`${root}/`);
    const refused = await writeContainedBytes(join(root, "taken.pdf"), bytes("new"), [root], contained, () => false).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(TaviError);
    expect(refused).toMatchObject({ code: "CONFLICT", details: { reason: "exists" } });
    expect(readFileSync(join(root, "taken.pdf"), "utf8")).toBe("mine");
  });

  it("removes a file it created and could not finish", async () => {
    const root = temporary();
    const contained = (real: string) => real === root || real.startsWith(`${root}/`);
    // A non-buffer body makes the write itself fail after the create.
    await expect(
      writeContainedBytes(join(root, "half.pdf"), 42 as unknown as Uint8Array, [root], contained, () => false),
    ).rejects.toThrow();
    expect(existsSync(join(root, "half.pdf"))).toBe(false);
  });
});

describe("folderFileWriter", () => {
  it("writes a default name, then its free variants, and never over a taken one", async () => {
    const { managed, context, write } = chat();
    const target = { managedSubfolder: "forms", name: "school-packet-filled.pdf" };
    expect(await write(target, bytes("one"), context, undefined)).toEqual({
      absolute: join(managed, "forms", "school-packet-filled.pdf"),
      shown: "forms/school-packet-filled.pdf",
    });
    expect((await write(target, bytes("two"), context, undefined)).shown).toBe("forms/school-packet-filled (2).pdf");
    expect(readFileSync(join(managed, "forms", "school-packet-filled.pdf"), "utf8")).toBe("one");
    // Two at once take two names.
    const both = await Promise.all([write(target, bytes("a"), context, undefined), write(target, bytes("b"), context, undefined)]);
    expect(new Set(both.map((written) => written.shown)).size).toBe(2);
    expect(readdirSync(join(managed, "forms"))).toHaveLength(4);
  });

  it("gives up after the last variant", async () => {
    const { managed, context, write } = chat();
    mkdirSync(join(managed, "forms"));
    writeFileSync(join(managed, "forms", "f.pdf"), "x");
    for (let index = 2; index <= 100; index += 1) writeFileSync(join(managed, "forms", `f (${index}).pdf`), "x");
    await expect(write({ managedSubfolder: "forms", name: "f.pdf" }, bytes("y"), context, undefined)).rejects.toThrow(
      /already holds 100 files named like f\.pdf/,
    );
  });

  it("refuses an explicit path that exists, and one outside the chat's folders", async () => {
    const { base, managed, context, write } = chat();
    writeFileSync(join(managed, "mine.pdf"), "keep");
    await expect(write({ path: "mine.pdf" }, bytes("new"), context, undefined)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(readFileSync(join(managed, "mine.pdf"), "utf8")).toBe("keep");
    await expect(write({ path: join(base, "elsewhere.pdf") }, bytes("new"), context, undefined)).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
    });
  });

  it("admits the write, marks a tainted chat's managed folder, and records a host write before and after", async () => {
    const admitted: string[] = [];
    const marked: string[] = [];
    const recorded: string[] = [];
    const options: Partial<FsToolOptions> = {
      space: { admitWrite: async (_folder, target) => void admitted.push(target) },
      markFolderTainted: async (context) => void marked.push(context.runId),
      hostWrites: {
        record: async (_context, path, sha256) => void recorded.push(`${path}:${sha256.slice(0, 8)}`),
        writerOf: async () => undefined,
      },
    };
    const managedChat = chat(options);
    await managedChat.write({ managedSubfolder: "forms", name: "a.pdf" }, bytes("x"), managedChat.context, untrustedLabel("attachment"));
    expect(admitted).toEqual([join(managedChat.managed, "forms", "a.pdf")]);
    // A taken default name moves on to its variant without admitting or marking again.
    await managedChat.write({ managedSubfolder: "forms", name: "a.pdf" }, bytes("y"), managedChat.context, untrustedLabel("attachment"));
    expect([admitted.length, marked.length]).toEqual([2, 2]);
    expect(marked).toEqual(["task-a", "task-a"]);
    expect(recorded).toEqual([]);
    const hostChat = chat(options, true);
    await hostChat.write({ path: "filled.pdf" }, bytes("x"), hostChat.context, untrustedLabel("attachment"));
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toContain(join(hostChat.project, "filled.pdf"));
    // An explicit path that exists is refused before anything is admitted, marked or recorded.
    const [admittedBefore, recordedBefore] = [admitted.length, recorded.length];
    await expect(
      hostChat.write({ path: "filled.pdf" }, bytes("other"), hostChat.context, untrustedLabel("attachment")),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect([admitted.length, recorded.length]).toEqual([admittedBefore, recordedBefore]);
  });
});
