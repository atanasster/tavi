import {
  boundTurnKnownUrls,
  MEMORY_USED_RECORDS_MAX,
  TRANSCRIPT_ITEMS_MAX,
  TRANSCRIPT_TEXT_MAX,
  type AdmissionKind,
  type AdmissionOutcome,
  type MemoryUsedRef,
  type TurnChannel,
  type TranscriptItem,
  type TranscriptTurn,
  type UnsequencedClientEvent,
} from "@tavi/contracts";

/**
 * What a person saw of one admission, built from the events published for it:
 * its text in the order its blocks began —
 * without the text of an attempt that failed over — and each tool call by name
 * and how it ended. Inputs and outputs are not kept: a saved turn is what the
 * chat showed, not the record of what ran.
 */
export interface TurnRecorder {
  observe(event: UnsequencedClientEvent): void;
  /**
   * Memory the turn used: a model call's retrieved evidence (never profile-only
   * entries that did not match the turn's query) and its preference count, or
   * what a memory tool returned. Each revision is kept once, in the order first used.
   */
  noteMemory(used: {
    readonly records: readonly MemoryUsedRef[];
    readonly listed?: readonly MemoryUsedRef[];
    readonly preferences?: number;
  }): void;
  /**
   * A model call of the turn read untrusted data that came in with it: the saved turn is marked `tainted`,
   * and keeps the conversation's known URLs as last told, for the canvas to disarm a novel link with.
   */
  noteUntrusted(knownUrls?: readonly string[]): void;
  /** The turn is held to a channel, such as a messaging conversation: the saved turn records it. */
  noteChannel(channel: TurnChannel): void;
  turn(outcome: AdmissionOutcome): TranscriptTurn;
}

type Item =
  | { readonly kind: "steer"; readonly messageId: string; readonly text: string }
  | { readonly kind: "text"; readonly blockId: string; readonly attemptId: string; text: string }
  | {
      readonly kind: "tool";
      readonly callId: string;
      readonly toolName: string;
      status: "running" | "completed" | "failed" | "interrupted";
      errorCode?: string;
      message?: string;
      durationMs?: number;
    };

/** A tool's name as the saved turn holds it: bounded like the stream's, never empty. */
const toolNameOf = (name: string): string => (name === "" ? "tool" : name.slice(0, 128));

