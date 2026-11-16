import { renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ScheduleRecord } from "@tavi/contracts";
import { fireSchedule, type ScheduleSchedulerDependencies } from "@tavi/agent-host/schedule-scheduler";
import { capture, temporaryDirectories, delay } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { fireScheduleNow, writeSchedule } from "../../src/features/schedules/actions.js";
import { parseWatchEvery } from "../../src/features/schedules/parse.js";
import { createSchedulePrecheck } from "../../src/features/schedules/precheck.js";
import { createScheduleWatchers, scheduleWriteCount, watchFileChanges, type WatchFile } from "../../src/features/schedules/watchers.js";
import { type ConfigDependencies, schedulesCommand } from "../../src/server/config-commands.js";
import { SqliteStore } from "../support/database-fixture.js";
import { scheduleFireHarness, ownerFolders } from "./fire-harness.js";

/** Watchers: schedules whose trigger is a change — a page, a feed or a file — checked on a cadence, and a file soon after it changes. */

const directories = temporaryDirectories({ prefix: "tavi-schedule-watch-" });
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  directories.cleanup();
});

const START = Date.parse("2026-10-29T08:00:00.000Z");
const PAGE = "https://example.com/status";

/** An owner's folder rule over one `--fs-root`, which a test may make refuse everything (`refuse`). */
function folders() {
  const root = directories.create();
  const chatFolders = ownerFolders(
    root,
    () => directories.create(),
    () => new Date(START).toISOString(),
  );
  const rule = { refuse: false };
  const checkFile = (path: string): string => {
    if (rule.refuse) throw new Error(`${path} is not under an --fs-root`);
    return chatFolders.checkReadableFile(path);
  };
  return { root, rule, checkFile };
}

/**
 * Timers a test runs by hand: each armed with when it is due, run once the clock reaches it, and what it started
 * left to settle (`settled`) before the next.
 */
