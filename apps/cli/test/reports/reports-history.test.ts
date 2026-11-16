import { join } from "node:path";

import { SqliteStore } from "../support/database-fixture.js";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * `tavi reports list` and `tavi reports trends` (audit requirements finding 8,
 * R6/R12).
 *
 * The history rows were durable and model-readable already; there was no way for
 * an *operator* to see what had been produced or how a metric moved, and
 * `reports.history` left the date arithmetic to its caller. These pin the
 * listing, the window, and the deltas.
 */

const directories = temporaryDirectories({ prefix: "tavi-reports-history-" });

afterEach(() => directories.cleanup());

/** Two consecutive weekly briefs for one project, as a real schedule leaves behind. */
async function seeded(overrides: { readonly secondValue?: number } = {}): Promise<string> {
  const directory = directories.create();
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
  try {
    const report = (index: number, periodStart: string, periodEnd: string, value: number) => ({
      reportId: `run-week-${index}`,
      workspaceId: "default",
      runId: `run-week-${index}`,
      artifactId: `art-${index}`,
      periodStart,
      periodEnd,
      generatedAt: `${periodEnd}T05:00:00.000Z`,
      bytes: 1_000 + index,
      pages: 1,
      projects: [
        {
          id: "acme",
          name: "Acme",
          metrics: [{ source: "ga4", key: "sessions", label: "Sessions", value, unit: "count" as const }],
          newsCount: 0,
          notes: [],
        },
      ],
    });
    await store.asPort().repositories.reports.record({ report: report(1, "2026-03-23", "2026-03-29", 400) });
    await store.asPort().repositories.reports.record({ report: report(2, "2026-03-30", "2026-04-05", overrides.secondValue ?? 520) });
  } finally {
    store.close();
  }
  return directory;
}

