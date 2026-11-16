import {
  isPlumbingOrigin,
  CHAT_INSTRUCTIONS_HISTORY_MAX,
  ChatContextAnswerSchema,
  ChatContextCompactAnswerSchema,
  ChatContextRewindAnswerSchema,
  ChatContextExportAnswerSchema,
  ChatContextForgetAnswerSchema,
  ChatContextHistoryAnswerSchema,
  CHAT_EXPORT_PAGE_CHARS,
  DEFAULT_WORKSPACE_ID,
  NOTICES_PAGE_MAX,
  TASK_TITLE_MAX,
  TaviError,
  type ChatContextAnswer,
  type ChatContextCompactAnswer,
  type ChatContextRewindAnswer,
  type ChatContextExportAnswer,
  type ChatContextForgetAnswer,
  type ChatContextHistoryAnswer,
  type ChatNotice,
  type TranscriptEntry,
  type ChatContextPayload,
  type MemoryActor,
  type MemoryRecord,
  type MemoryServicePort,
  type PersistencePort,
} from "@tavi/contracts";

import { pendingRoundRefusal, type IpcAnswer } from "../../shared/ipc-decisions.js";

/** What `chat-context` needs from the owner. */
export interface ChatContextDependencies {
  readonly repositories: Pick<
    PersistencePort["repositories"],
    "chatInstructions" | "tasks" | "agentDelegations" | "taskSummaries" | "transcripts"
  > &
    Partial<Pick<PersistencePort["repositories"], "agentMailbox">>;
  /** Let go of a thread's older checkpoints, keeping its newest; answers how many went. */
  readonly pruneCheckpoints?: (threadId: string) => Promise<number>;
  /** The chat's latest epoch summary, for an export's first page; absent where no workflow runs (offline). */
  readonly epochSummary?: (threadId: string) => Promise<string | undefined>;
  /** Let go of what the owner's event stream still holds of the chat from before an instant — all of it, with none; absent offline. */
  readonly dropRetainedEvents?: (taskId: string, before?: string) => void;
  /** Fresh context: the chat's next message starts a new epoch. Absent, `compact` is refused. */
  readonly requestFreshContext?: (taskId: string) => Promise<void>;
  /**
   * The chat's own folder and its size, which `forget`
   * names since it never touches files; absent, or failing, the answer has
   * no folder.
   */
  readonly folderOf?: (
    workspaceId: string,
    taskId: string,
  ) => Promise<{ readonly path: string; readonly bytes: number; readonly approximate?: true } | undefined>;
  /**
   * The owner's memory: `forget` erases the proposals the chat made
   * that still wait, and with `withMemory` the approved ones it taught. Absent
   * (offline), the chat's memory is not touched and the answer says nothing of it.
   */
  readonly memory?: Pick<MemoryServicePort, "list" | "forget">;
  /** Who saved: the front end that asked (`operator:ui`, `operator:cli`), never a payload field. */
  readonly author: string;
  /** The operator principal a workspace is served for, or undefined for one this owner does not serve. */
  readonly principalOf: (workspaceId: string) => string | undefined;
  readonly now: () => string;
}

/** The task, when it is in `workspaceId`; `NOT_FOUND` alike for one that does not exist and one elsewhere. */
async function chatTask(deps: ChatContextDependencies, workspaceId: string, taskId: string): Promise<void> {
  const task = await deps.repositories.tasks.get(taskId);
  if (task === undefined || task.workspaceId !== workspaceId) throw new TaviError("NOT_FOUND", `Task ${taskId} does not exist`);
}

/** The chat a delegated task belongs to; none for a chat itself. */
async function chatOfDelegated(deps: ChatContextDependencies, taskId: string): Promise<string | undefined> {
  const delegation = await deps.repositories.agentDelegations.getByWorkerTaskId(taskId);
  return delegation?.rootTaskId ?? delegation?.parentTaskId;
}

