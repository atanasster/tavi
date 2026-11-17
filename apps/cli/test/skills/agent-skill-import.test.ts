import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import type * as Fs from "node:fs";
import { join } from "node:path";

import { SkillService, ToolRegistry } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it, vi } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { readAgentSkillPackage, skillFrontmatter } from "../../src/features/skills/bundle.js";
import { SKILLS_READ_ID, registerSkillTools } from "../../src/features/skills/tools.js";
import { SqliteStore } from "../support/database-fixture.js";
import { zip } from "../support/zip.js";

/** A file that grows after its stat: `fstatSync` reports it as `size` bytes, while it holds more; `read` counts the bytes read. */
const statLie = vi.hoisted(() => ({ size: undefined as number | undefined, read: 0 }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof Fs>();
  const fstatSync = ((fd: number) => {
    const stat = fs.fstatSync(fd);
    return statLie.size === undefined ? stat : Object.assign(stat, { size: statLie.size });
  }) as typeof fs.fstatSync;
  const readSync = ((...args: Parameters<typeof fs.readSync>) => {
    const read = fs.readSync(...args);
    statLie.read += read;
    return read;
  }) as typeof fs.readSync;
  return { ...fs, default: { ...fs, fstatSync, readSync }, fstatSync, readSync };
});

/** `tavi skills import <folder|SKILL.md|zip>`: an Agent Skills package, read strictly, stored as one bundle, its scripts never run. */

const directories = temporaryDirectories({ prefix: "tavi-agent-skill-" });
afterAll(() => directories.cleanup());

const SKILL = `---
name: release-notes
description: How we write release notes
metadata:
  version: 1.2.0
allowed-tools:
  - Read
  - Bash(git log:*)
compatibility: Claude Code, Tavi
---
# Release notes

Read references/style.md first.
`;

function packageFolder(extra: (root: string) => void = () => {}): string {
  const root = join(directories.create(), "release-notes");
  mkdirSync(join(root, "references"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "SKILL.md"), SKILL);
  writeFileSync(join(root, "references", "style.md"), "Headings: Added, Fixed, Changed.");
  writeFileSync(join(root, "scripts", "collect.sh"), "#!/bin/sh\ngit log --oneline\n");
  extra(root);
  return root;
}

