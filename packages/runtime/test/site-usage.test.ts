import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import { readPluginSiteProfiles, validatePluginDirectory } from "../src/plugins/registry.js";
import { SqliteStore } from "../src/persistence/store.js";

const directories = temporaryDirectories();
afterEach(() => {
  directories.cleanup();
});
const temp = (prefix: string): string => {
  return directories.create(prefix);
};

function usage() {
  return new SqliteStore({ databasePath: ":memory:", inMemory: true, artifactsDirectory: temp("tavi-site-usage-") }).asPort().repositories
    .siteUsage;
}

describe("site usage", () => {
  it("counts a profile's pages per workspace and day up to its limit, and no further", () => {
    const repository = usage();
    const take = (day: string, workspaceId = "w1") =>
      repository.take({ workspaceId, profile: "acme.jobs/board", day, counter: "pages", limit: 2 });
    expect(take("2026-10-17")).toEqual({ ok: true, usage: { pages: 1, finalSteps: 0 } });
    expect(take("2026-10-17").ok).toBe(true);
    expect(take("2026-10-17")).toEqual({ ok: false, usage: { pages: 2, finalSteps: 0 } });
    // Another day, another workspace: their own counts.
    expect(take("2026-10-18").ok).toBe(true);
    expect(take("2026-10-17", "w2").ok).toBe(true);
    expect(repository.take({ workspaceId: "w1", profile: "acme.jobs/board", day: "2026-10-17", counter: "finalSteps", limit: 1 })).toEqual({
      ok: true,
      usage: { pages: 2, finalSteps: 1 },
    });
    expect(repository.prune("2026-10-18")).toBe(2);
    expect(repository.get("w1", "acme.jobs/board", "2026-10-17")).toEqual({ pages: 0, finalSteps: 0 });
  });

  it("never counts against a limit of zero", () => {
    expect(usage().take({ workspaceId: "w1", profile: "p", day: "2026-10-17", counter: "pages", limit: 0 })).toEqual({
      ok: false,
      usage: { pages: 0, finalSteps: 0 },
    });
  });
});

describe("a plugin's site profiles at install", () => {
  const site = {
    abi: "tavi.sites/1",
    id: "board",
    name: "Board",
    countries: ["*"],
    hosts: ["board.example"],
    kind: "jobs-board",
    access: { mode: "read", reason: "Public", termsUrl: "https://board.example/terms", reviewedAt: "2026-10-17" },
    notes: "",
  };
  function plugin(sites: Record<string, unknown>): string {
    const directory = temp("tavi-site-plugin-");
    writeFileSync(join(directory, "index.mjs"), "export function register() {}\n");
    mkdirSync(join(directory, "sites"));
    for (const [name, content] of Object.entries(sites))
      writeFileSync(join(directory, "sites", name), typeof content === "string" ? content : JSON.stringify(content));
    writeFileSync(
      join(directory, "tavi-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "bundled-esm", packages: [] },
        id: "acme.sites",
        version: "1.0.0",
        name: "Sites",
        description: "Sites",
        entry: "index.mjs",
        sites: Object.keys(sites).map((name) => `sites/${name}`),
      }),
    );
    return directory;
  }

  it("checks each profile is there and is a tavi.sites/1 profile, and reads them back", () => {
    const directory = plugin({ "board.json": site });
    expect(validatePluginDirectory(directory).manifest.sites).toEqual(["sites/board.json"]);
    expect(readPluginSiteProfiles(directory).map((profile) => profile.id)).toEqual(["board"]);
    expect(() =>
      validatePluginDirectory(plugin({ "board.json": { ...site, access: { ...site.access, mode: "read", navigate: false } } })),
    ).toThrow(/not a tavi.sites\/1 profile/);
    expect(() => validatePluginDirectory(plugin({ "board.json": "{" }))).toThrow(/is not JSON/);
    expect(() => validatePluginDirectory(plugin({ "a.json": site, "b.json": site }))).toThrow(/two site profiles are named board/);
  });

  it("checks each site note the same way: there, a tavi.sitenotes/1 note, and the only one of its id", () => {
    const note = { abi: "tavi.sitenotes/1", id: "board-notes", name: "Board", hosts: ["board.example"], notes: "Search from the box." };
    const withNotes = (notes: Record<string, unknown>, listed = Object.keys(notes)): string => {
      const directory = plugin({ "board.json": site });
      mkdirSync(join(directory, "notes"));
      for (const [name, content] of Object.entries(notes))
        writeFileSync(join(directory, "notes", name), typeof content === "string" ? content : JSON.stringify(content));
      const manifestPath = join(directory, "tavi-plugin.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, siteNotes: listed.map((name) => `notes/${name}`) }));
      return directory;
    };
    expect(validatePluginDirectory(withNotes({ "a.json": note })).manifest.siteNotes).toEqual(["notes/a.json"]);
    expect(() => validatePluginDirectory(withNotes({}, ["missing.json"]))).toThrow(/site note notes\/missing.json does not exist/);
    expect(() => validatePluginDirectory(withNotes({ "a.json": "{" }))).toThrow(/site note notes\/a.json is not JSON/);
    expect(() => validatePluginDirectory(withNotes({ "a.json": { ...note, paths: ["^/x"] } }))).toThrow(/not a tavi.sitenotes\/1 note/);
    expect(() => validatePluginDirectory(withNotes({ "a.json": note, "b.json": note }))).toThrow(/two site notes are named board-notes/);
  });
});
