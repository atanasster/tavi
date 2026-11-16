import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { clip, csvList, definedOnly, errorMessage, nowTimestamp } from "@tavi/contracts/util";
import {
  ECB_RATES_URL,
  J1_SOURCES,
  J2_SOURCES,
  JOB_APPLICATION_STATES,
  JobProfileInputSchema,
  JobQuerySchema,
  FillFactsSchema,
  IngestItemSchema,
  ObservedFieldSchema,
  PersonAnswerSchema,
  fillPlan,
  tailorCheck,
  JobWatchInputSchema,
  SOURCE_PAUSE_MS,
  createSkillIndex,
  gapsAcross,
  matchPostings,
  normalizePosting,
  openJobsStore,
  parseEcbRates,
  postingIdOf,
  postingAnswersQuery,
  readIngestItems,
  type JobApplicationState,
  type JobHit,
  type JobPosting,
  type JobWatch,
  type JobQuery,
  type EuroRates,
  type JobSourceAdapter,
  type JobsStore,
  type SkillDictionary,
  type SourceCall,
  type SourceOutcome,
  type SourceRequest,
} from "@tavi/jobs-kit";
import {
  createBudgetLedger,
  delay,
  type BudgetLedger,
  type CallContext,
  type Fetched,
  type Fetcher as DomainFetcher,
  type HeartbeatSignalLike,
} from "@tavi/domain-kit";

import { readOnlyHost } from "./sites.js";

/**
 * The `jobs.finder` tools' work, apart from the plugin context so
 * it is tested with a fake network. The worker makes every request; each goes
 * through its source's budget and health, and is logged with the query's
 * keywords only.
 */

export type { CallContext, Fetched, HeartbeatSignalLike } from "@tavi/domain-kit";
export type Fetcher = DomainFetcher<SourceRequest>;

