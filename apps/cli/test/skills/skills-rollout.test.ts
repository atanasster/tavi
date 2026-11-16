import { join } from "node:path";

import type { SkillActor } from "@tavi/contracts";
import { SkillService } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { SqliteStore } from "../support/database-fixture.js";
import { afterAll, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";

/**
 * `tavi skills pin-rollout|clear-rollout|rollout-status`: the operator-facing
 * surface for the bounded-rollout allowlist the runtime enforces.
 */

const AT = "2026-01-01T00:00:00.000Z";
const actor: SkillActor = { principalId: "operator", workspaceId: "default", caller: "cli" };

const directories = temporaryDirectories({ prefix: "tavi-skills-rollout-cli-" });
afterAll(() => directories.cleanup());

/** Imports, approves and activates 1.0.0, then 2.0.0 over it; returns the active version, 2.0.0. */
async function seedActiveSkill(directory: string): Promise<string> {
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  const skills = new SkillService(store.asPort(), { now: () => AT });
  const manifest = { name: "Reporting helper", supportedRuntimeVersions: ["1.0"], supportedToolContractVersions: ["1.0"] };
  for (const version of ["1.0.0", "2.0.0"]) {
    await skills.import({
      actor,
      skillId: "reporting",
      version,
      manifest,
      packageBody: new TextEncoder().encode(`package ${version}`),
      provenance: "operator upload",
    });
    await skills.approve({ actor, skillId: "reporting", version });
    await skills.activate({ actor, skillId: "reporting", version });
  }
  store.close();
  return "2.0.0";
}

describe("tavi skills pin-rollout", () => {
  it("authorizes the given tasks for the currently active version", async () => {
    const directory = directories.create();
    const version = await seedActiveSkill(directory);

    const pinned = capture();
    const code = await main(
      ["skills", "pin-rollout", "reporting", "--task", "task-1", "--task", "task-2", "--format", "json", "--data-dir", directory],
      { io: pinned.io },
    );
    expect(code, pinned.stderr()).toBe(EXIT.ok);
    const status = JSON.parse(pinned.stdout()) as { version: string; pinned: boolean; authorizedTaskIds: string[] };
    expect(status.version).toBe(version);
    expect(status.pinned).toBe(true);
    expect(new Set(status.authorizedTaskIds)).toEqual(new Set(["task-1", "task-2"]));
  });

  it("with --version pins a stored, not-yet-active version so the pin PRECEDES activation (no GA window)", async () => {
    const directory = directories.create();
    await seedActiveSkill(directory); // 2.0.0 is active; 1.0.0 is stored but inactive

    const pinned = capture();
    const code = await main(
      ["skills", "pin-rollout", "reporting", "--version", "1.0.0", "--task", "canary-1", "--format", "json", "--data-dir", directory],
      { io: pinned.io },
    );
    expect(code, pinned.stderr()).toBe(EXIT.ok);
    expect(JSON.parse(pinned.stdout())).toEqual({ version: "1.0.0", pinned: true, authorizedTaskIds: ["canary-1"] });

    // The ACTIVE version's own status is untouched by the pre-pin...
    const before = capture();
    expect(await main(["skills", "rollout-status", "reporting", "--format", "json", "--data-dir", directory], { io: before.io })).toBe(
      EXIT.ok,
    );
    const beforeDoc = JSON.parse(before.stdout()) as {
      active: { version: string; pinned: boolean };
      otherPins: { version: string; taskCount: number }[];
    };
    expect(beforeDoc.active.pinned).toBe(false);
    expect(beforeDoc.otherPins).toEqual([{ version: "1.0.0", taskCount: 1, active: false }]);

    // ...and the moment 1.0.0 becomes active (here via rollback), it is already bounded.
    expect(await main(["skills", "rollback", "reporting", "--version", "1.0.0", "--data-dir", directory], { io: capture().io })).toBe(
      EXIT.ok,
    );
    const after = capture();
    expect(await main(["skills", "rollout-status", "reporting", "--format", "json", "--data-dir", directory], { io: after.io })).toBe(
      EXIT.ok,
    );
    const afterDoc = JSON.parse(after.stdout()) as { active: { version: string; pinned: boolean; authorizedTaskIds: string[] } };
    expect(afterDoc.active).toEqual({ version: "1.0.0", pinned: true, authorizedTaskIds: ["canary-1"] });
  });

  it("with --version refuses a version nothing has stored", async () => {
    const directory = directories.create();
    await seedActiveSkill(directory);
    const refused = capture();
    expect(
      await main(["skills", "pin-rollout", "reporting", "--version", "9.9.9", "--task", "canary-1", "--data-dir", directory], {
        io: refused.io,
      }),
    ).toBe(EXIT.unavailable);
    expect(refused.stderr()).toMatch(/no stored version 9\.9\.9/);
  });

  it("rejects pin-rollout with no --task at all", async () => {
    const directory = directories.create();
    await seedActiveSkill(directory);
    const captured = capture();
    const code = await main(["skills", "pin-rollout", "reporting", "--data-dir", directory], { io: captured.io });
    expect(code).toBe(EXIT.usage);
    expect(captured.stderr()).toContain("--task");
  });

  it("refuses pin-rollout for a skill with no active version", async () => {
    const directory = directories.create();
    const captured = capture();
    const code = await main(["skills", "pin-rollout", "reporting", "--task", "task-1", "--data-dir", directory], { io: captured.io });
    expect(code).toBe(EXIT.unavailable);
  });

  it("rejects an empty --task value", async () => {
    const directory = directories.create();
    await seedActiveSkill(directory);
    const captured = capture();
    const code = await main(["skills", "pin-rollout", "reporting", "--task", "", "--data-dir", directory], { io: captured.io });
    expect(code).toBe(EXIT.usage);
    expect(captured.stderr()).toContain("--task");
  });

  it("prints the authorized tasks in the default text format", async () => {
    const directory = directories.create();
    await seedActiveSkill(directory);
    const pinned = capture();
    expect(
      await main(["skills", "pin-rollout", "reporting", "--task", "task-1", "--data-dir", directory], { io: pinned.io }),
      pinned.stderr(),
    ).toBe(EXIT.ok);
    expect(pinned.stdout()).toContain("task-1");
  });
});

describe("tavi skills rollout-status", () => {
  it("reports unpinned by default, then pinned with the authorized tasks after pin-rollout", async () => {
    const directory = directories.create();
    const version = await seedActiveSkill(directory);

    const before = capture();
    expect(await main(["skills", "rollout-status", "reporting", "--format", "json", "--data-dir", directory], { io: before.io })).toBe(
      EXIT.ok,
    );
    const beforeDoc = JSON.parse(before.stdout()) as { active: { version: string; pinned: boolean }; otherPins: unknown[] };
    expect(beforeDoc.active).toEqual({ version, pinned: false, authorizedTaskIds: [] });
    expect(beforeDoc.otherPins).toEqual([]);

    await main(["skills", "pin-rollout", "reporting", "--task", "task-1", "--data-dir", directory], { io: capture().io });

    const after = capture();
    expect(await main(["skills", "rollout-status", "reporting", "--format", "json", "--data-dir", directory], { io: after.io })).toBe(
      EXIT.ok,
    );
    const afterDoc = JSON.parse(after.stdout()) as { active: { pinned: boolean; authorizedTaskIds: string[] } };
    expect(afterDoc.active.pinned).toBe(true);
    expect(afterDoc.active.authorizedTaskIds).toEqual(["task-1"]);
  });

  it("surfaces a STALE pin for a rolled-back-away-from version under otherPins", async () => {
    const directory = directories.create();
    const version = await seedActiveSkill(directory);
    await main(["skills", "pin-rollout", "reporting", "--task", "task-1", "--data-dir", directory], { io: capture().io });
    const rolledBack = capture();
    expect(
      await main(["skills", "rollback", "reporting", "--version", "1.0.0", "--data-dir", directory], { io: rolledBack.io }),
      rolledBack.stderr(),
    ).toBe(EXIT.ok);

    const status = capture();
    expect(await main(["skills", "rollout-status", "reporting", "--format", "json", "--data-dir", directory], { io: status.io })).toBe(
      EXIT.ok,
    );
    const doc = JSON.parse(status.stdout()) as {
      active: { pinned: boolean };
      otherPins: { version: string; taskCount: number; active: boolean }[];
    };
    expect(doc.active.pinned).toBe(false); // rolled back to 1.0.0, never itself pinned
    expect(doc.otherPins).toEqual([{ version, taskCount: 1, active: false }]);
  });

  it("refuses rollout-status for a skill with no active version", async () => {
    const directory = directories.create();
    const captured = capture();
    const code = await main(["skills", "rollout-status", "reporting", "--data-dir", directory], { io: captured.io });
    expect(code).toBe(EXIT.unavailable);
  });
});

describe("tavi skills clear-rollout", () => {
  it("with no --version clears the currently active version's pin", async () => {
    const directory = directories.create();
    await seedActiveSkill(directory);
    await main(["skills", "pin-rollout", "reporting", "--task", "task-1", "--data-dir", directory], { io: capture().io });

    const cleared = capture();
    expect(await main(["skills", "clear-rollout", "reporting", "--data-dir", directory], { io: cleared.io }), cleared.stderr()).toBe(
      EXIT.ok,
    );

    const status = capture();
    await main(["skills", "rollout-status", "reporting", "--format", "json", "--data-dir", directory], { io: status.io });
    expect((JSON.parse(status.stdout()) as { active: { pinned: boolean } }).active.pinned).toBe(false);
  });

  it("with --version clears a SPECIFIC stale (non-active) version's pin, which the active-only form cannot reach", async () => {
    const directory = directories.create();
    const version = await seedActiveSkill(directory);
    await main(["skills", "pin-rollout", "reporting", "--task", "task-1", "--data-dir", directory], { io: capture().io });
    const rolledBack = capture();
    expect(
      await main(["skills", "rollback", "reporting", "--version", "1.0.0", "--data-dir", directory], { io: rolledBack.io }),
      rolledBack.stderr(),
    ).toBe(EXIT.ok);

    // The active-only form is a no-op against the stale pin (active version is now 1.0.0).
    await main(["skills", "clear-rollout", "reporting", "--data-dir", directory], { io: capture().io });
    const stillStale = capture();
    await main(["skills", "rollout-status", "reporting", "--format", "json", "--data-dir", directory], { io: stillStale.io });
    expect((JSON.parse(stillStale.stdout()) as { otherPins: unknown[] }).otherPins).toHaveLength(1);

    const cleared = capture();
    expect(
      await main(["skills", "clear-rollout", "reporting", "--version", version, "--data-dir", directory], { io: cleared.io }),
      cleared.stderr(),
    ).toBe(EXIT.ok);

    const after = capture();
    await main(["skills", "rollout-status", "reporting", "--format", "json", "--data-dir", directory], { io: after.io });
    expect((JSON.parse(after.stdout()) as { otherPins: unknown[] }).otherPins).toEqual([]);
  });

  it("refuses clear-rollout (no --version) for a skill with no active version", async () => {
    const directory = directories.create();
    const captured = capture();
    const code = await main(["skills", "clear-rollout", "reporting", "--data-dir", directory], { io: captured.io });
    expect(code).toBe(EXIT.unavailable);
  });

  it("prints 'cleared' in the default text format", async () => {
    const directory = directories.create();
    await seedActiveSkill(directory);
    await main(["skills", "pin-rollout", "reporting", "--task", "task-1", "--data-dir", directory], { io: capture().io });
    const cleared = capture();
    expect(await main(["skills", "clear-rollout", "reporting", "--data-dir", directory], { io: cleared.io }), cleared.stderr()).toBe(
      EXIT.ok,
    );
    expect(cleared.stdout()).toContain("cleared");
  });
});
