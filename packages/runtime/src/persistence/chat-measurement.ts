import { FOLLOW_UP_SQL } from "./task-list.js";
import type { Database } from "./sqlite-loader.js";

/**
 * Local measurement for `tavi doctor`:
 * how much each kind of chat costs per turn, how often a summarizer ran, and
 * how side chats are used. Read-only, computed from rows the runtime already
 * keeps, and never uploaded anywhere.
 */

/** How long after a side chat's settle notice a turn in its parent still counts as a return. */
export const SIDE_CHAT_RETURN_WINDOW_HOURS = 24;

/**
 * What chat a task is, read at query time from `tavi_tasks`: `home`, `side`,
 * `worker` and `run` from `chat_kind`; `messaging` for a
 * messaging-origin task with no chat kind (a channel conversation);
 * `chat` for anything else (an ordinary chat). A provider call whose run id
 * names no task (a router decision, an evaluation) is `unattributed`.
 */
export const MEASUREMENT_CHAT_KINDS = ["home", "side", "messaging", "worker", "run", "chat", "unattributed"] as const;
export type MeasurementChatKind = (typeof MEASUREMENT_CHAT_KINDS)[number];

const CHAT_KIND_SQL = `CASE
  WHEN t.task_id IS NULL THEN 'unattributed'
  WHEN t.chat_kind = 'home' THEN 'home'
  WHEN t.chat_kind = 'side' THEN 'side'
  WHEN t.chat_kind = 'worker' THEN 'worker'
  WHEN t.chat_kind = 'run' THEN 'run'
  WHEN t.origin = 'messaging' THEN 'messaging'
  ELSE 'chat' END`;

/**
 * Summarizer calls are `purpose: "summary"` provider attempts, told apart by
 * the attempt-id prefix each caller writes: `compaction-attempt-` (the stage-2
 * fold summary, `workflow.ts`), `epoch-flush-attempt-` (the epoch memory flush,
 * `epoch-flush.ts`) and `summary-` (a task's generated title and summary,
 * `task-summarizer.ts`). A summary call with none of these is `other`.
 */
const SUMMARY_KIND_SQL = `CASE
  WHEN p.attempt_id LIKE 'compaction-attempt-%' THEN 'compaction'
  WHEN p.attempt_id LIKE 'epoch-flush-attempt-%' THEN 'epochFlush'
  WHEN p.attempt_id LIKE 'summary-%' THEN 'taskSummary'
  ELSE 'other' END`;

export interface ChatKindUsage {
  readonly kind: MeasurementChatKind;
  /** Admissions that ran (claimed, committed or failed) on tasks of this kind. */
  readonly turns: number;
  /** Every recorded provider call, whatever its purpose. */
  readonly modelCalls: number;
  /** Calls with `purpose: "generation"`: the turn's own model calls. */
  readonly generationCalls: number;
  /** Generation calls whose provider reported no input-token count; left out of `inputTokens`. */
  readonly generationCallsWithoutUsage: number;
  /** Sum of `usage.inputTokens` over generation calls. */
  readonly inputTokens: number;
  /** `inputTokens / turns`, rounded; null with no turns. */
  readonly inputTokensPerTurn: number | null;
  readonly summarizerCalls: {
    readonly total: number;
    readonly compaction: number;
    readonly epochFlush: number;
    readonly taskSummary: number;
    readonly other: number;
  };
  /** Learning, evaluation and router calls. */
  readonly otherCalls: number;
}

export interface SideChatMeasurement {
  /** Tasks with `chat_kind = 'side'`. */
  readonly created: number;
  /**
   * The person's messages per side chat: its starting prompt plus every
   * follow-up prompt (a reply carrying text that was not refused).
   */
  readonly messages: { readonly total: number; readonly average: number | null; readonly median: number | null };
  /** Side chats whose settle posted a `side-chat-settled` notice into their parent. */
  readonly settled: number;
  /** Of `settled`: the parent got a prompt of the person's within the window after the notice's latest post. */
  readonly returned: number;
  /** Of `settled`: posted less than the window ago with no return yet, so not counted either way. */
  readonly awaitingWindow: number;
  /** `returned / (settled - awaitingWindow)`, to three places; null when nothing is decided. */
  readonly returnToParentRate: number | null;
  readonly returnWindowHours: number;
}