export function createTurnRecorder(admissionKind: AdmissionKind, prompt: string | undefined): TurnRecorder {
  const items: Item[] = [];
  let chars = 0;
  let truncated = false;
  /** The revisions the turn used, by `recordId revisionId`, in the order first used; and the most preferences any call applied. */
  const memory = new Map<string, MemoryUsedRef>();
  /** What a listing returned, by the same key: looked through, unless the turn used it too. */
  const listed = new Map<string, MemoryUsedRef>();
  let preferences = 0;
  let tainted = false;
  let knownUrls: string[] = [];
  let channel: TurnChannel | undefined;
  const textOf = (blockId: string): Extract<Item, { kind: "text" }> | undefined =>
    items.find((item): item is Extract<Item, { kind: "text" }> => item.kind === "text" && item.blockId === blockId);
  const toolOf = (callId: string): Extract<Item, { kind: "tool" }> | undefined =>
    items.findLast((item): item is Extract<Item, { kind: "tool" }> => item.kind === "tool" && item.callId === callId);
  const room = (): boolean => {
    if (items.length < TRANSCRIPT_ITEMS_MAX) return true;
    truncated = true;
    return false;
  };
  return {
    noteMemory(used) {
      for (const { recordId, revisionId } of used.records) {
        const key = `${recordId} ${revisionId}`;
        if (!memory.has(key)) memory.set(key, { recordId, revisionId });
      }
      for (const { recordId, revisionId } of used.listed ?? []) listed.set(`${recordId} ${revisionId}`, { recordId, revisionId });
      preferences = Math.max(preferences, used.preferences ?? 0);
    },
    noteUntrusted(known) {
      tainted = true;
      if (known !== undefined) knownUrls = boundTurnKnownUrls(known);
    },
    noteChannel(held) {
      channel = held;
    },
    observe(event) {
      switch (event.kind) {
        case "text.delta": {
          const left = TRANSCRIPT_TEXT_MAX - chars;
          if (left <= 0) {
            truncated ||= event.text.length > 0;
            return;
          }
          const text = event.text.slice(0, left);
          truncated ||= text.length < event.text.length;
          chars += text.length;
          const block = textOf(event.blockId);
          if (block !== undefined) block.text += text;
          else if (room()) items.push({ kind: "text", blockId: event.blockId, attemptId: event.attemptId, text });
          return;
        }
        case "attempt.replaced":
          // A failed-over attempt's text is not the conversation's.
          if (event.discarded === true) {
            for (let index = items.length - 1; index >= 0; index -= 1) {
              const item = items[index];
              if (item?.kind === "text" && item.attemptId === event.supersededAttemptId) {
                chars -= item.text.length;
                items.splice(index, 1);
              }
            }
          }
          return;
        case "turn.steered":
          // A message the person sent into the turn, once: a retried call may report it again.
          // Its words count toward the turn's bound as the turn's text does, and are clipped to what is left of it.
          if (event.text.trim() === "" || items.some((item) => item.kind === "steer" && item.messageId === event.messageId)) return;
          {
            const left = TRANSCRIPT_TEXT_MAX - chars;
            if (left <= 0) {
              truncated = true;
              return;
            }
            const text = event.text.slice(0, left);
            if (!room()) return;
            truncated ||= text.length < event.text.length;
            chars += text.length;
            items.push({ kind: "steer", messageId: event.messageId, text });
          }
          return;
        case "tool.started":
          if (room()) items.push({ kind: "tool", callId: event.callId, toolName: toolNameOf(event.toolName), status: "running" });
          return;
        case "tool.completed": {
          const tool = toolOf(event.callId);
          if (tool === undefined) {
            if (room())
              items.push({
                kind: "tool",
                callId: event.callId,
                toolName: toolNameOf(event.toolName),
                status: "completed",
                durationMs: event.durationMs,
              });
            return;
          }
          tool.status = "completed";
          tool.durationMs = event.durationMs;
          return;
        }
        case "tool.failed": {
          const tool = toolOf(event.callId);
          if (tool === undefined) {
            if (room())
              items.push({
                kind: "tool",
                callId: event.callId,
                toolName: toolNameOf(event.toolName),
                status: "failed",
                errorCode: event.errorCode,
                message: event.message,
                durationMs: event.durationMs,
              });
            return;
          }
          tool.status = "failed";
          tool.errorCode = event.errorCode;
          tool.message = event.message;
          tool.durationMs = event.durationMs;
          return;
        }
        default:
          return;
      }
    },
    turn(outcome) {
      // A call still running when the admission ended was suspended on, or cut short.
      const saved: TranscriptItem[] = items.map((item) =>
        item.kind === "steer"
          ? { kind: "steer", text: item.text }
          : item.kind === "text"
            ? { kind: "text", text: item.text }
            : {
                kind: "tool",
                callId: item.callId,
                toolName: item.toolName,
                status: item.status === "running" ? "interrupted" : item.status,
                ...(item.errorCode === undefined ? {} : { errorCode: item.errorCode.slice(0, 64) }),
                ...(item.message === undefined ? {} : { message: item.message.slice(0, 2_000) }),
                ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
              },
      );
      // The question the turn waits on is part of what the person saw.
      const question = outcome.waitInterrupt?.question?.trim();
      if (question !== undefined && question !== "") saved.push({ kind: "question", text: question.slice(0, 2_000) });
      const status =
        outcome.status === "completed"
          ? "completed"
          : outcome.status === "failed" || outcome.status === "stopped"
            ? outcome.status
            : outcome.interrupt !== undefined
              ? "approval"
              : outcome.reviewInterrupt !== undefined
                ? "review"
                : "waiting";
      // A record the turn used is used, whichever came first: it counts once.
      const usedIds = new Set([...memory.values()].map((ref) => ref.recordId));
      const onlyListed = [...listed.values()].filter((ref) => !usedIds.has(ref.recordId));
      return {
        admissionKind,
        ...(prompt === undefined || prompt === "" ? {} : { prompt: prompt.slice(0, TRANSCRIPT_TEXT_MAX) }),
        items: saved,
        ...(truncated ? { truncated: true } : {}),
        outcome: {
          status,
          ...(outcome.finalText === "" ? {} : { finalText: outcome.finalText.slice(0, TRANSCRIPT_TEXT_MAX) }),
          ...(outcome.error === undefined
            ? {}
            : { errorCode: outcome.error.code.slice(0, 64), message: outcome.error.message.slice(0, 2_000) }),
        },
        // Recorded on every turn saved, none used included.
        memoryUsed: {
          records: [...memory.values()].slice(0, MEMORY_USED_RECORDS_MAX),
          preferences,
          more: Math.max(0, memory.size - MEMORY_USED_RECORDS_MAX),
          ...(onlyListed.length === 0
            ? {}
            : {
                listed: {
                  records: onlyListed.slice(0, MEMORY_USED_RECORDS_MAX),
                  more: Math.max(0, onlyListed.length - MEMORY_USED_RECORDS_MAX),
                },
              }),
        },
        // Automatic capture leaves this turn out whole.
        ...(tainted ? { tainted: true as const } : {}),
        ...(tainted && knownUrls.length > 0 ? { knownUrls } : {}),
        // Nor does it read a turn that came in from a messaging conversation (invariant 6).
        ...(channel === undefined ? {} : { channel }),
      };
    },
  };
}
