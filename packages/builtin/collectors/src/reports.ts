import { z } from "zod";

import {
  TRUSTED_PUBLIC,
  TaviError,
  folderFileName,
  isUntrusted,
  joinLabels,
  trustedLabel,
  untrustedLabel,
  type ArtifactRepositoryPort,
  type ContentLabel,
  type InvocationContext,
  type ProjectRepositoryPort,
  type RenderPort,
  type ReportRepositoryPort,
  type SecretReaderPort,
  type ToolRegistrar,
} from "@tavi/contracts";
import type { Locale } from "@tavi/contracts/i18n";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { printThemeCss } from "@tavi/contracts/print-theme";
import { nowTimestamp } from "@tavi/contracts/util";

import {
  boundedIds,
  collectDaily,
  fitToToolResultBudget,
  type DailyBrief,
  type Metric,
  type NewsItem,
  type ProjectReport,
} from "./collectors.js";

/**
 * The daily brief's rendering step.
 *
 * Two properties are load-bearing:
 *
 *  - **The HTML is built here, from typed data — never supplied by the model.**
 *    Feed titles and snippets are untrusted input rendered inside Chromium, so
 *    every interpolated value is escaped. A `reports.render` tool that accepted
 *    HTML would hand the model a browser context.
 *  - **The PDF is an artifact, never a tool result.** The sample brief was
 *    already 77.5 KiB — past the 64 KiB gate that turns a
 *    tool result into a `pending` artifact and suspends the turn — so the tool
 *    returns `{artifactId, bytes, pages}` and the bytes go to the artifact store
 *    with `reviewState: "approved"` (a trusted producer: the operator's own
 *    schedule generated it, so there is nothing for a human to review before it
 *    is sent).
 */

/**
 * A `YYYY-MM-DD` that names a day that exists.
 *
 * The pattern alone is not the check: `2026-02-31` and `2026-13-01` match it,
 * compare as strings against every real period and match nothing — so a model
 * that miscounted a month's length reads "no reports" instead of being told its
 * argument is not a date. Mirrors `isCalendarDate` in `features/reports/parse.ts`, which does the
 * same for the operator's own `--from`/`--to`.
 */
const isCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

const formatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function formatValue(metric: Metric): string {
  if (metric.unit === "usd") return `$${formatter.format(metric.value)}`;
  if (metric.unit === "position") return metric.value.toFixed(1);
  return formatter.format(metric.value);
}

function metricRow(metric: Metric): string {
  return `<tr>
      <td class="label">${escapeHtml(metric.label)}</td>
      <td class="source">${escapeHtml(metric.source)}</td>
      <td class="value">${escapeHtml(formatValue(metric))}</td>
    </tr>`;
}

function newsList(news: readonly NewsItem[], t: CoreT): string {
  if (news.length === 0) return `<p class="muted">${t("plugins.collectors.brief.noNews")}</p>`;
  return `<ul class="news">${news
    .map((item) => {
      // The URL is escaped, but the scheme is validated here too: this HTML runs
      // inside a browser, and `parseFeed` is not the only possible source of a
      // `NewsItem`. Anything that is not http(s) renders as plain text.
      const link = /^https?:\/\//i.test(item.url)
        ? `<a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a>`
        : `<span>${escapeHtml(item.title)}</span>`;
      return `<li>
        ${link}
        <span class="meta">${escapeHtml(item.source)}${item.publishedAt === undefined ? "" : ` · ${escapeHtml(item.publishedAt)}`}</span>
        ${item.snippet === undefined ? "" : `<p class="snippet">${escapeHtml(item.snippet)}</p>`}
      </li>`;
    })
    .join("")}</ul>`;
}

function projectSection(project: ProjectReport, t: CoreT): string {
  const notes =
    project.notes.length === 0
      ? ""
      : `<div class="notes"><strong>${t("plugins.collectors.brief.dataQuality")}</strong><ul>${project.notes
          .map((note) => `<li>${escapeHtml(note)}</li>`)
          .join("")}</ul></div>`;
  const metrics =
    project.metrics.length === 0
      ? `<p class="muted">${t("plugins.collectors.brief.noMetrics")}</p>`
      : `<table class="metrics"><thead><tr><th>${t("plugins.collectors.brief.metric")}</th><th>${t("plugins.collectors.brief.source")}</th><th class="value">${t("plugins.collectors.brief.value")}</th></tr></thead>
          <tbody>${project.metrics.map(metricRow).join("")}</tbody></table>`;
  return `<section class="project">
    <h2>${escapeHtml(project.name)} <span class="meta">${escapeHtml(project.id)}</span></h2>
    ${metrics}
    <h3>${t("plugins.collectors.brief.news")}</h3>
    ${newsList(project.news, t)}
    ${notes}
  </section>`;
}

