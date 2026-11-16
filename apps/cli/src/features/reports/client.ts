import { plural } from "@tavi/contracts/util";
import type { PersistencePort } from "@tavi/contracts";
import { configOnOwner } from "../../cli/owner.js";
import { emit, jsonText } from "../../cli/output.js";
import { EXIT, reportCommandFailure, reportFailure } from "../../cli/exit.js";
import { writeFileSync } from "node:fs";
import type { ReportsCommandOptions } from "./parse.js";
import type { CliIo } from "../../cli/io.js";
import { type ResolvedDataDirectory, withStore } from "../../cli/store.js";

/**
 * `tavi reports show|open <artifact-id>`.
 *
 * The brief's PDF is an artifact, not a tool result — it is past the 64 KiB gate
 * the moment it exists — so this is how an operator reads it. `show`
 * prints metadata only; `open` materializes the bytes at an operator-chosen path.
 */
/**
 * `tavi reports list` and `tavi reports trends`: the operator's view of the
 * report history.
 *
 * The history rows were already durable and already readable by the model
 * through `reports.history`; there was simply no way for an *operator* to see
 * what had been produced or how a metric moved, and the tool's caller had to do
 * its own date arithmetic over a bounded list. `list` prints the rows; `trends`
 * shapes one project's metric across periods and computes the change between
 * adjacent periods, which is the question the scenario actually asks ("how have
 * sessions moved this month?").
 *
 * Read-only, but through the store rather than a raw file open, so it takes the
 * data directory like every other direct database command and refuses while
 * `serve` owns it.
 */
async function reportsHistoryCommand(options: ResolvedDataDirectory<ReportsCommandOptions>, io: CliIo): Promise<number> {
  const workspaceId = options.workspaceId ?? "default";
  // The window goes into the query, not a filter after it: `limit` then means
  // "the newest N *within the window*", and a window that matches nothing
  // says so because the store found nothing — not because the newest N rows
  // happened to fall outside it.
  const query = {
    workspaceId,
    limit: options.limit ?? 12,
    ...(options.from === undefined ? {} : { from: options.from }),
    ...(options.to === undefined ? {} : { to: options.to }),
  };
  try {
    // A live owner answers from its own store: a schedule's briefs are read while it runs.
    const viaOwner = await configOnOwner(options.dataDirectory, "reports", io, {
      label: `tavi reports ${options.action}`,
      mutates: false,
      build: () => ({ action: "list" as const, ...query }),
      render: (result) => renderHistory(options, io, workspaceId, result as ReportHistory),
    });
    if (viaOwner !== undefined) return viaOwner;
    return await withStore(options.dataDirectory, async (store) =>
      renderHistory(options, io, workspaceId, await store.asPort().repositories.reports.list(query)),
    );
  } catch (error) {
    return reportCommandFailure(error, io, "reports command failed");
  }
}

/** What `reports.list` answers: the window's reports, and the rows that could not be read. */
type ReportHistory = Awaited<ReturnType<PersistencePort["repositories"]["reports"]["list"]>>;

