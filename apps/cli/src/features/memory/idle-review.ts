import {
  isMemoryReviewFailureMark,
  memoryReviewFailureMark,
  memoryReviewMark,
  parseMemoryReviewMark,
  type EffectiveMemorySettings,
  type MemoryProvider,
  type MemoryReviewChat,
  type MemoryServicePort,
  type ModelPort,
  type ModelTarget,
  type PersistencePort,
  type TranscriptEntry,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import {
  MEMORY_REVIEW_DAILY_MAX,
  MEMORY_REVIEW_FAILURES_MAX,
  MEMORY_REVIEW_IDLE_MS,
  MEMORY_REVIEW_MIN_MESSAGES,
  MEMORY_REVIEW_RETRY_MS,
  memoryReviewPersonMessages,
  runMemoryReview,
  substantiveMessageCount,
} from "@tavi/agent-host/workflow";

import type { MemoryAutoApprove } from "./auto-approve.js";

/**
 * The idle review on the `tavi.memory` tick: automatic capture for a chat that went quiet, so what a
 * person said is proposed without waiting for the 416-message rollover.
 *
 * **Which chats.** An attended Home, side or ordinary chat with memory on
 * (`memoryReviewChats`: never a worker, a `run`, a messaging conversation —
 * a group's included —, a routine, a reminder or a heartbeat tick), idle at
 * least 10 minutes since its newest saved turn, with at least 3 new
 * substantive person messages since its mark (`substantiveMessageCount`).
 * The workspace must have memory on and `capture: "suggest"`; while it does
 * not, a quiet chat's mark is moved past what it said, so turning capture
 * back on never reviews what was said meanwhile. Only what was said after a
 * chat's memory was last turned back on is read, and a
 * saved turn marked `tainted` is left out.
 *
 * **Marks** (`tavi_memory_marks`, kind `review`, `memoryReviewMark`). A chat
 * with none is seeded at its newest turn saved before this job started, so
 * an upgrade never reviews history from before it (invariant 23). A review's
 * mark is claimed once its model call answered and before any draft is
 * filed, so a span is reviewed at most once across restarts (invariant 17).
 *
 * **Bounds**. At most one review a tick across the owner, the chat
 * idle longest first; at most 24 a person a day, failures included, counted
 * from the marks so a restart forgets nothing (invariant 24); a failure is
 * retried after an hour, and the third on one span moves the mark past it.
 * The model is the `extraction` role, else the chat's own, never a remote
 * one for a chat that used a local connection (`targetOf`); the call keeps
 * no copy of its request. One log line a review, counts only.
 */

export interface MemoryIdleReviewDependencies {
  readonly models: ModelPort;
  /** `list`, `history`, `search` and `get` read the titles a capture is told are kept already (`known`) and resolve `updatesRecordId`. */
  readonly memory: Pick<MemoryServicePort, "propose" | "list" | "history"> & Partial<Pick<MemoryServicePort, "search" | "get">>;
  readonly repositories: {
    readonly transcripts: Pick<
      PersistencePort["repositories"]["transcripts"],
      "memoryReviewChats" | "memoryMarksSince" | "claimMemoryMark" | "page"
    >;
    readonly tasks: Pick<PersistencePort["repositories"]["tasks"], "listAdmissions">;
  };
  readonly workspaces: () => readonly { readonly workspaceId: string }[];
  readonly memorySettings: (workspaceId: string) => Promise<EffectiveMemorySettings>;
  readonly timezoneOf: (workspaceId: string) => Promise<string>;
  /**
   * The memory provider that drafts a workspace's reviews:
   * the composition's registry's choice, an external one only with the
   * workspace's `conversation` switch on (the span is the person's words,
   * invariant 26), else the built-in `tavi.memoryprovider`. `knows` says
   * which records' titles it may be told (`known`): an external one's follow
   * `records` and `includePersonal`. Undefined, or one without `capture`:
   * the review fails, as a failed call does, and is retried an hour later.
   * Its id authors what it drafts (`provider:<id>:capture`, the built-in's as
   * first written).
   */
  readonly providerFor: (
    workspaceId: string,
    taskId: string,
  ) => MemoryReviewProvider | undefined | Promise<MemoryReviewProvider | undefined>;
  /**
   * The agent definition a chat runs as, when it has one (its checkpointed
   * persona): the review then reads that agent's own memory as `known`, as
   * the chat's flush does. Absent, or answering undefined: the chat has none.
   */
  readonly agentOf?: (workspaceId: string, taskId: string) => Promise<string | undefined>;
  /** The model a chat's review runs on, or undefined when none may (no model, or only a remote one for a chat that used a local one). */
  readonly targetOf: (workspaceId: string, taskId: string) => Promise<ModelTarget | undefined>;
  /**
   * Auto-approve: keeps what a review of the operator's own
   * chat proposed that *Keep without asking* covers, under its rule (the
   * quote check over the span's person messages), before its card is posted.
   */
  readonly autoApprove?: Pick<MemoryAutoApprove, "afterReview">;
  /** The review proposed `recordIds` in `taskId`, through saved turn `seq`: one memory card. */
  readonly onReviewed: (taskId: string, seq: number, recordIds: readonly string[]) => Promise<void>;
  readonly newId: (prefix: string) => string;
  readonly now: () => Date;
  /** When this job was created: a chat with no mark is seeded at its newest turn saved before it. */
  readonly startedAt: Date;
  /** Aborted when the owner stops: a review's call in flight ends now (a failure, retried an hour later). */
  readonly signal?: AbortSignal;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
}

/** The provider that drafts a workspace's review, and which records' titles it may be told. */
interface MemoryReviewProvider {
  readonly id: string;
  readonly provider: Pick<MemoryProvider, "capture">;
  readonly knows?: { readonly personal: boolean; readonly chat: boolean };
}

/** What `reviewNow` did with one chat. */
interface MemoryReviewNowChat {
  readonly taskId: string;
  /**
   * `reviewed` (its proposals in `filed`), `not-due` (fewer than three new
   * substantive person messages since its mark, or nothing new), `waiting`
   * (a failed review is retried an hour after it), `capped` (its person's 24
   * reviews today are spent), `no-model`, `capture-off` (memory paused or
   * capture off: its mark moved past what it said), `failed`, or
   * `not-eligible` (the chat named is not one the review reads: a worker's,
   * a `run` or messaging chat, or memory off along its parents).
   */
  readonly outcome: "reviewed" | "not-due" | "waiting" | "capped" | "no-model" | "capture-off" | "failed" | "not-eligible";
  readonly filed: readonly string[];
  readonly reason?: string;
}

export interface MemoryIdleReview {
  /** Seed what needs seeding, then start at most one review. Never throws. */
  tick(): Promise<void>;
  /**
   * `tavi memory review-now`: review every eligible chat of the workspace (or
   * the one named) now, ignoring the 10-minute idle wait and the
   * one-review-a-tick spacing; every other rule holds (eligibility and
   * exclusions, the seed of a chat seen first, three substantive messages,
   * the daily cap, the hour after a failure, the marks).
   */
  reviewNow(input: { readonly workspaceId: string; readonly taskId?: string }): Promise<readonly MemoryReviewNowChat[]>;
}

const DAY_MS = 86_400_000;
/** Saved turns one review reads at most, newest first: far past the 24,000 characters the span keeps. */
const REVIEW_ENTRIES_MAX = 400;
const PAGE = 100;

/**
 * Why a step failed, for the log: cut to 200 characters, as the vectors job
 * cuts its own, since a model's or a provider's error may quote what it
 * was sent — and a log line never carries memory text.
 */
const reasonOf = (error: unknown): string => errorMessage(error).slice(0, 200);

/** The saved turn a chat's review mark reads through; 0 for none. */
const markedSeq = (chat: MemoryReviewChat): number => (chat.review === undefined ? 0 : (parseMemoryReviewMark(chat.review.mark)?.seq ?? 0));

/** Whether a review mark counts toward the daily cap: a review that called the model (`claimed`), or a failure. */
function countsTowardReviewCap(mark: string): boolean {
  return isMemoryReviewFailureMark(mark) || parseMemoryReviewMark(mark)?.outcome === "claimed";
}

/**
 * Which of `admissionIds` came in from a messaging channel, as `taskId`'s
 * saved turns record it (`turn.channel`): the epoch flush leaves them
 * out, as the review does (invariant 6). Pages back from the newest saved turn
 * until each is found or `REVIEW_ENTRIES_MAX` were read; one not found was
 * never saved held, and stays in.
 */
export async function messagingTurnsOf(
  transcripts: Pick<PersistencePort["repositories"]["transcripts"], "page">,
  taskId: string,
  admissionIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const wanted = new Set(admissionIds);
  const held = new Set<string>();
  let before: number | undefined;
  let read = 0;
  while (wanted.size > 0 && read < REVIEW_ENTRIES_MAX) {
    const page = await transcripts.page(taskId, { ...(before === undefined ? {} : { before }), limit: PAGE });
    for (const entry of page.entries) {
      if (entry.admissionId === undefined || !wanted.has(entry.admissionId)) continue;
      wanted.delete(entry.admissionId);
      if (entry.turn.channel === "messaging") held.add(entry.admissionId);
    }
    read += page.entries.length;
    if (page.nextBefore === undefined || page.entries.length === 0) break;
    before = page.nextBefore;
  }
  return held;
}

export function createMemoryIdleReview(deps: MemoryIdleReviewDependencies): MemoryIdleReview {
  const { repositories } = deps;
  /**
   * Chats found not due at a newest turn: not read again until they have a
   * newer one, or, when parked with `until` (no model it may use), until then
   * (in-process only).
   */
  const notDue = new Map<string, { readonly seq: number; readonly until?: number }>();
  const parked = (chat: MemoryReviewChat, now: Date): boolean => {
    const found = notDue.get(chat.taskId);
    return found !== undefined && found.seq === chat.newestSeq && (found.until === undefined || now.getTime() < found.until);
  };

  /** The saved turns of `chat` after its mark, oldest first, at most `REVIEW_ENTRIES_MAX` of the newest. */
  const entriesAfter = async (chat: MemoryReviewChat, after: number): Promise<readonly TranscriptEntry[]> => {
    const entries: TranscriptEntry[] = [];
    let before: number | undefined = chat.newestSeq + 1;
    while (before !== undefined && entries.length < REVIEW_ENTRIES_MAX) {
      const page = await repositories.transcripts.page(chat.taskId, { before, limit: PAGE });
      const newer = page.entries.filter((entry) => entry.seq > after);
      entries.unshift(...newer);
      before = newer.length < page.entries.length ? undefined : page.nextBefore;
    }
    if (chat.memoryOnAt === undefined) return entries;
    // Turned back on: only turns admitted from then are read; one whose admission cannot be read is not.
    const admittedAt = new Map(
      (await repositories.tasks.listAdmissions(chat.taskId)).map((admission) => [admission.admissionId, admission.createdAt]),
    );
    const since = chat.memoryOnAt;
    return entries.filter((entry) => {
      const at = entry.admissionId === undefined ? undefined : admittedAt.get(entry.admissionId);
      return at !== undefined && at >= since;
    });
  };

  const claim = (taskId: string, mark: string, at: Date): Promise<boolean> =>
    repositories.transcripts.claimMemoryMark({ taskId, kind: "review", mark, at: at.toISOString() });

  /** One review of `chat` (due), on its workspace's settings. */
  const review = async (
    workspaceId: string,
    chat: MemoryReviewChat,
    entries: readonly TranscriptEntry[],
    settings: EffectiveMemorySettings,
    target: ModelTarget,
  ): Promise<{ readonly filed: readonly string[] } | { readonly failure: string }> => {
    const from = markedSeq(chat);
    const now = deps.now();
    // Once its span is claimed the review called the model: that claim already counts toward the day's cap,
    // and the mark has moved past the span, so a later failure writes no failure mark of its own (invariant 24).
    let claimed = false;
    try {
      // A time zone that cannot be read is left out, as one never set is.
      const timeZone = await deps.timezoneOf(workspaceId).catch(() => undefined);
      const installed = await deps.providerFor(workspaceId, chat.taskId);
      // No provider drafts here (the built-in disabled, none chosen): its span is passed by, as capture off passes it.
      if (installed?.provider.capture === undefined) {
        claimed = await claim(chat.taskId, memoryReviewMark({ seq: chat.newestSeq, outcome: "claimed" }), now);
        return { filed: [] };
      }
      // A persona that cannot be read is left out, as one never set is.
      const agentDefinitionId = await deps.agentOf?.(workspaceId, chat.taskId).catch(() => undefined);
      const result = await runMemoryReview({
        models: deps.models,
        memory: deps.memory,
        provider: installed.provider,
        providerId: installed.id,
        ...(installed.knows === undefined ? {} : { knows: installed.knows }),
        target,
        context: {
          workspaceId,
          principalId: chat.principalId,
          runId: chat.taskId,
          caller: "memory-review",
          ...(agentDefinitionId === undefined ? {} : { agentDefinitionId }),
        },
        entries,
        newId: deps.newId,
        now: () => deps.now().toISOString(),
        sensitive: settings.sensitive,
        ...(timeZone === undefined ? {} : { timeZone }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        claim: async () => (claimed = await claim(chat.taskId, memoryReviewMark({ seq: chat.newestSeq, outcome: "claimed" }), now)),
      });
      if (!result.claimed) return { failure: "its span was reviewed already" };
      await claim(
        chat.taskId,
        memoryReviewMark({ seq: chat.newestSeq, outcome: "reviewed", filed: result.recordIds.length, dropped: result.dropped }),
        now,
      );
      // Counts only, never memory text.
      deps.log("memory review ran", {
        workspaceId,
        taskId: chat.taskId,
        turns: entries.length,
        drafts: result.proposals,
        filed: result.recordIds.length,
        droppedSecret: result.dropped.secret,
        droppedSensitive: result.dropped.sensitive,
        droppedKnown: result.dropped.known,
        droppedSimilar: result.dropped.similar,
      });
      if (result.filed.length > 0 && deps.autoApprove !== undefined) {
        // Never throws: what it does not keep waits on the card as ever.
        await deps.autoApprove.afterReview({
          workspaceId,
          principalId: chat.principalId,
          taskId: chat.taskId,
          filed: result.filed,
          personMessages: memoryReviewPersonMessages(entries),
        });
      }
      if (result.recordIds.length > 0) {
        try {
          await deps.onReviewed(chat.taskId, chat.newestSeq, result.recordIds);
        } catch (error) {
          deps.log("a memory review's card could not be posted; its proposals still wait in the Center", {
            taskId: chat.taskId,
            reason: reasonOf(error),
          });
        }
      }
      return { filed: result.recordIds };
    } catch (error) {
      if (claimed) {
        deps.log("a memory review failed after its span was claimed; the span is not reviewed again", {
          workspaceId,
          taskId: chat.taskId,
          reason: reasonOf(error),
        });
        return { failure: reasonOf(error) };
      }
      // Counted toward the day's cap, retried after an hour; the third failure on this span moves the mark past it.
      const attempt = chat.failures + 1;
      await claim(chat.taskId, memoryReviewFailureMark(from, attempt), now);
      const skipped = attempt >= MEMORY_REVIEW_FAILURES_MAX;
      if (skipped) await claim(chat.taskId, memoryReviewMark({ seq: chat.newestSeq, outcome: "skipped" }), now);
      deps.log(
        skipped ? "a memory review failed three times; its span is skipped" : "a memory review failed; it is tried again in an hour",
        { workspaceId, taskId: chat.taskId, attempt, reason: reasonOf(error) },
      );
      return { failure: reasonOf(error) };
    }
  };

  type Candidate = { readonly workspaceId: string; readonly chat: MemoryReviewChat; readonly settings: EffectiveMemorySettings };

  /**
   * The chats that may be due: seeded at first sight, idle (unless
   * `immediate`), with something new since their mark, past a failure's hour and
   * (on the tick) not parked. `passed` hears each chat passed by and why.
   */
  const candidatesOf = async (
    now: Date,
    scope: { readonly workspaceId?: string; readonly taskId?: string; readonly immediate?: boolean },
    passed?: (taskId: string, outcome: "not-due" | "waiting" | "capture-off") => void,
  ): Promise<Candidate[]> => {
    const savedBefore = deps.startedAt.toISOString();
    const candidates: Candidate[] = [];
    for (const { workspaceId } of deps.workspaces()) {
      if (scope.workspaceId !== undefined && workspaceId !== scope.workspaceId) continue;
      try {
        const settings = await deps.memorySettings(workspaceId);
        const capturing = settings.enabled && settings.capture === "suggest";
        for (const found of await repositories.transcripts.memoryReviewChats({ workspaceId, savedBefore })) {
          if (scope.taskId !== undefined && found.taskId !== scope.taskId) continue;
          let chat = found;
          // First sight of a chat: history saved before this job started is never reviewed (invariant 23).
          if (chat.review === undefined) {
            const seed = memoryReviewMark({ seq: chat.seedSeq, outcome: "seed" });
            await claim(chat.taskId, seed, now);
            chat = { ...chat, review: { mark: seed, at: now.toISOString() }, failures: 0 };
          }
          const from = markedSeq(chat);
          if (chat.newestSeq <= from) {
            passed?.(chat.taskId, "not-due");
            continue;
          }
          if (scope.immediate !== true && now.getTime() - Date.parse(chat.newestAt) < MEMORY_REVIEW_IDLE_MS) continue;
          // Learning is off or memory paused: what the chat said meanwhile is never reviewed later.
          if (!capturing) {
            await claim(chat.taskId, memoryReviewMark({ seq: chat.newestSeq, outcome: "seed" }), now);
            passed?.(chat.taskId, "capture-off");
            continue;
          }
          if (
            chat.failures > 0 &&
            chat.lastFailureAt !== undefined &&
            now.getTime() - Date.parse(chat.lastFailureAt) < MEMORY_REVIEW_RETRY_MS
          ) {
            passed?.(chat.taskId, "waiting");
            continue;
          }
          if (scope.immediate !== true && parked(chat, now)) continue;
          candidates.push({ workspaceId, chat, settings });
        }
      } catch (error) {
        deps.log("memory reviews could not be checked", { workspaceId, reason: reasonOf(error) });
      }
    }
    // Idle longest first.
    candidates.sort(
      (left, right) => left.chat.newestAt.localeCompare(right.chat.newestAt) || left.chat.taskId.localeCompare(right.chat.taskId),
    );
    return candidates;
  };

  /** A person's reviews in the last day across the served workspaces, failures included (invariant 24). */
  const reviewsToday = async (principalId: string, now: Date): Promise<number> => {
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    let count = 0;
    for (const served of deps.workspaces()) {
      const marks = await repositories.transcripts.memoryMarksSince({ workspaceId: served.workspaceId, kind: "review", since });
      count += marks.filter((mark) => mark.principalId === principalId && countsTowardReviewCap(mark.mark)).length;
    }
    return count;
  };

  return {
    async reviewNow(input) {
      const now = deps.now();
      const results: MemoryReviewNowChat[] = [];
      const candidates = await candidatesOf(
        now,
        { workspaceId: input.workspaceId, ...(input.taskId === undefined ? {} : { taskId: input.taskId }), immediate: true },
        (taskId, outcome) => results.push({ taskId, outcome, filed: [] }),
      );
      for (const { workspaceId, chat, settings } of candidates) {
        try {
          const entries = await entriesAfter(chat, markedSeq(chat));
          if (substantiveMessageCount(entries) < MEMORY_REVIEW_MIN_MESSAGES) {
            results.push({ taskId: chat.taskId, outcome: "not-due", filed: [] });
            continue;
          }
          // Counted afresh each time: each review this call ran counts toward the 24.
          if ((await reviewsToday(chat.principalId, deps.now())) >= MEMORY_REVIEW_DAILY_MAX) {
            results.push({ taskId: chat.taskId, outcome: "capped", filed: [] });
            continue;
          }
          const target = await deps.targetOf(workspaceId, chat.taskId);
          if (target === undefined) {
            results.push({ taskId: chat.taskId, outcome: "no-model", filed: [] });
            continue;
          }
          const outcome = await review(workspaceId, chat, entries, settings, target);
          results.push(
            "failure" in outcome
              ? { taskId: chat.taskId, outcome: "failed", filed: [], reason: outcome.failure }
              : { taskId: chat.taskId, outcome: "reviewed", filed: outcome.filed },
          );
        } catch (error) {
          results.push({ taskId: chat.taskId, outcome: "failed", filed: [], reason: reasonOf(error) });
        }
      }
      // Every chat the review reads has an entry: a named chat with none is one it never reads.
      if (input.taskId !== undefined && results.length === 0) results.push({ taskId: input.taskId, outcome: "not-eligible", filed: [] });
      return results;
    },

    async tick() {
      const now = deps.now();
      /** Chats that may be due across the owner: idle, past their back-off, not parked. */
      const candidates = await candidatesOf(now, {});
      // Idle longest first; at most one review a tick across the owner. A chat's span is read only when its turn comes.
      const spent = new Map<string, number>();
      for (const candidate of candidates) {
        const { workspaceId, chat } = candidate;
        let entries: readonly TranscriptEntry[];
        try {
          entries = await entriesAfter(chat, markedSeq(chat));
        } catch (error) {
          deps.log("memory reviews could not be checked", { workspaceId, reason: reasonOf(error) });
          continue;
        }
        if (substantiveMessageCount(entries) < MEMORY_REVIEW_MIN_MESSAGES) {
          notDue.set(chat.taskId, { seq: chat.newestSeq });
          continue;
        }
        notDue.delete(chat.taskId);
        try {
          // The cap is per person per day (invariant 24): it counts that person's reviews in every workspace this owner serves.
          const key = chat.principalId;
          if (!spent.has(key)) spent.set(key, await reviewsToday(chat.principalId, now));
          // This person's day is spent: their chats wait, another's may go.
          if ((spent.get(key) ?? 0) >= MEMORY_REVIEW_DAILY_MAX) continue;
          const target = await deps.targetOf(workspaceId, chat.taskId);
          if (target === undefined) {
            // Looked at again after the retry interval, so a model bound meanwhile is used without a new turn.
            notDue.set(chat.taskId, { seq: chat.newestSeq, until: now.getTime() + MEMORY_REVIEW_RETRY_MS });
            deps.log("a memory review has no model it may use; the chat is not reviewed", { workspaceId, taskId: chat.taskId });
            continue;
          }
          await review(workspaceId, chat, entries, candidate.settings, target);
          return;
        } catch (error) {
          deps.log("a memory review could not run", { workspaceId, taskId: chat.taskId, reason: reasonOf(error) });
          return;
        }
      }
    },
  };
}

/** Doctor's line for the idle review: from the marks and the ledger, counts only. */
export interface MemoryIdleReviewDoctor {
  readonly capture: "suggest" | "off";
  /** When the last review (one that called the model) ran, in the last 30 days. */
  readonly lastReview: string | null;
  readonly today: {
    readonly reviews: number;
    readonly filed: number;
    readonly dropped: { readonly secret: number; readonly sensitive: number; readonly known: number; readonly similar: number };
    readonly failures: number;
    /** Spans skipped after three failures. */
    readonly skipped: number;
    readonly spend: {
      readonly calls: number;
      readonly failed: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly estimatedUsd: number;
    };
  };
}

/** Doctor's line from the review marks of the last 30 days (`month`), today's (`today`), and today's spend. */
export function memoryIdleReviewDoctor(input: {
  readonly capture: "suggest" | "off";
  readonly month: readonly { readonly mark: string; readonly at: string }[];
  readonly todaySince: string;
  readonly spend: MemoryIdleReviewDoctor["today"]["spend"];
}): MemoryIdleReviewDoctor {
  const dropped = { secret: 0, sensitive: 0, known: 0, similar: 0 };
  let reviews = 0;
  let filed = 0;
  let failures = 0;
  let skipped = 0;
  let lastReview: string | null = null;
  for (const { mark, at } of input.month) {
    const parsed = parseMemoryReviewMark(mark);
    if (parsed?.outcome === "claimed" && (lastReview === null || at > lastReview)) lastReview = at;
    if (at < input.todaySince) continue;
    if (isMemoryReviewFailureMark(mark)) failures += 1;
    else if (parsed?.outcome === "claimed") reviews += 1;
    else if (parsed?.outcome === "skipped") skipped += 1;
    else if (parsed?.outcome === "reviewed") {
      filed += parsed.filed;
      for (const reason of ["secret", "sensitive", "known", "similar"] as const) dropped[reason] += parsed.dropped[reason];
    }
  }
  return { capture: input.capture, lastReview, today: { reviews, filed, dropped, failures, skipped, spend: input.spend } };
}
