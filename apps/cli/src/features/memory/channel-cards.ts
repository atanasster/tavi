import {
  MAX_MEMORY_TITLE_CHARS,
  MEMORY_CARD_EXCERPT_CHARS,
  MEMORY_CARD_OPEN_HINT,
  MEMORY_CARD_PRESS,
  MEMORY_PROMPT_KEEP_DAYS,
  memoryPendingProvidersNote,
  TaviError,
  memoryCardChannelMessage,
  memoryCardOpenHint,
  memoryCommandReceiptKey,
  memoryKeptAllText,
  memoryProvenanceUntrusted,
  type EffectiveMemorySettings,
  type InboundEvent,
  type InvocationContext,
  type MemoryActor,
  type MemoryCardAnswer,
  type MemoryCardChannelMode,
  type MemoryForgetAnswer,
  type MemoryItem,
  type MemoryPayload,
  type MemoryPromptRow,
  type MessagingServicePort,
  type PersistencePort,
  type TaviErrorCode,
  disarmUrls,
} from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { errorMessage } from "@tavi/contracts/util";

import { channelWords, type WorkspaceLocaleOf } from "../channels/channel-words.js";

import { decideMemoryRecord, discardAll, keepAllPlain, memoryDecisionWords, type MemoryDecision } from "./bulk.js";
import { memoryCommand, type MemoryCommandDependencies } from "./owner.js";

/**
 * Memory cards on messaging channels: the card a turn or a flush posted in a chat is also sent to that
 * chat's channel, after the reply, when the chat is a direct one with the
 * card's person as its bound sender — with at most three buttons where the
 * channel has them, the `/memory` commands as text where it has none, and no
 * action at all on email. A group never gets one.
 *
 * A press (`y:<token>:<op>`) is handled beside the reminders' and the
 * heartbeat's, before admission and without a model: only the person whose
 * card it is may press it, a card older than the press-age limit (7 days) is
 * not acted on, and what a press says of a decided record is read from the
 * record (a card decided elsewhere answers "Already kept"). It acts with
 * operator authority for the **presser's own principal**, through the same
 * `memory` command code the Center and the chat commands use, so each person
 * decides only their own memory (invariant 21). After it acts, the message is
 * edited to the card as it now is.
 *
 * The card's words are rendered from the canonical rows each time it is sent
 * or edited, and dropped from the send's outbox record once the send is over,
 * whether it went out or failed, so Tavi
 * keeps no copy of them (invariant 22). A forget edits every message a card
 * holding the record was sent as, where the channel can edit; where it cannot,
 * the forget's answer names the channel.
 */

/** A press's data. */
export function isMemoryPress(event: InboundEvent): boolean {
  return event.kind === "interaction" && MEMORY_CARD_PRESS.test(event.interaction?.data ?? "");
}

/**
 * The send of a card: one per card, so a retried post is the same send. A
 * card sent to more than one chat (a digest to each of the operator's
 * targets) has one send per chat, `memory-card:<notice>:<key>`.
 */
export function memoryCardEffectId(noticeId: string, sendKey?: string): string {
  return sendKey === undefined ? `memory-card:${noticeId}` : `memory-card:${noticeId}:${sendKey}`;
}

const MAX_PRESS_AGE_MS = MEMORY_PROMPT_KEEP_DAYS * 86_400_000;

type ReplyTarget = NonNullable<InvocationContext["messagingReplyTo"]>;

