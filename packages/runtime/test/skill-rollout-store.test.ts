import { join } from "node:path";

import type { SkillRolloutAllowlistEntry } from "@tavi/contracts";

import { SqliteStore } from "../src/persistence/store.js";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

/**
 * Skill rollout persistence: the bounded-rollout allowlist — an explicit
 * small authorized task set.
 */

const AT = "2026-01-01T00:00:00.000Z";

const directories = temporaryDirectories();
afterEach(() => {
  directories.cleanup();
});

function fixture(): { readonly store: SqliteStore } {
  const directory = directories.create("tavi-skill-rollout-store-");
  const store = new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  return { store };
}

function entry(overrides: Partial<SkillRolloutAllowlistEntry> = {}): SkillRolloutAllowlistEntry {
  return {
    entryId: "entry-1",
    scopeKey: "w1",
    skillId: "reporting",
    version: "1.1.0",
    taskId: "task-1",
    authorizedBy: "operator",
    authorizedAt: AT,
    ...overrides,
  };
}

describe("skill rollout allowlist", () => {
  it("round-trips every field", () => {
    const { store } = fixture();
    const skillRollout = store.asPort().repositories.skillRollout;
    skillRollout.allow(entry());
    expect(skillRollout.listAllowed({ scopeKey: "w1", skillId: "reporting", version: "1.1.0" })).toEqual([entry()]);
    store.close();
  });

  it("no foreign key to tavi_tasks — a task can be pre-authorized before it is ever admitted", () => {
    const { store } = fixture();
    const skillRollout = store.asPort().repositories.skillRollout;
    expect(() => skillRollout.allow(entry({ taskId: "not-yet-admitted-task" }))).not.toThrow();
    store.close();
  });

  it("dedups a repeated (scopeKey, skillId, version, taskId) via ON CONFLICT DO NOTHING", () => {
    const { store } = fixture();
    const skillRollout = store.asPort().repositories.skillRollout;
    skillRollout.allow(entry({ entryId: "entry-1", authorizedAt: "2026-01-01T00:00:00.000Z" }));
    skillRollout.allow(entry({ entryId: "entry-2", authorizedAt: "2026-01-02T00:00:00.000Z" }));
    const rows = skillRollout.listAllowed({ scopeKey: "w1", skillId: "reporting", version: "1.1.0" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entryId).toBe("entry-1");
    store.close();
  });

  it("isAllowed is true only for a listed taskId within a pinned triple, false for an unlisted one", () => {
    const { store } = fixture();
    const skillRollout = store.asPort().repositories.skillRollout;
    skillRollout.allow(entry({ entryId: "entry-1", taskId: "task-allowed" }));
    expect(skillRollout.isAllowed({ scopeKey: "w1", skillId: "reporting", version: "1.1.0", taskId: "task-allowed" })).toBe(true);
    expect(skillRollout.isAllowed({ scopeKey: "w1", skillId: "reporting", version: "1.1.0", taskId: "task-not-allowed" })).toBe(false);
    store.close();
  });

  it("isAllowed is false for a fully unrestricted triple (no rows at all) — the same false result as a restricted-but-unlisted task, distinguished only by isPinned", () => {
    const { store } = fixture();
    const skillRollout = store.asPort().repositories.skillRollout;
    expect(skillRollout.isAllowed({ scopeKey: "w1", skillId: "reporting", version: "1.1.0", taskId: "any-task" })).toBe(false);
    expect(skillRollout.isPinned({ scopeKey: "w1", skillId: "reporting", version: "1.1.0" })).toBe(false);
    store.close();
  });

  it("isPinned is true once ANY row exists for the triple, regardless of which task", () => {
    const { store } = fixture();
    const skillRollout = store.asPort().repositories.skillRollout;
    expect(skillRollout.isPinned({ scopeKey: "w1", skillId: "reporting", version: "1.1.0" })).toBe(false);
    skillRollout.allow(entry());
    expect(skillRollout.isPinned({ scopeKey: "w1", skillId: "reporting", version: "1.1.0" })).toBe(true);
    store.close();
  });

  it("scopes isAllowed/isPinned/listAllowed to the exact (scopeKey, skillId, version) triple — a different version or workspace is unaffected", () => {
    const { store } = fixture();
    const skillRollout = store.asPort().repositories.skillRollout;
    skillRollout.allow(entry({ scopeKey: "w1", skillId: "reporting", version: "1.1.0", taskId: "task-1" }));

    expect(skillRollout.isPinned({ scopeKey: "w1", skillId: "reporting", version: "1.2.0" })).toBe(false);
    expect(skillRollout.isPinned({ scopeKey: "w2", skillId: "reporting", version: "1.1.0" })).toBe(false);
    expect(skillRollout.isAllowed({ scopeKey: "w1", skillId: "reporting", version: "1.2.0", taskId: "task-1" })).toBe(false);
    expect(skillRollout.listAllowed({ scopeKey: "w1", skillId: "other-skill", version: "1.1.0" })).toEqual([]);
    store.close();
  });

  it("listAllowed orders by authorizedAt ascending", () => {
    const { store } = fixture();
    const skillRollout = store.asPort().repositories.skillRollout;
    skillRollout.allow(entry({ entryId: "entry-2", taskId: "task-2", authorizedAt: "2026-01-02T00:00:00.000Z" }));
    skillRollout.allow(entry({ entryId: "entry-1", taskId: "task-1", authorizedAt: "2026-01-01T00:00:00.000Z" }));
    const rows = skillRollout.listAllowed({ scopeKey: "w1", skillId: "reporting", version: "1.1.0" });
    expect(rows.map((row) => row.entryId)).toEqual(["entry-1", "entry-2"]);
    store.close();
  });

  it("clear removes every row for the triple, returning it to unrestricted — isPinned/isAllowed/listAllowed all reflect general availability again", () => {
    const { store } = fixture();
    const skillRollout = store.asPort().repositories.skillRollout;
    skillRollout.allow(entry({ entryId: "entry-1", taskId: "task-1" }));
    skillRollout.allow(entry({ entryId: "entry-2", taskId: "task-2" }));
    expect(skillRollout.isPinned({ scopeKey: "w1", skillId: "reporting", version: "1.1.0" })).toBe(true);

    skillRollout.clear({ scopeKey: "w1", skillId: "reporting", version: "1.1.0" });

    expect(skillRollout.isPinned({ scopeKey: "w1", skillId: "reporting", version: "1.1.0" })).toBe(false);
    expect(skillRollout.isAllowed({ scopeKey: "w1", skillId: "reporting", version: "1.1.0", taskId: "task-1" })).toBe(false);
    expect(skillRollout.listAllowed({ scopeKey: "w1", skillId: "reporting", version: "1.1.0" })).toEqual([]);
    store.close();
  });

  it("clear on a triple with no rows is a harmless no-op", () => {
    const { store } = fixture();
    const skillRollout = store.asPort().repositories.skillRollout;
    expect(() => skillRollout.clear({ scopeKey: "w1", skillId: "reporting", version: "1.1.0" })).not.toThrow();
    store.close();
  });

  it("listPinnedVersions returns every distinct pinned version with its task count, empty when nothing is pinned", () => {
    const { store } = fixture();
    const skillRollout = store.asPort().repositories.skillRollout;
    expect(skillRollout.listPinnedVersions({ scopeKey: "w1", skillId: "reporting" })).toEqual([]);

    skillRollout.allow(entry({ entryId: "e1", version: "1.0.0", taskId: "task-1" }));
    skillRollout.allow(entry({ entryId: "e2", version: "1.0.0", taskId: "task-2" }));
    skillRollout.allow(entry({ entryId: "e3", version: "1.1.0", taskId: "task-1" }));

    expect(skillRollout.listPinnedVersions({ scopeKey: "w1", skillId: "reporting" })).toEqual([
      { version: "1.0.0", taskCount: 2 },
      { version: "1.1.0", taskCount: 1 },
    ]);
    store.close();
  });

  it("listPinnedVersions is scoped to the exact (scopeKey, skillId) — a different workspace or skill is unaffected", () => {
    const { store } = fixture();
    const skillRollout = store.asPort().repositories.skillRollout;
    skillRollout.allow(entry({ scopeKey: "w1", skillId: "reporting", version: "1.0.0" }));
    expect(skillRollout.listPinnedVersions({ scopeKey: "w2", skillId: "reporting" })).toEqual([]);
    expect(skillRollout.listPinnedVersions({ scopeKey: "w1", skillId: "other-skill" })).toEqual([]);
    store.close();
  });
});
