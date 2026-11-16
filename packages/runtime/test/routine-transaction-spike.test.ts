import { describe, expect, it } from "vitest";

import { SqliteStore } from "../src/persistence/store.js";

/** Temporary prototype tables deliberately do not freeze application migrations. */
describe("routine claim protocol spike", () => {
  it("rolls back the real schedule CAS with its dispatch intent and fences a stale generation", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    try {
      const schedules = store.asPort().repositories.schedules;
      const now = "2026-09-20T06:00:00.000Z";
      const next = "2026-09-21T06:00:00.000Z";
      schedules.create({
        scheduleId: "probe",
        workspaceId: "default",
        principalId: "alice",
        name: "probe",
        prompt: "fixture",
        spec: { at: "09:00", timezone: "Europe/Sofia" },
        missedRunPolicy: "skip",
        autoApproveTools: [],
        enabled: true,
        nextRunAt: now,
        now,
      });
      store.handle.exec("CREATE TEMP TABLE probe_dispatch (occurrence TEXT PRIMARY KEY, generation INTEGER NOT NULL, state TEXT NOT NULL)");
      const claim = store.handle.transaction((fail: boolean) => {
        if (!schedules.claimFire({ scheduleId: "probe", fireTime: now, nextRunAt: next, now })) return false;
        store.handle.prepare("INSERT INTO probe_dispatch VALUES (?, 1, 'pending')").run(`default/routine/trigger/${now}`);
        if (fail) throw new Error("crash before commit");
        return true;
      });
      expect(() => claim(true)).toThrow("crash before commit");
      expect(schedules.get("probe")?.nextRunAt).toBe(now);
      expect(store.handle.prepare("SELECT * FROM probe_dispatch").all()).toEqual([]);
      expect(claim(false)).toBe(true);
      expect(claim(false)).toBe(false);
      expect(schedules.get("probe")?.nextRunAt).toBe(next);
      store.handle.exec("UPDATE probe_dispatch SET generation = generation + 1");
      const complete = store.handle.prepare("UPDATE probe_dispatch SET state = 'published' WHERE generation = ? AND state = 'pending'");
      expect(complete.run(1).changes).toBe(0);
      expect(complete.run(2).changes).toBe(1);
      expect(complete.run(2).changes).toBe(0);
    } finally {
      store.close();
    }
  });
});