/** `list` or `trends` over the reports a store or the owner answered. */
async function renderHistory(
  options: ResolvedDataDirectory<ReportsCommandOptions>,
  io: CliIo,
  workspaceId: string,
  { reports, unreadable }: ReportHistory,
): Promise<number> {
  if (unreadable.length > 0) {
    // Named, not hidden: a period that exists but cannot be read is a
    // different answer from "no reports" (the same discipline the registry
    // listings use).
    io.stderr(`${unreadable.length} report row(s) could not be read: ${unreadable.join(", ")}
`);
  }
  // By *period*, not generation time: the periods are the axis an operator
  // reads, and a backfilled report generation-ordered after its successors
  // would invert the series.
  const window = [...reports].sort((left, right) => right.periodStart.localeCompare(left.periodStart));
  if (options.action === "list") {
    emit(
      io,
      options.format,
      {
        reports: await Promise.all(
          window.map(async (report) => ({
            reportId: report.reportId,
            periodStart: report.periodStart,
            periodEnd: report.periodEnd,
            generatedAt: report.generatedAt,
            artifactId: report.artifactId,
            bytes: report.bytes,
            pages: report.pages ?? null,
            projects: report.projects.length,
            metrics: await report.projects.reduce((sum, project) => sum + project.metrics.length, 0),
          })),
        ),
        unreadable,
      },
      (value) => (value.reports.length === 0 ? "no reports have been generated yet for this workspace\n" : reportListText(value.reports)),
    );
    return EXIT.ok;
  }

  // `trends`: one series per (project, metric), chronological, so a delta is
  // always between *adjacent periods of the same series* — not between two
  // adjacent rows, which mixed projects, metrics and units (a `count` beside
  // a `usd`) and made a missing week look like one period's change.
  interface TrendPoint {
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly value: number;
    /** Which report this point came from — the coincident-period tie-break, never printed. */
    readonly generatedAt: string;
    readonly reportId: string;
  }
  const groups = new Map<string, { projectId: string; metricKey: string; label: string; unit: string; points: TrendPoint[] }>();
  for (const report of window) {
    for (const project of report.projects) {
      if (options.projectId !== undefined && project.id !== options.projectId) continue;
      for (const metric of project.metrics) {
        if (options.metricKey !== undefined && metric.key !== options.metricKey) continue;
        const key = `${project.id}\u0000${metric.key}`;
        const group = groups.get(key) ?? {
          projectId: project.id,
          metricKey: metric.key,
          label: metric.label,
          unit: metric.unit,
          points: [],
        };
        // Several reports can share a period (a re-run, a backfill): the
        // most recently *generated* one wins, rather than contributing a
        // second coincident point.
        //
        // Which row that is cannot be read off iteration order: the store
        // orders `period_start DESC, report_id DESC`, and a report id is
        // `${runId}:${periodEnd}`, so among coincident rows the order is the
        // run ids' lexicographic order — arbitrary with respect to time.
        // Keeping the last one iterated therefore kept whichever run id
        // sorted lowest, which is how a correcting re-run's numbers lost to
        // the numbers it was generated to replace.
        const existing = group.points.find((point) => point.periodStart === report.periodStart);
        const candidate: TrendPoint = {
          periodStart: report.periodStart,
          periodEnd: report.periodEnd,
          value: metric.value,
          generatedAt: report.generatedAt,
          reportId: report.reportId,
        };
        if (existing !== undefined) {
          // Two rows can carry the same `generatedAt` (a replay, a stubbed
          // clock); the report id then breaks the tie, so the choice is at
          // least deterministic rather than dependent on scan order.
          const newer =
            candidate.generatedAt === existing.generatedAt
              ? candidate.reportId > existing.reportId
              : candidate.generatedAt > existing.generatedAt;
          if (!newer) continue;
          group.points = group.points.filter((point) => point.periodStart !== report.periodStart);
        }
        group.points.push(candidate);
        groups.set(key, group);
      }
    }
  }
  const shaped = [...groups.values()].map((group) => {
    const points = [...group.points]
      .sort((left, right) => left.periodStart.localeCompare(right.periodStart))
      // The tie-break fields are how a point was *chosen*, not part of the
      // series a reader plots: dropped here so the result shape stays the
      // period, the value and the movement.
      .map((point) => ({ periodStart: point.periodStart, periodEnd: point.periodEnd, value: point.value }));
    const withDeltas = points.map((point, index) => {
      const previous = points[index - 1];
      if (previous === undefined) {
        return { ...point, change: null, changePercent: null, basis: null, gap: false };
      }
      // Adjacent means the next period starts the day after the previous one
      // ends. Anything else — a missing week, a monthly series with a skipped
      // month — is a gap, and `previous.periodEnd < point.periodStart` alone
      // is true for *every* consecutive pair, which made the flag useless.
      const adjacent = Date.parse(point.periodStart) - Date.parse(previous.periodEnd) === 24 * 60 * 60 * 1000;
      // A percent change across zero, or from a zero baseline, has no
      // direction — reported as `null` with the reason, never as a number
      // (a `-10 → +5` move is not "+150%").
      const basis = previous.value === 0 ? "zero-baseline" : Math.sign(previous.value) !== Math.sign(point.value) ? "sign-change" : null;
      return {
        ...point,
        change: point.value - previous.value,
        changePercent: basis === null ? ((point.value - previous.value) / Math.abs(previous.value)) * 100 : null,
        basis,
        // A missing period between these two points: the change spans more
        // than one period, and the reader is told rather than left to infer.
        gap: !adjacent,
      };
    });
    const first = points[0];
    const last = points.at(-1);
    return {
      projectId: group.projectId,
      metricKey: group.metricKey,
      label: group.label,
      unit: group.unit,
      from: first?.periodStart ?? null,
      to: last?.periodEnd ?? null,
      change:
        first === undefined || last === undefined || first === last
          ? null
          : {
              absolute: last.value - first.value,
              percent:
                first.value === 0 || Math.sign(first.value) !== Math.sign(last.value)
                  ? null
                  : ((last.value - first.value) / Math.abs(first.value)) * 100,
            },
      points: withDeltas,
    };
  });
  const result = {
    workspaceId,
    from: window.at(-1)?.periodStart ?? null,
    to: window[0]?.periodEnd ?? null,
    groups: shaped,
    unreadable,
  };
  emit(io, options.format, result, (value) =>
    value.groups.every((group) => group.points.length === 0)
      ? `no recorded report matches that project/metric/window in ${workspaceId}\n`
      : value.groups
          .map(
            (group) =>
              `${group.projectId} ${group.metricKey} (${group.unit})\n` +
              `  period\tvalue\tchange\tchange%\n` +
              group.points
                .map(
                  (point) =>
                    `  ${point.periodStart}..${point.periodEnd}\t${point.value}\t${point.change === null ? "-" : point.change}\t` +
                    `${point.changePercent === null ? (point.basis === null ? "-" : `n/a (${point.basis})`) : point.changePercent.toFixed(1)}${point.gap ? "\t(gap)" : ""}\n`,
                )
                .join("") +
              (group.change === null
                ? ""
                : `  overall\t\t${group.change.absolute}\t${group.change.percent === null ? "n/a" : group.change.percent.toFixed(1)}\n`),
          )
          .join(""),
  );
  return EXIT.ok;
}

