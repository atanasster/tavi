import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_WORKSPACE_ID,
  FOLDER_BUDGET_WARN_FRACTION,
  HEARTBEAT_LIMITS,
  TaviError,
  heartbeatHostAllowed,
  heartbeatWatchedPages,
  memoryExcerptHead,
  type HeartbeatSignal,
  type HeartbeatSignalBatch,
  type HeartbeatSignalSource,
  type HeartbeatState,
  type ConnectableApp,
  type MemoryExcerpt,
  type MemoryServicePort,
  type NeedRow,
  type PersistencePort,
  type ScheduleFireRecord,
  SCHEDULE_FIRES_KEPT,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";
import { HeartbeatSignalRegistry, collectHeartbeatSignals } from "@tavi/agent-host/heartbeat-host";
import { retrievalKeywordsFrom } from "@tavi/agent-host/workflow";

import { listNeeds } from "../approvals/inbox.js";

/**
 * The built-in signal sources (`tavi.heartbeatsignals`): model-free reads of what is already in the store, per heartbeat, each
 * signal a stable key and a hash that changes when the thing does. Bounded,
 * indexed reads only: unanswered messages, failed or bounced sends and failed
 * routine runs read through indexes kept for them.
 */

const MINUTE = 60_000;

/** A need is worth a signal once it has waited this long, or when its deadline is this close. */
const HEARTBEAT_NEED_WAIT_MS = 30 * MINUTE;
const HEARTBEAT_NEED_DEADLINE_MS = 60 * MINUTE;
/** A message from someone else is worth a signal once it has waited this long with no answer, and for a week. */
const HEARTBEAT_MESSAGE_WAIT_MS = 60 * MINUTE;
const HEARTBEAT_MESSAGE_WINDOW_MS = 7 * 24 * 60 * MINUTE;
/** Failed sends and failed routine runs are signals for a day. */
const HEARTBEAT_FAILURE_WINDOW_MS = 24 * 60 * MINUTE;

/** An id as part of a signal key: itself when it fits the key alphabet, else a short hash of it. */
const keyPart = (id: string): string => (/^[A-Za-z0-9_.:@/-]{1,64}$/.test(id) ? id : sha256Hex(id).slice(0, 24));

/** Reminders and agenda items due within this look-ahead. */
const HEARTBEAT_AGENDA_LOOKAHEAD_MS = 120 * MINUTE;

type Repositories = Pick<
  PersistencePort["repositories"],
  "approvalInbox" | "center" | "schedules" | "messagingConnections" | "messagingInbox" | "heartbeats"
>;

/** Whose need it is: the person it waits on. */
export const principalOfNeed = (need: NeedRow): string => {
  switch (need.kind) {
    case "question":
      return need.question.principalId;
    case "approval":
      return need.approval.principalId;
    case "review":
      return need.review.principalId;
    case "connect":
      return need.connect.principalId;
  }
};

const titleOfNeed = (need: NeedRow): string => {
  switch (need.kind) {
    case "question":
      return `A question waits for you: ${need.question.question}`;
    case "approval":
      return `An approval waits for you: ${need.approval.summary ?? need.approval.toolId}`;
    case "review":
      return "A review waits for you";
    case "connect":
      return `${need.connect.appName} needs signing in again`;
  }
};

/** The pages the built-in sources read: a full page may have cut the list short. */
const AGENDA_PAGE = 50;
const HELD_PAGE = 200;
const LIST_PAGE = 50;

/** A list read in full is the signals; one cut at its page is a batch that saw only part, so what it missed is not taken for gone. */
function seenPart(cut: boolean, signals: readonly HeartbeatSignal[]): readonly HeartbeatSignal[] | HeartbeatSignalBatch {
  return cut ? { signals, incomplete: true } : signals;
}

/** A schedule's outcome for a fire that never ran (missed, overlapped, refused for space, disabled): not a failure. */
const notRun = (outcome: string | null): boolean => outcome !== null && /^(?:skipped|refused|disabled): /.test(outcome);

