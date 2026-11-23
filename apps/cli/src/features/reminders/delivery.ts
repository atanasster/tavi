import { z } from "zod";

import {
  TaviError,
  isUntrusted,
  localDateTime,
  conversationOfKey,
  topicConversationKey,
  formatReminderClock,
  formatReminderTime,
  reminderRetryDecision,
  type InboundEvent,
  type MemoryActor,
  type MessagingOutboxRepositoryPort,
  type MessagingServicePort,
  type OutboundButton,
  type PersistencePort,
  type Reminder,
  type ReminderDeliveryPort,
  type ReminderFire,
  disarmUrls,
} from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { errorMessage } from "@tavi/contracts/util";

import { pressOf } from "../channels/button-press.js";
import { channelWords, type WorkspaceLocaleOf, zonedClock, zonedShortDay } from "../channels/channel-words.js";

/**
 * Saying a reminder where it was asked.
 *
 * The delivery port the reminder scheduler calls. A reminder for the app is
 * recorded as delivered in the app; one for a conversation is sent through
 * the messaging outbox, with Done and Snooze buttons where the channel has
 * them. A refused send is retried with backoff for up to 15 minutes —
 * each retry is the fire claimed again later, so the loop never waits on a
 * channel — and then falls back to the app.
 *
 * A reminder goes only to the conversation it was asked in, another of the
 * same person's conversations, or a delivery target the operator added for
 * them. That is checked when the reminder is made and again here, so a
 * conversation that stopped qualifying gets nothing.
 */

/** Where a message to a conversation is addressed, as a task's reply target names it. */
export interface ReminderReplyTarget {
  readonly connectionId: string;
  readonly externalConversationId: string;
  readonly externalSenderId: string;
  readonly externalThreadId?: string;
}

export interface ReminderTargetDependencies {
  readonly repositories: Pick<PersistencePort["repositories"], "messagingConversations" | "tasks">;
  /** The delivery targets the operator added for a person (routine targets) that are enabled and authorized. */
  readonly operatorTargets: (
    workspaceId: string,
    principalId: string,
  ) => Promise<readonly { readonly connectionId: string; readonly chatId: string }[]>;
  /** The owner's own front ends' connections: a reminder there is delivered in the app. */
  readonly isLocalConnection: (connectionId: string) => boolean;
}

/**
 * The reply target a person's reminder may be delivered to in this
 * conversation, or undefined when it may not: the conversation the reminder
 * was asked in, another conversation of the same person, or an operator-added
 * target of theirs.
 */
export async function reminderReplyTarget(
  deps: ReminderTargetDependencies,
  owner: { readonly workspaceId: string; readonly principalId: string; readonly originTaskId?: string | undefined },
  connectionId: string,
  conversationId: string,
): Promise<ReminderReplyTarget | undefined> {
  if (deps.isLocalConnection(connectionId)) return undefined;
  const target = (replyTo: { readonly externalSenderId: string; readonly externalThreadId?: string } | undefined): ReminderReplyTarget => ({
    connectionId,
    externalConversationId: conversationId,
    externalSenderId: replyTo?.externalSenderId ?? conversationId,
    ...(replyTo?.externalThreadId === undefined ? {} : { externalThreadId: replyTo.externalThreadId }),
  });
  // The conversation it was asked in, whoever else talks there (a group chat).
  if (owner.originTaskId !== undefined) {
    const origin = await deps.repositories.messagingConversations.getByTask(owner.originTaskId);
    // A forum topic's side chat is mapped under its own key: its group is the conversation.
    if (origin !== undefined && origin.connectionId === connectionId && conversationOfKey(origin.externalConversationId) === conversationId)
      return target(origin.replyTo);
  }
  const conversation = await deps.repositories.messagingConversations.get(connectionId, conversationId);
  if (conversation !== undefined) {
    const task = await deps.repositories.tasks.get(conversation.taskId);
    if (task !== undefined && task.workspaceId === owner.workspaceId && task.principalId === owner.principalId)
      return target(conversation.replyTo);
  }
  const targets = await deps.operatorTargets(owner.workspaceId, owner.principalId);
  if (targets.some((target) => target.connectionId === connectionId && target.chatId === conversationId)) {
    return { connectionId, externalConversationId: conversationId, externalSenderId: conversationId };
  }
  return undefined;
}

