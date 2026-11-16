import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { nowTimestamp } from "@tavi/contracts/util";
import { afterEach, describe, expect, it } from "vitest";

import { createIpcClient } from "@tavi/runtime";
import { capture, temporaryDirectories, delay } from "@tavi/test-support";

import { EXIT, main } from "../../src/main.js";
import { findLiveOwner } from "../../src/server/serve.js";
import { SqliteStore } from "../support/database-fixture.js";

/**
 * `tavi reset --yes`: the data directory as if tavi had just been
 * installed. Only tavi's own entries go; anything else in the directory stays.
 */

const directories = temporaryDirectories({ prefix: "tavi-reset-" });

afterEach(() => directories.cleanup());

describe("tavi reset", () => {
  it("refuses without --yes", async () => {
    const directory = directories.create();
    const refused = capture();
    expect(await main(["reset", "--data-dir", directory], { io: refused.io })).toBe(EXIT.usage);
    expect(refused.stderr()).toContain("--yes");
  });

  it.each([
    [["--yes=1"], "--yes does not take a value"],
    [["--yes", "--force"], "reset does not accept --force"],
    [["--yes", "everything"], "Unexpected argument"],
    // --format is every command's (d101ea5): its own refusal names the values it takes.
    [["--yes", "--format", "yaml"], '--format takes text or json, not "yaml"'],
  ])("refuses %j", async (flags, message) => {
    const refused = capture();
    expect(await main(["reset", ...flags, "--data-dir", directories.create()], { io: refused.io })).toBe(EXIT.usage);
    expect(refused.stderr()).toContain(message);
  });

  it("asks a live owner, which resets and serves again", async () => {
    const directory = directories.create();
    const served = main(["serve", "--data-dir", directory], { io: capture().io });
    const ownerOf = async (other?: string) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const found = await findLiveOwner(directory);
        if (found !== undefined && found.sessionId !== other) return found;
        await delay(50);
      }
      throw new Error("no owner");
    };
    const first = await ownerOf();
    mkdirSync(join(directory, "artifacts"), { recursive: true });
    writeFileSync(join(directory, "artifacts", "old.bin"), "old");

    const reset = capture();
    expect(await main(["reset", "--yes", "--format", "json", "--data-dir", directory], { io: reset.io })).toBe(EXIT.ok);
    expect(JSON.parse(reset.stdout())).toEqual({ dataDirectory: directory, resetting: true });
    const second = await ownerOf(first.sessionId);
    expect(existsSync(join(directory, "artifacts", "old.bin"))).toBe(false);

    const tunnel = await createIpcClient(second);
    expect((await tunnel.request("shutdown", { reason: "test complete" }, "r1")).ok).toBe(true);
    tunnel.close();
    expect(await served).toBe(EXIT.ok);
  });

  it("says, through a live owner, that a selected external memory provider's own index is the plugin's to clear", async () => {
    const directory = directories.create();
    const writer = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const settings = writer.asPort().repositories.workspaceSettings;
      const current = await settings.get("default");
      await settings.set({
        workspaceId: "default",
        settings: { ...current.settings, memory: { provider: "acme.vectors" } },
        expectedRevision: current.revision,
        actor: "operator",
        now: nowTimestamp(),
      });
    } finally {
      await writer.close();
    }
    const served = main(["serve", "--data-dir", directory], { io: capture().io });
    let first: Awaited<ReturnType<typeof findLiveOwner>>;
    for (let attempt = 0; attempt < 200 && (first = await findLiveOwner(directory)) === undefined; attempt += 1) await delay(50);
    const reset = capture();
    expect(await main(["reset", "--yes", "--format", "json", "--data-dir", directory], { io: reset.io })).toBe(EXIT.ok);
    expect(JSON.parse(reset.stdout())).toEqual({ dataDirectory: directory, resetting: true, memoryProviders: ["acme.vectors"] });
    let second: Awaited<ReturnType<typeof findLiveOwner>>;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      second = await findLiveOwner(directory);
      if (second !== undefined && second.sessionId !== first?.sessionId) break;
      await delay(50);
    }
    const tunnel = await createIpcClient(second!);
    expect((await tunnel.request("shutdown", { reason: "test complete" }, "r1")).ok).toBe(true);
    tunnel.close();
    expect(await served).toBe(EXIT.ok);
  });

  it("deletes tavi's state and leaves files it did not write", async () => {
    const directory = directories.create();
    expect(await main(["projects", "add", "acme", "--ga4", "properties/1", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    for (const entry of [
      "artifacts/default",
      "credentials",
      "channels",
      "plugins/p/1",
      "ui",
      "logs",
      "browser-profiles/default-0123456789ab",
      "sandbox-home",
      // The sandbox's read roots and its probe's scratch: tavi's, not the reader's.
      "sandbox/.probe",
      "chats/default/t1/.home",
      "chats.pre-restore-2026/default",
    ])
      mkdirSync(join(directory, entry), { recursive: true });
    writeFileSync(join(directory, "credentials.key"), "k");
    writeFileSync(join(directory, "web-providers.json"), "{}");
    writeFileSync(join(directory, "tavi.sqlite.pre-restore-2026"), "old");
    writeFileSync(join(directory, "notes.txt"), "mine");

    const reset = capture();
    expect(await main(["reset", "--yes", "--format", "json", "--data-dir", directory], { io: reset.io })).toBe(EXIT.ok);
    const result = JSON.parse(reset.stdout()) as { removed: string[]; kept: string[] };
    expect(result.removed).toEqual(
      expect.arrayContaining([
        "tavi.sqlite",
        "artifacts",
        "credentials",
        "credentials.key",
        "channels",
        "plugins",
        "ui",
        "logs",
        "browser-profiles",
        "sandbox-home",
        "sandbox",
        "chats",
        "chats.pre-restore-2026",
        "web-providers.json",
        "tavi.sqlite.pre-restore-2026",
      ]),
    );
    expect(result.kept).toEqual(["notes.txt"]);
    expect(readdirSync(directory).filter((name) => !name.startsWith("owner."))).toEqual(["notes.txt"]);

    // A fresh start: the next command builds an empty database.
    const listed = capture();
    expect(await main(["projects", "list", "--format", "json", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stdout()).not.toContain("acme");
    expect(existsSync(join(directory, "tavi.sqlite"))).toBe(true);
  });

  it("deletes chats' folders a toolchain left read-only or unreadable, and a link in them but never what it points at", async () => {
    const directory = directories.create();
    expect(await main(["projects", "add", "acme", "--ga4", "properties/1", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    // Go keeps its module cache read-only under `.home/`; a shell can `chmod 000` a folder of its own.
    const modules = join(directory, "chats", "default", "t1", ".home", "go", "pkg", "mod", "example.com@v1");
    mkdirSync(modules, { recursive: true });
    writeFileSync(join(modules, "go.mod"), "module example.com");
    const locked = join(directory, "chats", "default", "t2", "locked");
    mkdirSync(join(locked, "inner"), { recursive: true });
    writeFileSync(join(locked, "inner", "f.txt"), "x");
    const aside = join(directory, "chats.pre-restore-2026", "default", "t3", "ro");
    mkdirSync(aside, { recursive: true });
    writeFileSync(join(aside, "f.txt"), "x");
    const outside = join(directories.create(), "kept");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "not tavi's");
    chmodSync(outside, 0o555);
    symlinkSync(outside, join(directory, "chats", "default", "t1", "to-outside"));
    for (const folder of [modules, join(modules, ".."), aside]) chmodSync(folder, 0o555);
    chmodSync(join(locked, "inner"), 0o000);
    chmodSync(locked, 0o000);

    const reset = capture();
    expect(await main(["reset", "--yes", "--format", "json", "--data-dir", directory], { io: reset.io }), reset.stderr()).toBe(EXIT.ok);
    expect((JSON.parse(reset.stdout()) as { removed: string[] }).removed).toEqual(
      expect.arrayContaining(["chats", "chats.pre-restore-2026", "tavi.sqlite"]),
    );
    expect(readdirSync(directory).filter((name) => !name.startsWith("owner."))).toEqual([]);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("not tavi's");
    expect(statSync(outside).mode & 0o777).toBe(0o555);
    chmodSync(outside, 0o700);
  });

  it.runIf(process.platform === "darwin")(
    "stops before deleting anything else when a chat's folder cannot be deleted, and says what it left",
    async () => {
      const directory = directories.create();
      expect(await main(["projects", "add", "acme", "--ga4", "properties/1", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
      mkdirSync(join(directory, "artifacts", "default"), { recursive: true });
      const pinned = join(directory, "chats", "default", "t1", "pinned.txt");
      mkdirSync(join(pinned, ".."), { recursive: true });
      writeFileSync(pinned, "immutable");
      // A flag no permission change lifts: only its owner's `chflags nouchg` does.
      execFileSync("chflags", ["uchg", pinned]);
      try {
        const reset = capture();
        expect(await main(["reset", "--yes", "--data-dir", directory], { io: reset.io })).not.toBe(EXIT.ok);
        expect(reset.stderr()).toMatch(/chats could not be deleted whole.*pinned\.txt.*nothing else was deleted.*tavi reset again/s);
        // The instance is whole: its database and artifacts are where they were.
        for (const kept of ["tavi.sqlite", "artifacts"]) expect(existsSync(join(directory, kept)), kept).toBe(true);
      } finally {
        execFileSync("chflags", ["nouchg", pinned]);
      }
    },
  );
});
