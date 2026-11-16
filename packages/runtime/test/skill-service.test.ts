import { SkillService } from "../src/skills/service.js";
import { join } from "node:path";
import Database from "better-sqlite3";

import { MAX_SKILL_USES_PER_SKILL, TaviError, skillUnused, type SkillActor, type SkillUse } from "@tavi/contracts";

import { MIGRATIONS, runMigrations } from "../src/persistence/migrations.js";
import { SqliteStore } from "../src/persistence/store.js";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

/**
 * Approved versioned skills.
 *
 * The properties under test: a version is immutable once imported, exact
 * bytes re-imported are idempotent, activation is a compare-and-set with a
 * durable history, and rollback only targets a version this scope already
 * activated.
 */

const AT = "2026-01-01T00:00:00.000Z";

// Skill packages are stored as artifacts on disk (content-addressed), which
// an in-memory store has no directory for, so these fixtures use a real
// temporary data directory rather than `:memory:` (matching the pattern
// `persistence.test.ts` uses for its own artifact tests).
const directories = temporaryDirectories();
afterEach(() => {
  directories.cleanup();
});

function fixture(): { readonly store: SqliteStore; readonly service: SkillService } {
  const directory = directories.create("tavi-skills-");
  const store = new SqliteStore({
    databasePath: join(directory, "tavi.sqlite"),
    artifactsDirectory: join(directory, "artifacts"),
  });
  let counter = 0;
  const service = new SkillService(store.asPort(), {
    now: () => AT,
    newId: (prefix) => `${prefix}-${(counter += 1)}`,
  });
  return { store, service };
}

const actor: SkillActor = { principalId: "alice", workspaceId: "w1", caller: "cli" };
const manifest = { name: "Reporting helper", supportedRuntimeVersions: ["1.0"], supportedToolContractVersions: ["1.0"] };

