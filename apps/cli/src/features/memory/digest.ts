import {
  MEMORY_DIGEST_EVERY_DAYS,
  MEMORY_DIGEST_HOUR,
  MEMORY_DIGEST_ITEMS_MAX,
  MEMORY_DIGEST_NEAR_EXPIRY_DAYS,
  MEMORY_IPC_LIST_MAX,
  localDateTime,
  memoryDigestKey,
  type EffectiveMemorySettings,
  type MemoryItem,
  type MemoryListAnswer,
  type MemoryPayload,
  type MemoryServicePort,
  type PersistencePort,
  taviErrorOf,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import type { MemoryChannelCards } from "./channel-cards.js";
import { memoryCommand, type MemoryCommandDependencies } from "./owner.js";
import { memoryDateText } from "./slash.js";
import type { WriteGate } from "../../shared/write-gate.js";
import { type RepeatTimer, repeatEvery } from "@tavi/agent-host/schedule-scheduler";

/**
 * The review digest before proposals expire: what waits for each person,
 * gathered into one memory card
 * so nothing they were asked about lapses unseen (invariant 18).
 *
 * **Who and where.** The operator's digest is a card in their Home, sent on
 * to each of their delivery targets (`operatorTargetsOf`) that is a direct
 * chat of theirs. Without a Home whose memory is on (Home is off by default),
 * it goes to their most recently active attended chat whose memory is on —
 * a canvas or terminal chat — and on to the same targets, so the operator
 * is never left without one (invariant 18). Anyone else with waiting proposals gets it in their bound
 * direct conversation (its Home), the newest one when they have
 * several. A chat whose memory is off or private gets none. Email gets the
 * text with no actions, and buttons go only where the channel has them —
 * the same delivery and press handler as every memory card.
 *
 * **When.** At the first `tavi.memory` tick at or after 09:00 in the
 * workspace's `timezone`, at most once a local day per chat: weekly while
 * anything waits, and sooner when a proposal is within 7 days of expiring and
 * was proposed after the person's last digest (so the near-expiry rule never
 * sends a second one for a proposal a digest already showed). With
 * `digest: "off"` none goes out; while memory is paused it still does, since
 * it is about decisions, not recall.
 *
 * **Once.** A person's last digest is the newest `digest` mark on any of
 * their chats, so a digest that moves to another chat is still sent at most
 * once a day and weekly. The day's mark (`tavi_memory_marks`) is claimed after
 * the card is posted and before it is sent, so a second tick never repeats a
 * digest and a failed post is tried again; a restart in between repeats the
 * post and the sends as no-ops (one card per day's key, one send per effect id).
 *
 * **What.** At most 10 proposals, oldest expiry first, titles only — a
 * sensitive one is counted, never named — with "and N more — Review" past
 * them. Like every card it holds ids (invariant 22), and its *Keep all* keeps
 * only the plain proposals it lists, as every bulk keep does: updates,
 * conflicts and sensitive proposals stay waiting.
 */

/** What the digest reads and writes. */
export interface MemoryDigestDependencies {
  readonly memory: MemoryCommandDependencies["memory"] & Pick<MemoryServicePort, "principals">;
  readonly repositories: MemoryCommandDependencies["repositories"] &
    Pick<PersistencePort["repositories"], "messagingConversations"> & {
      readonly transcripts: Pick<
        PersistencePort["repositories"]["transcripts"],
        "getNotice" | "memoryPrompts" | "page" | "postMemoryCard" | "claimMemoryMark" | "memoryMarksOf" | "memoryReviewChats"
      >;
    };
  /** The workspaces this owner serves, each with its operator. */
  readonly workspaces: () => readonly { readonly workspaceId: string; readonly principalId: string }[];
  readonly memorySettings: (workspaceId: string) => Promise<EffectiveMemorySettings>;
  readonly timezoneOf: (workspaceId: string) => Promise<string>;
  /** The operator's enabled, authorized delivery targets (`operatorTargetsOf`). */
  readonly operatorTargets: (
    workspaceId: string,
    principalId: string,
  ) => Promise<readonly { readonly connectionId: string; readonly chatId: string }[]>;
  /** A memory card's delivery to a chat's channel: direct chats of the card's own person only. */
  readonly deliver: MemoryChannelCards["deliver"];
  readonly newId: (prefix: string) => string;
  readonly now: () => Date;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
}

export interface MemoryDigest {
  /** One pass over every workspace and person: whoever is due gets their digest. Never throws. */
  tick(): Promise<void>;
}

const DAY_MS = 86_400_000;
/** The most waiting proposals one person's digest reads, to count them; past it the count says "at least". */
const WAITING_READ_MAX = 10 * MEMORY_IPC_LIST_MAX;

/** `YYYY-MM-DD` of a local date. */
export function localDateKey(date: { readonly year: number; readonly month: number; readonly day: number }): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

/** Whole calendar days from one `YYYY-MM-DD` to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * The chat a person's background memory job writes to: the
 * operator's Home, or another person's bound direct conversation (its Home,
 * the newest when they have several), whose memory is on. Without one,
 * the operator's most recently active attended chat whose memory is on — a
 * canvas or terminal chat; never a messaging, worker, routine or heartbeat
 * task — and nothing for anyone else. The digest's card and its mark go
 * there, and consolidation's mark.
 */
export async function memoryChatOf(
  repositories: {
    readonly tasks: Pick<PersistencePort["repositories"]["tasks"], "homeOf" | "get">;
    readonly messagingConversations: Pick<PersistencePort["repositories"]["messagingConversations"], "directTasksOf">;
    readonly transcripts: Pick<PersistencePort["repositories"]["transcripts"], "memoryReviewChats">;
  },
  input: { readonly workspaceId: string; readonly principalId: string; readonly operator: boolean; readonly now: Date },
): Promise<string | undefined> {
  const { workspaceId, principalId, operator } = input;
  const candidates = operator
    ? [await repositories.tasks.homeOf(workspaceId, principalId)]
    : (await repositories.messagingConversations.directTasksOf(workspaceId, principalId)).map((mapping) => mapping.taskId);
  for (const taskId of candidates) {
    if (taskId === undefined) continue;
    const task = await repositories.tasks.get(taskId);
    // Memory off or private: no card is posted there.
    if (task !== undefined && task.workspaceId === workspaceId && task.principalId === principalId && task.memoryMode === undefined)
      return taskId;
  }
  if (!operator) return undefined;
  // No Home with memory on: the operator's most recently active attended chat whose memory is on.
  const chats = await repositories.transcripts.memoryReviewChats({ workspaceId, savedBefore: input.now.toISOString() });
  return chats
    .filter((chat) => chat.principalId === principalId)
    .sort((left, right) => right.newestAt.localeCompare(left.newestAt) || left.taskId.localeCompare(right.taskId))[0]?.taskId;
}

/** How long a proposal waits before it brings a digest: its own card was shown when it was made. */
const MEMORY_DIGEST_FRESH_MS = 60 * 60 * 1000;

/**
 * Whether a person whose last digest was `last` (its local date and when it
 * was sent) is due one `today`, with `waiting` proposals: weekly, or sooner
 * for a proposal near expiry that no digest has shown yet. A proposal made
 * within the hour brings none: its own card was just shown.
 */
export function memoryDigestDue(input: {
  readonly today: string;
  readonly now: Date;
  readonly last: { readonly mark: string; readonly at: string } | undefined;
  readonly waiting: readonly Pick<MemoryItem, "recordedAt" | "expiresAt">[];
}): boolean {
  const { last } = input;
  // A proposal made within the hour had its own card just now: a digest of it would only repeat that card.
  const settled = input.now.getTime() - MEMORY_DIGEST_FRESH_MS;
  const waiting = input.waiting.filter((record) => Date.parse(record.recordedAt) <= settled);
  if (waiting.length === 0) return false;
  if (last === undefined) return true;
  if (last.mark >= input.today) return false;
  if (daysBetween(last.mark, input.today) >= MEMORY_DIGEST_EVERY_DAYS) return true;
  const soon = input.now.getTime() + MEMORY_DIGEST_NEAR_EXPIRY_DAYS * DAY_MS;
  return waiting.some((record) => record.expiresAt !== undefined && Date.parse(record.expiresAt) <= soon && record.recordedAt > last.at);
}

export function createMemoryDigest(deps: MemoryDigestDependencies): MemoryDigest {
  const { repositories } = deps;

  /** The `memory` command as `principalId`, who sees and decides only their own memory (invariant 21). */
  const ipc = async <T>(workspaceId: string, principalId: string, payload: MemoryPayload): Promise<T> => {
    const answer = await memoryCommand(
      {
        memory: deps.memory,
        repositories,
        principalOf: (id) => (id === workspaceId ? principalId : undefined),
        fromBridge: false,
        caller: "operator:digest",
        now: deps.now,
        memorySettings: deps.memorySettings,
      },
      { ...payload, workspaceId } as MemoryPayload,
    );
    if (!answer.ok) throw taviErrorOf(answer.error);
    return answer.result as T;
  };

  /** A person's own waiting proposals, soonest to expire first: never the shared scope, which is the operator's to share. */
  const waitingOf = async (workspaceId: string, principalId: string): Promise<readonly MemoryItem[]> => {
    const records: MemoryItem[] = [];
    let cursor: string | undefined;
    do {
      const page: MemoryListAnswer = await ipc(workspaceId, principalId, {
        action: "list",
        statuses: ["proposed"],
        limit: MEMORY_IPC_LIST_MAX,
        ...(cursor === undefined ? {} : { cursor }),
      } as MemoryPayload);
      records.push(...page.records.filter((record) => record.target !== "shared"));
      cursor = page.nextCursor;
    } while (cursor !== undefined && records.length < WAITING_READ_MAX);
    return records.sort(
      (left, right) => (left.expiresAt ?? "").localeCompare(right.expiresAt ?? "") || left.recordedAt.localeCompare(right.recordedAt),
    );
  };

  /** The chat a person's digest goes to, when they have one whose memory is on. */
  const chatOf = async (workspaceId: string, principalId: string, operator: boolean): Promise<string | undefined> =>
    await memoryChatOf(repositories, { workspaceId, principalId, operator, now: deps.now() });

  const digestFor = async (input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly operator: boolean;
    readonly today: string;
    readonly timezone: string;
    readonly last: { readonly mark: string; readonly at: string } | undefined;
  }): Promise<void> => {
    const { workspaceId, principalId, last } = input;
    const now = deps.now();
    // Today's already out: the waiting list is not read again until tomorrow.
    if (last !== undefined && last.mark >= input.today) return;
    const waiting = await waitingOf(workspaceId, principalId);
    if (!memoryDigestDue({ today: input.today, now, last, waiting })) return;
    const taskId = await chatOf(workspaceId, principalId, input.operator);
    if (taskId === undefined) return;
    const listed = waiting.slice(0, MEMORY_DIGEST_ITEMS_MAX);
    const oldest =
      waiting
        .map((record) => record.expiresAt)
        .filter((at): at is string => at !== undefined)
        .sort()[0] ?? now.toISOString();
    const card = await repositories.transcripts.postMemoryCard({
      noticeId: deps.newId("notice"),
      taskId,
      sourceKey: memoryDigestKey(input.today),
      createdAt: now.toISOString(),
      records: listed.map((record) => ({ recordId: record.recordId, workspaceId, principalId })),
      digest: { waiting: waiting.length, oldestExpires: memoryDateText(oldest, input.timezone) },
    });
    // Claimed after the card is posted, so a failed post is tried again at the next tick. A restart
    // between the two repeats the post and the sends as no-ops: the card is one per day's key, and
    // each send one per effect id.
    if (!(await repositories.transcripts.claimMemoryMark({ taskId, kind: "digest", mark: input.today, at: now.toISOString() }))) return;
    const noticeId = card.notice.noticeId;
    if (input.operator) {
      // The operator's targets: each a send of its own; one that is not a direct chat of theirs gets nothing.
      const targets = new Map(
        (await deps.operatorTargets(workspaceId, principalId)).map((target) => [`${target.connectionId}:${target.chatId}`, target]),
      );
      for (const [sendKey, target] of targets) {
        await deps.deliver({
          noticeId,
          taskId,
          workspaceId,
          principalId,
          sendKey,
          replyTo: { connectionId: target.connectionId, externalConversationId: target.chatId, externalSenderId: target.chatId },
        });
      }
    } else {
      await deps.deliver({ noticeId, taskId, workspaceId, principalId });
    }
    // Counts only, never memory text.
    deps.log("memory digest sent", { workspaceId, taskId, waiting: waiting.length, listed: listed.length });
  };

  return {
    async tick() {
      for (const { workspaceId, principalId: operator } of deps.workspaces()) {
        try {
          if ((await deps.memorySettings(workspaceId)).digest === "off") continue;
          const timezone = await deps.timezoneOf(workspaceId);
          const local = localDateTime(deps.now(), timezone);
          if (local.hour < MEMORY_DIGEST_HOUR) continue;
          const today = localDateKey(local);
          const people = await deps.memory.principals({
            actor: { principalId: operator, workspaceId, caller: "digest", authority: "operator" },
            statuses: ["proposed"],
          });
          // Each person's newest digest, whichever of their chats it went to.
          const lastOf = new Map<string, { readonly mark: string; readonly at: string }>();
          for (const mark of await repositories.transcripts.memoryMarksOf({ workspaceId, kind: "digest" })) {
            const seen = lastOf.get(mark.principalId);
            if (seen === undefined || mark.at > seen.at || (mark.at === seen.at && mark.mark > seen.mark))
              lastOf.set(mark.principalId, { mark: mark.mark, at: mark.at });
          }
          for (const principalId of people) {
            try {
              await digestFor({
                workspaceId,
                principalId,
                operator: principalId === operator,
                today,
                timezone,
                last: lastOf.get(principalId),
              });
            } catch (error) {
              deps.log("a memory digest could not be sent; it is tried again at the next tick", {
                workspaceId,
                reason: errorMessage(error),
              });
            }
          }
        } catch (error) {
          deps.log("memory digests could not be checked", { workspaceId, reason: errorMessage(error) });
        }
      }
    },
  };
}