export interface MemoryChannelCardDependencies {
  readonly memory: MemoryCommandDependencies["memory"];
  readonly repositories: MemoryCommandDependencies["repositories"] &
    Pick<PersistencePort["repositories"], "messagingConversations" | "messagingIdentityBindings"> & {
      readonly transcripts: Pick<
        PersistencePort["repositories"]["transcripts"],
        | "getNotice"
        | "memoryPrompts"
        | "page"
        | "postMemoryCard"
        | "memoryPromptByToken"
        | "memoryPromptsOfRecord"
        | "memoryCardMessages"
        | "eraseMemoryCardMessage"
      >;
    };
  readonly messaging: Pick<MessagingServicePort, "send" | "buildReplyDestination" | "capabilitiesOf" | "answerInteraction" | "editMessage">;
  /** A connection whose channel is email: text only, no actions. */
  readonly isEmailConnection: (connectionId: string) => boolean;
  readonly isLocalConnection: (connectionId: string) => boolean;
  /** A connection's channel as a person names it, from the catalog. */
  readonly channelName: (connectionId: string) => string | undefined;
  /** Whether a chat reads only its own notes (a group's): it never gets a card. */
  readonly reachOf: (taskId: string) => Promise<"chat-only" | undefined>;
  readonly memorySettings?: (workspaceId: string) => Promise<EffectiveMemorySettings>;
  /** The workspace's language, which cards, buttons and receipts are said in; English without it. */
  readonly localeOf?: WorkspaceLocaleOf;
  /**
   * The URLs a chat knows, as its replies' disarm
   * reads them: a proposal made after the chat read untrusted content goes
   * out with every other address defanged. Absent, or a chat it cannot
   * read: none, so every address in such a proposal is.
   */
  readonly knownUrlsOf?: (taskId: string) => Promise<ReadonlySet<string>>;
  readonly newId: (prefix: string) => string;
  readonly now: () => string;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
}

export interface MemoryChannelCards {
  /**
   * Send the card `noticeId` of `taskId` to its chat's channel: `replyTo` is
   * where the turn was asked (absent, the chat's recorded conversation).
   * `sendKey` tells apart the sends of one card to several chats (a digest
   * to each of the operator's targets).
   * Best effort: a card that cannot be sent still waits in the chat.
   */
  deliver(input: {
    readonly noticeId: string;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly principalId: string;
    readonly replyTo?: ReplyTarget | undefined;
    readonly sendKey?: string | undefined;
  }): Promise<void>;
  /** A press of a card's button: true when it was one (handled, whatever it answered). */
  handleInteraction(input: { readonly actor: MemoryActor; readonly event: InboundEvent }): Promise<boolean>;
  /**
   * Before `recordId` is forgotten: what to do once it is (edit every sent
   * card that holds it to what the card then says), and the channels whose
   * messages cannot be edited.
   */
  beforeForget(recordId: string): Promise<{ readonly after: () => Promise<void>; readonly unreached: readonly string[] }>;
}

/** What a forget's answer adds when a channel message still shows the record. */
export function memoryUnreachedNote(channels: readonly string[], t: CoreT = coreEnglish): string | undefined {
  if (channels.length === 0) return undefined;
  const last = channels.at(-1) ?? "";
  const names = channels.length === 1 ? last : t("channel.list.and", { items: channels.slice(0, -1).join(", "), last });
  return t("channel.memory.card.unreached", { channels: names });
}

/**
 * A card as a channel may show it: the title and
 * excerpt of each item proposed after its chat read untrusted content are
 * model-written words, so every address in them the chat does not know
 * (`known`) is defanged, as a reply's are.
 */
export function disarmedMemoryCard<T extends Pick<MemoryCardAnswer, "items">>(card: T, known: ReadonlySet<string>): T {
  if (!card.items.some((item) => memoryProvenanceUntrusted(item.provenance))) return card;
  const disarm = (text: string | null, max: number): string | null => (text === null ? null : disarmUrls(text, known).slice(0, max));
  return {
    ...card,
    items: card.items.map((item) =>
      memoryProvenanceUntrusted(item.provenance)
        ? { ...item, title: disarm(item.title, MAX_MEMORY_TITLE_CHARS), excerpt: disarm(item.excerpt, MEMORY_CARD_EXCERPT_CHARS) }
        : item,
    ),
  };
}