/** "Mon 5 Oct 10:00" in `t`'s words, the year said when it is not this one; English as `formatReminderTime` says it. */
function reminderWhenText(instant: Date, timezone: string, t: CoreT): string {
  if (t === coreEnglish) return formatReminderTime(instant, timezone);
  const year = localDateTime(instant, timezone).year;
  return t("channel.reminder.when", {
    day: zonedShortDay(instant, timezone, t),
    year: year === localDateTime(new Date(), timezone).year ? "" : ` ${year}`,
    time: zonedClock(instant, timezone),
  });
}

/** "⏰ Dentist appointment — Mon 5 Oct 10:00 (late: was due 09:00)": what a fire says, in `t`'s words. */
export function reminderMessageText(reminder: Reminder, fire: ReminderFire, late: boolean, t: CoreT = coreEnglish): string {
  const event =
    reminder.when.kind === "event" && fire.occurrence === "notice"
      ? ` — ${reminderWhenText(new Date(reminder.when.at), reminder.timezone, t)}`
      : "";
  const overdue = late ? t("channel.reminder.late", { time: formatReminderClock(new Date(fire.fireAt), reminder.timezone) }) : "";
  return `⏰ ${reminder.text}${event}${overdue}`;
}

/** A press's data: `m:<fire token>:<d|s|h>` — Done, Snooze 10 min, Snooze 1 h. */
const REMINDER_BUTTON = /^m:([A-Za-z0-9_-]{8,32}):([dsh])$/;

/** Whether an inbound event is a press of a reminder's Done or Snooze button. */
export function isReminderPress(event: InboundEvent): boolean {
  return event.kind === "interaction" && REMINDER_BUTTON.test(event.interaction?.data ?? "");
}
const SNOOZE_MINUTES: Readonly<Record<string, 10 | 60>> = { s: 10, h: 60 };

/** Done, Snooze 10 min and Snooze 1 h under a fire, for a channel with buttons. */
function reminderButtons(token: string, t: CoreT): readonly (readonly OutboundButton[])[] {
  return [
    [
      { label: `✅ ${t("channel.reminder.button.done")}`, data: `m:${token}:d` },
      { label: `⏰ ${t("channel.reminder.button.snooze10")}`, data: `m:${token}:s` },
      { label: `⏰ ${t("channel.reminder.button.snooze1h")}`, data: `m:${token}:h` },
    ],
  ];
}

export interface ReminderDeliveryDependencies extends ReminderTargetDependencies {
  readonly repositories: Pick<PersistencePort["repositories"], "messagingConversations" | "tasks" | "messagingOutbox">;
  readonly messaging: Pick<MessagingServicePort, "send" | "buildReplyDestination" | "capabilitiesOf">;
  /** Connections that are email: a subject, and no buttons. */
  readonly isEmailConnection?: (connectionId: string) => boolean;
  /**
   * Start the task a reminder's `prompt` asks for and answer its id once it is
   * admitted, not once it ends. Its approvals are announced to `replyTo` (the
   * app's own path when absent). Undefined without a model connection: the
   * reminder is still said, and says its task was not started.
   */
  readonly startTask?: (input: {
    readonly reminder: Reminder;
    readonly fire: ReminderFire;
    readonly replyTo?: ReminderReplyTarget;
  }) => Promise<string | undefined>;
  /**
   * Whether a model resolves in the workspace now: an
   * owner started with none composes `startTask`, and the first model added
   * over IPC runs the next fire's task with no restart. Until then the
   * reminder is said with `REMINDER_NO_MODEL_NOTE`, as without `startTask`.
   * Absent: a model is there whenever `startTask` is.
   */
  readonly modelReady?: (workspaceId: string) => Promise<boolean>;
  /**
   * Say a fire as a notice in its person's Home, for a reminder
   * delivered to `home`; true once it is posted. False — no Home — says it in
   * the app instead. Absent: always the app.
   */
  readonly postHome?: (input: {
    readonly reminder: Reminder;
    readonly fire: ReminderFire;
    readonly late: boolean;
    readonly text: string;
    readonly taskId?: string;
  }) => Promise<boolean>;
  /**
   * Say a fire sent to a chat app in the canvas too: a notice in that
   * conversation's current chat, so the chat there shows what reached the
   * chat app. Best effort; absent, the canvas is not told.
   */
  readonly postInChat?: (input: {
    readonly taskId: string;
    readonly reminder: Reminder;
    readonly fire: ReminderFire;
    readonly text: string;
  }) => Promise<void>;
  readonly now: () => string;
  /**
   * Whether the reminder's owner still acts in its workspace. One revoked from
   * Allowed people is shown in the app only: nothing reaches their chat, and its
   * prompt starts no task. Absent, every owner is.
   */
  readonly ownerAllowed?: (workspaceId: string, principalId: string) => boolean;
  readonly onDiagnostic?: (message: string, fields?: Record<string, unknown>) => void;
  /** The workspace's language, which a fire's message, buttons and subject speak; absent, English. */
  readonly localeOf?: WorkspaceLocaleOf;
}

