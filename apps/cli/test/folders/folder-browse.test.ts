import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { FOLDER_BROWSE_MAX_DEPTH, FOLDER_BROWSE_MAX_ENTRIES, type BrowseAnswer } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { FolderPicks, browseCommand } from "../../src/features/folders/owner.js";

/**
 * `browse`'s bounds and exclusions, over a
 * stub of `ChatFolders` that refuses what the owner's would: a path under
 * `refused/` (standing in for the data directory or a credential home) and a
 * path with a glob character.
 */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

function layout(): { readonly root: string; readonly outside: string } {
  const base = realpathSync(directories.create("tavi-browse-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return { root, outside };
}

function browser(root: string) {
  const picks = new FolderPicks();
  const deps = {
    picks,
    principalOf: () => "operator",
    folders: {
      attachableRoots: () => [root],
      refusalOf: (real: string) =>
        real.includes(`${join(root, "refused")}`) ? "is refused" : /[*?[\]]/.test(real) ? "has a glob character" : undefined,
    },
  };
  const browse = async (under?: string): Promise<BrowseAnswer> => {
    const answer = await browseCommand(deps as unknown as Parameters<typeof browseCommand>[0], {
      workspaceId: "default",
      ...(under === undefined ? {} : { under }),
    });
    if (!answer.ok) throw new Error(`${answer.error.code}: ${answer.error.message}`);
    return answer.result;
  };
  return { picks, browse };
}

describe("browse", () => {
  it("leaves out refused folders, glob-character folders, hidden folders — by name or through a link — and links out of every root", async () => {
    const { root, outside } = layout();
    for (const name of ["plain", "refused", "a[1]", ".hidden"]) mkdirSync(join(root, name));
    symlinkSync(join(root, ".hidden"), join(root, "notes"));
    symlinkSync(outside, join(root, "away"));
    symlinkSync(join(root, "refused"), join(root, "back-door"));
    symlinkSync(join(root, "plain"), join(root, "shortcut"));
    const { browse } = browser(root);
    const top = await browse();
    const inside = await browse(top.entries[0]?.token);
    expect(inside.entries.map((entry) => [entry.name, entry.path])).toEqual([
      ["plain", join(root, "plain")],
      ["plain", join(root, "plain")],
    ]);
  });

  it("opens folders at most FOLDER_BROWSE_MAX_DEPTH below a root, and lists at most FOLDER_BROWSE_MAX_ENTRIES", async () => {
    const { root } = layout();
    let deepest = root;
    for (let depth = 0; depth < FOLDER_BROWSE_MAX_DEPTH; depth += 1) {
      deepest = join(deepest, `d${depth}`);
      mkdirSync(deepest);
    }
    const { browse } = browser(root);
    let answer = await browse(); // the root
    answer = await browse(answer.entries[0]?.token);
    for (let depth = 1; depth < FOLDER_BROWSE_MAX_DEPTH; depth += 1) {
      expect(answer.entries[0]?.opens).toBe(true);
      answer = await browse(answer.entries[0]?.token);
    }
    // The folder FOLDER_BROWSE_MAX_DEPTH below the root may be picked, not opened.
    expect(answer.at?.path).toBe(join(root, ...Array.from({ length: FOLDER_BROWSE_MAX_DEPTH - 1 }, (_, index) => `d${index}`)));
    expect(answer.entries[0]).toMatchObject({ path: deepest, opens: false });
    await expect(browse(answer.entries[0]?.token)).rejects.toThrow(/INVALID_INPUT: The picker goes at most/);

    const { root: wide } = layout();
    for (let index = 0; index <= FOLDER_BROWSE_MAX_ENTRIES; index += 1) mkdirSync(join(wide, `f${String(index).padStart(4, "0")}`));
    const many = browser(wide);
    const listed = await many.browse((await many.browse()).entries[0]?.token);
    expect(listed.entries).toHaveLength(FOLDER_BROWSE_MAX_ENTRIES);
    expect(listed.truncated).toBe(true);
  });

  it("forgets the oldest token past its bound, and redeems nothing it did not issue", () => {
    const picks = new FolderPicks();
    const first = picks.issue("/first");
    expect(picks.redeem(first)).toBe("/first");
    for (let index = 0; index < 4_096; index += 1) picks.issue(`/p${index}`);
    expect(picks.redeem(first)).toBeUndefined();
    expect(new FolderPicks().redeem(picks.issue("/x"))).toBeUndefined();
  });
});
