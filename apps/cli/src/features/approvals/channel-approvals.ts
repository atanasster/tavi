import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  type ApprovalRoundDeliveryRecord,
  APPROVAL_EXPIRED_DECIDER,
  TaviError,
  type AgentWaitOutcome,
  type AskUserChoices,
  decidableRound,
  expectedStepsOf,
  maxRisk,
  newRoundToken,
  roundResumeKey,
  waitResumeOperationKey,
  type ApprovalLinkRecord,
  type ApprovalRoundRecord,
  type ApprovalScope,
  type ApprovalForm,
  type MessagingConversationKind,
  isTopicConversationKey,
  type InboundEvent,
  type InvocationContext,
  type MemoryActor,
  type MessagingServicePort,
  type NeedDeliveryRecord,
  type PendingReasonRecord,
  type OutboundButton,
  type PersistencePort,
  type WorkflowPort,
} from "@tavi/contracts";
import { clip, definedOnly, errorMessage, plural } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";
import type { ApprovalRoundAnnouncement, ApprovalRoundSettlement, ReviewAnnouncement } from "@tavi/agent-host/workflow";

import { pressOf } from "../channels/button-press.js";
import {
  type ApprovalCommand,
  BUTTON_SCOPES,
  callScopesOf,
  closedQuestionText,
  FORM_TOOLS,
  formDetail,
  formOfDetail,
  groupName,
  LINK_LABELS,
  linkLabel,
  type LinkView,
  offeredScopes,
  parseApprovalCommand,
  QUESTION_BUTTON,
  questionButtons,
  questionReceipt,
  questionToken,
  renderRoundText,
  LINK_BEARER_NOTE,
  ROUND_BUTTON,
  ROUND_TOKEN_SHAPE,
  roundExpiryLine,
  reviewNoticeText,
  roundGroup,
  roundLabelOf,
  roundScopes,
  scopeButtons,
  SCOPES,
  settlementText,
  subjectSafe,
  TASK_ID_SHAPE,
} from "./channel-approval-text.js";
import { maskedApprovable, maskedForm, splitMessage } from "./form.js";
import { scheduleInFlightMessage, undecidableRoundMessage } from "../../shared/rounds.js";

/**
 * Approval rounds in the conversations tasks came from.
 *
 * The workflow announces a round before it suspends and reports it once
 * decided; this module turns both into chat messages, and turns a chat's
 * decision — a typed command now, a button later — into the same round
 * admission every other front end uses. It never decides anything itself: the
 * round's resume key and its `expectedSteps` precondition keep the first
 * decision from any front end the only one.
 */

/** How long a round announced to a chat waits before it is denied. */
const DEFAULT_CHANNEL_ROUND_TTL_MS = 24 * 60 * 60 * 1000;
/** Who an expired round is recorded as decided by; the approvals history reads it as `expired`. */
const EXPIRED_DECIDER = APPROVAL_EXPIRED_DECIDER;
const EXPIRED_NOTE = "not approved: timed out (nobody decided before the approval expired)";
/** How long after settling a round whose settlement could not be shown there is it retried. */
export const NOTIFY_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ChannelApprovalDependencies {
  readonly repositories: PersistencePort["repositories"];
  readonly messaging: Pick<
    MessagingServicePort,
    "send" | "buildReplyDestination" | "buildDirectDestination" | "capabilitiesOf" | "answerInteraction" | "editMessage"
  >;
  /** Late-bound: the workflow is built with this module's hooks. */
  readonly workflow: () => WorkflowPort | undefined;
  /** The schedule whose fire is answering a task's rounds, if one is. */
  readonly scheduleOf: (taskId: string) => string | undefined;
  /** Connections whose front ends decide over IPC and are never sent a round. */
  readonly isLocalConnection: (connectionId: string) => boolean;
  readonly now: () => string;
  readonly fillRandom: (bytes: Uint8Array) => void;
  readonly roundTtlMs?: number;
  /** How long a ❌ press waits for its reason before the round is rejected without one. */
  readonly reasonWindowMs?: number;
  /**
   * The public base URL single-use links on a connection open at (email);
   * `undefined` for a connection that has none, whose rounds carry no links.
   */
  readonly linkBase?: (connectionId: string) => string | undefined;
  /**
   * Connections whose replies are authenticated by SPF/DKIM rather than by the
   * channel (email): their announcements carry the round's token in the
   * subject, and offer only what a reply may decide.
   */
  readonly isEmailConnection?: (connectionId: string) => boolean;
  /** How a connection is named in a settlement notice ("Telegram"); the connection id when absent. */
  readonly channelName?: (connectionId: string) => string | undefined;
  /**
   * The principal a workspace belongs to. A round in the task of anyone else
   * there — a person from Allowed people — is decided only by it: the person is
   * told it waits for the operator, and offered no way to decide it. Without
   * it, a task's own principal decides its rounds.
   */
  readonly operatorOf?: (workspaceId: string) => string | undefined;
  /** The operator's PIN a critical round's link page asks for; `undefined` when none is set. */
  readonly readPin?: () => Promise<string | undefined>;
  readonly onDiagnostic?: (message: string, fields?: Record<string, unknown>) => void;
}

/** A round `/new` withdrew: its settle event's `detail.reason`, and what it says where it was asked. */
const ROUND_RESET_REASON = "conversation-reset";
const ROUND_RESET_NOTICE = "This conversation was reset, so this round was withdrawn.";

/** A question link's `choice` for a multi-select question's one form link. */
const MULTI_SELECT_CHOICE = "*";

export interface ChannelApprovals {
  readonly announceRound: (round: ApprovalRoundAnnouncement) => Promise<void>;
  /** Tells the chat's channel that its turn waits on a review it cannot give there; once per review. */
  readonly announceReview: (review: ReviewAnnouncement) => Promise<void>;
  readonly onRoundSettled: (settlement: ApprovalRoundSettlement) => Promise<void>;
  /**
   * `/new` ended the conversation `taskId` was the task of: its rounds
   * still open are settled as withdrawn, and each announcement loses its
   * buttons, as a decided round's does — a press after it says the
   * conversation was reset. Never throws.
   */
  readonly onConversationReset: (input: { readonly taskId: string; readonly via: string; readonly actor?: string }) => Promise<void>;
  /**
   * Decide a round from a chat: the conversation's own task, a task id, or a
   * round token. Returns what to tell the person; `undefined` when the target
   * is a task waiting on a question rather than a round, so the caller can
   * treat the message as the answer instead.
   */
  readonly decide: (input: {
    readonly actor: { readonly workspaceId: string; readonly principalId: string };
    readonly connectionId: string;
    readonly conversationTaskId: string | undefined;
    readonly command: ApprovalCommand;
    /** An email reply's SPF/DKIM verdict: only a verified reply, for a low- or medium-risk round, decides. */
    readonly senderAuthentication?: "pass" | "fail" | "unknown" | undefined;
    /** What the decision is recorded as coming through, when not the connection itself (`link`). */
    readonly via?: string;
    /**
     * A DM linked to Home: a command that names no round
     * decides only a round announced to this conversation — one raised by a
     * turn sent from it — never one raised in the canvas, which it never saw.
     */
    readonly announcedIn?: { readonly connectionId: string; readonly conversationId: string };
  }) => Promise<string | undefined>;
  /**
   * Deny every announced round past its expiry, and send again announcements
   * and settlement notices that could not be sent; returns how many rounds
   * were denied.
   */
  readonly sweepExpired: () => Promise<number>;
  /** What became of each call a round decided, for its audit trail; a replay records nothing twice. */
  readonly recordToolResults: (report: {
    readonly taskId: string;
    readonly steps: number;
    readonly results: readonly { readonly callId: string; readonly toolName: string; readonly status: "ok" | "error" | "denied" }[];
  }) => Promise<void>;
  /** A button press (`kind: "interaction"`); never admitted as a turn. */
  readonly handleInteraction: (input: { readonly actor: MemoryActor; readonly event: InboundEvent }) => Promise<void>;
  /**
   * Record where a question was delivered — its destination, message id and
   * text — so a press, a link page or an edit after a restart still finds it.
   */
  readonly recordQuestion: (delivery: {
    readonly waitId: string;
    readonly taskId: string;
    readonly connectionId: string;
    readonly destination: unknown;
    readonly chatId: string;
    readonly threadId?: string;
    readonly providerMessageId?: string;
    readonly text: string;
  }) => Promise<void>;
  /**
   * A question's wait settled — answered anywhere, expired or withdrawn: each
   * message it was delivered as is edited into its receipt with the buttons
   * removed. Where a message cannot be edited, an
   * expiry or withdrawal is said in a follow-up; an answer is not, since the
   * person gave it. Never throws: a failed edit is reported as a diagnostic.
   */
  readonly onQuestionSettled: (input: {
    readonly waitId: string;
    readonly outcome: AgentWaitOutcome;
    readonly via: string;
    readonly at?: string;
  }) => Promise<void>;
  /**
   * Answer a task's open question from anywhere its owner is: settle
   * its wait, resume the task in its own conversation, and mark every message
   * it was asked in. `false` when it was no longer open. The caller has checked
   * that `actor` owns the task.
   */
  readonly answerQuestion: (input: {
    readonly actor: MemoryActor;
    readonly taskId: string;
    readonly waitId: string;
    readonly outcome: AgentWaitOutcome;
    readonly via: string;
    readonly beforeSettlement?: () => void;
  }) => Promise<boolean>;
  /** Where a task's messages go: its own conversation, or its delegation root's (a worker's). */
  readonly replyTargetOf: (taskId: string) => Promise<ReplyTargetRecord | undefined>;
  /** One single-use link line per option, where the connection has a public address (email). */
  readonly questionLinkLines: (input: {
    readonly taskId: string;
    readonly waitId: string;
    readonly choices: AskUserChoices;
    readonly connectionId: string;
  }) => Promise<readonly string[]>;
  /** What a link's page shows, without spending it (a GET must never decide: link scanners follow links). */
  readonly describeLink: (
    token: string,
  ) => Promise<{ readonly ok: true; readonly view: LinkView } | { readonly ok: false; readonly message: string }>;
  /** Spend a link and do what it says (the page's POST). */
  readonly useLink: (
    token: string,
    form: { readonly pin?: string; readonly note?: string; readonly picks?: readonly number[] },
  ) => Promise<{ readonly ok: boolean; readonly message: string }>;
  /**
   * The reason a ❌ press asked for: `true` when this message was it (and
   * the round is now rejected with it), so the caller admits nothing.
   */
  readonly takePendingReason: (input: { readonly actor: MemoryActor; readonly event: InboundEvent }) => Promise<boolean>;
}

/** A messaging task's reply target, as its conversation recorded it. */
type ReplyTargetRecord = NonNullable<InvocationContext["messagingReplyTo"]>;