/** Cache reads over input tokens for one set of generation calls. */
export interface CacheReadShare {
  /** Completed calls whose provider reported both input tokens and cache-read tokens. */
  readonly calls: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  /** `cacheReadTokens / inputTokens`, to three places; null with no input tokens. */
  readonly share: number | null;
}

/**
 * How much of a chat kind's prompts a provider's prefix cache could reuse,
 * from completed generation calls recorded with their turn `step`
 * and `systemHash` (calls with neither are left out).
 */
export interface ChatKindPromptCache {
  readonly kind: MeasurementChatKind;
  /** The cache-read share of the turns' first calls, which follow the person's message. */
  readonly firstStep: CacheReadShare;
  /** The same over every later call of a turn, which repeat the turn's own prefix. */
  readonly laterSteps: CacheReadShare;
  /** Completed calls with a step whose provider did not report both input tokens and cache reads (it does not cache, or does not say). */
  readonly callsWithoutCacheUsage: number;
  /**
   * Of the turns whose first call has a turn before it in the same chat, how
   * many sent the same system text as that turn's first call. Recalled memory
   * and epoch summaries travel in the user-role context block, not the
   * system text, so below 1 means the persona, the chat's instructions or the
   * runtime facts changed between turns.
   */
  readonly firstStepPrefix: {
    readonly turnsCompared: number;
    readonly sameAsPreviousTurn: number;
    /** `sameAsPreviousTurn / turnsCompared`, to three places; null with nothing compared. */
    readonly share: number | null;
  };
}

/** How long back the per-site report and the churn counts read the ledger. */
export const SITE_USAGE_WINDOW_DAYS = 30;

/**
 * Token use of one caller (`MODEL_CALL_SITES`) over the window, from every
 * settled provider call recorded with that site. Calls from before sites were
 * recorded, or from a caller that sets none, are `unlabelled`.
 */
export interface SiteUsage {
  readonly site: string;
  readonly calls: number;
  /** Calls whose provider reported no input-token count. */
  readonly callsWithoutUsage: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  /** Calls whose provider's usage said nothing about its cache: their cache reads of 0 are unknown, not misses. */
  readonly cacheUsageUnreported: number;
  /** `cacheReadTokens / inputTokens`, to three places; null with no input tokens. */
  readonly cacheReadShare: number | null;
  /** Sum of the calls' estimated cost in USD, to four places; null when none had a price. */
  readonly estimatedUsd: number | null;
}

/**
 * What re-sends a chat's whole prefix, over the window: a turn whose first
 * call went to another model than the turn before it (a router's choice or a
 * failover), and a stage-2 fold, which rewrites the history after the system
 * text.
 */
export interface PrefixChurn {
  readonly windowDays: number;
  readonly modelSwitches: number;
  readonly chatsWithModelSwitch: number;
  readonly folds: number;
  readonly chatsWithFold: number;
}