describe("tavi reports list", () => {
  it("prints one line per recorded brief, newest first", async () => {
    const directory = await seeded();
    const shown = capture();
    expect(await main(["reports", "list", "--format", "json", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    const listing = JSON.parse(shown.stdout()) as {
      reports: { reportId: string; periodStart: string; metrics: number; projects: number }[];
      unreadable: string[];
    };
    expect(listing.unreadable).toEqual([]);
    expect(listing.reports.map((row) => row.reportId)).toEqual(["run-week-2", "run-week-1"]);
    expect(listing.reports[0]).toMatchObject({ periodStart: "2026-03-30", projects: 1, metrics: 1 });

    const text = capture();
    expect(await main(["reports", "list", "--data-dir", directory], { io: text.io })).toBe(EXIT.ok);
    // A header, columns padded with spaces, the time to the minute in UTC, the id under its row: it fits a terminal.
    expect(text.stdout().split("\n")[0]).toMatch(/^PERIOD\s+GENERATED \(UTC\)\s+SIZE\s+CONTENTS$/);
    expect(text.stdout()).toMatch(/2026-03-30\.\.2026-04-05 {2}2026-04-05 05:00 +1002 B {2}1 project, 1 metric\n {2}art-2\n/);
    expect(text.stdout()).not.toContain("\t");
    expect(
      Math.max(
        ...text
          .stdout()
          .split("\n")
          .map((line) => line.length),
      ),
    ).toBeLessThanOrEqual(80);
  });

  it("takes the same period window as trends, so a month can be listed", async () => {
    const directory = await seeded();
    const windowed = capture();
    expect(await main(["reports", "list", "--from", "2026-03-30", "--format", "json", "--data-dir", directory], { io: windowed.io })).toBe(
      EXIT.ok,
    );
    const listing = JSON.parse(windowed.stdout()) as { reports: { reportId: string }[] };
    expect(listing.reports.map((row) => row.reportId)).toEqual(["run-week-2"]);

    const earlier = capture();
    expect(await main(["reports", "list", "--to", "2026-03-29", "--format", "json", "--data-dir", directory], { io: earlier.io })).toBe(
      EXIT.ok,
    );
    expect((JSON.parse(earlier.stdout()) as { reports: { reportId: string }[] }).reports.map((row) => row.reportId)).toEqual([
      "run-week-1",
    ]);
  });

  it("says the history is empty rather than printing nothing, and honours --limit", async () => {
    const empty = directories.create();
    expect(await main(["models", "list", "--data-dir", empty], { io: capture().io })).toBe(EXIT.ok);
    const none = capture();
    expect(await main(["reports", "list", "--data-dir", empty], { io: none.io })).toBe(EXIT.ok);
    expect(none.stdout()).toContain("no reports have been generated yet");

    const limited = capture();
    expect(await main(["reports", "list", "--limit", "1", "--format", "json", "--data-dir", await seeded()], { io: limited.io })).toBe(
      EXIT.ok,
    );
    expect((JSON.parse(limited.stdout()) as { reports: unknown[] }).reports).toHaveLength(1);
  });
});

describe("tavi reports trends", () => {
  it("computes the change between adjacent periods and the overall change", async () => {
    const directory = await seeded();
    const shown = capture();
    expect(
      await main(["reports", "trends", "--project", "acme", "--metric", "sessions", "--format", "json", "--data-dir", directory], {
        io: shown.io,
      }),
    ).toBe(EXIT.ok);
    const result = JSON.parse(shown.stdout()) as {
      groups: {
        projectId: string;
        metricKey: string;
        unit: string;
        points: {
          periodStart: string;
          value: number;
          change: number | null;
          changePercent: number | null;
          basis: string | null;
          gap: boolean;
        }[];
        change: { absolute: number; percent: number } | null;
        from: string;
        to: string;
      }[];
      from: string;
      to: string;
    };
    // One series per project and metric, chronological, so a delta is between
    // adjacent periods of the *same* series; the first point has nothing to
    // compare with and says so with null rather than 0.
    expect(result.groups).toHaveLength(1);
    const [group] = result.groups;
    expect(group?.metricKey).toBe("sessions");
    expect(group?.points.map((point) => [point.periodStart, point.value, point.change])).toEqual([
      ["2026-03-23", 400, null],
      ["2026-03-30", 520, 120],
    ]);
    expect(group?.points[1]?.changePercent).toBeCloseTo(30, 5);
    expect(group?.points[1]?.gap).toBe(false);
    expect(group?.change).toMatchObject({ absolute: 120 });
    expect(group?.change?.percent).toBeCloseTo(30, 5);
    expect(result.from).toBe("2026-03-23");
    expect(result.to).toBe("2026-04-05");
  });

  it("filters by period window, and says when nothing matches", async () => {
    const directory = await seeded();
    const inWindow = capture();
    expect(
      await main(["reports", "trends", "--project", "acme", "--metric", "sessions", "--from", "2026-03-30", "--data-dir", directory], {
        io: inWindow.io,
      }),
    ).toBe(EXIT.ok);
    expect(inWindow.stdout()).toMatch(/2026-03-30\.\.2026-04-05\t520/);

    // The window is in the query, so `--limit 1` cannot make a matching row
    // invisible: `limit` means the newest N *within* the window.
    const limited = capture();
    expect(
      await main(["reports", "trends", "--from", "2026-03-23", "--to", "2026-03-29", "--limit", "1", "--data-dir", directory], {
        io: limited.io,
      }),
    ).toBe(EXIT.ok);
    expect(limited.stdout()).toMatch(/2026-03-23\.\.2026-03-29\t400/);

    const outside = capture();
    expect(
      await main(["reports", "trends", "--from", "2026-06-01", "--to", "2026-06-30", "--data-dir", directory], { io: outside.io }),
    ).toBe(EXIT.ok);
    expect(outside.stdout()).toContain("no recorded report matches that project/metric/window");
  });

  it("treats a zero baseline as unknown rather than dividing by it", async () => {
    const directory = await seeded({ secondValue: 120 });
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      await store.asPort().repositories.reports.record({
        report: {
          reportId: "run-week-0",
          workspaceId: "default",
          runId: "run-week-0",
          artifactId: "art-0",
          periodStart: "2026-03-16",
          periodEnd: "2026-03-22",
          generatedAt: "2026-03-23T05:00:00.000Z",
          bytes: 999,
          projects: [
            {
              id: "acme",
              name: "Acme",
              metrics: [{ source: "ga4", key: "sessions", label: "Sessions", value: 0, unit: "count" }],
              newsCount: 0,
              notes: [],
            },
          ],
        },
      });
    } finally {
      store.close();
    }
    const shown = capture();
    expect(
      await main(["reports", "trends", "--project", "acme", "--metric", "sessions", "--format", "json", "--data-dir", directory], {
        io: shown.io,
      }),
    ).toBe(EXIT.ok);
    const result = JSON.parse(shown.stdout()) as {
      groups: {
        points: { value: number; changePercent: number | null; basis: string | null }[];
        change: { percent: number | null } | null;
      }[];
    };
    const group = result.groups[0];
    const points = group?.points ?? [];
    // 0 → 400 has no direction to report, so the percent is null and the *reason*
    // travels with it — asserting on `basis` matters because `JSON.stringify`
    // would turn a stray Infinity into null and make a bare `toBeNull` pass
    // either way.
    expect(points.map((point) => point.value)).toEqual([0, 400, 120]);
    expect(points[0]?.basis).toBeNull();
    expect(points[1]?.basis).toBe("zero-baseline");
    expect(points[1]?.changePercent).toBeNull();
    // 400 → 120 is an ordinary decline, and the *overall* change starts from the
    // zero baseline, so it reports no percent either.
    expect(points[2]?.changePercent).toBeCloseTo(-70, 5);
    expect(group?.change?.percent).toBeNull();
  });

  it("labels a change that spans a missing period instead of calling it one period's move", async () => {
    const directory = await seeded();
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      // 2026-03-16..22 is missing, so the 03-23 point has no adjacent predecessor.
      await store.asPort().repositories.reports.record({
        report: {
          reportId: "run-week-0",
          workspaceId: "default",
          runId: "run-week-0",
          artifactId: "art-0",
          periodStart: "2026-03-09",
          periodEnd: "2026-03-15",
          generatedAt: "2026-03-16T05:00:00.000Z",
          bytes: 999,
          projects: [
            {
              id: "acme",
              name: "Acme",
              metrics: [{ source: "ga4", key: "sessions", label: "Sessions", value: 300, unit: "count" }],
              newsCount: 0,
              notes: [],
            },
          ],
        },
      });
    } finally {
      store.close();
    }
    const shown = capture();
    expect(
      await main(["reports", "trends", "--project", "acme", "--metric", "sessions", "--format", "json", "--data-dir", directory], {
        io: shown.io,
      }),
    ).toBe(EXIT.ok);
    const points =
      (JSON.parse(shown.stdout()) as { groups: { points: { periodStart: string; change: number | null; gap: boolean }[] }[] }).groups[0]
        ?.points ?? [];
    // 03-09..15 → 03-23..29 crosses a week that was never recorded: the change is
    // real but it is not one period's move, and the flag says so.
    expect(points[1]).toMatchObject({ periodStart: "2026-03-23", change: 100, gap: true });
    expect(points[2]).toMatchObject({ periodStart: "2026-03-30", gap: false });
  });

  it("takes the most recently generated report when two cover the same period", async () => {
    const directory = directories.create();
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const sameWeek = (reportId: string, generatedAt: string, value: number) => ({
        reportId,
        workspaceId: "default",
        runId: reportId,
        artifactId: `art-${reportId}`,
        periodStart: "2026-03-23",
        periodEnd: "2026-03-29",
        generatedAt,
        bytes: 1_000,
        pages: 1,
        projects: [
          {
            id: "acme",
            name: "Acme",
            metrics: [{ source: "ga4", key: "sessions", label: "Sessions", value, unit: "count" as const }],
            newsCount: 0,
            notes: [],
          },
        ],
      });
      // A first run, then a re-run generated later to correct it. The store
      // orders coincident rows by `report_id DESC`, so the corrected row is
      // visited *first* and the stale one last — taking the last one seen kept
      // the numbers the re-run existed to replace.
      await store.asPort().repositories.reports.record({ report: sameWeek("run-a-first", "2026-03-30T05:00:00.000Z", 100) });
      await store.asPort().repositories.reports.record({ report: sameWeek("run-b-rerun", "2026-03-31T09:00:00.000Z", 400) });
    } finally {
      store.close();
    }

    const shown = capture();
    expect(await main(["reports", "trends", "--format", "json", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    const result = JSON.parse(shown.stdout()) as { groups: { points: { periodStart: string; value: number }[] }[] };
    // One point for the period, and it is the corrected one.
    expect(result.groups[0]?.points).toEqual([
      { periodStart: "2026-03-23", periodEnd: "2026-03-29", value: 400, change: null, changePercent: null, basis: null, gap: false },
    ]);
  });

  it("rejects a malformed window and an unknown action as usage", async () => {
    const directory = directories.create();
    const bad = capture();
    expect(await main(["reports", "trends", "--from", "March", "--data-dir", directory], { io: bad.io })).toBe(EXIT.usage);
    expect(bad.stderr()).toMatch(/--from must be a real date as YYYY-MM-DD/);

    // A date-shaped string that names no day matched nothing and read as "you
    // have no reports", which is a typo reported as an absence of data.
    const impossible = capture();
    expect(await main(["reports", "trends", "--from", "2026-02-31", "--data-dir", directory], { io: impossible.io })).toBe(EXIT.usage);
    expect(impossible.stderr()).toMatch(/--from must be a real date/);

    // So did a window whose ends are the wrong way round: the query asks for
    // `period_start >= from AND period_end <= to`, which no row can satisfy.
    const reversed = capture();
    expect(
      await main(["reports", "list", "--from", "2026-04-01", "--to", "2026-03-01", "--data-dir", directory], { io: reversed.io }),
    ).toBe(EXIT.usage);
    expect(reversed.stderr()).toMatch(/is after --to/);
    const unknown = capture();
    expect(await main(["reports", "frobnicate"], { io: unknown.io })).toBe(EXIT.usage);
    expect(unknown.stderr()).toMatch(/Unknown reports action/);
    const help = capture();
    expect(await main(["reports", "--help"], { io: help.io })).toBe(EXIT.ok);
    expect(help.stdout()).toMatch(/trends/);
  });
});

describe("tavi reports while tavi serve runs", () => {
  const handles: ServeHandle[] = [];
  afterEach(async () => {
    while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  });

  it("lists the briefs and their trends through the owner, as it does offline", async () => {
    const directory = await seeded();
    const handle = await serve(
      fixtureServeOptions(directory),
      { dataDirectory: directory, drainDeadlineMs: 5_000 },
      { stdout: () => {}, stderr: () => {}, isTty: false },
    );
    handles.push(handle);
    const listed = capture();
    expect(await main(["reports", "list", "--format", "json", "--data-dir", directory], { io: listed.io })).toBe(EXIT.ok);
    expect((JSON.parse(listed.stdout()) as { reports: { reportId: string }[] }).reports.map((row) => row.reportId)).toEqual([
      "run-week-2",
      "run-week-1",
    ]);
    const trends = capture();
    expect(await main(["reports", "trends", "--project", "acme", "--data-dir", directory], { io: trends.io })).toBe(EXIT.ok);
    expect(trends.stdout()).toContain("acme sessions (count)");
    // show and open read the store themselves: refused while the owner holds it.
    const shown = capture();
    expect(await main(["reports", "show", "art-1", "--data-dir", directory], { io: shown.io })).toBe(EXIT.alreadyOwned);
  });
});
