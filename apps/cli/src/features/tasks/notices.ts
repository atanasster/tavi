import {
  NOTICE_NOTE_MAX_NOTICES,
  NOTICE_SUMMARY_MAX,
  homeChatOn,
  normaliseUntrustedText,
  isTopicConversationKey,
  isTrustedPublic,
  joinLabels,
  SOURCE_TASK_NOTICE_KINDS,
  TRUSTED_PUBLIC,
  noticeContextNote,
  reminderIdOfTaskKey,
  untrustedLabel,
  type AdmissionResult,
  type ChatNotice,
  type ContentLabel,
  type ChatNoticeKind,
  type MessagingConversationTask,
  type PersistencePort,
  type ScheduleRecord,
  type TaskRecord,
  type WorkflowPort,
} from "@tavi/contracts";
import { clip, errorMessage } from "@tavi/contracts/util";

import { sideChatSeedLabel } from "../../server/side-chat-seed.js";
import { channelLabelOf } from "../channels/catalog.js";

import type { NoticeSeedSource } from "../run/owner.js";

/**
 * Notices: what background work posts into the
 * chat a person is in — a run's result into Home, a standalone run or a side
 * chat that settled, a new Home's "Earlier chats", a reminder said in Home.
 *
 * A notice is data, not instructions. Its label and status line are
 * Tavi's, and a group's text is never put in one, nor a run's raw output but
 * a schedule's result's (`scheduleResultSummary`), whose run's label the
 * reading turn takes on (`noticesLabelOf`) — and not every other word
 * is trusted either: the generated summary joined to it is a
 * model's reading of the run, a reminder's text may have been set by the
 * agent, and "Earlier chats" lists generated titles. So a notice's title and
 * summary reach the model only through `noticeContextNote`'s fenced block at
 * the chat's next turn (`withChatNotices`) or a side chat's quoted
 * background — never a system message or the instructions — and posting one
 * never admits a turn.
 */

/** How many earlier chats a new Home's notice names. */
const EARLIER_CHATS_LISTED = 10;
/** How many more chats "Earlier chats" reads, to make up for the messaging chats it leaves out. */
const EARLIER_CHATS_SCAN_EXTRA = 20;
/**
 * The kinds "Earlier chats" lists: chats the person had — side chats
 * and ordinary ones — never Home, a worker, or a run (a schedule's, reminder's
 * or routine's fire, or `tavi run`), which stays under Activity.
 */
export const EARLIER_CHAT_KINDS = ["side", "chat"] as const;

export interface ChatNoticeDependencies {
  readonly repositories: Pick<
    PersistencePort["repositories"],
    "tasks" | "transcripts" | "reminders" | "workspaceSettings" | "messagingConversations"
  >;
  /** The owner's own connection (`local-…`): its conversations are the front ends' chats, never a conversation Home. */
  readonly isLocalConnection: (connectionId: string) => boolean;
  /** The person's Home in a workspace, if they have one. */
  readonly homeOf: (workspaceId: string, principalId: string) => Promise<string | undefined>;
  /** The person's most recently touched chats, newest first: no Home, no worker, no run (`EARLIER_CHAT_KINDS`). */
  readonly recentChats?: (
    workspaceId: string,
    principalId: string,
    limit: number,
  ) => Promise<
    readonly {
      readonly taskId: string;
      readonly title?: string | undefined;
      readonly origin?: string | null | undefined;
      readonly chatKind?: string | null | undefined;
      readonly memoryMode?: string | null | undefined;
    }[]
  >;
  readonly newId: () => string;
  readonly now: () => string;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
}

/** A task's ending in Tavi's words: never its final text or error message, which may quote what a tool fetched. */
export function noticeStatusLine(status: string, errorCode?: string): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      // A turn a cancel ended is failed in its record; it was cancelled.
      if (errorCode === "CANCELLED" || errorCode === "TASK_CANCELLED") return "Cancelled";
      return errorCode === undefined ? "Failed" : `Failed (${errorCode})`;
    case "stopped":
      return "Stopped";
    case "cancelled":
      return "Cancelled";
    case "waiting":
    case "awaiting_approval":
    case "review_required":
      return "Waiting on a person";
    default:
      return `Ended (${status})`;
  }
}

