import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SITE_NOTE_ABI } from "@tavi/contracts";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { APPS_SITES_SETTING } from "../../src/features/apps/sharing.js";
import { browserCommand } from "../../src/features/browser/owner.js";
import { OPERATOR_SITE_NOTES, SITE_NOTES_DIRECTORY } from "../../src/features/browser/site-notes.js";
import { withStore } from "../../src/cli/store.js";
import { EXIT, main } from "../../src/main.js";

const directories = temporaryDirectories({ prefix: "tavi-site-notes-command-" });
afterEach(() => {
  directories.cleanup();
});

const run = async (dataDirectory: string, ...argv: string[]) => {
  const captured = capture();
  const code = await main(["browser", "site-notes", ...argv, "--data-dir", dataDirectory], { io: captured.io });
  return { code, out: captured.out(), err: captured.err() };
};

const switchOf = async (dataDirectory: string): Promise<Record<string, string[]>> =>
  await withStore(
    dataDirectory,
    async (store) => JSON.parse((await store.getMeta(APPS_SITES_SETTING)) ?? "{}") as Record<string, string[]>,
  );

const note = (id: string, notes = `How ${id} works.`) => ({ abi: SITE_NOTE_ABI, id, name: id, hosts: [`${id}.example`], notes });

describe("tavi browser site-notes", () => {
  it("lists each note's state, turns one on and off, and refuses one that does not read", async () => {
    const dataDirectory = directories.create();
    const notes = join(dataDirectory, SITE_NOTES_DIRECTORY);
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, "mine.json"), JSON.stringify(note("mine")));
    writeFileSync(join(notes, "other.json"), JSON.stringify(note("other")));
    writeFileSync(join(notes, "broken.json"), "{");

    const listed = await run(dataDirectory, "--format", "json");
    expect(listed.code, listed.err).toBe(EXIT.ok);
    expect(
      (JSON.parse(listed.out) as { notes: { file: string; state: string }[] }).notes.map((entry) => [entry.file, entry.state]),
    ).toEqual([
      ["broken.json", "unreadable"],
      ["mine.json", "off"],
      ["other.json", "off"],
    ]);

    const on = await run(dataDirectory, "--on", "mine");
    expect(on.code, on.err).toBe(EXIT.ok);
    expect(on.out).toContain("mine is on");
    expect((await switchOf(dataDirectory))[OPERATOR_SITE_NOTES]).toEqual([expect.stringMatching(/^mine@[0-9a-f]{16}$/)]);
    expect((await run(dataDirectory, "--on", "other")).code).toBe(EXIT.ok);
    let text = await run(dataDirectory);
    expect(text.out).toContain("broken.json — unreadable: not JSON");
    expect(text.out).toContain("mine — mine (mine.example), on");

    // An edited file is off again until it is turned on anew.
    writeFileSync(join(notes, "mine.json"), JSON.stringify(note("mine", "Something else.")));
    text = await run(dataDirectory);
    expect(text.out).toContain("mine — mine (mine.example), changed since turned on");

    // --off takes its key out; with none left, the operator's entry goes.
    expect((await run(dataDirectory, "--off", "mine")).code).toBe(EXIT.ok);
    expect((await switchOf(dataDirectory))[OPERATOR_SITE_NOTES]).toEqual([expect.stringMatching(/^other@/)]);
    expect((await run(dataDirectory, "--off", "other")).code).toBe(EXIT.ok);
    expect(await switchOf(dataDirectory)).not.toHaveProperty(OPERATOR_SITE_NOTES);

    // One that does not read, or is not there, is never turned on.
    for (const id of ["broken", "missing"]) {
      const refused = await run(dataDirectory, "--on", id);
      expect(refused.code).not.toBe(EXIT.ok);
      expect(refused.err).toMatch(new RegExp(`no site note ${id}`));
    }
    expect(await switchOf(dataDirectory)).not.toHaveProperty(OPERATOR_SITE_NOTES);
  });

  it("says there are none in an empty directory", async () => {
    const dataDirectory = directories.create();
    const listed = await run(dataDirectory);
    expect(listed.code, listed.err).toBe(EXIT.ok);
    expect(listed.out).toMatch(/^No site notes in /);
  });

  it("proposes a site's recipe as a note, off and private, and never overwrites one there", async () => {
    const dataDirectory = directories.create();
    await withStore(dataDirectory, async (store) => {
      await store.asPort().repositories.siteRecipes.put({
        workspaceId: "default",
        host: "shop.example.com",
        steps: [{ kind: "click", role: "button", label: "Search" }],
        results: 4,
        updatedAt: "2026-10-20T10:00:00.000Z",
      });
    });
    const proposed = await run(dataDirectory, "--propose", "www.shop.example.com", "--format", "json");
    expect(proposed.code, proposed.err).toBe(EXIT.ok);
    const { id, file } = (JSON.parse(proposed.out) as { proposed: { id: string; file: string } }).proposed;
    expect(id).toBe("recipe-shop-example-com");
    expect(file).toBe(join(dataDirectory, SITE_NOTES_DIRECTORY, "recipe-shop-example-com.json"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ abi: SITE_NOTE_ABI, id, hosts: ["shop.example.com"] });
    // Proposed, not turned on.
    expect(await switchOf(dataDirectory)).not.toHaveProperty(OPERATOR_SITE_NOTES);
    expect((await run(dataDirectory)).out).toContain(`${id} — shop.example.com (shop.example.com), off`);

    const again = await run(dataDirectory, "--propose", "shop.example.com");
    expect(again.code).not.toBe(EXIT.ok);
    expect(again.err).toContain("is there already");

    const none = await run(dataDirectory, "--propose", "nowhere.example");
    expect(none.code).not.toBe(EXIT.ok);
    expect(none.err).toContain("no recipe for nowhere.example");
  });

  it("is the owner's propose-site-note, which the canvas sends: the same note, off, and never over one there", async () => {
    const dataDirectory = directories.create();
    const siteNotesDirectory = join(dataDirectory, SITE_NOTES_DIRECTORY);
    await withStore(dataDirectory, async (store) => {
      const repositories = store.asPort().repositories;
      await repositories.siteRecipes.put({
        workspaceId: "default",
        host: "shop.example.com",
        steps: [{ kind: "click", role: "button", label: "Search" }],
        results: 4,
        updatedAt: "2026-10-20T10:00:00.000Z",
      });
      const deps = { repositories, principalOf: () => "operator", now: () => new Date(), siteNotesDirectory };
      const answer = await browserCommand(deps, { action: "propose-site-note", host: "www.shop.example.com" });
      expect(answer).toEqual({
        ok: true,
        result: {
          proposed: {
            id: "recipe-shop-example-com",
            name: "shop.example.com",
            hosts: ["shop.example.com"],
            file: "recipe-shop-example-com.json",
            on: false,
          },
        },
      });
      const path = join(siteNotesDirectory, "recipe-shop-example-com.json");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ abi: SITE_NOTE_ABI, id: "recipe-shop-example-com" });
      expect(await browserCommand(deps, { action: "propose-site-note", host: "shop.example.com" })).toMatchObject({
        ok: false,
        error: { code: "CONFLICT" },
      });
      expect(await browserCommand(deps, { action: "propose-site-note", host: "nowhere.example" })).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
      // Where no data directory is known (the CLI's offline reads), it is refused, never written somewhere else.
      const { siteNotesDirectory: _directory, ...offline } = deps;
      expect(await browserCommand(offline, { action: "propose-site-note", host: "shop.example.com" })).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
    });
    // Proposed, not turned on; the CLI lists it as any note of its own.
    expect(await switchOf(dataDirectory)).not.toHaveProperty(OPERATOR_SITE_NOTES);
    expect((await run(dataDirectory)).out).toContain("recipe-shop-example-com — shop.example.com (shop.example.com), off");
  });
});
