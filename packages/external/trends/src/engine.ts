import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { csvList, nowTimestamp } from "@tavi/contracts/util";
import {
  createBudgetLedger,
  delay,
  type BudgetLedger,
  type CallContext as DomainCallContext,
  type Fetched,
  type Fetcher as DomainFetcher,
  type HeartbeatSignalLike as DomainHeartbeatSignalLike,
} from "@tavi/domain-kit";
import {
  BUCKET_SECONDS,
  COUNTRY_EDITION,
  HEALTH_CLASSES,
  TR1_ADAPTERS,
  TR2_ADAPTERS,
  TRENDS_SOURCE_KINDS,
  TopicInputSchema,
  WIKIDATA,
  bucketStart,
  CLUSTER_ITEMS_MAX,
  checkBrief,
  clusterItems,
  judgeSweep,
  mergeSeries,
  nextState,
  openItemStore,
  openTrendsStore,
  personShapedTerm,
  refusesAiInput,
  robotsAllows,
  robotsContentSignal,
  testSource,
  wikidataEntity,
  wikidataSearch,
  type AccessToken,
  type AdapterTopic,
  type Bucket,
  type BriefBullet,
  type CountPoint,
  type HealthClass,
  type ItemStore,
  type Operation,
  type RawItem,
  type SourceCall,
  type SourceRequest,
  type SourceTest,
  type StoredItem,
  type Topic,
  type TopicInput,
  type TopicScope,
  type TrendsAdapter,
  type TrendsSourceKind,
  type TrendsSourceRecord,
  type TrendsStore,
  type WikidataExpansion,
  type Window,
} from "@tavi/trends-kit";

/**
 * The `trends.radar` tools' work, apart from the
 * plugin context so it is tested with a fake network. Every request goes
 * through its source's health and budget; counts land in `trends.db`, items
 * in `cache/items.db` for their source's cache window, and every test a sweep
 * runs is stored so `velocity` can show its arithmetic.
 */

export type { Fetched } from "@tavi/domain-kit";
export type Fetcher = DomainFetcher<SourceRequest>;