/**
 * A schedule's result notice: its status line, then the run's final text,
 * normalised (`normaliseUntrustedText`) and clipped to the notice's bound.
 * The words are the run's: the Home turn that reads them takes the run's label
 * (`noticesLabelOf`).
 */
export function scheduleResultSummary(admission: Pick<AdmissionResult, "outcome">): string {
  const status = noticeStatusLine(admission.outcome.status, admission.outcome.error?.code);
  const text = normaliseUntrustedText(admission.outcome.finalText).trim();
  if (text === "") return status;
  const room = NOTICE_SUMMARY_MAX - status.length - 1;
  return `${status}\n${text.length <= room ? text : `${text.slice(0, room - 1)}…`}`;
}

/** How many of a conversation Home's newest saved turns its notice counts; past it, "N+". */
const CONVERSATION_NOTICE_SCAN = 50;

/**
 * A conversation Home's notice title: its channel and kind, as the
 * conversation recorded them — never the chat's title or anything said in it,
 * which third parties wrote. A group is named by its id, so two groups'
 * notices stay apart.
 */
export function conversationNoticeTitle(
  mapping: Pick<MessagingConversationTask, "providerId" | "conversationKind" | "externalConversationId">,
): string {
  const label = channelLabelOf(mapping.providerId) ?? "Messaging";
  switch (mapping.conversationKind) {
    case "group":
      return `${label} group ${mapping.externalConversationId}`;
    case "direct":
      return `${label} DM`;
    case "thread":
      return `${label} thread`;
    default:
      return `${label} conversation`;
  }
}

/** "3 new messages, the last at 14:05 UTC": counts and a time, nothing that was said. */
function conversationNoticeSummary(count: number, capped: boolean, lastAt: string): string {
  return `${count}${capped ? "+" : ""} new message${count === 1 && !capped ? "" : "s"}, the last at ${lastAt.slice(11, 16)} UTC`;
}

/** A side chat's name in a notice: the reader's own rename, else its id. A generated title follows as the summary. */
function chatLabel(task: TaskRecord): string {
  return task.titleRenamed === true && task.title !== undefined && task.title !== null && task.title.trim() !== ""
    ? `“${task.title.trim()}”`
    : task.taskId;
}

export interface ChatNotices {
  /** After an admission left `taskId` completed or failed (the run-events decorator's `onTaskEnded`). Best effort. */
  onTaskEnded(taskId: string): Promise<void>;
  /** A schedule's settled run into its person's Home (`deliverTo: "home"`); false with no Home. */
  deliverSchedule(schedule: ScheduleRecord, admission: AdmissionResult): Promise<boolean>;
  /**
   * A heartbeat's word in its person's Home: an
   * item, the digest, a pause. Posted again under the same key it updates in
   * place (an item resolved). Its summary is sources and references only,
   * never an item's body, since a Home turn reads it. False with no Home.
   */
  postHeartbeat(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly sourceKey: string;
    readonly heartbeatItemId?: string;
    readonly title: string;
    readonly summary: string;
  }): Promise<boolean>;
  /**
   * Something gone wrong in a person's scheduled work that nobody would
   * otherwise be told — a schedule's alert with no alert target, a routine's
   * pause or a run that expired — in their Home. Posted once per key: a
   * repeat, even in other words (a failure noticed again a sweep later),
   * changes nothing. True when the notice is in Home; false with no Home.
   */
  postAlert(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly sourceKey: string;
    readonly title: string;
    readonly summary: string;
  }): Promise<boolean>;
  /** A reminder's fire said in its person's Home; false with no Home. */
  postReminder(input: {
    readonly reminder: { readonly reminderId: string; readonly workspaceId: string; readonly principalId: string };
    readonly fire: { readonly fireAt: string };
    readonly text: string;
    readonly taskId?: string;
  }): Promise<boolean>;
  /** A new Home's "Earlier chats". */
  postEarlierChats(home: { readonly taskId: string; readonly workspaceId: string; readonly principalId: string }): Promise<void>;
  /** A notice a side chat replies to, posted into `parent`. */
  noticeSource(noticeId: string, parent: TaskRecord): Promise<NoticeSeedSource | undefined>;
  /**
   * A chat's rollover into a new epoch, as a divider in the chat itself:
   * which epoch began, and the archive of what was folded. Shown to
   * the person only, never claimed into a turn. One per chat and epoch; none
   * for a worker, which is no chat.
   */
  postEpoch(taskId: string, rollover: { readonly epoch: number; readonly artifactId?: string; readonly folded: number }): Promise<void>;
  /**
   * A chat's own folder has just crossed 80% of its budget:
   * told once per crossing, at the turn that found it, with what happens
   * at the budget and how to clear it. For the person only; none for a
   * worker. Best effort.
   */
  postFolderBudget(taskId: string, warning: string): Promise<void>;
}

