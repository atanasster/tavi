import { expect, it } from "vitest";

import { SqliteStore } from "../src/persistence/store.js";

/** R0 lifecycle prototype, deliberately separate from skill promotion records. */
it("keeps admitted pins stable across retirement and only activates an evaluated replacement", () => {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  try {
    store.handle.exec(`CREATE TEMP TABLE probe_agent_revision (revision INTEGER PRIMARY KEY, model TEXT NOT NULL, evaluation TEXT NOT NULL);
      CREATE TEMP TABLE probe_agent_active (singleton INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
      INSERT INTO probe_agent_revision VALUES (1, 'provider/model-v1', 'passed');
      INSERT INTO probe_agent_active VALUES (1, 1);`);
    const admitted = store.handle.prepare("SELECT model FROM probe_agent_revision WHERE revision = 1").get();
    const promote = store.handle.transaction((revision: number, expected: number) => {
      const candidate = store.handle.prepare("SELECT evaluation FROM probe_agent_revision WHERE revision = ?").get(revision) as
        | { evaluation: string }
        | undefined;
      if (candidate?.evaluation !== "passed") return false;
      return (
        store.handle.prepare("UPDATE probe_agent_active SET revision = ? WHERE singleton = 1 AND revision = ?").run(revision, expected)
          .changes === 1
      );
    });
    store.handle.exec("INSERT INTO probe_agent_revision VALUES (2, 'provider/model-v2', 'failed')");
    expect(promote(2, 1)).toBe(false);
    store.handle.exec("INSERT INTO probe_agent_revision VALUES (3, 'provider/model-v3', 'passed')");
    expect(promote(3, 1)).toBe(true);
    expect(promote(3, 1)).toBe(false);
    expect(store.handle.prepare("SELECT model FROM probe_agent_revision WHERE revision = 1").get()).toEqual(admitted);

    type Health = "usable" | "retired" | "transient" | "unknown";
    // Only explicit, trusted retirement evidence changes model availability;
    // omission from a provider listing is unknown, not retirement.
    const choose = (primary: Health, approvedFallback?: string) =>
      primary === "retired"
        ? (approvedFallback ?? "blocked_model_unavailable")
        : primary === "transient"
          ? (approvedFallback ?? "retry_later")
          : "provider/model-v1";
    expect(choose("retired")).toBe("blocked_model_unavailable");
    expect(choose("retired", "provider/approved-backup")).toBe("provider/approved-backup");
    expect(choose("transient")).toBe("retry_later");
    expect(choose("unknown")).toBe("provider/model-v1");
  } finally {
    store.close();
  }
});
