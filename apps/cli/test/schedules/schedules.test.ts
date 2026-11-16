import { join } from "node:path";

import { RoutineCreateSchema, hostTimeZone, routineDefaults, type ScheduleRecord } from "@tavi/contracts";
import { DatabaseClient, RoutineService } from "@tavi/runtime";
import { SqliteStore } from "../support/database-fixture.js";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { agendaText, fireTimeText, schedulePreview, scheduleTools } from "../../src/features/schedules/actions.js";
import { SCHEDULES_USAGE } from "../../src/features/schedules/parse.js";
import { nextOccurrence } from "@tavi/agent-host/schedule-scheduler";
import { capture, temporaryDirectories } from "@tavi/test-support";

/**
 * Recurring schedules end to end through the real store
 * and the real CLI.
 *
 * The concurrency-relevant property is `claimFire`'s compare-and-set: two
 * dispatchers must not both fire one schedule time. It is asserted here against
 * SQLite rather than against a fake, because the guarantee *is* the SQL
 * predicate — a fake would only restate the implementation.
 */

const directories = temporaryDirectories({ prefix: "tavi-schedules-" });

afterEach(() => directories.cleanup());

async function withStore<T>(directory: string, body: (store: SqliteStore) => T | Promise<T>): Promise<T> {
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  try {
    return await body(store);
  } finally {
    await store.close();
  }
}

/** Create a schedule with `tavi schedules add` and return its id. */
async function addSchedule(directory: string, extra: readonly string[] = []): Promise<string> {
  const created = capture();
  const code = await main(
    [
      "schedules",
      "add",
      "--name",
      "morning-brief",
      "--at",
      "07:00",
      "--timezone",
      "Europe/Sofia",
      "--prompt",
      "produce the daily brief and send it",
      "--allow",
      "reports.*,messaging.send_to,http.*",
      "--alert-connection",
      "telegram-main",
      "--alert-destination",
      "8346819670",
      "--format",
      "json",
      "--data-dir",
      directory,
      ...extra,
    ],
    { io: created.io },
  );
  expect(code, created.stderr()).toBe(EXIT.ok);
  // The alert flags are part of the fixture, so this command must never produce
  // the no-alert-target warning.
  expect(created.stderr()).not.toMatch(/no alert target/);
  return (JSON.parse(created.stdout()) as { scheduleId: string }).scheduleId;
}

