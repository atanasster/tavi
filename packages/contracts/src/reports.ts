import type { AsyncRepository } from "./persistence-types.js";
import { z } from "zod";

/**
 * Generated-report history.
 *
 * The brief's PDF was already durable as an artifact, but a PDF is not
 * queryable: "how have sessions moved over the last month?" cannot be answered
 * from a stack of documents without reading them, and the model cannot read a
 * PDF at all. So each generated brief records a **bounded structured summary**
 * alongside its artifact — the same numbers the PDF was rendered from — and
 * `reports.history` turns that into an answer.
 *
 * This is deliberately a *summary*, not the collector output: the metric list
 * and the news count, never the headline text or the raw provider payload. A
 * trend needs the series, not the prose, and storing the full document again
 * would duplicate what the artifact already holds.
 */

/**
 * One metric as recorded at report time.
 *
 * `unit` is carried because a trend line is only meaningful with it: sessions,
 * dollars and average positions are not comparable, and a summary that dropped
 * the unit would invite exactly that mistake.
 */
export const ReportMetricSchema = z.strictObject({
  source: z.string().min(1).max(64),
  key: z.string().min(1).max(128),
  label: z.string().min(1).max(200),
  value: z.number(),
  unit: z.enum(["count", "usd", "position"]),
});

/** One project's contribution to one report. */
export const ReportProjectSummarySchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  metrics: z.array(ReportMetricSchema).max(64),
  newsCount: z.number().int().min(0),
  /** The per-source `partial`/unconfigured notes, so a gap in the series is explainable rather than mysterious. */
  notes: z.array(z.string().max(500)).max(32),
});

export const ReportRecordSchema = z.strictObject({
  reportId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  /** The task that produced it, so a report is traceable to its run. */
  runId: z.string().min(1).max(128),
  /** The artifact holding the rendered PDF. */
  artifactId: z.string().min(1).max(128),
  /** The reporting window this report covers — the axis a trend is plotted against. */
  periodStart: z.string().min(1).max(32),
  periodEnd: z.string().min(1).max(32),
  generatedAt: z.string().min(1).max(64),
  bytes: z.number().int().min(0),
  pages: z.number().int().min(0).optional(),
  projects: z.array(ReportProjectSummarySchema).max(50),
});
export type ReportRecord = z.infer<typeof ReportRecordSchema>;
export type ReportProjectSummary = z.infer<typeof ReportProjectSummarySchema>;

interface ReportRepositoryPortDefinition {
  /** Idempotent by `reportId`: a replayed generation must not double-count a period in the series. */
  record(input: { readonly report: ReportRecord }): ReportRecord;
  get(reportId: string): ReportRecord | undefined;
  /** Most recent first — the order a trend is read in. */
  /**
   * `unreadable` holds the `report_id` of each row that could not be validated,
   * isolated and reported rather than thrown or silently skipped — the same
   * shape the project, agent and schedule registries use. A trend that quietly
   * loses a period reads as "no data".
   */
  list(input: {
    readonly workspaceId: string;
    readonly limit: number;
    /**
     * Restrict to briefs whose *period* falls inside this window, resolved by the
     * store rather than by the caller: filtering after `limit` would search only
     * the newest N rows, so a window could report "nothing" while matching rows
     * exist further back.
     */
    readonly from?: string;
    readonly to?: string;
  }): { readonly reports: readonly ReportRecord[]; readonly unreadable: readonly string[] };
}

export type ReportRepositoryPort = AsyncRepository<ReportRepositoryPortDefinition>;

/** The most reports one `reports list` answer holds. */
export const REPORTS_LIST_MAX = 52;

/**
 * `reports` on a live owner: `list` reads the report history as `tavi reports
 * list` and `trends` do offline, so a schedule's briefs are read while it runs.
 * Dates are `YYYY-MM-DD`, matched against a report's period.
 */
export const ReportsPayloadSchema = z.strictObject({
  action: z.literal("list"),
  workspaceId: z.string().min(1).max(128),
  limit: z.number().int().min(1).max(REPORTS_LIST_MAX),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type ReportsPayload = z.infer<typeof ReportsPayloadSchema>;