async function stateOf(deps: ChatContextDependencies, taskId: string): Promise<ChatContextAnswer> {
  const current = await deps.repositories.chatInstructions.current(taskId);
  const delegatedFrom = await chatOfDelegated(deps, taskId);
  const task = await deps.repositories.tasks.get(taskId);
  // A worker's memory is its chat's.
  const memoryMode = delegatedFrom === undefined ? task?.memoryMode : (await deps.repositories.tasks.get(delegatedFrom))?.memoryMode;
  return ChatContextAnswerSchema.parse({
    taskId,
    revision: current?.revision ?? 0,
    current: current ?? null,
    ...(delegatedFrom === undefined ? {} : { delegatedFrom }),
    ...(task?.title === null || task?.title === undefined ? {} : { title: task.title.slice(0, TASK_TITLE_MAX) }),
    ...(task?.titleRenamed === true ? { renamed: true } : {}),
    ...(memoryMode === undefined ? {} : { memoryMode }),
  });
}

/** What forgetting a chat's history needs: the `forget` action's and the private-chat sweep's. */
export type ChatHistoryForgetDependencies = {
  readonly repositories: Pick<PersistencePort["repositories"], "tasks" | "transcripts"> &
    Partial<Pick<PersistencePort["repositories"], "agentMailbox">>;
} & Pick<ChatContextDependencies, "pruneCheckpoints" | "dropRetainedEvents">;

/**
 * Erase a chat's saved history from before `before`: its turns, its
 * fold archives, what agents sent it, what the owner's stream still
 * holds of it, and — when anything was erased — its older checkpoints. The
 * `forget` action's path, and the retention sweep's for a private chat.
 */
export async function forgetChatHistory(
  deps: ChatHistoryForgetDependencies,
  taskId: string,
  before: string,
): Promise<{
  readonly erased: Awaited<ReturnType<PersistencePort["repositories"]["transcripts"]["forget"]>>;
  readonly checkpointsPruned: number;
}> {
  const erased = await deps.repositories.transcripts.forget(taskId, before);
  // What agents sent the chat before then is not read into a later turn either.
  await deps.repositories.agentMailbox?.acknowledgeBefore(taskId, before);
  // Nor is it replayed to a late subscriber of the owner's stream.
  deps.dropRetainedEvents?.(taskId, before);
  const task = await deps.repositories.tasks.get(taskId);
  // Only a forget that erased something (a saved turn, or the words of an admission record — a chat from
  // before saved turns has only those) lets go of checkpoints, and the count is what went.
  const checkpointsPruned =
    erased.forgotten + erased.redacted === 0 || task === undefined || deps.pruneCheckpoints === undefined
      ? 0
      : await deps.pruneCheckpoints(task.threadId);
  return { erased, checkpointsPruned };
}

/** How many records one chat's forget reads at most: a workspace's own record quota. */
const CHAT_MEMORY_FORGET_MAX = 5_000;
/** A memory listing's page (`MEMORY_LIST_PAGE_MAX`). */
const CHAT_MEMORY_PAGE = 100;

/**
 * The memory a chat taught from before `before`: its
 * proposals that still wait are forgotten with its words, and with
 * `withMemory` its approved records too; the approved ones left are counted.
 * Only the chat's own person's: nobody, the operator included, decides
 * another person's memory (invariant 21), so a bound person's chat keeps
 * theirs, and offline (no memory port) nothing is read.
 */
async function forgetChatMemory(
  deps: ChatContextDependencies,
  workspaceId: string,
  taskId: string,
  before: string,
  withMemory: boolean,
): Promise<{
  readonly proposals?: number;
  readonly memories?: number;
  readonly memoriesKept?: number;
  readonly memoryNotYours?: true;
  readonly memoryWaitsFor?: readonly string[];
}> {
  if (deps.memory === undefined) return {};
  const principalId = deps.principalOf(workspaceId);
  const task = await deps.repositories.tasks.get(taskId);
  if (principalId === undefined || task === undefined) return {};
  if (task.principalId !== principalId) return { memoryNotYours: true };
  const read: MemoryActor = { principalId, workspaceId, caller: deps.author, authority: "operator" };
  const forgotten = await forgetMemoryTaught(deps.memory, read, taskId, before, withMemory);
  const { proposals, memories, kept, waiting } = forgotten;
  return {
    proposals,
    ...(withMemory ? { memories } : {}),
    ...(kept === 0 ? {} : { memoriesKept: kept }),
    ...(waiting.length === 0 ? {} : { memoryWaitsFor: waiting }),
  };
}