/** A source with no record, and why (`excluded.json`). */
export interface ExcludedSource {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

export interface EngineOptions {
  /** The worker's home: `trends.db` there, `cache/items.db` under it. */
  readonly home: string;
  readonly fetcher: Fetcher;
  readonly config: Readonly<Record<string, unknown>>;
  /** A credential setting's value (`ctx.secret`): a header key is the proxy's placeholder, a `rawSecrets` one itself. */
  readonly credential?: (key: string) => Promise<string | null>;
  readonly version: string;
  /** Per-country source order (`routing/<CC>.json`). */
  readonly routing?: Readonly<Record<string, readonly string[]>>;
  readonly excluded?: readonly ExcludedSource[];
  readonly now?: () => string;
  /** Waits out a source's rate; a test passes a clock's. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly adapters?: readonly TrendsAdapter[];
  /** The open-page lists (`lists/*.json`), beside the adapters. */
  readonly lists?: readonly TrendsAdapter[];
  /** The browser site profiles the manifest ships (`sites/*.json`). */
  readonly sites?: readonly SiteProfileLike[];
}

/** A browser site profile as `profile` shows it: the manifest's own file, validated by the owner. */
export interface SiteProfileLike {
  readonly id: string;
  readonly name: string;
  readonly countries: readonly string[];
  readonly hosts: readonly string[];
  readonly access: {
    readonly mode: string;
    readonly watchable: boolean;
    readonly reason: string;
    readonly termsUrl: string;
    readonly reviewedAt: string;
  };
  readonly budget: { readonly pagesPerTask: number; readonly pagesPerDay: number; readonly minIntervalMs: number };
  readonly signIn?: { readonly required: boolean; readonly handoffNote?: string };
  readonly extract?: { readonly jsonLdTypes: readonly string[]; readonly resultSchema?: Readonly<Record<string, unknown>> };
  readonly notes: string;
}

/** A row the agent read in the browser and relays. */
export interface IngestRow {
  readonly url: string;
  readonly title: string;
  readonly text?: string | undefined;
  readonly rank?: number | undefined;
  readonly metric?: number | undefined;
}

/** Rows one `ingest` takes. */
export const INGEST_ROWS_MAX = 200;
/** A relayed row is kept a day: it is the person's reading, for a brief, never a count. */
const RELAYED_TTL_MS = 86_400_000;

/** Who a call is for and whether anyone attends it. */
export interface CallContext extends DomainCallContext {
  readonly scope: TopicScope;
}

/** What a source's test reads: its metric and bucket, and whether its counts are a snapshot of now (a trending list). */
interface SeriesPlan {
  readonly metric: string;
  readonly bucket: Bucket;
  readonly snapshot: boolean;
}
/** Social and community count unique authors where the source names them. */
const SERIES_PLANS: Readonly<Record<string, SeriesPlan>> = {
  "hn-algolia": { metric: "stories", bucket: "hour", snapshot: false },
  "wikipedia-pageviews": { metric: "views", bucket: "day", snapshot: false },
  "gdelt-doc": { metric: "articles", bucket: "hour", snapshot: false },
  "gtrends-rss": { metric: "traffic", bucket: "hour", snapshot: true },
  "bluesky-trends": { metric: "trend-posts", bucket: "hour", snapshot: true },
  "bluesky-search": { metric: "authors", bucket: "hour", snapshot: false },
  "mastodon-trends": { metric: "accounts", bucket: "day", snapshot: false },
  arxiv: { metric: "papers", bucket: "day", snapshot: false },
  "rss-europe": { metric: "stories", bucket: "hour", snapshot: false },
  "rss-americas": { metric: "stories", bucket: "hour", snapshot: false },
  youtube: { metric: "channels", bucket: "hour", snapshot: false },
  "naver-datalab": { metric: "ratio", bucket: "day", snapshot: false },
  reddit: { metric: "authors", bucket: "hour", snapshot: false },
  threads: { metric: "authors", bucket: "hour", snapshot: false },
  // An open-page list: how many of its entries name the topic now.
  "baidu-hot": { metric: "entries", bucket: "hour", snapshot: true },
  "hatena-hot": { metric: "entries", bucket: "hour", snapshot: true },
  "ptt-board": { metric: "entries", bucket: "hour", snapshot: true },
  "pantip-hot": { metric: "entries", bucket: "hour", snapshot: true },
  "daum-top": { metric: "entries", bucket: "hour", snapshot: true },
};

/** Redirects an open page's read follows, each on the source's own hosts. */
const REDIRECTS_MAX = 3;
/** A host's robots.txt is read again after a day. */
const ROBOTS_TTL_MS = 86_400_000;

/** Wikidata's names are kept 30 days (CC0). */
const WIKIDATA_TTL_MS = 30 * 86_400_000;

/** The name a brief may attribute a source's figures to ("per GDELT"); a source not here goes by its record's name. */
const BRIEF_NAMES: Readonly<Record<string, string>> = {
  "hn-algolia": "Hacker News",
  "wikipedia-pageviews": "Wikipedia",
  "gdelt-doc": "GDELT",
  "gtrends-rss": "Google Trends",
  "bluesky-trends": "Bluesky",
  "bluesky-search": "Bluesky",
  "mastodon-trends": "Mastodon",
  arxiv: "arXiv",
  youtube: "YouTube",
  "naver-datalab": "Naver DataLab",
  reddit: "Reddit",
  threads: "Threads",
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** The furthest back a series is read and tested: eight weeks and a day of days, for a seasonal baseline; 35 days of hours, as long as hours are kept. */
const REACH_MS: Readonly<Record<Bucket, number>> = { day: 57 * DAY_MS, hour: 35 * DAY_MS };
/** A source read before is read again from this long before its last read, so a late bucket is filled. */
const REREAD_MS: Readonly<Record<Bucket, number>> = { day: 3 * DAY_MS, hour: 2 * DAY_MS };
/** The longest a sweep runs; what is unread then waits for the next. */
const SWEEP_DEADLINE_MS = 8 * 60_000;
/** The longest a search or a snapshot runs. */
const READ_DEADLINE_MS = 60_000;
/** The longest a sweep waits for a source's per-second rate before it goes on without it. */
const RATE_WAIT_MAX_MS = 6_000;
/** Topics one `sweep` call names. */
const SWEEP_TOPICS_MAX = 10;
/** Items one raised topic's sample keeps per source. */
const SAMPLE_PER_SOURCE = 10;
/** Items a search keeps per source. */
const SEARCH_PER_SOURCE = 20;
/** Entries routineSources carries. */
const ROUTINE_SOURCES_MAX = 20;
/** The heartbeat's limit is 50 a source. */
const SIGNALS_MAX = 40;
/** Sweeps start at most this often from the heartbeat, unless `sweepMinutes` says otherwise; never more often than the floor. */
const SWEEP_MINUTES_DEFAULT = 60;
const SWEEP_MINUTES_MIN = 30;

const WINDOWS = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS } as const;
export type WindowName = keyof typeof WINDOWS;

/** A source's cache window from its terms, in ms; `none` and `ids-only` keep an item no longer than the reply needs. */
function ttlOf(record: TrendsSourceRecord): number {
  const cache = record.terms.cache;
  const ms =
    cache.mode === "ttl"
      ? cache.days * DAY_MS
      : cache.mode === "ttl-hours"
        ? cache.hours * HOUR_MS
        : cache.mode === "keep"
          ? 3 * DAY_MS
          : HOUR_MS;
  // A source that must honour its authors' deletions keeps items a day at most.
  return record.trends.deletionOnRequest ? Math.min(ms, DAY_MS) : Math.min(ms, 3 * DAY_MS);
}

/** A topic as an adapter reads it. */
function adapterTopicOf(input: TopicInput, countries: readonly string[]): AdapterTopic {
  return {
    label: input.label,
    terms: [...new Set(Object.values(input.terms).flat())],
    termsByLanguage: input.terms,
    exclude: input.exclude,
    articles: input.articles ?? {},
    countries,
  };
}

/** What one source came to in a sweep, a search or a snapshot. */
export interface SourceReport {
  readonly source: string;
  readonly outcome: "ok" | "partial" | "skipped" | "failed";
  readonly why?: string;
  /** Its daily budget is spent: it is read again from `nextAt`, never answered as empty. */
  readonly exhausted?: true;
  readonly nextAt?: string;
}

type Ran<V> =
  | { readonly kind: "ok"; readonly values: readonly V[]; readonly partial: boolean }
  | { readonly kind: "skipped"; readonly why: string; readonly nextAt?: string }
  | { readonly kind: "failed"; readonly class: Exclude<HealthClass, "ok"> };

/** A heartbeat signal as `collect` answers it; its data's values are any JSON. */
export type HeartbeatSignalLike = DomainHeartbeatSignalLike<unknown>;

/** The `watch` tool's input. */
export interface WatchInput {
  readonly op: "add" | "update" | "pause" | "resume" | "remove";
  readonly topicId?: string | undefined;
  readonly topic?: unknown;
}

/** A test as a reply shows it, rounded. */
function testView(test: SourceTest) {
  const round = (value: number, places = 3): number => Number(value.toPrecision(places));
  return {
    sourceId: test.sourceId,
    kind: test.kind,
    metric: test.metric,
    test: test.test,
    ...(test.reason === undefined ? {} : { reason: test.reason }),
    ...(test.window === undefined ? {} : { window: test.window }),
    x: test.x,
    baseline: round(test.baseline),
    ...(test.baselineKind === undefined ? {} : { baselineKind: test.baselineKind }),
    ...(test.growthBaseline === undefined ? {} : { growthBaseline: round(test.growthBaseline) }),
    ...(test.k === undefined ? {} : { k: round(test.k) }),
    p: test.p < 1e-4 ? Number(test.p.toExponential(2)) : round(test.p),
    z: round(test.z),
    g: round(test.g),
    /** The growth as a brief may show it. */
    growthPercent: Math.round(test.g * 100),
    floorMet: test.floorMet,
    crossChecked: test.crossChecked,
    ...(test.pBh === undefined ? {} : { pBh: test.pBh }),
    passed: test.passed === true,
  };
}

/** A test's result as the engine stores it (`SourceTest`); a row that is not one is left out. */
const StoredTestSchema = z.object({
  sourceId: z.string(),
  kind: z.enum(TRENDS_SOURCE_KINDS),
  metric: z.string(),
  test: z.enum(["count", "presence", "insufficient"]),
  reason: z.string().exactOptional(),
  window: z.object({ from: z.string(), to: z.string() }).exactOptional(),
  x: z.number().finite(),
  baseline: z.number().finite(),
  baselineKind: z.enum(["seasonal", "previous-days"]).exactOptional(),
  growthBaseline: z.number().exactOptional(),
  k: z.number().exactOptional(),
  p: z.number().finite(),
  z: z.number().finite(),
  g: z.number().finite(),
  floorMet: z.boolean(),
  crossChecked: z.boolean(),
  pBh: z.boolean().exactOptional(),
  passed: z.boolean().exactOptional(),
}) satisfies z.ZodType<SourceTest>;

/** A stored test's result, read back as the engine wrote it. */
function storedTest(result: Readonly<Record<string, unknown>>): SourceTest | undefined {
  const parsed = StoredTestSchema.safeParse(result);
  return parsed.success ? parsed.data : undefined;
}

/** A topic as a reply shows it. */
function topicView(topic: Topic, lastSweepAt: string | undefined) {
  return {
    topicId: topic.topicId,
    label: topic.label,
    terms: topic.terms,
    exclude: topic.exclude,
    ...(topic.wikidata === undefined ? {} : { wikidata: topic.wikidata }),
    ...(topic.articles === undefined ? {} : { articles: topic.articles }),
    countries: topic.countries,
    ...(topic.sources === undefined ? {} : { sources: topic.sources }),
    alert: topic.alert,
    paused: topic.paused,
    state: topic.state,
    ...(topic.stateSince === undefined ? {} : { stateSince: topic.stateSince }),
    ...(lastSweepAt === undefined ? {} : { lastSweepAt }),
  };
}

export function createEngine(options: EngineOptions) {
  const now = options.now ?? nowTimestamp;
  const sleep = options.sleep ?? delay;
  const adapters = [...(options.adapters ?? [...TR1_ADAPTERS, ...TR2_ADAPTERS]), ...(options.lists ?? [])];
  const byId = new Map(adapters.map((adapter) => [adapter.record.id, adapter]));
  const contact =
    typeof options.config["contact"] === "string" && options.config["contact"].trim() !== ""
      ? options.config["contact"].trim().slice(0, 200)
      : undefined;
  const userAgent = `Tavi-trends/${options.version}${contact === undefined ? "" : ` (+${contact})`}`;
  const defaultCountries = csvList(options.config["countries"])
    .filter((code) => /^[A-Z]{2}$/.test(code))
    .slice(0, 10);
  const defaultLanguages = csvList(options.config["languages"])
    .filter((code) => /^[a-z]{2,3}$/.test(code))
    .slice(0, 8);
  const sweepMinutes = Math.max(
    SWEEP_MINUTES_MIN,
    typeof options.config["sweepMinutes"] === "number" && Number.isFinite(options.config["sweepMinutes"])
      ? options.config["sweepMinutes"]
      : SWEEP_MINUTES_DEFAULT,
  );
  const settings: SourceCall["settings"] = {
    ...Object.fromEntries(
      ["mastodonInstances", "pttBoard"].flatMap((key) => (typeof options.config[key] === "string" ? [[key, options.config[key]]] : [])),
    ),
    // The operator's own assertion, never the model's: PTT's 18+ boards.
    pttAdultBoards: options.config["pttAdultBoards"] === true,
  };
  /** Each host's robots.txt while it is fresh: its text, or none when it has none. */
  const robotsTexts = new Map<string, { readonly text: string; readonly until: number }>();
  /** Each `oauth-client` source's token while it holds. */
  const tokens = new Map<string, { readonly token: string; readonly until: number }>();
  const stopping = new AbortController();

  let opened: { readonly store: TrendsStore; readonly items: ItemStore; readonly budgets: BudgetLedger } | undefined;
  let retainedDay: string | undefined;
  /** The heartbeat's sweep, while it runs: it starts one at most at a time. */
  let running: Promise<unknown> | undefined;
  /** Sweeps run one after another, so each moves a topic's state on from the last one's. */
  let lock: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = lock.then(work, work);
    // Ordering only: the work's own failure reaches its caller through the promise it was handed.
    lock = next.catch(() => undefined);
    return next;
  };
  /** When the heartbeat's last sweep failed, for `sources`; its error's words are not shown. */
  let backgroundFailedAt: string | undefined;
  let lastSweepStart: number | undefined;

  /**
   * `forget` is one-shot: both stores are emptied once when the
   * operator sets it, and a marker in the home keeps later starts from
   * emptying them again until the setting goes back to false.
   */
  const forgottenMarker = join(options.home, "forgotten");
  const forgetOnce = (store: TrendsStore, items: ItemStore): void => {
    if (options.config["forget"] !== true) {
      rmSync(forgottenMarker, { force: true });
      return;
    }
    if (existsSync(forgottenMarker)) return;
    store.forget();
    items.forget();
    writeFileSync(forgottenMarker, `${now()}\n`);
  };

  /** The stores, opened once; emptied first when the operator set `forget`, and kept within their terms once a day. */
  const open = () => {
    if (stopping.signal.aborted) throw new Error("the trends engine is closed");
    if (opened === undefined) {
      mkdirSync(join(options.home, "cache"), { recursive: true });
      const store = openTrendsStore(join(options.home, "trends.db"));
      const items = openItemStore(join(options.home, "cache", "items.db"));
      forgetOnce(store, items);
      opened = { store, items, budgets: createBudgetLedger(store.db) };
    }
    const day = now().slice(0, 10);
    if (retainedDay !== day) {
      opened.store.retain(now(), Object.fromEntries(adapters.map((adapter) => [adapter.record.id, adapter.record.trends.seriesMaxDays])));
      retainedDay = day;
    }
    opened.items.expire(now());
    return opened;
  };