/**
 * The `tavi.memory` host's one tick: every
 * background memory job checks its own due time on it — the digest, the idle
 * review, the vector backfill and consolidation — rather than each
 * running a loop of its own. A tick that is still running when the next is
 * due is not overlapped. The first runs one interval after start.
 * `exclusive` runs an operator's job now (`tavi memory review-now`,
 * `reindex`, `consolidate-now`) between ticks, never beside one. With no
 * `everyMs` no timer starts: the jobs run only through `exclusive`. With a
 * `gate`, a tick that finds nothing written since the last and its idle
 * interval not yet over is skipped without a database call.
 */
export function startMemoryTick(input: {
  readonly everyMs?: number;
  readonly gate?: WriteGate;
  /** What runs the tick's timer; absent, `setInterval`. */
  readonly every?: RepeatTimer;
  readonly jobs: readonly (() => Promise<void>)[];
  readonly log: (message: string, fields: Record<string, unknown>) => void;
}): { readonly stop: () => void; readonly running: () => Promise<void>; readonly exclusive: <T>(job: () => Promise<T>) => Promise<T> } {
  let current: Promise<void> = Promise.resolve();
  let busy = false;
  const run = async (): Promise<void> => {
    for (const job of input.jobs) {
      try {
        await job();
      } catch (error) {
        input.log("a memory job failed", { reason: errorMessage(error) });
      }
    }
  };
  const stopTicks =
    input.everyMs === undefined
      ? undefined
      : (input.every ?? repeatEvery)(() => {
          if (busy || input.gate?.due() === false) return;
          busy = true;
          current = run().finally(() => {
            busy = false;
            input.gate?.ran();
          });
        }, input.everyMs);
  /** Jobs run now, in turn after whatever runs: the tick skips while one does. */
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(job: () => Promise<T>): Promise<T> => {
    const turn = queue.then(async () => {
      await current;
      busy = true;
      try {
        return await job();
      } finally {
        busy = false;
      }
    });
    // Ordering only: the work's own failure reaches its caller through the promise it was handed.
    queue = turn.catch(() => undefined);
    return turn;
  };
  return { stop: () => stopTicks?.(), running: () => Promise.all([current, queue]).then(() => undefined), exclusive };
}