export interface ChatMeasurement {
  /** Only kinds with a turn or a call, in `MEASUREMENT_CHAT_KINDS` order. */
  readonly usageByChatKind: readonly ChatKindUsage[];
  /** Only kinds with a measured call, in `MEASUREMENT_CHAT_KINDS` order. */
  readonly promptCacheByChatKind: readonly ChatKindPromptCache[];
  /** Only sites with a call in the window, most input tokens first. */
  readonly usageBySite: readonly SiteUsage[];
  readonly prefixChurn: PrefixChurn;
  readonly sideChats: SideChatMeasurement;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export function queryChatMeasurement(db: Database, input: { readonly now: string; readonly returnWindowHours?: number }): ChatMeasurement {
  const windowHours = input.returnWindowHours ?? SIDE_CHAT_RETURN_WINDOW_HOURS;
  const windowMs = windowHours * 3_600_000;

  // Columns only: parsing every attempt's `data` on each
  // `doctor` would read the whole ledger.
  const calls = db
    .prepare(`
    SELECT kind, purpose, summary_kind, count(*) AS calls,
      sum(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END) AS without_usage,
      coalesce(sum(input_tokens), 0) AS input_tokens
    FROM (
      SELECT ${CHAT_KIND_SQL} AS kind, p.purpose AS purpose,
        ${SUMMARY_KIND_SQL} AS summary_kind, p.input_tokens AS input_tokens
      FROM tavi_provider_attempts p LEFT JOIN tavi_tasks t ON t.task_id = p.run_id
    ) GROUP BY kind, purpose, summary_kind`)
    .all() as {
    kind: MeasurementChatKind;
    purpose: string;
    summary_kind: string;
    calls: number;
    without_usage: number;
    input_tokens: number;
  }[];
  const turns = db
    .prepare(`
    SELECT ${CHAT_KIND_SQL} AS measured_kind, count(*) AS turns
    FROM tavi_admissions a JOIN tavi_tasks t ON t.task_id = a.task_id
    WHERE a.state IN ('claimed', 'committed', 'failed') GROUP BY measured_kind`)
    .all() as { measured_kind: MeasurementChatKind; turns: number }[];

  const usageByChatKind = MEASUREMENT_CHAT_KINDS.flatMap((kind): ChatKindUsage[] => {
    const rows = calls.filter((row) => row.kind === kind);
    const turnCount = turns.find((row) => row.measured_kind === kind)?.turns ?? 0;
    if (rows.length === 0 && turnCount === 0) return [];
    const generation = rows.filter((row) => row.purpose === "generation");
    const summaries = rows.filter((row) => row.purpose === "summary");
    const sum = (list: typeof rows, field: "calls" | "without_usage" | "input_tokens") =>
      list.reduce((total, row) => total + row[field], 0);
    const summaryOf = (summaryKind: string) =>
      sum(
        summaries.filter((row) => row.summary_kind === summaryKind),
        "calls",
      );
    const inputTokens = sum(generation, "input_tokens");
    return [
      {
        kind,
        turns: turnCount,
        modelCalls: sum(rows, "calls"),
        generationCalls: sum(generation, "calls"),
        generationCallsWithoutUsage: sum(generation, "without_usage"),
        inputTokens,
        inputTokensPerTurn: turnCount === 0 ? null : Math.round(inputTokens / turnCount),
        summarizerCalls: {
          total: sum(summaries, "calls"),
          compaction: summaryOf("compaction"),
          epochFlush: summaryOf("epochFlush"),
          taskSummary: summaryOf("taskSummary"),
          other: summaryOf("other"),
        },
        otherCalls: sum(
          rows.filter((row) => row.purpose !== "generation" && row.purpose !== "summary"),
          "calls",
        ),
      },
    ];
  });

  const promptCacheByChatKind = queryPromptCache(db);
  const since = new Date(Date.parse(input.now) - SITE_USAGE_WINDOW_DAYS * 86_400_000).toISOString();
  const usageBySite = querySiteUsage(db, since);
  const prefixChurn = queryPrefixChurn(db, since);

  const sides = db
    .prepare(`
    SELECT s.task_id,
      (SELECT count(*) FROM tavi_admissions a WHERE a.task_id = s.task_id AND ((a.kind = 'start' AND a.state <> 'refused') OR ${FOLLOW_UP_SQL("a")})) AS messages,
      n.created_at AS settled_at,
      (SELECT min(a.created_at) FROM tavi_admissions a WHERE n.task_id IS NOT NULL AND a.task_id = n.task_id AND a.created_at > n.created_at
        AND ((a.kind = 'start' AND a.state <> 'refused') OR ${FOLLOW_UP_SQL("a")})) AS parent_turn_at
    FROM tavi_tasks s
    LEFT JOIN tavi_chat_notices n ON n.kind = 'side-chat-settled' AND n.source_task_id = s.task_id AND n.task_id = s.parent_chat_id
    WHERE s.chat_kind = 'side'`)
    .all() as { task_id: string; messages: number; settled_at: string | null; parent_turn_at: string | null }[];

  const counts = sides.map((row) => row.messages).sort((a, b) => a - b);
  const total = counts.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(counts.length / 2);
  const median = counts.length === 0 ? null : counts.length % 2 === 1 ? counts[middle]! : (counts[middle - 1]! + counts[middle]!) / 2;
  const now = Date.parse(input.now);
  let settled = 0;
  let returned = 0;
  let awaitingWindow = 0;
  for (const row of sides) {
    if (row.settled_at === null) continue;
    settled += 1;
    const posted = Date.parse(row.settled_at);
    if (row.parent_turn_at !== null && Date.parse(row.parent_turn_at) - posted <= windowMs) returned += 1;
    else if (now - posted < windowMs) awaitingWindow += 1;
  }
  const decided = settled - awaitingWindow;
  return {
    usageByChatKind,
    promptCacheByChatKind,
    usageBySite,
    prefixChurn,
    sideChats: {
      created: sides.length,
      messages: { total, average: counts.length === 0 ? null : round3(total / counts.length), median },
      settled,
      returned,
      awaitingWindow,
      returnToParentRate: decided === 0 ? null : round3(returned / decided),
      returnWindowHours: windowHours,
    },
  };
}

/**
 * The prompt-cache measurement. It reads `data` of completed
 * generation calls only: an attempt's row holds its
 * usage and ids, never its request, so the read stays small. A failed or
 * retried call is left out, so a retry of a turn's first call is not compared
 * with the call it replaced.
 */
function queryPromptCache(db: Database): ChatKindPromptCache[] {
  const measured = `SELECT ${CHAT_KIND_SQL} AS kind, p.run_id AS run_id, p.started_at AS started_at, p.call_id AS call_id,
      json_extract(p.data, '$.step') AS step, json_extract(p.data, '$.systemHash') AS system_hash,
      json_extract(p.data, '$.usage.inputTokens') AS input_tokens, json_extract(p.data, '$.usage.inputCacheReadTokens') AS cache_read
    FROM tavi_provider_attempts p LEFT JOIN tavi_tasks t ON t.task_id = p.run_id
    WHERE p.purpose = 'generation' AND p.state = 'completed'`;
  const shares = db
    .prepare(`
    SELECT kind, CASE WHEN step = 1 THEN 'first' ELSE 'later' END AS phase,
      sum(CASE WHEN input_tokens IS NOT NULL AND cache_read IS NOT NULL THEN 1 ELSE 0 END) AS calls,
      sum(CASE WHEN input_tokens IS NOT NULL AND cache_read IS NOT NULL THEN 0 ELSE 1 END) AS without_cache,
      coalesce(sum(CASE WHEN cache_read IS NOT NULL THEN input_tokens END), 0) AS input_tokens,
      coalesce(sum(CASE WHEN input_tokens IS NOT NULL THEN cache_read END), 0) AS cache_read
    FROM (${measured}) WHERE step IS NOT NULL GROUP BY kind, phase`)
    .all() as {
    kind: MeasurementChatKind;
    phase: "first" | "later";
    calls: number;
    without_cache: number;
    input_tokens: number;
    cache_read: number;
  }[];
  const prefixes = db
    .prepare(`
    SELECT kind, count(*) AS compared, sum(CASE WHEN system_hash = previous THEN 1 ELSE 0 END) AS same
    FROM (
      SELECT kind, system_hash, lag(system_hash) OVER (PARTITION BY run_id ORDER BY started_at, call_id) AS previous
      FROM (${measured}) WHERE step = 1 AND system_hash IS NOT NULL
    ) WHERE previous IS NOT NULL GROUP BY kind`)
    .all() as { kind: MeasurementChatKind; compared: number; same: number }[];

  const shareOf = (row: (typeof shares)[number] | undefined): CacheReadShare => {
    const inputTokens = row?.input_tokens ?? 0;
    const cacheReadTokens = row?.cache_read ?? 0;
    return {
      calls: row?.calls ?? 0,
      inputTokens,
      cacheReadTokens,
      share: inputTokens === 0 ? null : round3(cacheReadTokens / inputTokens),
    };
  };
  return MEASUREMENT_CHAT_KINDS.flatMap((kind): ChatKindPromptCache[] => {
    const first = shares.find((row) => row.kind === kind && row.phase === "first");
    const later = shares.find((row) => row.kind === kind && row.phase === "later");
    const prefix = prefixes.find((row) => row.kind === kind);
    if (first === undefined && later === undefined) return [];
    const turnsCompared = prefix?.compared ?? 0;
    const sameAsPreviousTurn = prefix?.same ?? 0;
    return [
      {
        kind,
        firstStep: shareOf(first),
        laterSteps: shareOf(later),
        callsWithoutCacheUsage: (first?.without_cache ?? 0) + (later?.without_cache ?? 0),
        firstStepPrefix: {
          turnsCompared,
          sameAsPreviousTurn,
          share: turnsCompared === 0 ? null : round3(sameAsPreviousTurn / turnsCompared),
        },
      },
    ];
  });
}

/** Per-site token use over the window (`SiteUsage`), from settled calls' recorded usage. */
function querySiteUsage(db: Database, since: string): SiteUsage[] {
  const rows = db
    .prepare(`
    SELECT coalesce(json_extract(data, '$.site'), 'unlabelled') AS site, count(*) AS calls,
      sum(CASE WHEN json_extract(data, '$.usage.inputTokens') IS NULL THEN 1 ELSE 0 END) AS without_usage,
      coalesce(sum(json_extract(data, '$.usage.inputTokens')), 0) AS input_tokens,
      coalesce(sum(json_extract(data, '$.usage.inputCacheReadTokens')), 0) AS cache_read,
      coalesce(sum(json_extract(data, '$.usage.inputCacheWriteTokens')), 0) AS cache_write,
      coalesce(sum(json_extract(data, '$.usage.outputTokens')), 0) AS output_tokens,
      coalesce(sum(json_extract(data, '$.usage.outputReasoningTokens')), 0) AS reasoning_tokens,
      sum(CASE WHEN json_extract(data, '$.usage.cacheUsageReported') = 0 THEN 1 ELSE 0 END) AS unreported,
      sum(json_extract(data, '$.estimatedUsd')) AS usd
    FROM tavi_provider_attempts WHERE state <> 'started' AND started_at >= ?
    GROUP BY site ORDER BY input_tokens DESC, site`)
    .all(since) as {
    site: string;
    calls: number;
    without_usage: number;
    input_tokens: number;
    cache_read: number;
    cache_write: number;
    output_tokens: number;
    reasoning_tokens: number;
    unreported: number;
    usd: number | null;
  }[];
  return rows.map((row) => ({
    site: row.site,
    calls: row.calls,
    callsWithoutUsage: row.without_usage,
    inputTokens: row.input_tokens,
    cacheReadTokens: row.cache_read,
    cacheWriteTokens: row.cache_write,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    cacheUsageUnreported: row.unreported,
    cacheReadShare: row.input_tokens === 0 ? null : round3(row.cache_read / row.input_tokens),
    estimatedUsd: row.usd === null ? null : Math.round(row.usd * 10_000) / 10_000,
  }));
}

/** Model switches between turns and stage-2 folds over the window (`PrefixChurn`). */
function queryPrefixChurn(db: Database, since: string): PrefixChurn {
  const switches = db
    .prepare(`
    SELECT count(*) AS switches, count(DISTINCT run_id) AS chats FROM (
      SELECT run_id, connection_id || '/' || model AS target,
        lag(connection_id || '/' || model) OVER (PARTITION BY run_id ORDER BY started_at, call_id) AS previous
      FROM (
        SELECT run_id, call_id, started_at, json_extract(data, '$.connectionId') AS connection_id, json_extract(data, '$.model') AS model
        FROM tavi_provider_attempts
        WHERE purpose = 'generation' AND state = 'completed' AND json_extract(data, '$.step') = 1 AND started_at >= ?
      )
    ) WHERE previous IS NOT NULL AND target <> previous`)
    .get(since) as { switches: number; chats: number };
  const folds = db
    .prepare(`
    SELECT count(*) AS folds, count(DISTINCT run_id) AS chats FROM tavi_provider_attempts
    WHERE purpose = 'summary' AND state = 'completed' AND attempt_id LIKE 'compaction-attempt-%' AND started_at >= ?`)
    .get(since) as { folds: number; chats: number };
  return {
    windowDays: SITE_USAGE_WINDOW_DAYS,
    modelSwitches: switches.switches,
    chatsWithModelSwitch: switches.chats,
    folds: folds.folds,
    chatsWithFold: folds.chats,
  };
}