  /** The sources turned on: the documented defaults, plus `enabledSources`, less `disabledSources`. */
  const enabled = (): Set<string> => {
    const off = new Set(csvList(options.config["disabledSources"]));
    const on = new Set([
      ...adapters.filter((adapter) => adapter.record.defaultOn).map((adapter) => adapter.record.id),
      ...csvList(options.config["enabledSources"]).filter((id) => byId.has(id)),
    ]);
    return new Set([...on].filter((id) => !off.has(id)));
  };

  /** A source's credential settings, each read when a call needs it (a rotated key applies at once); a key not set is absent. */
  const credentialsOf = async (record: TrendsSourceRecord): Promise<ReadonlyMap<string, string>> => {
    const values = new Map<string, string>();
    for (const key of record.credential ?? []) {
      const value = await options.credential?.(key);
      if (value !== null && value !== undefined && value !== "") values.set(key, value);
    }
    return values;
  };

  const call = (keys: ReadonlyMap<string, string> = new Map(), token?: string): SourceCall => ({
    now: now(),
    credential: (key) => keys.get(key),
    settings,
    ...(token === undefined ? {} : { token }),
  });

  /** Why a source may not be read for this call, or undefined when it may. */
  const admit = async (adapter: TrendsAdapter, context: { readonly unattended: boolean }): Promise<string | undefined> => {
    const record = adapter.record;
    if (record.trends.needsContact && contact === undefined) return "its terms ask for your contact in the User-Agent: set contact";
    if (record.terms.userTriggeredOnly && context.unattended) return "its terms allow only requests a person makes";
    if (record.trends.sunset !== undefined && now().slice(0, 10) >= record.trends.sunset)
      return `its access ended on ${record.trends.sunset}`;
    const keys = await credentialsOf(record);
    const missing = (record.credential ?? []).filter((key) => !keys.has(key));
    if (missing.length > 0) return `it needs its key: set ${missing.join(" and ")}`;
    return adapter.unconfigured?.(call(keys));
  };

  /** The next UTC midnight: an open page that refused a read is left until then. */
  const tomorrow = (at: string): string => new Date((Math.floor(Date.parse(at) / 86_400_000) + 1) * 86_400_000).toISOString();

  /** Whether an open page's robots.txt (and its Content-Signal) lets Tavi read `url`; undefined when it could not be read. */
  const robotsLet = async (url: string, signal: AbortSignal): Promise<{ readonly allowed: boolean; readonly why?: string } | undefined> => {
    const target = new URL(url);
    let held = robotsTexts.get(target.host);
    if (held === undefined || held.until <= Date.parse(now())) {
      let fetched: Fetched;
      try {
        fetched = await options.fetcher(
          { url: `${target.origin}/robots.txt`, expect: "text", headers: { "User-Agent": userAgent } },
          signal,
        );
      } catch {
        return undefined;
      }
      // No robots.txt is no rule; any other failure is no answer.
      if (fetched.status === 404 || fetched.status === 410) held = { text: "", until: Date.parse(now()) + ROBOTS_TTL_MS };
      else if (fetched.status === 200 && typeof fetched.body === "string")
        held = { text: fetched.body.slice(0, 500_000), until: Date.parse(now()) + ROBOTS_TTL_MS };
      else return undefined;
      robotsTexts.set(target.host, held);
    }
    if (refusesAiInput(robotsContentSignal(held.text)))
      return { allowed: false, why: "its robots.txt's Content-Signal says no to AI input" };
    return robotsAllows(held.text, `${target.pathname}${target.search}`)
      ? { allowed: true }
      : { allowed: false, why: `its robots.txt disallows ${target.pathname}` };
  };

  /** One request through its source's health and budget, its answer parsed, its outcome recorded. */
  const send = async <I, V>(
    adapter: TrendsAdapter,
    operation: Operation<I, V>,
    input: I,
    request: SourceRequest,
    signal: AbortSignal,
    sourceCall: SourceCall,
  ): Promise<
    | { readonly kind: "ok"; readonly value: V }
    | { readonly kind: "skipped"; readonly why: string; readonly nextAt?: string }
    | { readonly kind: "failed"; readonly class: Exclude<HealthClass, "ok"> }
  > => {
    const { store, budgets } = open();
    const id = adapter.record.id;
    const health = store.health(id, now());
    if (health.disabledUntil !== undefined && Date.parse(health.disabledUntil) > Date.parse(now()))
      return { kind: "skipped", why: `paused until ${health.disabledUntil}` };
    // Tavi reads no paid source: one with a price is never asked.
    if (adapter.record.trends.cost.unit !== "none") return { kind: "skipped", why: "it is a paid service, which Tavi does not use" };
    let budget = budgets.take(id, adapter.record.budget, Date.parse(now()));
    // A source's per-second rate is waited out, briefly; its daily budget is not.
    for (
      let waits = 0;
      !budget.ok && budget.reason === "per-second" && budget.retryAfterMs <= RATE_WAIT_MAX_MS && waits < 3 && !signal.aborted;
      waits += 1
    ) {
      await sleep(budget.retryAfterMs, signal);
      if (signal.aborted) break;
      budget = budgets.take(id, adapter.record.budget, Date.parse(now()));
    }
    if (signal.aborted) return { kind: "skipped", why: "the read ran out of time" };
    if (!budget.ok)
      return budget.reason === "per-day"
        ? { kind: "skipped", why: "its daily budget is spent", nextAt: new Date(Date.parse(now()) + budget.retryAfterMs).toISOString() }
        : { kind: "skipped", why: "its rate limit" };
    const at = now();
    let fetched: Fetched | undefined;
    let target = request;
    // An open page's every hop is asked of its robots.txt, and stays on the source's own hosts.
    for (let hop = 0; fetched === undefined; hop += 1) {
      if (adapter.robots === true) {
        const robots = await robotsLet(target.url, signal);
        if (robots === undefined) return { kind: "skipped", why: "its robots.txt could not be read" };
        if (!robots.allowed) {
          store.recordOutcome(id, { ok: false, class: "blocked", pauseUntil: tomorrow(now()) }, now());
          return { kind: "skipped", why: robots.why ?? "its robots.txt disallows it" };
        }
      }
      let answer: Fetched;
      try {
        answer = await options.fetcher({ ...target, headers: { "User-Agent": userAgent, ...target.headers } }, signal);
      } catch {
        // Tavi's own deadline or cancel is not the source failing.
        if (signal.aborted) return { kind: "skipped", why: "the read ran out of time" };
        store.recordOutcome(id, { ok: false, class: "network" }, at);
        return { kind: "failed", class: "network" };
      }
      if (target.redirect !== "manual" || ![301, 302, 303, 307, 308].includes(answer.status)) {
        fetched = answer;
        break;
      }
      const next = answer.location === undefined || answer.location === null ? undefined : URL.parse(answer.location, target.url);
      if (
        next === undefined ||
        next === null ||
        hop >= REDIRECTS_MAX ||
        (next.protocol !== "https:" && next.protocol !== "http:") ||
        !adapter.record.hosts.includes(next.host)
      ) {
        store.recordOutcome(id, { ok: false, class: "blocked", ...(adapter.robots === true ? { pauseUntil: tomorrow(at) } : {}) }, at);
        return { kind: "skipped", why: "it redirected off its own hosts" };
      }
      target = { ...target, url: next.toString() };
    }
    const outcome = operation.parse(
      { status: fetched.status, retryAfter: fetched.retryAfter, contentSignal: fetched.contentSignal ?? null, body: fetched.body },
      request,
      input,
      sourceCall,
    );
    if (outcome.kind === "ok") {
      store.recordOutcome(id, { ok: true }, at);
      return { kind: "ok", value: outcome.value };
    }
    if (outcome.kind === "rate-limited") {
      // An open page that asks Tavi to slow down is left for the day.
      store.recordOutcome(
        id,
        {
          ok: false,
          class: "quota",
          pauseUntil: adapter.robots === true ? tomorrow(at) : new Date(Date.parse(at) + outcome.retryAfterMs).toISOString(),
        },
        at,
      );
      return { kind: "failed", class: "quota" };
    }
    // So is one that refused, or answered with a challenge.
    const stop = adapter.robots === true && (outcome.class === "blocked" || outcome.class === "auth");
    store.recordOutcome(id, { ok: false, class: outcome.class, ...(stop ? { pauseUntil: tomorrow(at) } : {}) }, at);
    return { kind: "failed", class: outcome.class };
  };

