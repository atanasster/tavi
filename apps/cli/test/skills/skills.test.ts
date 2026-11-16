import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { acquireDataDirectoryOwnership } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";

/**
 * `tavi skills`: the CLI surface for approved versioned skills.
 */

const directories = temporaryDirectories({ prefix: "tavi-skills-cli-" });

afterAll(() => directories.cleanup());

function packageFile(directory: string, contents: string): string {
  const path = join(directory, "package.bin");
  writeFileSync(path, contents);
  return path;
}

describe("tavi skills", () => {
  it("imports a version (enters proposed), approves it, activates it, and shows it", async () => {
    const directory = directories.create();
    const pkg = packageFile(directory, "package v1");

    const imported = capture();
    const importCode = await main(
      [
        "skills",
        "import",
        "reporting",
        "--version",
        "1.0.0",
        "--package",
        pkg,
        "--name",
        "Reporting helper",
        "--provenance",
        "operator upload",
        "--format",
        "json",
        "--data-dir",
        directory,
      ],
      { io: imported.io },
    );
    expect(importCode, imported.stderr()).toBe(EXIT.ok);
    const version = JSON.parse(imported.stdout()) as { skillId: string; version: string; reviewState: string };
    expect(version.reviewState).toBe("proposed");

    const approved = capture();
    expect(
      await main(["skills", "approve", "reporting", "--version", "1.0.0", "--format", "json", "--data-dir", directory], {
        io: approved.io,
      }),
    ).toBe(EXIT.ok);
    expect((JSON.parse(approved.stdout()) as { reviewState: string }).reviewState).toBe("approved");

    const activated = capture();
    expect(
      await main(["skills", "activate", "reporting", "--version", "1.0.0", "--format", "json", "--data-dir", directory], {
        io: activated.io,
      }),
    ).toBe(EXIT.ok);
    expect((JSON.parse(activated.stdout()) as { activeVersion: string }).activeVersion).toBe("1.0.0");

    const shown = capture();
    expect(await main(["skills", "show", "reporting", "--format", "json", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    const document = JSON.parse(shown.stdout()) as { versions: unknown[]; activation: { activeVersion: string } };
    expect(document.versions).toHaveLength(1);
    expect(document.activation.activeVersion).toBe("1.0.0");
  });

  it("answers import, approve, activate, show and reject in readable lines by default, and JSON with --format json", async () => {
    const directory = directories.create();
    const pkg = packageFile(directory, "package v1");
    const run = async (args: string[]) => {
      const captured = capture();
      const code = await main(["skills", ...args, "--data-dir", directory], { io: captured.io });
      expect(code, captured.stderr()).toBe(EXIT.ok);
      return captured.stdout();
    };
    const manifest = ["--package", pkg, "--name", "Release notes", "--provenance", "my own notes"];
    expect(await run(["import", "release-notes", "--version", "1.0.0", ...manifest])).toBe(
      "release-notes@1.0.0 imported: proposed, from my own notes\nread it with tavi skills show release-notes --body --version 1.0.0\n",
    );
    expect(await run(["approve", "release-notes", "--version", "1.0.0"])).toBe(
      "release-notes@1.0.0 approved. Make it active with tavi skills activate release-notes --version 1.0.0\n",
    );
    expect(await run(["activate", "release-notes", "--version", "1.0.0"])).toMatch(
      /^release-notes@1\.0\.0 is active, since \w{3}, \d\d\/\d\d\/\d{4}, \d\d:\d\d\n$/,
    );
    // Other bytes: the same text approved before would be approved on import.
    writeFileSync(pkg, "package v2");
    await run(["import", "release-notes", "--version", "2.0.0", ...manifest]);
    expect(await run(["reject", "release-notes", "--version", "2.0.0"])).toBe("release-notes@2.0.0 rejected\n");
    const shown = await run(["show", "release-notes"]);
    expect(shown).not.toMatch(/[{}]|\d{4}-\d\d-\d\dT/);
    expect(shown.split("\n")).toEqual([
      "release-notes (Release notes): 1.0.0 active",
      expect.stringMatching(/^ {2}2\.0\.0\trejected\timported \w{3}, .+, from my own notes$/),
      expect.stringMatching(/^ {2}1\.0\.0\tapproved\timported \w{3}, .+, from my own notes$/),
      "history:",
      expect.stringMatching(/^ {2}\w{3}, .+ · Activated 1\.0\.0 · operator$/),
      "",
    ]);
    expect(JSON.parse(await run(["show", "release-notes", "--format", "json"]))).toMatchObject({ activation: { activeVersion: "1.0.0" } });
  });

  it("lists skill versions, defaulting to text output", async () => {
    const directory = directories.create();
    const pkg = packageFile(directory, "package v1");
    await main(
      [
        "skills",
        "import",
        "reporting",
        "--version",
        "1.0.0",
        "--package",
        pkg,
        "--name",
        "Reporting helper",
        "--provenance",
        "x",
        "--data-dir",
        directory,
      ],
      { io: capture().io },
    );
    const listed = capture();
    expect(await main(["skills", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stdout()).toContain("reporting");
    expect(listed.stdout()).toContain("proposed");
    expect(listed.stdout()).toContain("never used");
    expect(listed.stdout()).not.toContain("supported");
  });

  it("refuses to activate an unapproved version, and refuses rollback to a version never active", async () => {
    const directory = directories.create();
    const pkg1 = packageFile(directory, "v1");
    await main(
      [
        "skills",
        "import",
        "reporting",
        "--version",
        "1.0.0",
        "--package",
        pkg1,
        "--name",
        "x",
        "--provenance",
        "x",
        "--data-dir",
        directory,
      ],
      { io: capture().io },
    );
    const activateUnapproved = capture();
    const code = await main(["skills", "activate", "reporting", "--version", "1.0.0", "--data-dir", directory], {
      io: activateUnapproved.io,
    });
    expect(code).toBe(EXIT.usage);

    await main(["skills", "approve", "reporting", "--version", "1.0.0", "--data-dir", directory], { io: capture().io });
    await main(["skills", "activate", "reporting", "--version", "1.0.0", "--data-dir", directory], { io: capture().io });

    // A second, real, approved version that was never activated: rollback
    // must refuse it distinctly from "no such version at all" (NOT_FOUND).
    const pkg2 = packageFile(directory, "v2");
    await main(
      [
        "skills",
        "import",
        "reporting",
        "--version",
        "2.0.0",
        "--package",
        pkg2,
        "--name",
        "x",
        "--provenance",
        "x",
        "--data-dir",
        directory,
      ],
      { io: capture().io },
    );
    await main(["skills", "approve", "reporting", "--version", "2.0.0", "--data-dir", directory], { io: capture().io });

    const rollbackNeverActive = capture();
    const rollbackCode = await main(["skills", "rollback", "reporting", "--version", "2.0.0", "--data-dir", directory], {
      io: rollbackNeverActive.io,
    });
    expect(rollbackCode, rollbackNeverActive.stderr()).toBe(EXIT.usage);
  });

  it("scopes skills by workspace", async () => {
    const directory = directories.create();
    const pkg = packageFile(directory, "v1");
    await main(
      [
        "skills",
        "import",
        "reporting",
        "--version",
        "1.0.0",
        "--package",
        pkg,
        "--name",
        "x",
        "--provenance",
        "x",
        "--workspace",
        "w1",
        "--data-dir",
        directory,
      ],
      { io: capture().io },
    );
    const otherWorkspace = capture();
    expect(
      await main(["skills", "list", "--workspace", "w2", "--format", "json", "--data-dir", directory], { io: otherWorkspace.io }),
    ).toBe(EXIT.ok);
    expect(JSON.parse(otherWorkspace.stdout())).toEqual([]);
  });

  it("refuses to re-import the same version with different bytes", async () => {
    const directory = directories.create();
    const pkgA = packageFile(directory, "package v1");
    await main(
      [
        "skills",
        "import",
        "reporting",
        "--version",
        "1.0.0",
        "--package",
        pkgA,
        "--name",
        "x",
        "--provenance",
        "x",
        "--data-dir",
        directory,
      ],
      { io: capture().io },
    );
    const pkgB = packageFile(directory, "different bytes");
    const captured = capture();
    const code = await main(
      [
        "skills",
        "import",
        "reporting",
        "--version",
        "1.0.0",
        "--package",
        pkgB,
        "--name",
        "x",
        "--provenance",
        "x",
        "--data-dir",
        directory,
      ],
      { io: captured.io },
    );
    expect(code, captured.stderr()).toBe(EXIT.usage);
    expect(captured.stderr()).toMatch(/immutable/);
  });

  it("re-importing identical bytes is idempotent", async () => {
    const directory = directories.create();
    const pkg = packageFile(directory, "package v1");
    const first = capture();
    await main(
      [
        "skills",
        "import",
        "reporting",
        "--version",
        "1.0.0",
        "--package",
        pkg,
        "--name",
        "x",
        "--provenance",
        "x",
        "--format",
        "json",
        "--data-dir",
        directory,
      ],
      { io: first.io },
    );
    const second = capture();
    const code = await main(
      [
        "skills",
        "import",
        "reporting",
        "--version",
        "1.0.0",
        "--package",
        pkg,
        "--name",
        "x",
        "--provenance",
        "x",
        "--format",
        "json",
        "--data-dir",
        directory,
      ],
      { io: second.io },
    );
    expect(code, second.stderr()).toBe(EXIT.ok);
    expect(JSON.parse(second.stdout())).toEqual(JSON.parse(first.stdout()));
  });

  it("reports a sensible failure when --package points at a missing file", async () => {
    const directory = directories.create();
    const captured = capture();
    const code = await main(
      [
        "skills",
        "import",
        "reporting",
        "--version",
        "1.0.0",
        "--package",
        join(directory, "does-not-exist.bin"),
        "--name",
        "x",
        "--provenance",
        "x",
        "--data-dir",
        directory,
      ],
      { io: captured.io },
    );
    expect(code).not.toBe(EXIT.ok);
    expect(captured.stderr()).toMatch(/ENOENT|no such file/i);
  });

  it("shows a version's text, rejects and disables, and approves another author's skill only with --yes", async () => {
    const directory = directories.create();
    const run = async (args: string[]) => {
      const captured = capture();
      const code = await main(["skills", ...args, "--data-dir", directory], { io: captured.io });
      return { code, stdout: captured.stdout(), stderr: captured.stderr() };
    };
    const importAs = async (skillId: string, version: string, text: string, provenance: string) =>
      await run([
        "import",
        skillId,
        "--version",
        version,
        "--package",
        packageFile(directory, text),
        "--name",
        `${skillId} helper`,
        "--provenance",
        provenance,
      ]);
    expect((await importAs("mine", "1.0.0", "my steps", "team wiki")).code).toBe(EXIT.ok);
    const approved = await run(["approve", "mine", "--version", "1.0.0"]);
    expect(approved.code, approved.stderr).toBe(EXIT.ok);
    expect(approved.stderr).toContain("my steps");
    expect(approved.stderr).toMatch(/sha256 [0-9a-f]{64}/);
    expect((await run(["activate", "mine", "--version", "1.0.0"])).code).toBe(EXIT.ok);
    const shown = await run(["show", "mine", "--body"]);
    expect(shown.code, shown.stderr).toBe(EXIT.ok);
    expect(shown.stdout).toContain("mine@1.0.0 (approved)");
    expect(shown.stdout).toContain("my steps");
    expect((await run(["disable", "mine"])).code).toBe(EXIT.ok);
    expect((await run(["show", "mine", "--body"])).stderr).toContain("has no active version");

    expect((await importAs("proposed", "1.0.0", "a chat's steps", "chat:task-9")).code).toBe(EXIT.ok);
    const asked = await run(["approve", "proposed", "--version", "1.0.0"]);
    expect(asked.code).toBe(EXIT.usage);
    expect(asked.stderr).toContain("approve it with --yes");
    expect((await run(["approve", "proposed", "--version", "1.0.0", "--yes"])).code).toBe(EXIT.ok);

    expect((await importAs("unwanted", "1.0.0", "no thanks", "team wiki")).code).toBe(EXIT.ok);
    const rejected = await run(["reject", "unwanted", "--version", "1.0.0", "--format", "json"]);
    expect(rejected.code, rejected.stderr).toBe(EXIT.ok);
    expect(JSON.parse(rejected.stdout)).toMatchObject({ reviewState: "rejected" });
  });

  it("refuses skills commands while an owner holds the data directory", async () => {
    const directory = directories.create();
    const owner = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "live-owner" });
    try {
      const captured = capture();
      const code = await main(["skills", "list", "--data-dir", directory], { io: captured.io });
      expect(code).toBe(EXIT.alreadyOwned);
      expect(captured.stderr()).toContain("already owns");
    } finally {
      owner.release();
    }
  });

  it("rejects malformed actions and missing arguments with usage output", async () => {
    const directory = directories.create();
    for (const argv of [
      ["skills", "frobnicate"],
      ["skills", "show"],
      ["skills", "import", "reporting"],
      ["skills", "approve", "reporting"],
      ["skills", "list", "--unsupported-flag", "x"],
    ]) {
      const captured = capture();
      const code = await main([...argv, "--data-dir", directory], { io: captured.io });
      expect(code, `${argv.join(" ")} -> ${captured.stderr()}`).toBe(EXIT.usage);
    }
  });
});