/** An epoch divider's words: Tavi's own, naming the archive or saying there is none. */
function epochNoticeText(rollover: { readonly epoch: number; readonly artifactId?: string; readonly folded: number }): {
  readonly title: string;
  readonly summary: string;
} {
  return {
    title: `Epoch ${rollover.epoch} began`,
    summary:
      rollover.artifactId === undefined
        ? `${rollover.folded} earlier message(s) were summarized; no archive could keep them.`
        : `${rollover.folded} earlier message(s) were summarized and archived as ${rollover.artifactId}.`,
  };
}

export function createChatNotices(deps: ChatNoticeDependencies): ChatNotices {
  const post = async (input: {
    readonly taskId: string;
    readonly kind: ChatNoticeKind;
    readonly sourceKey: string;
    readonly sourceTaskId?: string;
    readonly artifactId?: string;
    readonly heartbeatItemId?: string;
    readonly title: string;
    readonly summary: string;
    readonly bump?: boolean;
    readonly once?: boolean;
  }): Promise<ChatNotice> =>
    (await deps.repositories.transcripts.postNotice({ noticeId: deps.newId(), createdAt: deps.now(), ...input })).notice;

  const homeOn = async (workspaceId: string): Promise<boolean> =>
    homeChatOn((await deps.repositories.workspaceSettings.get(workspaceId)).settings);

  /**
   * The person's Home as a notice's target, when it is another task than
   * `exclude` and `chat.home` is on: with Home off a stored Home is an
   * ordinary chat, so nothing is delivered into it.
   */
  const homeFor = async (workspaceId: string, principalId: string, exclude?: string): Promise<string | undefined> => {
    if (!(await homeOn(workspaceId))) return undefined;
    const home = await deps.homeOf(workspaceId, principalId);
    return home === undefined || home === exclude ? undefined : home;
  };

  /**
   * One coalesced notice per conversation in the person's Home:
   * its channel and kind, how many messages it took since the person last
   * wrote in Home, and when the last came — never a word of the chat, its
   * replies or its generated summary, which read what third parties wrote.
   * Posted again under the same key at each settle, so it updates in place.
   */
  const postConversation = async (task: TaskRecord): Promise<void> => {
    const conversations = deps.repositories.messagingConversations;
    const mapping = await conversations.getByTask(task.taskId);
    if (mapping === undefined || deps.isLocalConnection(mapping.connectionId) || isTopicConversationKey(mapping.externalConversationId))
      return;
    // Only the conversation's current epoch is its Home: an ended one is an ordinary chat.
    if ((await conversations.get(mapping.connectionId, mapping.externalConversationId))?.taskId !== task.taskId) return;
    const home = await homeFor(task.workspaceId, task.principalId, task.taskId);
    if (home === undefined) return;
    // Counts and a time from indexed reads: no turn of the chat is read, let alone posted.
    const since = await deps.repositories.transcripts.latestAt(home);
    const activity = await deps.repositories.transcripts.activity(task.taskId, {
      ...(since === undefined ? {} : { since }),
      max: CONVERSATION_NOTICE_SCAN,
    });
    if (activity.count === 0 || activity.lastAt === undefined) return;
    await post({
      taskId: home,
      kind: "conversation",
      sourceKey: `conversation:${mapping.connectionId}:${mapping.externalConversationId}`,
      sourceTaskId: task.taskId,
      title: conversationNoticeTitle(mapping),
      summary: conversationNoticeSummary(activity.count, activity.capped, activity.lastAt),
    });
  };

  return {
    async onTaskEnded(taskId) {
      const task = await deps.repositories.tasks.get(taskId);
      if (task === undefined || task.chatKind === "worker" || task.chatKind === "home") return;
      const status = noticeStatusLine(task.status);
      // A side chat's settle, back into the chat it was opened from.
      if (task.chatKind === "side" && task.parentChatId !== undefined) {
        const parent = await deps.repositories.tasks.get(task.parentChatId);
        if (parent === undefined || parent.workspaceId !== task.workspaceId || parent.principalId !== task.principalId) return;
        // A messaging chat is read by its group: only a side chat of its own
        // (a topic's) settles into it — the summary joined to the notice is a
        // reading of the side chat, never carried there from the canvas.
        if (parent.origin === "messaging" && task.origin !== "messaging") return;
        await post({
          taskId: parent.taskId,
          kind: "side-chat-settled",
          sourceKey: `side-chat:${task.taskId}`,
          sourceTaskId: task.taskId,
          title: `Side chat ${chatLabel(task)} finished`,
          summary: status,
        });
        return;
      }
      // A conversation Home's turn: metadata only into its person's Home.
      if (task.origin === "messaging" && task.chatKind === undefined) {
        await postConversation(task);
        return;
      }
      // A reminder's task, for a reminder said in Home.
      const reminderId = task.origin === "reminder" ? reminderIdOfTaskKey(task.creationOperationKey) : undefined;
      if (reminderId !== undefined) {
        const reminder = await deps.repositories.reminders.get(reminderId);
        if (reminder?.deliverTo.kind !== "home") return;
        const home = await homeFor(task.workspaceId, task.principalId, task.taskId);
        if (home === undefined) return;
        await post({
          taskId: home,
          kind: "run-result",
          sourceKey: `run:${task.taskId}`,
          sourceTaskId: task.taskId,
          title: "A reminder's task finished",
          summary: status,
        });
        return;
      }
      // A standalone run (`tavi run`): one line into Home, while Home is on.
      if (task.chatKind === "run" && (task.origin === "cli" || task.origin === "ipc" || task.origin === "web")) {
        const home = await homeFor(task.workspaceId, task.principalId, task.taskId);
        if (home === undefined) return;
        await post({
          taskId: home,
          kind: "run-settled",
          sourceKey: `run:${task.taskId}`,
          sourceTaskId: task.taskId,
          title: `Run ${task.taskId} finished`,
          summary: status,
        });
      }
    },

    async deliverSchedule(schedule, admission) {
      const home = await homeFor(schedule.workspaceId, schedule.principalId, admission.taskId);
      if (home === undefined) return false;
      await post({
        taskId: home,
        kind: "run-result",
        sourceKey: `run:${admission.taskId}`,
        sourceTaskId: admission.taskId,
        title: `Scheduled run “${schedule.name}”`,
        summary: scheduleResultSummary(admission),
      });
      return true;
    },

    async postHeartbeat({ workspaceId, principalId, sourceKey, heartbeatItemId, title, summary }) {
      const home = await homeFor(workspaceId, principalId);
      if (home === undefined) return false;
      // Each heartbeat post is news (an item told again in the same words, after a snooze): it comes back up unread.
      await post({
        taskId: home,
        kind: "heartbeat",
        sourceKey,
        ...(heartbeatItemId === undefined ? {} : { heartbeatItemId }),
        title,
        summary,
        bump: true,
      });
      return true;
    },

    async postAlert({ workspaceId, principalId, sourceKey, title, summary }) {
      const home = await homeFor(workspaceId, principalId);
      if (home === undefined) return false;
      await post({ taskId: home, kind: "run-settled", sourceKey, title, summary, once: true });
      return true;
    },

    async postReminder({ reminder, fire, text, taskId }) {
      const home = await homeFor(reminder.workspaceId, reminder.principalId);
      if (home === undefined) return false;
      // The reminder's own words, which the person (or the agent, in their chat) set to be said.
      await post({
        taskId: home,
        kind: "reminder",
        sourceKey: `reminder:${reminder.reminderId}:${fire.fireAt}`,
        ...(taskId === undefined ? {} : { sourceTaskId: taskId }),
        title: "Reminder",
        summary: `${text}${taskId === undefined ? "" : " (its task started)"}`,
      });
      return true;
    },

    async postEarlierChats(home) {
      // With `chat.home` off there is no Home to post into.
      if (!(await homeOn(home.workspaceId))) return;
      // A chat from a messaging conversation is not listed: its title is a group's or a sender's words.
      // Nor is a run: it is no chat the person had.
      // Nor is a private chat.
      const chats = ((await deps.recentChats?.(home.workspaceId, home.principalId, EARLIER_CHATS_LISTED + EARLIER_CHATS_SCAN_EXTRA)) ?? [])
        .filter(
          (chat) =>
            chat.taskId !== home.taskId &&
            chat.origin !== "messaging" &&
            (chat.chatKind ?? "chat") !== "run" &&
            chat.chatKind !== "worker" &&
            chat.chatKind !== "home" &&
            chat.memoryMode !== "private",
        )
        .slice(0, EARLIER_CHATS_LISTED);
      if (chats.length === 0) return;
      const lines = chats.map((chat) => `${clip(chat.title ?? "", 80, { squeeze: true }) || "Untitled chat"} (${chat.taskId})`);
      await post({
        taskId: home.taskId,
        kind: "earlier-chats",
        sourceKey: "earlier-chats",
        title: "Earlier chats",
        summary: lines.join("\n"),
      });
    },

    async postEpoch(taskId, rollover) {
      const task = await deps.repositories.tasks.get(taskId);
      if (task === undefined || task.chatKind === "worker") return;
      await post({
        taskId,
        kind: "epoch",
        sourceKey: `epoch:${rollover.epoch}`,
        ...(rollover.artifactId === undefined ? {} : { artifactId: rollover.artifactId }),
        ...epochNoticeText(rollover),
      });
    },

    async postFolderBudget(taskId, warning) {
      try {
        const task = await deps.repositories.tasks.get(taskId);
        if (task === undefined || task.chatKind === "worker") return;
        // Each crossing is its own notice: the key carries when it was found.
        await post({
          taskId,
          kind: "folder",
          sourceKey: `folder:budget:${deps.now()}`,
          title: "This chat's folder is nearly full",
          summary: warning,
        });
      } catch (error) {
        deps.log("a chat's folder budget notice could not be posted", { taskId, reason: errorMessage(error) });
      }
    },

    async noticeSource(noticeId, parent) {
      const notice = await deps.repositories.transcripts.getNotice(noticeId);
      if (notice === undefined || notice.taskId !== parent.taskId) return undefined;
      const source = notice.sourceTaskId === undefined ? undefined : await deps.repositories.tasks.get(notice.sourceTaskId);
      // Another person's or workspace's run is never quoted: the notice is answered without its output.
      // Nor a conversation's: its replies read what third parties wrote.
      const own =
        notice.kind !== "conversation" &&
        source !== undefined &&
        source.workspaceId === parent.workspaceId &&
        source.principalId === parent.principalId;
      return { title: notice.title, sourceTaskId: notice.sourceTaskId ?? notice.noticeId, output: own ? (source.finalText ?? "") : "" };
    },
  };
}

