import {
  type ContentLabel,
  type AdmitInput,
  isQuotedDataMessage,
  mailboxContextNote,
  MAILBOX_NOTE_MAX_MESSAGES,
  type WorkflowMessage,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { rewoundFrom, PENDING_SEEDS_KEPT } from "./admission-input.js";
import type { CompiledWorkflowGraph, WorkflowThreadState } from "./graph.js";
import type { WorkflowScope } from "./scope.js";

/** What a turn's admission keeps around it: one task's work at a time, a rewind's hold, the turn's agent mail and a new chat's seed. */
export function createTurnSupport(scope: WorkflowScope & { readonly compiled: CompiledWorkflowGraph }) {
  const { compiled, inFlight, options, rewindMarker, workerModelUrls } = scope;
  /**
   * A rewind's hold goes once the thread's checkpoint holds none of the
   * rewound turns' messages: cut by this turn, or folded away by a
   * rollover. One the turn never reached (it failed before the graph wrote)
   * stays for the next. Best effort: a failure never fails the turn.
   */
  const settleRewind = async (taskId: string, threadId: string): Promise<void> => {
    try {
      const marker = await rewindMarker(taskId);
      if (marker === undefined) return;
      const state = await compiled.getState({ configurable: { thread_id: threadId } });
      const conversation = (state.values as { readonly conversation?: readonly WorkflowMessage[] } | undefined)?.conversation ?? [];
      if (rewoundFrom(conversation, marker) < 0) await options.rewinds?.clear(taskId, marker);
    } catch (error) {
      options.onDiagnostic?.("a chat's rewind could not be settled", { taskId, error: errorMessage(error) });
    }
  };

  /**
   * Chain work for one task so ownership acquisition is never racy.
   *
   * A rejection fails only its own caller; the chain continues.
   */
  function serialize<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const previous = inFlight.get(taskId) ?? Promise.resolve();
    const settled = previous.then(work, work);
    const chain = settled.then(
      () => undefined,
      () => undefined,
    );
    inFlight.set(taskId, chain);
    // Prune only this chain's own entry, so a later admission's entry survives.
    void chain.finally(() => {
      if (inFlight.get(taskId) === chain) inFlight.delete(taskId);
    });
    return settled;
  }

  /**
   * The ids of the `mailbox-…` blocks a thread's checkpointed conversation holds; none when it cannot be read.
   * `read` is the admission's own reading of the checkpoint, when it has one.
   */
  async function mailboxBlocksIn(threadId: string, read?: () => Promise<WorkflowThreadState>): Promise<Set<string>> {
    try {
      const state = await (read?.() ?? compiled.getState({ configurable: { thread_id: threadId } }));
      const conversation = (state.values as { readonly conversation?: readonly WorkflowMessage[] } | undefined)?.conversation ?? [];
      return new Set(
        conversation.flatMap((message) => (isQuotedDataMessage(message) && message.id.startsWith("mailbox-") ? [message.id] : [])),
      );
    } catch {
      return new Set();
    }
  }

  /**
   * Claims the task's unread agent-mailbox envelopes for a turn
   * — newest first, at most `MAILBOX_NOTE_MAX_MESSAGES` — under the
   * admission's own lease, and quotes them as data. Mail an earlier turn
   * claimed and never settled (the owner died between) is settled first:
   * read when its block reached the conversation, else claimed again. Only a
   * turn that begins (a `start` or `reply`, prompted or a wake) reads mail; a
   * resume goes on with the turn it resumes. A claim that fails is reported,
   * and the turn runs without its mail, which waits for the next.
   * `readCheckpoint` is the admission's own reading of the thread's checkpoint.
   */
  async function claimTurnMailbox(
    input: AdmitInput,
    taskId: string,
    threadId: string,
    admissionId: string,
    readCheckpoint?: () => Promise<WorkflowThreadState>,
  ): Promise<
    | {
        readonly leaseId: string;
        readonly text: string;
        readonly shown: readonly string[];
        readonly label: ContentLabel;
        readonly modelUrls: readonly string[];
      }
    | undefined
  > {
    if (options.mailbox === undefined || input.resume !== undefined || (input.kind !== "start" && input.kind !== "reply")) return undefined;
    const leaseId = `mailbox-${admissionId}`;
    try {
      const readLeases = input.taskId === undefined ? [] : [...(await mailboxBlocksIn(threadId, readCheckpoint))];
      const claim = await options.mailbox.claimForTurn({ taskId, leaseId, limit: MAILBOX_NOTE_MAX_MESSAGES, readLeases });
      const note = mailboxContextNote(claim.envelopes, { more: claim.more });
      if (note === undefined) return undefined;
      // What the block could not show is handed back, for the next turn.
      const left = claim.envelopes.map((envelope) => envelope.messageId).filter((id) => !note.shown.includes(id));
      if (left.length > 0) await options.mailbox.releaseClaim({ taskId, leaseId, messageIds: left });
      // Labelled by its senders' labels at send time: a clean worker's result does not taint the chat.
      // The URLs its senders wrote are model-written in this chat too.
      const senders = claim.envelopes
        .filter((envelope) => note.shown.includes(envelope.messageId))
        .map((envelope) => envelope.senderTaskId);
      return {
        leaseId,
        text: note.text,
        shown: note.shown,
        label: note.label,
        modelUrls: await workerModelUrls(senders, input.context.workspaceId),
      };
    } catch (error) {
      options.onDiagnostic?.("a turn's agent mail could not be claimed; it runs without it", { taskId, reason: errorMessage(error) });
      return undefined;
    }
  }

  /**
   * Settles a turn's claim, whatever the turn's outcome: read when its block
   * is in the thread's checkpointed conversation (the model has it, and every
   * later turn too), handed back when it is not (the turn failed before its
   * input was written). Best effort: a claim left held is settled by the
   * task's next turn.
   */
  async function settleTurnMailbox(
    taskId: string,
    threadId: string,
    mailbox: { readonly leaseId: string; readonly shown: readonly string[] } | undefined,
  ): Promise<void> {
    if (mailbox === undefined || options.mailbox === undefined) return;
    try {
      if ((await mailboxBlocksIn(threadId)).has(mailbox.leaseId))
        await options.mailbox.acknowledge({ taskId, leaseId: mailbox.leaseId, messageIds: mailbox.shown });
      else await options.mailbox.releaseClaim({ taskId, leaseId: mailbox.leaseId });
    } catch (error) {
      options.onDiagnostic?.("a turn's agent mail could not be settled", { taskId, reason: errorMessage(error) });
    }
  }

  /**
   * New chats' seeds their first turn never read, its prompt dropped or
   * cancelled: the chat's next turn reads them. In memory and bounded —
   * an owner restart between the two loses it, and the chat goes on without
   * its parent's background, as it would have before.
   */
  const pendingSeeds = new Map<string, NonNullable<AdmitInput["seed"]>>();
  const keepSeed = (taskId: string, seed: NonNullable<AdmitInput["seed"]>): void => {
    pendingSeeds.delete(taskId);
    pendingSeeds.set(taskId, seed);
    if (pendingSeeds.size > PENDING_SEEDS_KEPT) pendingSeeds.delete(pendingSeeds.keys().next().value ?? "");
  };
  const takeSeed = (taskId: string): AdmitInput["seed"] => {
    const seed = pendingSeeds.get(taskId);
    pendingSeeds.delete(taskId);
    return seed;
  };
  return { settleRewind, serialize, claimTurnMailbox, settleTurnMailbox, keepSeed, takeSeed };
}

export type TurnSupport = ReturnType<typeof createTurnSupport>;