/** What a reminder with a `prompt` adds to what it says when there is no model to start its task. */
export const REMINDER_NO_MODEL_NOTE = coreEnglish("channel.reminder.noModel");

const effectIdOf = (reminder: Reminder, fire: ReminderFire, attempt: number): string =>
  `reminder:${reminder.reminderId}:${fire.fireAt}:${attempt}`;

/**
 * The outbox effect this attempt sends under. Each attempt the channel
 * refused has its own — a connector's refusal before dispatch included, which
 * the outbox records as rejected — but an earlier attempt whose result is
 * unknown (it timed out, or its send never resolved) may have arrived, so its
 * effect is used again: the outbox answers with what that send did
 * (`uncertain` while it is unresolved) and nothing is sent twice.
 */
async function effectIdFor(outbox: Pick<MessagingOutboxRepositoryPort, "get">, reminder: Reminder, fire: ReminderFire): Promise<string> {
  const attempts = fire.attempts ?? 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const effect = await outbox.get(effectIdOf(reminder, fire, attempt));
    if (effect !== undefined && (effect.state === "pending" || effect.outcome?.status !== "rejected"))
      return effectIdOf(reminder, fire, attempt);
  }
  return effectIdOf(reminder, fire, attempts);
}

/**
 * A reminder's words as said on a channel or in Home. One made or changed
 * under taint is disarmed as a tainted turn's reply is: its
 * words may be a page's, said later outside any tainted turn, and a channel
 * fetches a link's preview unattended. No URL is known to it, so every
 * address is disarmed.
 */
function said(reminder: Reminder, text: string): string {
  return reminder.label !== undefined && isUntrusted(reminder.label) ? disarmUrls(text, new Set()) : text;
}