/**
 * The fires missed in a row, newest first: counted from the newest fire while
 * nothing ran at it (`missed`), past manual runs, which are not the schedule's
 * own, and refused webhook calls and emails, which started nothing; a skip for
 * overlap or a full disk, or any run, ends it.
 */
function missedStreak(fires: readonly ScheduleFireRecord[]): { readonly count: number; readonly latest: ScheduleFireRecord } | undefined {
  let count = 0;
  let latest: ScheduleFireRecord | undefined;
  for (const fire of fires) {
    if (fire.reasonCode === "manual" || fire.reasonCode === "webhook-refused" || fire.reasonCode === "email-refused") continue;
    if (fire.reasonCode !== "missed") break;
    latest ??= fire;
    count += 1;
  }
  return latest === undefined ? undefined : { count, latest };
}

export interface BuiltinHeartbeatSourceOptions {
  /**
   * The routine whose trigger each schedule is, if any, in their order (one call for them all): its runs are the
   * routines source's, not a schedule's.
   */
  readonly routineOwners?: (scheduleIds: readonly string[]) => Promise<readonly unknown[]> | readonly unknown[];
}

/** The built-in sources for one heartbeat's scope. */
export function builtinHeartbeatSources(
  repositories: Repositories,
  options: BuiltinHeartbeatSourceOptions = {},
): readonly HeartbeatSignalSource[] {
  const needs: HeartbeatSignalSource = {
    id: "needs",
    offer: "Approvals or questions waiting more than an hour",
    async collect(scope) {
      const now = scope.now;
      const at = Date.parse(now);
      const { needs: rows, truncated } = await listNeeds(repositories, { workspaceId: scope.workspaceId, limit: 100 });
      return seenPart(
        truncated,
        rows
          .filter((need) => principalOfNeed(need) === scope.principalId)
          .flatMap((need): HeartbeatSignal[] => {
            const waited = at - Date.parse(need.askedAt) >= HEARTBEAT_NEED_WAIT_MS;
            const close = need.deadlineAt !== undefined && Date.parse(need.deadlineAt) - at <= HEARTBEAT_NEED_DEADLINE_MS;
            if (!waited && !close) return [];
            return [
              {
                key: need.needId,
                hash: close ? "deadline" : "waiting",
                title: titleOfNeed(need).slice(0, 120),
                at: need.askedAt,
                source: "Waiting on you",
                data: { taskId: need.taskId, kind: need.kind, ...(need.deadlineAt === undefined ? {} : { deadlineAt: need.deadlineAt }) },
              },
            ];
          }),
      );
    },
  };
  const agenda: HeartbeatSignalSource = {
    id: "agenda",
    offer: "Reminders and events in the next 2 hours",
    // Something coming up leaves the list when its time passes; nothing was resolved.
    retracts: false,
    async collect(scope) {
      const now = scope.now;
      const from = new Date(now);
      const until = new Date(from.getTime() + HEARTBEAT_AGENDA_LOOKAHEAD_MS);
      const { items } = await repositories.center.agenda({
        workspaceId: scope.workspaceId,
        now: from.toISOString(),
        from: from.toISOString(),
        until: until.toISOString(),
        limit: AGENDA_PAGE,
      });
      // Only the person's own: a reminder names its principal; a schedule's is its record's. A routine's owner is
      // not on its agenda item, so routines are left out rather than shown to someone else.
      const mySchedules = new Set(
        (await repositories.schedules.list(scope.workspaceId))
          .filter((schedule) => schedule.principalId === scope.principalId)
          .map((schedule) => schedule.scheduleId),
      );
      return seenPart(
        items.length >= AGENDA_PAGE,
        items
          .filter(
            (item) =>
              item.enabled &&
              (item.kind === "reminder" ? item.principalId === scope.principalId : item.kind === "schedule" && mySchedules.has(item.id)),
          )
          .map((item) => ({
            key: `${item.kind}:${item.id}:${item.at}`,
            hash: item.at,
            title: `Coming up: ${item.title}`.slice(0, 120),
            at: item.at,
            source: item.kind === "reminder" ? "Reminders" : "Schedule",
            data: { kind: item.kind, id: item.id },
          })),
      );
    },
  };
  // The person's plain schedules whose runs failed, or whose latest fires were missed; a routine's trigger rows are the
  // routines source's.
  const schedules: HeartbeatSignalSource = {
    id: "schedules",
    offer: "Scheduled runs that fail",
    async collect(scope) {
      const own = (await repositories.schedules.list(scope.workspaceId)).filter(
        (schedule) => schedule.principalId === scope.principalId && schedule.enabled,
      );
      if (own.length === 0) return [];
      const owners = (await options.routineOwners?.(own.map((schedule) => schedule.scheduleId))) ?? [];
      const plain = own.filter((_, index) => owners[index] === undefined);
      // A failure before any run started (a fire that threw early) counts too: it is dated by the row's last change.
      const failed = plain
        .filter((schedule) => schedule.consecutiveFailures > 0)
        .map((schedule) => ({
          key: schedule.scheduleId,
          // The last run that started and the failures in a row: a fire missed or skipped since changes neither.
          hash: `${schedule.lastRunAt ?? ""}:${schedule.consecutiveFailures}`,
          title: `The schedule ${schedule.name} failed`.slice(0, 120),
          at: schedule.lastRunAt ?? schedule.updatedAt,
          source: "Schedules",
          // A fire not run since the failures (missed, overlapped, refused) is said apart, never as the failure.
          data: { failures: schedule.consecutiveFailures, ...(notRun(schedule.lastOutcome) ? { latest: "not run" } : {}) },
        }));
      // Every plain schedule's recent fires in one read.
      const recent =
        plain.length === 0
          ? []
          : await repositories.schedules.latestFires(
              plain.map((schedule) => schedule.scheduleId),
              SCHEDULE_FIRES_KEPT,
            );
      const missed = plain.flatMap((schedule, index): HeartbeatSignal[] => {
        const streak = missedStreak(recent[index] ?? []);
        if (streak === undefined) return [];
        return [
          {
            key: `${keyPart(schedule.scheduleId)}:missed`,
            // The newest miss and how many: another miss changes it, a run ends it.
            hash: `${streak.latest.fireTime}:${streak.count}`,
            title: (streak.count === 1
              ? `The schedule ${schedule.name} missed its run`
              : `The schedule ${schedule.name} missed ${streak.count} times in a row`
            ).slice(0, 120),
            at: streak.latest.at,
            source: "Schedules",
            data: { missed: streak.count },
          },
        ];
      });
      return [...failed, ...missed];
    },
  };
  const held: HeartbeatSignalSource = {
    id: "held",
    offer: "Messages held for my review",
    async collect(scope) {
      const mine = new Set((await repositories.messagingConnections.list(scope.workspaceId)).map((connection) => connection.connectionId));
      // Held rows are listed across workspaces, oldest first: read a wider page, then keep this workspace's, for this
      // person or for no one yet (an unbound sender is the operator's to review).
      // This workspace's connections only, so other workspaces' backlog never crowds its held messages out.
      const { held: rows } = await repositories.messagingInbox.listHeld({ limit: HELD_PAGE, connectionIds: [...mine] });
      // The sender is outside text: named in the title, which every surface treats as untrusted.
      return seenPart(
        rows.length >= HELD_PAGE,
        rows
          .filter(
            (row) => mine.has(row.connectionId) && (row.resolvedPrincipalId === null || row.resolvedPrincipalId === scope.principalId),
          )
          .map((row) => ({
            key: `${keyPart(row.connectionId)}:${keyPart(row.providerEventId)}`,
            hash: "held",
            title: `A message is held for review from ${row.externalSenderId}`.slice(0, 120),
            at: row.receivedAt,
            source: "Channels",
          })),
      );
    },
  };
  /** A channel's name, as its owner labelled it. */
  const channelName = async (workspaceId: string): Promise<(connectionId: string) => string> => {
    const labels = new Map(
      (await repositories.messagingConnections.list(workspaceId)).map((connection) => [
        connection.connectionId,
        connection.label ?? connection.providerId,
      ]),
    );
    return (connectionId) => labels.get(connectionId) ?? "a channel";
  };
  // A message from someone else with no answer after an hour: a newer message in the conversation is a new signal.
  const messages: HeartbeatSignalSource = {
    id: "messages",
    offer: "Messages that wait over an hour for an answer",
    async collect(scope) {
      const at = Date.parse(scope.now);
      const rows = await repositories.heartbeats.unansweredMessages({
        workspaceId: scope.workspaceId,
        principalId: scope.principalId,
        since: new Date(at - HEARTBEAT_MESSAGE_WINDOW_MS).toISOString(),
        before: new Date(at - HEARTBEAT_MESSAGE_WAIT_MS).toISOString(),
        limit: LIST_PAGE,
      });
      const name = await channelName(scope.workspaceId);
      return seenPart(
        rows.length >= LIST_PAGE,
        rows.map((row) => ({
          key: `message:${keyPart(row.connectionId)}:${keyPart(row.conversationKey)}`,
          hash: sha256Hex(row.providerEventId).slice(0, 32),
          title: `A message on ${name(row.connectionId)} has waited over an hour for an answer`.slice(0, 120),
          at: row.receivedAt,
          source: "Channels",
          data: { connectionId: row.connectionId, ...(row.taskId === undefined ? {} : { taskId: row.taskId }) },
        })),
      );
    },
  };
  // A send a channel reported bounced or failed in the last day.
  const sends: HeartbeatSignalSource = {
    id: "sends",
    offer: "Messages that bounce or fail to send",
    // A failed send leaves the list after a day; nothing was fixed.
    retracts: false,
    async collect(scope) {
      const rows = await repositories.heartbeats.failedSends({
        workspaceId: scope.workspaceId,
        since: new Date(Date.parse(scope.now) - HEARTBEAT_FAILURE_WINDOW_MS).toISOString(),
        limit: LIST_PAGE,
      });
      const name = await channelName(scope.workspaceId);
      return seenPart(
        rows.length >= LIST_PAGE,
        rows.map((row) => ({
          key: `send:${keyPart(row.connectionId)}:${keyPart(row.providerMessageId)}`,
          hash: row.status,
          title: `A message on ${name(row.connectionId)} ${row.status === "bounced" ? "bounced" : "failed to deliver"}`.slice(0, 120),
          at: row.statusAt,
          source: "Channels",
          data: { connectionId: row.connectionId, status: row.status },
        })),
      );
    },
  };
  // A routine run of the person's that failed in the last day.
  const routines: HeartbeatSignalSource = {
    id: "routines",
    offer: "Routines that fail",
    // A failed run leaves the list after a day; nothing was fixed.
    retracts: false,
    async collect(scope) {
      const rows = await repositories.heartbeats.failedRoutineRuns({
        workspaceId: scope.workspaceId,
        principalId: scope.principalId,
        since: new Date(Date.parse(scope.now) - HEARTBEAT_FAILURE_WINDOW_MS).toISOString(),
        limit: LIST_PAGE,
      });
      return seenPart(
        rows.length >= LIST_PAGE,
        rows.map((row) => ({
          key: `routine-run:${keyPart(row.runId)}`,
          hash: "failed",
          title: `Routine ${row.name} failed`.slice(0, 120),
          at: row.endedAt,
          source: "Routines",
          data: { routineId: row.routineId, runId: row.runId },
        })),
      );
    },
  };
  return [needs, agenda, schedules, held, messages, sends, routines];
}