  /** An `oauth-client` source's token: the one held, else a new one from its `authorize`. */
  const tokenFor = async (
    adapter: TrendsAdapter,
    keys: ReadonlyMap<string, string>,
    signal: AbortSignal,
  ): Promise<{ readonly token?: string; readonly stop?: Ran<never> }> => {
    if (adapter.authorize === undefined) return {};
    const held = tokens.get(adapter.record.id);
    if (held !== undefined && held.until > Date.parse(now())) return { token: held.token };
    const sourceCall = call(keys);
    const [request] = adapter.authorize.request({}, sourceCall);
    if (request === undefined) return {};
    const answer = await send<Record<string, never>, AccessToken>(adapter, adapter.authorize, {}, request, signal, sourceCall);
    if (answer.kind === "skipped") return { stop: { kind: "skipped", why: answer.why } };
    if (answer.kind === "failed") return { stop: { kind: "failed", class: answer.class } };
    // A minute's margin, so a token never lapses mid-call.
    tokens.set(adapter.record.id, { token: answer.value.token, until: Date.parse(now()) + answer.value.expiresInMs - 60_000 });
    return { token: answer.value.token };
  };

  /** Every request an operation asks for, in turn; the values of those that answered. */
  const run = async <I, V>(adapter: TrendsAdapter, operation: Operation<I, V>, input: I, signal: AbortSignal): Promise<Ran<V>> => {
    const values: V[] = [];
    let failure: Exclude<HealthClass, "ok"> | undefined;
    let skipped: string | undefined;
    let nextAt: string | undefined;
    const keys = await credentialsOf(adapter.record);
    const authorized = await tokenFor(adapter, keys, signal);
    if (authorized.stop !== undefined) return authorized.stop;
    const sourceCall = call(keys, authorized.token);
    for (const request of operation.request(input, sourceCall)) {
      if (signal.aborted) {
        skipped ??= "the read ran out of time";
        break;
      }
      const answer = await send(adapter, operation, input, request, signal, sourceCall);
      if (answer.kind === "ok") values.push(answer.value);
      else if (answer.kind === "failed") {
        failure ??= answer.class;
        // A refused token is dropped, so the next call asks for a new one.
        if (answer.class === "auth") tokens.delete(adapter.record.id);
      } else {
        skipped ??= answer.why;
        nextAt ??= answer.nextAt;
        // A paused or spent source stays so for the rest of this call.
        break;
      }
    }
    if (values.length > 0) return { kind: "ok", values, partial: failure !== undefined || skipped !== undefined };
    if (failure !== undefined) return { kind: "failed", class: failure };
    if (skipped !== undefined) return { kind: "skipped", why: skipped, ...(nextAt === undefined ? {} : { nextAt }) };
    return { kind: "ok", values, partial: false };
  };

  const reportOf = <V>(source: string, ran: Ran<V>): SourceReport =>
    ran.kind === "ok"
      ? { source, outcome: ran.partial ? "partial" : "ok" }
      : ran.kind === "skipped"
        ? { source, outcome: "skipped", why: ran.why, ...(ran.nextAt === undefined ? {} : { exhausted: true, nextAt: ran.nextAt }) }
        : { source, outcome: "failed", why: ran.class };

  /** The sources a topic reads: its own list or every one turned on, that counts, covers its countries, in its first country's order. */
  const sourcesFor = (topic: Topic): TrendsAdapter[] => {
    const on = enabled();
    // A source the operator has not turned on is never read, whoever names it.
    const named = topic.sources === undefined ? [...on] : topic.sources.filter((id) => on.has(id));
    const countries = topic.countries.length > 0 ? topic.countries : defaultCountries;
    const covers = (record: TrendsSourceRecord): boolean =>
      countries.length === 0 || record.countries.includes("*") || record.countries.some((code) => countries.includes(code));
    const order = options.routing?.[countries[0] ?? ""] ?? [];
    const rank = (id: string): number =>
      order.includes(id) ? order.indexOf(id) : order.length + adapters.findIndex((adapter) => adapter.record.id === id);
    return named
      .flatMap((id) => byId.get(id) ?? [])
      .filter((adapter) => adapter.counts !== undefined && covers(adapter.record))
      .sort((a, b) => rank(a.record.id) - rank(b.record.id));
  };

  /** A topic's countries: its own, else the default setting. */
  const countriesOf = (topic: Topic): readonly string[] => (topic.countries.length > 0 ? topic.countries : defaultCountries);