function manualTimers(clock: { now: number }, settled: () => boolean = () => true) {
  const timers: { at: number; callback: () => void; live: boolean }[] = [];
  return {
    setTimer: (callback: () => void, ms: number) => {
      const timer = { at: clock.now + ms, callback, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    /** Moves the clock on by `ms`, running each timer that comes due on the way, in order. */
    advance: async (ms: number) => {
      const until = clock.now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.live && timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.live = false;
        clock.now = Math.max(clock.now, due.at);
        due.callback();
        // The store answers from a worker thread: a check's reads take real time.
        await delay(40);
        for (let tries = 0; tries < 200 && !settled(); tries += 1) await delay(5);
      }
      clock.now = until;
    },
    pending: () => timers.filter((timer) => timer.live).length,
  };
}

/** A watch whose changes a test makes: `change(path)` is a change to that file. */
function fakeWatches() {
  const open = new Map<string, () => void>();
  let closed = 0;
  const watchFile: WatchFile = (path, changed) => {
    open.set(path, changed);
    return () => {
      open.delete(path);
      closed += 1;
    };
  };
  return { watchFile, open, closed: () => closed, change: (path: string) => open.get(path)?.() };
}

/**
 * A store, a file watcher on a file under an `--fs-root`, the scheduler's run-now path whose workflow only records
 * what it was asked to admit (no model is called), the real pre-check, and the watchers over them with hand-run timers.
 */
async function fixture() {
  const { root, rule, checkFile } = folders();
  const file = join(root, "notes.md");
  writeFileSync(file, "first");
  const directory = directories.create();
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  stores.push(store);
  const repositories = store.asPort().repositories;
  const clock = { now: START };
  const iso = () => new Date(clock.now).toISOString();
  const pages: Record<string, string> = { [PAGE]: "all good" };
  const harness = scheduleFireHarness(repositories, iso);
  const { admitted, inFlight } = harness;
  const scheduling: ScheduleSchedulerDependencies = {
    ...harness.scheduling,
    precheck: createSchedulePrecheck({
      fetchPage: async (url) => ({ status: 200, text: pages[url] ?? "" }),
      checkFile,
      now: iso,
    }),
    log: () => {},
  };
  const watcher = await writeSchedule(
    repositories,
    {
      action: "add",
      name: "Notes",
      prompt: "Summarise what changed in my notes",
      everyHours: 1,
      timezone: "UTC",
      precheck: `file-changed:${file}`,
      watch: true,
    },
    new Date(START),
    { precheckFile: checkFile },
  );
  const timers = manualTimers(clock, () => inFlight.size === 0);
  const watches = fakeWatches();
  const logs: string[] = [];
  const watchers = createScheduleWatchers({
    schedules: repositories.schedules,
    checkFile,
    fire: (schedule) => {
      inFlight.add(schedule.scheduleId);
      return fireScheduleNow(schedule, scheduling, () => inFlight.delete(schedule.scheduleId), "watch");
    },
    watchFile: watches.watchFile,
    setTimer: timers.setTimer,
    // As the owner wires it: the schedule writes settled on this store are what the timer's sync lists after.
    changes: scheduleWriteCount(store),
    now: () => clock.now,
    log: (_level, message) => logs.push(message),
  });
  return { root, rule, file, checkFile, store, repositories, clock, pages, admitted, scheduling, watcher, timers, watches, watchers, logs };
}

describe("tavi schedules watch", () => {
  /** `tavi schedules watch Status …` in `directory`, with what it printed. */
  async function watchCommand(directory: string, extra: readonly string[]) {
    const out = capture();
    const code = await main(
      [
        "schedules",
        "watch",
        "Status",
        "--prompt",
        "Tell me what changed on the status page",
        "--timezone",
        "UTC",
        ...extra,
        "--data-dir",
        directory,
      ],
      { io: out.io },
    );
    return { code, out };
  }

  it("creates a schedule that checks every hour and runs only when the page changes, and says so", async () => {
    const directory = directories.create();
    const made = await watchCommand(directory, ["--page", "https://Example.com/status#top"]);
    expect(made.code, made.out.stderr()).toBe(EXIT.ok);
    expect(made.out.stdout()).toMatch(
      /\tStatus\twatches the page https:\/\/example\.com\/status every hour; runs only when it changes\tenabled/,
    );
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    stores.push(store);
    const [stored] = await store.asPort().repositories.schedules.list("default");
    expect(stored).toMatchObject({
      name: "Status",
      watch: true,
      spec: { everyHours: 1, timezone: "UTC" },
      precheck: { kind: "page-changed", target: PAGE },
    });
    const shown = capture();
    expect(await main(["schedules", "show", "Status", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toMatch(/watcher {5}watches the page https:\/\/example\.com\/status every hour; runs only when it changes\n/);
    const listed = capture();
    expect(await main(["schedules", "list", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect(listed.stdout()).toMatch(/\tStatus\twatches the page https:\/\/example\.com\/status every hour; runs only when it changes\t/);
  });

  it("takes a feed and a cadence in hours, stops being a watcher on update --watch off, and refuses what it cannot be", async () => {
    const directory = directories.create();
    const made = await watchCommand(directory, ["--feed", "https://example.com/feed.xml", "--every", "180m", "--between", "08:00-20:00"]);
    expect(made.code, made.out.stderr()).toBe(EXIT.ok);
    expect(made.out.stdout()).toMatch(
      /watches the feed https:\/\/example\.com\/feed\.xml every 3 hours from 08:00 to 20:00; runs only when it has new items/,
    );
    for (const [extra, said] of [
      [["--page", PAGE, "--every", "30m"], /a watcher's model runs at most once an hour/],
      [["--page", PAGE, "--every", "13h"], /--every expects 1h-12h/],
      [["--page", PAGE, "--feed", "https://example.com/feed.xml"], /needs one of --page/],
      [[], /needs one of --page/],
      [["--page", "http://example.com/"], /https address/],
      [["--page", PAGE, "--at", "07:00"], /does not accept --at: watch sets it/],
    ] as const) {
      const refused = await watchCommand(directories.create(), extra);
      expect(refused.code, extra.join(" ")).toBe(EXIT.usage);
      expect(refused.out.stderr()).toMatch(said);
    }
    // A file is checked against a running owner's --fs-root folders, which an offline write has none of.
    const offline = await watchCommand(directories.create(), ["--file", "/tmp/notes.md"]);
    expect(offline.code).not.toBe(EXIT.ok);
    expect(offline.out.stderr()).toMatch(/needs a running owner/);
    expect(await main(["schedules", "update", "Status", "--watch", "off", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    const shown = capture();
    await main(["schedules", "show", "Status", "--data-dir", directory], { io: shown.io });
    expect(shown.stdout()).not.toMatch(/watcher/);
    expect(shown.stdout()).toMatch(/pre-check {3}runs only when the feed/);
    expect(await main(["schedules", "update", "Status", "--watch", "on", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    expect(await main(["schedules", "update", "Status", "--precheck", "none", "--data-dir", directory], { io: capture().io })).toBe(
      EXIT.ok,
    );
    const plain = capture();
    await main(["schedules", "show", "Status", "--data-dir", directory], { io: plain.io });
    expect(plain.stdout()).not.toMatch(/watcher/);
    const noCheck = capture();
    expect(await main(["schedules", "update", "Status", "--watch", "on", "--data-dir", directory], { io: noCheck.io })).not.toBe(EXIT.ok);
    expect(noCheck.stderr()).toMatch(/a watcher runs when its pre-check finds a change/);
  });

  it("reads --every in whole hours", () => {
    expect(parseWatchEvery("1h")).toBe(1);
    expect(parseWatchEvery("2")).toBe(2);
    expect(parseWatchEvery("120m")).toBe(2);
    expect(parseWatchEvery("12 hours")).toBe(12);
    expect(parseWatchEvery("15m")).toBeUndefined();
    expect(parseWatchEvery("90m")).toBeUndefined();
    expect(parseWatchEvery("0h")).toBeUndefined();
  });
});

describe("a page watcher's cadence", () => {
  it("runs its first check and then only when the page changed: an unchanged page makes no model call", async () => {
    const f = await fixture();
    const page = await writeSchedule(
      f.repositories,
      {
        action: "add",
        name: "Status",
        prompt: "Say what changed",
        everyHours: 1,
        timezone: "UTC",
        precheck: `page-changed:${PAGE}`,
        watch: true,
      },
      new Date(START),
    );
    /** The watcher's due fire, made at its time. */
    const fireDue = async () => {
      const current = (await f.repositories.schedules.get(page.scheduleId)) as ScheduleRecord;
      f.clock.now = Date.parse(current.nextRunAt ?? "");
      return fireSchedule(current, current.nextRunAt ?? "", f.scheduling);
    };
    expect(await fireDue()).toMatchObject({ kind: "ran", status: "completed" });
    expect(f.admitted).toHaveLength(1);
    expect(await fireDue()).toEqual({ kind: "skipped", reason: "unchanged" });
    expect(await fireDue()).toEqual({ kind: "skipped", reason: "unchanged" });
    expect(f.admitted).toHaveLength(1);
    f.pages[PAGE] = "degraded";
    expect(await fireDue()).toMatchObject({ kind: "ran" });
    expect(f.admitted).toHaveLength(2);
    expect(f.admitted[1]?.prompt).toContain(`Pre-check: the page ${PAGE} has changed`);
    const reasons = (await f.repositories.schedules.listFires(page.scheduleId, 10)).map((fire) => fire.reasonCode);
    expect(reasons).toEqual(["ok", "unchanged", "unchanged", "ok"]);
    // A page has nothing to watch between fires: only its cadence checks it.
    await f.watchers.start();
    expect([...f.watchers.watching().keys()]).toEqual([f.watcher.scheduleId]);
    f.watchers.stop();
  });
});

describe("a file watcher", () => {
  it("checks soon after its file changes — once for a burst, after a quiet spell — and runs only when it changed", async () => {
    const f = await fixture();
    await f.watchers.start();
    expect(f.watchers.watching()).toEqual(new Map([[f.watcher.scheduleId, f.checkFile(f.file)]]));
    f.watches.change(f.checkFile(f.file));
    await f.timers.advance(10_000);
    f.watches.change(f.checkFile(f.file));
    await f.timers.advance(29_000);
    expect(f.admitted).toHaveLength(0);
    await f.timers.advance(1_000);
    // The first check has no earlier reading: it runs, and its reading is the baseline.
    expect(f.admitted).toHaveLength(1);
    expect(f.admitted[0]?.operationKey).toMatch(/:watch:/);
    // A change made within the minute is checked once the minute is up.
    writeFileSync(f.file, "second");
    f.watches.change(f.checkFile(f.file));
    await f.timers.advance(30_000);
    expect(f.admitted).toHaveLength(1);
    await f.timers.advance(30_000);
    expect(f.admitted).toHaveLength(2);
    expect(f.admitted[1]?.prompt).toContain(`Pre-check: the file ${f.checkFile(f.file)} has changed`);
    // Touched, not changed: checked, recorded, and nothing runs.
    f.watches.change(f.checkFile(f.file));
    await f.timers.advance(90_000);
    expect(f.admitted).toHaveLength(2);
    const fires = await f.repositories.schedules.listFires(f.watcher.scheduleId, 10);
    expect(fires.map((fire) => fire.reasonCode)).toEqual(["watch", "watch", "watch"]);
    expect(fires[0]?.outcome).toMatch(/^file-watch run: unchanged: file-changed:/);
    expect(fires[1]?.outcome).toMatch(/^file-watch run: completed/);
    // Its cadence's next fire is untouched by the watch's checks.
    expect((await f.repositories.schedules.get(f.watcher.scheduleId))?.nextRunAt).toBe(f.watcher.nextRunAt);
    f.watchers.stop();
  });

  it("checks at most once a minute and twelve times an hour, however often its file changes", async () => {
    const f = await fixture();
    const checks: number[] = [];
    const watchers = createScheduleWatchers({
      schedules: f.repositories.schedules,
      checkFile: f.checkFile,
      fire: async () => {
        checks.push(f.clock.now);
        return { outcome: { kind: "skipped", reason: "unchanged" } };
      },
      watchFile: f.watches.watchFile,
      setTimer: f.timers.setTimer,
      now: () => f.clock.now,
      log: () => {},
    });
    await watchers.start();
    for (let minute = 0; minute < 60; minute += 1) {
      f.watches.change(f.checkFile(f.file));
      await f.timers.advance(31_000);
    }
    expect(checks).toHaveLength(12);
    for (let index = 1; index < checks.length; index += 1) expect(checks[index]! - checks[index - 1]!).toBeGreaterThanOrEqual(60_000);
    // A change past the hour's limit waits for it, and is checked once it allows.
    await f.timers.advance(60 * 60_000);
    expect(checks.length).toBeGreaterThanOrEqual(13);
    watchers.stop();
  });

  it("checks again once a run in flight has ended, and a check that met one takes none of the hour's checks", async () => {
    const f = await fixture();
    const checks: number[] = [];
    const watchers = createScheduleWatchers({
      schedules: f.repositories.schedules,
      checkFile: f.checkFile,
      fire: async () => {
        checks.push(f.clock.now);
        return checks.length <= 15 ? { outcome: { kind: "skipped", reason: "overlap" } } : { taskId: "task-1" };
      },
      watchFile: f.watches.watchFile,
      setTimer: f.timers.setTimer,
      now: () => f.clock.now,
      log: () => {},
    });
    await watchers.start();
    f.watches.change(f.checkFile(f.file));
    await f.timers.advance(30_000);
    expect(checks).toEqual([START + 30_000]);
    // Met a run in flight: checked again after a quiet spell, not held to the minute between checks.
    await f.timers.advance(30_000);
    expect(checks).toEqual([START + 30_000, START + 60_000]);
    // Fifteen in a row, past the hour's twelve, and the change is still checked once the run has ended.
    await f.timers.advance(7 * 60_000);
    expect(checks).toHaveLength(16);
    expect(checks.at(-1)).toBe(START + 8 * 60_000);
    watchers.stop();
  });

  it("is checked only at its cadence for an hour once its changes ran it too often in a row, and its person is told once", async () => {
    const f = await fixture();
    const checks: number[] = [];
    const alerts: { identity: string; text: string }[] = [];
    let changed = true;
    const watchers = createScheduleWatchers({
      schedules: f.repositories.schedules,
      checkFile: f.checkFile,
      fire: async () => {
        checks.push(f.clock.now);
        return changed ? { taskId: `task-${checks.length}` } : { outcome: { kind: "skipped", reason: "unchanged" } };
      },
      alert: async (_schedule, alert) => {
        alerts.push(alert);
      },
      watchFile: f.watches.watchFile,
      setTimer: f.timers.setTimer,
      now: () => f.clock.now,
      log: () => {},
    });
    await watchers.start();
    const changeEvery = async (times: number) => {
      for (let index = 0; index < times; index += 1) {
        f.watches.change(f.checkFile(f.file));
        await f.timers.advance(61_000);
      }
    };
    // A check that found nothing new breaks the run of changes.
    await changeEvery(5);
    changed = false;
    await changeEvery(1);
    changed = true;
    await changeEvery(5);
    expect(checks).toHaveLength(11);
    expect(alerts).toHaveLength(0);
    await changeEvery(1);
    expect(checks).toHaveLength(12);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toMatch(
      /^Schedule "Notes" ran 6 times in a row within an hour, each on a change to .*notes\.md: until .* it checks only at its cadence\.$/,
    );
    // Changes in the hour after are left to the cadence.
    await changeEvery(50);
    expect(checks).toHaveLength(12);
    expect(alerts).toHaveLength(1);
    // Once the hour is up, a change is checked promptly again.
    await changeEvery(10);
    expect(checks.length).toBeGreaterThan(12);
    watchers.stop();
  });

  it("moves its watch to the file its path resolves to now: a symlink put in its place, or the file back", async () => {
    const f = await fixture();
    const real = f.checkFile(f.file);
    const other = join(f.root, "other.md");
    writeFileSync(other, "other");
    await f.watchers.start();
    expect(f.watchers.watching().get(f.watcher.scheduleId)).toBe(real);
    rmSync(f.file);
    symlinkSync(other, f.file);
    await f.watchers.sync();
    expect(f.watchers.watching().get(f.watcher.scheduleId)).toBe(f.checkFile(other));
    expect([...f.watches.open.keys()]).toEqual([f.checkFile(other)]);
    // The file back between syncs: an event on the other file's watch moves it before its check.
    rmSync(f.file);
    writeFileSync(f.file, "back");
    f.watches.change(f.checkFile(other));
    await f.timers.advance(30_000);
    expect(f.watchers.watching().get(f.watcher.scheduleId)).toBe(real);
    expect([...f.watches.open.keys()]).toEqual([real]);
    expect(f.admitted).toHaveLength(1);
    f.watchers.stop();
  });

  it("is not watched once edited, paused or removed, through the owner's writes, and none is after stop", async () => {
    const f = await fixture();
    let syncs = 0;
    const deps = {
      dataDirectory: directories.create(),
      repositories: f.repositories,
      now: () => new Date(f.clock.now),
      precheckFile: f.checkFile,
      schedulesChanged: async () => {
        syncs += 1;
        await f.watchers.sync();
      },
    } as unknown as ConfigDependencies;
    await f.watchers.start();
    // A change pending when the watcher is paused is never checked.
    f.watches.change(f.checkFile(f.file));
    expect(await schedulesCommand(deps, { action: "disable", scheduleId: "Notes" })).toMatchObject({ ok: true });
    expect(f.watchers.watching().size).toBe(0);
    expect(f.watches.closed()).toBe(1);
    await f.timers.advance(5 * 60_000);
    expect(f.admitted).toHaveLength(0);
    expect(await schedulesCommand(deps, { action: "enable", scheduleId: "Notes" })).toMatchObject({ ok: true });
    expect(f.watchers.watching().size).toBe(1);
    // Edited to stop watching: a file-changed pre-check alone is a schedule run by its time, not watched.
    expect(await schedulesCommand(deps, { action: "update", scheduleId: "Notes", watch: false })).toMatchObject({
      ok: true,
      result: { precheck: { kind: "file-changed" } },
    });
    expect(f.watchers.watching().size).toBe(0);
    expect(await schedulesCommand(deps, { action: "update", scheduleId: "Notes", watch: true })).toMatchObject({ ok: true });
    expect(f.watchers.watching().size).toBe(1);
    expect(await schedulesCommand(deps, { action: "remove", scheduleId: "Notes" })).toMatchObject({ ok: true });
    expect(f.watchers.watching().size).toBe(0);
    expect(syncs).toBe(5);
    // A watcher made again is watched; stop ends every watch and the sync timer.
    await writeSchedule(
      f.repositories,
      {
        action: "add",
        name: "Notes again",
        prompt: "Summarise",
        everyHours: 2,
        timezone: "UTC",
        precheck: `file-changed:${f.file}`,
        watch: true,
      },
      new Date(START),
      { precheckFile: f.checkFile },
    );
    await f.timers.advance(60_000);
    expect(f.watchers.watching().size).toBe(1);
    f.watches.change(f.checkFile(f.file));
    f.watchers.stop();
    expect(f.watchers.watching().size).toBe(0);
    expect(f.timers.pending()).toBe(0);
    await f.timers.advance(5 * 60_000);
    expect(f.admitted).toHaveLength(0);
  });

  it("lists the schedules on its timer only after a schedule write settled, and re-checks the watched paths alone between", async () => {
    const f = await fixture();
    let lists = 0;
    const watchers = createScheduleWatchers({
      schedules: {
        get: (scheduleId) => f.repositories.schedules.get(scheduleId),
        list: (workspaceId) => {
          lists += 1;
          return f.repositories.schedules.list(workspaceId);
        },
      },
      checkFile: f.checkFile,
      fire: async () => ({ outcome: { kind: "skipped", reason: "unchanged" } }),
      watchFile: f.watches.watchFile,
      setTimer: f.timers.setTimer,
      changes: scheduleWriteCount(f.store),
      now: () => f.clock.now,
      log: () => {},
    });
    await watchers.start();
    expect(lists).toBe(1);
    expect(watchers.watching().size).toBe(1);
    // Idle ticks read nothing: no schedule write has settled since the listing, and reads move no count.
    await f.repositories.schedules.get(f.watcher.scheduleId);
    await f.repositories.schedules.listFires(f.watcher.scheduleId, 10);
    await f.timers.advance(5 * 60_000);
    expect(lists).toBe(1);
    // A write through any path on this store — a chat's tool, say, which announces nothing — is listed at the next tick.
    await f.repositories.schedules.setEnabled({
      scheduleId: f.watcher.scheduleId,
      enabled: false,
      nextRunAt: null,
      now: new Date(f.clock.now).toISOString(),
    });
    await f.timers.advance(60_000);
    expect(lists).toBe(2);
    expect(watchers.watching().size).toBe(0);
    await f.timers.advance(60_000);
    expect(lists).toBe(2);
    // A watched path the --fs-root rule now refuses is found by an idle tick too, which then lists.
    await f.repositories.schedules.setEnabled({
      scheduleId: f.watcher.scheduleId,
      enabled: true,
      nextRunAt: f.watcher.nextRunAt,
      now: new Date(f.clock.now).toISOString(),
    });
    await watchers.sync();
    expect(watchers.watching().size).toBe(1);
    const listed = lists;
    await f.timers.advance(60_000);
    expect(lists).toBe(listed);
    f.rule.refuse = true;
    await f.timers.advance(60_000);
    expect(lists).toBe(listed + 1);
    expect(watchers.watching().size).toBe(0);
    watchers.stop();
    f.watchers.stop();
  });

  it("counts a routine's writes to its trigger schedules, which reach the worker as routine requests", () => {
    const listeners: ((operation: string) => void)[] = [];
    const changes = scheduleWriteCount({
      onSettled: (listener) => {
        listeners.push(listener);
        return () => {};
      },
    });
    const settled = (operation: string): void => {
      for (const listener of listeners) listener(operation);
    };
    // Reads, and routine bookkeeping that never touches a schedule, move nothing.
    for (const operation of [
      "repository.schedules.list",
      "routine.routines.get",
      "routine.runs.heartbeat",
      "routine.runs.serviceHeartbeat",
    ])
      settled(operation);
    expect(changes()).toBe(0);
    // A run's finish can pause its routine for its failures, disabling the routine's trigger schedules in the worker.
    settled("routine.runs.finish");
    settled("routine.routines.setStatus");
    settled("routine.control");
    settled("repository.schedules.setEnabled");
    expect(changes()).toBe(4);
  });

  it("watches one the --fs-root rule refused once it allows it, at the next tick with no schedule write", async () => {
    const f = await fixture();
    f.rule.refuse = true;
    await f.watchers.start();
    expect(f.watchers.watching().size).toBe(0);
    await f.timers.advance(60_000);
    expect(f.watchers.watching().size).toBe(0);
    f.rule.refuse = false;
    await f.timers.advance(60_000);
    expect(f.watchers.watching().size).toBe(1);
    f.watchers.stop();
  });

  it("does not fire one edited, paused or removed elsewhere before the watches follow it", async () => {
    const f = await fixture();
    await f.watchers.start();
    f.watches.change(f.checkFile(f.file));
    // Paused through a path that does not announce it (a chat's tool, say): read again before the check, so not fired.
    await f.repositories.schedules.setEnabled({
      scheduleId: f.watcher.scheduleId,
      enabled: false,
      nextRunAt: null,
      now: new Date(f.clock.now).toISOString(),
    });
    await f.timers.advance(30_000);
    expect(f.admitted).toHaveLength(0);
    expect(f.watchers.watching().size).toBe(0);
    f.watchers.stop();
  });

  it("holds its path to the --fs-root rule when it is watched and again before each check", async () => {
    const f = await fixture();
    f.rule.refuse = true;
    await f.watchers.start();
    expect(f.watchers.watching().size).toBe(0);
    expect(f.logs).toContain("a watcher's file is not under an --fs-root; it is checked only at its cadence");
    f.rule.refuse = false;
    await f.watchers.sync();
    expect(f.watchers.watching().size).toBe(1);
    f.watches.change(f.checkFile(f.file));
    f.rule.refuse = true;
    await f.timers.advance(30_000);
    expect(f.admitted).toHaveLength(0);
    expect(f.watchers.watching().size).toBe(0);
    expect(f.logs).toContain("a watched file is no longer under an --fs-root; its change is not checked");
    f.watchers.stop();
  });

  it("says its file is gone, not refused, records the check failed at once, and says so once", async () => {
    const f = await fixture();
    await f.watchers.start();
    const real = f.checkFile(f.file);
    rmSync(f.file);
    f.watches.change(real);
    await f.timers.advance(30_000);
    expect(f.logs).toContain("a watched file is gone; its check is recorded failed");
    expect(f.logs.some((line) => line.includes("--fs-root"))).toBe(false);
    const fires = await f.repositories.schedules.listFires(f.watcher.scheduleId, 10);
    expect(fires[0]?.outcome).toMatch(/pre-check failed: .*does not exist/);
    expect(f.admitted).toHaveLength(0);
    // Left without a watch while it is gone: said once, however many syncs list it.
    await f.watchers.sync();
    await f.watchers.sync();
    expect(f.logs.filter((line) => line === "a watcher's file does not exist; it is checked only at its cadence")).toHaveLength(1);
    writeFileSync(f.file, "back");
    await f.watchers.sync();
    expect(f.watchers.watching().size).toBe(1);
    f.watchers.stop();
  });

  it("watches only schedules a person made watchers: a file pre-check alone is not watched", async () => {
    const f = await fixture();
    await writeSchedule(f.repositories, { action: "update", scheduleId: "Notes", watch: false }, new Date(START), {
      precheckFile: f.checkFile,
    });
    await f.watchers.start();
    expect(f.watchers.watching().size).toBe(0);
    f.watchers.stop();
  });

  it("refuses a watcher without a pre-check", async () => {
    const f = await fixture();
    await expect(
      writeSchedule(
        f.repositories,
        { action: "add", name: "Nothing", prompt: "go", everyHours: 1, timezone: "UTC", watch: true },
        new Date(START),
      ),
    ).rejects.toThrow(/a watcher runs when its pre-check finds a change/);
  });
});

describe("a file's changes", () => {
  /** Waits until `done` holds, up to two seconds. */
  const until = async (done: () => boolean) => {
    for (let tries = 0; tries < 200 && !done(); tries += 1) await delay(10);
  };

  it("are seen on the file itself, not on another file in its folder, and the watch ends when stopped", async () => {
    const root = directories.create();
    const file = join(root, "watched.md");
    writeFileSync(file, "one");
    let changes = 0;
    const stop = watchFileChanges(
      file,
      () => {
        changes += 1;
      },
      () => {},
    );
    writeFileSync(join(root, "other.md"), "x");
    await delay(300);
    expect(changes).toBe(0);
    writeFileSync(file, "two");
    await until(() => changes > 0);
    expect(changes).toBeGreaterThanOrEqual(1);
    stop();
    const seen = changes;
    writeFileSync(file, "three");
    await delay(300);
    expect(changes).toBe(seen);
  });

  it("follow the path when an editor replaces the file, or removes it and writes it again", async () => {
    const root = directories.create();
    const file = join(root, "watched.md");
    writeFileSync(file, "one");
    let changes = 0;
    const stop = watchFileChanges(
      file,
      () => {
        changes += 1;
      },
      () => {},
    );
    // A watch sees events from the event loop's next turn on.
    await delay(100);
    writeFileSync(join(root, "watched.md.tmp"), "two");
    renameSync(join(root, "watched.md.tmp"), file);
    await until(() => changes > 0);
    expect(changes).toBeGreaterThanOrEqual(1);
    await delay(100);
    let seen = changes;
    writeFileSync(file, "three");
    await until(() => changes > seen);
    expect(changes).toBeGreaterThan(seen);
    rmSync(file);
    await delay(100);
    seen = changes;
    writeFileSync(file, "four");
    await until(() => changes > seen);
    expect(changes).toBeGreaterThan(seen);
    await delay(100);
    seen = changes;
    writeFileSync(file, "five");
    await until(() => changes > seen);
    expect(changes).toBeGreaterThan(seen);
    stop();
  });
});