/** One watched page is read at most this often, whether the read worked or not; between reads its last reading stands. */
const HEARTBEAT_PAGE_EVERY_MS = 60 * MINUTE;
/** A page read runs on its own, outside a collection's deadline, within this long. */
const PAGE_READ_DEADLINE_MS = 30_000;
/** How much of a page's text its signal carries at most, for the provider to see what it says now; less when it is multi-byte. */
const PAGE_EXCERPT_CHARS = 1_500;

export interface WatchedPagesDependencies {
  readonly heartbeats: Pick<PersistencePort["repositories"]["heartbeats"], "get">;
  /** One guarded fetch of `url`, dialling only `allowedHosts`: its status and readable text. */
  readonly fetchPage: (
    url: string,
    allowedHosts: readonly string[],
    signal: AbortSignal,
  ) => Promise<{ readonly status: number; readonly text: string }>;
  /** When a page could not be read; it is read again an hour on. */
  readonly log?: (message: string, fields: Record<string, unknown>) => void;
}

/** The signal's data within its size limit: the excerpt is cut by bytes, and an address too long for it is left out. */
function pageData(url: string, line: number, excerpt: string): Record<string, unknown> {
  const fits = (data: Record<string, unknown>): boolean =>
    new TextEncoder().encode(JSON.stringify(data)).length <= HEARTBEAT_LIMITS.signalDataBytes;
  let text = excerpt;
  const withUrl = (): Record<string, unknown> => ({ url, instructionLine: line, text });
  while (text.length > 0 && !fits(withUrl())) text = text.slice(0, Math.floor(text.length * 0.8));
  if (fits(withUrl())) return withUrl();
  text = excerpt;
  const withoutUrl = (): Record<string, unknown> => ({ instructionLine: line, text });
  while (text.length > 0 && !fits(withoutUrl())) text = text.slice(0, Math.floor(text.length * 0.8));
  return withoutUrl();
}

