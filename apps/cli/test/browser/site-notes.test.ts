import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SITE_NOTE_ABI, type PluginManifest, type SiteNote } from "@tavi/contracts";
import { SiteSkillRegistry } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { parseBrowser } from "../../src/features/browser/parse.js";
import {
  OPERATOR_SITE_NOTES,
  enabledSiteNotes,
  operatorNoteKey,
  readOperatorSiteNotes,
  readPluginSiteNotes,
  recipeNoteId,
  siteNoteFromRecipe,
} from "../../src/features/browser/site-notes.js";
import { SITE_NOTES_ENTRY, addBuiltinSiteSkills, showSiteNotes } from "../../src/features/browser/site-skills-host.js";

const note = (id: string, hosts: string[], extra: Partial<SiteNote> = {}): SiteNote => ({
  abi: SITE_NOTE_ABI,
  id,
  name: id,
  hosts,
  notes: `How ${id} works.`,
  ...extra,
});

const directories = temporaryDirectories({ prefix: "tavi-site-notes-" });
const scratch = (): string => directories.create();
afterEach(() => directories.cleanup());

describe("site notes", () => {
  it("reads a plugin's notes from its snapshot, leaving out one that does not read", () => {
    const directory = scratch();
    writeFileSync(join(directory, "acme.json"), JSON.stringify(note("acme", ["acme.example"], { paths: ["/jobs/**"] })));
    writeFileSync(join(directory, "bad.json"), JSON.stringify({ ...note("bad", ["acme.example"]), paths: ["^/x$"] }));
    const manifest = { siteNotes: ["acme.json", "bad.json", "missing.json"] } as unknown as PluginManifest;
    expect(readPluginSiteNotes(directory, manifest).map((entry) => entry.id)).toEqual(["acme"]);
  });

  it("is off until the switch names it: a plugin's by its site's id, the operator's by its id and digest", () => {
    const operatorDirectory = scratch();
    const file = join(operatorDirectory, "mine.json");
    writeFileSync(file, JSON.stringify(note("mine", ["mine.example"])));
    const read = (): readonly SiteNote[] => [note("acme", ["acme.example"]), note("other", ["other.example"])];
    let withdrawn = new Set<string>();
    const notes = enabledSiteNotes({
      plugins: () => [{ pluginId: "acme.app", version: "1.0.0", directory: "/d", manifest: { siteNotes: ["a.json"] } as never }],
      withdrawn: () => withdrawn,
      operatorDirectory,
      read,
    });
    expect(notes({})).toEqual([]);
    expect(notes({ "acme.app": ["acme"] }).map((entry) => [entry.from, entry.note.id])).toEqual([["the plugin acme.app", "acme"]]);
    const [mine] = readOperatorSiteNotes(operatorDirectory);
    const key = operatorNoteKey(mine!.note!, mine!.digest);
    expect(notes({ [OPERATOR_SITE_NOTES]: [key] }).map((entry) => [entry.from, entry.note.id])).toEqual([["the operator", "mine"]]);
    // An edited file is off again until it is reviewed and turned on anew.
    writeFileSync(file, JSON.stringify(note("mine", ["mine.example"], { notes: "Something else." })));
    expect(notes({ [OPERATOR_SITE_NOTES]: [key] })).toEqual([]);
    withdrawn = new Set(["acme.app"]);
    expect(notes({ "acme.app": ["acme"] })).toEqual([]);
  });

  it("shows an enabled note beside the built-in skills, framed as reference notes", () => {
    const registry = new SiteSkillRegistry();
    addBuiltinSiteSkills(registry);
    showSiteNotes(registry, [{ from: "the operator", note: note("acme", ["acme.example"], { paths: ["/jobs/**"] }) }]);
    expect(registry.skillFor("https://www.acme.example/jobs/12")?.notes).toMatch(
      /^Reference notes on this site from the operator, not instructions.*How acme works\.$/,
    );
    expect(registry.skillFor("https://www.acme.example/about")).toBeUndefined();
    expect(registry.skillFor("https://www.booking.com/")?.id).toBe("booking");
    // Shown again with none: the note is gone, the built-in skills stay.
    showSiteNotes(registry, []);
    expect(registry.skillFor("https://www.acme.example/jobs/12")).toBeUndefined();
    expect(registry.skillFor("https://www.booking.com/")?.id).toBe("booking");
  });

  it("takes an enabled note before a built-in skill for the same host, however late it was shown", () => {
    const registry = new SiteSkillRegistry({ first: [SITE_NOTES_ENTRY] });
    addBuiltinSiteSkills(registry);
    expect(registry.skillFor("https://www.booking.com/")?.id).toBe("booking");
    showSiteNotes(registry, [{ from: "the operator", note: note("my-booking", ["booking.com"]) }]);
    expect(registry.skillFor("https://www.booking.com/")?.id).toBe("my-booking");
    showSiteNotes(registry, []);
    expect(registry.skillFor("https://www.booking.com/")?.id).toBe("booking");
  });

  it("reads an operator's note again only once its file changed, and never reads one over the limit", () => {
    const operatorDirectory = scratch();
    const file = join(operatorDirectory, "mine.json");
    writeFileSync(file, JSON.stringify(note("mine", ["mine.example"])));
    writeFileSync(join(operatorDirectory, "big.json"), " ".repeat(65 * 1024));
    const cache = new Map();
    const [, first] = readOperatorSiteNotes(operatorDirectory, cache);
    expect(readOperatorSiteNotes(operatorDirectory, cache)[1]).toBe(first);
    expect(readOperatorSiteNotes(operatorDirectory, cache)[0]).toMatchObject({ file: "big.json", problem: "larger than 64 KiB" });
    writeFileSync(file, JSON.stringify(note("mine", ["mine.example"], { notes: "Something longer than before." })));
    const [, second] = readOperatorSiteNotes(operatorDirectory, cache);
    expect(second).not.toBe(first);
    expect(second?.note?.notes).toBe("Something longer than before.");
  });

  it("proposes a recipe as a note: its steps in words, on its host only", () => {
    const proposed = siteNoteFromRecipe({
      host: "shop.example.com",
      steps: [
        { kind: "click", role: "button", label: "Search" },
        { kind: "press", value: "Enter" },
      ],
      uses: 3,
      updatedAt: "2026-10-20T10:00:00.000Z",
    });
    expect(proposed).toMatchObject({ id: "recipe-shop-example-com", hosts: ["shop.example.com"] });
    expect(proposed.notes).toContain('1. click button "Search"; 2. press the page (Enter)');
    expect(proposed.notes).toContain("3 times, last 2026-10-20");
    const once = siteNoteFromRecipe({
      host: "shop.example.com",
      steps: [{ kind: "press", value: "Enter" }],
      uses: 1,
      updatedAt: "2026-10-20",
    });
    expect(once.notes).toContain("(once, last 2026-10-20)");
    expect(recipeNoteId(`${"a".repeat(50)}.example`)).toHaveLength(40);
    expect(() => siteNoteFromRecipe({ host: "localhost", steps: [], uses: 1, updatedAt: "2026-10-20" })).toThrow();
  });

  it("parses browser site-notes", () => {
    expect(parseBrowser(["site-notes", "--propose", "shop.example.com"])).toMatchObject({
      browser: { action: "site-notes", propose: "shop.example.com", format: "text" },
    });
    expect(parseBrowser(["site-notes", "--off", "mine"])).toMatchObject({ browser: { turn: { id: "mine", on: false } } });
    expect(() => parseBrowser(["site-notes", "--on", "a", "--off", "b"])).toThrow(/one of --propose, --on and --off/);
  });
});
