import { assertPositiveLimit } from "../values.js";
import type { ReportRepositoryPort } from "../internal-contracts.js";
import { z } from "zod";
import { TaviError, type ReportRecord, ReportProjectSummarySchema, ReportRecordSchema, parseOrThrow } from "@tavi/contracts";
import type { StoreContext } from "./context.js";
import { parseJsonColumn, partitionReadable } from "./stored-values.js";

/**
 * Generated-report history.
 *
 * `record` is an upsert keyed on `reportId`. A replayed generation — the same
 * task re-admitting after a suspension — must not add a second row for the same
 * period, or the trend would show the window twice and read as a spike that
 * never happened.
 */
export class SqliteReportRepository implements ReportRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  record(input: { readonly report: ReportRecord }): ReportRecord {
    // Validated **before** the write, not read back after it. The first version
    // inserted and then validated on the read-back, so a payload the schema
    // rejects — a 201-character project name, a 501-character note, a
    // non-finite metric that `JSON.stringify` renders as `null` — committed a
    // row that could never be read: the caller saw a throw, the row stayed, and
    // `list` skipped it, so a period vanished from the series with nothing
    // saying why (reproduced in review).
    const report = parseOrThrow(ReportRecordSchema, input.report, "the report summary is not valid and was not recorded");
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_reports
           (report_id, workspace_id, run_id, artifact_id, period_start, period_end, generated_at, bytes, pages, projects_json)
         VALUES (@reportId, @workspaceId, @runId, @artifactId, @periodStart, @periodEnd, @generatedAt, @bytes, @pages, @projectsJson)
         ON CONFLICT (report_id) DO UPDATE SET
           artifact_id = @artifactId,
           -- The period is replaced, not kept: a re-record with a new window
           -- would otherwise pair the OLD period with the NEW metrics, which is
           -- a series that lies about when its numbers came from.
           period_start = @periodStart,
           period_end = @periodEnd,
           generated_at = @generatedAt,
           bytes = @bytes,
           pages = @pages,
           projects_json = @projectsJson`,
      )
      .run({
        reportId: report.reportId,
        workspaceId: report.workspaceId,
        runId: report.runId,
        artifactId: report.artifactId,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        generatedAt: report.generatedAt,
        bytes: report.bytes,
        pages: report.pages ?? null,
        projectsJson: JSON.stringify(report.projects),
      });
    const stored = this.get(report.reportId);
    if (stored === undefined) {
      throw new TaviError("INTERNAL", `Report ${report.reportId} vanished immediately after insert`);
    }
    return stored;
  }

  get(reportId: string): ReportRecord | undefined {
    const row = this.#store.handle.prepare("SELECT * FROM tavi_reports WHERE report_id = ?").get(reportId) as ReportRow | undefined;
    return row === undefined ? undefined : toReportRecord(row);
  }

  list(input: { readonly workspaceId: string; readonly limit: number; readonly from?: string; readonly to?: string }): {
    readonly reports: readonly ReportRecord[];
    readonly unreadable: readonly string[];
  } {
    // `limit` went straight to SQLite, and a
    // negative one is *unbounded* there, so a port-level caller could read the
    // whole history while every other bounded listing in this file refused.
    assertPositiveLimit(input.limit, "ReportRepository.list");
    const rows = this.#store.handle
      .prepare(
        `SELECT * FROM tavi_reports
          WHERE workspace_id = @workspaceId
            AND (@from IS NULL OR period_start >= @from)
            AND (@to IS NULL OR period_end <= @to)
          ORDER BY period_start DESC, report_id DESC
          LIMIT @limit`,
      )
      .all({
        workspaceId: input.workspaceId,
        from: input.from ?? null,
        to: input.to ?? null,
        limit: input.limit,
      }) as ReportRow[];
    // Per row, and reported rather than thrown: `toReportRecord` validates, and a
    // throwing read would make one hand-edited row (or one written from a
    // non-finite metric, which JSON turns into `null`) destroy the entire
    // workspace's history rather than costing its own entry. Returning the ids
    // rather than `continue`-ing is what keeps a lost period from reading as
    // "no data".
    const partitioned = partitionReadable(rows, (row) => row.report_id, toReportRecord);
    return { reports: partitioned.readable, unreadable: partitioned.unreadable };
  }
}

interface ReportRow {
  readonly report_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly artifact_id: string;
  readonly period_start: string;
  readonly period_end: string;
  readonly generated_at: string;
  readonly bytes: number;
  readonly pages: number | null;
  readonly projects_json: string;
}

/**
 * Validated on the way out, like the schedule and agent rows: a hand-edited or
 * older row must not become an unvalidated metric series inside a trend.
 */
function toReportRecord(row: ReportRow): ReportRecord {
  const projects = z
    .array(ReportProjectSummarySchema)
    .max(50)
    .safeParse(parseJsonColumn<unknown>(row.projects_json, "report project summaries"));
  if (!projects.success) {
    throw new TaviError("INTERNAL", `Report ${row.report_id} has an unreadable summary`, { details: { reportId: row.report_id } });
  }
  return {
    reportId: row.report_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    artifactId: row.artifact_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    generatedAt: row.generated_at,
    bytes: row.bytes,
    ...(row.pages === null ? {} : { pages: row.pages }),
    projects: projects.data,
  };
}
