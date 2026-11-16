import { type InvocationContext, type MemoryRecord, type PersistencePort, isLocalConnectionId } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import type { MemoryAutoApprove, MemoryAutoApproveSettings } from "./auto-approve.js";

/**
 * Memory cards: what a turn proposed, shown in the chat after the turn, one
 * card per turn; and what an epoch's flush proposed, one card per epoch; and
 * what an idle review proposed, one card per review.
 *
 * `memory.propose` tells `noteProposed` of each proposal as it is filed; the
 * turn's end (`onTaskEnded`, after its turn is saved, so the card follows it)
 * posts them as one card. A worker's proposals go to the chat it works for —
 * the record's origin chat — when the worker's turn ends. A group's never
 * get one: its members are not the person whose memory it would be.
 *
 * The card holds ids only (`tavi_memory_prompts`); the canvas and the
 * terminal render its text from the memory rows when they read it
 * (`memory {action: "card"}`). Best effort throughout: a card that cannot be
 * posted is logged, and the proposal still waits in the Center.
 *
 * A posted card is also sent to the chat's channel (`deliver`): where
 * the turn was asked, or for a flush and a worker the chat's own
 * conversation; `features/memory/channel-cards.ts` decides whether that is a direct
 * chat of the card's person.
 *
 * Before a turn's card is posted, what the turn proposed goes through
 * auto-approve (`features/memory/auto-approve.ts`): a proposal the operator's
 * *Keep without asking* covers, from an attended, untainted turn of the
 * operator's own chat that passes the quote check, is kept first, so the card
 * shows it *Saved* with *Undo*. Each proposal carries the admission that made
 * it (`onAdmissionClaimed`), which it is judged by: a turn that waited and
 * was resumed by a later admission ends with proposals of both.
 */

/** Proposals held for a turn's card, at most this many turns at once: the oldest go first. */
const PENDING_TURNS_MAX = 1_024;

interface PendingProposal {
  readonly recordId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  /** The chat the card goes to: the record's origin, the worker's root chat for a worker. */
  readonly chatTaskId: string;
  /** Where the turn was asked: the channel its card is sent to; absent, the chat's own conversation. */
  readonly replyTo?: InvocationContext["messagingReplyTo"];
  /** A delegated worker's proposal: never kept without asking. */
  readonly worker: boolean;
  /** The admission of `context.runId` running when it was filed; absent, auto-approve leaves it waiting. */
  readonly admissionId?: string;
  /** *Keep without asking* as it was when it was filed (`settingsNow`, read as it was noted); `null` when nothing was ticked or unreadable. */
  readonly settings?: Promise<MemoryAutoApproveSettings | null>;
}

export interface MemoryCardDependencies {
  readonly repositories: Pick<PersistencePort["repositories"], "transcripts" | "tasks">;
  readonly newId: () => string;
  readonly now: () => string;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
  /** Send a posted card to its chat's channel, after the reply; best effort. */
  readonly deliver?: (card: {
    readonly noticeId: string;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly principalId: string;
    readonly replyTo?: InvocationContext["messagingReplyTo"];
  }) => Promise<void>;
  /** Auto-approve: keeps what the turn proposed that *Keep without asking* covers, before its card is posted. */
  readonly autoApprove?: Pick<MemoryAutoApprove, "afterTurn"> & Partial<Pick<MemoryAutoApprove, "settingsNow">>;
}

export interface MemoryCards {
  /** An admission of `taskId` was claimed: what `memory.propose` files in that task from now on is that admission's. */
  onAdmissionClaimed(taskId: string, admissionId: string): void;
  /** `memory.propose` filed `record` in the turn `context` runs. */
  noteProposed(context: InvocationContext, record: MemoryRecord): void;
  /** A turn of `taskId` ended (completed or failed): its proposals become one card, keyed by its admission. */
  onTaskEnded(taskId: string, admissionId?: string): Promise<void>;
  /** An epoch's flush proposed `recordIds` in `taskId`: one card per chat and epoch. */
  onFlushed(taskId: string, epoch: number, recordIds: readonly string[]): Promise<void>;
  /** The idle review proposed `recordIds` in `taskId`, reading through saved turn `seq`: one card per review. */
  onReviewed(taskId: string, seq: number, recordIds: readonly string[]): Promise<void>;
}