/**
 * Watched pages: each `watch:` line whose host
 * the heartbeat may read (`fetchHosts`) is read at most hourly, and its signal
 * is hashed over what the page says, so a change is new and the same page is
 * not. A host never approved is never fetched. Reads run on their own, so a
 * slow page never holds up a collection: a collection answers the last
 * readings, and a page read for the first time shows from the next one. An
 * error answer or a failed read keeps the last reading. What a page says is
 * untrusted text, as every signal is.
 */
export function watchedPagesSource(deps: WatchedPagesDependencies): HeartbeatSignalSource {
  /** Each person's last reading of each page. */
  const readings = new Map<string, { readonly at: number; readonly hash: string; readonly excerpt: string }>();
  /** When each page was last tried, worked or not: once an hour. */
  const tried = new Map<string, number>();
  const reading = new Set<string>();
  const read = async (slot: string, url: string, allowedHosts: readonly string[], at: number): Promise<void> => {
    reading.add(slot);
    tried.set(slot, at);
    try {
      const { status, text } = await deps.fetchPage(url, allowedHosts, AbortSignal.timeout(PAGE_READ_DEADLINE_MS));
      // An error page says nothing about the page: a passing outage is not a change.
      if (status < 200 || status >= 300) {
        deps.log?.("a watched page answered an error; its last reading stands", { url, status });
        return;
      }
      const normalized = text.replace(/\s+/g, " ").trim();
      readings.set(slot, { at, excerpt: normalized.slice(0, PAGE_EXCERPT_CHARS), hash: sha256Hex(normalized) });
    } catch (error) {
      deps.log?.("a watched page could not be read; its last reading stands", { url, error: errorMessage(error) });
    } finally {
      reading.delete(slot);
    }
  };
  return {
    id: "pages",
    async collect(scope) {
      const state = await deps.heartbeats.get(scope.workspaceId, scope.principalId);
      if (state === undefined) return [];
      const at = Date.parse(scope.now);
      const prefix = `${scope.workspaceId}\u0000${scope.principalId}\u0000`;
      const watched = heartbeatWatchedPages(state.config.instructions).filter((page) =>
        heartbeatHostAllowed(page.host, state.config.fetchHosts),
      );
      const signals: HeartbeatSignal[] = [];
      // A page with no reading yet (the owner just started, or it has not answered) is unseen, not gone.
      let unread = false;
      for (const page of watched) {
        const slot = `${prefix}${page.url}`;
        const last = tried.get(slot);
        if (!reading.has(slot) && (last === undefined || at - last >= HEARTBEAT_PAGE_EVERY_MS))
          void read(slot, page.url, [...state.config.fetchHosts], at);
        const current = readings.get(slot);
        if (current === undefined) {
          unread = true;
          continue;
        }
        signals.push({
          key: `page:${sha256Hex(page.url).slice(0, 24)}`,
          hash: current.hash,
          title: `A page you watch: ${page.url.replace(/^https:\/\//, "")}`.slice(0, 120),
          at: new Date(current.at).toISOString(),
          source: "Watched page",
          data: pageData(page.url, page.line, current.excerpt),
        });
      }
      // Pages no longer watched, or no longer allowed, are forgotten.
      const live = new Set(watched.map((page) => `${prefix}${page.url}`));
      for (const slot of [...readings.keys(), ...tried.keys()]) {
        if (slot.startsWith(prefix) && !live.has(slot)) {
          readings.delete(slot);
          tried.delete(slot);
        }
      }
      return seenPart(unread, signals);
    },
  };
}