function pkg(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function countArtifacts(store: SqliteStore): number {
  const row = store.handle.prepare("SELECT COUNT(*) AS count FROM tavi_artifacts").get() as { count: number };
  return row.count;
}

describe("import", () => {
  it("enters proposed state, and re-importing identical bytes is idempotent", () => {
    const { service } = fixture();
    const imported = service.import({
      actor,
      skillId: "reporting",
      version: "1.0.0",
      manifest,
      packageBody: pkg("package v1"),
      provenance: "operator upload",
    });
    expect(imported.reviewState).toBe("proposed");

    const again = service.import({
      actor,
      skillId: "reporting",
      version: "1.0.0",
      manifest,
      packageBody: pkg("package v1"),
      provenance: "operator upload",
    });
    expect(again).toEqual(imported);
  });

  it("moves the workspace's skill counter for the canvas on every import, review and activation", () => {
    const { service, store } = fixture();
    const counter = () =>
      (
        store.handle.prepare("SELECT version FROM tavi_center_versions WHERE scope = ? AND kind = 'skill'").get(actor.workspaceId) as
          | { version: number }
          | undefined
      )?.version ?? 0;
    service.import({ actor, skillId: "counted", version: "1.0.0", manifest, packageBody: pkg("steps"), provenance: "operator upload" });
    const imported = counter();
    expect(imported).toBeGreaterThan(0);
    service.approve({ actor, skillId: "counted", version: "1.0.0" });
    const approved = counter();
    expect(approved).toBeGreaterThan(imported);
    service.activate({ actor, skillId: "counted", version: "1.0.0" });
    expect(counter()).toBeGreaterThan(approved);
  });

  it("refuses a package that is not UTF-8 text, before storing anything", () => {
    const { service, store } = fixture();
    const before = countArtifacts(store);
    expect(() =>
      service.import({
        actor,
        skillId: "binary",
        version: "1.0.0",
        manifest,
        packageBody: new Uint8Array([0xff, 0xfe, 0x00, 0x80]),
        provenance: "operator upload",
      }),
    ).toThrow(/must be UTF-8 text/);
    expect(countArtifacts(store)).toBe(before);
  });

  it("refuses to re-import the same version with different bytes", () => {
    const { service } = fixture();
    service.import({
      actor,
      skillId: "reporting",
      version: "1.0.0",
      manifest,
      packageBody: pkg("package v1"),
      provenance: "operator upload",
    });
    expect(() =>
      service.import({
        actor,
        skillId: "reporting",
        version: "1.0.0",
        manifest,
        packageBody: pkg("DIFFERENT bytes"),
        provenance: "operator upload",
      }),
    ).toThrowError(/immutable/);
  });

  it("does not leave an orphan artifact behind on an idempotent or a conflicting re-import", () => {
    const { store, service } = fixture();
    service.import({
      actor,
      skillId: "reporting",
      version: "1.0.0",
      manifest,
      packageBody: pkg("package v1"),
      provenance: "operator upload",
    });
    const countAfterFirstImport = countArtifacts(store);
    expect(countAfterFirstImport).toBe(1);

    // Idempotent re-import: identical bytes must not publish a second artifact.
    service.import({
      actor,
      skillId: "reporting",
      version: "1.0.0",
      manifest,
      packageBody: pkg("package v1"),
      provenance: "operator upload",
    });
    expect(countArtifacts(store)).toBe(countAfterFirstImport);

    // Conflicting re-import: refused before ever writing to the artifact store.
    expect(() =>
      service.import({
        actor,
        skillId: "reporting",
        version: "1.0.0",
        manifest,
        packageBody: pkg("DIFFERENT bytes"),
        provenance: "operator upload",
      }),
    ).toThrow();
    expect(countArtifacts(store)).toBe(countAfterFirstImport);
  });

  it("enters approved directly when exact bytes were already approved for this scope", () => {
    const { service } = fixture();
    const first = service.import({
      actor,
      skillId: "reporting",
      version: "1.0.0",
      manifest,
      packageBody: pkg("shared bytes"),
      provenance: "operator upload",
    });
    service.approve({ actor, skillId: "reporting", version: "1.0.0" });

    const second = service.import({
      actor,
      skillId: "reporting",
      version: "1.0.1",
      manifest,
      packageBody: pkg("shared bytes"), // identical content, new version string
      provenance: "operator re-tag",
    });
    expect(second.reviewState).toBe("approved");
    expect(second.contentHash).toBe(first.contentHash);
  });

  it("rejects an oversized package and an empty one", () => {
    const { service } = fixture();
    expect(() =>
      service.import({
        actor,
        skillId: "reporting",
        version: "1.0.0",
        manifest,
        packageBody: new Uint8Array(512 * 1024 + 1),
        provenance: "x",
      }),
    ).toThrowError(/exceeds/);
    expect(() =>
      service.import({
        actor,
        skillId: "reporting",
        version: "1.0.0",
        manifest,
        packageBody: new Uint8Array(0),
        provenance: "x",
      }),
    ).toThrowError(/must not be empty/);
  });

  it("rejects an invalid manifest and an empty skillId/version", () => {
    const { service } = fixture();
    expect(() =>
      service.import({
        actor,
        skillId: "",
        version: "1.0.0",
        manifest,
        packageBody: pkg("x"),
        provenance: "x",
      }),
    ).toThrowError(/skillId/);
    expect(() =>
      service.import({
        actor,
        skillId: "reporting",
        version: "1.0.0",
        // @ts-expect-error deliberately invalid for the test
        manifest: { name: 12345 },
        packageBody: pkg("x"),
        provenance: "x",
      }),
    ).toThrowError(TaviError);
  });
});

describe("approve/reject", () => {
  it("is idempotent, and refuses to approve a rejected version", () => {
    const { service } = fixture();
    service.import({
      actor,
      skillId: "reporting",
      version: "1.0.0",
      manifest,
      packageBody: pkg("v1"),
      provenance: "x",
    });
    const approved = service.approve({ actor, skillId: "reporting", version: "1.0.0" });
    expect(approved.reviewState).toBe("approved");
    expect(service.approve({ actor, skillId: "reporting", version: "1.0.0" }).reviewState).toBe("approved");

    service.import({
      actor,
      skillId: "reporting",
      version: "2.0.0",
      manifest,
      packageBody: pkg("v2"),
      provenance: "x",
    });
    service.reject({ actor, skillId: "reporting", version: "2.0.0" });
    expect(() => service.approve({ actor, skillId: "reporting", version: "2.0.0" })).toThrowError(/only a proposed version/);
  });
});

describe("activation", () => {
  it("activates an approved version, records history, and refuses an unapproved one", () => {
    const { service } = fixture();
    service.import({
      actor,
      skillId: "reporting",
      version: "1.0.0",
      manifest,
      packageBody: pkg("v1"),
      provenance: "x",
    });
    expect(() => service.activate({ actor, skillId: "reporting", version: "1.0.0" })).toThrowError(/only an approved version/);

    service.approve({ actor, skillId: "reporting", version: "1.0.0" });
    const activated = service.activate({ actor, skillId: "reporting", version: "1.0.0" });
    expect(activated.activeVersion).toBe("1.0.0");

    const shown = service.show({ actor, skillId: "reporting" });
    expect(shown.activation?.activeVersion).toBe("1.0.0");
    expect(shown.history).toHaveLength(1);
    expect(shown.history[0]?.reason).toBe("activate");
  });

  it("rolls back only to a version this scope has activated before", () => {
    const { service } = fixture();
    for (const version of ["1.0.0", "2.0.0"]) {
      service.import({ actor, skillId: "reporting", version, manifest, packageBody: pkg(version), provenance: "x" });
      service.approve({ actor, skillId: "reporting", version });
    }
    service.activate({ actor, skillId: "reporting", version: "1.0.0" });
    service.activate({ actor, skillId: "reporting", version: "2.0.0" });

    const rolled = service.rollback({ actor, skillId: "reporting", version: "1.0.0" });
    expect(rolled.activeVersion).toBe("1.0.0");

    service.import({ actor, skillId: "reporting", version: "3.0.0", manifest, packageBody: pkg("3.0.0"), provenance: "x" });
    service.approve({ actor, skillId: "reporting", version: "3.0.0" });
    expect(() => service.rollback({ actor, skillId: "reporting", version: "3.0.0" })).toThrowError(/was never active/);
  });

  it("refuses a stale expectedCurrentVersion (compare-and-set)", () => {
    const { service } = fixture();
    for (const version of ["1.0.0", "2.0.0"]) {
      service.import({ actor, skillId: "reporting", version, manifest, packageBody: pkg(version), provenance: "x" });
      service.approve({ actor, skillId: "reporting", version });
    }
    service.activate({ actor, skillId: "reporting", version: "1.0.0" });
    expect(() => service.activate({ actor, skillId: "reporting", version: "2.0.0", expectedCurrentVersion: "0.9.0" })).toThrowError(
      /changed while activating/,
    );
  });

  it("omitting expectedCurrentVersion still writes atomically but protects nothing against a real concurrent writer", () => {
    // Two independent store handles on the same file, standing in for two
    // sessions that never read each other's state — the scenario an implicit
    // (omitted) expectedCurrentVersion cannot protect against by design.
    const directory = directories.create("tavi-skills-race-");
    const dbPath = join(directory, "tavi.sqlite");
    const artifactsDirectory = join(directory, "artifacts");
    const storeA = new SqliteStore({ databasePath: dbPath, artifactsDirectory });
    const serviceA = new SkillService(storeA.asPort(), { now: () => AT, newId: (p) => `${p}-a` });
    for (const version of ["1.0.0", "2.0.0"]) {
      serviceA.import({ actor, skillId: "reporting", version, manifest, packageBody: pkg(version), provenance: "x" });
      serviceA.approve({ actor, skillId: "reporting", version });
    }
    storeA.close();

    // Two sessions, each opening its own handle, each activating a different
    // version without ever telling the other — no expectedCurrentVersion.
    const storeSessionA = new SqliteStore({ databasePath: dbPath, artifactsDirectory });
    const sessionA = new SkillService(storeSessionA.asPort(), { now: () => AT, newId: (p) => `${p}-a2` });
    const activatedByA = sessionA.activate({ actor, skillId: "reporting", version: "1.0.0" });
    expect(activatedByA.activeVersion).toBe("1.0.0");
    storeSessionA.close();

    const storeSessionB = new SqliteStore({ databasePath: dbPath, artifactsDirectory });
    const sessionB = new SkillService(storeSessionB.asPort(), { now: () => AT, newId: (p) => `${p}-b` });
    const activatedByB = sessionB.activate({ actor, skillId: "reporting", version: "2.0.0" });
    // Neither call threw — the write is atomic (never interleaved), but with
    // no expectation supplied, session B's write simply wins; this is the
    // documented, not-a-bug behavior of the implicit path.
    expect(activatedByB.activeVersion).toBe("2.0.0");
    storeSessionB.close();
  });
});

describe("disable", () => {
  it("clears the activation entirely, recording a disable history entry with no newVersion", () => {
    const { service } = fixture();
    service.import({ actor, skillId: "reporting", version: "1.0.0", manifest, packageBody: pkg("v1"), provenance: "x" });
    service.approve({ actor, skillId: "reporting", version: "1.0.0" });
    service.activate({ actor, skillId: "reporting", version: "1.0.0" });

    service.disable({ actor, skillId: "reporting" });

    const shown = service.show({ actor, skillId: "reporting" });
    expect(shown.activation).toBeUndefined();
    const disableEntry = shown.history.find((entry) => entry.reason === "disable");
    expect(disableEntry?.previousVersion).toBe("1.0.0");
    expect(disableEntry?.newVersion).toBeUndefined();
  });

  it("is a no-op, recording no history entry, when the skill is already disabled or never activated", () => {
    const { service } = fixture();
    service.import({ actor, skillId: "reporting", version: "1.0.0", manifest, packageBody: pkg("v1"), provenance: "x" });
    service.approve({ actor, skillId: "reporting", version: "1.0.0" });

    service.disable({ actor, skillId: "reporting" });
    expect(service.show({ actor, skillId: "reporting" }).history).toHaveLength(0);

    service.activate({ actor, skillId: "reporting", version: "1.0.0" });
    service.disable({ actor, skillId: "reporting" });
    service.disable({ actor, skillId: "reporting" });
    expect(service.show({ actor, skillId: "reporting" }).history).toHaveLength(2); // activate, disable — the second disable is a no-op
  });

  it("refuses a stale expectedCurrentVersion (compare-and-set)", () => {
    const { service } = fixture();
    service.import({ actor, skillId: "reporting", version: "1.0.0", manifest, packageBody: pkg("v1"), provenance: "x" });
    service.approve({ actor, skillId: "reporting", version: "1.0.0" });
    service.activate({ actor, skillId: "reporting", version: "1.0.0" });

    expect(() => service.disable({ actor, skillId: "reporting", expectedCurrentVersion: "0.9.0" })).toThrowError(/changed while disabling/);
  });

  it("a disabled skill can be re-activated afterward", () => {
    const { service } = fixture();
    service.import({ actor, skillId: "reporting", version: "1.0.0", manifest, packageBody: pkg("v1"), provenance: "x" });
    service.approve({ actor, skillId: "reporting", version: "1.0.0" });
    service.activate({ actor, skillId: "reporting", version: "1.0.0" });
    service.disable({ actor, skillId: "reporting" });

    const reactivated = service.activate({ actor, skillId: "reporting", version: "1.0.0" });
    expect(reactivated.activeVersion).toBe("1.0.0");
  });

  it("SqliteSkillRepository.setActivation refuses a disable (newVersion: null) against a stale expectedCurrentVersion, at the repository level", () => {
    const { store, service } = fixture();
    service.import({ actor, skillId: "reporting", version: "1.0.0", manifest, packageBody: pkg("v1"), provenance: "x" });
    service.approve({ actor, skillId: "reporting", version: "1.0.0" });
    service.activate({ actor, skillId: "reporting", version: "1.0.0" });

    const skills = store.asPort().repositories.skills;
    const applied = skills.setActivation({
      scopeKey: "w1",
      skillId: "reporting",
      newVersion: null,
      expectedCurrentVersion: "0.9.0", // stale — the real active version is "1.0.0"
      activatedBy: "alice",
      activatedAt: AT,
      reason: "disable",
      historyId: "skillact-stale-disable",
    });
    expect(applied).toBe(false);
    // The CAS miss must leave the activation exactly as it was — no
    // DELETE, no history row for a refused write.
    expect(skills.getActivation("w1", "reporting")?.activeVersion).toBe("1.0.0");
    expect(skills.listActivationHistory("w1", "reporting").find((entry) => entry.historyId === "skillact-stale-disable")).toBeUndefined();
  });
});

describe("list/show", () => {
  it("scopes versions to the actor's workspace", () => {
    const { service } = fixture();
    service.import({ actor, skillId: "reporting", version: "1.0.0", manifest, packageBody: pkg("v1"), provenance: "x" });
    const otherWorkspace: SkillActor = { ...actor, workspaceId: "w2" };
    expect(service.list({ actor: otherWorkspace })).toEqual([]);
    expect(service.list({ actor })).toHaveLength(1);
  });

  it("never lets another workspace see, decide, activate or roll back a version", () => {
    const { service } = fixture();
    service.import({ actor, skillId: "reporting", version: "1.0.0", manifest, packageBody: pkg("v1"), provenance: "x" });
    const other: SkillActor = { ...actor, workspaceId: "w2" };
    expect(() => service.approve({ actor: other, skillId: "reporting", version: "1.0.0" })).toThrowError(/does not exist/);
    expect(() => service.reject({ actor: other, skillId: "reporting", version: "1.0.0" })).toThrowError(/does not exist/);
    expect(service.show({ actor, skillId: "reporting" }).versions[0]?.reviewState).toBe("proposed");
    service.approve({ actor, skillId: "reporting", version: "1.0.0" });
    service.activate({ actor, skillId: "reporting", version: "1.0.0" });
    expect(() => service.activate({ actor: other, skillId: "reporting", version: "1.0.0" })).toThrowError(/does not exist/);
    expect(() => service.rollback({ actor: other, skillId: "reporting", version: "1.0.0" })).toThrowError(/does not exist/);
    expect(service.listActive({ actor: other })).toEqual([]);
  });

  it("gives each workspace its own version under the same id, with no conflict between them", () => {
    const { service } = fixture();
    service.import({ actor, skillId: "reporting", version: "1.0.0", manifest, packageBody: pkg("ours"), provenance: "x" });
    const other: SkillActor = { ...actor, workspaceId: "w2" };
    const theirs = service.import({
      actor: other,
      skillId: "reporting",
      version: "1.0.0",
      manifest,
      packageBody: pkg("theirs"),
      provenance: "x",
    });
    expect(theirs.scopeKey).toBe("w2");
    expect(theirs.reviewState).toBe("proposed");
    service.approve({ actor: other, skillId: "reporting", version: "1.0.0" });
    expect(service.show({ actor, skillId: "reporting" }).versions[0]?.reviewState).toBe("proposed");
  });

  it("refuses to act on a skill version that does not exist", () => {
    const { service } = fixture();
    expect(() => service.approve({ actor, skillId: "nope", version: "1.0.0" })).toThrowError(/does not exist/);
  });
});

describe("listActive", () => {
  it("returns each activated skill's manifest, empty when nothing is activated, scoped by workspace", () => {
    const { service } = fixture();
    expect(service.listActive({ actor })).toEqual([]);

    service.import({ actor, skillId: "reporting", version: "1.0.0", manifest, packageBody: pkg("v1"), provenance: "x" });
    service.approve({ actor, skillId: "reporting", version: "1.0.0" });
    // Proposed/unactivated versions don't show up until activated.
    expect(service.listActive({ actor })).toEqual([]);

    service.activate({ actor, skillId: "reporting", version: "1.0.0" });
    expect(service.listActive({ actor })).toEqual([{ skillId: "reporting", version: "1.0.0", manifest }]);

    const otherWorkspace: SkillActor = { ...actor, workspaceId: "w2" };
    expect(service.listActive({ actor: otherWorkspace })).toEqual([]);
  });

  it("reflects a rollback's new active version, and lists multiple activated skills", () => {
    const { service } = fixture();
    for (const version of ["1.0.0", "2.0.0"]) {
      service.import({ actor, skillId: "reporting", version, manifest, packageBody: pkg(version), provenance: "x" });
      service.approve({ actor, skillId: "reporting", version });
    }
    service.activate({ actor, skillId: "reporting", version: "1.0.0" });
    service.activate({ actor, skillId: "reporting", version: "2.0.0" });

    const otherManifestInput = { name: "Second skill", supportedRuntimeVersions: [], supportedToolContractVersions: [] };
    service.import({ actor, skillId: "second", version: "1.0.0", manifest: otherManifestInput, packageBody: pkg("s1"), provenance: "x" });
    service.approve({ actor, skillId: "second", version: "1.0.0" });
    service.activate({ actor, skillId: "second", version: "1.0.0" });

    // The stored manifest carries the schema's filled-in defaults, not the
    // caller's raw input.
    const otherManifest = { name: "Second skill", supportedRuntimeVersions: [], supportedToolContractVersions: [] };
    expect(service.listActive({ actor })).toEqual(
      expect.arrayContaining([
        { skillId: "reporting", version: "2.0.0", manifest },
        { skillId: "second", version: "1.0.0", manifest: otherManifest },
      ]),
    );

    service.rollback({ actor, skillId: "reporting", version: "1.0.0" });
    const active = service.listActive({ actor });
    expect(active.find((entry) => entry.skillId === "reporting")).toEqual({
      skillId: "reporting",
      version: "1.0.0",
      manifest,
    });
  });

  it("throws INTERNAL if an activation somehow points at a version missing from storage", () => {
    const { store, service } = fixture();
    // `tavi_skill_activations.(scope_key, skill_id, active_version)` has a real foreign
    // key into `tavi_skill_versions(scope_key, skill_id, version)`, so this state is
    // already unreachable via `activate`/`rollback` in normal operation
    // (confirmed: the same INSERT below fails with a FOREIGN KEY constraint
    // error when this pragma isn't disabled first). `foreign_keys` is turned
    // OFF here only to simulate that guarantee being bypassed — a different
    // SQLite build, a misconfigured pragma, a future migration — so
    // `listActive`'s defensive fallback stays pinned rather than resting on
    // convention alone.
    store.handle.pragma("foreign_keys = OFF");
    store.handle
      .prepare(
        `INSERT INTO tavi_skill_activations (scope_key, skill_id, active_version, activated_by, activated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("w1", "reporting", "9.9.9", "alice", AT);
    expect(() => service.listActive({ actor })).toThrowError(/missing from storage/);
  });
});

describe("migration 0008_skill_versions_scoped", () => {
  it("keeps every version and every same-workspace activation, and drops an activation that pointed across workspaces", () => {
    const directory = directories.create("tavi-skills-migrate-");
    const databasePath = join(directory, "tavi.sqlite");
    const pre = new Database(databasePath);
    try {
      pre.pragma("foreign_keys = ON");
      runMigrations(pre, MIGRATIONS.slice(0, 7));
      pre
        .prepare(
          "INSERT INTO tavi_artifacts (artifact_id, workspace_id, content_type, sha256, byte_size, relative_path, created_at) VALUES ('a1', 'w1', 'application/octet-stream', 'h', 1, 'a1', ?)",
        )
        .run(AT);
      const insertVersion = pre.prepare(
        `INSERT INTO tavi_skill_versions (skill_id, version, content_hash, scope_key, manifest_json, provenance, review_state, package_artifact_id, imported_by, imported_at)
         VALUES (?, '1.0.0', 'h', 'w1', '{"name":"x","supportedRuntimeVersions":[],"supportedToolContractVersions":[]}', 'x', 'approved', 'a1', 'alice', ?)`,
      );
      insertVersion.run("reporting", AT);
      insertVersion.run("shared", AT);
      const insertActivation = pre.prepare(
        "INSERT INTO tavi_skill_activations (scope_key, skill_id, active_version, activated_by, activated_at) VALUES (?, ?, '1.0.0', 'alice', ?)",
      );
      insertActivation.run("w1", "reporting", AT);
      // The old key let w2 point at w1's version.
      insertActivation.run("w2", "shared", AT);
    } finally {
      pre.close();
    }

    const store = new SqliteStore({ databasePath, artifactsDirectory: join(directory, "artifacts") });
    try {
      const skills = store.asPort().repositories.skills;
      expect(skills.getVersion("w1", "reporting", "1.0.0")?.reviewState).toBe("approved");
      expect(skills.getVersion("w1", "shared", "1.0.0")).toBeDefined();
      expect(skills.getActivation("w1", "reporting")?.activeVersion).toBe("1.0.0");
      expect(skills.getActivation("w2", "shared")).toBeUndefined();
      expect(skills.listActivationHistory("w2", "shared")[0]).toMatchObject({ reason: "disable", previousVersion: "1.0.0" });
      expect(skills.listActivationHistory("w1", "reporting")).toEqual([]);
      expect(store.handle.pragma("foreign_key_check")).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("retired compatibility arrays", () => {
  it("imports a manifest without them, and writes none to the retired columns", () => {
    const { store, service } = fixture();
    service.import({
      actor,
      skillId: "plain",
      version: "1.0.0",
      manifest: { name: "Plain", compatibility: "Needs git" },
      packageBody: pkg("p"),
      provenance: "x",
    });
    const stored = store.asPort().repositories.skills.getVersion("w1", "plain", "1.0.0");
    expect(stored?.manifest).toEqual({ name: "Plain", compatibility: "Needs git" });
    const row = store.handle
      .prepare("SELECT supported_runtime_versions_json AS runtime FROM tavi_skill_versions WHERE skill_id = 'plain'")
      .get() as { runtime: string };
    expect(row.runtime).toBe("[]");
  });
});

describe("skill uses", () => {
  const use = (overrides: Partial<SkillUse> = {}): SkillUse => ({
    scopeKey: "w1",
    taskId: "task-1",
    skillId: "reporting",
    version: "1.0.0",
    usedAt: "2026-10-01T00:00:00.000Z",
    source: "chat",
    ...overrides,
  });

  it("counts a task's repeated reads of one version once, its latest, per workspace", () => {
    const { store } = fixture();
    const skills = store.asPort().repositories.skills;
    skills.recordUse(use());
    skills.recordUse(use({ usedAt: "2026-10-02T00:00:00.000Z" }));
    skills.recordUse(use({ taskId: "run-1", source: "routine", usedAt: "2026-10-03T00:00:00.000Z" }));
    skills.recordUse(use({ scopeKey: "w2", usedAt: "2026-10-04T00:00:00.000Z" }));
    expect(skills.listUsage("w1")).toEqual([{ skillId: "reporting", uses: 2, lastUsedAt: "2026-10-03T00:00:00.000Z" }]);
    expect(skills.listUsage("w2")).toEqual([{ skillId: "reporting", uses: 1, lastUsedAt: "2026-10-04T00:00:00.000Z" }]);
    // Metadata only: the row holds no text column.
    const columns = (store.handle.prepare("PRAGMA table_info(tavi_skill_uses)").all() as { name: string }[]).map((c) => c.name);
    expect(columns.sort()).toEqual(["scope_key", "skill_id", "source", "task_id", "used_at", "version"]);
  });

  it("prunes uses older than the retention, and past the cap for one skill", () => {
    const { store } = fixture();
    const skills = store.asPort().repositories.skills;
    skills.recordUse(use({ taskId: "old", usedAt: "2025-01-01T00:00:00.000Z" }));
    skills.recordUse(use({ taskId: "new", usedAt: "2026-10-01T00:00:00.000Z" }));
    expect(skills.listUsage("w1")[0]?.uses).toBe(1);
    const base = Date.parse("2026-10-01T00:00:00.000Z");
    for (let index = 0; index < MAX_SKILL_USES_PER_SKILL + 5; index += 1)
      skills.recordUse(use({ taskId: `task-${index}`, usedAt: new Date(base + index * 1000).toISOString() }));
    expect(skills.listUsage("w1")[0]?.uses).toBe(MAX_SKILL_USES_PER_SKILL);
  });

  it("flags an active skill unused for 60 days, counted from its activation when never used", () => {
    const now = Date.parse("2026-10-27T00:00:00.000Z");
    expect(skillUnused({ activatedAt: "2026-10-20T00:00:00.000Z" }, now)).toBe(false);
    expect(skillUnused({ activatedAt: "2026-01-01T00:00:00.000Z" }, now)).toBe(true);
    expect(skillUnused({ activatedAt: "2026-01-01T00:00:00.000Z", lastUsedAt: "2026-10-01T00:00:00.000Z" }, now)).toBe(false);
    expect(skillUnused({ lastUsedAt: "2026-01-01T00:00:00.000Z" }, now)).toBe(false);
  });
});