/** Every waiting proposal and approved record a chat taught, read as `read`, page by page up to the forget's most. */
async function memoryTaught(memory: Pick<MemoryServicePort, "list">, read: MemoryActor, taskId: string): Promise<readonly MemoryRecord[]> {
  const taught: MemoryRecord[] = [];
  for (let offset = 0; offset < CHAT_MEMORY_FORGET_MAX; offset += CHAT_MEMORY_PAGE) {
    const page = await memory.list({
      actor: read,
      view: "operator",
      chats: [taskId],
      originTaskId: taskId,
      statuses: ["proposed", "approved"],
      limit: CHAT_MEMORY_PAGE,
      offset,
    });
    taught.push(...page);
    if (page.length < CHAT_MEMORY_PAGE) break;
  }
  return taught;
}

/** How many waiting proposals and approved records a chat taught, read as `read`: what a purge's forget would take. */
export async function countMemoryTaught(memory: Pick<MemoryServicePort, "list">, read: MemoryActor, taskId: string): Promise<number> {
  return (await memoryTaught(memory, read, taskId)).length;
}

/**
 * The memory a chat taught from before `before`, read and forgotten as
 * `read` (its person, with the operator's authority): its waiting proposals,
 * and with `withMemory` its approved records too. Answers what went, how many
 * approved ones stayed, and the providers a removal still waits for.
 * The `forget` action's path, and a channel purge's.
 */
export async function forgetMemoryTaught(
  memory: Pick<MemoryServicePort, "list" | "forget">,
  read: MemoryActor,
  taskId: string,
  before: string,
  withMemory: boolean,
): Promise<{ readonly proposals: number; readonly memories: number; readonly kept: number; readonly waiting: readonly string[] }> {
  const taught = (await memoryTaught(memory, read, taskId)).filter((record) => record.recordedAt < before);
  let proposals = 0;
  let memories = 0;
  /** The providers a removal waits for, as each receipt names them. */
  const waiting = new Set<string>();
  for (const record of taught) {
    if (record.status === "approved" && !withMemory) continue;
    // As `memory`'s writes: an agent's scope only as that agent, a chat's notes only as that chat.
    const actor: MemoryActor = {
      ...read,
      ...(record.scope.kind === "personal_agent" ? { agentId: record.scope.agentId } : {}),
      ...(record.scope.kind === "run_local" ? { runId: record.scope.runId } : {}),
    };
    try {
      const receipt = await memory.forget({
        actor,
        recordId: record.recordId,
        reason: record.status === "approved" ? "forgotten with the chat that taught it" : "its chat's history was forgotten",
      });
      for (const provider of receipt.pendingProviders ?? []) waiting.add(provider);
    } catch (error) {
      // Forgotten elsewhere since it was listed: nothing left to do.
      if (TaviError.from(error).code === "NOT_FOUND") continue;
      throw error;
    }
    if (record.status === "approved") memories += 1;
    else proposals += 1;
  }
  const kept = taught.filter((record) => record.status === "approved").length - memories;
  return { proposals, memories, kept, waiting: [...waiting].sort().slice(0, 16) };
}