export function createReminderDelivery(deps: ReminderDeliveryDependencies): ReminderDeliveryPort {
  /** `modelReady`, contained: a check that cannot be read tries the task, which reports its own failure. */
  const modelReadyFor = async (workspaceId: string): Promise<boolean> => {
    if (deps.modelReady === undefined) return true;
    try {
      return await deps.modelReady(workspaceId);
    } catch (error) {
      deps.onDiagnostic?.("whether a model is configured could not be read; the reminder's task is tried", {
        workspaceId,
        error: errorMessage(error),
      });
      return true;
    }
  };
  return {
    async deliver({ reminder, fire, late }) {
      const now = Date.parse(deps.now());
      const deliverTo = reminder.deliverTo;
      // Whether this chat may still be reached. A failure to find out (a store
      // or routine-target read that threw) is a failed delivery like any other:
      // retried, then shown in the app, never shown nowhere.
      let replyTo: ReminderReplyTarget | undefined;
      let failure: string | undefined;
      const revoked = deps.ownerAllowed !== undefined && !deps.ownerAllowed(reminder.workspaceId, reminder.principalId);
      if (revoked)
        deps.onDiagnostic?.("a reminder's owner is no longer allowed in its workspace; it was shown in the app only", {
          reminderId: reminder.reminderId,
          principalId: reminder.principalId,
        });
      if (deliverTo.kind === "conversation" && !revoked) {
        try {
          replyTo = await reminderReplyTarget(deps, reminder, deliverTo.connectionId, deliverTo.conversationId);
        } catch (error) {
          failure = errorMessage(error);
        }
        if (replyTo === undefined && failure === undefined) {
          deps.onDiagnostic?.("a reminder's conversation is not one it may be delivered to; it was delivered in the app", {
            reminderId: reminder.reminderId,
            connectionId: deliverTo.connectionId,
          });
        }
      }
      // A reminder with a prompt also starts its task, once per fire: a retry
      // carries the task id the first attempt recorded.
      let taskId = fire.taskId;
      // Without a model the prompt cannot run: the reminder says so rather than dropping it.
      // Read now, not at startup: a model added to the running owner runs the next fire's task.
      const noModel =
        reminder.prompt !== undefined &&
        taskId === undefined &&
        (deps.startTask === undefined || !(await modelReadyFor(reminder.workspaceId)));
      const startTask = async (): Promise<void> => {
        if (reminder.prompt === undefined || taskId !== undefined || deps.startTask === undefined || revoked || noModel) return;
        try {
          taskId = await deps.startTask({ reminder, fire, ...(replyTo === undefined ? {} : { replyTo }) });
        } catch (error) {
          deps.onDiagnostic?.("a reminder's task could not be started", { reminderId: reminder.reminderId, error: errorMessage(error) });
        }
      };
      const withTask = () => (taskId === undefined ? {} : { taskId });
      // What a fire says, wherever it is said, in the workspace's language.
      const t = await channelWords(deps.localeOf, reminder.workspaceId, deps.onDiagnostic);
      const message = said(reminder, `${reminderMessageText(reminder, fire, late, t)}${noModel ? t("channel.reminder.noModel") : ""}`);
      /**
       * The fire, said in the canvas too: in the chat it reached — a forum topic's side chat, else the
       * conversation's current one — when that chat is the reminder's own person's. Best effort, never failing the delivery.
       */
      const noteInChat = async (target: ReminderReplyTarget, text: string): Promise<void> => {
        if (deps.postInChat === undefined) return;
        try {
          const conversations = deps.repositories.messagingConversations;
          const topic =
            target.externalThreadId === undefined
              ? undefined
              : await conversations.get(target.connectionId, topicConversationKey(target.externalConversationId, target.externalThreadId));
          const chat = topic ?? (await conversations.get(target.connectionId, target.externalConversationId));
          const task = chat === undefined ? undefined : await deps.repositories.tasks.get(chat.taskId);
          if (task !== undefined && task.workspaceId === reminder.workspaceId && task.principalId === reminder.principalId)
            await deps.postInChat({ taskId: task.taskId, reminder, fire, text });
        } catch (error) {
          deps.onDiagnostic?.("a reminder sent to its chat could not be noted in the canvas", {
            reminderId: reminder.reminderId,
            error: errorMessage(error),
          });
        }
      };
      if (noModel && fire.attempts === undefined) {
        deps.onDiagnostic?.("a reminder's task was not started: no model is configured", {
          reminderId: reminder.reminderId,
          fireAt: fire.fireAt,
        });
      }

      if (failure === undefined) {
        await startTask();
        // Into Home: a notice there, its task's approvals asked in the app as before.
        if (deliverTo.kind === "home") {
          let posted = false;
          try {
            posted =
              (await deps.postHome?.({
                reminder,
                fire,
                late,
                text: message,
                ...withTask(),
              })) === true;
          } catch (error) {
            deps.onDiagnostic?.("a reminder could not be posted into Home; it was delivered in the app", {
              reminderId: reminder.reminderId,
              error: errorMessage(error),
            });
          }
          return { outcome: posted ? "delivered" : "delivered-in-app", ...withTask() };
        }
        if (replyTo === undefined) return { outcome: "delivered-in-app", ...withTask() };
        try {
          const destination = deps.messaging.buildReplyDestination(replyTo.connectionId, {
            externalConversationId: replyTo.externalConversationId,
            externalSenderId: replyTo.externalSenderId,
            ...(replyTo.externalThreadId === undefined ? {} : { externalThreadId: replyTo.externalThreadId }),
          });
          if (destination === undefined) throw new TaviError("UNAVAILABLE", `connection ${replyTo.connectionId} is not open`);
          const email = deps.isEmailConnection?.(replyTo.connectionId) === true;
          const buttons =
            !email && fire.token !== undefined && deps.messaging.capabilitiesOf(replyTo.connectionId)?.interactions === true
              ? reminderButtons(fire.token, t)
              : undefined;
          const outcome = await deps.messaging.send({
            // Each refused attempt is its own outbox effect: the outbox keeps a
            // refused send's outcome, and a repeat of one attempt sends nothing twice.
            effectId: await effectIdFor(deps.repositories.messagingOutbox, reminder, fire),
            connectionId: replyTo.connectionId,
            workspaceId: reminder.workspaceId,
            destination,
            parts: [{ content: message }],
            ...(buttons === undefined ? {} : { buttons }),
            ...(email
              ? { subject: said(reminder, t("channel.reminder.subject", { text: reminder.text.replace(/\s+/g, " ").slice(0, 120) })) }
              : {}),
          });
          // An uncertain send may have arrived: it is not sent again.
          if (outcome.status !== "rejected") {
            await noteInChat(replyTo, message);
            return { outcome: "delivered", ...withTask() };
          }
          failure = outcome.parts[0]?.error ?? "the connector refused the message";
        } catch (error) {
          failure = errorMessage(error);
        }
      }
      const decision = reminderRetryDecision(fire, now);
      if (decision.outcome === "delivered-in-app") {
        deps.onDiagnostic?.("a reminder could not be sent to its conversation for 15 minutes; it was delivered in the app", {
          reminderId: reminder.reminderId,
          fireAt: fire.fireAt,
          error: failure,
        });
        // A task not started yet, because the chat could not be checked, starts now with its approvals in the app.
        await startTask();
        return { outcome: "delivered-in-app", ...withTask() };
      }
      return { outcome: "retry", retryAt: decision.retryAt, ...withTask() };
    },
  };
}