export interface EngineOptions {
  /** The store's file: `jobs.db` in the worker's home. */
  readonly storePath: string;
  readonly dictionary: SkillDictionary;
  readonly fetcher: Fetcher;
  readonly credential: (key: string) => Promise<string | null>;
  readonly config: Readonly<Record<string, unknown>>;
  readonly version: string;
  readonly now?: () => string;
  /** Waits out a source's rate; a test passes a clock's. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly sources?: readonly JobSourceAdapter[];
}

/** The longest a search waits for a source's per-second rate before it goes on without it. */
const RATE_WAIT_MAX_MS = 5_000;

/** The most postings a search answers with; the rest are stored. */
const SEARCH_REPLY_MAX = 20;
/** A posting's excerpt in a reply: the store keeps more. */
const REPLY_EXCERPT_CHARS = 600;
/** Pages one search reads of one source, whatever its `next` says. */
const PAGES_PER_SOURCE = 5;
/** Postings whose detail one search reads (Greenhouse's pay, SmartRecruiters' description). */
const DETAILS_PER_SEARCH = 5;
/** The longest one search runs; what is unread then is reported, not waited for. */
const SEARCH_DEADLINE_MS = 60_000;

/** Fields one `fill_plan` call takes. */
const FORM_FIELDS_MAX = 100;

/** Items one `ingest` call takes. */
const INGEST_ITEMS_MAX = 50;

/** Hits the heartbeat sees: those of the last day, at most 40 with the paused sources (its limit is 50 a source). */
const SIGNAL_WINDOW_MS = 24 * 3_600_000;
const SIGNALS_MAX = 40;

/** The `watch` tool's input: `create` takes the watch's fields; the rest name it by `watchId`. */
export interface WatchInput {
  readonly action: "create" | "update" | "pause" | "resume" | "remove";
  readonly watchId?: string | undefined;
  readonly name?: string | undefined;
  readonly query?: unknown;
  readonly criteria?: unknown;
  readonly cadence?: number | undefined;
  readonly minScore?: number | undefined;
  readonly digest?: { readonly at: string; readonly timezone: string; readonly deliverTo: string } | undefined;
}

/** A watch as a reply shows it: its criteria stay in the store. */
function watchSummaryOf(watch: JobWatch) {
  return {
    watchId: watch.watchId,
    name: watch.name,
    enabled: watch.enabled,
    cadence: watch.cadence,
    minScore: watch.minScore,
    nextRunAt: watch.nextRunAt,
    ...(watch.lastRunAt === undefined ? {} : { lastRunAt: watch.lastRunAt }),
    ...(watch.lastOutcome === undefined ? {} : { lastOutcome: watch.lastOutcome }),
    query: watch.query,
  };
}

/** The schedule a digest needs: the plugin cannot write schedules, so the agent makes this one, with its own approval. */
function digestScheduleOf(watch: JobWatch) {
  return {
    prompt: `Summarise new matches for watch "${watch.name}" (watchId ${watch.watchId}) from the last 24 hours with jobs.finder.digest.`,
    ...watch.digest,
    autoApproveTools: ["jobs.finder.digest", "jobs.finder.match", "jobs.finder.pipeline"],
  };
}

/** What `watch` answers: the watch as it now is (and a digest's schedule to create), or that it was removed. */
export interface WatchReply {
  readonly watch?: ReturnType<typeof watchSummaryOf>;
  readonly digestSchedule?: ReturnType<typeof digestScheduleOf>;
  readonly removed?: boolean;
  readonly watchId?: string;
}

/** Per source and board (`""` for a global source), a search's answers and how many of them had changed shape. */
type DriftTally = Map<string, Map<string, { readonly asked: number; readonly drifted: number }>>;

/**
 * Whether a search's answers say the source itself changed: over half
 * of a global source's answers, or of a per-board source's boards, when it
 * read two or more; one employer's board changing is that employer's.
 */
function sourceDrifted(runs: ReadonlyMap<string, { readonly asked: number; readonly drifted: number }>, perTenant: boolean): boolean {
  if (!perTenant) return [...runs.values()].some((counted) => counted.drifted * 2 > counted.asked);
  const boards = [...runs.values()];
  return boards.length >= 2 && boards.filter((counted) => counted.drifted * 2 > counted.asked).length * 2 > boards.length;
}

type SourceReport = { readonly source: string; readonly tenant?: string; readonly outcome: string; readonly postings: number };

export function createEngine(options: EngineOptions) {
  const now = options.now ?? nowTimestamp;
  const sleep = options.sleep ?? delay;
  const adapters = options.sources ?? [...J1_SOURCES, ...J2_SOURCES];
  /** The operator's contact, which USAJOBS requires as its User-Agent. */
  const contact =
    typeof options.config["usajobsEmail"] === "string" && options.config["usajobsEmail"].includes("@")
      ? options.config["usajobsEmail"]
      : undefined;
  /** `Tavi-jobs/<version> (+<contact>)`: the operator's contact, when they gave one, lets a source reach them. */
  const operatorContact =
    typeof options.config["contact"] === "string" && /^[\x21-\x7e]{3,200}$/.test(options.config["contact"])
      ? options.config["contact"]
      : undefined;
  const userAgent = `Tavi-jobs/${options.version}${operatorContact === undefined ? "" : ` (+${operatorContact})`}`;
  /** A request with Tavi's User-Agent, unless the source asks for its own (USAJOBS). */
  const send = (request: SourceRequest, signal: AbortSignal): Promise<Fetched> =>
    options.fetcher({ ...request, headers: { "User-Agent": userAgent, ...request.headers } }, signal);
  const byId = new Map(adapters.map((adapter) => [adapter.record.id, adapter]));
  const records = new Map(adapters.map((adapter) => [adapter.record.id, adapter.record]));
  const skills = createSkillIndex(options.dictionary);
  let opened: { readonly store: JobsStore; readonly budgets: BudgetLedger } | undefined;
  /** Closes with the engine: a sweep in flight stops at its next request, and the store is not opened again. */
  const stopping = new AbortController();
  /**
   * What the engine can fetch again, in the worker home's `cache/` (left
   * out of backups): each feed's cursor (NAV's), and the day's ECB rates. Lost,
   * a feed reads its last day again and the rates are fetched again.
   */
  const cacheFile = (name: string): string => join(dirname(options.storePath), "cache", name);
  const readCache = <T>(name: string): T | undefined => {
    try {
      return JSON.parse(readFileSync(cacheFile(name), "utf8")) as T;
    } catch {
      return undefined;
    }
  };
  const writeCache = (name: string, value: unknown): void => {
    const file = cacheFile(name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(value));
    renameSync(`${file}.tmp`, file);
  };
  let retainedDay: string | undefined;

  /**
   * `forget` is one-shot: the store is emptied once when the operator sets it,
   * and a marker beside the store (backed up with it) keeps later starts from
   * emptying it again until the setting goes back to false.
   */
  const forgottenMarker = join(dirname(options.storePath), "forgotten");
  const forgetOnce = (store: JobsStore): void => {
    if (options.config["forget"] !== true) {
      rmSync(forgottenMarker, { force: true });
      return;
    }
    if (existsSync(forgottenMarker)) return;
    store.forget();
    writeFileSync(forgottenMarker, `${now()}\n`);
  };

  /** The store, opened once; emptied first when the operator set `forget`, and kept within its terms once a day. */
  const open = () => {
    // Closed, it stays closed: a sweep still running finds no store rather than reopening one.
    if (stopping.signal.aborted) throw new Error("the jobs engine is closed");
    if (opened === undefined) {
      const store = openJobsStore(options.storePath, records);
      forgetOnce(store);
      opened = { store, budgets: createBudgetLedger(store.db) };
    }
    const day = now().slice(0, 10);
    if (retainedDay !== day) {
      opened.store.retain(now());
      retainedDay = day;
    }
    return opened;
  };

  /** The sources the operator turned on: the `sources` setting, else every documented one on by default. */
  const enabled = (): Set<string> => {
    const named = csvList(options.config["sources"]);
    return new Set(
      named.length > 0
        ? named.filter((id) => byId.has(id))
        : adapters.filter((adapter) => adapter.record.defaultOn).map((adapter) => adapter.record.id),
    );
  };

  /** A call for a source that needs no key (a posting's own answer). */
  const keylessCall = (): SourceCall => ({
    credential: () => undefined,
    userAgent,
    now: now(),
    ...(contact === undefined ? {} : { contact }),
  });

  const credentials = async (adapter: JobSourceAdapter): Promise<SourceCall["credential"]> => {
    const values = new Map<string, string>();
    for (const key of adapter.record.credential ?? []) {
      const value = await options.credential(key);
      if (value !== null && value !== "") values.set(key, value);
    }
    return (key) => values.get(key);
  };

  /** One request through its source's health and budget; its outcome recorded, the request logged. */
  const request = async (
    adapter: JobSourceAdapter,
    call: SourceCall,
    req: SourceRequest,
    keywords: string,
    signal: AbortSignal,
    tally?: DriftTally,
  ): Promise<SourceOutcome | { readonly kind: "skipped"; readonly why: string }> => {
    const { store, budgets } = open();
    const health = store.health(adapter.record.id, now());
    if (health.disabledUntil !== undefined && Date.parse(health.disabledUntil) > Date.parse(now()))
      return { kind: "skipped", why: `paused until ${health.disabledUntil}` };
    let budget = budgets.take(adapter.record.id, adapter.record.budget, Date.parse(now()));
    // A source's per-second rate is waited out, briefly; its daily budget is not.
    for (
      let waits = 0;
      !budget.ok && budget.reason === "per-second" && budget.retryAfterMs <= RATE_WAIT_MAX_MS && waits < 3 && !signal.aborted;
      waits += 1
    ) {
      await sleep(budget.retryAfterMs, signal);
      if (signal.aborted) return { kind: "skipped", why: "the search ran out of time" };
      budget = budgets.take(adapter.record.id, adapter.record.budget, Date.parse(now()));
    }
    if (!budget.ok) return { kind: "skipped", why: budget.reason === "per-day" ? "its daily budget is spent" : "its rate limit" };
    const at = now();
    let fetched: Fetched;
    try {
      fetched = await send(req, signal);
    } catch (error) {
      // Tavi's own deadline or cancel is not the source failing.
      if (signal.aborted) return { kind: "skipped", why: "the search ran out of time" };
      store.recordOutcome(adapter.record.id, { ok: false, error: errorMessage(error) }, at);
      return { kind: "failed", status: 0 };
    }
    store.log({ source: adapter.record.id, host: new URL(req.url).host, at, status: fetched.status, bytes: fetched.bytes, keywords });
    const outcome = adapter.parse(
      { status: fetched.status, retryAfter: fetched.retryAfter, etag: fetched.etag ?? null, body: fetched.body },
      req,
      call,
    );
    if (outcome.kind === "ok") store.recordOutcome(adapter.record.id, { ok: true }, at);
    else if (outcome.kind === "rate-limited")
      store.recordOutcome(
        adapter.record.id,
        { ok: false, error: "rate limited", pauseUntil: new Date(Date.parse(at) + outcome.retryAfterMs).toISOString() },
        at,
      );
    // An unknown board is the person's typo, not the source failing.
    // Nor is a site's robots.txt saying no.
    else if (outcome.kind !== "not-found" && outcome.kind !== "disallowed")
      store.recordOutcome(
        adapter.record.id,
        {
          ok: false,
          drift: outcome.kind === "drift",
          error: outcome.kind === "drift" ? outcome.detail : outcome.kind === "failed" ? `HTTP ${String(outcome.status)}` : outcome.kind,
        },
        at,
      );
    if (tally !== undefined) {
      const runs = tally.get(adapter.record.id) ?? new Map<string, { asked: number; drifted: number }>();
      const counted = runs.get(req.tenant ?? "") ?? { asked: 0, drifted: 0 };
      runs.set(req.tenant ?? "", { asked: counted.asked + 1, drifted: counted.drifted + (outcome.kind === "drift" ? 1 : 0) });
      tally.set(adapter.record.id, runs);
    }
    return outcome;
  };

  /** The posting kept under a URL, unless its source said it is gone. */
  const keptAt = (url: string): { posting: JobPosting; description: string } | undefined => {
    const { store } = open();
    const postingId = store.findByUrl(url);
    const kept = postingId === undefined ? undefined : store.get(postingId, now());
    return kept === undefined || kept.removed ? undefined : { posting: kept.posting, description: kept.description };
  };

  /** The day's ECB rates, fetched once a day with a search (match sends nothing, so it reads what a search kept). */
  const refreshRates = async (signal: AbortSignal): Promise<void> => {
    const kept = readCache<EuroRates & { readonly fetchedOn: string }>("ecb.json");
    if (kept?.fetchedOn === now().slice(0, 10) || signal.aborted) return;
    try {
      const fetched = await send({ url: ECB_RATES_URL, body: "text", purpose: "search" }, signal);
      open().store.log({
        source: "ecb",
        host: new URL(ECB_RATES_URL).host,
        at: now(),
        status: fetched.status,
        bytes: fetched.bytes,
        keywords: "",
      });
      const rates = fetched.status === 200 && typeof fetched.body === "string" ? parseEcbRates(fetched.body) : undefined;
      if (rates !== undefined) writeCache("ecb.json", { ...rates, fetchedOn: now().slice(0, 10) });
    } catch {
      // Without today's rates, yesterday's stand; with none, another currency's pay stays unchecked.
    }
  };

  /** A posting as a reply shows it: no full description, an excerpt cut short. */
  const summary = (posting: JobPosting) => ({
    postingId: posting.postingId,
    title: posting.title,
    company: posting.company,
    places: posting.places
      .map((place) => [place.city, place.region, place.country].filter((part) => part !== undefined).join(", "))
      .filter((place) => place !== ""),
    workplace: posting.workplace,
    ...definedOnly({
      remoteRegions: posting.remoteRegions,
      salary: posting.salary,
      employmentType: posting.employmentType,
      seniority: posting.seniority,
      postedAt: posting.postedAt,
    }),
    url: posting.url,
    ...(posting.applyUrl === undefined ? {} : { applyUrl: posting.applyUrl }),
    excerpt: clip(posting.excerpt, REPLY_EXCERPT_CHARS),
    ...(posting.flags.length === 0 ? {} : { flags: posting.flags }),
    ...(posting.aiPolicy === undefined ? {} : { aiPolicy: posting.aiPolicy }),
    sponsorship: posting.sponsorship,
    attribution: posting.attribution,
  });

  /** A search: what it stored, each job once, newest first; and what each source said. */
  const searchStored = async (
    input: unknown,
    signal: AbortSignal,
    call: CallContext,
  ): Promise<{ readonly stored: JobPosting[]; readonly reports: SourceReport[] }> => {
    const parsed = JobQuerySchema.parse(input);
    const query: JobQuery =
      parsed.countries.length > 0
        ? parsed
        : {
            ...parsed,
            countries: csvList(options.config["countries"])
              .map((country) => country.toUpperCase())
              .filter((country) => /^[A-Z]{2}$/.test(country))
              .slice(0, 8),
          };
    const on = enabled();
    const wanted = (adapter: JobSourceAdapter) =>
      on.has(adapter.record.id) && (query.sources === undefined || query.sources.includes(adapter.record.id));
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(SEARCH_DEADLINE_MS)]);
    const keywords = query.keywords.join(" ");
    const reports: SourceReport[] = [];
    const tally: DriftTally = new Map();
    const removed = new Set<string>();
    const found: { posting: JobPosting; description: string }[] = [];
    const runs: { readonly adapter: JobSourceAdapter; readonly tenant?: string }[] = [
      ...(query.employers ?? [])
        .map((employer) => ({ adapter: byId.get(employer.source), tenant: employer.tenant }))
        .filter(
          (run): run is { adapter: JobSourceAdapter; tenant: string } =>
            run.adapter !== undefined && run.adapter.record.tenancy === "per-tenant",
        ),
      ...adapters.filter((adapter) => adapter.record.tenancy === "global").map((adapter) => ({ adapter })),
    ];
    for (const run of runs) {
      const { adapter, tenant } = run;
      const report = (outcome: string, postings = 0) =>
        reports.push({ source: adapter.record.id, ...(tenant === undefined ? {} : { tenant }), outcome, postings });
      if (!wanted(adapter)) {
        if (tenant !== undefined || query.sources?.includes(adapter.record.id) === true) report("off: turned off in the plugin's settings");
        continue;
      }
      // Terms that allow only searches a person makes: never in a run nobody attends.
      if (adapter.record.terms.userTriggeredOnly && call.unattended) {
        report("skipped: its terms allow only searches a person makes");
        continue;
      }
      // A per-tenant source keeps a cursor for each board (Workday's sitemap).
      const cursorKey = tenant === undefined ? adapter.record.id : `${adapter.record.id}:${tenant}`;
      const cursor = (readCache<Record<string, string>>("cursors.json") ?? {})[cursorKey];
      const sourceCall: SourceCall = {
        credential: await credentials(adapter),
        userAgent,
        now: now(),
        ...(contact === undefined ? {} : { contact }),
        ...(cursor === undefined ? {} : { cursor }),
      };
      const pending = [...adapter.search(query, sourceCall, tenant)];
      if (pending.length === 0) {
        if (tenant !== undefined || query.sources?.includes(adapter.record.id) === true)
          report(
            adapter.record.credential === undefined
              ? "nothing to ask: no board or country it covers"
              : "not set up: its key is missing, or no country it covers",
          );
        continue;
      }
      let pages = 0;
      let count = 0;
      let last = "ok";
      const pagesMax = adapter.requestsPerSearch ?? PAGES_PER_SOURCE * Math.max(1, query.countries.length);
      while (pending.length > 0 && pages < pagesMax && !deadline.aborted) {
        const req = pending.shift() as SourceRequest;
        // A job page already kept is read from the store, not fetched again (Workday's).
        const kept = req.purpose === "detail" ? keptAt(req.url) : undefined;
        if (kept !== undefined) {
          if (postingAnswersQuery(kept.posting, kept.description, query, sourceCall.now)) {
            found.push(kept);
            count += 1;
          }
          continue;
        }
        pages += 1;
        const outcome = await request(adapter, sourceCall, req, keywords, deadline, tally);
        // A job page gone since its list was read (Workday's sitemap) is passed over; the rest are still read.
        if (outcome.kind === "not-found" && req.purpose === "detail") continue;
        if (outcome.kind !== "ok") {
          last =
            outcome.kind === "skipped" || outcome.kind === "disallowed"
              ? `skipped: ${outcome.why}`
              : outcome.kind === "not-found"
                ? "not found: check the board's name"
                : outcome.kind === "drift"
                  ? "changed: its answer is not the shape Tavi reads"
                  : outcome.kind;
          break;
        }
        // A posting the source says is gone is hidden at once (NAV's terms; JobTech's removed ads), and stays gone this search.
        for (const ref of outcome.removed ?? []) removed.add(postingIdOf(adapter.record.id, ref));
        if (outcome.cursor !== undefined)
          writeCache("cursors.json", { ...(readCache<Record<string, string>>("cursors.json") ?? {}), [cursorKey]: outcome.cursor });
        for (const raw of outcome.postings) {
          let normalized;
          try {
            normalized = normalizePosting(raw, sourceCall.now, { skills });
          } catch {
            continue;
          }
          if (!postingAnswersQuery(normalized.posting, normalized.description, query, sourceCall.now)) continue;
          found.push(normalized);
          count += 1;
        }
        if (outcome.next !== undefined) pending.push(outcome.next);
        pending.push(...(outcome.more ?? []));
      }
      report(deadline.aborted && pending.length > 0 ? "cut short: the search ran out of time" : last, count);
    }
    // Newest first; a posting with no date last.
    found.sort((a, b) => (b.posting.postedAt ?? "").localeCompare(a.posting.postedAt ?? ""));
    // Pay or a description only a posting's own answer has, for the first few.
    let details = 0;
    for (const [index, entry] of found.entries()) {
      if (details >= DETAILS_PER_SEARCH || index >= SEARCH_REPLY_MAX || deadline.aborted) break;
      const adapter = byId.get(entry.posting.source);
      const needs = adapter?.detail !== undefined && (entry.posting.salary === undefined || entry.description === "");
      if (adapter === undefined || !needs) continue;
      // The source's own call: a keyed detail (NAV's) needs the key its search used.
      const detailCall: SourceCall = { ...keylessCall(), credential: await credentials(adapter) };
      const req = adapter.detail?.(entry.posting.sourceRef, detailCall);
      if (req === undefined) continue;
      details += 1;
      const outcome = await request(adapter, detailCall, req, keywords, deadline, tally);
      for (const ref of outcome.kind === "ok" ? (outcome.removed ?? []) : []) removed.add(postingIdOf(adapter.record.id, ref));
      const raw = outcome.kind === "ok" ? outcome.postings[0] : undefined;
      // Only an answer about this posting replaces it.
      if (raw === undefined || raw.sourceRef !== entry.posting.sourceRef) continue;
      try {
        found[index] = normalizePosting(raw, now(), { skills });
      } catch {
        // The list's reading stands.
      }
    }
    // Each posting once, and each job once: the first of a cluster stands for the rest. A removed one is not kept again.
    const unique = [
      ...new Map(found.filter((entry) => !removed.has(entry.posting.postingId)).map((entry) => [entry.posting.postingId, entry])).values(),
    ];
    if (removed.size > 0) open().store.remove([...removed], now());
    // Rates matter only to pay a source states; a search that found none fetches none.
    if (unique.some((entry) => entry.posting.salary?.origin === "stated")) await refreshRates(deadline);
    const stored = keepOncePerJob(unique);
    // Over half a source's answers in one search changed shape: it is paused for a day.
    for (const [source, runs] of tally)
      if (sourceDrifted(runs, records.get(source)?.tenancy === "per-tenant"))
        open().store.pause(source, new Date(Date.parse(now()) + SOURCE_PAUSE_MS).toISOString(), now());
    return { stored, reports };
  };

  /** Stores postings (each once already), answering each job once: the first of a cluster stands for the rest. */
  const keepOncePerJob = (postings: readonly { readonly posting: JobPosting; readonly description: string }[]): JobPosting[] => {
    if (postings.length === 0) return [];
    const clusters = new Set<string>();
    return open()
      .store.upsert(postings, now())
      .filter((posting) => !clusters.has(posting.clusterId) && clusters.add(posting.clusterId) !== undefined);
  };

  /** Fits, scored, for kept postings against a profile; the ECB rates a search last kept convert pay. */
  const matchKept = (postingIds: readonly string[], profile: unknown) => {
    const criteria = JobProfileInputSchema.parse(profile);
    const kept = open().store.many(postingIds.slice(0, 200), now());
    const rates = readCache<EuroRates>("ecb.json");
    const results = matchPostings(
      kept.map(({ posting, description }) => ({ posting, text: description })),
      criteria,
      { now: now(), skills, ...(rates === undefined ? {} : { rates }) },
    );
    return { kept, results };
  };

  /** One watch's sweep: its query as a run nobody attends, matched against its criteria; new fits at its score are hits. */
  const sweepOne = async (watch: JobWatch, signal: AbortSignal): Promise<void> => {
    const { store } = open();
    const started = now();
    let outcome: string;
    try {
      const { stored, reports } = await searchStored(watch.query, signal, { unattended: true });
      const { kept, results } = matchKept(
        stored.map((posting) => posting.postingId),
        watch.criteria,
      );
      const clusters = new Map(kept.map(({ posting }) => [posting.postingId, posting.clusterId]));
      const fits = results.filter((result) => result.outcome === "fits" && result.score >= watch.minScore);
      const added = store.addHits(
        watch.watchId,
        fits.map((result) => ({
          clusterId: clusters.get(result.postingId) ?? result.postingId,
          postingId: result.postingId,
          score: result.score,
        })),
        now(),
      );
      const trouble = reports
        .filter((report) => report.outcome !== "ok" && !report.outcome.startsWith("off:"))
        .map((report) => report.source);
      outcome = `${String(added.length)} new of ${String(fits.length)} fitting in ${String(stored.length)}${trouble.length === 0 ? "" : `; not read: ${[...new Set(trouble)].join(", ")}`}`;
    } catch (error) {
      outcome = `failed: ${errorMessage(error)}`;
    }
    // The next sweep counts from this one's start: an hour at the least (the cadence's floor).
    if (stopping.signal.aborted) return;
    store.sweptWatch(watch.watchId, outcome, now(), new Date(Date.parse(started) + watch.cadence * 3_600_000).toISOString());
  };

  let sweeping: Promise<void> | undefined;
  let sweepError: { readonly at: string; readonly error: string } | undefined;
  /** Every due watch, one at a time; one run at once, however often it is asked. */
  const sweepDue = async (): Promise<void> => {
    for (const watch of open().store.dueWatches(now())) {
      if (stopping.signal.aborted) break;
      await sweepOne(watch, stopping.signal);
    }
  };
  const sweep = (): Promise<void> => {
    // Cleared once settled: `finally` runs after the assignment, even for a run with nothing due.
    sweeping ??= sweepDue().finally(() => {
      sweeping = undefined;
    });
    return sweeping;
  };

  const hitSummary = (hit: JobHit, posting: JobPosting | undefined) => ({
    ...(posting === undefined ? { postingId: hit.postingId } : summary(posting)),
    score: hit.score,
    firstSeen: hit.firstSeen,
  });

  return {
    async search(input: unknown, signal: AbortSignal, call: CallContext) {
      const { stored, reports } = await searchStored(input, signal, call);
      const shown = stored.slice(0, SEARCH_REPLY_MAX).map(summary);
      const notices = [
        ...new Set(
          stored
            .slice(0, SEARCH_REPLY_MAX)
            .flatMap((posting) => [posting.attribution, ...(records.get(posting.source)?.terms.displayRules ?? [])]),
        ),
      ];
      return {
        postings: shown,
        found: stored.length,
        sources: reports,
        ...(notices.length === 0 ? {} : { attribution: notices }),
        // The postings shown, kept with the task so a long search still answers from them.
        ...(shown.length === 0
          ? {}
          : {
              taviFindings: [
                {
                  kind: "job",
                  records: shown.map((posting) => ({
                    postingId: posting.postingId,
                    title: posting.title,
                    company: posting.company,
                    places: posting.places,
                    workplace: posting.workplace,
                    url: posting.url,
                    ...(posting.salary === undefined ? {} : { salary: posting.salary }),
                  })),
                },
              ],
            }),
      };
    },

    async get(input: { readonly postingId?: string; readonly url?: string }, signal: AbortSignal) {
      const { store } = open();
      const read = (postingId: string) => {
        const kept = store.get(postingId, now());
        if (kept === undefined) throw new Error(`no posting ${postingId}: find it with search first`);
        return {
          posting: { ...summary(kept.posting), excerpt: kept.posting.excerpt },
          description: kept.description,
          firstSeen: kept.firstSeen,
          lastSeen: kept.lastSeen,
          ...(kept.removed ? { removed: true } : {}),
        };
      };
      if (input.postingId !== undefined) return read(input.postingId);
      if (input.url === undefined) throw new Error("get takes a postingId or a url");
      const known = store.findByUrl(input.url);
      if (known !== undefined) return read(known);
      // A posting's own page on a source that reads one posting (Greenhouse with its pay, SmartRecruiters, NAV): read it from its API.
      const url = input.url;
      const found = adapters
        .filter((each) => enabled().has(each.record.id))
        .flatMap((each) => {
          const ref = each.refFromUrl?.(url);
          return ref === undefined ? [] : [{ adapter: each, ref }];
        })[0];
      if (found === undefined) throw new Error("that URL is not a posting Tavi has found: search for it first");
      const { adapter } = found;
      const call: SourceCall = { ...keylessCall(), credential: await credentials(adapter) };
      const req = adapter.detail?.(found.ref, call);
      if (req === undefined) throw new Error("that URL is not a posting Tavi can read");
      const outcome = await request(adapter, call, req, "", signal);
      const raw = outcome.kind === "ok" ? outcome.postings[0] : undefined;
      if (raw === undefined) throw new Error(`the posting could not be read (${outcome.kind === "skipped" ? outcome.why : outcome.kind})`);
      const [stored] = store.upsert([normalizePosting(raw, now(), { skills })], now());
      return read(stored?.postingId ?? "");
    },

    /** Kept postings, or a watch's hits, against a profile. */
    match(input: { readonly postingIds?: readonly string[]; readonly watchId?: string; readonly profile: unknown }) {
      const { store } = open();
      if (input.watchId !== undefined && store.watch(input.watchId) === undefined) throw new Error(`no watch ${input.watchId}`);
      const postingIds =
        input.watchId === undefined ? (input.postingIds ?? []) : store.hitsSince(input.watchId, "").map((hit) => hit.postingId);
      const { kept, results } = matchKept(postingIds, input.profile);
      const titles = new Map(kept.map(({ posting }) => [posting.postingId, { title: posting.title, company: posting.company }]));
      return {
        results: results.map((result) => ({ ...result, ...titles.get(result.postingId) })),
        counts: {
          fits: results.filter((result) => result.outcome === "fits").length,
          maybe: results.filter((result) => result.outcome === "maybe").length,
          excluded: results.filter((result) => result.outcome === "excluded").length,
        },
        gaps: gapsAcross(results.filter((result) => result.outcome !== "excluded")).slice(0, 10),
        ...(kept.length < Math.min(postingIds.length, 200) ? { missing: Math.min(postingIds.length, 200) - kept.length } : {}),
      };
    },

    pipeline(input: { readonly states?: readonly JobApplicationState[] }) {
      const { store } = open();
      const applications = store.applications(input.states);
      const postings = new Map(
        store
          .many(
            applications.map((application) => application.postingId),
            now(),
          )
          .map(({ posting }) => [posting.postingId, posting]),
      );
      return {
        counts: store.counts(),
        applications: applications.slice(0, 100).map((application) => {
          const posting = postings.get(application.postingId);
          return { ...application, ...(posting === undefined ? {} : { title: posting.title, company: posting.company, url: posting.url }) };
        }),
      };
    },

    track(input: { readonly postingId: string; readonly state: JobApplicationState; readonly note?: string }) {
      return open().store.track({ ...input, actor: "agent" }, now());
    },

    sources() {
      const { store, budgets } = open();
      const on = enabled();
      const at = now();
      return {
        sources: adapters.map((adapter) => ({
          id: adapter.record.id,
          name: adapter.record.name,
          kind: adapter.record.kind,
          on: on.has(adapter.record.id),
          standing: adapter.record.standing,
          countries: adapter.record.countries,
          terms: {
            url: adapter.record.terms.url,
            reviewedAt: adapter.record.terms.reviewedAt,
            licence: adapter.record.terms.licence,
            cache: adapter.record.terms.cache,
            attribution: adapter.record.terms.attribution,
            displayRules: adapter.record.terms.displayRules,
            userTriggeredOnly: adapter.record.terms.userTriggeredOnly,
          },
          budget: {
            ...adapter.record.budget,
            usedToday: budgets.peek(adapter.record.id)?.day === at.slice(0, 10) ? (budgets.peek(adapter.record.id)?.usedToday ?? 0) : 0,
          },
          health: store.health(adapter.record.id, at),
          ...(adapter.record.credential === undefined ? {} : { needs: adapter.record.credential }),
        })),
        recentRequests: store.recentFetches(20),
        watches: store.watches().map(watchSummaryOf),
        // The skills dictionary's sources and the notices they ask for (ESCO, O*NET).
        skills: { version: options.dictionary.version, attribution: options.dictionary.attribution },
        ...(sweepError === undefined ? {} : { sweepError }),
        states: JOB_APPLICATION_STATES,
      };
    },

    /**
     * A watch the person approved (`watch`): create one, change it, pause,
     * resume or remove it. A digest it asks for is a schedule the agent makes.
     */
    watch(input: WatchInput): WatchReply {
      const { store } = open();
      if (input.action === "create") {
        const watch = store.createWatch(
          JobWatchInputSchema.parse({
            name: input.name,
            query: input.query,
            criteria: input.criteria,
            cadence: input.cadence,
            minScore: input.minScore,
            digest: input.digest,
          }),
          now(),
        );
        return { watch: watchSummaryOf(watch), ...(watch.digest === undefined ? {} : { digestSchedule: digestScheduleOf(watch) }) };
      }
      if (input.watchId === undefined) throw new Error(`${input.action} needs the watch's watchId`);
      const known = store.watch(input.watchId);
      if (known === undefined) throw new Error(`no watch ${input.watchId}`);
      if (input.action === "remove") return { removed: store.removeWatch(input.watchId), watchId: input.watchId };
      if (input.action === "pause" || input.action === "resume")
        return { watch: watchSummaryOf(store.updateWatch(input.watchId, { enabled: input.action === "resume" }, now())) };
      const changed = JobWatchInputSchema.parse({
        name: input.name ?? known.name,
        query: input.query ?? known.query,
        criteria: input.criteria ?? known.criteria,
        cadence: input.cadence ?? known.cadence,
        minScore: input.minScore ?? known.minScore,
        digest: input.digest ?? known.digest,
      });
      const watch = store.updateWatch(input.watchId, { input: changed }, now());
      return { watch: watchSummaryOf(watch), ...(input.digest === undefined ? {} : { digestSchedule: digestScheduleOf(watch) }) };
    },

    /** A watch's hits first seen after `since` (`digest`): it reads, and writes nothing. */
    digest(input: { readonly watchId: string; readonly since: string }) {
      const { store } = open();
      const watch = store.watch(input.watchId);
      if (watch === undefined) throw new Error(`no watch ${input.watchId}`);
      const since = new Date(input.since);
      if (Number.isNaN(since.getTime())) throw new Error("since is an ISO date and time");
      const hits = store.hitsSince(input.watchId, since.toISOString());
      const postings = new Map(
        store
          .many(
            hits.map((hit) => hit.postingId),
            now(),
          )
          .map(({ posting }) => [posting.postingId, posting]),
      );
      return {
        watch: { watchId: watch.watchId, name: watch.name, lastRunAt: watch.lastRunAt, lastOutcome: watch.lastOutcome },
        since: since.toISOString(),
        count: hits.length,
        hits: hits.slice(0, SEARCH_REPLY_MAX).map((hit) => hitSummary(hit, postings.get(hit.postingId))),
      };
    },

    /**
     * Postings the agent gathered and the person approved keeping (`ingest`): a page's JobPosting, an
     * extracted record, an alert email's links, or a career page's ATS board. Stored as `agent:<host>`, deduplicated
     * and flagged like any source's; nothing is fetched.
     */
    ingest(input: { readonly items: unknown; readonly personSaved?: boolean }) {
      const items = IngestItemSchema.array().min(1).max(INGEST_ITEMS_MAX).parse(input.items);
      const read = readIngestItems(items, { readOnlyHost, personSaved: input.personSaved === true });
      let unreadable = 0;
      const normalized = read.postings.flatMap((raw) => {
        try {
          return [normalizePosting(raw, now(), { skills })];
        } catch {
          unreadable += 1;
          return [];
        }
      });
      // Each posting once, and each job once, as a search keeps them.
      const stored = keepOncePerJob([...new Map(normalized.map((entry) => [entry.posting.postingId, entry])).values()]);
      const kept = stored.slice(0, SEARCH_REPLY_MAX).map(summary);
      return {
        kept,
        count: stored.length,
        ...(read.employers.length === 0 ? {} : { employers: read.employers }),
        ...(read.refused.length === 0 ? {} : { refused: read.refused }),
        ...(unreadable === 0 ? {} : { unreadable }),
        // The postings kept, with the task, as a search's are.
        ...(kept.length === 0
          ? {}
          : {
              taviFindings: [
                {
                  kind: "job",
                  records: kept.map((posting) => ({
                    postingId: posting.postingId,
                    title: posting.title,
                    company: posting.company,
                    places: posting.places,
                    workplace: posting.workplace,
                    url: posting.url,
                  })),
                },
              ],
            }),
      };
    },

    /**
     * A value for each field of an application form the agent observed (`fill_plan`): from the person's
     * facts and answers, protected fields left for them, the rest unmapped. It sends and writes nothing.
     */
    fillPlan(input: { readonly fields: unknown; readonly facts?: unknown; readonly answers?: unknown; readonly postingId?: string }) {
      const fields = ObservedFieldSchema.array().max(FORM_FIELDS_MAX).parse(input.fields);
      const facts = FillFactsSchema.parse(input.facts ?? {});
      const answers = PersonAnswerSchema.array()
        .max(50)
        .parse(input.answers ?? []);
      const kept = input.postingId === undefined ? undefined : open().store.get(input.postingId, now());
      if (input.postingId !== undefined && kept === undefined) throw new Error(`no posting ${input.postingId}`);
      return fillPlan({ fields, facts, answers, ...(kept === undefined ? {} : { posting: kept.posting }) });
    },

    /** What to look at again in a draft before it is used (`tailor_check`). Advisory; it writes nothing. */
    tailorCheck(input: { readonly text: string; readonly postingId: string; readonly profileSkills?: readonly string[] }) {
      const kept = open().store.get(input.postingId, now());
      if (kept === undefined) throw new Error(`no posting ${input.postingId}`);
      return {
        warnings: tailorCheck({ text: input.text, postingText: kept.description, profileSkills: input.profileSkills ?? [], skills }),
      };
    },

    /** Runs the due watches; the heartbeat's collection starts it, and tests wait for it. */
    sweep,

    /**
     * What the heartbeat's Jobs source sees, model-free and quick:
     * the hits of the last day and the sources paused. It starts the due sweeps
     * and does not wait for them: their hits are in the next collection.
     */
    signals(): HeartbeatSignalLike[] {
      // Its own failures are kept for `sources`; a watch's are in its last outcome.
      void sweep().catch((error: unknown) => {
        sweepError = { at: now(), error: errorMessage(error) };
      });
      const { store } = open();
      const at = now();
      const since = new Date(Date.parse(at) - SIGNAL_WINDOW_MS).toISOString();
      const paused = adapters.flatMap((adapter): HeartbeatSignalLike[] => {
        const until = store.health(adapter.record.id, at).disabledUntil;
        if (until === undefined || Date.parse(until) <= Date.parse(at)) return [];
        return [
          {
            key: `paused:${adapter.record.id}`,
            hash: until,
            title: `Jobs source ${adapter.record.name} is paused until ${until.slice(0, 16).replace("T", " ")} UTC`.slice(0, 120),
            at,
            source: "Jobs",
          },
        ];
      });
      // The paused sources first: hits fill the rest, and only those told are marked delivered.
      const hits = store.deliverHits(since, at, Math.max(0, SIGNALS_MAX - paused.length));
      const watches = new Map(store.watches().map((watch) => [watch.watchId, watch.name]));
      const postings = new Map(
        store
          .many(
            hits.map((hit) => hit.postingId),
            at,
          )
          .map(({ posting }) => [posting.postingId, posting]),
      );
      const found = hits.flatMap((hit): HeartbeatSignalLike[] => {
        const posting = postings.get(hit.postingId);
        if (posting === undefined) return [];
        return [
          {
            key: `hit:${hit.watchId}:${hit.clusterId}`,
            hash: hit.score.toFixed(2),
            title: `New match: ${posting.title} at ${posting.company} (${hit.score.toFixed(2)})`.slice(0, 120),
            at: hit.firstSeen,
            source: "Jobs",
            data: { watch: watches.get(hit.watchId) ?? hit.watchId, postingId: posting.postingId, url: posting.url.slice(0, 500) },
          },
        ];
      });
      return [...paused, ...found].slice(0, SIGNALS_MAX);
    },

    close() {
      stopping.abort();
      opened?.store.close();
      opened = undefined;
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