export function createMemoryChannelCards(deps: MemoryChannelCardDependencies): MemoryChannelCards {
  const { repositories } = deps;
  /** The workspace's words: its language, or English when it cannot be read. */
  const wordsOf = (workspaceId: string): Promise<CoreT> =>
    channelWords(deps.localeOf, workspaceId, (message, fields) => deps.log(message, fields));
  /** What `taskId`'s chat knows, for its cards' disarm; none when it cannot be read. */
  const knownOf = async (taskId: string | undefined): Promise<ReadonlySet<string>> => {
    if (taskId === undefined || deps.knownUrlsOf === undefined) return new Set();
    try {
      return await deps.knownUrlsOf(taskId);
    } catch (error) {
      deps.log("a chat's known URLs could not be read; its memory card's addresses are all defanged", {
        taskId,
        reason: errorMessage(error),
      });
      return new Set();
    }
  };

  /** The `memory` command, as `principalId` (with operator authority over their own memory, invariant 21). */
  const ipc = async <T>(workspaceId: string, principalId: string, payload: MemoryPayload): Promise<T> => {
    const answer = await memoryCommand(
      {
        memory: deps.memory,
        repositories,
        principalOf: (id) => (id === workspaceId ? principalId : undefined),
        fromBridge: false,
        caller: "operator:button",
        now: () => new Date(deps.now()),
        ...(deps.memorySettings === undefined ? {} : { memorySettings: deps.memorySettings }),
      },
      { ...payload, workspaceId } as MemoryPayload,
    );
    if (!answer.ok) throw new TaviError(answer.error.code as TaviErrorCode, answer.error.message);
    return answer.result as T;
  };

  const render = async (noticeId: string, workspaceId: string, principalId: string): Promise<MemoryCardAnswer | undefined> => {
    try {
      return await ipc<MemoryCardAnswer>(workspaceId, principalId, { action: "card", noticeId } as MemoryPayload);
    } catch (error) {
      if (TaviError.from(error).code === "NOT_FOUND") return undefined;
      throw error;
    }
  };

  const modeOf = (connectionId: string): MemoryCardChannelMode | undefined => {
    const capabilities = deps.messaging.capabilitiesOf(connectionId);
    if (capabilities === undefined) return undefined;
    if (deps.isEmailConnection(connectionId)) return "email";
    return capabilities.interactions ? "buttons" : "text";
  };

  const destinationOf = (target: ReplyTarget): unknown =>
    deps.messaging.buildReplyDestination(target.connectionId, {
      externalConversationId: target.externalConversationId,
      externalSenderId: target.externalSenderId,
      ...(target.externalThreadId === undefined ? {} : { externalThreadId: target.externalThreadId }),
      ...(target.subject === undefined ? {} : { subject: target.subject }),
    });

  /** Edit a sent card's message to what the card says now: its buttons follow its state. */
  const edit = async (input: {
    readonly connectionId: string;
    readonly destination: unknown;
    readonly messageId: string;
    readonly noticeId: string;
    readonly workspaceId: string;
    readonly principalId: string;
  }): Promise<boolean> => {
    if (deps.messaging.capabilitiesOf(input.connectionId)?.editOrProgress !== true) return false;
    const mode = modeOf(input.connectionId);
    const card = await render(input.noticeId, input.workspaceId, input.principalId);
    if (mode === undefined || card === undefined) return false;
    const message = memoryCardChannelMessage(
      disarmedMemoryCard(card, await knownOf((await repositories.transcripts.getNotice(input.noticeId))?.taskId)),
      mode,
      await wordsOf(input.workspaceId),
    );
    try {
      return await deps.messaging.editMessage(input.connectionId, {
        destination: input.destination,
        messageId: input.messageId,
        text: message.text,
        ...(message.buttons.length === 0 ? {} : { buttons: [message.buttons] }),
      });
    } catch (error) {
      deps.log("a memory card's message could not be edited", {
        connectionId: input.connectionId,
        noticeId: input.noticeId,
        reason: errorMessage(error),
      });
      return false;
    }
  };

  const deliver: MemoryChannelCards["deliver"] = async ({ noticeId, taskId, workspaceId, principalId, replyTo, sendKey }) => {
    try {
      const target = replyTo ?? (await repositories.messagingConversations.getByTask(taskId))?.replyTo;
      if (target === undefined || deps.isLocalConnection(target.connectionId)) return;
      // A direct chat only: never a group, a topic or a chat channel's thread.
      if ((await deps.reachOf(taskId)) === "chat-only") return;
      // Whose card it is must be who the channel's sender is bound to.
      const binding = await repositories.messagingIdentityBindings.get(target.connectionId, target.externalSenderId);
      if (binding === undefined || binding.workspaceId !== workspaceId || binding.principalId !== principalId) return;
      const mode = modeOf(target.connectionId);
      const card = mode === undefined ? undefined : await render(noticeId, workspaceId, principalId);
      if (mode === undefined || card === undefined || card.items.length === 0) return;
      const destination = destinationOf(target);
      if (destination === undefined) return;
      const message = memoryCardChannelMessage(disarmedMemoryCard(card, await knownOf(taskId)), mode, await wordsOf(workspaceId));
      const effectId = memoryCardEffectId(noticeId, sendKey);
      try {
        await deps.messaging.send({
          effectId,
          connectionId: target.connectionId,
          workspaceId,
          destination,
          parts: [{ content: message.text }],
          ...(message.buttons.length === 0 ? {} : { buttons: [message.buttons] }),
        });
      } finally {
        // Sent or not: the outbox keeps where and whether, never the records' words (invariant 22).
        await repositories.transcripts.eraseMemoryCardMessage(effectId).catch((error: unknown) => {
          deps.log("a memory card's words could not be dropped from its send's record", {
            noticeId,
            reason: errorMessage(error),
          });
        });
      }
    } catch (error) {
      deps.log("a memory card could not be sent to its chat's channel; it still waits in the chat", {
        taskId,
        noticeId,
        reason: errorMessage(error),
      });
    }
  };

  const readRecord = async (row: MemoryPromptRow): Promise<MemoryItem | undefined> => {
    try {
      return (
        await ipc<{ readonly record: MemoryItem }>(row.workspaceId, row.principalId, {
          action: "get",
          recordId: row.recordId,
        } as MemoryPayload)
      ).record;
    } catch (error) {
      if (TaviError.from(error).code === "NOT_FOUND") return undefined;
      throw error;
    }
  };

  /** Keep or discard one waiting record; what it is now when it no longer waits. */
  const decide = (row: MemoryPromptRow, record: MemoryItem, decision: "approve" | "reject"): Promise<MemoryDecision> =>
    decideMemoryRecord({
      record,
      decision,
      run: (payload) => ipc(row.workspaceId, row.principalId, payload),
      reread: () => readRecord(row),
    });

  /** Forget one record: the channels whose earlier messages may still show it, and the providers its removal waits for. */
  const forgetOne = async (
    row: MemoryPromptRow,
    reason: string,
  ): Promise<{ readonly unreached: readonly string[]; readonly waiting: readonly string[] }> => {
    const { unreached } = await beforeForget(row.recordId);
    const receipt = await ipc<MemoryForgetAnswer | undefined>(row.workspaceId, row.principalId, {
      action: "forget",
      recordId: row.recordId,
      reason,
    } as MemoryPayload);
    return { unreached, waiting: receipt?.pendingProviders ?? [] };
  };

  const beforeForget: MemoryChannelCards["beforeForget"] = async (recordId) => {
    const rows = await repositories.transcripts.memoryPromptsOfRecord(recordId);
    const sent: {
      readonly row: MemoryPromptRow;
      readonly message: { readonly connectionId: string; readonly destination: unknown; readonly messageId: string };
    }[] = [];
    for (const row of new Map(rows.map((row) => [row.noticeId, row])).values()) {
      // Every chat the card was sent to: one, or each of a digest's targets.
      for (const message of await repositories.transcripts.memoryCardMessages(memoryCardEffectId(row.noticeId)))
        sent.push({ row, message });
    }
    const unreached = [
      ...new Set(
        sent
          .filter(({ message }) => deps.messaging.capabilitiesOf(message.connectionId)?.editOrProgress !== true)
          .map(({ message }) => deps.channelName(message.connectionId) ?? coreEnglish("channel.memory.card.anotherChannel")),
      ),
    ];
    return {
      unreached,
      after: async () => {
        for (const { row, message } of sent) {
          await edit({ ...message, noticeId: row.noticeId, workspaceId: row.workspaceId, principalId: row.principalId });
        }
      },
    };
  };

  const handleInteraction: MemoryChannelCards["handleInteraction"] = async ({ actor, event }) => {
    const match = MEMORY_CARD_PRESS.exec(event.interaction?.data ?? "");
    if (match === null) return false;
    const callbackId = event.interaction?.callbackId;
    const t = await wordsOf(actor.workspaceId);
    const answer = async (text: string): Promise<void> => {
      if (callbackId === undefined) return;
      try {
        await deps.messaging.answerInteraction(event.connectionId, callbackId, text.slice(0, 190));
      } catch (error) {
        deps.log("a memory card's button press could not be acknowledged", {
          connectionId: event.connectionId,
          reason: errorMessage(error),
        });
      }
    };
    // Never in a group, never on email (invariant 11): a card is sent to neither, so a press there is not one of ours.
    if (event.conversationKind === "group" || deps.isEmailConnection(event.connectionId)) {
      await answer(t("channel.memory.card.groupOrEmail"));
      return true;
    }
    const row = await repositories.transcripts.memoryPromptByToken(match[1] ?? "");
    if (row === undefined) {
      await answer(t("channel.memory.card.gone"));
      return true;
    }
    // Only the person whose card it is (invariant 21): another's is "not found", as the commands say.
    if (actor.workspaceId !== row.workspaceId || actor.principalId !== row.principalId) {
      await answer(t("channel.memory.notYours"));
      return true;
    }
    if (Date.parse(deps.now()) - Date.parse(row.createdAt) > MAX_PRESS_AGE_MS) {
      await answer(t("channel.memory.card.tooOld"));
      return true;
    }
    const op = match[2] ?? "o";
    if (op === "o") {
      await answer(t === coreEnglish ? MEMORY_CARD_OPEN_HINT : memoryCardOpenHint(t));
      return true;
    }
    const target: ReplyTarget = {
      connectionId: event.connectionId,
      externalConversationId: event.externalConversationId,
      externalSenderId: event.externalSenderId,
      externalMessageId: undefined,
      ...(event.externalThreadId === undefined ? {} : { externalThreadId: event.externalThreadId }),
    };
    /** The pressed message, edited to what its card says now. */
    const settle = async (): Promise<void> => {
      const messageId = event.interaction?.messageId;
      const destination = messageId === undefined ? undefined : destinationOf(target);
      if (messageId === undefined || destination === undefined) return;
      await edit({
        connectionId: event.connectionId,
        destination,
        messageId,
        noticeId: row.noticeId,
        workspaceId: row.workspaceId,
        principalId: row.principalId,
      });
    };
    try {
      if (op === "k" || op === "d") {
        const record = await readRecord(row);
        if (record === undefined) {
          await answer(t("channel.memory.card.alreadyForgotten"));
          return true;
        }
        const outcome = await decide(row, record, op === "k" ? "approve" : "reject");
        await answer(
          outcome === "done"
            ? t(op === "k" ? "channel.memory.card.kept" : "channel.memory.card.discarded")
            : outcome === "conflict"
              ? t("channel.memory.card.conflict")
              : outcome === "tidy"
                ? t("memory.card.tidyUpNeedsLook")
                : outcome === "stale"
                  ? t("channel.memory.tidyStale")
                  : `${memoryDecisionWords(outcome, t)}.`,
        );
        await settle();
        return true;
      }
      if (op === "u") {
        const record = await readRecord(row);
        if (record === undefined) {
          await answer(t("channel.memory.card.alreadyForgotten"));
          return true;
        }
        if (record.status !== "approved") {
          await answer(t(record.status === "proposed" ? "channel.memory.card.notKeptYet" : "channel.memory.card.nothingToUndo"));
          return true;
        }
        const { unreached, waiting } = await forgetOne(row, "undone from a memory card");
        await answer(
          [t("channel.memory.card.forgotten"), memoryPendingProvidersNote(waiting, t), memoryUnreachedNote(unreached, t)]
            .filter((part) => part !== undefined)
            .join(" "),
        );
        await settle();
        return true;
      }
      // K, D, U: every record of this card that is the presser's.
      const rows = (await repositories.transcripts.memoryPrompts(row.noticeId)).filter(
        (each) => each.workspaceId === actor.workspaceId && each.principalId === actor.principalId,
      );
      const records: { readonly row: MemoryPromptRow; readonly record: MemoryItem }[] = [];
      for (const each of rows) {
        const record = await readRecord(each);
        if (record !== undefined) records.push({ row: each, record });
      }
      if (op === "U") {
        const saved = records.filter(({ record }) => record.status === "approved");
        if (saved.length === 0) {
          await answer(t("channel.memory.card.nothingToUndo"));
          return true;
        }
        const unreached = new Set<string>();
        const waiting = new Set<string>();
        for (const { row: each } of saved) {
          const forgot = await forgetOne(each, "undone from a memory card");
          for (const channel of forgot.unreached) unreached.add(channel);
          for (const provider of forgot.waiting) waiting.add(provider);
        }
        await answer(
          [
            t("channel.memory.card.forgottenCount", { n: String(saved.length) }),
            memoryPendingProvidersNote([...waiting].sort(), t),
            memoryUnreachedNote([...unreached], t),
          ]
            .filter((part) => part !== undefined)
            .join(" "),
        );
        await settle();
        return true;
      }
      const waiting = records.filter(({ record }) => record.status === "proposed");
      if (waiting.length === 0) {
        const statuses = new Set(records.map(({ record }) => record.status));
        await answer(
          statuses.size === 1 && statuses.has("approved")
            ? `${t("channel.memory.already.kept")}.`
            : statuses.size === 1 && statuses.has("rejected")
              ? `${t("channel.memory.already.discarded")}.`
              : t("channel.memory.card.nothingWaits"),
        );
        return true;
      }
      const rowOf = new Map(waiting.map(({ row: each, record }) => [record.recordId, each]));
      const decideListed =
        (decision: "approve" | "reject") =>
        (record: MemoryItem): Promise<MemoryDecision> =>
          decide(rowOf.get(record.recordId) ?? row, record, decision);
      if (op === "D") {
        // *Discard all* has no exclusions: discarding loses nothing the person cannot add again.
        const discarded = await discardAll(
          waiting.map(({ record }) => record),
          decideListed("reject"),
        );
        await answer(t("channel.memory.card.discardedCount", { n: String(discarded) }));
        await settle();
        return true;
      }
      // *Keep all*: plain proposals only; a sensitive one, one proposed after its chat read untrusted
      // content, or one that conflicts, stays waiting and is counted.
      const { kept, needsLook } = await keepAllPlain(
        waiting.map(({ record }) => record),
        decideListed("approve"),
      );
      await answer(`${memoryKeptAllText(kept.length, needsLook, t)}.`);
      await settle();
      if (kept.length > 0) {
        // Its receipt: a *Saved · N* card of exactly what this press kept, whose Undo forgets those.
        const receipt = await repositories.transcripts.postMemoryCard({
          noticeId: deps.newId("notice"),
          taskId: row.taskId,
          sourceKey: memoryCommandReceiptKey(event.connectionId, deps.newId("cmd")),
          createdAt: deps.now(),
          records: kept.map((recordId) => ({ recordId, workspaceId: row.workspaceId, principalId: row.principalId })),
        });
        await deliver({
          noticeId: receipt.notice.noticeId,
          taskId: row.taskId,
          workspaceId: row.workspaceId,
          principalId: row.principalId,
          replyTo: target,
        });
      }
      return true;
    } catch (error) {
      const failure = TaviError.from(error);
      if (failure.code === "NOT_FOUND") {
        await answer(t("channel.memory.notYours"));
        return true;
      }
      deps.log("a memory card press failed", { connectionId: event.connectionId, reason: failure.message });
      await answer(t("channel.memory.card.failed"));
      return true;
    }
  };

  return { deliver, handleInteraction, beforeForget };
}