/**
 * A heartbeat tick's memory context: the person's accepted preferences,
 * then the records search finds for the instructions (a deep look) or the new
 * signals' titles. Their own scopes only — the actor names no run, so no
 * run-local record, and shared workspace memory is left out; search reads
 * approved current revisions alone.
 */
export async function heartbeatMemoryContext(
  memory: Pick<MemoryServicePort, "resolvePreferences" | "search">,
  state: HeartbeatState,
  query: { readonly kind: "signal" | "deep"; readonly signals: readonly HeartbeatSignal[] },
): Promise<readonly MemoryExcerpt[]> {
  const actor = {
    workspaceId: state.workspaceId,
    principalId: state.principalId,
    ...(state.config.agentId === undefined ? {} : { agentId: state.config.agentId }),
    caller: "heartbeat",
    authority: "operator" as const,
  };
  const own = new Set(["personal", "personal_workspace", "personal_agent"]);
  const excerpts: MemoryExcerpt[] = [];
  const seen = new Set<string>();
  for (const preference of (await memory.resolvePreferences({ actor })).preferences) {
    const revisionId = preference.winner.currentRevisionId;
    // A record with no current revision has nothing approved to read.
    if (revisionId === undefined || !own.has(preference.winner.scope.kind) || seen.has(preference.winner.recordId)) continue;
    seen.add(preference.winner.recordId);
    excerpts.push({
      recordId: preference.winner.recordId,
      revisionId,
      kind: "preference",
      text: `${preference.key}: ${typeof preference.value === "string" ? preference.value : JSON.stringify(preference.value)}`,
    });
  }
  // The turn's keyword builder: distinct terms, short CJK words kept. Lexical always —
  // no `semantic`: its words are other people's (signals), never sent to an embedding service (invariant 14).
  const text = retrievalKeywordsFrom(
    (query.kind === "deep" ? state.config.instructions : query.signals.map((signal) => signal.title).join("\n")).slice(0, 2_000),
  ).join(" ");
  if (text !== "") {
    // Heartbeat recall: the built-in's always, whatever the workspace chose.
    const { hits } = await memory.search({ actor, query: text, match: "any", limit: 10, purpose: "heartbeat" });
    for (const hit of hits) {
      if (!own.has(hit.scope.kind) || hit.superseded || seen.has(hit.recordId)) continue;
      seen.add(hit.recordId);
      // A turn's format: the title, then the whole body up to 300 characters or a window around the match.
      excerpts.push({
        recordId: hit.recordId,
        revisionId: hit.revisionId,
        kind: hit.kind === "preference" || hit.kind === "lesson" || hit.kind === "summary" ? hit.kind : "fact",
        text: memoryExcerptHead(hit.title, hit.snippet),
      });
    }
  }
  return excerpts;
}

