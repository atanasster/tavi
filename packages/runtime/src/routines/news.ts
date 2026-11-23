import {
  MediatedFetchResultSchema,
  RoutineNewsSelectionSchema,
  RoutineNewsSourceSchema,
  TaviError,
  redactCredentialPrefixes,
  redactCredentialShapes,
  scrubCredentialText,
  ROUTINE_REPORTED_LIMIT,
  type RoutineDedupEntry,
  type RoutineFence,
  type RoutineNewsReport,
  type RoutineNewsWindow,
  type RoutineNewsSelection,
  type RoutineNewsSource,
  type RoutineNewsStory,
  type RoutineRun,
  type RoutineScope,
  LLM_RELEASES_ROUTINE_TEMPLATE_ID,
  isBuiltinRoutineTemplate,
  localDateTime,
  routineReportTitle,
  routineTemplateIdOf,
  type RoutineTemplate,
} from "@tavi/contracts";
import { DEFAULT_LOCALE, isLocale } from "@tavi/contracts/i18n";
import type { CoreKey, CoreT } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { printThemeCss } from "@tavi/contracts/print-theme";
import { nowTimestamp } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";
import { canonicalRoutineJson, routineHash } from "./service.js";
import { hostRefusal } from "../host-policy.js";
import { egressHostRefusal } from "../fetch-tool.js";
import { PUBLISHER_REGISTRY_REVIEWED_AT, PUBLISHER_REGISTRY_VERSION, mayCorroborate, publisherIdentity } from "../publisher-registry.js";
import { ROUTINE_CLUSTERING, materialChangeFingerprint, syndicationVerdict } from "./clustering.js";
import { routineRunSnapshotSql, type RoutineExecutionService } from "./runs.js";
/** The window's caveat when an earlier gap lies past the recovery window: English, as the window is read; said in the report's language there. */
const UNCOVERED_GAP = "An earlier uncovered interval exceeds the saved recovery window";
const normalized = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
/** Words whose period ends an abbreviation, not a sentence: "Acme Inc. said", "Dr. Lee", "Jan. 5", "A vs. B". */
const ABBREVIATIONS = new Set(
  "inc co corp ltd llc plc bros dept univ assn mr mrs ms dr prof sr jr st mt gen gov sen rep rev capt col lt sgt no vol fig est approx vs etc al jan feb mar apr jun jul aug sep sept oct nov dec".split(
    " ",
  ),
);
/** True when the text ends in an abbreviation's or an initial's period ("Inc.", "U.S.", "J."), which does not end a sentence. */
function endsInAbbreviation(text: string): boolean {
  const word = /([^\s([{"'\u201c\u2018]+)\.$/.exec(text)?.[1];
  if (word === undefined) return false;
  return /^(?:[a-z]\.)*[a-z]$/i.test(word) || ABBREVIATIONS.has(word.toLowerCase());
}
/**
 * The normalized sentences a quote may be: the text split at every sentence-ending mark, and split again
 * without breaking after an abbreviation or an initial, so "Acme Inc. shipped it." and its two fragments both count.
 */
function routineSentences(text: string): readonly string[] {
  const sentences = new Set<string>();
  const split = (line: string, keep: (before: string) => boolean) => {
    let start = 0;
    for (const boundary of line.matchAll(/(?<=[.!?])\s+/g)) {
      if (keep(line.slice(start, boundary.index))) continue;
      sentences.add(normalized(line.slice(start, boundary.index)));
      start = boundary.index + boundary[0].length;
    }
    sentences.add(normalized(line.slice(start)));
  };
  for (const line of text.split(/\n+/)) {
    split(line, () => false);
    split(line, endsInAbbreviation);
  }
  sentences.delete("");
  return [...sentences];
}
/** Common words that say nothing about which story a page is about. */
const STOPWORDS = new Set(
  "about after also been from have into more most news only over said says than that their them then there these they this those were what when which while will with would your".split(
    " ",
  ),
);
/** A text's lowercase words and numbers. */
const tokens = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)*/gu) ?? [];
/** The words that pick a story out: at least four letters and not a stopword, or any word with a digit in it. */
function distinctiveTokens(text: string): readonly string[] {
  return [...new Set(tokens(text).filter((token) => /\d/.test(token) || (token.length >= 4 && !STOPWORDS.has(token))))];
}
const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
function textOf(html: string): string {
  return scrubCredentialText(
    redactCredentialShapes(
      html
        .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
        .replace(/<\/(?:p|div|h[1-6]|li|article|section)>/gi, "\n")
        .replace(/<[^>]*>/g, " ")
        .replace(
          /&(?:nbsp|amp|quot|lt|gt|#39);/g,
          (entity) => ({ "&nbsp;": " ", "&amp;": "&", "&quot;": '"', "&lt;": "<", "&gt;": ">", "&#39;": "'" })[entity] ?? entity,
        )
        .replace(/[ \t]+/g, " ")
        .trim(),
    ),
  ).slice(0, 16_000);
}
function dateOf(html: string, field: "published" | "updated"): string | null {
  const property = field === "published" ? "article:published_time" : "article:modified_time";
  const jsonField = field === "published" ? "datePublished" : "dateModified";
  const tag = (html.match(/<meta\b[^>]*>/gi) ?? []).find((value) => value.includes(property));
  const match = tag === undefined ? new RegExp(`"${jsonField}"\\s*:\\s*"([^"']+)`, "i").exec(html) : /content=["']([^"']+)/i.exec(tag);
  const value = match?.[1];
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}
function canonicalUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new TaviError("NOT_AUTHORIZED", "Evidence URL must be public HTTPS");
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_|fbclid|gclid|token$|key$|api_key$|access_token$|secret$|signature$|auth$)/i.test(key)) url.searchParams.delete(key);
  return url.toString();
}
export interface RoutineNewsOptions {
  /**
   * The near-duplicate policy in use.
   *
   * `null` means clustering is unavailable: the run then deduces by story
   * identity alone and says so in its coverage gaps, rather than silently
   * behaving as if it had clustered. The default is the threshold the corpus
   * sweep chose, so the fallback is a deliberate degradation and not the norm.
   */
  readonly clustering?: { readonly threshold: number; readonly method: string } | null;
}
export class RoutineNewsService {
  readonly runs: RoutineExecutionService;
  readonly options: RoutineNewsOptions;
  constructor(runs: RoutineExecutionService, options: RoutineNewsOptions = {}) {
    this.runs = runs;
    this.options = options;
  }
  private get clustering(): { readonly threshold: number; readonly method: string } | null {
    return this.options.clustering === undefined
      ? { threshold: ROUTINE_CLUSTERING.threshold, method: ROUTINE_CLUSTERING.method }
      : this.options.clustering;
  }
  private get db() {
    return this.runs.routines.store.handle;
  }
  sources(scope: RoutineScope, runId: string): readonly RoutineNewsSource[] {
    this.runs.get(scope, runId);
    return (
      this.db.prepare("SELECT source_json FROM tavi_routine_sources WHERE run_id=? ORDER BY source_id LIMIT 100").all(runId) as {
        source_json: string;
      }[]
    ).map((row) => RoutineNewsSourceSchema.parse(JSON.parse(row.source_json)));
  }
  private save(run: RoutineRun, source: RoutineNewsSource): void {
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM tavi_routine_sources WHERE run_id=?").get(run.runId) as { n: number };
    if (count.n >= 100 && this.db.prepare("SELECT 1 FROM tavi_routine_sources WHERE source_id=?").get(source.sourceId) === undefined)
      throw new TaviError("CONFLICT", "Run evidence limit reached");
    this.db
      .prepare("INSERT INTO tavi_routine_sources VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_id) DO NOTHING")
      .run(source.sourceId, run.runId, run.workspaceId, canonicalRoutineJson(RoutineNewsSourceSchema.parse(source)), source.retrievedAt);
  }
  /**
   * A granted plugin read's result: each of its `routineSources` (at
   * most 20) is checked like a search result (public HTTPS, the run's
   * network mode) and recorded as fetched evidence whose quotable text is the
   * plugin's excerpt; anything else in the result passes through, recording
   * nothing. Keyed on the registry's word that the tool is a plugin read,
   * never on its name.
   */
  private capturePlugin(run: RoutineRun, tool: string, result: Record<string, unknown>, now: string): unknown {
    // Only the call's own failure (the `{ ok: false }` the research adapter sends when it throws) is a coverage gap; a plugin's answer that says no (a brief's problems) is the model's to read.
    if (result["ok"] === false && Object.keys(result).length === 1) {
      this.db
        .prepare(
          "INSERT INTO tavi_routine_coverage VALUES (?,0,1,?) ON CONFLICT(run_id) DO UPDATE SET failures=failures+1,updated_at=excluded.updated_at",
        )
        .run(run.runId, now);
      return { sources: [], note: `${tool} failed; coverage is incomplete.` };
    }
    if (!Array.isArray(result["routineSources"])) return result;
    this.db
      .prepare(
        "INSERT INTO tavi_routine_coverage(run_id,searches,failures,updated_at) VALUES (?,1,0,?) ON CONFLICT(run_id) DO UPDATE SET searches=searches+1,updated_at=excluded.updated_at",
      )
      .run(run.runId, now);
    const recorded: RoutineNewsSource[] = [];
    for (const item of result["routineSources"].slice(0, 20)) {
      if (item === null || typeof item !== "object") continue;
      const value = item as Record<string, unknown>;
      if (typeof value["url"] !== "string" || typeof value["excerpt"] !== "string") continue;
      let url: string;
      try {
        url = canonicalUrl(value["url"]);
      } catch {
        continue;
      }
      const { networkMode, allowedHosts } = run.snapshot.permissions;
      if (egressHostRefusal(new URL(url), networkMode, allowedHosts) !== undefined) continue;
      const excerpt = scrubCredentialText(redactCredentialShapes(value["excerpt"])).replace(/\s+/g, " ").trim().slice(0, 2_000);
      if (excerpt === "") continue;
      const published = typeof value["publishedAt"] === "string" ? Date.parse(value["publishedAt"]) : Number.NaN;
      const source: RoutineNewsSource = {
        version: 1,
        sourceId: `source-${routineHash({ runId: run.runId, url, tool, hash: sha256Hex(excerpt) }).slice(0, 48)}`,
        runId: run.runId,
        workspaceId: run.workspaceId,
        originalUrl: url,
        finalUrl: url,
        canonicalUrl: url,
        publisher: new URL(url).hostname,
        title: typeof value["title"] === "string" ? scrubCredentialText(value["title"]).slice(0, 300) : "",
        state: "fetched",
        retrievedAt: now,
        publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null,
        updatedAt: null,
        excerpt,
        contentHash: sha256Hex(excerpt),
        byteSize: Buffer.byteLength(excerpt),
        redirects: [],
        adapter: `plugin:${tool}`,
      };
      this.save(run, source);
      recorded.push(source);
    }
    // The model cites what was recorded, by its sourceId, quoting the excerpt as it was kept.
    return {
      ...result,
      routineSources: recorded.map((source) => ({
        sourceId: source.sourceId,
        url: source.canonicalUrl,
        title: source.title,
        publishedAt: source.publishedAt,
        excerpt: source.excerpt,
      })),
    };
  }
  /** Called after the guarded real tool response, never from model-supplied evidence. `origin` is the registry's: a granted plugin read. */
  capture(fence: RoutineFence, tool: string, input: unknown, output: unknown, origin?: "plugin"): unknown {
    const run = this.runs.assertFence(fence, "research");
    const now = nowTimestamp();
    let result = output !== null && typeof output === "object" ? (output as Record<string, unknown>) : {};
    if (tool === "web_search") {
      if (result["ok"] === false) {
        this.db
          .prepare(
            "INSERT INTO tavi_routine_coverage VALUES (?,0,1,?) ON CONFLICT(run_id) DO UPDATE SET failures=failures+1,updated_at=excluded.updated_at",
          )
          .run(run.runId, now);
        return { sources: [], note: "Search failed; coverage is incomplete." };
      }
      this.db
        .prepare(
          "INSERT INTO tavi_routine_coverage(run_id,searches,failures,updated_at) VALUES (?,1,0,?) ON CONFLICT(run_id) DO UPDATE SET searches=searches+1,updated_at=excluded.updated_at",
        )
        .run(run.runId, now);
      const items = Array.isArray(result["sources"]) ? result["sources"].slice(0, 20) : [];
      const sources: RoutineNewsSource[] = [];
      for (const item of items) {
        if (item === null || typeof item !== "object") continue;
        const value = item as Record<string, unknown>;
        if (typeof value["url"] !== "string") continue;
        let url: string;
        try {
          url = canonicalUrl(value["url"]);
        } catch {
          continue;
        }
        const { networkMode, allowedHosts } = run.snapshot.permissions;
        if (egressHostRefusal(new URL(url), networkMode, allowedHosts) !== undefined) continue;
        const snippet = typeof value["snippet"] === "string" ? value["snippet"] : "";
        const source: RoutineNewsSource = {
          version: 1,
          sourceId: `source-${routineHash({ runId: run.runId, url, snippet: true }).slice(0, 48)}`,
          runId: run.runId,
          workspaceId: run.workspaceId,
          originalUrl: url,
          finalUrl: url,
          canonicalUrl: url,
          publisher: new URL(url).hostname,
          title: typeof value["title"] === "string" ? value["title"].slice(0, 300) : "",
          state: "snippet",
          retrievedAt: now,
          publishedAt: null,
          updatedAt: null,
          excerpt: redactCredentialShapes(snippet).slice(0, 1000),
          contentHash: null,
          byteSize: null,
          redirects: [],
        };
        this.save(run, source);
        // The stored record is scrubbed; the result keeps every full-length credential shape as the
        // tool gave it, so the tool-output redaction (and the workspace's redactToolResults setting)
        // labels and counts each kind instead of finding an unlabelled `[redacted]` in its place.
        // A fragment too short for any full shape (`sk-abc123`) is masked here, setting or not.
        sources.push({ ...source, excerpt: redactCredentialPrefixes(snippet).slice(0, 1000) });
      }
      return { sources, note: "Discovery only. Fetch pages before using claims; snippet text is not evidence." };
    }
    if (origin === "plugin") return this.capturePlugin(run, tool, result, now);
    if (tool !== "http.request" && tool !== "web_fetch") throw new TaviError("NOT_AUTHORIZED", "Unsupported evidence adapter");
    if (tool === "web_fetch" && result["ok"] !== false) {
      const parsed = MediatedFetchResultSchema.safeParse(output);
      if (!parsed.success) throw new TaviError("NOT_AUTHORIZED", "Evidence requires a host transport receipt beside the content");
      const { content, receipt } = parsed.data;
      const request = input as { url: string };
      if (receipt.url !== request.url || receipt.finalUrl !== content.url || receipt.status !== content.statusCode)
        throw new TaviError("NOT_AUTHORIZED", "Evidence content does not match its transport receipt");
      // Truncated content is a partial page: it is recorded, never counted as fetched evidence.
      result = { ...receipt, body: content.body.content, truncated: content.truncated };
    }
    const args = input as { url: string };
    const original = canonicalUrl(args.url);
    const final = typeof result["finalUrl"] === "string" ? canonicalUrl(result["finalUrl"]) : original;
    const redirects = Array.isArray(result["redirects"])
      ? (result["redirects"] as { to?: unknown }[])
          .map((hop) => (typeof hop.to === "string" ? canonicalUrl(hop.to) : undefined))
          .filter((value): value is string => value !== undefined)
          .slice(0, 5)
      : [];
    if (tool === "web_fetch") {
      // `web_fetch` re-validates every hop against the address guard, so a
      // cross-host redirect is legitimate when it is *recorded*: the chain is
      // the evidence that each hop was checked, not an unexplained destination
      // change. Its response shape is app-produced, never model-supplied.
      if (result["ok"] !== false && result["addressClass"] !== "public")
        throw new TaviError("NOT_AUTHORIZED", "Evidence response was not address-classified");
    } else if (
      new URL(final).origin !== new URL(original).origin ||
      hostRefusal(final, run.snapshot.permissions.allowedHosts) !== undefined
    ) {
      throw new TaviError("NOT_AUTHORIZED", "Evidence response changed destination");
    }
    const httpError = typeof result["status"] === "number" && result["status"] >= 400;
    const truncated = result["truncated"] === true;
    const fetched =
      tool === "web_fetch"
        ? typeof result["body"] === "string" && typeof result["status"] === "number" && !httpError && !truncated
        : result["ok"] === true && typeof result["body"] === "string";
    const failureReason = fetched ? undefined : httpError ? ("http_status" as const) : truncated ? ("truncated" as const) : undefined;
    const body = fetched ? (result["body"] as string) : "";
    const excerpt = textOf(body);
    const source: RoutineNewsSource = {
      version: 1,
      sourceId: `source-${routineHash({ runId: run.runId, original, hash: sha256Hex(excerpt) }).slice(0, 48)}`,
      runId: run.runId,
      workspaceId: run.workspaceId,
      originalUrl: original,
      finalUrl: final,
      canonicalUrl: final,
      publisher: new URL(final).hostname,
      title: textOf(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? "").slice(0, 300),
      state: fetched ? "fetched" : "failed",
      retrievedAt: now,
      publishedAt: dateOf(body, "published"),
      updatedAt: dateOf(body, "updated"),
      excerpt,
      contentHash: fetched ? sha256Hex(excerpt) : null,
      byteSize: fetched ? Buffer.byteLength(excerpt) : null,
      redirects,
      addressClass: tool === "web_fetch" ? "public" : "allowlist",
      ...(failureReason === undefined ? {} : { failureReason }),
    };
    this.save(run, source);
    if (!fetched)
      this.db
        .prepare(
          "INSERT INTO tavi_routine_coverage VALUES (?,0,1,?) ON CONFLICT(run_id) DO UPDATE SET failures=failures+1,updated_at=excluded.updated_at",
        )
        .run(run.runId, now);
    return source;
  }
  window(scope: RoutineScope, runId: string, now: string): RoutineNewsWindow {
    const run = this.runs.get(scope, runId);
    const pinned = (run.data as typeof run.data & { newsWindow?: RoutineNewsWindow }).newsWindow;
    if (pinned !== undefined) return pinned;
    const row = this.db.prepare("SELECT state_json FROM tavi_routine_state WHERE routine_id=?").get(run.routineId) as {
      state_json: string;
    };
    const state = JSON.parse(row.state_json) as {
      coverage?: { to: string | null } | null;
      unresolvedCoverage?: { from: string; to: string } | null;
      dedup?: RoutineDedupEntry[];
    };
    // What the routine already reported, so research and synthesis spend no slot on it: the newest within the dedup
    // window, one entry a story. A row from before titles were kept suppresses its repeat but cannot be named.
    const reported = new Map<string, { title: string; releaseIdentity: string }>();
    for (const item of [...(state.dedup ?? [])].reverse()) {
      if (reported.size >= ROUTINE_REPORTED_LIMIT) break;
      if (item.title === undefined || item.releaseIdentity === undefined) continue;
      if (Date.parse(now) - Date.parse(item.at) > run.snapshot.report.dedupWindowDays * 86_400_000) continue;
      const story = normalized(`${item.releaseIdentity}\u0000${item.title}`);
      if (!reported.has(story)) reported.set(story, { title: item.title, releaseIdentity: item.releaseIdentity });
    }
    // `to: null` is the initial state ("nothing covered yet"), not a timestamp.
    // Reading it as one produced `Invalid time value` on the first run of a fresh
    // routine — the reader and the writer now agree on the shape.
    const covered = state.coverage?.to ?? undefined;
    const base = Date.parse(now) - run.snapshot.report.lookbackHours * 3_600_000;
    const failed = this.db
      .prepare(
        "SELECT MIN(claimed_at) AS first FROM tavi_routine_runs WHERE routine_id=? AND mode='production' AND status='failed' AND claimed_at>?",
      )
      .get(run.routineId, covered ?? "") as { first: string | null };
    const failedStart =
      failed.first === null ? undefined : new Date(Date.parse(failed.first) - run.snapshot.report.lookbackHours * 3_600_000).toISOString();
    const earliest = state.unresolvedCoverage?.from ?? failedStart ?? covered;
    const desired = earliest === undefined ? base : Math.min(base, Date.parse(earliest) - 3_600_000);
    const cutoff = Date.parse(now) - run.snapshot.report.widenLookbackMaxHours * 3_600_000;
    const from = Math.max(cutoff, desired);
    return {
      from: new Date(from).toISOString(),
      to: now,
      hours: (Date.parse(now) - from) / 3_600_000,
      gaps: desired < cutoff ? [UNCOVERED_GAP] : [],
      ...(reported.size === 0 ? {} : { reported: [...reported.values()].reverse() }),
    };
  }
  prepareWindow(fence: RoutineFence): RoutineNewsWindow {
    const run = this.runs.assertFence(fence);
    const window = this.window({ workspaceId: run.workspaceId, principalId: run.principalId }, run.runId, run.startedAt ?? run.claimedAt);
    this.db
      .prepare("UPDATE tavi_routine_runs SET data_json=? WHERE run_id=?")
      .run(canonicalRoutineJson({ ...run.data, newsWindow: window }), run.runId);
    return window;
  }
  pruneEvidence(now = nowTimestamp(), dryRun = false): number {
    if (dryRun)
      return (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM tavi_routine_sources WHERE json_extract(source_json,'$.excerpt')<>'' AND julianday(created_at)<julianday(?) - COALESCE((SELECT json_extract(${routineRunSnapshotSql("r")},'$.retention.detailDays') FROM tavi_routine_runs r WHERE r.run_id=tavi_routine_sources.run_id),30)`,
          )
          .get(now) as { n: number }
      ).n;
    return this.db
      .prepare(
        `UPDATE tavi_routine_sources SET source_json=json_set(source_json,'$.excerpt','','$.prunedAt',?) WHERE json_extract(source_json,'$.excerpt')<>'' AND julianday(created_at)<julianday(?) - COALESCE((SELECT json_extract(${routineRunSnapshotSql("r")},'$.retention.detailDays') FROM tavi_routine_runs r WHERE r.run_id=tavi_routine_sources.run_id),30)`,
      )
      .run(now, now).changes;
  }
  select(scope: RoutineScope, runId: string, raw: unknown, now = nowTimestamp()): RoutineNewsReport {
    const run = this.runs.get(scope, runId);
    const selection: RoutineNewsSelection = RoutineNewsSelectionSchema.parse(raw);
    const sources = this.sources(scope, runId);
    const coverage = this.db.prepare("SELECT searches,failures FROM tavi_routine_coverage WHERE run_id=?").get(runId) as
      | { searches: number; failures: number }
      | undefined;
    const fetched = sources.filter((source) => source.state === "fetched");
    if ((coverage?.searches ?? 0) === 0 && fetched.length === 0)
      throw new TaviError("INVALID_INPUT", "Research performed no discovery or page reads");
    const state = this.db.prepare("SELECT state_json FROM tavi_routine_state WHERE routine_id=?").get(run.routineId) as {
      state_json: string;
    };
    const history = (JSON.parse(state.state_json) as { dedup?: RoutineDedupEntry[] }).dedup ?? [];
    const retained = new Set(
      history
        .filter((item) => Date.parse(now) - Date.parse(item.at) <= run.snapshot.report.dedupWindowDays * 86_400_000)
        .map((item) => item.key),
    );
    const window = this.window(scope, runId, now);
    let rejected = 0;
    let duplicates = 0;
    const suppressions: { releaseIdentity: string; reason: string }[] = [];
    // The report's own caveats are said in its language, as its headings are; English as they always were.
    const language = run.snapshot.report.language;
    const t = coreIn(isLocale(language) ? language : DEFAULT_LOCALE);
    const gaps: string[] = window.gaps.map((gap) => (gap === UNCOVERED_GAP ? t("reports.news.gap.uncovered") : gap));
    // An `llm-releases-v1` story is a release: every claim names it, the story is titled by it, and the LLM
    // benchmarks its claims name are part of what it says. A plugin template keeps those rules, except that a
    // topic template's story (a trends digest's) is named by its label, which its claims need not repeat.
    // A `news-v1` story is what its title says, and its claims are sentences about it.
    const template = run.snapshot.report.template;
    const templateId = routineTemplateIdOf(run.snapshot);
    const releases = templateId === LLM_RELEASES_ROUTINE_TEMPLATE_ID || template !== undefined;
    const namesRelease = releases && template?.storyIsTopic !== true;
    const name = this.runs.routines.get(scope, run.routineId).routine.name;
    const clustering = this.clustering;
    if (clustering === null) gaps.push(t(releases ? "reports.news.gap.noClusteringRelease" : "reports.news.gap.noClusteringStory"));
    // Provenance for the policy actually in force, so a reader can tell which
    // threshold and which registry produced a report. It is the run's own until
    // a production publication copies it into the routine's state: a preview
    // leaves the routine's state as it found it. The name the report is titled
    // with is kept beside it, so its delivered file is named the same.
    this.db
      .prepare("UPDATE tavi_routine_runs SET data_json=json_set(data_json,'$.clustering',json(?),'$.reportName',?) WHERE run_id=?")
      .run(
        canonicalRoutineJson({
          threshold: clustering?.threshold ?? null,
          method: clustering?.method ?? null,
          corpusVersion: ROUTINE_CLUSTERING.corpusVersion,
          registryVersion: PUBLISHER_REGISTRY_VERSION,
          registryReviewedAt: PUBLISHER_REGISTRY_REVIEWED_AT,
          at: now,
        }),
        name,
        run.runId,
      );
    if (coverage?.failures) gaps.push(t("reports.news.gap.failures", { count: coverage.failures, n: String(coverage.failures) }));
    if (fetched.some((source) => source.publishedAt === null)) gaps.push(t("reports.news.gap.undated"));
    const select = (hours: number): RoutineNewsStory[] => {
      const stories: RoutineNewsStory[] = [];
      const seen = new Set<string>();
      for (const candidate of selection.stories) {
        const linked = candidate.claims.map((claim) => fetched.find((source) => source.sourceId === claim.sourceId));
        const supported = candidate.claims.every((claim, index) => {
          const source = linked[index];
          if (source === undefined) return false;
          return routineSentences(source.excerpt).includes(normalized(claim.text)) && /[.!?]$/.test(claim.text.trim());
        });
        const dates = linked.map((source) => Date.parse(source?.publishedAt ?? ""));
        const newest = Math.max(...dates);
        if (
          !supported ||
          dates.some((date) => !Number.isFinite(date) || date < Date.parse(now) - hours * 3_600_000) ||
          !Number.isFinite(newest) ||
          newest > Date.parse(now) + 300_000 ||
          newest < Date.parse(now) - hours * 3_600_000 ||
          (namesRelease && !candidate.claims.every((claim) => normalized(claim.text).includes(normalized(candidate.releaseIdentity))))
        ) {
          rejected++;
          continue;
        }
        const sourceIds = [...new Set(candidate.claims.map((claim) => claim.sourceId))];
        // A `news-v1` claim need not name its story, so a source counts toward independence only when its page
        // names a distinctive term of the story's title or identity: a sentence from an unrelated page does not.
        const terms = distinctiveTokens(`${candidate.title} ${candidate.releaseIdentity}`);
        const about = (source: RoutineNewsSource) => {
          if (releases) return true;
          const page = new Set(tokens(source.excerpt));
          return terms.some((term) => page.has(term));
        };
        const unique = linked
          .filter((source): source is RoutineNewsSource => source !== undefined)
          .filter((source, index, values) => values.findIndex((other) => other.contentHash === source.contentHash) === index);
        // Independence counts distinct *publishers*, not strings, and it applies
        // the weaker admission rule on purpose: a known syndicator or aggregator
        // is excluded because counting it would count the same voice twice, while
        // a host the registry has never reviewed is "no evidence either way" and
        // *does* contribute. The registry is evidence, not a requirement, which is
        // why the caveat below says what it says rather than "verified".
        // A plugin read's sources are one voice however many hosts it names: it asserted their text, Tavi fetched none of it.
        const primary = new Set(
          unique
            .filter((source) => mayCorroborate(source.publisher) && about(source))
            .map((source) => source.adapter ?? publisherIdentity(source.publisher).publisher),
        );
        const syndicated =
          clustering === null
            ? false
            : unique.some((source, index) =>
                unique.slice(index + 1).some((other) => syndicationVerdict(source, other, clustering.threshold).syndicated),
              );
        const unknownPublishers = [
          ...new Set(unique.filter((source) => publisherIdentity(source.publisher).source === "unknown").map((source) => source.publisher)),
        ];
        const independent = primary.size >= 2 && !syndicated;
        if (run.snapshot.report.corroboration === "two_independent" && !independent) {
          rejected++;
          continue;
        }
        // A material change inside one release identity is a *new* story even at
        // the same URL and title, so what the claims actually say is part of the
        // key rather than only the identity they carry.
        const dedupKey = routineHash({
          release: normalized(candidate.releaseIdentity),
          kind: candidate.eventKind,
          material: materialChangeFingerprint(candidate.claims, releases),
        });
        if (retained.has(dedupKey)) {
          duplicates++;
          suppressions.push({
            releaseIdentity: candidate.releaseIdentity,
            reason: `already reported within the ${run.snapshot.report.dedupWindowDays}-day dedup window`,
          });
          continue;
        }
        if (seen.has(dedupKey)) {
          duplicates++;
          suppressions.push({
            releaseIdentity: candidate.releaseIdentity,
            reason: `the same ${releases ? "release" : "story"} and the same material appeared twice in this selection`,
          });
          continue;
        }
        seen.add(dedupKey);
        const caveats = independent ? [] : ["Single-source or non-independent coverage"];
        if (unknownPublishers.length > 0)
          caveats.push(`Publisher independence is not established for ${unknownPublishers.join(", ")}: not in the curated registry`);
        if (clustering === null)
          caveats.push(
            `Near-duplicate clustering was unavailable, so only identical ${releases ? "release identities" : "story identities"} were deduplicated`,
          );
        const reported = [
          ...new Set(unique.flatMap((source) => (source.adapter === undefined ? [] : [source.adapter.slice("plugin:".length)]))),
        ];
        if (reported.length > 0)
          caveats.push(`Text from ${reported.join(", ")} is as the plugin reported it: Tavi did not fetch those pages`);
        stories.push({
          ...candidate,
          claims: run.snapshot.report.style === "summary" ? candidate.claims.slice(0, 1) : candidate.claims,
          title: releases ? candidate.releaseIdentity : candidate.title,
          storyId: `story-${dedupKey.slice(0, 32)}`,
          dedupKey,
          sourceIds,
          independentlyCorroborated: independent,
          caveats,
        });
      }
      return stories.slice(0, run.snapshot.report.maxItems);
    };
    let hours = window.hours;
    let stories = select(hours);
    let widened = false;
    if (stories.length === 0 && run.snapshot.report.onEmpty === "widen_lookback" && run.snapshot.report.widenLookbackMaxHours > hours) {
      hours = run.snapshot.report.widenLookbackMaxHours;
      widened = true;
      rejected = 0;
      duplicates = 0;
      stories = select(hours);
    }
    if (rejected > 0) gaps.push(t("reports.news.gap.unsupported", { count: rejected, n: String(rejected) }));
    if (gaps.length > 0 && run.snapshot.report.partialSources === "fail")
      throw new TaviError("INVALID_INPUT", "Source coverage policy requires complete eligible evidence");
    const used = new Set(stories.flatMap((story) => story.sourceIds));
    return {
      version: 1,
      runId,
      routineId: run.routineId,
      revision: run.revision,
      generatedAt: now,
      mode: run.mode,
      title: routineReportTitle(run.snapshot, name, t),
      stories,
      suppressions,
      sources: fetched
        .filter((source) => used.has(source.sourceId))
        .map((source) => ({
          ...source,
          excerpt: stories
            .flatMap((story) => story.claims)
            .filter((claim) => claim.sourceId === source.sourceId)
            .map((claim) => claim.text)
            .join("\n"),
        })),
      coverage: {
        from: new Date(Date.parse(now) - hours * 3_600_000).toISOString(),
        to: now,
        searched: coverage?.searches ?? 0,
        fetched: fetched.length,
        failed: coverage?.failures ?? 0,
        widened,
        gaps,
      },
      quiet: stories.length === 0,
      suppressed: stories.length === 0 && run.snapshot.report.onEmpty === "suppress_delivery",
      degraded: gaps.length > 0,
      rejected,
      duplicates,
    };
  }
}

/** Only typed, validated news data enters this template. No model HTML or remote assets. */
/**
 * The report policy the renderer honors.
 *
 * The renderer reads all three fields rather than hardcoding them, but today the
 * only production caller passes what the revision schema pins: `sourceLinks` is
 * `z.literal(true)`, `unsupportedRoutinePolicy` refuses any language but a supported one (`SUPPORTED_LOCALES`),
 * and `templateVersion` is the host's own (`news-v1`, `llm-releases-v1`), or a plugin's template the
 * revision carries (`template`), which shares its layout and gives its words; one
 * with no template is refused rather than rendered as news. They are read but
 * invariant, so a direct caller (and the renderer test) can still exercise the
 * other values without the product being able to produce them.
 *
 * The page's own words (run, coverage, the quiet sentence), its dates and its `lang` are in `language` (English when
 * it is not a supported one); what the report holds (titles, claims, caveats, gaps) is shown as it was written. In English the dates stay as stored (ISO), as they
 * always have; in another language they read as that language's dates in `timezone` (UTC when absent).
 */
export interface RoutineRenderPolicy {
  readonly language: string;
  readonly sourceLinks: boolean;
  readonly templateVersion: string;
  readonly template?: Pick<RoutineTemplate, "id" | "quiet" | "sourcesWord">;
  readonly timezone?: string;
}

/** `iso` as `t`'s language reads a date and time in `timezone`: "23 ноември 2026 г., 07:00". */
function reportDate(iso: string, t: CoreT, timezone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const local = localDateTime(at, timezone);
  const time = `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
  const day = t("date.withYear", { date: `${local.day} ${t(`date.month.${local.month}` as CoreKey)}`, year: String(local.year) });
  return `${t("date.dayTime", { date: day, time })}${timezone === "UTC" ? " UTC" : ""}`;
}

export function renderRoutineNewsHtml(
  report: RoutineNewsReport,
  policy: RoutineRenderPolicy = { language: "en", sourceLinks: true, templateVersion: "news-v1" },
): string {
  const template = policy.template;
  if (isBuiltinRoutineTemplate(policy.templateVersion) ? template !== undefined : template?.id !== policy.templateVersion)
    throw new TaviError("UNSUPPORTED", `Report template ${policy.templateVersion} is not available`);
  const locale = isLocale(policy.language) ? policy.language : DEFAULT_LOCALE;
  const t = coreIn(locale);
  const when = (iso: string): string => (locale === DEFAULT_LOCALE ? iso : reportDate(iso, t, policy.timezone ?? "UTC"));
  const source = (id: string) => {
    const found = report.sources.find((item) => item.sourceId === id);
    if (found === undefined) throw new TaviError("INVALID_INPUT", `the report cites ${id}, a source it does not hold`);
    return found;
  };
  const citation = (claim: { sourceId: string }) =>
    policy.sourceLinks ? ` <a href="${escape(source(claim.sourceId).canonicalUrl)}">${escape(source(claim.sourceId).publisher)}</a>` : "";
  const run = report.mode === "preview" ? t("reports.news.preview") : t("reports.news.revision", { revision: String(report.revision) });
  // English has always printed the count as it is ("1234"); another language formats it ("1 234") and picks its plural.
  const count = locale === DEFAULT_LOCALE ? String(report.coverage.fetched) : report.coverage.fetched;
  const fetched =
    template?.sourcesWord === undefined
      ? t("reports.news.fetched", { count })
      : t("reports.news.fetchedAs", { count, word: template.sourcesWord });
  const coverage = `${t("reports.news.coverage", { from: when(report.coverage.from), to: when(report.coverage.to) })} ${fetched}${report.coverage.widened ? ` ${t("reports.news.widened")}` : ""}`;
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escape(report.title)}</title><style>${printThemeCss("pt")}@page{size:A4;margin:18mm}body{font:var(--print-text-base)/1.5 var(--print-font);color:var(--print-ink)}h1{font-size:var(--print-text-2xl);margin-bottom:4mm}h2{font-size:var(--print-text-lg);margin-bottom:2mm}article{break-inside:avoid;margin:7mm 0}a{color:var(--print-link);overflow-wrap:anywhere}small{color:var(--print-ink-soft)}.caveat{font-size:var(--print-text-xs);color:var(--print-caution)}footer{margin-top:8mm;border-top:1px solid var(--print-rule);padding-top:3mm}</style></head><body><h1>${escape(report.title)}</h1><small>${escape(when(report.generatedAt))} · ${escape(run)}</small>${report.quiet ? `<p>${escape(template?.quiet.report ?? t("reports.news.quiet"))}</p>` : report.stories.map((story) => `<article><h2>${escape(story.title)}</h2>${story.claims.map((claim) => `<p>${escape(claim.text)}${citation(claim)}</p>`).join("")}${story.caveats.map((item) => `<p class="caveat">${escape(item)}</p>`).join("")}</article>`).join("")}<footer><small>${escape(coverage)}</small>${report.coverage.gaps.map((gap) => `<p class="caveat">${escape(gap)}</p>`).join("")}</footer></body></html>`;
}

/**
 * A model's JSON answer — the researcher's selection, or an evaluation's. Models asked for "only JSON" still often
 * wrap it in a Markdown fence (```` ```json ```` … ```` ``` ````); one fence around the whole answer is removed, and
 * nothing else is forgiven: words around it still fail to parse, and the shape is validated by its caller.
 */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```$/i.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed);
}
