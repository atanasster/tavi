import { SkillRolloutService } from "../src/skills/rollout.js";
import { SkillService } from "../src/skills/service.js";
import { join } from "node:path";

import { TaviError, type SkillActor } from "@tavi/contracts";

import { SqliteStore } from "../src/persistence/store.js";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

/**
 * Skill bounded rollout: `SkillRolloutService` pins a version to an explicit
 * task set, narrower than the workspace-wide activation pointer.
 *
 * Properties under test: pinning a stored-but-inactive version bounds it from
 * its first moment of activation; pins are durable per version across
 * rollback/reactivate; the active-version operations refuse a skill with no
 * active version while `listRolloutPins`/`clearRolloutVersion` never do.
 */

const AT = "2026-01-01T00:00:00.000Z";

const directories = temporaryDirectories();
afterEach(() => {
  directories.cleanup();
});

const actor: SkillActor = { principalId: "alice", workspaceId: "w1", caller: "cli" };
const manifest = { name: "Reporting helper", supportedRuntimeVersions: ["1.0"], supportedToolContractVersions: ["1.0"] };

function pkg(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fixture(): {
  readonly store: SqliteStore;
  readonly skills: SkillService;
  readonly rollouts: SkillRolloutService;
} {
  const directory = directories.create("tavi-skill-rollout-service-");
  const store = new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  let counter = 0;
  const newId = (prefix: string): string => `${prefix}-${(counter += 1)}`;
  const skills = new SkillService(store.asPort(), { now: () => AT, newId });
  const rollouts = new SkillRolloutService(store.asPort(), skills, { now: () => AT, newId });
  return { store, skills, rollouts };
}

/** Imports and approves `version` of the `reporting` skill, activating it unless `activate` is false. */
function seedVersion(skills: SkillService, version: string, options: { readonly activate?: boolean } = {}): string {
  skills.import({ actor, skillId: "reporting", version, manifest, packageBody: pkg(`package ${version}`), provenance: "operator upload" });
  skills.approve({ actor, skillId: "reporting", version });
  if (options.activate !== false) skills.activate({ actor, skillId: "reporting", version });
  return version;
}

/** 1.0.0 activated, then 2.0.0 activated over it; returns the active (newer) version. */
function seedTwoVersions(skills: SkillService): string {
  seedVersion(skills, "1.0.0");
  return seedVersion(skills, "2.0.0");
}

describe("bounded rollout with no GA window", () => {
  it("pinRollout --version pins a stored, NOT-yet-active version, so activation is bounded from its very first moment", () => {
    const { store, skills, rollouts } = fixture();
    seedVersion(skills, "1.0.0");
    seedVersion(skills, "2.0.0", { activate: false });

    // Pin BEFORE activate — the active-only form would refuse this.
    rollouts.pinRollout({ actor, skillId: "reporting", taskIds: ["canary-1"], version: "2.0.0" });
    const rollout = store.asPort().repositories.skillRollout;
    expect(rollout.isPinned({ scopeKey: "w1", skillId: "reporting", version: "2.0.0" })).toBe(true);
    // The still-active 1.0.0 is untouched (unrestricted).
    expect(rollouts.getRolloutStatus({ actor, skillId: "reporting" })).toEqual({ version: "1.0.0", pinned: false, authorizedTaskIds: [] });

    skills.activate({ actor, skillId: "reporting", version: "2.0.0" });
    // No window: the instant 2.0.0 is active it is already bounded.
    expect(rollouts.getRolloutStatus({ actor, skillId: "reporting" })).toEqual({
      version: "2.0.0",
      pinned: true,
      authorizedTaskIds: ["canary-1"],
    });
    expect(rollout.isAllowed({ scopeKey: "w1", skillId: "reporting", version: "2.0.0", taskId: "someone-else" })).toBe(false);
    store.close();
  });

  it("pinRollout --version refuses a version nothing has stored (a typo must not create an orphaned pin)", () => {
    const { store, skills, rollouts } = fixture();
    seedVersion(skills, "1.0.0");
    expect(() => rollouts.pinRollout({ actor, skillId: "reporting", taskIds: ["canary-1"], version: "9.9.9" })).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(store.asPort().repositories.skillRollout.isPinned({ scopeKey: "w1", skillId: "reporting", version: "9.9.9" })).toBe(false);
    store.close();
  });
});

describe("pinRollout / clearRollout / getRolloutStatus", () => {
  it("getRolloutStatus reports unpinned (unrestricted) for a freshly-activated version with no rollout ever pinned", () => {
    const { store, skills, rollouts } = fixture();
    const active = seedTwoVersions(skills);

    const status = rollouts.getRolloutStatus({ actor, skillId: "reporting" });
    expect(status).toEqual({ version: active, pinned: false, authorizedTaskIds: [] });
    store.close();
  });

  it("pinRollout authorizes exactly the given tasks for the currently active version", () => {
    const { store, skills, rollouts } = fixture();
    const active = seedTwoVersions(skills);

    rollouts.pinRollout({ actor, skillId: "reporting", taskIds: ["task-1", "task-2"] });

    const status = rollouts.getRolloutStatus({ actor, skillId: "reporting" });
    expect(status.pinned).toBe(true);
    expect(status.version).toBe(active);
    expect(new Set(status.authorizedTaskIds)).toEqual(new Set(["task-1", "task-2"]));

    const rollout = store.asPort().repositories.skillRollout;
    expect(rollout.isAllowed({ scopeKey: "w1", skillId: "reporting", version: active, taskId: "task-1" })).toBe(true);
    expect(rollout.isAllowed({ scopeKey: "w1", skillId: "reporting", version: active, taskId: "task-not-authorized" })).toBe(false);
    store.close();
  });

  it("refuses pinRollout with an empty taskIds list", () => {
    const { store, skills, rollouts } = fixture();
    seedTwoVersions(skills);
    expect(() => rollouts.pinRollout({ actor, skillId: "reporting", taskIds: [] })).toThrow(TaviError);
    store.close();
  });

  it("refuses pinRollout/clearRollout/getRolloutStatus for a skill with no active version", () => {
    const { store, rollouts } = fixture();
    expect(() => rollouts.pinRollout({ actor, skillId: "reporting", taskIds: ["task-1"] })).toThrow(TaviError);
    expect(() => rollouts.clearRollout({ actor, skillId: "reporting" })).toThrow(TaviError);
    expect(() => rollouts.getRolloutStatus({ actor, skillId: "reporting" })).toThrow(TaviError);
    store.close();
  });

  it("clearRollout removes every pinned row, restoring unrestricted access", () => {
    const { store, skills, rollouts } = fixture();
    const active = seedTwoVersions(skills);
    rollouts.pinRollout({ actor, skillId: "reporting", taskIds: ["task-1"] });
    expect(rollouts.getRolloutStatus({ actor, skillId: "reporting" }).pinned).toBe(true);

    rollouts.clearRollout({ actor, skillId: "reporting" });

    const status = rollouts.getRolloutStatus({ actor, skillId: "reporting" });
    expect(status).toEqual({ version: active, pinned: false, authorizedTaskIds: [] });
    store.close();
  });

  it("clearRollout on a never-pinned version is a harmless no-op", () => {
    const { store, skills, rollouts } = fixture();
    const active = seedTwoVersions(skills);
    expect(() => rollouts.clearRollout({ actor, skillId: "reporting" })).not.toThrow();
    expect(rollouts.getRolloutStatus({ actor, skillId: "reporting" })).toEqual({ version: active, pinned: false, authorizedTaskIds: [] });
    store.close();
  });

  it("pinning against a version, then rolling back, leaves the OLD pin in place but getRolloutStatus now reports the ROLLED-BACK version's own (unpinned) status", () => {
    const { store, skills, rollouts } = fixture();
    const active = seedTwoVersions(skills);
    rollouts.pinRollout({ actor, skillId: "reporting", taskIds: ["task-1"] });

    skills.rollback({ actor, skillId: "reporting", version: "1.0.0" });

    // The rolled-back-to version ("1.0.0") was never itself pinned.
    const status = rollouts.getRolloutStatus({ actor, skillId: "reporting" });
    expect(status.version).toBe("1.0.0");
    expect(status.pinned).toBe(false);

    // The newer version's own allowlist rows are untouched — rollback never
    // touches `tavi_skill_rollout_allowlist` — they just no longer apply to
    // anything since that version isn't active.
    const rollout = store.asPort().repositories.skillRollout;
    expect(rollout.isPinned({ scopeKey: "w1", skillId: "reporting", version: active })).toBe(true);
    store.close();
  });

  it("a pin survives a rollback-then-reactivate cycle back to the SAME version — old pins for a version are durable, not tied to one continuous activation window", () => {
    const { store, skills, rollouts } = fixture();
    const active = seedTwoVersions(skills);
    rollouts.pinRollout({ actor, skillId: "reporting", taskIds: ["task-1"] });

    skills.rollback({ actor, skillId: "reporting", version: "1.0.0" }); // -> back to 1.0.0
    skills.activate({ actor, skillId: "reporting", version: active }); // -> forward to the pinned version again

    const status = rollouts.getRolloutStatus({ actor, skillId: "reporting" });
    expect(status.version).toBe(active);
    expect(status.pinned).toBe(true);
    expect(status.authorizedTaskIds).toEqual(["task-1"]);
    store.close();
  });

  it("listRolloutPins is empty when nothing was ever pinned", () => {
    const { store, skills, rollouts } = fixture();
    seedTwoVersions(skills);
    expect(rollouts.listRolloutPins({ actor, skillId: "reporting" })).toEqual([]);
    store.close();
  });

  it("listRolloutPins surfaces a STALE pin for a rolled-back-away-from version, marking only the active one as active", () => {
    const { store, skills, rollouts } = fixture();
    const active = seedTwoVersions(skills);
    rollouts.pinRollout({ actor, skillId: "reporting", taskIds: ["task-1", "task-2"] });

    skills.rollback({ actor, skillId: "reporting", version: "1.0.0" }); // active version is now 1.0.0 again

    const pins = rollouts.listRolloutPins({ actor, skillId: "reporting" });
    expect(pins).toEqual([{ version: active, taskCount: 2, active: false }]);
    store.close();
  });

  it("listRolloutPins never throws for a skill with no active version (or no skill at all)", () => {
    const { store, skills, rollouts } = fixture();
    expect(() => rollouts.listRolloutPins({ actor, skillId: "no-such-skill" })).not.toThrow();
    expect(rollouts.listRolloutPins({ actor, skillId: "no-such-skill" })).toEqual([]);

    // A stored, pinned, but never-activated skill: no active version, yet the pin is listed.
    seedVersion(skills, "1.0.0", { activate: false });
    rollouts.pinRollout({ actor, skillId: "reporting", taskIds: ["task-1"], version: "1.0.0" });
    expect(rollouts.listRolloutPins({ actor, skillId: "reporting" })).toEqual([{ version: "1.0.0", taskCount: 1, active: false }]);
    store.close();
  });

  it("clearRolloutVersion removes a STALE pin for a version that is no longer active — clearRollout alone cannot reach it", () => {
    const { store, skills, rollouts } = fixture();
    const active = seedTwoVersions(skills);
    rollouts.pinRollout({ actor, skillId: "reporting", taskIds: ["task-1"] });
    skills.rollback({ actor, skillId: "reporting", version: "1.0.0" });

    // clearRollout only targets the ACTIVE version (1.0.0 now) — the
    // stale pin on the newer version survives it.
    rollouts.clearRollout({ actor, skillId: "reporting" });
    expect(rollouts.listRolloutPins({ actor, skillId: "reporting" })).toEqual([{ version: active, taskCount: 1, active: false }]);

    rollouts.clearRolloutVersion({ actor, skillId: "reporting", version: active });
    expect(rollouts.listRolloutPins({ actor, skillId: "reporting" })).toEqual([]);
    store.close();
  });

  it("clearRolloutVersion on a version with no pins is a harmless no-op", () => {
    const { store, skills, rollouts } = fixture();
    seedTwoVersions(skills);
    expect(() => rollouts.clearRolloutVersion({ actor, skillId: "reporting", version: "no-such-version" })).not.toThrow();
    store.close();
  });

  it("clearRolloutVersion also clears the CURRENTLY active version's pins when its version string is passed explicitly — same effect as clearRollout, minus the NOT_FOUND guard for a skill with no active version (disclosed design tradeoff)", () => {
    const { store, skills, rollouts } = fixture();
    const active = seedTwoVersions(skills);
    rollouts.pinRollout({ actor, skillId: "reporting", taskIds: ["task-1"] });

    rollouts.clearRolloutVersion({ actor, skillId: "reporting", version: active });

    expect(rollouts.getRolloutStatus({ actor, skillId: "reporting" })).toEqual({ version: active, pinned: false, authorizedTaskIds: [] });
    store.close();
  });
});
