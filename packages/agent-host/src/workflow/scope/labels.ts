import {
  ContentLabelSchema,
  TRUSTED_PUBLIC,
  UNTRUSTED_UNKNOWN_SOURCE,
  isUntrusted,
  type UntrustedEnvelope,
  joinLabels,
  isTrustedPublic,
  trustedLabel,
  untrustedLabel,
  INBOUND_MESSAGE_PREFIX,
  TRIGGER_MESSAGE_PREFIX,
  type ContentLabel,
  type ConversationFold,
  type InvocationContext,
  CONTEXT_MESSAGE_PREFIX,
  isQuotedDataMessage,
  type WorkflowMessage,
  type parseAgentState,
  UNTRUSTED_PLUGIN_CONTEXT_MESSAGE_PREFIX,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { noticesTaintTurn } from "../admission-input.js";
import { untrustedEnvelopeOf } from "../context-block.js";
import { isSummaryMessage } from "../epoch.js";
import { OUTSIDE_RESULT_SOURCES } from "../known-urls.js";
import type { WorkflowAdapterOptions } from "../options.js";

/** The id prefix of a turn's prompt message: `input-<admissionId>`. */
export const PROMPT_MESSAGE_PREFIX = "input-";

/** How the adapter labels what a chat holds: a message's, a span's and a turn's content labels, and the turns a flush leaves out. */
export function createLabelScope(options: WorkflowAdapterOptions) {
  /**
   * One message's label: the one it carries —
   * a tool result's, a summary's (the span it folded), an inbound block's —
   * or, for a message without one, what it reads as: a tool's
   * result by its tool's declaration and `untrusted` mark, a side chat's
   * quoted background or an agent mailbox as `agent`, a plugin's untrusted
   * context as `plugin`. A `context-…` block has none: it neither taints nor
   * raises confidentiality, whatever it says. Derived labels carry no
   * refs, so reading one twice joins to the same label.
   */
  const labelOfMessage = (message: WorkflowMessage): ContentLabel => {
    if (message.role === "user" && message.id.startsWith(CONTEXT_MESSAGE_PREFIX)) return TRUSTED_PUBLIC;
    if (message.label !== undefined)
      return message.untrusted === true && !isUntrusted(message.label)
        ? joinLabels(message.label, untrustedLabel("download"))
        : message.label;
    if (message.role === "tool") {
      const definition = message.toolName === undefined ? undefined : options.tools.get(message.toolName);
      const confidentiality = definition?.outputConfidentiality ?? "public";
      // A store-labelled tool's result always carries its label (`runHandler`): one without fails closed.
      if (definition?.labelledByStore === true) return untrustedLabel(definition.outputSource ?? "unknown-source", { confidentiality });
      if (message.untrusted === true || definition?.untrustedOutput === true) {
        return untrustedLabel(definition?.outputSource ?? (message.untrusted === true ? "download" : "unknown-source"), {
          confidentiality,
        });
      }
      return confidentiality === "public" ? TRUSTED_PUBLIC : trustedLabel(confidentiality);
    }
    if (isQuotedDataMessage(message)) {
      // Someone else's words: one admitted without its label reads as another member's.
      if (message.id.startsWith(INBOUND_MESSAGE_PREFIX)) return untrustedLabel("chat-other");
      if (message.id.startsWith(TRIGGER_MESSAGE_PREFIX)) return untrustedLabel("unknown-source");
      if (message.id.startsWith("seed-background-") || message.id.startsWith("mailbox-")) return untrustedLabel("agent");
      if (message.id.startsWith(UNTRUSTED_PLUGIN_CONTEXT_MESSAGE_PREFIX)) return untrustedLabel("plugin");
    }
    return TRUSTED_PUBLIC;
  };
  /**
   * The envelope a message is sent in, to the turn's model and to the
   * stage-2 summarizer alike: an untrusted tool result or untrusted quoted
   * data, by its label. An inbound block keeps its own fence, its text
   * normalised at admission (`inboundBlockText`); the model's own turns
   * are never wrapped.
   */
  const envelopeOfMessage = (taskId: string, message: WorkflowMessage): UntrustedEnvelope | undefined =>
    message.role === "tool" || (isQuotedDataMessage(message) && !message.id.startsWith(INBOUND_MESSAGE_PREFIX))
      ? untrustedEnvelopeOf(taskId, message.toolCallId ?? message.id, labelOfMessage(message), message.toolCallId)
      : undefined;
  /** The join of `messages`' labels (`labelOfMessage`); `TRUSTED_PUBLIC` itself when none says anything. */
  const labelOf = (messages: readonly WorkflowMessage[]): ContentLabel =>
    messages.reduce((label, message) => {
      const own = labelOfMessage(message);
      return isTrustedPublic(own) ? label : joinLabels(label, own);
    }, TRUSTED_PUBLIC);
  /**
   * Whether a tool result's words came from outside (`OUTSIDE_RESULT_SOURCES`):
   * its label untrusted and every source on it outside, from a tool
   * that declares an outside source (an external tool is stamped `plugin`). A
   * worker's answer is the worker's words whatever its label names, so
   * `agents.wait`, `agents.status`, `agents.spawn` and `agents.read_payload`
   * (`agent`) never count, nor does a tool that declares no source.
   */
  const outsideResult = (message: WorkflowMessage): boolean => {
    const declared = message.toolName === undefined ? undefined : options.tools.get(message.toolName)?.outputSource;
    if (declared === undefined || !OUTSIDE_RESULT_SOURCES.has(declared)) return false;
    const label = labelOfMessage(message);
    return isUntrusted(label) && label.sources.length > 0 && label.sources.every((source) => OUTSIDE_RESULT_SOURCES.has(source));
  };
  /**
   * Whether `conversation` holds untrusted content (`labelOf`'s integrity):
   * output from a tool that returns untrusted content, a side chat's quoted
   * background (its parent's replies may quote whatever a page or a
   * tool result put in them), an agent mailbox, a plugin's untrusted context,
   * or a summary of a span that held any. Every message counts, not only this
   * turn's: a page fetched three turns ago can still be steering the model.
   */
  const holdsUntrusted = (conversation: readonly WorkflowMessage[]): boolean =>
    conversation.some((message) => isUntrusted(labelOfMessage(message)));
  /** The context label: the checkpointed channel, joined with what the conversation holds now. */
  const contextLabelOf = (current: {
    readonly contextLabel?: ContentLabel | undefined;
    readonly conversation: readonly WorkflowMessage[];
  }): ContentLabel => joinLabels(current.contextLabel ?? TRUSTED_PUBLIC, labelOf(current.conversation));
  /** The context label's integrity (`contextLabelOf`): the checkpointed channel keeps what a fold has since summarized away. */
  const conversationTainted = (current: {
    readonly contextLabel?: ContentLabel | undefined;
    readonly conversation: readonly WorkflowMessage[];
  }): boolean => isUntrusted(contextLabelOf(current));
  /**
   * What the gate reads: the context label, joined with the notices
   * block the turn came with (`noticesTaintTurn`). An unlabelled notices
   * block labels only its own turn — it is not written into the checkpointed
   * channel — so a Home whose every turn may bring a notice is not held as
   * tainted for good by one. A block quoting a run's output carries that
   * run's label (`AdmitInput.noticesLabel`), which stays like a worker's result's.
   */
  const turnLabel = (current: ReturnType<typeof parseAgentState>): ContentLabel =>
    noticesTaintTurn(current.conversation) ? joinLabels(contextLabelOf(current), untrustedLabel("agent")) : contextLabelOf(current);
  /**
   * The label a caller hands a new conversation: its
   * `inheritedLabel`, and a bare `inheritedTaint` as `UNTRUSTED_UNKNOWN_SOURCE` —
   * untrusted from a source it did not name. A label that does not parse
   * reads as `UNTRUSTED_UNKNOWN_SOURCE` too: it only ever narrows.
   */
  const inheritedLabelOf = (context: InvocationContext): ContentLabel => {
    const given = context.inheritedLabel === undefined ? undefined : ContentLabelSchema.safeParse(context.inheritedLabel);
    const label = given === undefined ? TRUSTED_PUBLIC : given.success ? joinLabels(given.data, TRUSTED_PUBLIC) : UNTRUSTED_UNKNOWN_SOURCE;
    return context.inheritedTaint === true && !isUntrusted(label) ? joinLabels(label, UNTRUSTED_UNKNOWN_SOURCE) : label;
  };
  /** A previous checkpoint's values, as `contextLabelOf` reads them (a missing channel is the default). */
  const previousLabelState = (
    values: unknown,
    conversation: readonly WorkflowMessage[],
  ): { readonly contextLabel?: ContentLabel; readonly conversation: readonly WorkflowMessage[] } => {
    const held = values as { readonly contextLabel?: ContentLabel } | undefined;
    return { ...(held?.contextLabel === undefined ? {} : { contextLabel: held.contextLabel }), conversation };
  };
  /** `turnLabel`'s integrity. */
  const turnTainted = (current: ReturnType<typeof parseAgentState>): boolean => isUntrusted(turnLabel(current));
  /**
   * The join of the labels of the messages `removeIds` names: what a fold of them carries, and its archive stores.
   * In a tainted checkpoint (`state`'s channel untrusted), the model's words written before they were labelled — an
   * unlabelled assistant message after the conversation's first untrusted one, or anywhere when none is left to say
   * where the taint came in — carry the checkpoint's label.
   */
  const spanLabel = (
    conversation: readonly WorkflowMessage[],
    removeIds: readonly string[],
    state?: { readonly contextLabel?: ContentLabel | undefined },
  ): ContentLabel => {
    const removed = new Set(removeIds);
    const span = labelOf(conversation.filter((message) => removed.has(message.id)));
    const channel = state?.contextLabel ?? TRUSTED_PUBLIC;
    const source = conversation.findIndex((message) => isUntrusted(labelOfMessage(message)));
    const unlabelledWords =
      isUntrusted(channel) &&
      conversation.some(
        (message, index) => index > source && removed.has(message.id) && message.role === "assistant" && message.label === undefined,
      );
    return unlabelledWords ? joinLabels(span, channel) : span;
  };
  /**
   * A fold whose summary carries what it folds: the join of the
   * labels of the span it replaces, with the summary's own. So a summary never
   * lowers anything — and the sticky `contextLabel` holds it besides.
   */
  const labelledFold = (
    fold: ConversationFold | undefined,
    conversation: readonly WorkflowMessage[],
    state?: { readonly contextLabel?: ContentLabel | undefined },
  ): ConversationFold | undefined => {
    if (fold === undefined) return undefined;
    const span = spanLabel(conversation, fold.removeIds, state);
    if (isTrustedPublic(span)) return fold;
    return { ...fold, summary: { ...fold.summary, label: fold.summary.label === undefined ? span : joinLabels(fold.summary.label, span) } };
  };
  /**
   * Whether the messages of one turn carried untrusted data:
   * a tool's untrusted output, a side chat's background, an agent mailbox or
   * a plugin's untrusted context (`holdsUntrusted`), or a notices block.
   */
  const turnMessagesUntrusted = (messages: readonly WorkflowMessage[]): boolean =>
    holdsUntrusted(messages) || messages.some((message) => isQuotedDataMessage(message) && message.id.startsWith("notices-"));
  /**
   * Where each turn of `conversation` begins: its prompt (`input-…`), or the
   * quoted data and seed it was admitted with just before it (a notices
   * block, a side chat's background, a mailbox, a new chat's seed).
   */
  const turnStarts = (conversation: readonly WorkflowMessage[]): readonly number[] => {
    const starts: number[] = [];
    conversation.forEach((message, index) => {
      if (message.role !== "user" || !message.id.startsWith(PROMPT_MESSAGE_PREFIX)) return;
      let start = index;
      for (
        let before = conversation[start - 1];
        before !== undefined && (isQuotedDataMessage(before) || before.role === "system");
        before = conversation[start - 1]
      )
        start -= 1;
      starts.push(start);
    });
    return starts;
  };
  /**
   * `messages` without the turns automatic capture leaves out (the flush's
   * span): every turn from the first tainted one, since the taint is
   * sticky — a later turn can repeat a page
   * read turns earlier — and a turn its notices block taints on its own.
   * Where the taint came in is read over the whole `conversation`, the
   * recent messages the rollover keeps included, so a page read after the
   * span leaves the span's clean turns in. `tainted` is the conversation's
   * sticky flag at the flush: then a summary may stand in for what an earlier
   * fold took away, which came before every message still here (a summary is
   * placed after the messages its fold kept), so with a summary, or with
   * nothing in the conversation showing where the taint came in, it is
   * counted from the start. The turn the taint came in is left out from its
   * start, its prompt included. What comes before the first prompt seen is
   * the tail of a turn begun in an earlier epoch, whose untrusted output may
   * have been folded then: it is left out too, the narrower reading
   * `saidSince` uses.
   */
  const withoutUntrustedTurns = (
    messages: readonly WorkflowMessage[],
    conversation: readonly WorkflowMessage[],
    tainted: boolean,
  ): readonly WorkflowMessage[] => {
    const source = conversation.findIndex((message) => holdsUntrusted([message]));
    const taintedAt = tainted && (source < 0 || conversation.some(isSummaryMessage)) ? 0 : source;
    const taintedIds = new Set<string>();
    if (taintedAt >= 0) {
      const from =
        turnStarts(conversation)
          .filter((start) => start <= taintedAt)
          .at(-1) ?? taintedAt;
      for (const message of conversation.slice(from)) taintedIds.add(message.id);
    }
    const starts = turnStarts(messages);
    const kept: WorkflowMessage[] = [];
    starts.forEach((start, index) => {
      const turn = messages.slice(start, starts[index + 1] ?? messages.length);
      if (!turn.some((message) => taintedIds.has(message.id)) && !turnMessagesUntrusted(turn)) kept.push(...turn);
    });
    return kept;
  };
  /**
   * `messages` without the turns held to a messaging channel (`messagingTurns`,
   * invariant 6): each turn is known by its prompt (`input-<admissionId>`), so
   * `messages` begins at one — `withoutUntrustedTurns` sees to that.
   * Undefined when the channels cannot be read: then nothing is flushed.
   */
  const withoutMessagingTurns = async (
    taskId: string,
    messages: readonly WorkflowMessage[],
  ): Promise<readonly WorkflowMessage[] | undefined> => {
    if (options.messagingTurns === undefined) return messages;
    const starts = turnStarts(messages);
    const turns = starts.map((start, index) => messages.slice(start, starts[index + 1] ?? messages.length));
    const admissionOf = (turn: readonly WorkflowMessage[]): string | undefined =>
      turn
        .find((message) => message.role === "user" && message.id.startsWith(PROMPT_MESSAGE_PREFIX))
        ?.id.slice(PROMPT_MESSAGE_PREFIX.length);
    const admissionIds = turns.flatMap((turn) => admissionOf(turn) ?? []);
    if (admissionIds.length === 0) return messages;
    let held: ReadonlySet<string>;
    try {
      held = await options.messagingTurns(taskId, admissionIds);
    } catch (error) {
      options.onDiagnostic?.("a chat's turn channels could not be read; the epoch is not flushed", { taskId, error: errorMessage(error) });
      return undefined;
    }
    return turns.flatMap((turn) => {
      const admissionId = admissionOf(turn);
      return admissionId !== undefined && held.has(admissionId) ? [] : turn;
    });
  };
  return {
    options,
    labelOfMessage,
    envelopeOfMessage,
    labelOf,
    outsideResult,
    contextLabelOf,
    conversationTainted,
    turnLabel,
    inheritedLabelOf,
    previousLabelState,
    turnTainted,
    spanLabel,
    labelledFold,
    withoutUntrustedTurns,
    withoutMessagingTurns,
  };
}

export type LabelScope = ReturnType<typeof createLabelScope>;