/** A saved turn as Markdown: its prompt as a quote, its text, its tool lines, its question. */
function turnMarkdown(entry: TranscriptEntry): string {
  const lines = [`## Turn ${entry.seq} · ${entry.createdAt}`];
  if (entry.turn.prompt !== undefined)
    lines.push(
      entry.turn.prompt
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n"),
    );
  for (const item of entry.turn.items) {
    if (item.kind === "text") lines.push(item.text);
    else if (item.kind === "question") lines.push(`**Asked:** ${item.text}`);
    else if (item.kind === "steer")
      lines.push(
        `**Steered:**\n${item.text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}`,
      );
    else lines.push(`- \`${item.toolName}\` ${item.status}${item.errorCode === undefined ? "" : ` (${item.errorCode})`}`);
  }
  if (entry.turn.outcome.status === "failed") {
    // A cancel ends a turn as failed, and its message may name the internal caller.
    const cancelled = entry.turn.outcome.errorCode === "CANCELLED";
    const message = entry.turn.outcome.message?.replace(/^Task was cancelled by [^:]*: /, "");
    lines.push(`*${cancelled ? "Cancelled" : "Failed"}${message === undefined ? "" : `: ${message}`}*`);
  }
  if (entry.turn.outcome.status === "stopped") lines.push(`*${entry.turn.outcome.message ?? "Stopped"}*`);
  return lines.join("\n\n");
}

/** A notice posted into the chat, as a line between its turns: what it was, when, and from where. */
function noticeMarkdown(notice: ChatNotice): string {
  const from = notice.sourceTaskId === undefined ? "" : ` (task ${notice.sourceTaskId})`;
  return `*Notice · ${notice.kind} · ${notice.createdAt}${from}:* **${notice.title}**${notice.summary.trim() === "" ? "" : ` — ${notice.summary}`}`;
}

/** How many saved turns an export reads at a time: a page's Markdown is bounded by size, not by this. */
const EXPORT_READ_TURNS = 20;

/**
 * `chat-context`: a chat's instructions. A
 * save is a new revision under a compare-and-set, and applies from the chat's
 * next turn; `reset` saves an empty one.
 */
export async function chatContextCommand(
  deps: ChatContextDependencies,
  payload: ChatContextPayload,
): Promise<
  IpcAnswer<
    | ChatContextAnswer
    | ChatContextHistoryAnswer
    | ChatContextExportAnswer
    | ChatContextForgetAnswer
    | ChatContextCompactAnswer
    | ChatContextRewindAnswer
  >