describe("SqliteScheduleRepository", () => {
  const base = {
    workspaceId: "default",
    principalId: "operator",
    name: "brief",
    prompt: "go",
    spec: { at: "07:00", timezone: "Europe/Sofia" },
    missedRunPolicy: "run-once-if-missed-within-6h" as const,
    autoApproveTools: ["reports.*"],
    enabled: true,
    now: "2026-04-05T00:00:00.000Z",
  };

  it("refuses a duplicate name within a workspace, because two identical schedules are a configuration bug", async () => {
    const directory = directories.create();
    await withStore(directory, async (store) => {
      const schedules = store.asPort().repositories.schedules;
      await schedules.create({ ...base, scheduleId: "sched-1", nextRunAt: "2026-04-05T04:00:00.000Z" });
      await expect(
        (async () => await schedules.create({ ...base, scheduleId: "sched-2", nextRunAt: "2026-04-05T04:00:00.000Z" }))(),
      ).rejects.toThrow(/already exists/);
      // A different workspace may reuse the name.
      await (async () =>
        await schedules.create({ ...base, workspaceId: "other", scheduleId: "sched-3", nextRunAt: "2026-04-05T04:00:00.000Z" }))();
    });
  });

  it("claims a fire exactly once, so two dispatchers cannot both run one schedule time", async () => {
    const directory = directories.create();
    await withStore(directory, async (store) => {
      const schedules = store.asPort().repositories.schedules;
      await schedules.create({ ...base, scheduleId: "sched-1", nextRunAt: "2026-04-05T04:00:00.000Z" });
      const fireTime = "2026-04-05T04:00:00.000Z";
      const first = await schedules.claimFire({ scheduleId: "sched-1", fireTime, nextRunAt: "2026-04-06T04:00:00.000Z", now: base.now });
      const second = await schedules.claimFire({ scheduleId: "sched-1", fireTime, nextRunAt: "2026-04-06T04:00:00.000Z", now: base.now });
      expect(first).toBe(true);
      expect(second).toBe(false);
      expect((await schedules.get("sched-1"))?.nextRunAt).toBe("2026-04-06T04:00:00.000Z");
    });
  });

  it("refuses to claim a fire for a disabled schedule", async () => {
    const directory = directories.create();
    await withStore(directory, async (store) => {
      const schedules = store.asPort().repositories.schedules;
      await schedules.create({ ...base, scheduleId: "sched-1", enabled: false, nextRunAt: "2026-04-05T04:00:00.000Z" });
      expect(
        await schedules.claimFire({
          scheduleId: "sched-1",
          fireTime: "2026-04-05T04:00:00.000Z",
          nextRunAt: "2026-04-06T04:00:00.000Z",
          now: base.now,
        }),
      ).toBe(false);
    });
  });

  it("lists only enabled schedules whose time has arrived", async () => {
    const directory = directories.create();
    await withStore(directory, async (store) => {
      const schedules = store.asPort().repositories.schedules;
      await schedules.create({ ...base, scheduleId: "due", nextRunAt: "2026-04-05T04:00:00.000Z" });
      await schedules.create({ ...base, name: "future", scheduleId: "future", nextRunAt: "2026-04-06T04:00:00.000Z" });
      await schedules.create({ ...base, name: "off", scheduleId: "off", enabled: false, nextRunAt: "2026-04-05T04:00:00.000Z" });
      const listed = await schedules.listDue("2026-04-05T04:00:30.000Z", 10);
      expect(listed.due.map((entry) => entry.scheduleId)).toEqual(["due"]);
      expect(listed.unreadable).toEqual([]);
    });
  });

  it("round-trips the spec and the allowlist, and re-validates the stored spec", async () => {
    const directory = directories.create();
    await withStore(directory, async (store) => {
      const schedules = store.asPort().repositories.schedules;
      await schedules.create({
        ...base,
        scheduleId: "sched-1",
        spec: { at: "07:00", timezone: "Europe/Sofia", daysOfWeek: [1, 3] },
        autoApproveTools: ["reports.*", "messaging.send_to"],
        alert: { connectionId: "telegram-main", destination: "8346819670" },
        nextRunAt: "2026-04-05T04:00:00.000Z",
      });
      const stored = await schedules.get("sched-1");
      expect(stored?.spec).toEqual({ at: "07:00", timezone: "Europe/Sofia", daysOfWeek: [1, 3] });
      expect(stored?.autoApproveTools).toEqual(["reports.*", "messaging.send_to"]);
      expect(stored?.alert).toEqual({ connectionId: "telegram-main", destination: "8346819670" });
    });
  });

  /** Simulate an out-of-band edit (an operator, or a future migration). */
  function handEdit(store: SqliteStore, column: string, value: string, scheduleId = "sched-1"): void {
    (store as unknown as { handle: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).handle
      .prepare(`UPDATE tavi_schedules SET ${column} = ? WHERE schedule_id = ?`)
      .run(value, scheduleId);
  }

  it("refuses to act on a row whose stored configuration is unreadable", async () => {
    const directory = directories.create();
    await withStore(directory, async (store) => {
      const schedules = store.asPort().repositories.schedules;
      await schedules.create({ ...base, scheduleId: "sched-1", nextRunAt: "2026-04-05T04:00:00.000Z" });
      handEdit(store, "spec_json", JSON.stringify({ at: "99:99", timezone: "Europe/Sofia" }));
      await expect((async () => await schedules.get("sched-1"))()).rejects.toThrow(/unreadable configuration/);
    });
  });

  it("fails closed on a hand-edited allowlist instead of granting more than the operator wrote", async () => {
    const directory = directories.create();
    await withStore(directory, async (store) => {
      const schedules = store.asPort().repositories.schedules;
      await schedules.create({ ...base, scheduleId: "sched-1", nextRunAt: "2026-04-05T04:00:00.000Z" });
      // The dangerous direction: an unvalidated read would turn this into a
      // policy that auto-approves *every* tool, `sandbox.run` included.
      handEdit(store, "auto_approve_tools_json", JSON.stringify(["*", "not a tool id!"]));
      await expect((async () => await schedules.get("sched-1"))()).rejects.toThrow(/unreadable configuration/);
      // Still listed, so the operator can see and fix it, but disabled and
      // carrying none of the unvalidated grant.
      const listed = (await schedules.list()).find((entry) => entry.scheduleId === "sched-1");
      expect(listed?.autoApproveTools).toEqual([]);
      expect(listed?.enabled).toBe(false);
      expect(listed?.lastOutcome).toMatch(/unreadable configuration/);
    });
  });

  it("refuses --allow '*' rather than granting sandbox.run by accident", async () => {
    // A wildcard reads as "everything my deployment can do" and means "including
    // sandbox.run" — arbitrary local command execution in an unattended run — and
    // it hides which tools were actually granted.
    const directory = directories.create();
    const refused = capture();
    const code = await main(
      [
        "schedules",
        "add",
        "--name",
        "everything",
        "--at",
        "07:00",
        "--timezone",
        "Europe/Sofia",
        "--prompt",
        "do whatever",
        "--allow",
        "*",
        "--data-dir",
        directory,
      ],
      { io: refused.io },
    );
    expect(code).toBe(EXIT.usage);
    expect(refused.stderr()).toMatch(/grants every tool/);
    expect(refused.stderr()).toContain("sandbox.run");

    // A form fill is a person's to approve: naming it is refused.
    const fill = capture();
    expect(
      await main(
        [
          "schedules",
          "add",
          "--name",
          "forms",
          "--at",
          "07:00",
          "--timezone",
          "Europe/Sofia",
          "--prompt",
          "fill the forms",
          "--allow",
          "pdf.fill",
          "--data-dir",
          directory,
        ],
        { io: fill.io },
      ),
    ).toBe(EXIT.usage);
    expect(fill.stderr()).toMatch(/pdf\.fill" is refused: a form fill is approved by a person/);

    // Naming the tools — including sandbox.run explicitly — is accepted, and the
    // schedule says what the allowlist does and does not bound.
    const directory2 = directories.create();
    const named = capture();
    const namedCode = await main(
      [
        "schedules",
        "add",
        "--name",
        "named",
        "--at",
        "07:00",
        "--timezone",
        "Europe/Sofia",
        "--prompt",
        "produce the brief",
        "--allow",
        "reports.*,messaging.send_to",
        "--data-dir",
        directory2,
      ],
      { io: named.io },
    );
    expect(namedCode, named.stderr()).toBe(EXIT.ok);
    expect(named.stderr()).toMatch(/governs only the calls that would otherwise need approval/);
  });

  it("warns when a schedule is created with no way to report its own failure", async () => {
    // Every `sendAlert` path returns early without an alert target, so a broken or
    // missed brief is silent — and `schedules show` printing "alert none" is only
    // found by someone who already suspected a problem.
    const directory = directories.create();
    const silent = capture();
    const code = await main(
      [
        "schedules",
        "add",
        "--name",
        "silent",
        "--at",
        "07:00",
        "--timezone",
        "Europe/Sofia",
        "--prompt",
        "produce the brief",
        "--allow",
        "reports.*",
        "--data-dir",
        directory,
      ],
      { io: silent.io },
    );
    expect(code, silent.stderr()).toBe(EXIT.ok);
    // Where a failure goes instead (AUTOMATION.md): its person's Home, never nowhere.
    expect(silent.stderr()).toMatch(/no alert target, so a failed or missed run is posted to your Home as a notice/);
    expect(silent.stderr()).not.toContain("cannot be reported");
    expect(silent.stderr()).toContain("--alert-destination");
    // From the terminal, a schedule delivers nowhere unless it is told to, even when its runs send nothing themselves.
    await withStore(directory, async (store) => {
      const [stored] = await store.asPort().repositories.schedules.list("default");
      expect(stored?.deliverTo).toBeUndefined();
    });

    // With an alert target configured, the same command stays quiet.
    const directory2 = directories.create();
    await addSchedule(directory2);
  });

  it("fails closed on a malformed alert target rather than silently dropping failure alerts", async () => {
    const directory = directories.create();
    await withStore(directory, async (store) => {
      const schedules = store.asPort().repositories.schedules;
      await schedules.create({ ...base, scheduleId: "sched-1", nextRunAt: "2026-04-05T04:00:00.000Z" });
      handEdit(store, "alert_json", "{not json");
      await expect((async () => await schedules.get("sched-1"))()).rejects.toThrow(/unreadable configuration/);
    });
  });

  it("keeps firing the readable schedules when one row is unreadable", async () => {
    const directory = directories.create();
    await withStore(directory, async (store) => {
      const schedules = store.asPort().repositories.schedules;
      await schedules.create({ ...base, scheduleId: "good", nextRunAt: "2026-04-05T04:00:00.000Z" });
      await schedules.create({ ...base, name: "bad", scheduleId: "bad", nextRunAt: "2026-04-05T04:00:00.000Z" });
      handEdit(store, "spec_json", JSON.stringify({ at: "nope" }), "bad");
      // The regression: `listDue` used to throw, so one bad row stopped *every*
      // schedule on every tick, with no alert.
      const listed = await schedules.listDue("2026-04-05T04:00:30.000Z", 10);
      expect(listed.due.map((entry) => entry.scheduleId)).toEqual(["good"]);
      expect(listed.unreadable).toEqual(["bad"]);
    });
  });

  it("finds the healthy schedules even when unreadable rows fill the whole first page", async () => {
    // Nothing ever advances an unreadable row — its `next_run_at` stays in the past
    // — so with a single `LIMIT ?` they permanently occupied the head of every
    // sweep: `limit` poisoned rows meant no schedule in the deployment ever fired
    // again.
    const directory = directories.create();
    await withStore(directory, async (store) => {
      const schedules = store.asPort().repositories.schedules;
      for (let index = 0; index < 5; index += 1) {
        await schedules.create({ ...base, name: `bad-${index}`, scheduleId: `bad-${index}`, nextRunAt: "2026-04-05T03:00:00.000Z" });
        handEdit(store, "spec_json", JSON.stringify({ at: "nope" }), `bad-${index}`);
      }
      // Older `next_run_at` than the healthy one, so they sort first.
      await schedules.create({ ...base, scheduleId: "good", nextRunAt: "2026-04-05T04:00:00.000Z" });

      const listed = await schedules.listDue("2026-04-05T04:00:30.000Z", 2);
      expect(listed.due.map((entry) => entry.scheduleId)).toEqual(["good"]);
      expect(listed.unreadable).toHaveLength(5);
    });
  });

  it("tracks consecutive failures so a bad morning is distinguishable from a broken week", async () => {
    const directory = directories.create();
    await withStore(directory, async (store) => {
      const schedules = store.asPort().repositories.schedules;
      await schedules.create({ ...base, scheduleId: "sched-1", nextRunAt: "2026-04-05T04:00:00.000Z" });
      await schedules.recordRun({ scheduleId: "sched-1", taskId: "task-1", outcome: "failed: boom", outcomeKind: "failed", now: base.now });
      await schedules.recordRun({
        scheduleId: "sched-1",
        taskId: "task-2",
        outcome: "failed: boom again",
        outcomeKind: "failed",
        now: base.now,
      });
      expect((await schedules.get("sched-1"))?.consecutiveFailures).toBe(2);
      // A skipped fire is neither: it must not reset the counter (which would
      // let a broken schedule look healthy after a quiet morning).
      await schedules.recordRun({
        scheduleId: "sched-1",
        taskId: null,
        outcome: "skipped: the previous run is still in flight",
        outcomeKind: "skipped",
        now: base.now,
      });
      expect((await schedules.get("sched-1"))?.consecutiveFailures).toBe(2);
      await schedules.recordRun({ scheduleId: "sched-1", taskId: "task-3", outcome: "completed", outcomeKind: "succeeded", now: base.now });
      const recovered = await schedules.get("sched-1");
      expect(recovered?.consecutiveFailures).toBe(0);
      expect(recovered?.lastOutcome).toBe("completed");
      expect(recovered?.lastRunTaskId).toBe("task-3");
    });
  });

  it("names as its last run only a fire that started: a claimed fire that is then skipped leaves it", async () => {
    const directory = directories.create();
    await withStore(directory, async (store) => {
      const schedules = store.asPort().repositories.schedules;
      await schedules.create({ ...base, scheduleId: "sched-1", nextRunAt: "2026-04-05T04:00:00.000Z" });
      const claim = (fireTime: string, nextRunAt: string) =>
        schedules.claimFire({ scheduleId: "sched-1", fireTime, nextRunAt, now: base.now });
      expect(await claim("2026-04-05T04:00:00.000Z", "2026-04-06T04:00:00.000Z")).toBe(true);
      await schedules.markRunning({ scheduleId: "sched-1", taskId: "task-1", fireTime: "2026-04-05T04:00:00.000Z", now: base.now });
      expect((await schedules.get("sched-1"))?.lastRunAt).toBe("2026-04-05T04:00:00.000Z");
      // The next fire is claimed and then missed: nothing ran, so the last run stays the 5th's.
      expect(await claim("2026-04-06T04:00:00.000Z", "2026-04-07T04:00:00.000Z")).toBe(true);
      await schedules.recordRun({
        scheduleId: "sched-1",
        taskId: null,
        outcome: "skipped: missed by 400m (policy: skip)",
        outcomeKind: "skipped",
        now: base.now,
      });
      expect((await schedules.get("sched-1"))?.lastRunAt).toBe("2026-04-05T04:00:00.000Z");
    });
  });

  it("clears and re-arms the next fire through setEnabled", async () => {
    const directory = directories.create();
    await withStore(directory, async (store) => {
      const schedules = store.asPort().repositories.schedules;
      await schedules.create({ ...base, scheduleId: "sched-1", nextRunAt: "2026-04-05T04:00:00.000Z" });
      await schedules.setEnabled({ scheduleId: "sched-1", enabled: false, nextRunAt: null, now: base.now });
      expect((await schedules.get("sched-1"))?.nextRunAt).toBeNull();
      await schedules.setEnabled({ scheduleId: "sched-1", enabled: true, nextRunAt: "2026-05-01T04:00:00.000Z", now: base.now });
      expect((await schedules.get("sched-1"))?.nextRunAt).toBe("2026-05-01T04:00:00.000Z");
    });
  });
});

describe("tavi schedules", () => {
  it("adds a schedule, arming the next 07:00 in its own timezone", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory);
    await withStore(directory, async (store) => {
      const stored = await store.asPort().repositories.schedules.get(id);
      if (stored === undefined) throw new Error(`schedule ${id} was reported created but is not in the store`);
      expect(stored.name).toBe("morning-brief");
      // Comma-separated `--allow` is accepted, and `--alert-*` became a target.
      expect(stored.autoApproveTools).toEqual(["reports.*", "messaging.send_to", "http.*"]);
      expect(stored.alert).toEqual({ connectionId: "telegram-main", destination: "8346819670" });
      // The next fire is a real, future instant in the schedule's zone.
      expect(stored.nextRunAt).toBe(nextOccurrence(stored.spec, new Date())?.toISOString());
    });
  });

  it("rejects an invalid time or zone at add, before writing anything", async () => {
    const directory = directories.create();
    const bad = capture();
    expect(
      await main(
        ["schedules", "add", "--name", "x", "--at", "25:00", "--timezone", "Europe/Sofia", "--prompt", "go", "--data-dir", directory],
        { io: bad.io },
      ),
    ).toBe(EXIT.usage);
    expect(bad.stderr()).toMatch(/invalid schedule spec/);
    await withStore(directory, async (store) => {
      expect(await store.asPort().repositories.schedules.list()).toHaveLength(0);
    });
  });

  it("rejects a timezone typo as usage rather than an internal failure", async () => {
    // The CLI is protected twice over: the argument parser refuses the zone at
    // the boundary, and `nextOccurrence` now refuses it too, so a row that got
    // into the database another way (a hand edit, a restored backup) cannot
    // throw a raw `RangeError` out of a sweep.
    const directory = directories.create();
    const bad = capture();
    expect(
      await main(
        ["schedules", "add", "--name", "x", "--at", "07:00", "--timezone", "Europe/Sofija", "--prompt", "go", "--data-dir", directory],
        { io: bad.io },
      ),
    ).toBe(EXIT.usage);
    expect(bad.stderr()).toMatch(/is not a known IANA timezone/);
    await withStore(directory, async (store) => {
      expect(await store.asPort().repositories.schedules.list()).toHaveLength(0);
    });
  });

  it("rejects an unknown missed-run policy and a malformed tool pattern", async () => {
    const directory = directories.create();
    const badMissed = capture();
    expect(
      await main(
        [
          "schedules",
          "add",
          "--name",
          "x",
          "--at",
          "07:00",
          "--timezone",
          "Europe/Sofia",
          "--prompt",
          "go",
          "--missed",
          "whenever",
          "--data-dir",
          directory,
        ],
        { io: badMissed.io },
      ),
    ).toBe(EXIT.usage);
    expect(badMissed.stderr()).toMatch(/--missed must be one of/);

    const badPattern = capture();
    expect(
      await main(
        [
          "schedules",
          "add",
          "--name",
          "x",
          "--at",
          "07:00",
          "--timezone",
          "Europe/Sofia",
          "--prompt",
          "go",
          "--allow",
          "http..request",
          "--data-dir",
          directory,
        ],
        { io: badPattern.io },
      ),
    ).toBe(EXIT.usage);
    expect(badPattern.stderr()).toMatch(/is not a tool id/);
    const stalePattern = capture();
    expect(
      await main(
        [
          "schedules",
          "add",
          "--name",
          "x",
          "--at",
          "07:00",
          "--timezone",
          "Europe/Sofia",
          "--prompt",
          "go",
          "--allow",
          "web.*",
          "--data-dir",
          directory,
        ],
        { io: stalePattern.io },
      ),
    ).toBe(EXIT.usage);
    expect(stalePattern.stderr()).toMatch(/web_search, web_fetch, or web_\*/);
  });

  it("requires the alert connection and destination together", async () => {
    const directory = directories.create();
    const bad = capture();
    expect(
      await main(
        [
          "schedules",
          "add",
          "--name",
          "x",
          "--at",
          "07:00",
          "--timezone",
          "Europe/Sofia",
          "--prompt",
          "go",
          "--alert-connection",
          "telegram-main",
          "--data-dir",
          directory,
        ],
        { io: bad.io },
      ),
    ).toBe(EXIT.usage);
    expect(bad.stderr()).toMatch(/must be given together/);
  });

  it("shows the effective unattended policy in plain language, including that nothing is allowed by default", async () => {
    const directory = directories.create();
    const quiet = capture();
    expect(
      await main(
        [
          "schedules",
          "add",
          "--name",
          "locked-down",
          "--at",
          "07:00",
          "--timezone",
          "Europe/Sofia",
          "--prompt",
          "go",
          "--data-dir",
          directory,
        ],
        { io: quiet.io },
      ),
    ).toBe(EXIT.ok);

    const shown = capture();
    expect(await main(["schedules", "show", "locked-down", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    // Addressed by name, not id — an operator types the name they chose.
    expect(shown.stdout()).toMatch(/schedule .* \(locked-down\)/);
    expect(shown.stdout()).toMatch(/fires {7}every day at 07:00 \(Europe\/Sofia\)\n/);
    expect(shown.stdout()).toMatch(/missed {6}run-once-if-missed-within-6h/);
    expect(shown.stdout()).toMatch(/alert {7}none/);
    expect(shown.stdout()).toMatch(/\(nothing — every gated tool call is denied\)/);
    // A never-run schedule must read as "never", not "never (null)" — the field
    // is null, not undefined, and the first version printed the literal.
    expect(shown.stdout()).toMatch(/last run {4}never\n/);
    expect(shown.stdout()).not.toContain("null");
  });

  it("keeps a run limit from --max-run-minutes, shows it, and changes only it on update", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory, ["--max-run-minutes", "90"]);
    const show = async () => {
      const shown = capture();
      expect(await main(["schedules", "show", id, "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
      return shown.stdout();
    };
    expect(await show()).toMatch(/run limit {3}90 minutes of work, then stopped/);
    const updated = capture();
    expect(await main(["schedules", "update", id, "--max-run-minutes", "15", "--data-dir", directory], { io: updated.io })).toBe(EXIT.ok);
    await withStore(directory, async (store) => {
      const stored = await store.asPort().repositories.schedules.get(id);
      expect(stored?.maxRunMinutes).toBe(15);
      expect(stored?.autoApproveTools).toEqual(["reports.*", "messaging.send_to", "http.*"]);
      expect(stored?.spec).toEqual({ at: "07:00", timezone: "Europe/Sofia" });
    });
    expect(await show()).toMatch(/run limit {3}15 minutes of work, then stopped/);
    for (const bad of ["0", "1441", "2.5", "soon"]) {
      const refused = capture();
      expect(await main(["schedules", "update", id, "--max-run-minutes", bad, "--data-dir", directory], { io: refused.io }), bad).toBe(
        EXIT.usage,
      );
      expect(refused.stderr()).toMatch(/--max-run-minutes expects 1-1440/);
    }
    // One made without it is held to the default, and says so.
    const plain = capture();
    expect(
      await main(["schedules", "add", "--name", "plain", "--at", "07:00", "--timezone", "UTC", "--prompt", "go", "--data-dir", directory], {
        io: plain.io,
      }),
    ).toBe(EXIT.ok);
    const shown = capture();
    expect(await main(["schedules", "show", "plain", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toMatch(/run limit {3}30 minutes of work \(the default\), then stopped/);
  });

  it("keeps when a schedule tells its person from --notify, shows it, and changes only it on update", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory, ["--notify", "when-sent"]);
    const show = async () => {
      const shown = capture();
      expect(await main(["schedules", "show", id, "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
      return shown.stdout();
    };
    expect(await show()).toMatch(
      /notifies {4}only when a run has something to send; a run with nothing to tell stays quiet; failures always/,
    );
    const updated = capture();
    expect(await main(["schedules", "update", id, "--notify", "if-changed", "--data-dir", directory], { io: updated.io })).toBe(EXIT.ok);
    await withStore(directory, async (store) => {
      const stored = await store.asPort().repositories.schedules.get(id);
      expect(stored?.notify).toBe("if-changed");
      expect(stored?.autoApproveTools).toEqual(["reports.*", "messaging.send_to", "http.*"]);
      expect(stored?.spec).toEqual({ at: "07:00", timezone: "Europe/Sofia" });
    });
    expect(await show()).toMatch(/notifies {4}after each run, but never the same result twice in a row; failures always/);
    const refused = capture();
    expect(await main(["schedules", "update", id, "--notify", "sometimes", "--data-dir", directory], { io: refused.io })).toBe(EXIT.usage);
    expect(refused.stderr()).toMatch(/--notify must be one of always, when-sent, if-changed/);
    expect(await main(["schedules", "update", id, "--notify", "always", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    expect(await show()).toMatch(/notifies {4}after every run; failures always/);
  });

  it("keeps a pre-check from --precheck, shows it, removes it with none, and refuses what it cannot check", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory, ["--precheck", "page-changed:https://Example.com/news#top"]);
    const show = async () => {
      const shown = capture();
      expect(await main(["schedules", "show", id, "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
      return shown.stdout();
    };
    // Written as it is fetched: a lower-case host, no fragment.
    expect(await show()).toMatch(/pre-check {3}runs only when the page https:\/\/example\.com\/news has changed since the last check\n/);
    expect(
      await main(["schedules", "update", id, "--precheck", "feed-has-new https://example.com/feed.xml", "--data-dir", directory], {
        io: capture().io,
      }),
    ).toBe(EXIT.ok);
    await withStore(directory, async (store) => {
      const stored = await store.asPort().repositories.schedules.get(id);
      expect(stored?.precheck).toEqual({ kind: "feed-has-new", target: "https://example.com/feed.xml" });
      expect(stored?.spec).toEqual({ at: "07:00", timezone: "Europe/Sofia" });
    });
    for (const [bad, said] of [
      ["page-changed:http://example.com/", /https address/],
      ["page-changed:https://10.0.0.1/", /https address/],
      ["page-changed:https://user:pw@example.com/", /https address/],
      ["file-changed:notes.txt", /absolute path/],
      ["watch:https://example.com/", /a pre-check is page-changed/],
    ] as const) {
      const refused = capture();
      expect(await main(["schedules", "update", id, "--precheck", bad, "--data-dir", directory], { io: refused.io }), bad).toBe(EXIT.usage);
      expect(refused.stderr()).toMatch(said);
    }
    // A file is checked against a running owner's --fs-root folders, which an offline write has none of.
    const offline = capture();
    expect(
      await main(["schedules", "update", id, "--precheck", "file-changed:/tmp/notes.txt", "--data-dir", directory], { io: offline.io }),
    ).not.toBe(EXIT.ok);
    expect(offline.stderr()).toMatch(/needs a running owner/);
    const refusedNone = capture();
    expect(
      await main(
        [
          "schedules",
          "add",
          "--name",
          "n",
          "--at",
          "07:00",
          "--timezone",
          "UTC",
          "--prompt",
          "go",
          "--precheck",
          "none",
          "--data-dir",
          directory,
        ],
        { io: refusedNone.io },
      ),
    ).toBe(EXIT.usage);
    expect(await main(["schedules", "update", id, "--precheck", "none", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    expect(await show()).toMatch(/pre-check {3}none: every fire runs\n/);
  });

  it("says a schedule its failures paused and how to resume it, a retried try in its fires, and enable clears both", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory);
    await withStore(directory, async (store) => {
      const schedules = store.asPort().repositories.schedules;
      const fireTime = (await schedules.get(id))?.nextRunAt ?? "";
      await schedules.recordFire({
        scheduleId: id,
        taskId: "task-1",
        outcome: "retrying at 2026-04-05T04:02:00.000Z (retry 2 of 3) after a provider error: 429",
        outcomeKind: "skipped",
        fire: { fireTime, reasonCode: "retry", retryCount: 1 },
        now: fireTime,
      });
      for (let failed = 0; failed < 3; failed += 1) {
        await schedules.recordRun({ scheduleId: id, taskId: null, outcome: "failed: boom", outcomeKind: "failed", now: fireTime });
      }
      expect(
        await schedules.pauseForFailures({
          scheduleId: id,
          failures: 3,
          fireTime,
          outcome: "paused: 3 failed runs in a row",
          now: fireTime,
        }),
      ).toBe(true);
    });
    const show = async () => {
      const shown = capture();
      expect(await main(["schedules", "show", id, "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
      return shown.stdout();
    };
    expect(await show()).toMatch(/state {7}paused after 3 failed runs in a row; resume it to run again\n/);
    expect(await show()).toMatch(/\tretry \(retry 1\)\tretrying at /);
    const listed = capture();
    expect(await main(["schedules", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stdout()).toContain("\tpaused:failures\tnext=-\tfailures=3\t");
    expect(await main(["schedules", "enable", id, "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    expect(await show()).toMatch(/state {7}enabled\n[\s\S]*failures {4}0 consecutive/);
  });

  it("keeps a token ceiling from --max-tokens, shows it, and removes it with off; none is set unless asked", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory, ["--max-tokens", "250_000"]);
    const show = async () => {
      const shown = capture();
      expect(await main(["schedules", "show", id, "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
      return shown.stdout();
    };
    expect(await show()).toMatch(/tokens {6}250,000 tokens a run, its workers included, then stopped/);
    const updated = capture();
    expect(await main(["schedules", "update", id, "--max-tokens", "1,000", "--data-dir", directory], { io: updated.io })).toBe(EXIT.ok);
    await withStore(directory, async (store) => {
      const stored = await store.asPort().repositories.schedules.get(id);
      expect(stored?.maxTokens).toBe(1_000);
      expect(stored?.spec).toEqual({ at: "07:00", timezone: "Europe/Sofia" });
    });
    for (const bad of ["999", "100000001", "2.5", "lots"]) {
      const refused = capture();
      expect(await main(["schedules", "update", id, "--max-tokens", bad, "--data-dir", directory], { io: refused.io }), bad).toBe(
        EXIT.usage,
      );
      expect(refused.stderr()).toMatch(/--max-tokens expects 1000-100000000 or off/);
    }
    // The help says a run can go past its ceiling by the one model call that crossed it.
    expect(SCHEDULES_USAGE.replace(/\s+/g, " ")).toMatch(/so a run can go past it by one/);
    const cleared = capture();
    expect(await main(["schedules", "update", id, "--max-tokens", "off", "--data-dir", directory], { io: cleared.io })).toBe(EXIT.ok);
    expect(await show()).toMatch(/tokens {6}no ceiling/);
    const plain = capture();
    expect(
      await main(["schedules", "add", "--name", "plain", "--at", "07:00", "--timezone", "UTC", "--prompt", "go", "--data-dir", directory], {
        io: plain.io,
      }),
    ).toBe(EXIT.ok);
    await withStore(directory, async (store) => {
      expect((await store.asPort().repositories.schedules.list()).find((schedule) => schedule.name === "plain")).not.toHaveProperty(
        "maxTokens",
      );
    });
  });

  it("shows the recent fires, newest first, in the workspace's zone, each with why it ended so", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory);
    const never = capture();
    expect(await main(["schedules", "show", id, "--data-dir", directory], { io: never.io })).toBe(EXIT.ok);
    expect(never.stdout()).toMatch(/recent fires \(.+\):\n {4}\(none recorded\)/);

    await withStore(directory, async (store) => {
      const repositories = store.asPort().repositories;
      await repositories.workspaceSettings.set({
        workspaceId: "default",
        settings: { timezone: "Europe/Sofia" },
        expectedRevision: 0,
        actor: "operator:cli",
        now: "2026-04-05T03:00:00.000Z",
      });
      await repositories.schedules.recordRun({
        scheduleId: id,
        taskId: null,
        outcome: "skipped: missed by 420m (beyond the 6h catch-up window)",
        outcomeKind: "skipped",
        fire: { fireTime: "2026-04-04T04:00:00.000Z", reasonCode: "missed" },
        now: "2026-04-04T11:00:00.000Z",
      });
      await repositories.schedules.recordRun({
        scheduleId: id,
        taskId: "task-7",
        outcome: "completed",
        outcomeKind: "succeeded",
        fire: { fireTime: "2026-04-05T04:00:00.000Z", reasonCode: "ok" },
        now: "2026-04-05T04:02:00.000Z",
      });
    });
    const shown = capture();
    expect(await main(["schedules", "show", id, "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toContain(
      [
        "  recent fires (Europe/Sofia):",
        "    Sun, 05/04/2026, 07:00\tok\tcompleted\ttask task-7",
        "    Sat, 04/04/2026, 07:00\tmissed\tskipped: missed by 420m (beyond the 6h catch-up window)",
      ].join("\n"),
    );
    const json = capture();
    expect(await main(["schedules", "show", id, "--format", "json", "--data-dir", directory], { io: json.io })).toBe(EXIT.ok);
    const answer = JSON.parse(json.stdout()) as { timezone: string; recentFires: { reasonCode: string }[] };
    expect(answer.timezone).toBe("Europe/Sofia");
    expect(answer.recentFires.map((fire) => fire.reasonCode)).toEqual(["ok", "missed"]);
  });

  it("says list, show, enable and disable in the read-back's words: days by name, the next run in the schedule's zone, the failures in a row", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory, ["--days", "1,5"]);
    let next = "";
    await withStore(directory, async (store) => {
      const schedules = store.asPort().repositories.schedules;
      const stored = await schedules.get(id);
      next = stored?.nextRunAt ?? "";
      await schedules.recordRun({
        scheduleId: id,
        taskId: "task-1",
        outcome: "failed: the provider refused",
        outcomeKind: "failed",
        fire: { fireTime: next, reasonCode: "failed" },
        now: next,
      });
    });
    // The next run as the read-back says it, in Europe/Sofia: "Mon 5 Oct 07:00".
    const local = /next=(Mon|Fri) \d{1,2} \w{3} 07:00\t/;
    const listed = capture();
    expect(await main(["schedules", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    const line = listed.stdout();
    expect(line).toContain(`${id}\tmorning-brief\tevery Mon, Fri at 07:00 (Europe/Sofia)\tenabled\t`);
    expect(line).toMatch(local);
    expect(line).toContain("\tfailures=1\tlast=failed: the provider refused\n");
    expect(line).not.toContain(next);

    const shown = capture();
    expect(await main(["schedules", "show", id, "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toMatch(/fires {7}every Mon, Fri at 07:00 \(Europe\/Sofia\)\n/);
    expect(shown.stdout()).toMatch(/next fire {3}(Mon|Fri) \d{1,2} \w{3} 07:00\n/);
    expect(shown.stdout()).toMatch(/failures {4}1 consecutive/);

    const paused = capture();
    expect(await main(["schedules", "disable", id, "--data-dir", directory], { io: paused.io })).toBe(EXIT.ok);
    expect(paused.stdout()).toBe(`${id}\tmorning-brief\tdisabled\tnext=-\n`);
    const resumed = capture();
    expect(await main(["schedules", "enable", id, "--data-dir", directory], { io: resumed.io })).toBe(EXIT.ok);
    expect(resumed.stdout()).toMatch(new RegExp(`^${id}\tmorning-brief\tenabled\tnext=(Mon|Fri) \\d{1,2} \\w{3} 07:00\n$`));
  });

  it("says a fire being handed to its run as running, never as the scheduler's own mark", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory);
    await withStore(directory, async (store) => {
      store.asPort().repositories.schedules.markRunning({
        scheduleId: id,
        taskId: "task-1",
        fireTime: "2026-10-05T04:00:00.000Z",
        now: "2026-10-05T04:00:00.000Z",
      });
    });
    const listed = capture();
    expect(await main(["schedules", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stdout()).toMatch(/\tlast=running \(fire due [^)]*07:00\)\n/);
    const shown = capture();
    expect(await main(["schedules", "show", id, "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    // `show` reads times in the workspace's zone, the host's while none is set: 07:00 in Sofia, 04:00 on a UTC runner.
    const due = fireTimeText("2026-10-05T04:00:00.000Z", hostTimeZone());
    expect(shown.stdout()).toContain(`(running (fire due ${due}))\n`);
    expect(shown.stdout()).not.toContain("dispatching");
  });

  it("lists schedules and reports an unknown one as usage rather than crashing", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory);
    const listed = capture();
    expect(await main(["schedules", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stdout()).toContain(id);
    expect(listed.stdout()).toContain("enabled");

    const missing = capture();
    expect(await main(["schedules", "show", "nope", "--data-dir", directory], { io: missing.io })).toBe(EXIT.usage);
    expect(missing.stderr()).toMatch(/no schedule "nope" exists/);
  });

  it("lists the agenda: each occurrence in the window, in JSON or as text", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory);
    const json = capture();
    expect(
      await main(["schedules", "agenda", "--days", "3", "--format", "json", "--data-dir", directory], { io: json.io }),
      json.stderr(),
    ).toBe(EXIT.ok);
    const answer = JSON.parse(json.stdout()) as { timezone: string; items: { kind: string; id: string; at: string; cadence: unknown }[] };
    expect(answer.timezone.length).toBeGreaterThan(0);
    // A 72-hour window holds two to four 07:00s, whatever the time of day.
    expect(answer.items.length).toBeGreaterThanOrEqual(2);
    expect(answer.items.length).toBeLessThanOrEqual(4);
    const sofia = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    for (const item of answer.items) {
      expect(item).toMatchObject({ kind: "schedule", id, cadence: { kind: "daily", at: "07:00", timezone: "Europe/Sofia" } });
      expect(sofia.format(new Date(item.at))).toBe("07:00");
    }
    const text = capture();
    expect(await main(["schedules", "agenda", "--data-dir", directory], { io: text.io })).toBe(EXIT.ok);
    expect(text.stdout()).toMatch(/^Agenda \(/);
    // Its time as `list` says one, and its own cadence in words (its zone said only when it is not the agenda's).
    expect(text.stdout()).toMatch(
      /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} \d\d:\d\d +schedule +morning-brief +Daily 07:00( · Europe\/Sofia)? +sched-/m,
    );

    expect(text.stderr()).not.toMatch(/the agenda lists the first/);
    const cut = capture();
    expect(await main(["schedules", "agenda", "--limit", "1", "--format", "json", "--data-dir", directory], { io: cut.io })).toBe(EXIT.ok);
    expect(JSON.parse(cut.stdout())).toMatchObject({ truncated: true, skipped: [] });
    expect(cut.stderr()).toMatch(/note: the agenda lists the first 1 occurrences/);
    const badLimit = capture();
    expect(await main(["schedules", "agenda", "--limit", "201", "--data-dir", directory], { io: badLimit.io })).toBe(EXIT.usage);

    const tooLong = capture();
    expect(await main(["schedules", "agenda", "--days", "32", "--data-dir", directory], { io: tooLong.io })).toBe(EXIT.usage);
    expect(tooLong.stderr()).toMatch(/--days for agenda expects 1-31/);
  });

  it("clears days, the agent and the alert target on update, and refuses a clear anywhere else", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory, ["--days", "1,2,3,4,5"]);
    const update = async (...flags: string[]) => {
      const out = capture();
      const code = await main(["schedules", "update", id, ...flags, "--data-dir", directory], { io: out.io });
      return { code, stderr: out.stderr() };
    };
    await withStore(directory, async (store) => {
      expect((await store.asPort().repositories.schedules.get(id))?.spec.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    });
    expect((await update("--days", "none", "--no-alert", "--no-agent")).code).toBe(EXIT.ok);
    await withStore(directory, async (store) => {
      const stored = await store.asPort().repositories.schedules.get(id);
      expect(stored?.spec).toEqual({ at: "07:00", timezone: "Europe/Sofia" });
      expect(stored?.alert).toBeUndefined();
      expect(stored?.agentId).toBeUndefined();
      // What was not cleared stays.
      expect(stored?.autoApproveTools).toEqual(["reports.*", "messaging.send_to", "http.*"]);
    });
    expect(await update("--agent", "chief", "--no-agent")).toMatchObject({
      code: EXIT.usage,
      stderr: expect.stringMatching(/--agent and --no-agent cannot be given together/),
    });
    expect(await update("--no-alert", "--alert-connection", "telegram-main")).toMatchObject({
      code: EXIT.usage,
      stderr: expect.stringMatching(/--no-alert cannot be given with/),
    });
    const add = capture();
    expect(
      await main(
        [
          "schedules",
          "add",
          "--name",
          "x",
          "--at",
          "07:00",
          "--timezone",
          "UTC",
          "--prompt",
          "go",
          "--days",
          "none",
          "--data-dir",
          directory,
        ],
        { io: add.io },
      ),
    ).toBe(EXIT.usage);
    expect(add.stderr()).toMatch(/--days none clears a schedule's days: it is for update only/);
    const addClear = capture();
    expect(
      await main(
        ["schedules", "add", "--name", "x", "--at", "07:00", "--timezone", "UTC", "--prompt", "go", "--no-alert", "--data-dir", directory],
        { io: addClear.io },
      ),
    ).toBe(EXIT.usage);
    expect(addClear.stderr()).toMatch(/does not accept --no-alert/);
  });

  it("adds and changes every cadence: several times, every few hours in a window, monthly, yearly, once and until", async () => {
    const directory = directories.create();
    const added = capture();
    expect(
      await main(
        // biome-ignore format: one flag and its value to a line reads as the command does
        [
          "schedules", "add", "--name", "shapes", "--at", "07:00,19:00", "--monthly", "last:fri", "--until", "2099-12-31",
          "--timezone", "Europe/Sofia", "--prompt", "go", "--format", "json", "--data-dir", directory,
        ],
        { io: added.io },
      ),
      added.stderr(),
    ).toBe(EXIT.ok);
    const id = (JSON.parse(added.stdout()) as { scheduleId: string }).scheduleId;
    const spec = async () => withStore(directory, async (store) => (await store.asPort().repositories.schedules.get(id))?.spec);
    expect(await spec()).toEqual({
      times: ["07:00", "19:00"],
      timezone: "Europe/Sofia",
      monthly: { nth: -1, weekday: 5 },
      until: "2099-12-31",
    });
    const update = async (...flags: string[]) => {
      const out = capture();
      const code = await main(["schedules", "update", id, ...flags, "--data-dir", directory], { io: out.io });
      return { code, stdout: out.stdout(), stderr: out.stderr() };
    };
    // The times are replaced together, the days kept; then the days are replaced, the window kept.
    expect((await update("--every-hours", "2", "--between", "08:00-18:00")).code).toBe(EXIT.ok);
    expect(await spec()).toEqual({
      everyHours: 2,
      between: { from: "08:00", to: "18:00" },
      timezone: "Europe/Sofia",
      monthly: { nth: -1, weekday: 5 },
      until: "2099-12-31",
    });
    expect((await update("--yearly", "12-25", "--until", "none")).code).toBe(EXIT.ok);
    expect(await spec()).toEqual({
      everyHours: 2,
      between: { from: "08:00", to: "18:00" },
      timezone: "Europe/Sofia",
      yearly: { month: 12, day: 25 },
    });
    const once = await update("--at", "09:30", "--once", "2099-06-01");
    expect(once.code).toBe(EXIT.ok);
    expect(once.stdout).toContain("once on 2099-06-01 at 09:30 (Europe/Sofia)");
    expect(await spec()).toEqual({ at: "09:30", timezone: "Europe/Sofia", once: "2099-06-01" });
    expect((await update("--days", "none")).code).toBe(EXIT.ok);
    expect(await spec()).toEqual({ at: "09:30", timezone: "Europe/Sofia" });
    // A date already past has no run left: refused when written, not found finished at a fire.
    expect(await update("--once", "2020-01-01")).toMatchObject({ code: EXIT.usage, stderr: expect.stringMatching(/has no run left/) });
    expect(await update("--at", "07:00", "--every-hours", "2")).toMatchObject({
      code: EXIT.usage,
      stderr: expect.stringMatching(/--at and --every-hours cannot be given together/),
    });
    expect(await update("--monthly", "1", "--days", "1")).toMatchObject({ code: EXIT.usage, stderr: expect.stringMatching(/one of them/) });
    expect(await update("--between", "8-18")).toMatchObject({
      code: EXIT.usage,
      stderr: expect.stringMatching(/--between expects HH:MM-HH:MM/),
    });
    expect(await update("--every-hours", "13")).toMatchObject({
      code: EXIT.usage,
      stderr: expect.stringMatching(/--every-hours expects 1-12/),
    });
    expect(await update("--once", "2099-06-01", "--until", "2099-07-01")).toMatchObject({
      code: EXIT.usage,
      stderr: expect.stringMatching(/takes no --until/),
    });
  });

  it("will not resume a schedule whose last run is past, and says it finished", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory, ["--once", "2099-06-01"]);
    await withStore(directory, async (store) => {
      const schedules = store.asPort().repositories.schedules;
      // As the scheduler leaves one after its last fire: disabled, with no next run, and its date past.
      await schedules.update({
        scheduleId: id,
        spec: { at: "07:00", timezone: "Europe/Sofia", once: "2020-01-01" },
        now: new Date().toISOString(),
      });
      await schedules.setEnabled({ scheduleId: id, enabled: false, nextRunAt: null, now: new Date().toISOString() });
    });
    const shown = capture();
    expect(await main(["schedules", "show", id, "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toMatch(/state +finished: its last run is past/);
    const enabled = capture();
    expect(await main(["schedules", "enable", id, "--data-dir", directory], { io: enabled.io })).toBe(EXIT.usage);
    expect(enabled.stderr()).toMatch(/has finished: .* has no run left; move its once or until date later/);
    // A later date is what it asks for, and it runs again then.
    const moved = capture();
    expect(await main(["schedules", "update", id, "--once", "2099-06-01", "--data-dir", directory], { io: moved.io })).toBe(EXIT.ok);
    await withStore(directory, async (store) => {
      expect(await store.asPort().repositories.schedules.get(id)).toMatchObject({ enabled: true, nextRunAt: "2099-06-01T04:00:00.000Z" });
    });
  });

  it("says a monthly or yearly reminder on the agenda as the web app does", () => {
    const text = agendaText({
      timezone: "Europe/Sofia",
      truncated: false,
      skipped: [],
      items: [
        {
          kind: "reminder",
          id: "rem-rent",
          title: "Pay rent",
          at: "2026-11-01T07:00:00.000Z",
          cadence: { kind: "repeat", at: "09:00", timezone: "Europe/Sofia", monthly: { dayOfMonth: 1 } },
          enabled: true,
          reminder: { cadence: "repeat", times: ["09:00"], monthly: { dayOfMonth: 1 } },
        },
        {
          kind: "reminder",
          id: "rem-birthday",
          title: "Birthday",
          at: "2027-02-28T06:00:00.000Z",
          cadence: { kind: "repeat", at: "08:00", timezone: "Europe/Sofia", yearly: { month: 2, day: 29 } },
          enabled: true,
          reminder: { cadence: "repeat", times: ["08:00"], yearly: { month: 2, day: 29 } },
        },
      ],
    });
    expect(text).toMatch(/ Pay rent {2,}Monthly on the 1st, 09:00 +rem-rent$/m);
    expect(text).toMatch(/ Birthday {2,}Yearly on 29 Feb, 08:00 +rem-birthday$/m);
    expect(text).not.toMatch(/Daily|daily/);
    // The zone is said once, in the heading; the columns line up.
    expect(text.split("\n")[0]).toBe("Agenda (Europe/Sofia)");
    expect(text).not.toContain("08:00 Europe/Sofia");
    const [, first, second] = text.split("\n");
    expect(first?.indexOf("rem-rent")).toBe(second?.indexOf("rem-birthday"));
  });

  it("says each row's time, cadence and event as the other commands do, a schedule by its own spec", () => {
    const zone = "Europe/London";
    const text = agendaText(
      {
        timezone: zone,
        truncated: false,
        skipped: [],
        items: [
          {
            kind: "schedule",
            id: "sched-brief",
            title: "morning-brief",
            at: "2026-11-03T07:30:00.000Z",
            cadence: { kind: "daily", at: "07:30", timezone: zone, daysOfWeek: [1, 2, 3, 4, 5] },
            enabled: true,
          },
          {
            kind: "schedule",
            id: "sched-desk",
            title: "desk-check",
            at: "2026-11-03T10:00:00.000Z",
            cadence: { kind: "daily", at: "10:00", timezone: zone, daysOfWeek: [1, 2, 3, 4, 5] },
            enabled: true,
          },
          {
            kind: "reminder",
            id: "rem-stretch",
            title: "Stretch",
            at: "2026-11-03T15:00:00.000Z",
            cadence: { kind: "daily", at: "15:00", timezone: zone, daysOfWeek: [1, 2, 3, 4, 5] },
            enabled: true,
            reminder: { cadence: "repeat", times: ["10:00", "15:00"] },
          },
          {
            kind: "reminder",
            id: "rem-dentist",
            title: "Dentist appointment",
            at: "2026-11-04T20:00:00.000Z",
            cadence: { kind: "once" },
            enabled: true,
            reminder: { cadence: "event", eventAt: "2026-11-05T10:00:00.000Z", notice: "-1d@20:00" },
          },
        ],
      },
      new Map([
        ["sched-brief", { at: "07:30", daysOfWeek: [1, 2, 3, 4, 5], timezone: zone }],
        ["sched-desk", { everyHours: 2, between: { from: "08:00", to: "18:00" }, daysOfWeek: [1, 2, 3, 4, 5], timezone: zone }],
      ]),
    );
    expect(text).toMatch(/^Tue 3 Nov 07:30 +schedule +morning-brief +Mon–Fri 07:30 +sched-brief$/m);
    expect(text).toMatch(/^Tue 3 Nov 10:00 +schedule +desk-check +Mon–Fri every 2 h 08:00–18:00 +sched-desk$/m);
    expect(text).toMatch(/^Tue 3 Nov 15:00 +reminder +Stretch +Mon–Fri 10:00, 15:00 +rem-stretch$/m);
    expect(text).toMatch(/^Wed 4 Nov 20:00 +reminder +Dentist appointment +1 day before at 20:00 \(event Thu 5 Nov 10:00\) +rem-dentist$/m);
    expect(text).not.toMatch(/Z\b|\d\d\/\d\d\/\d{4}|days 1,2|-1d@/);
  });

  it("says a due to-do on the agenda is a to-do", () => {
    const text = agendaText({
      timezone: "Europe/London",
      truncated: false,
      skipped: [],
      items: [
        {
          kind: "reminder",
          id: "todo-plumber",
          title: "Call the plumber",
          at: "2026-11-06T17:00:00.000Z",
          cadence: { kind: "once" },
          enabled: true,
          todo: true,
          reminder: { cadence: "once" },
        },
      ],
    });
    expect(text).toMatch(/^Fri 6 Nov 17:00 +to-do +Call the plumber +Once +todo-plumber$/m);
  });

  it("keeps the zone of an item in another zone, and lines up wide titles", () => {
    const text = agendaText({
      timezone: "Etc/GMT",
      truncated: false,
      skipped: [],
      items: [
        {
          kind: "reminder",
          id: "rem-far",
          title: "提醒我",
          at: "2026-11-01T07:00:00.000Z",
          cadence: { kind: "daily", at: "09:00", timezone: "Etc/GMT+5" },
          enabled: true,
          overdue: true,
          reminder: { cadence: "repeat", times: ["09:00"] },
        },
        {
          kind: "reminder",
          id: "rem-near",
          title: "Water",
          at: "2026-11-01T08:00:00.000Z",
          cadence: { kind: "daily", at: "10:00", timezone: "Etc/GMT" },
          enabled: true,
          reminder: { cadence: "repeat", times: ["10:00"] },
        },
      ],
    });
    // A zone that only starts like the agenda's is another zone, said whole.
    expect(text).toContain("Daily 09:00 · Etc/GMT+5 · overdue");
    expect(text).toMatch(/ Daily 10:00 +rem-near$/m);
    // Two columns wide each, the CJK title still leaves the ids lined up on screen.
    const [, far, near] = text.split("\n");
    expect(far?.indexOf("rem-far")).toBe((near?.indexOf("rem-near") ?? 0) - 3);
  });

  it("disabling clears the next fire and enabling re-arms it from now", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory);
    const disabled = capture();
    expect(await main(["schedules", "disable", id, "--format", "json", "--data-dir", directory], { io: disabled.io })).toBe(EXIT.ok);
    const off = JSON.parse(disabled.stdout()) as ScheduleRecord;
    expect(off.enabled).toBe(false);
    // A disabled schedule must not advertise a fire that will not happen —
    // otherwise `schedules list` shows a time, and the next morning nothing runs.
    expect(off.nextRunAt).toBeNull();

    const enabled = capture();
    expect(await main(["schedules", "enable", id, "--format", "json", "--data-dir", directory], { io: enabled.io })).toBe(EXIT.ok);
    const on = JSON.parse(enabled.stdout()) as ScheduleRecord;
    expect(on.enabled).toBe(true);
    // Re-armed from *now*, so a month disabled does not owe a month of catch-up.
    expect(on.nextRunAt).toBe(nextOccurrence(on.spec, new Date())?.toISOString());
  });

  it("removes a schedule and then refuses to address it", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory);
    const removed = capture();
    expect(await main(["schedules", "remove", id, "--data-dir", directory], { io: removed.io })).toBe(EXIT.ok);
    const again = capture();
    expect(await main(["schedules", "show", id, "--data-dir", directory], { io: again.io })).toBe(EXIT.usage);
  });

  it("refuses an edit flag on a lifecycle action instead of silently ignoring it", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory);
    const bad = capture();
    // `enable` mutates one bit; accepting `--prompt` and ignoring it would look
    // like the edit succeeded.
    expect(await main(["schedules", "enable", id, "--prompt", "new prompt", "--data-dir", directory], { io: bad.io })).toBe(EXIT.usage);
    expect(bad.stderr()).toMatch(/schedules enable does not accept --prompt/);
  });

  it("fails run-now clearly when no model target is configured, instead of pretending to run", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory);
    const bad = capture();
    // `run-now` admits a real model turn, so it needs the same explicit target
    // `tavi run` needs, and a *missing* target must be reported as a
    // usage problem rather than surfacing as a mysterious run failure.
    const code = await main(["schedules", "run-now", id, "--data-dir", directory], { io: bad.io });
    expect(code).toBe(EXIT.usage);
    expect(bad.stderr()).toMatch(/no model is configured/);
    // Its own usage, not `tavi run`'s: the flags an operator needs here are
    // `--at`/`--allow`/`--alert-*`, which `tavi run`'s help does not mention.
    expect(bad.stderr()).toMatch(/tavi schedules <action> \[options\]/);
  });

  it("refuses an unknown action with the usage text", async () => {
    const bad = capture();
    expect(await main(["schedules", "frobnicate"], { io: bad.io })).toBe(EXIT.usage);
    expect(bad.stderr()).toMatch(/Unknown schedules action/);
  });

  it("documents its own flags on --help, rather than printing only the general help", async () => {
    const shown = capture();
    expect(await main(["schedules", "--help"], { io: shown.io })).toBe(EXIT.ok);
    // The unattended policy is the part an operator cannot guess, so the flags
    // that author it have to be discoverable from the command itself.
    expect(shown.stdout()).toMatch(/Author recurring unattended runs/);
    expect(shown.stdout()).toMatch(/--allow <tool>/);
    expect(shown.stdout()).toMatch(/--alert-destination/);
  });
});

it("updates supplied fields offline and preserves policy and timing otherwise", async () => {
  const directory = directories.create();
  const id = await addSchedule(directory);
  const before = await withStore(directory, async (store) => (await store.asPort().repositories.schedules.get(id))!);
  const output = capture();
  expect(await main(["schedules", "update", id, "--prompt", "updated", "--data-dir", directory], { io: output.io })).toBe(EXIT.ok);
  const after = await withStore(directory, async (store) => (await store.asPort().repositories.schedules.get(id))!);
  expect(after.prompt).toBe("updated");
  expect(after.nextRunAt).toBe(before.nextRunAt);
  expect(after.autoApproveTools).toEqual(before.autoApproveTools);
});

describe("schedules preview", () => {
  /** A workspace whose zone is `timezone`: all preview reads of the store. */
  const settings = (timezone: string | undefined) =>
    ({
      workspaceSettings: { get: async () => ({ settings: timezone === undefined ? {} : { timezone } }) },
    }) as unknown as Parameters<typeof schedulePreview>[0];
  const now = new Date("2026-10-28T12:00:00.000Z");

  it("answers a cadence's next three runs from the engine the scheduler fires by, in its zone", async () => {
    const answer = await schedulePreview(
      settings("UTC"),
      { action: "preview", times: ["19:00", "07:00"], timezone: "Europe/Sofia", days: [1, 3] },
      now,
    );
    // Wednesday 28 October is past 07:00 Sofia; the clocks went back on the 25th (UTC+2).
    expect(answer).toEqual({
      timezone: "Europe/Sofia",
      text: "every Mon, Wed at 07:00 and 19:00 (Europe/Sofia)",
      runs: ["2026-10-28T17:00:00.000Z", "2026-11-02T05:00:00.000Z", "2026-11-02T17:00:00.000Z"],
    });
    const spec = { times: ["07:00", "19:00"], timezone: "Europe/Sofia", daysOfWeek: [1, 3] };
    let after = now;
    for (const run of answer.runs) {
      const next = nextOccurrence(spec, after)!;
      expect(run).toBe(next.toISOString());
      after = next;
    }
  });

  it("reads a cadence with no zone in the workspace's, and answers up to ten runs", async () => {
    const answer = await schedulePreview(
      settings("Asia/Tokyo"),
      { action: "preview", everyHours: 4, between: { from: "08:00", to: "20:00" }, limit: 50 },
      now,
    );
    expect(answer.timezone).toBe("Asia/Tokyo");
    expect(answer.runs).toHaveLength(10);
    // 21:00 Tokyo now: the next is 08:00 tomorrow, then every four hours to 20:00.
    expect(answer.runs.slice(0, 4)).toEqual([
      "2026-10-28T23:00:00.000Z",
      "2026-10-29T03:00:00.000Z",
      "2026-10-29T07:00:00.000Z",
      "2026-10-29T11:00:00.000Z",
    ]);
    expect((await schedulePreview(settings("UTC"), { action: "preview", at: "09:00", limit: 1 }, now)).runs).toEqual([
      "2026-10-29T09:00:00.000Z",
    ]);
  });

  it("answers fewer runs for a cadence that ends, and none for one that has", async () => {
    const yearly = await schedulePreview(settings("UTC"), { action: "preview", at: "09:00", yearly: { month: 2, day: 29 } }, now);
    expect(yearly.runs).toEqual(["2027-02-28T09:00:00.000Z", "2028-02-29T09:00:00.000Z", "2029-02-28T09:00:00.000Z"]);
    const ending = await schedulePreview(settings("UTC"), { action: "preview", at: "09:00", untilDate: "2026-10-30" }, now);
    expect(ending.runs).toEqual(["2026-10-29T09:00:00.000Z", "2026-10-30T09:00:00.000Z"]);
    expect((await schedulePreview(settings("UTC"), { action: "preview", at: "09:00", once: "2026-10-01" }, now)).runs).toEqual([]);
    const monthly = await schedulePreview(settings("UTC"), { action: "preview", at: "09:00", monthly: { nth: -1, weekday: 5 } }, now);
    expect(monthly.runs).toEqual(["2026-10-30T09:00:00.000Z", "2026-11-27T09:00:00.000Z", "2026-12-25T09:00:00.000Z"]);
  });

  it("refuses a cadence the schema refuses, and a zone it does not know, in words", async () => {
    await expect(
      schedulePreview(settings("UTC"), { action: "preview", everyHours: 2, between: { from: "18:00", to: "08:00" } }, now),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("between must end after it starts") });
    await expect(schedulePreview(settings("UTC"), { action: "preview", timezone: "UTC" }, now)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(schedulePreview(settings("UTC"), { action: "preview", at: "09:00", timezone: "Mars/Olympus" }, now)).rejects.toMatchObject(
      {
        code: "INVALID_INPUT",
        message: expect.stringContaining("Mars/Olympus"),
      },
    );
  });
});

describe("schedules tools", () => {
  it("offers what a schedule may list: no scheduling writes, form fills or MCP tools not approved read-only", async () => {
    const asked: string[] = [];
    const mcp = {
      listTools: async (pluginId: string) => {
        asked.push(pluginId);
        return [
          { toolId: "mcp.files.read", state: "approved", decision: { effect: "read-only" } },
          { toolId: "mcp.files.write", state: "approved", decision: { effect: "write" } },
          { toolId: "mcp.files.peek", state: "pending" },
        ];
      },
    };
    const answer = await scheduleTools(
      { mcp } as unknown as Parameters<typeof scheduleTools>[0],
      [
        "web_search",
        "reports.write",
        "reports.read",
        "pdf.fill",
        "pdf.read",
        "schedules.add",
        "schedules.list",
        "routines.create",
        "mcp.files.read",
        "mcp.files.write",
        "mcp.files.peek",
      ].map((id) => ({ id, effect: "read-only" as const })),
    );
    expect(answer).toEqual({
      tools: ["mcp.files.read", "pdf.read", "reports.read", "reports.write", "schedules.list", "web_search"],
      families: ["pdf.*", "reports.*"],
      readOnly: ["mcp.files.read", "pdf.read", "reports.read", "reports.write", "schedules.list", "web_search"],
    });
    // One read of each MCP server's tools, however many of them are registered.
    expect(asked).toEqual(["mcp.files"]);
  });

  it("offers a family only when every registered tool in it is read-only, and names the read-only tools", async () => {
    const mcp = { listTools: async () => [] };
    const answer = await scheduleTools({ mcp } as unknown as Parameters<typeof scheduleTools>[0], [
      { id: "sandbox.run", effect: "mutating" },
      { id: "sandbox.status", effect: "read-only" },
      { id: "fs.read", effect: "read-only" },
      { id: "fs.write", effect: "external" },
      { id: "reports.read", effect: "read-only" },
      { id: "reports.list", effect: "read-only" },
    ]);
    expect(answer).toEqual({
      tools: ["fs.read", "fs.write", "reports.list", "reports.read", "sandbox.run", "sandbox.status"],
      families: ["reports.*"],
      readOnly: ["fs.read", "reports.list", "reports.read", "sandbox.status"],
    });
  });
});

it("lists a routine's one-off at its date and minute in the routine's zone, and shows its catch-up as the missed policy", async () => {
  const directory = directories.create();
  const client = await DatabaseClient.open({
    databasePath: join(directory, "tavi.sqlite"),
    artifactsDirectory: join(directory, "artifacts"),
  });
  try {
    await client.call("routine.configure", {
      ownerEpoch: "fixture",
      workspaces: [{ workspaceId: "default", principalId: "operator", permissions: [] }],
      toolPermissions: { web_search: [] },
      destinations: [],
      deliveryAuthorizationAvailable: false,
      providerConnectionIds: [],
      modelOverride: true,
      executionAvailable: true,
      allowedHosts: ["example.com"],
    });
    const routines = new RoutineService(client);
    const scope = { workspaceId: "default", principalId: "operator" };
    const defaults = routineDefaults("Europe/Sofia");
    const created = await routines.create(
      scope,
      RoutineCreateSchema.parse({
        ...defaults,
        execution: { ...defaults.execution, catchUpHours: 0 },
        operationKey: "create",
        name: "Launch",
        objective: "Find launch news",
        agent: { agentId: "launch", name: "Launch", instructions: "Find evidence" },
        triggers: [{ id: "launch", kind: "once", runAt: "2030-03-15T06:30:00.000Z" }],
        skills: [],
        models: {
          research: { primary: { connectionId: "research", model: "r1" }, fallbacks: [] },
          synthesis: { primary: { connectionId: "summary", model: "s1" }, fallbacks: [] },
        },
        permissions: { revision: 1, researchTools: ["web_search"], allowedHosts: ["example.com"], networkMode: "allowlist" },
      }),
    );
    await routines.finishEvaluation(scope, created.routine.routineId, 1, true, "pass");
  } finally {
    await client.close();
  }
  const listed = capture();
  expect(await main(["schedules", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
  // 06:30Z on 15 March 2030 is 08:30 in Sofia (EET): not the 00:00 UTC placeholder it was listed as.
  expect(listed.stdout()).toMatch(/\tonce on 2030-03-15 at 08:30 \(Europe\/Sofia\)\tenabled\tnext=/);
  const name = listed.stdout().split("\t")[1]!;
  const shown = capture();
  expect(await main(["schedules", "show", name, "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
  expect(shown.stdout()).toMatch(/missed {6}skip\n/);
});

describe("tavi schedules webhook", () => {
  it("turns a schedule's webhook on with a secret shown once, shows it on, rotates it and turns it off", async () => {
    const directory = directories.create();
    const id = await addSchedule(directory);
    const on = capture();
    expect(await main(["schedules", "webhook", id, "on", "--format", "json", "--data-dir", directory], { io: on.io })).toBe(EXIT.ok);
    const answer = JSON.parse(on.stdout()) as { webhook: string; path: string; secret?: string; signingKey?: string };
    expect(answer).toMatchObject({ webhook: "on", path: `/hooks/schedules/${id}` });
    expect(answer.secret).toMatch(/^twh_/);
    const text = capture();
    expect(await main(["schedules", "webhook", "morning-brief", "on", "--data-dir", directory], { io: text.io })).toBe(EXIT.ok);
    expect(text.stdout()).toMatch(/webhook on/);
    expect(text.stdout()).toMatch(/already on; its secret is not shown again/);
    const shown = capture();
    expect(await main(["schedules", "show", id, "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toMatch(new RegExp(`webhook {5}on at /hooks/schedules/${id}`));
    expect(shown.stdout()).not.toContain(answer.secret);
    expect(shown.stdout()).not.toContain(answer.signingKey);
    const rotated = capture();
    expect(await main(["schedules", "webhook", id, "rotate", "--data-dir", directory], { io: rotated.io })).toBe(EXIT.ok);
    expect(rotated.stdout()).toMatch(/secret {4}twh_/);
    expect(rotated.stdout()).toMatch(/Authorization: Bearer <secret>/);
    expect(rotated.stdout()).not.toContain(answer.secret);
    const off = capture();
    expect(await main(["schedules", "webhook", id, "off", "--data-dir", directory], { io: off.io })).toBe(EXIT.ok);
    expect(off.stdout()).toMatch(/webhook off/);
    const bad = capture();
    expect(await main(["schedules", "webhook", id, "maybe", "--data-dir", directory], { io: bad.io })).toBe(EXIT.usage);
    expect(bad.stderr()).toMatch(/needs on, off, rotate/);
  });
});