describe("Agent Skills packages", () => {
  it("reads the frontmatter's name, version, allowed-tools as a list or a line, and compatibility", () => {
    expect(skillFrontmatter(SKILL)).toMatchObject({
      name: "release-notes",
      metadata: { version: "1.2.0" },
      "allowed-tools": ["Read", "Bash(git log:*)"],
      compatibility: "Claude Code, Tavi",
    });
    const read = readAgentSkillPackage(packageFolder());
    expect(read).toMatchObject({
      skillId: "release-notes",
      version: "1.2.0",
      allowedTools: ["Read", "Bash(git log:*)"],
      files: ["SKILL.md", "references/style.md", "scripts/collect.sh"],
    });
    // The same files are the same bytes: the bundle is deterministic.
    expect(readAgentSkillPackage(packageFolder()).text).toBe(read.text);
  });

  it("reads a block description (folded or kept) and a flow list of allowed-tools", () => {
    const text =
      "---\nname: notes\ndescription: >-\n  Writes release\n  notes well\nusage: |\n  one\n  two\nallowed-tools: [Read, Grep]\n---\nBody";
    expect(skillFrontmatter(text)).toMatchObject({ name: "notes", description: "Writes release notes well", usage: "one\ntwo" });
    const root = join(directories.create(), "notes");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "SKILL.md"), text);
    expect(readAgentSkillPackage(root)).toMatchObject({ description: "Writes release notes well", allowedTools: ["Read", "Grep"] });
  });

  it("refuses a symbolic link, a package without SKILL.md, and one of more than 32 files", () => {
    expect(() => readAgentSkillPackage(packageFolder((root) => symlinkSync("/etc/hosts", join(root, "references", "hosts"))))).toThrow(
      /symbolic link/,
    );
    const bare = directories.create();
    writeFileSync(join(bare, "README.md"), "no skill");
    expect(() => readAgentSkillPackage(bare)).toThrow(/no SKILL.md/);
    expect(() =>
      readAgentSkillPackage(
        packageFolder((root) => {
          for (let index = 0; index < 32; index += 1) writeFileSync(join(root, "references", `${index}.md`), "x");
        }),
      ),
    ).toThrow(/more than 32 files/);
  });

  it("sizes each file before reading it, against a running total, and a zip and a lone SKILL.md before reading them", () => {
    // Each file is under the cap; together they pass it, and the import fails on the file that crosses it.
    const filler = "x".repeat(200 * 1024);
    statLie.read = 0;
    expect(() =>
      readAgentSkillPackage(
        packageFolder((root) => {
          for (let index = 0; index < 3; index += 1) writeFileSync(join(root, "references", `${index}.md`), filler);
        }),
      ),
    ).toThrow(/over 512 KiB/);
    // The third file was read only to one byte past what the package had left, never whole.
    expect(statLie.read).toBeLessThanOrEqual(512 * 1024 + 1);
    expect(() =>
      readAgentSkillPackage(packageFolder((root) => writeFileSync(join(root, "references", "big.md"), "x".repeat(513 * 1024)))),
    ).toThrow(/over 512 KiB/);
    const lone = join(directories.create(), "SKILL.md");
    writeFileSync(lone, SKILL + "x".repeat(513 * 1024));
    expect(() => readAgentSkillPackage(lone)).toThrow(/over 512 KiB/);
    // A zip over its own cap is refused by its size, before it is read and unpacked.
    const big = join(directories.create(), "big.zip");
    writeFileSync(big, Buffer.alloc(1024 * 1024 + 1));
    expect(() => readAgentSkillPackage(big)).toThrow(/the zip is over 1024 KiB/);
  });

  it("reads no further than the cap when a file grows after its stat", () => {
    const root = packageFolder((folder) => writeFileSync(join(folder, "references", "grows.md"), "x".repeat(600 * 1024)));
    statLie.size = 10;
    statLie.read = 0;
    try {
      expect(() => readAgentSkillPackage(root)).toThrow(/over 512 KiB/);
      // The 600 KiB file was read only to one byte past what the package had left.
      expect(statLie.read).toBeLessThanOrEqual(512 * 1024 + 1);
    } finally {
      statLie.size = undefined;
    }
    // Within the cap, the bytes read are the file's, whatever its stat said.
    statLie.size = 1;
    try {
      expect(readAgentSkillPackage(packageFolder()).files).toContain("references/style.md");
    } finally {
      statLie.size = undefined;
    }
  });

  it("reads a zip whose files sit in one top folder, beside what macOS adds, and keeps a binary file as bytes", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const path = join(directories.create(), "release-notes.zip");
    writeFileSync(
      path,
      zip([
        { name: "release-notes/SKILL.md", data: SKILL },
        { name: "release-notes/references/style.md", data: "Headings: Added, Fixed, Changed." },
        { name: "release-notes/assets/logo.png", data: png },
        { name: "__MACOSX/release-notes/._SKILL.md", data: "junk" },
        { name: "release-notes/.DS_Store", data: "junk" },
      ]),
    );
    const read = readAgentSkillPackage(path);
    expect(read.files).toEqual(["SKILL.md", "assets/logo.png", "references/style.md"]);
    const bundle = JSON.parse(read.text) as { files: { path: string; text?: string; base64?: string }[] };
    expect(bundle.files.find((file) => file.path === "assets/logo.png")).toEqual({
      path: "assets/logo.png",
      base64: png.toString("base64"),
    });
  });

  it("names a mistyped path as missing, rather than asking for --package", async () => {
    const directory = directories.create();
    const captured = capture();
    const code = await main(["skills", "import", join(directory, "no-such-skill"), "--data-dir", directory], { io: captured.io });
    expect(code).not.toBe(EXIT.ok);
    expect(captured.stderr()).toContain("no such folder, SKILL.md or .zip");
    expect(captured.stderr()).not.toContain("--package");
  });

  it("names a missing --package file as a usage error, not an internal one", async () => {
    const directory = directories.create();
    for (const action of [
      ["import", "release-notes", "--version", "3.0.0", "--name", "Release notes", "--provenance", "team wiki"],
      ["edit", "release-notes", "--version", "3.0.0"],
    ]) {
      const captured = capture();
      const missing = join(directory, "release-notes-3.md");
      const code = await main(["skills", ...action, "--package", missing, "--data-dir", directory], { io: captured.io });
      expect(code).toBe(EXIT.usage);
      expect(captured.stderr()).toBe(`no such file: ${missing}\n`);
    }
  });

  it("shows a one-file package's SKILL.md as lines when approving and with show --body, not as its stored bundle", async () => {
    const directory = directories.create();
    const root = join(directories.create(), "notes");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "SKILL.md"),
      "---\nname: notes\ndescription: Notes\nmetadata:\n  version: 1.0.0\n---\n1. Start with one line.\n",
    );
    const run = async (args: string[]) => {
      const captured = capture();
      const code = await main(["skills", ...args, "--data-dir", directory], { io: captured.io });
      return { code, stdout: captured.stdout(), stderr: captured.stderr() };
    };
    expect((await run(["import", root, "--provenance", "my own notes"])).code).toBe(EXIT.ok);
    const approved = await run(["approve", "notes", "--version", "1.0.0"]);
    expect(approved.code, approved.stderr).toBe(EXIT.ok);
    for (const shown of [approved.stderr, (await run(["show", "notes", "--body", "--version", "1.0.0"])).stdout]) {
      expect(shown).toContain("--- SKILL.md\n---\nname: notes\n");
      expect(shown).toContain("\n1. Start with one line.");
      expect(shown).not.toContain("tavi-skill-bundle");
    }
  });

  it("approves and activates a skill's only version without --version, and asks for one when there are two (Mac mini tests)", async () => {
    const directory = directories.create();
    const write = (version: string) => {
      const root = join(directories.create(), "notes");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "SKILL.md"), `---\nname: notes\ndescription: Notes\nmetadata:\n  version: ${version}\n---\n1. Start.\n`);
      return root;
    };
    const run = async (args: string[]) => {
      const captured = capture();
      const code = await main(["skills", ...args, "--data-dir", directory], { io: captured.io });
      return { code, stdout: captured.stdout(), stderr: captured.stderr() };
    };
    expect((await run(["import", write("1.0.0"), "--provenance", "my own notes"])).code).toBe(EXIT.ok);
    // Nothing approved yet: activate says what there is.
    const early = await run(["activate", "notes"]);
    expect(early.code).toBe(EXIT.usage);
    expect(early.stderr).toContain("notes has no approved version: its versions are 1.0.0 (proposed)");
    const approved = await run(["approve", "notes"]);
    expect(approved.code, approved.stderr).toBe(EXIT.ok);
    expect(approved.stdout).toContain("notes@1.0.0 approved");
    const active = await run(["activate", "notes"]);
    expect(active.code, active.stderr).toBe(EXIT.ok);
    expect(active.stdout).toContain("notes@1.0.0 is active");
    // Two proposed versions: which is meant is the person's to say.
    expect((await run(["import", write("1.1.0"), "--provenance", "my own notes"])).code).toBe(EXIT.ok);
    expect((await run(["import", write("1.2.0"), "--provenance", "my own notes"])).code).toBe(EXIT.ok);
    const two = await run(["reject", "notes"]);
    expect(two.code).toBe(EXIT.usage);
    expect(two.stderr).toContain("notes has 2 proposed versions (");
    expect(two.stderr).toContain("name one with --version");
  });

  it("imports a folder with tavi skills import, and skills.read serves SKILL.md, then a reference by path", async () => {
    const directory = directories.create();
    const run = async (args: string[]) => {
      const captured = capture();
      const code = await main(["skills", ...args, "--data-dir", directory], { io: captured.io });
      return { code, stdout: captured.stdout(), stderr: captured.stderr() };
    };
    const imported = await run(["import", packageFolder(), "--format", "json"]);
    expect(imported.code, imported.stderr).toBe(EXIT.ok);
    expect(JSON.parse(imported.stdout)).toMatchObject({
      skillId: "release-notes",
      version: "1.2.0",
      manifest: { allowedTools: ["Read", "Bash(git log:*)"] },
    });
    // Imported without --provenance it is someone else's package: approved only once read, with --yes.
    expect(JSON.parse(imported.stdout)).toMatchObject({ provenance: "archive:release-notes" });
    const said = await run(["import", packageFolder()]);
    expect(said.stdout).toBe(
      [
        "release-notes@1.2.0 imported: proposed, from archive:release-notes",
        "files: SKILL.md, references/style.md, scripts/collect.sh",
        "allowed-tools (a ceiling, not a grant): Read, Bash(git log:*)",
        "read it with tavi skills show release-notes --body --version 1.2.0",
        "",
      ].join("\n"),
    );
    const unread = await run(["approve", "release-notes", "--version", "1.2.0"]);
    expect(unread.code).toBe(EXIT.usage);
    expect(unread.stderr).toContain("approve it with --yes");
    const approved = await run(["approve", "release-notes", "--version", "1.2.0", "--yes"]);
    expect(approved.code, approved.stderr).toBe(EXIT.ok);
    expect(approved.stderr).toContain("allowed-tools (a ceiling, not a grant): Read, Bash(git log:*)");
    expect(approved.stderr).toContain("--- scripts/collect.sh");
    expect((await run(["activate", "release-notes", "--version", "1.2.0"])).code).toBe(EXIT.ok);

    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    const registry = new ToolRegistry();
    const port = store.asPort();
    registerSkillTools(registry, { skills: port.repositories.skills, rollout: port.repositories.skillRollout, artifacts: store });
    const read = async (input: unknown) =>
      (await registry.get(SKILLS_READ_ID)?.handler({
        input,
        context: { workspaceId: "default", principalId: "operator", runId: "task-1", caller: "test" },
        signal: new AbortController().signal,
      })) as Record<string, unknown>;
    const main_ = await read({ skillId: "release-notes" });
    expect(main_["text"]).toContain("# Release notes");
    expect(main_["files"]).toEqual(["SKILL.md", "references/style.md", "scripts/collect.sh"]);
    expect((await read({ skillId: "release-notes", path: "references/style.md" }))["text"]).toBe("Headings: Added, Fixed, Changed.");
    await expect(read({ skillId: "release-notes", path: "nope.md" })).rejects.toThrow(/has no file nope.md/);
    store.close();
    // SkillService reads the stored bundle as one package: what a routine pins.
    expect(SkillService).toBeDefined();
  });

  it("flags a new version that widens allowed-tools as an escalation, and an unknown name as not enforceable here", async () => {
    const directory = directories.create();
    const run = async (args: string[]) => {
      const captured = capture();
      const code = await main(["skills", ...args, "--data-dir", directory], { io: captured.io });
      return { code, stdout: captured.stdout(), stderr: captured.stderr() };
    };
    expect((await run(["import", packageFolder()])).code).toBe(EXIT.ok);
    expect((await run(["approve", "release-notes", "--version", "1.2.0", "--yes"])).code).toBe(EXIT.ok);
    expect((await run(["activate", "release-notes", "--version", "1.2.0"])).code).toBe(EXIT.ok);
    const wider = packageFolder((root) =>
      writeFileSync(
        join(root, "SKILL.md"),
        SKILL.replace("version: 1.2.0", "version: 1.3.0").replace("  - Read\n", "  - Read\n  - Write\n  - Frobnicate\n"),
      ),
    );
    expect((await run(["import", wider])).code).toBe(EXIT.ok);
    const shown = await run(["show", "release-notes", "--body", "--version", "1.3.0"]);
    expect(shown.code, shown.stderr).toBe(EXIT.ok);
    expect(shown.stdout).toContain("! Escalation: this version widens allowed-tools, adding Write, Frobnicate (since 1.2.0)");
    expect(shown.stdout).toContain("Frobnicate (declared but not enforceable here)");
    // The version in force widens nothing against itself.
    const active = await run(["show", "release-notes", "--body", "--version", "1.2.0"]);
    expect(active.stdout).not.toContain("Escalation");
  });
});