export interface ReminderButtonDependencies {
  readonly repositories: Pick<PersistencePort["repositories"], "reminders">;
  readonly messaging: Pick<MessagingServicePort, "answerInteraction" | "buildReplyDestination" | "editMessage">;
  readonly now: () => string;
  readonly onDiagnostic?: (message: string, fields?: Record<string, unknown>) => void;
  /** The workspace's language, which the acks and receipts speak; absent, English. */
  readonly localeOf?: WorkspaceLocaleOf;
}

/**
 * Done and Snooze presses under a delivered reminder. Answers whether the
 * press was a reminder's (and so handled); only the person the reminder is
 * for, in the conversation it was delivered to, can act on it. A press that
 * acts replaces the buttons with what it did ("Done ✓", "Snoozed until 15:10"),
 * as a decided approval's message does.
 */
export function createReminderButtons(deps: ReminderButtonDependencies): {
  handleInteraction(input: { readonly actor: MemoryActor; readonly event: InboundEvent }): Promise<boolean>;
} {
  return {
    async handleInteraction({ actor, event }) {
      const match = REMINDER_BUTTON.exec(event.interaction?.data ?? "");
      if (match === null) return false;
      const press = pressOf(
        deps.messaging,
        event,
        { press: "a reminder button press", message: "a reminder's message" },
        deps.onDiagnostic,
      );
      const answer = press.answer;
      const now = deps.now();
      const t = await channelWords(deps.localeOf, actor.workspaceId, deps.onDiagnostic);
      if (press.tooOld(now)) {
        await answer(t("channel.button.tooOld"));
        return true;
      }
      const found = await deps.repositories.reminders.fireByToken(match[1] ?? "");
      if (found === undefined) {
        await answer(t("channel.reminder.gone"));
        return true;
      }
      const { reminder, fire } = found;
      const deliverTo = reminder.deliverTo;
      const own =
        actor.workspaceId === reminder.workspaceId &&
        actor.principalId === reminder.principalId &&
        deliverTo.kind === "conversation" &&
        deliverTo.connectionId === event.connectionId &&
        deliverTo.conversationId === event.externalConversationId;
      if (!own) {
        await answer(t("channel.reminder.notYours"));
        return true;
      }
      const settle = (note: string): Promise<void> =>
        press.settle(() => said(reminder, `${reminderMessageText(reminder, fire, fire.late === true, t)}\n\n${note}`));
      try {
        const minutes = SNOOZE_MINUTES[match[2] ?? ""];
        if (minutes === undefined) {
          await deps.repositories.reminders.acknowledge({ reminderId: reminder.reminderId, fireAt: fire.fireAt, now });
          await answer(t("channel.reminder.done"));
          await settle(`${t("channel.reminder.doneNote")} ✓`);
        } else {
          const snoozed = await deps.repositories.reminders.snooze({ reminderId: reminder.reminderId, fireAt: fire.fireAt, minutes, now });
          const until = formatReminderClock(new Date(snoozed.followUp.fireAt), reminder.timezone);
          await answer(t("channel.reminder.snoozed", { time: until }));
          await settle(t("channel.reminder.snoozedNote", { time: until }));
        }
      } catch (error) {
        await answer(errorMessage(error).slice(0, 190));
      }
      return true;
    },
  };
}

const OperatorTargetsSchema = z.object({
  targets: z.array(z.object({ connectionId: z.string(), chatId: z.string(), enabled: z.boolean(), authorized: z.boolean() })),
});

/** The enabled, authorized targets in a `routines targets` answer, as `operatorTargets` wants them. */
export function operatorTargetsOf(answer: unknown): readonly { readonly connectionId: string; readonly chatId: string }[] {
  const parsed = OperatorTargetsSchema.safeParse(answer);
  if (!parsed.success) return [];
  return parsed.data.targets
    .filter((target) => target.enabled && target.authorized)
    .map((target) => ({ connectionId: target.connectionId, chatId: target.chatId }));
}