export async function reportsCommand(options: ResolvedDataDirectory<ReportsCommandOptions>, io: CliIo): Promise<number> {
  if (options.action === "list" || options.action === "trends") {
    return reportsHistoryCommand(options, io);
  }
  try {
    return await withStore(options.dataDirectory, async (store) => {
      const artifacts = store.asPort().repositories.artifacts;
      const record = await artifacts.getArtifact(options.artifactId);
      if (record === undefined) {
        io.stderr(`no artifact ${options.artifactId} exists in ${options.dataDirectory}\n`);
        return EXIT.unavailable;
      }
      // This command is for rendered briefs. Without this, `open` would write any
      // artifact's raw body — a skill package, an archived tool output, a folded
      // conversation — to any path, and would hand over a `pending` artifact's
      // content without the decision the review gate exists to obtain.
      if (record.contentType !== "application/pdf") {
        io.stderr(`artifact ${record.artifactId} is ${record.contentType}, not a report\n`);
        return EXIT.usage;
      }
      const metadata = {
        artifactId: record.artifactId,
        contentType: record.contentType,
        byteSize: record.byteSize,
        sha256: record.sha256,
        reviewState: record.reviewState,
        runId: record.runId,
      };
      if (options.action === "show") {
        io.stdout(
          options.format === "json"
            ? jsonText(metadata)
            : `${metadata.artifactId}\t${metadata.contentType}\t${metadata.byteSize}B\t${metadata.reviewState}\n`,
        );
        return EXIT.ok;
      }
      if (record.reviewState !== "approved") {
        // Metadata is always readable; the *body* of an undecided or refused
        // artifact is not.
        io.stderr(`artifact ${record.artifactId} is ${record.reviewState}; decide it with \`tavi artifacts approve|reject\` first\n`);
        return EXIT.reviewRequired;
      }
      const body = await artifacts.readArtifactBody(record.artifactId);
      if (body === undefined) {
        io.stderr(`artifact ${record.artifactId} is recorded but its body could not be read\n`);
        return EXIT.unavailable;
      }
      const out = options.out ?? "";
      writeFileSync(out, body);
      io.stdout(`${out}\n`);
      return EXIT.ok;
    });
  } catch (error) {
    return reportFailure(error, io, "reports command failed");
  }
}

/**
 * `tavi reports list`'s text: a header, then each report on a line of its own,
 * columns padded with spaces (never tabs) and its time to the minute in UTC,
 * with its id under it for `tavi reports open` — an `art-<uuid>` beside the
 * rest would run past a terminal's width.
 */
function reportListText(
  reports: readonly {
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly generatedAt: string;
    readonly artifactId: string;
    readonly bytes: number;
    readonly projects: number;
    readonly metrics: number;
  }[],
): string {
  const rows = [
    ["PERIOD", "GENERATED (UTC)", "SIZE", "CONTENTS"],
    ...reports.map((row) => [
      `${row.periodStart}..${row.periodEnd}`,
      row.generatedAt.slice(0, 16).replace("T", " "),
      `${row.bytes} B`,
      `${plural(row.projects, "project")}, ${plural(row.metrics, "metric")}`,
    ]),
  ];
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length))) ?? [];
  const line = (row: readonly string[]) =>
    `${row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0))).join("  ")}\n`;
  return [line(rows[0] ?? []), ...reports.map((report, index) => `${line(rows[index + 1] ?? [])}  ${report.artifactId}\n`)].join("");
}