/**
 * The first-run offer's instructions: a line per installed source that
 * suggests one (a built-in's own, a plugin's from its approved manifest), but
 * only when a built-in source has something to watch for this person now — a
 * heartbeat with nothing to look at is not offered.
 */
export async function heartbeatOfferInstructions(
  registry: HeartbeatSignalRegistry,
  scope: { readonly workspaceId: string; readonly principalId: string; readonly now: string; readonly timezone: string },
): Promise<string | undefined> {
  const offering = registry.list().filter((entry) => entry.source.offer !== undefined);
  const builtins = offering.filter((entry) => entry.kind === "builtin");
  if (builtins.length === 0) return undefined;
  // Whether to offer at all is the built-in sources' alone: no plugin's code runs for a heartbeat that is off.
  const own = new HeartbeatSignalRegistry();
  for (const entry of builtins) own.install(entry.id, entry.source, "builtin");
  const collection = await collectHeartbeatSignals(own, scope);
  // The lines are every source's that has one: a plugin's is its approved manifest's words, shown at approval.
  const ordered = [...builtins, ...offering.filter((entry) => entry.kind === "plugin")];
  return collection.signals.length > 0 ? `${ordered.map((entry) => entry.source.offer).join("\n")}\n` : undefined;
}

/** At most this many of a person's chat folders are measured each collection. */
const STORAGE_FOLDERS = 50;