  /** Reads one source's counts for a topic into the store: a backfill the first time, the last days again after. */
  const readCounts = async (topic: Topic, read: AdapterTopic, adapter: TrendsAdapter, signal: AbortSignal): Promise<SourceReport> => {
    const { store } = open();
    const id = adapter.record.id;
    const plan = SERIES_PLANS[id] ?? { metric: "", bucket: "hour", snapshot: false };
    const at = now();
    const width = BUCKET_SECONDS[plan.bucket] * 1_000;
    // Whole buckets only, but a snapshot's bucket is the one holding now.
    const to = Date.parse(bucketStart(at, plan.bucket)) + (plan.snapshot ? width : 0);
    const last = store.sweep(topic.topicId).sourcesDone[id];
    const reach = Math.min(REACH_MS[plan.bucket], Math.max(adapter.record.trends.backfillDays * DAY_MS, plan.snapshot ? width : DAY_MS));
    const from = Math.max(to - reach, last === undefined ? Number.NEGATIVE_INFINITY : Date.parse(last) - REREAD_MS[plan.bucket]);
    if (from >= to || adapter.counts === undefined) return { source: id, outcome: "ok" };
    const window: Window = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucket: plan.bucket };
    const ran = await run(adapter, adapter.counts, { topic: read, window }, signal);
    if (ran.kind !== "ok") return reportOf(id, ran);
    // One series per metric over every answer; a request that failed leaves its buckets partial.
    const byMetric = new Map<string, CountPoint[][]>();
    for (const series of ran.values.flat()) byMetric.set(series.metric, [...(byMetric.get(series.metric) ?? []), [...series.points]]);
    const points = [...byMetric].flatMap(([metric, parts]) =>
      mergeSeries(parts).map((point) => ({
        topicId: topic.topicId,
        sourceId: id,
        metric,
        bucket: plan.bucket,
        start: point.start,
        value: point.value,
        quality: ran.partial && point.quality === "ok" ? ("partial" as const) : point.quality,
        ...(point.norm === undefined ? {} : { norm: point.norm }),
      })),
    );
    store.putSeries(points, at);
    store.sweptSource(topic.topicId, id, new Date(to).toISOString());
    return reportOf(id, ran);
  };

  /** A source's test for a topic, from the store. */
  const testOf = (topic: Topic, adapter: TrendsAdapter, at: string): SourceTest => {
    const { store } = open();
    const plan = SERIES_PLANS[adapter.record.id] ?? { metric: "", bucket: "hour", snapshot: false };
    const to = new Date(Date.parse(at) + HOUR_MS).toISOString();
    const from = new Date(Date.parse(at) - REACH_MS[plan.bucket] - DAY_MS).toISOString();
    const observations = store
      .series(topic.topicId, plan.bucket, from, to, { sourceId: adapter.record.id, metric: plan.metric })
      .map((point) => ({ start: point.start, value: point.value, quality: point.quality }));
    return testSource({
      sourceId: adapter.record.id,
      kind: adapter.record.kind,
      metric: plan.metric,
      bucket: plan.bucket,
      observations,
      now: at,
      alert: topic.alert,
    });
  };

  /** Keeps a raised topic's sample: the items behind its spike, for a brief to cite. */
  const sampleFor = async (
    topic: Topic,
    read: AdapterTopic,
    passing: readonly SourceTest[],
    context: { readonly unattended: boolean },
    signal: AbortSignal,
  ): Promise<StoredItem[]> => {
    const { items } = open();
    const at = now();
    const kept: StoredItem[] = [];
    for (const adapter of passing.flatMap((test) => byId.get(test.sourceId) ?? [])) {
      if (adapter.sample === undefined || signal.aborted || (await admit(adapter, context)) !== undefined) continue;
      const window: Window = { from: new Date(Date.parse(at) - DAY_MS).toISOString(), to: at, bucket: "hour" };
      const ran = await run(adapter, adapter.sample, { topic: read, window, limit: SAMPLE_PER_SOURCE }, signal);
      if (ran.kind !== "ok") continue;
      kept.push(
        ...items.upsert(
          ran.values.flat().slice(0, SAMPLE_PER_SOURCE),
          { source: adapter.record.id, origin: "adapter", ttlMs: ttlOf(adapter.record), topicId: topic.topicId },
          at,
        ),
      );
    }
    return kept;
  };

  const wikidataSource: TrendsAdapter = { record: WIKIDATA };
  /** The languages a topic is asked in: its terms', and its countries' editions. */
  const languagesOf = (topic: Topic, countries: readonly string[]): string[] =>
    [...new Set([...Object.keys(topic.terms), ...countries.map((country) => COUNTRY_EDITION[country] ?? "en")])].sort().slice(0, 12);
  /** The topic's first term and its language: what Wikidata is searched for. */
  const firstTermOf = (topic: Topic): readonly [string, string] | readonly [] =>
    Object.entries(topic.terms).flatMap(([code, terms]) => terms.map((each) => [code, each] as const))[0] ?? [];
  /** A topic's Wikidata names as the last sweep cached them, read with no request. */
  const cachedNames = (topic: Topic): readonly string[] => {
    const { store } = open();
    const at = now();
    const [language, term] = firstTermOf(topic);
    const found =
      topic.wikidata ??
      (language === undefined || term === undefined ? undefined : store.wikidata(`search:${language}:${term.toLowerCase()}`, at));
    if (typeof found !== "string") return [];
    const expansion = store.wikidata(`entity:${found}:${languagesOf(topic, countriesOf(topic)).join(",")}`, at) as
      | WikidataExpansion
      | undefined;
    return expansion === undefined ? [] : Object.values(expansion.terms).flat();
  };
  const searchOperation: Operation<{ readonly term: string; readonly language: string }, string | undefined> = {
    request: ({ term, language }) => [wikidataSearch.request(term, language)],
    parse: (response, _request, _input, sourceCall) => wikidataSearch.parse(response, sourceCall),
  };
  const entityOperation: Operation<{ readonly qid: string; readonly languages: readonly string[] }, WikidataExpansion> = {
    request: ({ qid, languages }) => [wikidataEntity.request(qid, languages)],
    parse: (response, _request, { qid }, sourceCall) => wikidataEntity.parse(response, qid, sourceCall),
  };

  /**
   * A topic as the sources are asked it: its own terms, and for one
   * across several languages, its Wikidata entity's names in each and its
   * article in each edition, cached 30 days. Wikidata is read only with the
   * operator's contact; without it, or on a failure, the topic's own terms.
   */
  const expand = async (topic: Topic, context: { readonly unattended: boolean }, signal: AbortSignal): Promise<AdapterTopic> => {
    const countries = countriesOf(topic);
    const own = adapterTopicOf(topic, countries);
    const languages = languagesOf(topic, countries);
    if (
      (languages.length < 2 && topic.wikidata === undefined) ||
      csvList(options.config["disabledSources"]).includes("wikidata") ||
      (await admit(wikidataSource, context)) !== undefined
    )
      return own;
    const { store } = open();
    const at = now();
    const [language, term] = firstTermOf(topic);
    let qid = topic.wikidata;
    if (qid === undefined && language !== undefined && term !== undefined) {
      const key = `search:${language}:${term.toLowerCase()}`;
      const cached = store.wikidata(key, at);
      if (cached === null || typeof cached === "string") qid = cached ?? undefined;
      else {
        const ran = await run(wikidataSource, searchOperation, { term, language }, signal);
        if (ran.kind !== "ok") return own;
        qid = ran.values[0];
        store.putWikidata(key, qid ?? null, at, WIKIDATA_TTL_MS);
      }
    }
    if (qid === undefined) return own;
    const key = `entity:${qid}:${languages.join(",")}`;
    let expansion = store.wikidata(key, at) as WikidataExpansion | undefined;
    if (expansion === undefined) {
      const ran = await run(wikidataSource, entityOperation, { qid, languages }, signal);
      if (ran.kind !== "ok" || ran.values[0] === undefined) return own;
      expansion = ran.values[0];
      store.putWikidata(key, expansion, at, WIKIDATA_TTL_MS);
    }
    const found = expansion;
    const termsByLanguage: Record<string, readonly string[]> = {};
    for (const code of languages) {
      const terms = [...new Set([...(topic.terms[code] ?? []), ...(found.terms[code] ?? [])])].slice(0, 20);
      if (terms.length > 0) termsByLanguage[code] = terms;
    }
    const articles =
      topic.articles ??
      Object.fromEntries(Object.entries(expansion.articles).filter(([project]) => languages.includes(project.replace(".wikipedia", ""))));
    // The topic's own terms first: a source that asks one term asks the person's.
    return { ...own, terms: [...new Set([...own.terms, ...Object.values(termsByLanguage).flat()])], termsByLanguage, articles };
  };

  /** Items as `routineSources`: what a routine may record as evidence. */
  const routineSourcesOf = (items: readonly StoredItem[]) =>
    items
      .filter((item) => item.url.startsWith("https://"))
      .slice(0, ROUTINE_SOURCES_MAX)
      .map((item) => ({
        url: item.url,
        title: item.title,
        ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
        excerpt: (item.text === "" ? item.title : item.text).slice(0, 500),
      }));

  /**
   * One sweep: each topic's sources read, tested, corrected together
   * by Benjamini–Hochberg, and each topic's state moved on. Time-boxed: what
   * a source could not read keeps its last counts.
   */
  const sweepTopics = (named: readonly Topic[], context: { readonly unattended: boolean }, outer: AbortSignal) =>
    exclusive(async () => {
      const signal = AbortSignal.any([outer, stopping.signal, AbortSignal.timeout(SWEEP_DEADLINE_MS)]);
      const { store } = open();
      // Each topic as the store has it now: a sweep that ran while this one waited has moved its state on, and one may be gone.
      const topics = named.flatMap((topic) => {
        try {
          return [store.topic(topic.topicId, { principalId: topic.principalId, workspaceId: topic.workspaceId })];
        } catch {
          return [];
        }
      });
      const reports = new Map<string, SourceReport[]>();
      const adaptersOf = new Map<string, TrendsAdapter[]>();
      const asked = new Map<string, AdapterTopic>();
      for (const topic of topics) {
        const own: SourceReport[] = [];
        const read: TrendsAdapter[] = [];
        const expanded = await expand(topic, context, signal);
        asked.set(topic.topicId, expanded);
        for (const adapter of sourcesFor(topic)) {
          const why = await admit(adapter, context);
          if (why !== undefined) {
            own.push({ source: adapter.record.id, outcome: "skipped", why });
            continue;
          }
          read.push(adapter);
          own.push(
            signal.aborted
              ? { source: adapter.record.id, outcome: "skipped", why: "the sweep ran out of time" }
              : await readCounts(topic, expanded, adapter, signal),
          );
        }
        reports.set(topic.topicId, own);
        adaptersOf.set(topic.topicId, read);
      }
      // Every topic's tests together, so the false-discovery rate is the sweep's.
      const at = now();
      const pending = topics.flatMap((topic) =>
        (adaptersOf.get(topic.topicId) ?? []).map((adapter) => ({ topic, test: testOf(topic, adapter, at) })),
      );
      const judged = judgeSweep(pending.map((entry) => entry.test));
      const results = [];
      for (const topic of topics) {
        const own = judged.filter((_, index) => pending[index]?.topic.topicId === topic.topicId);
        const before = {
          state: topic.state,
          quietSweeps: topic.quietSweeps,
          ...(topic.quietSince === undefined ? {} : { quietSince: topic.quietSince }),
        };
        const after = nextState(before, own, at, topic.alert.growth);
        store.setState(topic.topicId, after, at);
        for (const test of own) store.recordTest(topic.topicId, test.sourceId, at, { ...test });
        const passing = own.filter((test) => test.passed === true);
        const sample =
          after.state === "quiet" || signal.aborted
            ? []
            : await sampleFor(topic, asked.get(topic.topicId) ?? adapterTopicOf(topic, countriesOf(topic)), passing, context, signal);
        const sourceReports = reports.get(topic.topicId) ?? [];
        const outcome = `${after.state}; ${sourceReports.filter((report) => report.outcome === "ok" || report.outcome === "partial").length} of ${sourceReports.length} sources read`;
        store.sweptTopic(topic.topicId, at, outcome);
        const growth = Math.max(0, ...passing.filter((test) => test.test === "count").map((test) => test.g));
        results.push({
          topicId: topic.topicId,
          label: topic.label,
          state: after.state,
          previousState: topic.state,
          families: [...new Set(passing.map((test) => test.kind))],
          growthPercent: Math.round(growth * 100),
          sources: sourceReports,
          itemIds: sample.map((item) => item.itemId),
        });
      }
      const day = new Date(Date.parse(at) - DAY_MS).toISOString();
      return {
        at,
        topics: results,
        routineSources: routineSourcesOf(topics.flatMap((topic) => open().items.forTopic(topic.topicId, day, at, ROUTINE_SOURCES_MAX))),
      };
    });

  /** The heartbeat's background sweep of every active topic, at most one at a time and one per `sweepMinutes`. */
  const backgroundSweep = (): boolean => {
    if (running !== undefined) return true;
    const started = Date.parse(now());
    if (lastSweepStart !== undefined && started - lastSweepStart < sweepMinutes * 60_000) return false;
    const topics = open().store.activeTopics();
    if (topics.length === 0) return false;
    lastSweepStart = started;
    running = sweepTopics(topics, { unattended: true }, stopping.signal)
      .then(
        () => {
          backgroundFailedAt = undefined;
        },
        () => {
          backgroundFailedAt = now();
        },
      )
      .finally(() => {
        running = undefined;
      });
    return true;
  };

  const sourceOf = (sourceId: string) => {
    if (sourceId === "agent") return { kind: "social" as const, name: "the browser" };
    const record = byId.get(sourceId)?.record;
    return record === undefined ? undefined : { kind: record.kind, name: BRIEF_NAMES[sourceId] ?? record.name };
  };

  /** A test's arithmetic for the topic, newest per source. */
  const latestTests = (topicId: string): SourceTest[] =>
    open()
      .store.latestTests(topicId)
      .flatMap((entry) => storedTest(entry.result) ?? []);

  return {
    /** The sources: static record facts, numbers and enum health only, never caller text or an upstream's words. */
    async sources(input: { readonly country?: string | undefined; readonly kind?: TrendsSourceKind | undefined }) {
      const { store, budgets } = open();
      const at = now();
      const on = enabled();
      const records = adapters
        .map((adapter) => adapter.record)
        .filter(
          (record) =>
            (input.country === undefined || record.countries.includes("*") || record.countries.includes(input.country)) &&
            (input.kind === undefined || record.kind === input.kind),
        );
      // Which keys are set: a yes or no, never a value.
      const keyed = new Map(
        await Promise.all(
          records.map(async (record) => [record.id, (await credentialsOf(record)).size === (record.credential ?? []).length] as const),
        ),
      );
      return {
        sources: records.map((record) => {
          const health = store.health(record.id, at);
          const budget = budgets.peek(record.id);
          const usedToday = budget !== undefined && budget.day === at.slice(0, 10) ? budget.usedToday : 0;
          const paused = health.disabledUntil !== undefined && Date.parse(health.disabledUntil) > Date.parse(at);
          return {
            id: record.id,
            name: record.name,
            kind: record.kind,
            on: on.has(record.id),
            standing: record.standing,
            countries: record.countries,
            languages: record.trends.languages,
            ...(record.trends.needsContact && contact === undefined
              ? { needs: "contact" }
              : keyed.get(record.id) === false
                ? { needs: "key" }
                : {}),
            terms: {
              url: record.terms.url,
              licence: record.terms.licence,
              llmUse: record.terms.llmUse,
              attribution: record.terms.attribution,
              displayRules: record.terms.displayRules,
            },
            health: (HEALTH_CLASSES as readonly string[]).includes(health.lastClass) ? health.lastClass : "ok",
            consecutiveFailures: health.consecutiveFailures,
            ...(paused ? { pausedUntil: health.disabledUntil } : {}),
            ...(health.lastSuccess === undefined ? {} : { lastSuccess: health.lastSuccess }),
            budget: {
              perDay: record.budget.perDay,
              usedToday,
              ...(usedToday >= record.budget.perDay ? { exhausted: true, nextAt: tomorrow(at) } : {}),
            },
          };
        }),
        excluded: (options.excluded ?? []).map((entry) => ({ id: entry.id, name: entry.name, reason: entry.reason })),
        ...(backgroundFailedAt === undefined ? {} : { backgroundSweep: { outcome: "failed", at: backgroundFailedAt } }),
      };
    },

    topics(context: CallContext) {
      const { store } = open();
      return { topics: store.topics(context.scope).map((topic) => topicView(topic, store.sweep(topic.topicId).lastSweepAt)) };
    },

    /** Adds, changes, pauses or removes a topic (`watch`); a person approves each call. */
    watch(input: WatchInput, context: CallContext) {
      if (context.unattended) throw new Error("watch is the person's to approve: a run nobody attends cannot change topics");
      const { store } = open();
      const at = now();
      const topicId = (): string => {
        if (input.topicId === undefined) throw new Error(`${input.op} names its topic by topicId`);
        return input.topicId;
      };
      if (input.op === "add" || input.op === "update") {
        const parsed = TopicInputSchema.parse(input.topic);
        // A handle, an account, or the name of an author a read saw today: a person, never a topic.
        const people = Object.values(parsed.terms)
          .flat()
          .filter((term) => personShapedTerm(term) || open().items.seenAuthor(term, at));
        if (people.length > 0)
          throw new Error(
            `a topic is a subject, never a person: ${people.length === 1 ? "a term is" : "terms are"} a handle, an account or an author's name`,
          );
        if (parsed.sources !== undefined) {
          const unknown = parsed.sources.filter((id) => !byId.has(id));
          if (unknown.length > 0) throw new Error(`no source ${unknown.join(", ")}: trends.radar.sources lists them`);
          const on = enabled();
          const off = parsed.sources.filter((id) => !on.has(id));
          if (off.length > 0)
            throw new Error(`${off.join(", ")} ${off.length === 1 ? "is" : "are"} off: the operator turns a source on with enabledSources`);
        }
        const topic =
          input.op === "add" ? store.createTopic(context.scope, parsed, at) : store.updateTopic(topicId(), context.scope, parsed, at);
        const backfill = sourcesFor(topic)
          .filter((adapter) => adapter.record.trends.backfillDays > 0)
          .map((adapter) => adapter.record.id);
        return {
          topic: topicView(topic, store.sweep(topic.topicId).lastSweepAt),
          backfill: { sources: backfill, when: "the first sweep reads each source's history" },
        };
      }
      if (input.op === "remove") return { removed: store.removeTopic(topicId(), context.scope), topicId: topicId() };
      const topic = store.setPaused(topicId(), context.scope, input.op === "pause", at);
      return { topic: topicView(topic, store.sweep(topic.topicId).lastSweepAt) };
    },

    /** A sweep of the caller's topics now (`sweep`). */
    async sweep(input: { readonly topicIds?: readonly string[] | undefined }, signal: AbortSignal, context: CallContext) {
      const { store } = open();
      const topics =
        input.topicIds === undefined
          ? store
              .topics(context.scope)
              .filter((topic) => !topic.paused)
              .slice(0, SWEEP_TOPICS_MAX)
          : input.topicIds.slice(0, SWEEP_TOPICS_MAX).map((topicId) => store.topic(topicId, context.scope));
      if (topics.length === 0)
        return { at: now(), topics: [], routineSources: [], note: "no topics to sweep: add one with trends.radar.watch" };
      return sweepTopics(topics, context, signal);
    },

    /** A topic's series, baselines and tests from the store (`velocity`): no request. */
    velocity(input: { readonly topicId: string; readonly window: WindowName; readonly bucket?: Bucket | undefined }, context: CallContext) {
      const { store, items } = open();
      const topic = store.topic(input.topicId, context.scope);
      const at = now();
      const from = new Date(Date.parse(at) - WINDOWS[input.window]).toISOString();
      const to = new Date(Date.parse(at) + HOUR_MS).toISOString();
      const bucket = input.bucket ?? (input.window === "24h" ? "hour" : "day");
      const series = store.series(topic.topicId, bucket, from, to);
      const grouped = new Map<string, { sourceId: string; metric: string; points: { start: string; value: number; quality: string }[] }>();
      for (const point of series) {
        const key = `${point.sourceId}\u0000${point.metric}`;
        const entry = grouped.get(key) ?? { sourceId: point.sourceId, metric: point.metric, points: [] };
        entry.points.push({ start: point.start, value: point.value, quality: point.quality });
        grouped.set(key, entry);
      }
      const tests = latestTests(topic.topicId);
      return {
        topicId: topic.topicId,
        label: topic.label,
        state: topic.state,
        ...(topic.stateSince === undefined ? {} : { stateSince: topic.stateSince }),
        alert: topic.alert,
        ...(store.sweep(topic.topicId).lastSweepAt === undefined ? {} : { lastSweepAt: store.sweep(topic.topicId).lastSweepAt }),
        bucket,
        series: [...grouped.values()],
        tests: tests.map(testView),
        ...(tests.length === 0
          ? {}
          : {
              taviFindings: [
                { kind: "trend-test", records: tests.map((test) => ({ topicId: topic.topicId, label: topic.label, ...testView(test) })) },
              ],
            }),
        itemIds: items.forTopic(topic.topicId, new Date(Date.parse(at) - DAY_MS).toISOString(), at, 50).map((item) => item.itemId),
      };
    },

    /** Topics' daily counts side by side, each series scaled to 100 at its peak (`compare`): no request. */
    compare(input: { readonly topicIds: readonly string[]; readonly window: WindowName }, context: CallContext) {
      const { store } = open();
      const at = now();
      // A day's comparison is by hour; a week's or a month's by day.
      const step: Bucket = input.window === "24h" ? "hour" : "day";
      const keyOf = (start: string): string => (step === "hour" ? start.slice(0, 13) : start.slice(0, 10));
      const from = bucketStart(new Date(Date.parse(at) - WINDOWS[input.window]).toISOString(), step);
      const to = new Date(Date.parse(at) + HOUR_MS).toISOString();
      const days: string[] = [];
      for (let ms = Date.parse(from); ms < Date.parse(to); ms += BUCKET_SECONDS[step] * 1_000) days.push(keyOf(new Date(ms).toISOString()));
      return {
        bucket: step,
        days,
        topics: input.topicIds.map((topicId) => {
          const topic = store.topic(topicId, context.scope);
          // A daily source's own days; an hourly one's hours summed into days.
          const totals = new Map<string, Map<string, number>>();
          for (const bucket of ["day", "hour"] as const) {
            for (const point of store.series(topic.topicId, bucket, from, to)) {
              const plan = SERIES_PLANS[point.sourceId];
              // A daily series has no hours to show a day by.
              if (
                plan === undefined ||
                plan.metric !== point.metric ||
                plan.bucket !== bucket ||
                point.quality === "missing" ||
                (step === "hour" && bucket === "day")
              )
                continue;
              const byDay = totals.get(point.sourceId) ?? new Map<string, number>();
              byDay.set(keyOf(point.start), (byDay.get(keyOf(point.start)) ?? 0) + point.value);
              totals.set(point.sourceId, byDay);
            }
          }
          const series = [...totals].map(([sourceId, byDay]) => {
            const peak = Math.max(0, ...byDay.values());
            return {
              sourceId,
              metric: SERIES_PLANS[sourceId]?.metric ?? "",
              peak,
              values: days.map((day) => (byDay.has(day) && peak > 0 ? Math.round(((byDay.get(day) ?? 0) / peak) * 100) : null)),
            };
          });
          return { topicId: topic.topicId, label: topic.label, state: topic.state, series };
        }),
      };
    },

    /** What is trending now in a country (`snapshot`), each entry kept as an item to cite. */
    async snapshot(
      input: { readonly country: string; readonly sources?: readonly string[] | undefined },
      outer: AbortSignal,
      context: CallContext,
    ) {
      const signal = AbortSignal.any([outer, stopping.signal, AbortSignal.timeout(READ_DEADLINE_MS)]);
      const { items } = open();
      const on = enabled();
      const chosen = adapters.filter(
        (adapter) =>
          adapter.trending !== undefined &&
          on.has(adapter.record.id) &&
          (input.sources === undefined || input.sources.includes(adapter.record.id)) &&
          (adapter.record.countries.includes("*") || adapter.record.countries.includes(input.country)),
      );
      const reports: SourceReport[] = [];
      const lists = [];
      for (const adapter of chosen) {
        const why = await admit(adapter, context);
        if (why !== undefined || adapter.trending === undefined) {
          reports.push({ source: adapter.record.id, outcome: "skipped", why: why ?? "no list" });
          continue;
        }
        const ran = await run(adapter, adapter.trending, { country: input.country }, signal);
        reports.push(reportOf(adapter.record.id, ran));
        if (ran.kind !== "ok") continue;
        const entries = ran.values.flat().slice(0, 50);
        const at = now();
        const raw: RawItem[] = entries.map((entry) => ({
          ref: `${input.country}:${entry.url ?? entry.title}`,
          url: entry.url ?? "",
          title: entry.title,
          metrics: { rank: entry.rank, ...(entry.volume === undefined ? {} : { volume: entry.volume }) },
        }));
        const stored = items.upsert(
          raw,
          {
            source: adapter.record.id,
            origin: "adapter",
            ttlMs: ttlOf(adapter.record),
            itemSet: `snapshot:${input.country}:${at.slice(0, 13)}`,
          },
          at,
        );
        lists.push({
          source: adapter.record.id,
          attribution: adapter.record.terms.attribution,
          entries: entries.map((entry, index) => ({
            rank: entry.rank,
            title: entry.title,
            ...(entry.url === undefined ? {} : { url: entry.url }),
            ...(entry.volumeLabel === undefined ? {} : { volume: entry.volumeLabel }),
            itemId: stored[index]?.itemId,
          })),
        });
      }
      const kept = lists.flatMap((each) => each.entries).filter((entry) => entry.url !== undefined);
      return {
        country: input.country,
        lists,
        sources: reports,
        routineSources: routineSourcesOf(
          items.many(
            kept.flatMap((entry) => entry.itemId ?? []),
            now(),
          ),
        ),
        ...(kept.length === 0
          ? {}
          : {
              taviFindings: [
                {
                  kind: "trend",
                  records: kept.slice(0, 100).map((entry) => ({
                    title: entry.title,
                    url: entry.url,
                    rank: entry.rank,
                    ...(entry.volume === undefined ? {} : { volume: entry.volume }),
                  })),
                },
              ],
            }),
      };
    },

    /** A phrase searched across the sources that sample (`search`): a dated sample to cite, and hourly counts where a source has them. */
    async search(
      input: {
        readonly query: string;
        readonly languages?: readonly string[] | undefined;
        readonly countries?: readonly string[] | undefined;
        readonly window: WindowName;
        readonly sources?: readonly string[] | undefined;
      },
      outer: AbortSignal,
      context: CallContext,
    ) {
      if (personShapedTerm(input.query) || open().items.seenAuthor(input.query, now()))
        throw new Error("a search is for a subject, never a person: a handle, an account or an author's name is refused");
      const signal = AbortSignal.any([outer, stopping.signal, AbortSignal.timeout(READ_DEADLINE_MS)]);
      const { items } = open();
      const at = now();
      const languages = input.languages ?? (defaultLanguages.length > 0 ? defaultLanguages : ["en"]);
      const countries = input.countries ?? defaultCountries;
      const topic: AdapterTopic = {
        label: input.query,
        terms: [input.query],
        termsByLanguage: Object.fromEntries(languages.map((language) => [language, [input.query]])),
        exclude: [],
        articles: {},
        countries,
      };
      const window: Window = {
        from: new Date(Date.parse(at) - WINDOWS[input.window]).toISOString(),
        to: bucketStart(at, "hour"),
        bucket: "hour",
      };
      const on = enabled();
      const chosen = adapters.filter(
        (adapter) =>
          adapter.sample !== undefined &&
          on.has(adapter.record.id) &&
          (input.sources === undefined || input.sources.includes(adapter.record.id)) &&
          (countries.length === 0 ||
            adapter.record.countries.includes("*") ||
            adapter.record.countries.some((code) => countries.includes(code))),
      );
      const itemSet = `search:${at}`;
      const reports: SourceReport[] = [];
      const kept: StoredItem[] = [];
      const counts: { source: string; metric: string; total: number; quality: string }[] = [];
      /** The sources whose read was a capped sample: no count is given for them, only where the sample starts. */
      const samples: { source: string; coveredFrom?: string; note: string }[] = [];
      for (const adapter of chosen) {
        const why = await admit(adapter, context);
        if (why !== undefined || adapter.sample === undefined) {
          reports.push({ source: adapter.record.id, outcome: "skipped", why: why ?? "no sample" });
          continue;
        }
        const ran = await run(adapter, adapter.sample, { topic, window, limit: SEARCH_PER_SOURCE }, signal);
        reports.push(reportOf(adapter.record.id, ran));
        if (ran.kind === "ok")
          kept.push(
            ...items.upsert(
              ran.values.flat().slice(0, SEARCH_PER_SOURCE),
              { source: adapter.record.id, origin: "adapter", ttlMs: ttlOf(adapter.record), itemSet },
              at,
            ),
          );
        const plan = SERIES_PLANS[adapter.record.id];
        if (adapter.counts === undefined || plan === undefined || plan.bucket !== "hour" || plan.snapshot || signal.aborted) continue;
        const read = await run(adapter, adapter.counts, { topic, window }, signal);
        if (read.kind !== "ok") continue;
        for (const series of read.values.flat()) {
          if (series.metric !== plan.metric) continue;
          const seen = series.points.filter((point) => point.quality !== "missing");
          const total = seen.reduce((sum, point) => sum + point.value, 0);
          if (seen.length === series.points.length && seen.every((point) => point.quality === "ok")) {
            counts.push({ source: adapter.record.id, metric: series.metric, total, quality: "ok" });
            continue;
          }
          // A capped or cut read (Bluesky's one page of posts) is a sample, not the window's count: a week and a month can read the same posts.
          // No number at all: a model given one sets it beside the other window's, though a sample read the same posts for both.
          const coveredFrom = seen.length < series.points.length ? seen[0]?.start : undefined;
          samples.push({
            source: adapter.record.id,
            ...(coveredFrom === undefined ? {} : { coveredFrom }),
            note: `Only a sample of the newest items${coveredFrom === undefined ? "" : `, from ${coveredFrom}`}: no count for this window.`,
          });
        }
      }
      return {
        query: input.query,
        window: input.window,
        itemSet,
        items: kept.map((item) => ({
          itemId: item.itemId,
          source: item.source,
          outlet: item.outlet,
          url: item.url,
          title: item.title,
          ...(item.text === "" ? {} : { excerpt: item.text.slice(0, 400) }),
          ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
          ...(item.language === undefined ? {} : { language: item.language }),
          metrics: item.metrics,
        })),
        counts,
        ...(samples.length === 0 ? {} : { samples }),
        sources: reports,
        routineSources: routineSourcesOf(kept),
        ...(kept.length === 0
          ? {}
          : {
              taviFindings: [
                {
                  kind: "trend-item",
                  records: kept.slice(0, 100).map((item) => ({
                    itemId: item.itemId,
                    title: item.title,
                    url: item.url,
                    outlet: item.outlet,
                    ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
                  })),
                },
              ],
            }),
      };
    },

    /**
     * A browser site profile and how to read it: the agent reads the
     * page in the person's session, JSON-LD first, then `browser.extract`
     * with the profile's result schema, and relays the rows with `ingest`;
     * on an assist-only site, only a page the person opened, kept by nothing.
     */
    profile(input: { readonly profileId: string }) {
      const profile = (options.sites ?? []).find((each) => each.id === input.profileId);
      if (profile === undefined)
        throw new Error(`no site profile ${input.profileId}: ${(options.sites ?? []).map((each) => each.id).join(", ")}`);
      // An assist-only site's terms bar reading it by program: the agent is not to open it, and nothing read there is kept.
      const assistOnly = profile.access.mode === "assist-only";
      return {
        profile: {
          id: profile.id,
          name: profile.name,
          countries: profile.countries,
          hosts: profile.hosts,
          access: profile.access,
          budget: profile.budget,
          ...(profile.signIn === undefined ? {} : { signIn: profile.signIn }),
          ...(profile.extract === undefined ? {} : { extract: profile.extract }),
          notes: profile.notes,
        },
        howToRead: assistOnly
          ? `Never open ${profile.name}: its terms bar reading it by program. Only if the person opened the page themselves, read that page for the chat with browser.structured or browser.read. Nothing from it is kept: trends.radar.ingest refuses it.`
          : `Only when the person asks, and only if they turned ${profile.name} on under "Sites this app may browse": open it in their session; try browser.structured (${(profile.extract?.jsonLdTypes ?? []).join(", ") || "no JSON-LD"}), else browser.extract with this profile's resultSchema. A sign-in or a check is theirs: browser.request_handoff. Then relay the rows with trends.radar.ingest; they are cited as read in the browser and never counted toward a spike.`,
      };
    },

    /** Keeps rows the agent read in the browser, after the person approves: `origin: "agent"`, a day, never counted. */
    ingest(input: { readonly profileId: string; readonly itemSet: string; readonly items: readonly IngestRow[] }, context: CallContext) {
      if (context.unattended) throw new Error("ingest is the person's to approve: a run nobody attends cannot keep rows");
      const profile = (options.sites ?? []).find((each) => each.id === input.profileId);
      if (profile === undefined) throw new Error(`no site profile ${input.profileId}`);
      if (profile.access.mode === "assist-only")
        throw new Error(`${profile.name} is read for the chat only: its terms bar keeping what is read there`);
      // A row links to the site it was read on: a page cannot name another outlet for a brief to cite.
      const onProfile = (host: string): boolean =>
        profile.hosts.some((pattern) =>
          pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern,
        );
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(input.itemSet))
        throw new Error("an itemSet is lower-case letters, digits and dashes, at most 40");
      if (input.items.length === 0 || input.items.length > INGEST_ROWS_MAX)
        throw new Error(`ingest takes 1 to ${String(INGEST_ROWS_MAX)} rows`);
      const seen = new Set<string>();
      const rows = input.items.flatMap((row): RawItem[] => {
        const url = URL.parse(row.url);
        if (
          url === null ||
          (url.protocol !== "https:" && url.protocol !== "http:") ||
          !onProfile(url.hostname) ||
          row.title.trim() === "" ||
          seen.has(url.toString())
        )
          return [];
        seen.add(url.toString());
        return [
          {
            ref: `${input.itemSet}:${url.toString()}`,
            url: url.toString(),
            title: row.title,
            ...(row.text === undefined ? {} : { text: row.text }),
            metrics: { ...(row.rank === undefined ? {} : { rank: row.rank }), ...(row.metric === undefined ? {} : { metric: row.metric }) },
          },
        ];
      });
      const at = now();
      const kept = open().items.upsert(rows, { source: "agent", origin: "agent", ttlMs: RELAYED_TTL_MS, itemSet: input.itemSet }, at);
      return {
        itemSet: input.itemSet,
        kept: kept.map((item) => ({ itemId: item.itemId, url: item.url, title: item.title })),
        refused: input.items.length - rows.length,
        note: "Relayed rows are cited as read in the browser on their day, and never enter a series or count toward a spike.",
      };
    },

    /**
     * What a topic's items, or a set the agent relayed, say:
     * copies and coordinated bursts excluded, then themes with their shares,
     * keywords and verbatim quotes, and Other. Model-free; it sends nothing.
     */
    cluster(
      input: { readonly topicId?: string | undefined; readonly itemSet?: string | undefined; readonly minClusterSize?: number | undefined },
      context: CallContext,
    ) {
      const { store, items } = open();
      const at = now();
      if ((input.topicId === undefined) === (input.itemSet === undefined)) throw new Error("cluster takes a topicId or an itemSet");
      const topic = input.topicId === undefined ? undefined : store.topic(input.topicId, context.scope);
      // A topic's items of its sources' cache windows (three days at most); a set as it was relayed.
      // One more than is clustered, to know when some were left unread.
      const read =
        topic !== undefined
          ? items.forTopic(topic.topicId, new Date(Date.parse(at) - 3 * DAY_MS).toISOString(), at, CLUSTER_ITEMS_MAX + 1)
          : items.forSet(input.itemSet ?? "", at, CLUSTER_ITEMS_MAX + 1);
      const stored = read.slice(0, CLUSTER_ITEMS_MAX);
      const result = clusterItems(
        stored.map((item) => ({
          itemId: item.itemId,
          text: item.text === "" ? item.title : item.text,
          title: item.title,
          url: item.url,
          outlet: item.outlet,
          authorHash: item.authorHash,
          publishedAt: item.publishedAt,
        })),
        {
          // On the topic as the sweep read it: its own terms and the names Wikidata gave it.
          ...(topic === undefined ? {} : { terms: [...Object.values(topic.terms).flat(), ...cachedNames(topic)], exclude: topic.exclude }),
          ...(input.minClusterSize === undefined ? {} : { minClusterSize: input.minClusterSize }),
        },
      );
      return {
        ...(topic === undefined ? { itemSet: input.itemSet } : { topicId: topic.topicId, label: topic.label }),
        read: stored.length,
        ...(read.length > CLUSTER_ITEMS_MAX ? { capped: `only the newest ${String(CLUSTER_ITEMS_MAX)} items were read` } : {}),
        ...result,
        note: "Name each theme from its quotes; cite a quote by its itemId, and check the brief with trends.radar.brief. Shares are of the valid items; Other is what fits no theme.",
      };
    },

    /** Checks a brief against the store: model-free; it sends nothing. */
    brief(input: { readonly topicId: string; readonly bullets: readonly BriefBullet[] }, context: CallContext) {
      const { store, items } = open();
      const topic = store.topic(input.topicId, context.scope);
      const cited = [
        ...new Set(input.bullets.flatMap((bullet) => [...bullet.cites, ...(bullet.quotes ?? []).map((quote) => quote.itemId)])),
      ];
      const found = items.many(cited, now());
      return checkBrief({
        bullets: input.bullets,
        items: new Map(found.map((item) => [item.itemId, item])),
        tests: latestTests(topic.topicId),
        sourceOf,
      });
    },

    /**
     * What the heartbeat's spikes source sees, model-free and
     * quick: the person's raised topics as the last sweep left them. It
     * starts the next sweep when one is due and does not wait for it.
     */
    signals(
      scope: TopicScope & { readonly now: string },
    ): HeartbeatSignalLike[] | { readonly signals: HeartbeatSignalLike[]; readonly incomplete: true } {
      const inFlight = backgroundSweep();
      const { store } = open();
      const raised = store
        .topics(scope)
        .filter(
          (topic) =>
            !topic.paused &&
            (topic.state === "confirmed" || (topic.state === "signal" && topic.alert.corroboration === "allow_single_with_caveat")),
        );
      const signals = raised.slice(0, SIGNALS_MAX).map((topic): HeartbeatSignalLike => {
        const passing = latestTests(topic.topicId).filter((test) => test.passed === true);
        const kinds = [...new Set(passing.map((test) => test.kind))].sort();
        const growth = Math.max(0, ...passing.filter((test) => test.test === "count").map((test) => test.g));
        const percent = Math.round(growth * 100);
        const since = topic.stateSince ?? topic.updatedAt;
        const title = `${topic.label}: ${percent > 0 ? `+${String(percent)}% vs 7-day baseline` : "on a trending list"} (${kinds.join(", ")})`;
        return {
          key: `topic:${topic.topicId}:${topic.state}:${bucketStart(since, "hour").slice(0, 13)}`,
          // The state and the growth to the nearest 100%: a rise worth telling again changes it.
          hash: `${topic.state}:${String(Math.round(growth))}`,
          title: title.length > 120 ? `${title.slice(0, 119)}…` : title,
          at: scope.now,
          source: "Trends",
          data: { topicId: topic.topicId, state: topic.state, g: Number(growth.toFixed(2)), kinds, window: "24h" },
        };
      });
      // A sweep still running may raise more: the heartbeat hears this batch is not all.
      return inFlight ? { signals, incomplete: true } : signals;
    },

    /** The heartbeat's sweep, if one is running: tests wait for it. */
    settled(): Promise<unknown> {
      return running ?? Promise.resolve();
    },

    close(): void {
      stopping.abort();
      opened?.store.close();
      opened?.items.close();
      opened = undefined;
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