export function createMemoryCards(deps: MemoryCardDependencies): MemoryCards {
  const pending = new Map<string, PendingProposal[]>();
  /** Each task's running admission, at most `PENDING_TURNS_MAX` tasks: the oldest go first. */
  const claimed = new Map<string, string>();

  const post = async (
    chatTaskId: string,
    sourceKey: string,
    records: readonly Omit<PendingProposal, "chatTaskId" | "replyTo" | "worker" | "admissionId">[],
    replyTo?: InvocationContext["messagingReplyTo"],
  ): Promise<void> => {
    let card: { readonly noticeId: string; readonly workspaceId: string; readonly principalId: string } | undefined;
    try {
      const chat = await deps.repositories.tasks.get(chatTaskId);
      // A card is for a chat a person reads: never a worker, and never a chat that is gone.
      if (chat === undefined || chat.chatKind === "worker") return;
      const posted = await deps.repositories.transcripts.postMemoryCard({
        noticeId: deps.newId(),
        taskId: chatTaskId,
        sourceKey,
        createdAt: deps.now(),
        records,
      });
      const [first] = records;
      if (first !== undefined) card = { noticeId: posted.notice.noticeId, workspaceId: first.workspaceId, principalId: first.principalId };
    } catch (error) {
      deps.log("a memory card could not be posted; its proposals still wait in the Center", {
        taskId: chatTaskId,
        sourceKey,
        reason: errorMessage(error),
      });
    }
    // On the chat's channel too, where it is a direct one; it never throws.
    if (card !== undefined) await deps.deliver?.({ ...card, taskId: chatTaskId, ...(replyTo === undefined ? {} : { replyTo }) });
  };

  return {
    onAdmissionClaimed(taskId, admissionId) {
      claimed.delete(taskId);
      claimed.set(taskId, admissionId);
      if (claimed.size > PENDING_TURNS_MAX) claimed.delete(claimed.keys().next().value as string);
    },

    noteProposed(context, record) {
      // A group proposes only its chat's notes, and gets no card.
      if (context.memoryReach === "chat-only") return;
      const admissionId = claimed.get(context.runId);
      // *Keep without asking* as it is now, not only at the turn's end: a kind unticked in between waits.
      const settingsNow = deps.autoApprove?.settingsNow;
      const settings =
        settingsNow === undefined
          ? undefined
          : settingsNow(context.workspaceId).then(
              (read) => read ?? null,
              () => null,
            );
      const proposal: PendingProposal = {
        recordId: record.recordId,
        workspaceId: context.workspaceId,
        principalId: context.principalId,
        chatTaskId: record.originTaskId ?? context.chatTaskId ?? context.runId,
        ...(context.messagingReplyTo === undefined ? {} : { replyTo: context.messagingReplyTo }),
        worker: context.memoryScopeRestricted === true || (context.chatTaskId !== undefined && context.chatTaskId !== context.runId),
        ...(admissionId === undefined ? {} : { admissionId }),
        ...(settings === undefined ? {} : { settings }),
      };
      const held = pending.get(context.runId);
      if (held !== undefined) {
        held.push(proposal);
        return;
      }
      pending.set(context.runId, [proposal]);
      if (pending.size > PENDING_TURNS_MAX) pending.delete(pending.keys().next().value as string);
    },

    async onTaskEnded(taskId, admissionId) {
      claimed.delete(taskId);
      const held = pending.get(taskId);
      if (held === undefined) return;
      pending.delete(taskId);
      const [first] = held;
      if (first !== undefined && deps.autoApprove !== undefined) {
        const mine = held.filter((proposal) => proposal.workspaceId === first.workspaceId && proposal.principalId === first.principalId);
        const proposals = await Promise.all(
          mine.map(async ({ recordId, admissionId: madeIn, settings }) => ({
            recordId,
            admissionId: madeIn,
            ...(settings === undefined ? {} : { settings: await settings }),
          })),
        );
        // Never throws: a proposal it does not keep waits on the card as ever.
        await deps.autoApprove.afterTurn({
          workspaceId: first.workspaceId,
          principalId: first.principalId,
          runId: taskId,
          admissionId,
          worker: held.some((proposal) => proposal.worker),
          // Asked from a channel conversation: every IPC run replies to the owner's own local connection, which is no channel.
          messaging: held.some((proposal) => proposal.replyTo !== undefined && !isLocalConnectionId(proposal.replyTo.connectionId)),
          proposals,
        });
      }
      const byChat = new Map<string, PendingProposal[]>();
      for (const proposal of held) byChat.set(proposal.chatTaskId, [...(byChat.get(proposal.chatTaskId) ?? []), proposal]);
      // One card per turn: a worker's turn has its own admission, so its card is its own in the root chat.
      const key = `memory:${admissionId ?? `${taskId}:${deps.now()}`}`;
      for (const [chatTaskId, chatProposals] of byChat) {
        await post(
          chatTaskId,
          key,
          chatProposals.map(({ recordId, workspaceId, principalId }) => ({ recordId, workspaceId, principalId })),
          chatProposals.find((proposal) => proposal.replyTo !== undefined)?.replyTo,
        );
      }
    },

    async onFlushed(taskId, epoch, recordIds) {
      if (recordIds.length === 0) return;
      const task = await deps.repositories.tasks.get(taskId);
      if (task === undefined) return;
      await post(
        taskId,
        `memory:flush:e${epoch}`,
        recordIds.map((recordId) => ({ recordId, workspaceId: task.workspaceId, principalId: task.principalId })),
      );
    },

    async onReviewed(taskId, seq, recordIds) {
      if (recordIds.length === 0) return;
      const task = await deps.repositories.tasks.get(taskId);
      if (task === undefined) return;
      await post(
        taskId,
        `memory:review:${seq}`,
        recordIds.map((recordId) => ({ recordId, workspaceId: task.workspaceId, principalId: task.principalId })),
      );
    },
  };
}