export interface StorageSignalsDependencies {
  /** The folders' budgets and sizes, and the free-space floor (`FolderSpace`): sizes only, no file is read. */
  readonly space: {
    usage(
      managed: string,
    ): Promise<{ readonly bytes: number; readonly capBytes: number; readonly chatsBytes: number; readonly chatsCapBytes: number }>;
    checkFloor(): void;
  };
  /** A workspace's managed chat folders, by the chat's task id. */
  readonly chatFolders: (workspaceId: string) => Promise<readonly { readonly taskId: string; readonly managed: string }[]>;
  /** Whose chat a task is. */
  readonly ownerOf: (taskId: string) => Promise<string | undefined>;
}

/**
 * Storage signals: a chat folder of the
 * person's past 80% of its budget, every chat's folders together past 80% of
 * theirs, and the data directory's volume below the free-space floor. Model
 * free and metadata only: sizes come from the folder walk, and no file's
 * content is read. Each is one signal while it lasts, so crossing makes one,
 * and falling back retracts it.
 */
export function storageSignalsSource(deps: StorageSignalsDependencies): HeartbeatSignalSource {
  return {
    id: "storage",
    async collect(scope) {
      const signals: HeartbeatSignal[] = [];
      const folders = await deps.chatFolders(scope.workspaceId);
      const own: { readonly taskId: string; readonly managed: string }[] = [];
      for (const folder of folders) {
        if (own.length >= STORAGE_FOLDERS) break;
        scope.signal.throwIfAborted();
        if ((await deps.ownerOf(folder.taskId)) === scope.principalId) own.push(folder);
      }
      let total: { readonly bytes: number; readonly capBytes: number } | undefined;
      for (const folder of own) {
        scope.signal.throwIfAborted();
        const usage = await deps.space.usage(folder.managed);
        total ??= { bytes: usage.chatsBytes, capBytes: usage.chatsCapBytes };
        if (usage.bytes < FOLDER_BUDGET_WARN_FRACTION * usage.capBytes) continue;
        signals.push({
          key: `folder:${folder.taskId}`,
          hash: "past-80",
          title: "A chat's folder is past 80% of its space budget",
          at: scope.now,
          source: "Storage",
          data: { taskId: folder.taskId, bytes: usage.bytes, capBytes: usage.capBytes },
        });
      }
      // Every chat's folders together are everyone's: measured through any folder when the person owns none.
      const any = folders[0];
      if (total === undefined && any !== undefined) {
        const usage = await deps.space.usage(any.managed);
        total = { bytes: usage.chatsBytes, capBytes: usage.chatsCapBytes };
      }
      if (total !== undefined && total.bytes >= FOLDER_BUDGET_WARN_FRACTION * total.capBytes) {
        signals.push({
          key: "folders",
          hash: "past-80",
          title: "All chats' folders together are past 80% of their space budget",
          at: scope.now,
          source: "Storage",
          data: { bytes: total.bytes, capBytes: total.capBytes },
        });
      }
      try {
        deps.space.checkFloor();
      } catch (error) {
        // Only the floor's own refusal says the disk is nearly full.
        if (!(error instanceof TaviError && error.code === "QUOTA_EXCEEDED")) throw error;
        signals.push({
          key: "free-space",
          hash: "below-floor",
          title: "The disk Tavi keeps its data on is nearly full",
          at: scope.now,
          source: "Storage",
        });
      }
      return signals;
    },
  };
}