> {
  try {
    const workspaceId = payload.workspaceId ?? DEFAULT_WORKSPACE_ID;
    // As `memory` and `reminders`: a workspace this owner does not serve is not found.
    if (deps.principalOf(workspaceId) === undefined) {
      throw new TaviError("NOT_FOUND", `workspace ${workspaceId} is not configured on this owner`, { details: { workspaceId } });
    }
    await chatTask(deps, workspaceId, payload.taskId);
    switch (payload.action) {
      case "get":
        return { ok: true, result: await stateOf(deps, payload.taskId) };
      case "history": {
        const revisions = await deps.repositories.chatInstructions.history(payload.taskId, payload.limit ?? CHAT_INSTRUCTIONS_HISTORY_MAX);
        return { ok: true, result: ChatContextHistoryAnswerSchema.parse({ taskId: payload.taskId, revisions }) };
      }
      case "rename":
        await deps.repositories.taskSummaries.rename({ taskId: payload.taskId, title: payload.title });
        return { ok: true, result: await stateOf(deps, payload.taskId) };
      case "export": {
        // Oldest turns first, a read of several at a time, until the page's Markdown is full: a page always fits an
        // IPC answer, and a reader writes each page as it comes. The notices posted among the turns go between them,
        // read on their own cursor (`after` and how many of the notices after it were written), so a page can end
        // among notices and none is dropped, however many there are.
        const parts: string[] = [];
        let chars = 0;
        let turns = 0;
        let after = payload.after ?? 0;
        let skip = payload.noticeSkip ?? 0;
        let full = false;
        const add = (part: string): boolean => {
          const clipped = part.slice(0, CHAT_EXPORT_PAGE_CHARS);
          if (parts.length > 0 && chars + clipped.length > CHAT_EXPORT_PAGE_CHARS) return false;
          parts.push(clipped);
          chars += clipped.length;
          return true;
        };
        /** Write the notices after turn `after` and before turn `beforeSeq` (all later ones when absent); false when the page filled. */
        const writeNotices = async (beforeSeq?: number): Promise<boolean> => {
          for (;;) {
            const notices = await deps.repositories.transcripts.noticesAfter(payload.taskId, {
              fromSeq: after,
              ...(beforeSeq === undefined ? {} : { beforeSeq }),
              skip,
              limit: NOTICES_PAGE_MAX,
            });
            for (const notice of notices) {
              if (!add(noticeMarkdown(notice))) return false;
              skip += 1;
            }
            if (notices.length < NOTICES_PAGE_MAX) return true;
          }
        };
        reading: for (;;) {
          const page = await deps.repositories.transcripts.page(payload.taskId, { after, limit: EXPORT_READ_TURNS });
          for (const entry of page.entries) {
            if (!(await writeNotices(entry.seq)) || !add(turnMarkdown(entry))) {
              full = true;
              break reading;
            }
            turns += 1;
            after = entry.seq;
            skip = 0;
          }
          if (page.nextAfter === undefined) {
            // The newest turn: the notices after it close the export, as far as the page holds them.
            full = !(await writeNotices());
            break;
          }
        }
        const nextAfter = full ? after : undefined;
        const nextNoticeSkip = full && skip > 0 ? skip : undefined;
        const task = await deps.repositories.tasks.get(payload.taskId);
        // The first page names what earlier epochs folded into: the turns before them may be long erased.
        const summary = payload.after === undefined && task !== undefined ? await deps.epochSummary?.(task.threadId) : undefined;
        return {
          ok: true,
          result: ChatContextExportAnswerSchema.parse({
            taskId: payload.taskId,
            title: task?.title ?? payload.taskId,
            turns,
            markdown: parts.join("\n\n"),
            ...(nextAfter === undefined ? {} : { nextAfter }),
            ...(nextNoticeSkip === undefined ? {} : { nextNoticeSkip }),
            ...(summary === undefined || summary.trim() === "" ? {} : { epochSummary: summary.slice(0, CHAT_EXPORT_PAGE_CHARS) }),
          }),
        };
      }
      case "forget": {
        let before: string;
        if (payload.epoch !== undefined) {
          // Everything before the epoch began: its rollover's notice says when.
          const started = await deps.repositories.transcripts.epochStartedAt(payload.taskId, payload.epoch);
          if (started === undefined) throw new TaviError("NOT_FOUND", `Chat ${payload.taskId} has no epoch ${payload.epoch} on record`);
          before = started;
        } else {
          // Compared as stored, to the millisecond: `2026-10-01T00:00:00Z` names the same instant as `…00.000Z`.
          before = new Date(Date.parse(payload.before ?? "")).toISOString();
        }
        const { erased, checkpointsPruned } = await forgetChatHistory(deps, payload.taskId, before);
        // What it taught: its waiting proposals go with its words, approved memory only when asked.
        const memory = await forgetChatMemory(deps, workspaceId, payload.taskId, before, payload.withMemory === true);
        // The chat's folder is not touched: named, with its size, for the reader to clear.
        const folder = await deps.folderOf?.(workspaceId, payload.taskId).catch(() => undefined);
        return {
          ok: true,
          result: ChatContextForgetAnswerSchema.parse({
            taskId: payload.taskId,
            forgotten: erased.forgotten,
            before,
            checkpointsPruned,
            related: erased.related,
            archives: erased.archives,
            ...memory,
            ...(folder === undefined ? {} : { folder }),
          }),
        };
      }
      case "compact": {
        // A worker is no chat: its context follows the chat it works for.
        const chat = await chatOfDelegated(deps, payload.taskId);
        if (chat !== undefined)
          throw new TaviError("INVALID_INPUT", `Task ${payload.taskId} is an agent's task; ask for fresh context in its chat, ${chat}`);
        if (deps.requestFreshContext === undefined) throw new TaviError("UNSUPPORTED", "This owner cannot start a fresh context");
        await deps.requestFreshContext(payload.taskId);
        return { ok: true, result: ChatContextCompactAnswerSchema.parse({ taskId: payload.taskId, freshContext: "next-message" }) };
      }
      case "rewind": {
        // A worker is no chat: what it was asked is its chat's to take back.
        const chat = await chatOfDelegated(deps, payload.taskId);
        if (chat !== undefined) throw new TaviError("INVALID_INPUT", `Task ${payload.taskId} is an agent's task; rewind its chat, ${chat}`);
        if (await deps.repositories.tasks.hasRunningAdmission(payload.taskId))
          throw new TaviError("CONFLICT", `Chat ${payload.taskId} has a turn running: stop it, then rewind`);
        // A suspended thread stays suspended whatever is cut from its history: what it waits on is settled first.
        const round = await pendingRoundRefusal(deps.repositories.tasks, payload.taskId, `Chat ${payload.taskId}`);
        if (round !== undefined) throw new TaviError("CONFLICT", round.error.message);
        if ((await deps.repositories.tasks.latestSettledAdmission(payload.taskId))?.result?.status === "waiting") {
          throw new TaviError("CONFLICT", `Chat ${payload.taskId} waits on an answer: answer it or stop the chat, then rewind`);
        }
        const taken = await deps.repositories.transcripts.rewind(payload.taskId, payload.seq, payload.prompt);
        // The owner's stream held the rewound turns: a page opening the chat reads its saved history instead.
        deps.dropRetainedEvents?.(payload.taskId);
        return {
          ok: true,
          result: ChatContextRewindAnswerSchema.parse({
            taskId: payload.taskId,
            seq: payload.seq,
            rewound: taken.rewound,
            prompt: taken.prompt,
          }),
        };
      }
      case "memory": {
        // A worker's memory follows its chat's: turned off or on there.
        const chat = await chatOfDelegated(deps, payload.taskId);
        if (chat !== undefined)
          throw new TaviError("INVALID_INPUT", `Task ${payload.taskId} is an agent's task; its memory follows its chat, ${chat}`);
        // A standalone run and a heartbeat check have no mode: their memory is fixed.
        const task = await deps.repositories.tasks.get(payload.taskId);
        // A chat's memory is its person's to turn (invariant 21): the operator never turns a bound
        // person's chat back on, a DM they turned off with /memory off. Not found, as another person's chat is.
        if (task?.principalId !== deps.principalOf(workspaceId)) throw new TaviError("NOT_FOUND", `Task ${payload.taskId} does not exist`);
        if (task !== undefined && (task.chatKind === "run" || isPlumbingOrigin(task.origin)))
          throw new TaviError(
            "INVALID_INPUT",
            `Task ${payload.taskId} is ${task.chatKind === "run" ? "a standalone run" : task.origin === "ideas" ? "an idea's prepared step" : "a heartbeat check"}, not a chat: it has no memory mode`,
          );
        await deps.repositories.tasks.setMemoryMode({ taskId: payload.taskId, mode: payload.mode, now: deps.now() });
        return { ok: true, result: await stateOf(deps, payload.taskId) };
      }
      case "set":
      case "reset": {
        // A delegated task runs under its agent's instructions, never its own chat layer: a save would do nothing.
        const chat = await chatOfDelegated(deps, payload.taskId);
        if (chat !== undefined)
          throw new TaviError(
            "INVALID_INPUT",
            `Task ${payload.taskId} is an agent's task and runs under its agent's instructions; set them on its chat, ${chat}`,
          );
        await deps.repositories.chatInstructions.record({
          taskId: payload.taskId,
          text: payload.action === "set" ? payload.text : "",
          author: deps.author,
          expectedRevision: payload.expectedRevision,
          now: deps.now(),
        });
        return { ok: true, result: await stateOf(deps, payload.taskId) };
      }
    }
  } catch (error) {
    const failure = TaviError.from(error);
    return {
      ok: false,
      error: { code: failure.code, message: failure.message, ...(failure.details === undefined ? {} : { details: failure.details }) },
    };
  }
}