export function createChannelApprovals(deps: ChannelApprovalDependencies): ChannelApprovals {
  const { repositories } = deps;
  const ttlMs = deps.roundTtlMs ?? DEFAULT_CHANNEL_ROUND_TTL_MS;

  /** Whether a task's rounds are its workspace operator's to decide, not its own principal's (a person from Allowed people). */
  const operatorDecides = (task: { readonly workspaceId: string; readonly principalId: string }): boolean => {
    const operator = deps.operatorOf?.(task.workspaceId);
    return operator !== undefined && operator !== task.principalId;
  };
  /** Whether the actor may decide the task's rounds: the workspace's operator, or the task's own principal when none is named. */
  const mayDecide = (
    task: { readonly workspaceId: string; readonly principalId: string },
    actor: { readonly workspaceId: string; readonly principalId: string },
  ): boolean => task.workspaceId === actor.workspaceId && actor.principalId === (deps.operatorOf?.(task.workspaceId) ?? task.principalId);
  const OPERATOR_DECIDES = "The operator decides this task's approvals; you will hear here once they have.";

  /**
   * Whether a card on a connection with links goes to anyone but the sender
   * bound to its decider (`mayDecide`), as one to a person writing in the
   * operator's email thread does: a link is a bearer token that decides as
   * the decider, so that card is sent without links, buttons or token.
   */
  const linksWithheld = async (
    taskId: string,
    replyTarget: { readonly connectionId: string; readonly externalSenderId: string },
  ): Promise<boolean> => {
    if (deps.linkBase?.(replyTarget.connectionId) === undefined) return false;
    const task = await repositories.tasks.get(taskId);
    const recipient = await repositories.messagingIdentityBindings.get(replyTarget.connectionId, replyTarget.externalSenderId);
    return task === undefined || recipient === undefined || !mayDecide(task, recipient);
  };

  /** Where a task's rounds are announced: its own conversation, or its delegation root's. */
  const replyTargetOf = async (taskId: string, invocation?: ApprovalRoundAnnouncement["invocation"]) => {
    if (invocation?.messagingReplyTo !== undefined) return invocation.messagingReplyTo;
    const own = (await repositories.messagingConversations.getByTask(taskId))?.replyTo;
    if (own !== undefined) return own;
    const delegation = await repositories.agentDelegations.getByWorkerTaskId(taskId);
    const root = delegation?.rootTaskId ?? delegation?.parentTaskId;
    return root === undefined ? undefined : (await repositories.messagingConversations.getByTask(root))?.replyTo;
  };

  type ReplyTarget = NonNullable<Awaited<ReturnType<typeof replyTargetOf>>>;
  const destinationOf = (replyTarget: ReplyTarget): unknown => {
    const destination = deps.messaging.buildReplyDestination(replyTarget.connectionId, {
      externalConversationId: replyTarget.externalConversationId,
      externalSenderId: replyTarget.externalSenderId,
      ...(replyTarget.externalMessageId === undefined ? {} : { externalMessageId: replyTarget.externalMessageId }),
      ...(replyTarget.externalThreadId === undefined ? {} : { externalThreadId: replyTarget.externalThreadId }),
    });
    if (destination === undefined) throw new TaviError("UNAVAILABLE", `connection ${replyTarget.connectionId} is not open`);
    return destination;
  };

  const send = async (
    round: Pick<ApprovalRoundRecord, "workspaceId">,
    effectId: string,
    text: string | readonly string[],
    replyTarget: ReplyTarget,
    buttons?: readonly (readonly OutboundButton[])[],
    subject?: string,
  ) => {
    const destination = destinationOf(replyTarget);
    const outcome = await deps.messaging.send({
      effectId,
      connectionId: replyTarget.connectionId,
      workspaceId: round.workspaceId,
      destination,
      parts: (typeof text === "string" ? [text] : text).map((content) => ({ content })),
      ...definedOnly({
        replyToId: replyTarget.externalMessageId,
        buttons,
        subject,
      }),
    });
    if (outcome.status === "rejected")
      throw new TaviError("UNAVAILABLE", `the connector refused the message (${outcome.parts[0]?.error ?? "no reason given"})`);
    return outcome.parts.flatMap((part) => (part.providerMessageId === undefined ? [] : [part.providerMessageId]));
  };

  /** What the conversation a round is sent to is, as its first message said; unknown reads as not one-to-one. */
  const conversationKindOf = async (replyTarget: ReplyTarget): Promise<MessagingConversationKind | undefined> => {
    if (isTopicConversationKey(replyTarget.externalConversationId)) return "thread";
    return (await repositories.messagingConversations.get(replyTarget.connectionId, replyTarget.externalConversationId))?.conversationKind;
  };

  /**
   * Where a round raised in a room is shown: on a channel that reaches a sender one-to-one, the card goes
   * to its decider's own chat — the operator, or the task's person when none
   * is named — and the room hears only that it waits. `destination` is absent
   * when the decider has no binding on the connection or the channel cannot
   * open their chat: the room is then told to approve in Tavi, and the card is
   * shown nowhere on the channel. Undefined: not a room's round, or a channel
   * that cannot; the round is announced where it was raised.
   */
  const privatePlacementOf = async (
    round: Pick<ApprovalRoundRecord, "taskId" | "workspaceId">,
    replyTarget: ReplyTarget,
  ): Promise<{ readonly name: string; readonly destination?: unknown } | undefined> => {
    if (deps.isEmailConnection?.(replyTarget.connectionId) === true) return undefined;
    if (deps.messaging.capabilitiesOf(replyTarget.connectionId)?.groups?.directToSender !== true) return undefined;
    if (("audience" in replyTarget && replyTarget.audience === "one-to-one") || (await conversationKindOf(replyTarget)) === "direct")
      return undefined;
    const decider = deps.operatorOf?.(round.workspaceId) ?? (await repositories.tasks.get(round.taskId))?.principalId;
    const sender =
      decider === undefined ? undefined : await repositories.messagingIdentityBindings.senderOf(replyTarget.connectionId, decider);
    if (sender === undefined) return { name: "the operator" };
    const name = (await repositories.messagingIdentityBindings.get(replyTarget.connectionId, sender))?.displayName ?? "the operator";
    const destination = deps.messaging.buildDirectDestination?.(replyTarget.connectionId, sender, round.workspaceId);
    return destination === undefined ? { name } : { name, destination };
  };

  /** A fresh 128-bit single-use token; only its hash is stored. */
  const mintLink = async (link: Omit<ApprovalLinkRecord, "tokenHash" | "usedAt" | "createdAt">): Promise<string> => {
    const token = randomBytes(16).toString("base64url");
    await repositories.approvalLinks.create({ ...link, tokenHash: sha256Hex(token), createdAt: deps.now() });
    return token;
  };

  /**
   * What an announcement carries apart from its links and its expiry line, kept
   * on a failed attempt so a later sweep can send it without the workflow.
   */
  interface RoundMessage {
    readonly body: string;
    readonly scopes: readonly ApprovalScope[];
    readonly subjectTitle: string;
    /** The group the round is asked as (`roundGroup`), whose choices it names. */
    readonly group?: string;
    /** What the group's choices call it: "the browser on example.com". */
    readonly groupName?: string;
    /** A form fill this surface may not approve (`RoundTextOptions.formApproval`): kept on the round, and held by `decide`. */
    readonly formApproval?: "none" | "link";
    /** The masked forms an email link's page shows, where the card itself shows labels only. */
    readonly linkForms?: readonly ApprovalForm[];
  }

  /**
   * A room's round, shown to its decider alone: the card one-to-one,
   * with its buttons and without the room's message to reply to, and a notice
   * in the room naming no call, destination or form. When the decider cannot be
   * reached there, the room is told to approve in Tavi and the card is shown
   * nowhere on the channel. Each is recorded with its own destination, which
   * its settlement edits; a resend of either is answered by the outbox.
   */
  const deliverPrivately = async (
    round: ApprovalRoundRecord,
    message: RoundMessage,
    replyTarget: ReplyTarget,
    expiresAt: string | undefined,
    placement: { readonly name: string; readonly destination?: unknown },
  ): Promise<void> => {
    const capabilities = deps.messaging.capabilitiesOf(replyTarget.connectionId);
    const failures = (await repositories.approvalRounds.listEvents(round.taskId, round.steps)).filter(
      (event) => event.kind === "announce_failed",
    ).length;
    const effectId = `approval:${round.taskId}:${round.steps}`;
    const suffix = failures === 0 ? "" : `:${failures}`;
    const recordedText = message.body + (expiresAt === undefined ? "" : `\n${roundExpiryLine(expiresAt)}`);
    const cardIds: string[] = [];
    let reached = false;
    let unreachable = false;
    // A resend after the room's notice failed finds the card already shown: it is not sent a second time.
    const shown = (await repositories.approvalRoundDeliveries.listForRound(round.taskId, round.steps)).find(
      (delivery) => delivery.role === "card",
    );
    if (shown !== undefined) {
      reached = true;
      cardIds.push(...shown.messageIds);
    } else if (placement.destination !== undefined) {
      const scopes = message.formApproval === "none" ? [] : message.scopes;
      const buttons =
        capabilities?.approvals === "buttons" && capabilities.interactions ? scopeButtons(scopes, round.token, message.group) : undefined;
      const maxTextLength = capabilities?.maxTextLength;
      const parts =
        maxTextLength === undefined || recordedText.length <= maxTextLength
          ? [recordedText]
          : (splitMessage(recordedText, maxTextLength, 3) ?? [recordedText]);
      reached = true;
      for (const [index, part] of parts.entries()) {
        const last = index === parts.length - 1;
        const outcome = await deps.messaging.send({
          effectId: last ? `${effectId}:card${suffix}` : `${effectId}:card${suffix}:part${index + 1}`,
          connectionId: replyTarget.connectionId,
          workspaceId: round.workspaceId,
          destination: placement.destination,
          parts: [{ content: part }],
          ...(last && buttons !== undefined ? { buttons } : {}),
        });
        // A decider whose chat the platform will not open (DMs closed, never started the bot): told in the room instead.
        if (outcome.parts.some((receipt) => receipt.unreachable === true)) {
          reached = false;
          unreachable = true;
          break;
        }
        if (outcome.status === "rejected")
          throw new TaviError("UNAVAILABLE", `the connector refused the message (${outcome.parts[0]?.error ?? "no reason given"})`);
        cardIds.push(...outcome.parts.flatMap((receipt) => (receipt.providerMessageId === undefined ? [] : [receipt.providerMessageId])));
      }
      if (reached)
        await repositories.approvalRoundDeliveries.record({
          taskId: round.taskId,
          steps: round.steps,
          connectionId: replyTarget.connectionId,
          role: "card",
          destination: placement.destination,
          messageIds: cardIds,
          text: recordedText,
          createdAt: deps.now(),
        });
    }
    // A decider the platform would not let the card reach is told how to open the way.
    const noticeText = reached
      ? `⏸ Waiting on ${placement.name}'s approval (round ${round.token}).`
      : unreachable
        ? `⏸ Round ${round.token} waits on ${placement.name}'s approval: open a one-to-one chat with me, or approve it in Tavi: the web app, the CLI or another chat.`
        : `⏸ Round ${round.token} waits on ${placement.name}'s approval in Tavi: the web app, the CLI or another chat.`;
    const noticeIds = await send(round, `${effectId}:notice${suffix}`, noticeText, replyTarget);
    await repositories.approvalRoundDeliveries.record({
      taskId: round.taskId,
      steps: round.steps,
      connectionId: replyTarget.connectionId,
      role: "notice",
      destination: destinationOf(replyTarget),
      messageIds: noticeIds,
      text: noticeText,
      createdAt: deps.now(),
    });
    await repositories.approvalRounds.appendEvent({
      taskId: round.taskId,
      steps: round.steps,
      kind: "announced",
      via: replyTarget.connectionId,
      detail: {
        token: round.token,
        messageIds: cardIds,
        text: recordedText,
        placement: reached ? "private" : "notice-only",
        ...formDetail(message),
      },
      at: deps.now(),
    });
  };

  /** Send a round's announcement (again) and record it; the outbox effect id makes a resend of a sent one a no-op. */
  const deliver = async (
    round: ApprovalRoundRecord,
    message: RoundMessage,
    replyTarget: ReplyTarget,
    expiresAt: string | undefined,
    placed?: Awaited<ReturnType<typeof privatePlacementOf>>,
  ): Promise<void> => {
    try {
      // A room's round on a channel that reaches its decider one-to-one: never shown in the room.
      // Placed once by the announcement that rendered it; a resend places it again.
      const placement = placed ?? (await privatePlacementOf(round, replyTarget));
      if (placement !== undefined) {
        await deliverPrivately(round, message, replyTarget, expiresAt, placement);
        return;
      }
      // Buttons where the channel decides rounds with them; the text says how to answer either way, so a client that
      // shows no buttons still can.
      // A person's round is the operator's: the person is offered no buttons, links or token to decide it with,
      // nor is anyone but its decider on a connection with links (`linksWithheld`).
      const owner = await repositories.tasks.get(round.taskId);
      const forOperator = owner === undefined || operatorDecides(owner) || (await linksWithheld(round.taskId, replyTarget));
      const capabilities = deps.messaging.capabilitiesOf(replyTarget.connectionId);
      // A fill this chat may not approve is offered ❌ alone.
      const scopes = message.formApproval === "none" ? [] : message.scopes;
      const buttons =
        !forOperator && capabilities?.approvals === "buttons" && capabilities.interactions
          ? scopeButtons(scopes, round.token, message.group)
          : undefined;
      // Single-use links where the connection has a public address (email):
      // one per offered choice, spent together.
      const base = forOperator ? undefined : deps.linkBase?.(replyTarget.connectionId);
      const linkLines =
        base === undefined || expiresAt === undefined
          ? []
          : await Promise.all(
              [...offeredScopes(scopes, message.group), "deny" as const].map(async (choice) => {
                const token = await mintLink({ taskId: round.taskId, kind: "round", steps: round.steps, choice, expiresAt });
                return `${linkLabel(choice, message.group, message.groupName)}: ${base}/i/${token}`;
              }),
            );
      // What is recorded (and shown on a link's page, and edited in place) is
      // the announcement without its links: a raw token lives only in the one
      // message it was sent in.
      const recordedText = message.body + (expiresAt === undefined ? "" : `\n${roundExpiryLine(expiresAt)}`);
      const text =
        recordedText +
        (linkLines.length === 0
          ? ""
          : `\n\nOr open a link — each asks you to confirm before it decides, and works once. ${LINK_BEARER_NOTE}\n${linkLines.join("\n")}`);
      // An email carries the round's token in its subject, so a bare
      // "approve" in a reply names this round.
      const subject =
        deps.isEmailConnection?.(replyTarget.connectionId) !== true
          ? undefined
          : forOperator
            ? `Waiting for approval: ${subjectSafe(clip(message.subjectTitle, 120))}`
            : `[tavi ${round.token}] Approval needed: ${subjectSafe(clip(message.subjectTitle, 120))}`;
      // The outbox keeps a refused send's outcome for good: each attempt after
      // a failure is its own effect, while a re-entered node repeating an
      // attempt still finds that attempt's outcome and sends nothing twice.
      const failures = (await repositories.approvalRounds.listEvents(round.taskId, round.steps)).filter(
        (event) => event.kind === "announce_failed",
      ).length;
      // A long announcement (a form's table) goes as up to three messages, the buttons under the last,
      // after every row; `announceRound` made sure it fits. Each part is its own outbox effect.
      const maxTextLength = capabilities?.maxTextLength;
      const parts = maxTextLength === undefined || text.length <= maxTextLength ? [text] : (splitMessage(text, maxTextLength, 3) ?? [text]);
      const effectId = `approval:${round.taskId}:${round.steps}${failures === 0 ? "" : `:${failures}`}`;
      const messageIds: string[] = [];
      for (const [index, part] of parts.entries()) {
        const last = index === parts.length - 1;
        messageIds.push(
          ...(await send(
            round,
            last ? effectId : `${effectId}:part${index + 1}`,
            part,
            replyTarget,
            last ? buttons : undefined,
            index === 0 ? subject : undefined,
          )),
        );
      }
      // What each message is edited back to once the round is decided: the parts without their links.
      const recordedParts = parts.length === 1 || maxTextLength === undefined ? undefined : splitMessage(recordedText, maxTextLength, 3);
      await repositories.approvalRounds.addMessageIds(round.taskId, round.steps, messageIds);
      await repositories.approvalRounds.appendEvent({
        taskId: round.taskId,
        steps: round.steps,
        kind: "announced",
        via: replyTarget.connectionId,
        detail: {
          token: round.token,
          messageIds,
          text: recordedText,
          ...(recordedParts === undefined ? {} : { parts: recordedParts }),
          ...formDetail(message),
        },
        at: deps.now(),
      });
    } catch (error) {
      // The round stays decidable from every other front end; the sweep sends
      // it again while it is pending, and it expires only once it was seen.
      await repositories.approvalRounds.appendEvent({
        taskId: round.taskId,
        steps: round.steps,
        kind: "announce_failed",
        via: replyTarget.connectionId,
        detail: {
          error: clip(errorMessage(error), 300),
          body: message.body,
          scopes: message.scopes,
          subjectTitle: message.subjectTitle,
          ...(message.group === undefined ? {} : { group: message.group }),
          ...(message.groupName === undefined ? {} : { groupName: message.groupName }),
          ...formDetail(message),
        },
        at: deps.now(),
      });
      throw error;
    }
  };

  /**
   * A turn of a channel's chat that waits on a review (a screenshot held until a person approves it) is said so in
   * the chat, which cannot review it: where to, and that a new message goes on without it. Keyed by the review's
   * artifacts, so a node that re-enters sends it once.
   */
  const announceReview = async (review: ReviewAnnouncement): Promise<void> => {
    if (review.requests.length === 0 || deps.scheduleOf(review.taskId) !== undefined) return;
    const replyTarget = await replyTargetOf(review.taskId, review.invocation);
    if (replyTarget === undefined || deps.isLocalConnection(replyTarget.connectionId)) return;
    const ids = review.requests.map((request) => request.artifactId).sort();
    await send(
      { workspaceId: review.invocation.workspaceId },
      `review:${review.taskId}:${createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 32)}`,
      reviewNoticeText(review.requests),
      replyTarget,
    );
  };

  const announceRound = async (announcement: ApprovalRoundAnnouncement): Promise<void> => {
    const existing = await repositories.approvalRounds.get(announcement.taskId, announcement.steps);
    // A round already announced, or already decided: nothing to do.
    if (
      existing !== undefined &&
      (existing.settledAt !== undefined ||
        (await repositories.approvalRounds.listEvents(existing.taskId, existing.steps)).some((event) => event.kind === "announced"))
    )
      return;
    // A round that goes to no chat is still recorded with its risk and each
    // call's scopes, so the approvals inbox offers what the gate offered. Only
    // when every call was assessed: an unassessed call offers `once` alone.
    const recordUnannounced = async (): Promise<void> => {
      if (existing !== undefined || announcement.requests.some((request) => request.risk === undefined)) return;
      await repositories.approvalRounds.create({
        taskId: announcement.taskId,
        steps: announcement.steps,
        token: newRoundToken(deps.fillRandom),
        workspaceId: announcement.invocation.workspaceId,
        risk: maxRisk(...announcement.requests.map((request) => request.risk?.level ?? "medium")),
        ...roundLabelOf(announcement.requests),
        callScopes: callScopesOf(announcement.requests),
        createdAt: deps.now(),
      });
    };
    // A schedule's fire answers its own rounds.
    if (deps.scheduleOf(announcement.taskId) !== undefined) return recordUnannounced();
    const replyTarget = await replyTargetOf(announcement.taskId, announcement.invocation);
    if (replyTarget === undefined || deps.isLocalConnection(replyTarget.connectionId)) return recordUnannounced();
    const createdAt = deps.now();
    const risk = maxRisk(...announcement.requests.map((request) => request.risk?.level ?? "medium"));
    // A round recorded by an attempt that crashed or failed before sending is
    // sent now, by the node that re-entered: the same round and token.
    const round =
      existing ??
      (
        await repositories.approvalRounds.create({
          taskId: announcement.taskId,
          steps: announcement.steps,
          token: newRoundToken(deps.fillRandom),
          workspaceId: announcement.invocation.workspaceId,
          connectionId: replyTarget.connectionId,
          conversationId: replyTarget.externalConversationId,
          expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
          risk,
          ...roundLabelOf(announcement.requests),
          callScopes: callScopesOf(announcement.requests),
          createdAt,
        })
      ).round;
    const email = deps.isEmailConnection?.(replyTarget.connectionId) === true;
    const group = roundGroup(announcement.requests);
    const maxTextLength = deps.messaging.capabilitiesOf(replyTarget.connectionId)?.maxTextLength;
    const withheld = await linksWithheld(round.taskId, replyTarget);
    const links = !withheld && deps.linkBase?.(replyTarget.connectionId) !== undefined;
    const forms = announcement.requests.flatMap((request) => (request.display?.form === undefined ? [] : [request.display.form]));
    // A fill's values: masked in the owner's one-to-one chat; labels only in a group, a topic or an email,
    // whose link page shows the masked view. Approvable only where every row was shown and every masked one verified.
    // One-to-one as the turn was admitted (`audience`); a delegated task's round, by its conversation's record.
    // The owner's own one-to-one chat only: a person's round is the operator's, and shows them labels.
    // A room's round shown to its decider one-to-one is rendered as their own chat's card.
    const placement = await privatePlacementOf(round, replyTarget);
    const privately = placement?.destination !== undefined;
    const direct =
      privately ||
      (!email &&
        !operatorDecides(announcement.invocation) &&
        (announcement.invocation.messagingReplyTo?.audience === "one-to-one" || (await conversationKindOf(replyTarget)) === "direct"));
    const approvable = forms.every((form) => maskedApprovable(form));
    let listedAll = true;
    const render = (formView: "masked" | "labels", formApproval: "none" | "link" | undefined): string =>
      renderRoundText(announcement, round.token, undefined, {
        ...(withheld || (!privately && operatorDecides(announcement.invocation)) ? { operatorDecides: true } : {}),
        ...(email ? { email: { links } } : {}),
        ...(maxTextLength === undefined ? {} : { maxTextLength }),
        ...(forms.length === 0 ? {} : { formView }),
        ...(formApproval === undefined ? {} : { formApproval }),
        onListed: (listed) => {
          listedAll = listed === announcement.requests.length;
        },
      });
    let formApproval: "none" | "link" | undefined =
      forms.length === 0 ? undefined : direct ? (approvable ? undefined : "none") : email && links && approvable ? "link" : "none";
    let body = render(direct ? "masked" : "labels", formApproval);
    // A form whose call did not fit the card was not shown: the round is decided where it is.
    if (forms.length > 0 && !listedAll && formApproval !== "none") {
      formApproval = "none";
      body = render(direct ? "masked" : "labels", formApproval);
    }
    // Rows that do not fit three messages (the links and expiry line beside them) are not shown, so the chat may only reject.
    const fits = (text: string): boolean =>
      maxTextLength === undefined ||
      splitMessage(round.expiresAt === undefined ? text : `${text}\n${roundExpiryLine(round.expiresAt)}`, maxTextLength, 3) !== undefined;
    if (forms.length > 0 && !fits(body)) {
      formApproval = "none";
      body = render("labels", formApproval);
    }
    const message: RoundMessage = {
      body,
      scopes: roundScopes(announcement.requests),
      subjectTitle: announcement.requests[0]?.display?.title ?? announcement.requests[0]?.summary ?? "a tool call",
      ...(group === undefined ? {} : { group, groupName: groupName(group, announcement.requests) }),
      ...(formApproval === undefined ? {} : { formApproval }),
      ...(email && formApproval === "link" ? { linkForms: forms.map((form) => maskedForm(form)) } : {}),
    };
    await deliver(round, message, replyTarget, round.expiresAt, placement);
  };

  /** Where a settled round's outcome is shown, or `undefined` when it was not announced to a chat. */
  const settledReplyTarget = async (
    round: ApprovalRoundRecord,
    invocation?: ApprovalRoundAnnouncement["invocation"],
  ): Promise<ReplyTarget | undefined> => {
    if (round.connectionId === undefined) return undefined;
    const replyTarget = await replyTargetOf(round.taskId, invocation);
    return replyTarget === undefined || replyTarget.connectionId !== round.connectionId ? undefined : replyTarget;
  };

  /**
   * Show a settled round's outcome where it was announced: the announcement
   * edited in place where the connector can, and a follow-up otherwise —
   * unless it was decided in that conversation, whose own reply says so.
   * Recorded as `notified`; a failure is retried by the sweep.
   */
  const notify = async (round: ApprovalRoundRecord, notice: string, via: string, replyTarget: ReplyTarget): Promise<void> => {
    const connectionId = replyTarget.connectionId;
    const deliveries = await repositories.approvalRoundDeliveries.listForRound(round.taskId, round.steps);
    if (deliveries.length > 0) {
      await notifyDeliveries(round, notice, via, deliveries);
      return;
    }
    const announced = (await repositories.approvalRounds.listEvents(round.taskId, round.steps)).find((event) => event.kind === "announced");
    const announcedText = announced?.detail?.["text"];
    const recordedParts = announced?.detail?.["parts"];
    const parts =
      Array.isArray(recordedParts) && recordedParts.every((part) => typeof part === "string") ? (recordedParts as string[]) : undefined;
    let shown = false;
    if (
      typeof announcedText === "string" &&
      deps.messaging.capabilitiesOf(connectionId)?.editOrProgress === true &&
      round.messageIds.length > 0
    ) {
      try {
        if (parts !== undefined) {
          // An announcement sent in parts: each part edited back to its own text, the last carrying the outcome.
          for (const [index, messageId] of round.messageIds.entries()) {
            const last = index === round.messageIds.length - 1;
            const own = parts[index] ?? "";
            const edited = await deps.messaging.editMessage(connectionId, {
              destination: destinationOf(replyTarget),
              messageId,
              text: last ? (own === "" ? notice : `${own}\n\n${notice}`) : own === "" ? notice : own,
            });
            if (last) shown = edited;
          }
        }
        // Every part of the announcement loses its buttons; the first carries the outcome.
        else
          for (const [index, messageId] of round.messageIds.entries()) {
            const edited = await deps.messaging.editMessage(connectionId, {
              destination: destinationOf(replyTarget),
              messageId,
              text: index === 0 ? `${announcedText}\n\n${notice}` : notice,
            });
            if (index === 0) shown = edited;
          }
      } catch (error) {
        deps.onDiagnostic?.("a decided round's message could not be edited", {
          taskId: round.taskId,
          steps: round.steps,
          error: errorMessage(error),
        });
      }
    }
    // A decision made in this conversation was already answered there — but
    // when the edit failed, a button's presser has seen nothing else.
    const decidedHere = via === connectionId && deps.messaging.capabilitiesOf(connectionId)?.editOrProgress !== true;
    if (!shown && !decidedHere) {
      const failures = (await repositories.approvalRounds.listEvents(round.taskId, round.steps)).filter(
        (event) => event.kind === "notify_failed",
      ).length;
      try {
        await send(round, `approval-settled:${round.taskId}:${round.steps}${failures === 0 ? "" : `:${failures}`}`, notice, replyTarget);
      } catch (error) {
        // Counted so the sweep's next attempt is a new outbox effect.
        await repositories.approvalRounds.appendEvent({
          taskId: round.taskId,
          steps: round.steps,
          kind: "notify_failed",
          via: connectionId,
          detail: { error: clip(errorMessage(error), 300) },
          at: deps.now(),
        });
        throw error;
      }
    }
    await repositories.approvalRounds.appendEvent({
      taskId: round.taskId,
      steps: round.steps,
      kind: "notified",
      via: connectionId,
      detail: { edited: shown },
      at: deps.now(),
    });
  };

  /**
   * A room's round settled: each delivery edited through its own
   * destination — the card in the decider's chat, the notice in the room —
   * and, where the card could not be edited, the outcome sent after it there,
   * or in the room when no card was shown.
   */
  const notifyDeliveries = async (
    round: ApprovalRoundRecord,
    notice: string,
    via: string,
    deliveries: readonly ApprovalRoundDeliveryRecord[],
  ): Promise<void> => {
    const shown = new Set<ApprovalRoundDeliveryRecord["role"]>();
    for (const delivery of deliveries) {
      if (deps.messaging.capabilitiesOf(delivery.connectionId)?.editOrProgress !== true) continue;
      try {
        for (const [index, messageId] of delivery.messageIds.entries()) {
          const edited = await deps.messaging.editMessage(delivery.connectionId, {
            destination: delivery.destination,
            messageId,
            text: index === 0 ? `${delivery.text}\n\n${notice}` : notice,
          });
          if (index === 0 && edited) shown.add(delivery.role);
        }
      } catch (error) {
        deps.onDiagnostic?.("a decided round's message could not be edited", {
          taskId: round.taskId,
          steps: round.steps,
          role: delivery.role,
          error: errorMessage(error),
        });
      }
    }
    // The outcome is told where the round was shown: the card's chat, or the room when no card was shown.
    const target = deliveries.find((delivery) => delivery.role === "card") ?? deliveries.find((delivery) => delivery.role === "notice");
    if (target === undefined) return;
    const decidedHere = via === target.connectionId && deps.messaging.capabilitiesOf(target.connectionId)?.editOrProgress !== true;
    if (!shown.has(target.role) && !decidedHere) {
      const failures = (await repositories.approvalRounds.listEvents(round.taskId, round.steps)).filter(
        (event) => event.kind === "notify_failed",
      ).length;
      try {
        const outcome = await deps.messaging.send({
          effectId: `approval-settled:${round.taskId}:${round.steps}${failures === 0 ? "" : `:${failures}`}`,
          connectionId: target.connectionId,
          workspaceId: round.workspaceId,
          destination: target.destination,
          parts: [{ content: notice }],
        });
        if (outcome.status === "rejected")
          throw new TaviError("UNAVAILABLE", `the connector refused the message (${outcome.parts[0]?.error ?? "no reason given"})`);
      } catch (error) {
        await repositories.approvalRounds.appendEvent({
          taskId: round.taskId,
          steps: round.steps,
          kind: "notify_failed",
          via: target.connectionId,
          detail: { error: clip(errorMessage(error), 300) },
          at: deps.now(),
        });
        throw error;
      }
    }
    await repositories.approvalRounds.appendEvent({
      taskId: round.taskId,
      steps: round.steps,
      kind: "notified",
      via: target.connectionId,
      detail: { edited: shown.has(target.role) },
      at: deps.now(),
    });
  };

  const onRoundSettled = async (settlement: ApprovalRoundSettlement): Promise<void> => {
    // A node re-entered after a crash reports the same settlement again.
    if (
      (await repositories.approvalRounds.listEvents(settlement.taskId, settlement.steps)).some(
        (event) => event.kind === "settled" || event.kind === "expired",
      )
    )
      return;
    const at = deps.now();
    const expired = settlement.decisions.every((decision) => decision.decidedBy === EXPIRED_DECIDER);
    const via = settlement.via ?? (expired ? "policy" : "ipc");
    await repositories.approvalRounds.settle(settlement.taskId, settlement.steps, at);
    const round = await repositories.approvalRounds.get(settlement.taskId, settlement.steps);
    const notice = round === undefined ? undefined : settlementText(round, settlement, expired, deps.channelName?.(via) ?? via, at);
    await repositories.approvalRounds.appendEvent({
      taskId: settlement.taskId,
      steps: settlement.steps,
      kind: expired ? "expired" : "settled",
      via,
      ...(settlement.decisions[0] === undefined ? {} : { actor: settlement.decisions[0].decidedBy }),
      detail: {
        decisions: settlement.decisions.map((decision) => ({
          callId: decision.callId,
          toolName: decision.toolName,
          approved: decision.approved,
          scope: decision.scope,
          ...(decision.note === undefined ? {} : { note: decision.note }),
        })),
        ...(notice === undefined ? {} : { notice }),
      },
      at,
    });
    for (const decision of settlement.decisions) {
      if (!decision.approved || decision.scope === "once") continue;
      await repositories.approvalRounds.appendEvent({
        taskId: settlement.taskId,
        steps: settlement.steps,
        kind: decision.scope === "session" ? "grant_created" : "rule_created",
        via,
        actor: decision.decidedBy,
        // What to revoke: `tavi permissions rm <id>` or `revoke <id>`.
        detail: { toolName: decision.toolName, callId: decision.callId, created: decision.created ?? [] },
        at,
      });
    }
    if (round === undefined || notice === undefined) return;
    const replyTarget = await settledReplyTarget(round, settlement.invocation);
    // A round that never reached its chat has nothing there to settle.
    if (
      replyTarget === undefined ||
      !(await repositories.approvalRounds.listEvents(round.taskId, round.steps)).some((event) => event.kind === "announced")
    )
      return;
    await notify(round, notice, via, replyTarget);
  };

  const onConversationReset: ChannelApprovals["onConversationReset"] = async ({ taskId, via, actor }) => {
    try {
      for (const round of await repositories.approvalRounds.listForTask(taskId)) {
        if (round.settledAt !== undefined) continue;
        const at = deps.now();
        if (!(await repositories.approvalRounds.settle(round.taskId, round.steps, at))) continue;
        await repositories.approvalRounds.appendEvent({
          taskId: round.taskId,
          steps: round.steps,
          kind: "settled",
          via,
          ...(actor === undefined ? {} : { actor }),
          detail: { reason: ROUND_RESET_REASON, notice: ROUND_RESET_NOTICE },
          at,
        });
        const replyTarget = await settledReplyTarget(round);
        if (
          replyTarget === undefined ||
          !(await repositories.approvalRounds.listEvents(round.taskId, round.steps)).some((event) => event.kind === "announced")
        )
          continue;
        await notify(round, ROUND_RESET_NOTICE, via, replyTarget).catch((error: unknown) =>
          deps.onDiagnostic?.("a reset conversation's round could not be shown as withdrawn", {
            taskId: round.taskId,
            steps: round.steps,
            error: errorMessage(error),
          }),
        );
      }
    } catch (error) {
      deps.onDiagnostic?.("a reset conversation's rounds could not be withdrawn", { taskId, error: errorMessage(error) });
    }
  };
  /** Whether a settled round was withdrawn by `/new` rather than decided. */
  const resetRound = async (round: ApprovalRoundRecord): Promise<boolean> =>
    (await repositories.approvalRounds.listEvents(round.taskId, round.steps)).some(
      (event) => event.kind === "settled" && event.detail?.["reason"] === ROUND_RESET_REASON,
    );

  /**
   * Announcements that failed (the connection was down, the owner was not
   * running) and settlement notices that were never shown, sent again. An
   * announcement first seen late gets its full time to be decided.
   */
  const retryDeliveries = async (): Promise<void> => {
    for (const round of await repositories.approvalRounds.listUnannounced(20)) {
      const failed = (await repositories.approvalRounds.listEvents(round.taskId, round.steps))
        .filter((event) => event.kind === "announce_failed")
        .at(-1)?.detail;
      const body = failed?.["body"];
      const replyTarget = await replyTargetOf(round.taskId);
      if (typeof body !== "string" || replyTarget === undefined || replyTarget.connectionId !== round.connectionId) continue;
      if (
        deps.messaging.buildReplyDestination(replyTarget.connectionId, {
          externalConversationId: replyTarget.externalConversationId,
          externalSenderId: replyTarget.externalSenderId,
        }) === undefined
      )
        continue;
      const scopes = Array.isArray(failed?.["scopes"])
        ? (failed["scopes"] as unknown[]).filter((scope): scope is ApprovalScope => SCOPES.includes(scope as ApprovalScope))
        : ["once" as const];
      const expiresAt = round.expiresAt === undefined ? undefined : new Date(Date.parse(deps.now()) + ttlMs).toISOString();
      if (expiresAt !== undefined) await repositories.approvalRounds.setExpiry(round.taskId, round.steps, expiresAt);
      try {
        const group = failed?.["group"];
        const named = failed?.["groupName"];
        await deliver(
          round,
          {
            body,
            scopes,
            subjectTitle: typeof failed?.["subjectTitle"] === "string" ? failed["subjectTitle"] : "a tool call",
            ...(typeof group === "string" ? { group } : {}),
            ...(typeof named === "string" ? { groupName: named } : {}),
            ...formOfDetail(failed),
          },
          replyTarget,
          expiresAt,
        );
      } catch (error) {
        deps.onDiagnostic?.("an approval round could not be announced again", {
          taskId: round.taskId,
          steps: round.steps,
          error: errorMessage(error),
        });
      }
    }
    const since = new Date(Date.parse(deps.now()) - NOTIFY_RETRY_WINDOW_MS).toISOString();
    for (const round of await repositories.approvalRounds.listUnnotified(since, 20)) {
      const settled = (await repositories.approvalRounds.listEvents(round.taskId, round.steps)).find(
        (event) => event.kind === "settled" || event.kind === "expired",
      );
      const notice = settled?.detail?.["notice"];
      const replyTarget = await settledReplyTarget(round);
      if (typeof notice !== "string" || replyTarget === undefined) continue;
      if (
        deps.messaging.buildReplyDestination(replyTarget.connectionId, {
          externalConversationId: replyTarget.externalConversationId,
          externalSenderId: replyTarget.externalSenderId,
        }) === undefined
      )
        continue;
      try {
        await notify(round, notice, settled?.via ?? "ipc", replyTarget);
      } catch (error) {
        deps.onDiagnostic?.("a decided round's outcome could not be shown again", {
          taskId: round.taskId,
          steps: round.steps,
          error: errorMessage(error),
        });
      }
    }
  };

  const decide = async (
    {
      actor,
      connectionId,
      conversationTaskId,
      command: typed,
      senderAuthentication,
      via: decidedVia,
      announcedIn,
    }: Parameters<ChannelApprovals["decide"]>[0],
    beforeAdmission?: () => void,
  ): ReturnType<ChannelApprovals["decide"]> => {
    const tokenRound = typed.target === undefined ? undefined : await repositories.approvalRounds.getByToken(typed.target.toLowerCase());
    // `approve it`, `allow notifications`: a second word that looks like
    // neither a round token nor a task id is not naming a round — the message
    // is an answer to a question, or an instruction, and goes on as one.
    if (
      typed.approved &&
      typed.target !== undefined &&
      tokenRound === undefined &&
      !ROUND_TOKEN_SHAPE.test(typed.target) &&
      !TASK_ID_SHAPE.test(typed.target) &&
      (await repositories.tasks.get(typed.target)) === undefined
    ) {
      return undefined;
    }
    if (
      typed.target !== undefined &&
      tokenRound === undefined &&
      ROUND_TOKEN_SHAPE.test(typed.target) &&
      (await repositories.tasks.get(typed.target)) === undefined
    ) {
      // No task to key it to: an unknown token is a diagnostic, not a round event.
      deps.onDiagnostic?.("a decision named an unknown round token", { connectionId, principalId: actor.principalId });
    }
    // `reject too risky`: a first word that names no round and no task is the
    // start of the reason. An approval is never reinterpreted — a mistyped
    // token must not approve whatever round the conversation has pending.
    const command: ApprovalCommand =
      typed.target !== undefined &&
      tokenRound === undefined &&
      !typed.approved &&
      conversationTaskId !== undefined &&
      (await repositories.tasks.get(typed.target)) === undefined
        ? {
            approved: false,
            note: [typed.target, typed.note]
              .filter((part) => part !== undefined)
              .join(" ")
              .slice(0, 500),
          }
        : typed;
    const byToken = command.target === undefined ? undefined : tokenRound;
    const taskId = byToken?.taskId ?? command.target ?? conversationTaskId;
    if (taskId === undefined) return "There is nothing to approve or reject: this conversation has no task.";
    const task = await repositories.tasks.get(taskId);
    // Workspace *and* principal: any other sender bound in the same workspace
    // must not decide this task's rounds. A person's own task goes on below, so
    // a word that answers its question still reaches it; its rounds are the operator's.
    const ownTask = task !== undefined && task.workspaceId === actor.workspaceId && task.principalId === actor.principalId;
    if (task === undefined || (!ownTask && !mayDecide(task, actor))) {
      // Someone else's round, named by its token: worth a line in its audit trail.
      if (byToken !== undefined)
        await repositories.approvalRounds.appendEvent({
          taskId: byToken.taskId,
          steps: byToken.steps,
          kind: "decision_refused",
          via: connectionId,
          actor: actor.principalId,
          detail: { reason: "not-owner" },
          at: deps.now(),
        });
      return `There is no task ${JSON.stringify(command.target ?? taskId)} of yours to decide.`;
    }
    // A question the task is waiting on wins over the keyword: "approve" is a
    // plausible answer to "shall I?". A token names a round, so it never does.
    const waiting = await repositories.agentWaits.getActiveByTask(taskId);
    if (
      byToken === undefined &&
      waiting !== undefined &&
      waiting.correlationId === undefined &&
      waiting.waitingOnWorkerTaskId === undefined
    )
      return undefined;
    const schedule = deps.scheduleOf(taskId);
    if (schedule !== undefined) return `Task ${taskId}: ${scheduleInFlightMessage(taskId, schedule)}.`;
    const decidability = await decidableRound(repositories, task);
    const round = decidability.decidable ? decidability.round : undefined;
    // `deny the request from alice` with no round to decide is an instruction,
    // not a command: let it reach the model.
    if (byToken === undefined && !command.approved && command.note !== undefined && (round === undefined || round.kind !== "approval"))
      return undefined;
    // Every refusal of a round that can be named is recorded: by its token, or
    // the task's current round when the command named the task.
    const refusedSteps =
      byToken?.steps ??
      (round !== undefined && (await repositories.approvalRounds.get(taskId, round.steps)) !== undefined ? round.steps : undefined);
    const refuse = async (reason: string, message: string) => {
      if (refusedSteps !== undefined)
        await repositories.approvalRounds.appendEvent({
          taskId,
          steps: refusedSteps,
          kind: "decision_refused",
          via: connectionId,
          actor: actor.principalId,
          detail: { reason },
          at: deps.now(),
        });
      return message;
    };
    if (round === undefined || round.kind !== "approval") {
      const lingering = (await repositories.approvals.listForTask(taskId)).some((record) => record.state === "pending");
      if (byToken !== undefined && (await resetRound(byToken))) return await refuse("conversation-reset", ROUND_RESET_NOTICE);
      if (!decidability.decidable && decidability.reason === "cancelled")
        return await refuse("cancelled", `Task ${taskId} is cancelled; there is nothing to decide.`);
      if (!decidability.decidable && decidability.reason === "settled-uncommitted")
        return await refuse("settled-uncommitted", `Task ${taskId}: ${undecidableRoundMessage(taskId, decidability, "approval")}.`);
      if (lingering && task.status !== "waiting")
        return await refuse("not-waiting", `Task ${taskId} is ${task.status}; there is nothing to decide.`);
      return await refuse("no-round", `Task ${taskId} has no pending approval.`);
    }
    // A person's round is decided by the operator alone (Allowed people).
    if (!mayDecide(task, actor)) return await refuse("operator-decides", OPERATOR_DECIDES);
    // A form fill whose values this chat did not show in full, or showed masked without a verified source, is
    // approved only in Tavi; one announced by email, only through its link. Rejecting stays open.
    if (command.approved) {
      // As the round was (or will again be) announced; a fill never announced here is not approved here at all.
      const announced = (await repositories.approvalRounds.listEvents(taskId, round.steps))
        .filter((event) => event.kind === "announced" || event.kind === "announce_failed")
        .at(-1);
      const fills = (await repositories.approvals.listForTask(taskId)).some(
        (record) => record.steps === round.steps && record.state === "pending" && FORM_TOOLS.has(record.toolId),
      );
      const formApproval = announced === undefined ? (fills ? "none" : undefined) : formOfDetail(announced.detail).formApproval;
      if (formApproval === "none" || (formApproval === "link" && decidedVia !== "link")) {
        return await refuse(
          "form-not-shown",
          `Task ${taskId}: this form fill can be approved only ${formApproval === "link" ? "through the link in its email, or " : ""}in Tavi (\`tavi approvals show ${taskId}\` or the approvals view in \`tavi ui\`), where every value is shown. You can still reject it here.`,
        );
      }
    }
    // A token names one round: a later round of the same task is not it.
    if (byToken !== undefined && round.steps !== byToken.steps)
      return await refuse("stale-token", `Round ${command.target} was already decided.`);
    // Past its expiry the round is the sweep's to deny, even before the sweep runs.
    const record = await repositories.approvalRounds.get(taskId, round.steps);
    if (
      record?.expiresAt !== undefined &&
      Date.parse(record.expiresAt) <= Date.parse(deps.now()) &&
      (await repositories.approvalRounds.listEvents(taskId, record.steps)).some((event) => event.kind === "announced")
    ) {
      void sweepExpired().catch((error: unknown) =>
        deps.onDiagnostic?.("approval round expiry sweep failed", { error: errorMessage(error) }),
      );
      return await refuse("expired", `Round ${record.token} expired and is rejected; the task goes on without it.`);
    }
    // In a DM linked to Home, a bare verb decides only a round announced to that DM.
    if (
      announcedIn !== undefined &&
      byToken === undefined &&
      (record?.connectionId !== announcedIn.connectionId || record?.conversationId !== announcedIn.conversationId)
    ) {
      return await refuse(
        "not-announced-here",
        `Home's pending round was not asked in this chat. Name it by its token (shown where it was asked), or decide it in the app or with \`tavi approvals\`.`,
      );
    }
    // An email's From can be forged: a reply decides only when Mailgun
    // authenticated its sender, and only a round a forged reply could not do
    // much harm with. The link in the email covers the rest.
    if (senderAuthentication !== undefined) {
      // The round's token proves the reply answers the email that carried it;
      // a conversation's pending round is not enough when a From can be forged.
      if (byToken === undefined) {
        return await refuse(
          "reply-without-token",
          "Reply to the approval email itself, keeping its subject line (`[tavi …]`), or decide it with a link in that email or `tavi approvals`.",
        );
      }
      if (command.approved && command.scope !== undefined && command.scope !== "once") {
        return await refuse(
          "reply-scope",
          "An email reply can approve once only. Use a link in the approval email to approve for the chat or always.",
        );
      }
      if (senderAuthentication !== "pass") {
        return await refuse(
          "unverified-sender",
          "This reply could not be verified as coming from you (its sender did not pass SPF and DKIM). Decide it with a link in the approval email, or with `tavi approvals`.",
        );
      }
      const roundRisk = (await repositories.approvalRounds.get(taskId, round.steps))?.risk;
      if (roundRisk !== "low" && roundRisk !== "medium") {
        return await refuse(
          "reply-risk",
          "An email reply can decide only a low- or medium-risk round. Use a link in the approval email, or `tavi approvals`.",
        );
      }
    }
    const workflow = deps.workflow();
    if (workflow === undefined) return "Approvals cannot be decided here: no model connection is configured.";
    // An email reply stays one call, even for a round that defaults wider.
    const scope: ApprovalScope | undefined = senderAuthentication === undefined ? command.scope : "once";
    try {
      beforeAdmission?.();
      const resumed = await workflow.admit({
        // The task's own identity, never the sender's: a follow-up admission
        // is refused unless its principal equals the task's.
        context: { workspaceId: task.workspaceId, principalId: task.principalId, caller: `messaging:${connectionId}`, runId: taskId },
        taskId,
        operationKey: roundResumeKey(taskId, round),
        kind: "approval",
        resume: {
          decisions: round.callIds.map((callId) => ({
            callId,
            approved: command.approved,
            decidedBy: actor.principalId,
            ...(command.approved && scope !== undefined ? { scope } : {}),
            ...(!command.approved && command.note !== undefined ? { note: command.note } : {}),
          })),
          via: decidedVia ?? connectionId,
          ...expectedStepsOf(round),
        },
      });
      const stillPending = (await repositories.approvals.listForTask(taskId)).filter((record) => record.state === "pending").length;
      return (
        `Task ${taskId} ${command.approved ? `approved${await appliedScopeText(taskId, round.steps, scope)}` : "rejected"}: the run is now ${resumed.outcome.status}` +
        (stillPending === 0 ? "." : `, with ${stillPending} approval(s) still pending.`)
      );
    } catch (error) {
      // Link callers retain their claim when a dispatched admission has an
      // uncertain outcome, including a lost database acknowledgement.
      if (beforeAdmission !== undefined) throw error;
      return await refuse("admission-failed", `Task ${taskId}: the decision could not be applied (${errorMessage(error)}).`);
    }
  };

  /**
   * The scope the round was actually granted with, from its settlement record:
   * a wider scope than a call's verdict offered is applied as `once`, and the
   * person must not be told otherwise.
   */
  const appliedScopeText = async (taskId: string, steps: number, requested: ApprovalScope | undefined): Promise<string> => {
    const settled = (await repositories.approvalRounds.listEvents(taskId, steps)).find((event) => event.kind === "settled");
    const decisions = (settled?.detail?.["decisions"] ?? []) as readonly { readonly scope?: string }[];
    const applied = [...new Set(decisions.map((decision) => decision.scope ?? "once"))];
    // No scope asked for: say what the round's default applied (a browser round's is the task).
    if (requested === undefined) return applied.length === 1 && applied[0] !== "once" ? ` (${applied[0]})` : "";
    const wanted = requested;
    if (applied.length === 0) return wanted === "once" ? "" : ` (${wanted})`;
    if (applied.length === 1 && applied[0] === wanted) return wanted === "once" ? "" : ` (${wanted})`;
    return applied.length === 1 && applied[0] === "once"
      ? ` once (${wanted} is not offered for this round)`
      : ` (${applied.join(" and ")}; ${wanted} was not offered for every call)`;
  };

  const sweepExpired = async (): Promise<number> => {
    await retryDeliveries();
    // ❌ presses whose reason window ended while no timer was left to end it
    // (the owner restarted): rejected without a reason, as the timer would have.
    for (const pending of await repositories.needDeliveries.takeExpiredReasons(deps.now())) {
      try {
        await rejectWithoutReason(pending);
      } catch (error) {
        deps.onDiagnostic?.("a round could not be rejected after its reason window", { token: pending.token, error: errorMessage(error) });
      }
    }
    const workflow = deps.workflow();
    if (workflow === undefined) return 0;
    let decided = 0;
    for (const expired of await repositories.approvalRounds.listExpired(deps.now(), 50)) {
      const task = await repositories.tasks.get(expired.taskId);
      const decidability = task === undefined ? undefined : await decidableRound(repositories, task);
      const round = decidability?.decidable === true ? decidability.round : undefined;
      if (task === undefined || round === undefined || round.kind !== "approval" || round.steps !== expired.steps) {
        // Decided elsewhere without a settlement report, or gone: close it.
        await repositories.approvalRounds.settle(expired.taskId, expired.steps, deps.now());
        continue;
      }
      if (deps.scheduleOf(task.taskId) !== undefined) continue;
      try {
        await workflow.admit({
          context: { workspaceId: task.workspaceId, principalId: task.principalId, caller: EXPIRED_DECIDER, runId: task.taskId },
          taskId: task.taskId,
          operationKey: roundResumeKey(task.taskId, round),
          kind: "approval",
          resume: {
            decisions: round.callIds.map((callId) => ({ callId, approved: false, decidedBy: EXPIRED_DECIDER, note: EXPIRED_NOTE })),
            via: "policy",
            ...expectedStepsOf(round),
          },
        });
        decided += 1;
      } catch (error) {
        // Another front end decided it first (the round key's CONFLICT): the
        // next sweep finds it settled.
        deps.onDiagnostic?.("an expired approval round could not be denied", {
          taskId: task.taskId,
          steps: expired.steps,
          error: errorMessage(error),
        });
      }
    }
    return decided;
  };

  /**
   * ❌ presses waiting for their reason are held durably by conversation and
   * presser (`needDeliveries.putReason`); the timer is only the prompt path.
   * After a restart the channel sweep rejects an expired one without a reason.
   */
  const reasonTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reasonKey = (event: InboundEvent) => `${event.connectionId}\u0000${event.externalConversationId}\u0000${event.externalSenderId}`;
  const replyTargetOfEvent = (event: InboundEvent) => ({
    connectionId: event.connectionId,
    externalConversationId: event.externalConversationId,
    externalSenderId: event.externalSenderId,
    ...(event.externalThreadId === undefined ? {} : { externalThreadId: event.externalThreadId }),
  });
  const tell = async (actor: MemoryActor, event: InboundEvent, effectId: string, text: string): Promise<void> => {
    try {
      await send({ workspaceId: actor.workspaceId }, effectId, text, replyTargetOfEvent(event));
    } catch (error) {
      deps.onDiagnostic?.("a chat approval notice could not be sent", { connectionId: event.connectionId, error: errorMessage(error) });
    }
  };
  const conversationTask = async (event: InboundEvent) =>
    (await repositories.messagingConversations.get(event.connectionId, event.externalConversationId))?.taskId;

  /** Whether the actor may decide the round: its task's workspace operator (or, with none named, the task's own principal). */
  const ownsRound = async (round: ApprovalRoundRecord, actor: MemoryActor): Promise<boolean> => {
    const task = await repositories.tasks.get(round.taskId);
    return task !== undefined && mayDecide(task, actor);
  };
  const isSettled = async (token: string): Promise<boolean> =>
    (await repositories.approvalRounds.getByToken(token))?.settledAt !== undefined;

  const handleInteraction: ChannelApprovals["handleInteraction"] = async ({ actor, event }) => {
    const data = event.interaction?.data ?? "";
    const press = pressOf(deps.messaging, event, { press: "a button press", message: "an approval's message" }, deps.onDiagnostic);
    const acknowledge = press.answer;
    // A press held in the inbox and replayed long after it was made decides
    // nothing — and answers nothing.
    if (press.tooOld(deps.now())) {
      await acknowledge("This button press is too old to act on.");
      return;
    }
    const questionPress = QUESTION_BUTTON.exec(data);
    if (questionPress !== null) {
      await answerQuestionPress(actor, event, questionPress[1] ?? "", questionPress[2] ?? "", acknowledge);
      return;
    }
    // The data is only a key: the round, and who may decide it, are looked up
    // here, and the presser is checked against the task's principal.
    const match = ROUND_BUTTON.exec(data);
    if (match === null) {
      await acknowledge("This button is no longer valid.");
      return;
    }
    const token = match[1] ?? "";
    const choice = match[2] ?? "";
    const round = await repositories.approvalRounds.getByToken(token);
    if (round === undefined || round.settledAt !== undefined) {
      await acknowledge(round !== undefined && (await resetRound(round)) ? ROUND_RESET_NOTICE : "This round was already decided.");
      return;
    }
    // Checked before anything else happens, ❌ included: in a group chat any
    // bound member can press, and only the task's owner may decide.
    if (!(await ownsRound(round, actor))) {
      await repositories.approvalRounds.appendEvent({
        taskId: round.taskId,
        steps: round.steps,
        kind: "decision_refused",
        via: event.connectionId,
        actor: actor.principalId,
        detail: { reason: "not-owner" },
        at: deps.now(),
      });
      const task = await repositories.tasks.get(round.taskId);
      await acknowledge(
        task !== undefined && task.principalId === actor.principalId && operatorDecides(task)
          ? OPERATOR_DECIDES
          : "Only the person this chat belongs to can decide it.",
      );
      return;
    }
    if (choice === "d") {
      const key = reasonKey(event);
      // A second ❌ for the round already asking for its reason asks nothing new.
      if ((await repositories.needDeliveries.getReason(key))?.token === token) {
        await acknowledge('Waiting for your reason — reply in this chat, or send "-".');
        return;
      }
      const windowMs = deps.reasonWindowMs ?? 120_000;
      await repositories.needDeliveries.putReason({
        key,
        token,
        workspaceId: actor.workspaceId,
        principalId: actor.principalId,
        caller: actor.caller,
        replyTarget: replyTargetOfEvent(event),
        expiresAt: new Date(Date.parse(deps.now()) + windowMs).toISOString(),
      });
      const previousTimer = reasonTimers.get(key);
      if (previousTimer !== undefined) clearTimeout(previousTimer);
      // Unanswered, the round is rejected without a reason — unless it was
      // decided some other way in the meantime.
      const timer = setTimeout(() => {
        if (reasonTimers.get(key) === timer) reasonTimers.delete(key);
        void repositories.needDeliveries
          .takeReason(key, token)
          .then((pending) => (pending === undefined ? undefined : rejectWithoutReason(pending)))
          .catch((error: unknown) =>
            deps.onDiagnostic?.("a round could not be rejected after its reason window", { token, error: errorMessage(error) }),
          );
      }, windowMs);
      timer.unref?.();
      reasonTimers.set(key, timer);
      const minutes = Math.max(1, Math.round(windowMs / 60_000));
      await acknowledge("Why reject it? (optional) Reply in this chat.");
      await tell(
        actor,
        event,
        `reason-prompt:${token}:${event.interaction?.callbackId ?? event.providerEventId}`,
        `Why reject round ${token}? (optional) Your next message here within ${plural(minutes, "minute")} is the reason the model reads — send "-" for none. With no reply, it is rejected without one.`,
      );
      return;
    }
    const scope = BUTTON_SCOPES[choice] ?? "once";
    // Acknowledged before the decision runs: the resumed turn can take far
    // longer than Telegram keeps a press answerable, and the presser's client
    // spins until it is answered.
    await acknowledge(`Approving round ${token}${scope === "once" ? "" : ` (${scope})`}…`);
    // Not awaited: the poll loop that delivered this press must not wait for
    // the turn it resumes. The round key makes the decision safe to finish late.
    void decide({
      actor,
      connectionId: event.connectionId,
      conversationTaskId: await conversationTask(event),
      command: { approved: true, target: token, scope },
    })
      .then(async (answer) => {
        // An edited announcement shows a decided round; say it in words when
        // the round was not decided, or the message cannot be edited.
        const editable = deps.messaging.capabilitiesOf(event.connectionId)?.editOrProgress === true;
        if (answer !== undefined && (!(await isSettled(token)) || !editable))
          await tell(actor, event, `press:${event.providerEventId}`, answer);
      })
      .catch((error: unknown) => deps.onDiagnostic?.("a button press could not be decided", { token, error: errorMessage(error) }));
  };

  /** A ❌ whose reason window ended unanswered: the round is rejected without one, unless it was decided meanwhile. */
  const rejectWithoutReason = async (pending: PendingReasonRecord): Promise<void> => {
    if (await isSettled(pending.token)) return;
    const actor: MemoryActor = {
      workspaceId: pending.workspaceId,
      principalId: pending.principalId,
      caller: pending.caller,
      authority: "operator",
    };
    const target = pending.replyTarget;
    const conversationTaskId = (await repositories.messagingConversations.get(target.connectionId, target.externalConversationId))?.taskId;
    const answer = await decide({
      actor,
      connectionId: target.connectionId,
      conversationTaskId,
      command: { approved: false, target: pending.token },
    });
    if (answer === undefined) return;
    try {
      await send({ workspaceId: actor.workspaceId }, `reject-timeout:${pending.token}`, answer, target);
    } catch (error) {
      deps.onDiagnostic?.("a chat approval notice could not be sent", { connectionId: target.connectionId, error: errorMessage(error) });
    }
  };

  const takePendingReason: ChannelApprovals["takePendingReason"] = async ({ actor, event }) => {
    if (event.kind !== "message") return false;
    const key = reasonKey(event);
    const pending = await repositories.needDeliveries.takeReason(key);
    if (pending === undefined) return false;
    const timer = reasonTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    reasonTimers.delete(key);
    // Decided some other way meanwhile, or the person typed a command instead
    // of a reason: this message is handled as it would be without the ❌.
    if ((await isSettled(pending.token)) || parseApprovalCommand(event.content ?? "") !== null) return false;
    const reason = (event.content ?? "").trim();
    // Not awaited, as a press is not: the poll loop that delivered this
    // message must not wait for the turn the rejection resumes.
    void decide({
      actor,
      connectionId: event.connectionId,
      conversationTaskId: await conversationTask(event),
      command: { approved: false, target: pending.token, ...(reason === "" || reason === "-" ? {} : { note: reason.slice(0, 500) }) },
    })
      .then((answer) =>
        answer === undefined ? undefined : tell(actor, event, `reject-reason:${pending.token}:${event.providerEventId}`, answer),
      )
      .catch((error: unknown) =>
        deps.onDiagnostic?.("a round could not be rejected with its reason", { token: pending.token, error: errorMessage(error) }),
      );
    return true;
  };

  const recordQuestion: ChannelApprovals["recordQuestion"] = async (delivery) => {
    await repositories.needDeliveries.record({ ...delivery, token: questionToken(delivery.waitId), createdAt: deps.now() });
  };

  const onQuestionSettled: ChannelApprovals["onQuestionSettled"] = async ({ waitId, outcome, via, at }) => {
    const report = (message: string, error: unknown, connectionId?: string) =>
      deps.onDiagnostic?.(message, { waitId, ...(connectionId === undefined ? {} : { connectionId }), error: errorMessage(error) });
    let deliveries: readonly NeedDeliveryRecord[];
    try {
      deliveries = await repositories.needDeliveries.listForWait(waitId);
    } catch (error) {
      report("a settled question's deliveries could not be read", error);
      return;
    }
    // Each delivery on its own: one connection's failure must not keep the
    // others showing live buttons.
    for (const delivery of deliveries) {
      const receipt = questionReceipt(
        outcome,
        via === delivery.connectionId ? undefined : (deps.channelName?.(via) ?? via),
        at ?? deps.now(),
      );
      let edited = false;
      if (delivery.providerMessageId !== undefined && deps.messaging.capabilitiesOf(delivery.connectionId)?.editOrProgress === true) {
        try {
          edited = await deps.messaging.editMessage(delivery.connectionId, {
            destination: delivery.destination,
            messageId: delivery.providerMessageId,
            text: `${delivery.text}\n\n${receipt}`,
            buttons: [],
          });
        } catch (error) {
          // Not edited: an expiry or withdrawal is still said below.
          report("a settled question's message could not be edited", error, delivery.connectionId);
        }
      }
      if (edited || outcome.kind === "answered") continue;
      try {
        const task = await repositories.tasks.get(delivery.taskId);
        if (task === undefined) {
          report("a settled question's task is gone; its follow-up was not sent", "task not found", delivery.connectionId);
          continue;
        }
        await deps.messaging.send({
          effectId: `question-settled:${waitId}:${delivery.connectionId}`,
          connectionId: delivery.connectionId,
          workspaceId: task.workspaceId,
          destination: delivery.destination,
          parts: [{ content: receipt }],
        });
      } catch (error) {
        report("a settled question's follow-up could not be sent", error, delivery.connectionId);
      }
    }
  };

  const answerQuestion: ChannelApprovals["answerQuestion"] = async ({ actor, taskId, waitId, outcome, via, beforeSettlement }) => {
    const answered = await answerWait(actor, await replyTargetOf(taskId), taskId, waitId, outcome, via, beforeSettlement);
    if (answered) await onQuestionSettled({ waitId, outcome, via });
    return answered;
  };

  /** Settle a question's wait with an answer and resume the task, exactly as a typed answer does. */
  const answerWait = async (
    actor: MemoryActor,
    replyTarget: ReplyTarget | undefined,
    taskId: string,
    waitId: string,
    outcome: AgentWaitOutcome,
    via: string,
    beforeSettlement?: () => void,
  ): Promise<boolean> => {
    const workflow = deps.workflow();
    if (workflow === undefined) return false;
    beforeSettlement?.();
    if (!(await repositories.agentWaits.settle({ waitId, outcome, resume: true, by: actor.principalId, via }))) return false;
    // Resumed as the task's own principal — the operator may answer a person's question — and recorded as answered by the actor.
    const task = await repositories.tasks.get(taskId);
    const owner =
      task === undefined
        ? { workspaceId: actor.workspaceId, principalId: actor.principalId }
        : { workspaceId: task.workspaceId, principalId: task.principalId };
    // Not awaited: the poll loop that delivered this press must not wait for the
    // turn it resumes. A resume that fails here stays pending on the row, and
    // the wait sweep admits it under the same key.
    void workflow
      .admit({
        context: { ...owner, runId: taskId, caller: actor.caller, ...(replyTarget === undefined ? {} : { messagingReplyTo: replyTarget }) },
        operationKey: waitResumeOperationKey(waitId),
        kind: "deadline",
        taskId,
        resume: { waitOutcome: outcome, waitId, via, decidedBy: actor.principalId },
      })
      .then(async () => {
        await repositories.agentWaits.markResumed(waitId);
      })
      .catch((error: unknown) =>
        deps.onDiagnostic?.("an answered question could not resume its task", { taskId, error: errorMessage(error) }),
      );
    return true;
  };

  const answerQuestionPress = async (
    actor: MemoryActor,
    event: InboundEvent,
    token: string,
    choice: string,
    acknowledge: (text: string) => Promise<void>,
  ): Promise<void> => {
    // The conversation's own task, or — for a question a scheduled, CLI or
    // delegated task sent to a named chat — the wait this owner sent it for.
    const conversationTaskId = await conversationTask(event);
    const conversationWait =
      conversationTaskId === undefined ? undefined : await repositories.agentWaits.getActiveByTask(conversationTaskId);
    const sentWaitId =
      conversationWait !== undefined && questionToken(conversationWait.waitId) === token
        ? undefined
        : (await repositories.needDeliveries.getByToken(token))?.waitId;
    const sentWait = sentWaitId === undefined ? undefined : await repositories.agentWaits.get(sentWaitId);
    const waiting = sentWait?.state === "active" ? sentWait : conversationWait;
    const taskId = waiting === sentWait && sentWait !== undefined ? sentWait.taskId : conversationTaskId;
    const task = taskId === undefined ? undefined : await repositories.tasks.get(taskId);
    const choices = waiting?.choices;
    // The data names a question only by a token derived from its wait: a press
    // for any other question, or one already answered, matches nothing.
    if (
      task === undefined ||
      waiting === undefined ||
      choices === undefined ||
      waiting.correlationId !== undefined ||
      waiting.waitingOnWorkerTaskId !== undefined ||
      questionToken(waiting.waitId) !== token
    ) {
      await acknowledge(closedQuestionText(sentWait ?? (await settledWaitOfToken(token))));
      return;
    }
    if (task.workspaceId !== actor.workspaceId || task.principalId !== actor.principalId) {
      await acknowledge("Only the person this chat belongs to can answer it.");
      return;
    }
    const messageId = event.interaction?.messageId;
    const edit = async (text: string, buttons?: readonly (readonly OutboundButton[])[]) => {
      if (messageId === undefined) return;
      try {
        await deps.messaging.editMessage(event.connectionId, {
          destination: destinationOf(replyTargetOfEvent(event)),
          messageId,
          text,
          ...(buttons === undefined ? {} : { buttons }),
        });
      } catch (error) {
        deps.onDiagnostic?.("a question's message could not be edited", { error: errorMessage(error) });
      }
    };
    // Recorded when the question was sent here; a question sent before
    // deliveries were recorded leaves its text alone rather than replacing it
    // with less than it says.
    const delivery = (await repositories.needDeliveries.listForWait(waiting.waitId)).find(
      (entry) => entry.connectionId === event.connectionId,
    );
    const shown = delivery?.text;
    if ((choice.startsWith("t") || choice === "ok") && delivery === undefined) {
      // Sent before deliveries were recorded, or its record failed: there is
      // nowhere to keep toggles, so the answer has to be typed.
      await acknowledge("Reply in this chat with the numbers you choose, e.g. 1, 3.");
      return;
    }
    if (choice.startsWith("t")) {
      const selected = new Set<number>(delivery?.selected ?? []);
      const index = Number(choice.slice(1));
      if (index > choices.options.length) {
        await acknowledge("This button is no longer valid.");
        return;
      }
      if (selected.has(index)) selected.delete(index);
      else selected.add(index);
      await repositories.needDeliveries.setSelected(
        waiting.waitId,
        event.connectionId,
        [...selected].sort((x, y) => x - y),
      );
      const names = [...selected].sort().flatMap((picked) => {
        const option = choices.options[picked - 1];
        return option === undefined ? [] : [option.label];
      });
      await acknowledge(names.length === 0 ? "Nothing selected" : clip(`Selected: ${names.join(", ")}`, 200));
      if (shown !== undefined) await edit(shown, questionButtons(token, choices, selected));
      return;
    }
    const picked = choice === "ok" ? [...(delivery?.selected ?? [])].sort((x, y) => x - y) : [Number(choice)];
    if (picked.length === 0) {
      await acknowledge("Pick at least one option first.");
      return;
    }
    const labels = picked.flatMap((index) => {
      const option = choices.options[index - 1];
      return option === undefined ? [] : [option.label];
    });
    if (labels.length !== picked.length) {
      await acknowledge("This button is no longer valid.");
      return;
    }
    // No message id: the pressed message is tavi's own question, not something the person wrote.
    const outcome: AgentWaitOutcome = { kind: "answered", replyText: labels.join(", "), answers: labels };
    if (!(await answerWait(actor, replyTargetOfEvent(event), task.taskId, waiting.waitId, outcome, event.connectionId))) {
      await acknowledge(closedQuestionText(await repositories.agentWaits.get(waiting.waitId)));
      return;
    }
    await acknowledge(`Answered: ${clip(labels.join(", "), 150)}`);
    // A recorded delivery is edited with every other one; a question sent
    // before deliveries were recorded is edited through the pressed message.
    if (delivery === undefined) await edit(`✅ Answered: ${labels.join(", ")}`);
    else await onQuestionSettled({ waitId: waiting.waitId, outcome, via: event.connectionId });
  };

  /** The settled wait a question token names, for a press that found no open question. */
  const settledWaitOfToken = async (token: string) => {
    const waitId = (await repositories.needDeliveries.getByToken(token))?.waitId;
    return waitId === undefined ? undefined : await repositories.agentWaits.get(waitId);
  };

  const questionLinkLines: ChannelApprovals["questionLinkLines"] = async ({ taskId, waitId, choices, connectionId }) => {
    const base = deps.linkBase?.(connectionId);
    if (base === undefined) return [];
    // A link lasts as long as its question — never past its wait's deadline —
    // and at most a day.
    const cap = Date.parse(deps.now()) + DEFAULT_CHANNEL_ROUND_TTL_MS;
    const deadline = Date.parse((await repositories.agentWaits.get(waitId))?.deadlineAt ?? "");
    const expiresAt = new Date(Number.isNaN(deadline) ? cap : Math.min(deadline, cap)).toISOString();
    // A multi-select question is one form with a box per option: a link per
    // option could only ever answer one of them.
    if (choices.multiSelect)
      return [`Choose: ${base}/i/${await mintLink({ taskId, kind: "question", waitId, choice: MULTI_SELECT_CHOICE, expiresAt })}`];
    return await Promise.all(
      choices.options.map(
        async (option, index) =>
          `${index + 1}. ${option.label}: ${base}/i/${await mintLink({ taskId, kind: "question", waitId, choice: String(index + 1), expiresAt })}`,
      ),
    );
  };

  /** What a link would do, or why it does nothing — read, never spent. */
  const readLink = async (
    token: string,
  ): Promise<{ readonly link: ApprovalLinkRecord; readonly view: LinkView } | { readonly refusal: string }> => {
    const link = /^[A-Za-z0-9_-]{16,64}$/.test(token) ? await repositories.approvalLinks.get(sha256Hex(token)) : undefined;
    if (link === undefined) return { refusal: "This link is not valid." };
    if (link.usedAt !== undefined) return { refusal: "This link was already used." };
    if (Date.parse(link.expiresAt) <= Date.parse(deps.now())) return { refusal: "This link has expired." };
    if (link.kind === "round") {
      const round = link.steps === undefined ? undefined : await repositories.approvalRounds.get(link.taskId, link.steps);
      if (round === undefined || round.settledAt !== undefined) return { refusal: "This round was already decided." };
      const announcedDetail = (await repositories.approvalRounds.listEvents(link.taskId, round.steps)).find(
        (event) => event.kind === "announced",
      )?.detail;
      const announced = announcedDetail?.["text"];
      const linkForms = formOfDetail(announcedDetail).linkForms;
      const choice = link.choice as ApprovalScope | "deny";
      return {
        link,
        view: {
          kind: "round",
          title: `Round ${round.token} of task ${link.taskId}`,
          body: typeof announced === "string" ? announced : "",
          choiceLabel: LINK_LABELS[choice] ?? link.choice,
          needsPin: round.risk === "critical",
          allowsNote: choice === "deny",
          ...(linkForms === undefined ? {} : { forms: linkForms }),
        },
      };
    }
    const waiting = link.waitId === undefined ? undefined : await repositories.agentWaits.get(link.waitId);
    const multi = link.choice === MULTI_SELECT_CHOICE && waiting?.choices?.multiSelect === true ? waiting.choices.options : undefined;
    const option = waiting?.choices?.options[Number(link.choice) - 1];
    if (waiting === undefined || waiting.state !== "active" || (option === undefined && multi === undefined))
      return { refusal: "This question was already answered." };
    const body = (await repositories.needDeliveries.listForWait(waiting.waitId))[0]?.text ?? "";
    return {
      link,
      view: {
        kind: "question",
        title: `A question from task ${link.taskId}`,
        body,
        choiceLabel: option?.label ?? "Send my choices",
        needsPin: false,
        allowsNote: false,
        ...(multi === undefined ? {} : { options: multi }),
      },
    };
  };

  const describeLink: ChannelApprovals["describeLink"] = async (token) => {
    const read = await readLink(token);
    return "refusal" in read ? { ok: false, message: read.refusal } : { ok: true, view: read.view };
  };

  const useLink: ChannelApprovals["useLink"] = async (token, form) => {
    const read = await readLink(token);
    if ("refusal" in read) return { ok: false, message: read.refusal };
    const { link, view } = read;
    const spentAt = deps.now();
    let consumed = false;
    if (view.needsPin && link.kind === "round" && link.steps !== undefined) {
      // A critical round asks for something the email alone does not carry.
      const pin = await deps.readPin?.();
      if (pin === undefined)
        return {
          ok: false,
          message:
            "This round is critical: decide it with `tavi approvals`, or set a PIN with `tavi credentials set approvals.pin` to decide such rounds here.",
        };
      // Compared as digests: equal lengths, so neither the PIN nor its length leaks through timing.
      const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
      const attempt = await repositories.approvalLinks.consumeWithPin({
        tokenHash: link.tokenHash,
        at: spentAt,
        pinMatches: timingSafeEqual(digest(form.pin ?? ""), digest(pin)),
      });
      if (attempt.status === "unavailable")
        return {
          ok: false,
          message: "This link was already used, or too many wrong PINs were tried. Decide the round with `tavi approvals`.",
        };
      if (attempt.status === "wrong-pin")
        return {
          ok: false,
          message:
            attempt.remaining === 0
              ? "Too many wrong PINs: this email's links no longer work. Decide the round with `tavi approvals`."
              : `That PIN is not correct. The link was not used (${attempt.remaining} tries left).`,
        };
      consumed = true;
    }
    if (!consumed && !(await repositories.approvalLinks.consume(link.tokenHash, spentAt)))
      return { ok: false, message: "This link was already used or has expired." };
    let dispatched = false;
    try {
      const result = await applyLink(link, form, () => {
        dispatched = true;
      });
      if (!result.ok) await repositories.approvalLinks.release(link.tokenHash, spentAt);
      return result;
    } catch (error) {
      // Reads and refusal-audit writes cannot apply the decision. Once its
      // admission/settlement is dispatched, a failure may hide a committed write.
      if (!dispatched) await repositories.approvalLinks.release(link.tokenHash, spentAt);
      throw error;
    }
  };

  const applyLink = async (
    link: ApprovalLinkRecord,
    form: { readonly note?: string; readonly picks?: readonly number[] },
    beforeDispatch: () => void,
  ): Promise<{ readonly ok: boolean; readonly message: string }> => {
    const task = await repositories.tasks.get(link.taskId);
    if (task === undefined) return { ok: false, message: "The task is gone." };
    // The link's bearer is the person the email went to: the task's owner.
    const actor: MemoryActor = { workspaceId: task.workspaceId, principalId: task.principalId, caller: "link", authority: "operator" };
    if (link.kind === "round") {
      const steps = link.steps;
      const round = steps === undefined ? undefined : await repositories.approvalRounds.get(link.taskId, steps);
      if (round === undefined) return { ok: false, message: "This round was already decided." };
      const choice = link.choice as ApprovalScope | "deny";
      const note = form.note?.trim().slice(0, 500);
      const answer = await decide(
        {
          actor,
          connectionId: round.connectionId ?? "link",
          conversationTaskId: link.taskId,
          // Told apart from an email reply in the audit trail and on a rule's `createdVia`.
          via: "link",
          command:
            choice === "deny"
              ? { approved: false, target: round.token, ...(note === undefined || note === "" ? {} : { note }) }
              : { approved: true, target: round.token, scope: choice },
        },
        beforeDispatch,
      );
      const decided = (await repositories.approvalRounds.get(link.taskId, round.steps))?.settledAt !== undefined;
      return { ok: decided, message: answer ?? "Nothing to decide." };
    }
    const waitId = link.waitId;
    const waiting = waitId === undefined ? undefined : await repositories.agentWaits.get(waitId);
    const options = waiting?.choices?.options ?? [];
    const picks = link.choice === MULTI_SELECT_CHOICE ? [...new Set(form.picks ?? [])].sort((x, y) => x - y) : [Number(link.choice)];
    const labels = picks.flatMap((pick) => {
      const option = options[pick - 1];
      return option === undefined ? [] : [option.label];
    });
    if (waiting === undefined || options.length === 0) return { ok: false, message: "This question was already answered." };
    // Refused before anything is spent for good: `useLink` releases the link.
    if (labels.length === 0 || labels.length !== picks.length) return { ok: false, message: "Choose at least one of the options." };
    const outcome: AgentWaitOutcome = { kind: "answered", replyText: labels.join(", "), answers: labels };
    const answered = await answerQuestion({
      actor,
      taskId: link.taskId,
      waitId: waiting.waitId,
      outcome,
      via: "link",
      beforeSettlement: beforeDispatch,
    });
    return answered
      ? { ok: true, message: `Answered: ${labels.join(", ")}` }
      : { ok: false, message: "This question was already answered." };
  };

  const recordToolResults: ChannelApprovals["recordToolResults"] = async ({ taskId, steps, results }) => {
    // Only a round that has a record: one decided in a terminal was never announced, and its rows say enough.
    if ((await repositories.approvalRounds.get(taskId, steps)) === undefined) return;
    const recorded = new Set(
      (await repositories.approvalRounds.listEvents(taskId, steps))
        .filter((event) => event.kind === "tool_result")
        .map((event) => event.detail?.["callId"]),
    );
    for (const result of results) {
      if (recorded.has(result.callId)) continue;
      await repositories.approvalRounds.appendEvent({
        taskId,
        steps,
        kind: "tool_result",
        detail: { callId: result.callId, toolName: result.toolName, status: result.status },
        at: deps.now(),
      });
    }
  };

  return {
    announceRound,
    announceReview,
    onRoundSettled,
    onConversationReset,
    recordToolResults,
    decide,
    sweepExpired,
    handleInteraction,
    takePendingReason,
    recordQuestion,
    onQuestionSettled,
    answerQuestion,
    replyTargetOf: (taskId: string) => replyTargetOf(taskId),
    questionLinkLines,
    describeLink,
    useLink,
  };
}