/** The chat folders under one workspace's managed directory, by name, which is the chat's task id; at most 500, no file inside read. */
export async function managedChatFolders(
  workspaceDirectory: string,
): Promise<readonly { readonly taskId: string; readonly managed: string }[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(workspaceDirectory, { withFileTypes: true });
  } catch {
    // No chat of this workspace has a folder yet.
    return [];
  }
  // By name, so the folders measured are the same from one look to the next.
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 500)
    .map((entry) => ({ taskId: entry.name, managed: join(workspaceDirectory, entry.name) }));
}

export interface AppsSignalsDependencies {
  /** The workspace's Connected apps, as the owner projects them; undefined when it cannot now. */
  readonly apps: (workspaceId: string) => Promise<readonly ConnectableApp[] | undefined>;
  readonly connections: Pick<PersistencePort["repositories"]["messagingConnections"], "list">;
  /** The principal a workspace's apps are the operator's: only they are told. */
  readonly operatorOf: (workspaceId: string) => string | undefined;
  /** The workspaces that offer an owner-wide account (an MCP server): it is told in the first of them. */
  readonly usedIn: (accountId: string) => Promise<readonly string[]>;
}

/**
 * Apps that need signing in again: a
 * channel or an MCP account whose sign-in lapsed or left access out, and a
 * weekly sign-in a day before it lapses. One signal per account, in one
 * workspace, which a reconnect (a new revision or sign-in) raises again.
 */
export function appsSignalsSource(deps: AppsSignalsDependencies): HeartbeatSignalSource {
  return {
    id: "apps",
    offer: "Apps that need signing in again",
    async collect(scope) {
      if (deps.operatorOf(scope.workspaceId) !== scope.principalId) return [];
      const apps = await deps.apps(scope.workspaceId);
      if (apps === undefined) throw new TaviError("UNAVAILABLE", "the apps could not be read");
      const connections = new Map(
        (await deps.connections.list(scope.workspaceId)).map((connection) => [connection.connectionId, connection]),
      );
      const told = await Promise.all(
        apps.flatMap((app) =>
          app.accounts.map(async (account) => {
            const repair = app.repairs.find(
              (candidate) =>
                candidate.accountId === account.accountId && (candidate.kind === "sign-in" || candidate.kind === "grant-access"),
            );
            if (repair === undefined || account.health === "not-set-up") return [];
            const connection = connections.get(account.accountId);
            // An owner-wide account (an MCP server's) is listed in every workspace: it is told once, in the first that
            // offers it, or in the default workspace when none does.
            if (
              connection === undefined &&
              scope.workspaceId !== ([...(await deps.usedIn(account.accountId))].sort()[0] ?? DEFAULT_WORKSPACE_ID)
            )
              return [];
            const revision = connection === undefined ? (account.signedInAt ?? "none") : String(connection.configRevision);
            return [
              {
                key: `app:${account.accountId}`,
                hash: `${account.health}:${account.accountId}:${revision}`,
                title: repair.title.slice(0, 120),
                at: connection?.updatedAt ?? account.signedInAt ?? scope.now,
                source: "Connected apps",
                data: { appId: app.appId },
              },
            ];
          }),
        ),
      );
      return told.flat();
    },
  };
}