/**
 * What a chat's notices carry: the join of the context labels of the runs and
 * side chats they are about — a schedule's result quotes its run's final text
 * (`scheduleResultSummary`), a settle's summary is a model's reading of it —
 * read as a side chat's background is (`sideChatSeedLabel`: an unreadable
 * one, or one whose run has no checkpoint left, counts as personal and
 * untrusted). A conversation notice holds only Tavi's counts and times. A
 * notice that names no source (a reminder's text, "Earlier chats"' titles, a
 * heartbeat item) cannot be traced: with one, the block is unlabelled and its
 * turn alone reads as untrusted (`noticesTaintTurn`) — unless what was traced
 * says more than public and trusted, which must stay in the chat: untrusted then.
 */
export async function noticesLabelOf(
  notices: readonly ChatNotice[],
  deps: {
    readonly tasks: Pick<PersistencePort["repositories"]["tasks"], "get">;
    readonly contextLabel?: ((threadId: string) => Promise<ContentLabel | undefined>) | undefined;
  },
): Promise<ContentLabel | undefined> {
  const threadIds: (string | undefined)[] = [];
  let untraced = false;
  for (const notice of notices) {
    if (notice.kind === "conversation") continue;
    if (!SOURCE_TASK_NOTICE_KINDS.has(notice.kind) || notice.sourceTaskId === undefined) {
      untraced = true;
      continue;
    }
    threadIds.push((await deps.tasks.get(notice.sourceTaskId))?.threadId);
  }
  // Only Tavi's own counts and times, or nothing traced at all.
  if (threadIds.length === 0) return untraced ? undefined : TRUSTED_PUBLIC;
  const unread = untrustedLabel("agent", { confidentiality: "personal" });
  const read = deps.contextLabel;
  const label = await sideChatSeedLabel(threadIds, read === undefined ? undefined : async (threadId) => (await read(threadId)) ?? unread);
  if (!untraced) return label;
  return isTrustedPublic(label) ? undefined : joinLabels(label, untrustedLabel("agent"));
}

