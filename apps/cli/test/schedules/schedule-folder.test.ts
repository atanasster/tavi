import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { writeSchedule } from "../../src/features/schedules/actions.js";
import { SqliteStore } from "../support/database-fixture.js";
import { ownerFolders } from "./fire-harness.js";

/** A schedule's working folder: pinned by a person, held to the owner's --fs-root rule, as a routine's folder is. */

const directories = temporaryDirectories({ prefix: "tavi-schedule-folder-" });
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  directories.cleanup();
});

const NOW = new Date("2026-11-03T08:00:00.000Z");

/** A store and the owner's folder rule over one --fs-root, as `tavi serve --fs-root <root>` checks a schedule's folder. */
async function owner() {
  const root = directories.create();
  const chatFolders = ownerFolders(
    root,
    () => directories.create(),
    () => NOW.toISOString(),
  );
  const directory = directories.create();
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  stores.push(store);
  return { root, repositories: store.asPort().repositories, folder: (path: string) => chatFolders.checkPrimary(path) };
}

describe("a schedule's folder", () => {
  it("is pinned as its real path when the owner's --fs-root rule allows it, refused outside it, and removed with off", async () => {
    const o = await owner();
    const notes = join(o.root, "notes");
    mkdirSync(notes);
    const base = { action: "add" as const, name: "prices", prompt: "Read prices.txt", at: "07:00", timezone: "UTC" };
    const made = await writeSchedule(o.repositories, { ...base, folder: notes }, NOW, { folder: o.folder });
    expect(made.folder).toBe(realpathSync(notes));
    await expect(
      writeSchedule(o.repositories, { ...base, name: "outside", folder: directories.create() }, NOW, { folder: o.folder }),
    ).rejects.toThrow(/--folder: .* is not under an --fs-root/);
    // An edit that does not name it keeps it; off removes it.
    const edited = await writeSchedule(o.repositories, { action: "update", scheduleId: "prices", prompt: "Again" }, NOW, {
      folder: o.folder,
    });
    expect(edited.folder).toBe(realpathSync(notes));
    const cleared = await writeSchedule(o.repositories, { action: "update", scheduleId: "prices", folder: null }, NOW, {
      folder: o.folder,
    });
    expect(cleared).not.toHaveProperty("folder");
  });

  it("needs a running owner to be set, takes only an absolute path, and is said by show", async () => {
    const directory = directories.create();
    const add = (extra: readonly string[]) => {
      const out = capture();
      return main(
        ["schedules", "add", "--name", "brief", "--at", "07:00", "--timezone", "UTC", "--prompt", "go", ...extra, "--data-dir", directory],
        { io: out.io },
      ).then((code) => ({ code, stderr: out.stderr() }));
    };
    const offline = await add(["--folder", "/tmp/notes"]);
    expect(offline.code).not.toBe(EXIT.ok);
    expect(offline.stderr).toMatch(/a schedule's folder needs a running owner/);
    expect(await add(["--folder", "notes"])).toMatchObject({
      code: EXIT.usage,
      stderr: expect.stringMatching(/--folder expects an absolute path/),
    });
    expect(await add(["--folder", "off"])).toMatchObject({ code: EXIT.usage, stderr: expect.stringMatching(/--folder off is for update/) });
    expect((await add([])).code).toBe(EXIT.ok);
    const shown = capture();
    await main(["schedules", "show", "brief", "--data-dir", directory], { io: shown.io });
    expect(shown.stdout()).toMatch(/ {2}folder {6}each run's own\n/);
  });
});