/**
 * Render the brief to a complete, self-contained HTML document, its own words
 * (headings, column names, empty states) in `locale`: English by default. They
 * are the catalogue's, written into the page as they are; everything collected
 * is escaped. The collectors' metric labels and notes are their data, as collected.
 */
export async function renderBriefHtml(brief: DailyBrief, locale: Locale = "en"): Promise<string> {
  const t = locale === "en" ? coreEnglish : coreIn(locale);
  const summaryKeys = ["sessions", "mrr", "revenue"];
  const header = (await brief.projects.map((project) => `<td>${escapeHtml(project.name)}</td>`)).join("");
  const body = summaryKeys
    .map((key) => {
      const cells = brief.projects
        .map((project) => {
          const metric = project.metrics.find((candidate) => candidate.key === key);
          return `<td>${metric === undefined ? "—" : escapeHtml(formatValue(metric))}</td>`;
        })
        .join("");
      const label = t(
        key === "mrr"
          ? "plugins.collectors.brief.mrr"
          : key === "revenue"
            ? "plugins.collectors.brief.revenue"
            : "plugins.collectors.brief.sessions",
      );
      return `<tr><th>${label}</th>${cells}</tr>`;
    })
    .join("");
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><title>${t("plugins.collectors.brief.title")}</title>
<style>
  ${printThemeCss("px")}
  @page { size: A4; margin: 18mm 16mm; }
  body { font: var(--print-text-base)/1.45 var(--print-font); color: var(--print-ink); margin: 0; }
  header { border-bottom: 2px solid var(--print-ink); padding-bottom: 8px; margin-bottom: 16px; }
  h1 { font-size: var(--print-text-xl); margin: 0 0 4px; }
  h2 { font-size: var(--print-text-lg); margin: 0 0 8px; }
  h3 { font-size: var(--print-text-md); text-transform: uppercase; letter-spacing: 0.6px; color: var(--print-muted); margin: 16px 0 6px; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 2px; }
  th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--print-rule); }
  th { font-size: var(--print-text-xs); text-transform: uppercase; letter-spacing: 0.5px; color: var(--print-muted); }
  td.value, th.value { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  td.label { font-weight: 600; }
  .meta { color: var(--print-faint); font-size: var(--print-text-xs); text-transform: uppercase; letter-spacing: 0.4px; }
  .project { break-inside: avoid; margin-top: 20px; padding-top: 10px; border-top: 1px solid var(--print-rule); }
  ul.news { list-style: none; padding: 0; margin: 0; }
  ul.news li { margin-bottom: 7px; }
  ul.news a { color: var(--print-ink); text-decoration: none; font-weight: 600; }
  .snippet { margin: 1px 0 0; color: var(--print-ink-soft); }
  .notes { margin-top: 10px; background: var(--print-note-fill); border-left: 3px solid var(--print-note-edge); padding: 6px 9px; font-size: var(--print-text-sm); }
  .muted { color: var(--print-faint); font-style: italic; }
</style></head>
<body>
  <header>
    <h1>${t("plugins.collectors.brief.heading")}</h1>
    <div class="meta">${t("plugins.collectors.brief.meta", {
      start: escapeHtml(brief.period.start),
      end: escapeHtml(brief.period.end),
      generatedAt: escapeHtml(brief.generatedAt),
      count: brief.projects.length,
    })}</div>
  </header>
  <table class="summary"><thead><tr><th>${t("plugins.collectors.brief.crossProject")}</th>${header}</tr></thead><tbody>${body}</tbody></table>
  ${(await brief.projects.map((project) => projectSection(project, t))).join("")}
</body></html>`;
}

export interface ReportToolOptions {
  readonly dataDirectory: string;
  readonly secretReader: SecretReaderPort;
  /** The project registry — see `CollectorToolOptions`. */
  readonly projects: ProjectRepositoryPort;
  /** Generated-report history. */
  readonly reports: ReportRepositoryPort;
  /** Injectable so a recorded `generatedAt` is deterministic under test. */
  readonly nowIso?: () => string;
  readonly artifacts: ArtifactRepositoryPort;
  /**
   * Copies the stored report into `reports/` in the calling chat's managed
   * folder: it is stored approved, so at
   * once. Never throws; a copy that fails leaves the report generated.
   */
  readonly materializeArtifact?: (artifactId: string) => Promise<unknown>;
  /**
   * Records the calling chat's folder as tainted: an
   * untrusted report's copy in `reports/` taints whoever reads it later.
   */
  readonly markFolderTainted?: (context: InvocationContext) => Promise<void>;
  readonly renderer: RenderPort;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  /**
   * Where a non-fatal failure goes when the result can only carry a short note.
   *
   * `reports.generate` promises a PDF, so a failed history write is degraded
   * rather than fatal — but the *cause* has to exist somewhere. Without it the
   * model and the operator both see only "a trend will be missing this period"
   * with no indication whether a payload our own read schema rejects, a full
   * disk, or a bug in this handler was responsible.
   */
  readonly logWarning?: (message: string, details?: Record<string, unknown>) => void;
  /** The workspace's language, which the brief's own words are written in. Absent: English. */
  readonly locale?: (workspaceId: string) => Promise<Locale>;
}

/** What a render returns to the model: a reference and a size, never the bytes. */
interface RenderedReport {
  readonly artifactId: string;
  readonly bytes: number;
  readonly pages?: number;
  readonly period: { readonly start: string; readonly end: string };
  readonly projects: readonly { readonly id: string; readonly metrics: number; readonly news: number; readonly notes: number }[];
}

/**
 * How many metrics one project contributes to `reports.history`.
 *
 * The collector pipeline records well under this per report; the cap exists so a
 * history over many reports cannot grow past the 64 KiB tool-result gate, which
 * suspends an unattended run on a *read* rather than failing it.
 */
const MAX_HISTORY_METRICS_PER_PROJECT = 16;

export function registerReportTools(registry: ToolRegistrar, options: ReportToolOptions): void {
  const nowIso = options.nowIso ?? ((): string => nowTimestamp());
  /**
   * `reports.history` — trends over the reports this deployment generated.
   *
   * `read-only`, so an unattended run can ask it without raising an approval,
   * and it returns the *series* rather than the documents: a caller asking
   * "how did sessions move?" wants numbers with their units and the periods
   * they belong to, not a list of PDFs it cannot read.
   */
  registry.register({
    id: "reports.history",
    sink: "none",
    // What the reports' pipeline recorded from collected data — third parties' figures and names.
    untrustedOutput: true,
    outputSource: "routine-output",
    version: "1.0.0",
    description:
      "The reporting history: each generated brief's period, artifact and per-project metric values, newest first. Use this for trends over time. Returns bounded summaries, never the PDFs.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: z
      .object({
        limit: z.number().int().min(1).max(52).optional().describe("How many recent reports to include (default 12)"),
        projectId: z.string().min(1).max(64).optional().describe("Limit the series to one project"),
        metricKey: z.string().min(1).max(128).optional().describe("Limit the series to one metric key"),
        // The *declared* schema stays a plain pattern: it is converted to a JSON
        // schema for the model, and the registry refuses a refinement there
        // (`ZodEffects` has no representation). The calendar check and the
        // window's ordering are enforced by the handler's own parse below,
        // which is what actually gates the query.
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Earliest period start to include (YYYY-MM-DD)"),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Latest period end to include (YYYY-MM-DD)"),
      })
      .optional(),
    handler: async ({ input, context }: { input: unknown; context: { readonly workspaceId: string } }) => {
      const parsed = z
        .object({
          limit: z.number().int().min(1).max(52).optional(),
          projectId: z.string().min(1).max(64).optional(),
          metricKey: z.string().min(1).max(128).optional(),
          from: z.string().refine(isCalendarDate, "expected a real date as YYYY-MM-DD").optional(),
          to: z.string().refine(isCalendarDate, "expected a real date as YYYY-MM-DD").optional(),
        })
        // A reversed window can never match — the store asks for
        // `period_start >= from AND period_end <= to` — so it is refused with
        // its cause rather than answered "no recorded report falls in ...",
        // which a model reads as an absence of data.
        .refine((value) => value.from === undefined || value.to === undefined || value.from <= value.to, {
          message: "from is after to; the window is empty",
        })
        .safeParse(input ?? {});
      if (!parsed.success) throw new TaviError("INVALID_INPUT", "reports.history received invalid arguments");
      const { reports, unreadable } = await options.reports.list({
        workspaceId: context.workspaceId,
        limit: parsed.data.limit ?? 12,
        ...(parsed.data.from === undefined ? {} : { from: parsed.data.from }),
        ...(parsed.data.to === undefined ? {} : { to: parsed.data.to }),
      });
      if (reports.length === 0) {
        // The unreadable ids travel with the empty answer, not only with a
        // non-empty one: otherwise a workspace whose every row failed validation
        // would get "no reports have been generated yet", and a lost period would
        // read as no data.
        const unreadableReports = boundedIds(unreadable);
        return {
          reports: 0,
          ...(unreadableReports.ids.length === 0 ? {} : { unreadableReports }),
          note:
            unreadableReports.ids.length > 0
              ? "every recorded report in this workspace could not be read; repair or restore those rows"
              : parsed.data.from === undefined && parsed.data.to === undefined
                ? "no reports have been generated yet for this workspace"
                : `no recorded report falls in ${parsed.data.from ?? "-"}..${parsed.data.to ?? "-"}`,
          series: [],
        };
      }
      // One row per report, each project's metrics filtered to what was asked
      // for: a trend is read across periods, so the caller needs the same metric
      // from each report rather than everything from one.
      const series: {
        reportId: string;
        periodStart: string;
        periodEnd: string;
        generatedAt: string;
        artifactId: string;
        projects: {
          id: string;
          metrics: { key: string; label: string; value: number; unit: string }[];
          newsCount: number;
          notes?: readonly string[];
          /** How many metrics the per-project cap left out. */
          omittedMetrics?: number;
        }[];
      }[] = reports
        // The window is resolved by the store, against the *period* rather than
        // the generation time: "sessions for March" means the periods March
        // covers, and `limit` then means the newest N *within* the window, so a
        // window the caller asked for cannot come back empty because the newest
        // rows happened to fall outside it.
        .map((report) => ({
          reportId: report.reportId,
          periodStart: report.periodStart,
          periodEnd: report.periodEnd,
          generatedAt: report.generatedAt,
          artifactId: report.artifactId,
          projects: report.projects
            .filter((project) => parsed.data.projectId === undefined || project.id === parsed.data.projectId)
            .map((project) => {
              const matching = project.metrics.filter(
                (metric) => parsed.data.metricKey === undefined || metric.key === parsed.data.metricKey,
              );
              const shown = matching.slice(0, MAX_HISTORY_METRICS_PER_PROJECT);
              return {
                id: project.id,
                // A per-project cap is not a bound on the *result*: `limit` defaults
                // to 12 and a report may carry 50 projects, which measured 133 255
                // bytes — twice the gate — with default input. The
                // whole payload is bounded below; this cap only decides what a single
                // project contributes before that.
                metrics: shown.map((metric) => ({ key: metric.key, label: metric.label, value: metric.value, unit: metric.unit })),
                // …and the cap is stated rather than silent: a
                // caller reading a series otherwise cannot tell a project with
                // sixteen metrics from one with forty, and would read a flat trend
                // across the missing ones as "no change".
                ...(matching.length === shown.length ? {} : { omittedMetrics: matching.length - shown.length }),
                newsCount: project.newsCount,
                ...(project.notes.length === 0 ? {} : { notes: project.notes }),
              };
            }),
        }));
      const matched = (
        await Promise.all(series.map(async (entry) => await entry.projects.some((project) => project.metrics.length > 0)))
      ).some(Boolean);
      const payload = (): unknown => ({
        reports: reports.length,
        // Named so a trend that lost a period does not read as "no data": the
        // row exists and could not be parsed, which is a different answer.
        ...(unreadable.length === 0 ? {} : { unreadableReports: boundedIds(unreadable) }),
        // The axis a caller should plot against, stated so it is not guessed — and
        // read off the *surviving* series, so a period dropped to fit the gate is
        // not advertised as covered.
        from: series.at(-1)?.periodStart ?? null,
        to: series[0]?.periodEnd ?? null,
        // A filter that matches nothing is a *result*, not an empty trend:
        // otherwise a wrong metric key returns metric-less rows that read as "no data" rather than "no such metric".
        ...(matched
          ? {}
          : {
              note: (() => {
                const window = ` in ${parsed.data.from ?? "-"}..${parsed.data.to ?? "-"}`;
                if (parsed.data.metricKey === undefined && parsed.data.projectId === undefined) {
                  return parsed.data.from === undefined && parsed.data.to === undefined
                    ? "the recorded reports contain no metrics"
                    : `no recorded report falls${window}`;
                }
                return (
                  `no recorded report has a metric matching ${JSON.stringify(parsed.data.metricKey ?? parsed.data.projectId ?? "")}` +
                  (parsed.data.from === undefined && parsed.data.to === undefined ? "" : window)
                );
              })(),
            }),
        series,
      });
      // Cross the gate and the *read* is what suspends: `archiveToolOutput` turns
      // the result into a pending artifact, and an unattended run has nobody to
      // release it. Metrics inside the oldest report go first (a trend loses its
      // least-recent detail), then the oldest whole period, and either way the
      // answer says what it left out instead of quietly shortening the series.
      const bounded = fitToToolResultBudget(
        payload,
        () => {
          for (let index = series.length - 1; index >= 0; index -= 1) {
            const host = series[index]?.projects.find((project) => project.metrics.length > 0);
            if (host !== undefined) {
              host.metrics.pop();
              // The count has to include what the *gate* dropped, not just what
              // the per-project cap did, or a project left showing 0 of 23 metrics
              // would still claim `omittedMetrics: 7`.
              host.omittedMetrics = (host.omittedMetrics ?? 0) + 1;
              return true;
            }
          }
          // Notes before whole periods: a note explains *why* a point is missing,
          // and untrimmed notes could crowd a notes-dominated history out of its
          // own series while the range still claimed to cover it.
          for (let index = series.length - 1; index >= 0; index -= 1) {
            const host = series[index]?.projects.find((project) => (project.notes?.length ?? 0) > 0);
            if (host !== undefined && host.notes !== undefined) {
              (host.notes as string[]).pop();
              return true;
            }
          }
          return series.pop() !== undefined;
        },
        (dropped) =>
          `${dropped} metric(s) or report(s) were omitted to keep this result under the runtime's tool-result gate; ` +
          "narrow with `metricKey` or `projectId`, or ask for fewer reports with `limit`",
      );
      return bounded.note === undefined ? payload() : { ...(payload() as Record<string, unknown>), note: bounded.note };
    },
  });

  registry.register({
    id: "reports.generate",
    sink: "none",
    version: "1.0.0",
    description:
      "Collect every configured project's data and render the daily brief as a PDF, stored as a report artifact. " +
      "Returns the artifact reference and size — never the document itself.",
    // It reads the provider APIs *and* writes an artifact, so it is an effect
    // rather than a read. A scheduled run auto-approves `reports.*` through its
    // own policy — and that allowlist entry has to cover
    // both halves, since this tool is not read-only.
    effect: "mutating",
    requiredPermissions: ["tools.invoke"],
    inputSchema: z
      .object({
        projectIds: z.array(z.string().min(1).max(64)).max(50).optional().describe("Limit to these projects (default: all)"),
        lookbackDays: z.number().int().min(1).max(90).optional().describe("Reporting window ending yesterday"),
      })
      .optional(),
    handler: async ({
      input,
      context,
      signal,
      contextLabel,
    }: {
      input: unknown;
      context: InvocationContext;
      signal: AbortSignal;
      contextLabel?: ContentLabel;
    }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "reports.generate was cancelled");
      const parsed = z
        .object({ projectIds: z.array(z.string()).max(50).optional(), lookbackDays: z.number().int().min(1).max(90).optional() })
        .safeParse(input ?? {});
      if (!parsed.success) throw new TaviError("INVALID_INPUT", "reports.generate received invalid arguments");

      const brief = await collectDaily(
        {
          dataDirectory: options.dataDirectory,
          secretReader: options.secretReader,
          // Threaded from the composition root so the report and the collector
          // tools read the same registry.
          projects: options.projects,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.now === undefined ? {} : { now: options.now }),
        },
        {
          // The invoking task's workspace, as the artifact write below.
          workspaceId: context.workspaceId,
          ...(parsed.data.projectIds === undefined ? {} : { projectIds: parsed.data.projectIds }),
          ...(parsed.data.lookbackDays === undefined ? {} : { lookbackDays: parsed.data.lookbackDays }),
        },
      );

      const locale = (await options.locale?.(context.workspaceId)) ?? "en";
      const rendered = await options.renderer.renderPdf({ html: await renderBriefHtml(brief, locale) });
      if (signal.aborted) throw new TaviError("CANCELLED", "reports.generate was cancelled");
      // Rendered by Tavi from the business collectors' numbers, which are personal, with the feeds'
      // headlines and snippets when any project has news (third parties' words, `routine-output`),
      // joined with the chat it was made in: trusted only when neither is untrusted.
      const fed = brief.projects.some((project) => project.news.length > 0);
      const label = joinLabels(
        joinLabels(contextLabel ?? TRUSTED_PUBLIC, trustedLabel("personal")),
        fed ? untrustedLabel("routine-output", { confidentiality: "personal" }) : TRUSTED_PUBLIC,
      );
      // Its copy in the chat's folder is read as the folder is: tainted, when the report is — recorded before it
      // is stored approved, so a failure stores nothing.
      if (isUntrusted(label)) await options.markFolderTainted?.(context);
      const record = await options.artifacts.putArtifact({
        workspaceId: context.workspaceId,
        runId: context.runId,
        contentType: "application/pdf",
        extension: "pdf",
        body: rendered.bytes,
        // A trusted producer: the operator's own schedule asked for this report,
        // so it must not enter the `pending` review queue — an unattended run has
        // no one to decide, and the whole point of a scheduled report is that nobody is there.
        reviewState: "approved",
        // Copied into `reports/` in the chat's own folder under this name.
        fileName: folderFileName(`brief-${brief.period.start}-to-${brief.period.end}.pdf`, "brief.pdf"),
        folderCopy: "reports",
        label,
      });
      await options.materializeArtifact?.(record.artifactId);
      // Record the *numbers* the PDF was rendered from. A PDF is not queryable and the model cannot read one, so without
      // this row "how have sessions moved this month?" has no answer — the
      // history exists but nothing can see it.
      // The PDF is the deliverable; the history row is what makes it *queryable*.
      // A failed history write must therefore not fail the generation — the
      // operator was promised a report and has one — but it must be visible
      // rather than silent, so the result says the series is incomplete.
      let historyFailure: string | undefined;
      try {
        await options.reports.record({
          report: {
            // Run **and** window: a replay of the same generation resolves the
            // same id (so a resumed task cannot double-count a period), while two
            // distinct generations in one run — a lookback change, an on-demand
            // re-run — keep their own rows instead of the later one silently
            // replacing the earlier PDF's entry in the series.
            reportId: `${context.runId}:${brief.period.end}`,
            workspaceId: context.workspaceId,
            runId: context.runId,
            artifactId: record.artifactId,
            periodStart: brief.period.start,
            periodEnd: brief.period.end,
            generatedAt: nowIso(),
            bytes: record.byteSize,
            ...(rendered.pages === undefined ? {} : { pages: rendered.pages }),
            projects: await brief.projects.map((project) => ({
              id: project.id,
              name: project.name,
              // A non-finite value is dropped rather than stored: `JSON.stringify`
              // turns `NaN`/`Infinity` into `null`, the read schema rejects a null
              // number, and the row would then be unreadable forever. Losing one
              // metric point is a visible gap; losing the row costs the report.
              metrics: project.metrics
                .filter((metric) => Number.isFinite(metric.value))
                .map((metric) => ({
                  source: metric.source,
                  key: metric.key,
                  label: metric.label,
                  value: metric.value,
                  unit: metric.unit,
                })),
              newsCount: project.news.length,
              notes: [...project.notes],
            })),
          },
        });
      } catch (error) {
        // Name the cause instead of discarding it: the note
        // the model sees carries the typed code, and the operator's log carries
        // the whole error. Catching everything is deliberate — the PDF is the
        // deliverable and it already exists — but "degraded" and "silent" are
        // not the same thing.
        historyFailure = error instanceof TaviError ? error.code : "INTERNAL";
        // The log call is guarded too: `createLogger` writes through a
        // caller-supplied sink, and an unguarded throw from it would fail a
        // generation whose artifact is already durable — turning a degraded
        // history into an orphaned PDF and an `uncertain` effect row.
        try {
          options.logWarning?.("report history write failed; the series will be missing this period", {
            reportId: `${context.runId}:${brief.period.end}`,
            code: historyFailure,
            error,
          });
        } catch {
          // Nothing left to report to: the note below still says the series is
          // incomplete, which is the part the caller has to act on.
        }
      }
      return {
        ...(historyFailure === undefined
          ? {}
          : {
              historyNote: `this report could not be added to the reporting history (${historyFailure}); a trend will be missing this period`,
            }),
        artifactId: record.artifactId,
        bytes: record.byteSize,
        ...(rendered.pages === undefined ? {} : { pages: rendered.pages }),
        period: brief.period,
        projects: await brief.projects.map((project) => ({
          id: project.id,
          metrics: project.metrics.length,
          news: project.news.length,
          notes: project.notes.length,
        })),
      } satisfies RenderedReport;
    },
  });
}