/**
 * Wrap a `WorkflowPort` so a chat's next turn reads the notices posted into it
 * since its last one: an admission with a prompt on an existing task
 * marks the unread notices as read under its operation key — a retry reads the
 * same ones — and carries them as `AdmitInput.notices`, with the label of the run output
 * they quote (`noticesLabel`) as `AdmitInput.noticesLabel`. A turn that never ran
 * (refused, queued and dropped, a replay) hands back what it marked. Nothing
 * here admits: a notice reaches the model only inside a turn the person began.
 */
export function withChatNotices(
  workflow: WorkflowPort,
  deps: {
    readonly transcripts: Pick<PersistencePort["repositories"]["transcripts"], "claimNotices" | "releaseNotices">;
    /** The label of what `notices` quote (`noticesLabelOf`); undefined when it cannot be traced. */
    readonly noticesLabel?: (notices: readonly ChatNotice[]) => Promise<ContentLabel | undefined>;
    readonly log: (message: string, fields: Record<string, unknown>) => void;
  },
): WorkflowPort {
  return {
    ...workflow,
    async admit(input, invokeOptions) {
      const taskId = input.taskId;
      if (
        taskId === undefined ||
        input.prompt === undefined ||
        input.resume !== undefined ||
        (input.kind !== "start" && input.kind !== "reply")
      )
        return workflow.admit(input, invokeOptions);
      let claim: Awaited<ReturnType<typeof deps.transcripts.claimNotices>>;
      try {
        claim = await deps.transcripts.claimNotices(taskId, input.operationKey, NOTICE_NOTE_MAX_NOTICES);
      } catch (error) {
        deps.log("a chat's notices could not be read for its turn; it runs without them", { taskId, reason: errorMessage(error) });
        return workflow.admit(input, invokeOptions);
      }
      const notices = noticeContextNote(claim.notices, { more: claim.more });
      if (notices === undefined) return workflow.admit(input, invokeOptions);
      let noticesLabel: ContentLabel | undefined;
      try {
        noticesLabel = await deps.noticesLabel?.(claim.notices);
      } catch (error) {
        // Unread, the run output reads as personal and untrusted: it never lowers the chat's label.
        deps.log("the label of a chat's notices could not be read; they count as untrusted", { taskId, reason: errorMessage(error) });
        noticesLabel = untrustedLabel("agent", { confidentiality: "personal" });
      }
      let claimed = false;
      const release = async (): Promise<void> => {
        if (claimed || claim.claimed.length === 0) return;
        try {
          await deps.transcripts.releaseNotices(input.operationKey, claim.claimed);
        } catch (error) {
          deps.log("a turn that never ran could not hand back its notices", { taskId, reason: errorMessage(error) });
        }
      };
      try {
        const result = await workflow.admit(
          {
            ...input,
            notices,
            ...(noticesLabel === undefined ? {} : { noticesLabel }),
            onClaimed: (value) => {
              claimed = true;
              input.onClaimed?.(value);
            },
          },
          invokeOptions,
        );
        // No turn ran (its prompt dropped, or cancelled before it started): the notices are not spent.
        if (result.outcome.notRun === true) claimed = false;
        await release();
        return result;
      } catch (error) {
        await release();
        throw error;
      }
    },
  };
}
