import {
  type BrowserObservation,
  type ContentLabel,
  supersedeBrowserObservation,
  type ArtifactFold,
  type ArtifactRepositoryPort,
  type ConversationFold,
  type InvocationContext,
  type WorkflowMessage,
} from "@tavi/contracts";

/**
 * Fold defaults. `MAX_CONVERSATION_MESSAGES` (512) is a hard, cross-run bound;
 * two folds keep a long-lived thread clear of it: stage 2 under token
 * pressure, and the epoch rollover by message count (and at 85% of a known
 * window).
 *
 * Stage 1's message-count fold (old tool rounds
 * replaced by a deterministic `[compaction]` pointer at 80% of the bound, 409
 * messages) is retired. It ran just below the rollover's 416
 * and only delayed it: nothing else was gated on it, stage 2 has its own
 * trigger, and the rollover runs with or without `artifacts` (stage 1 needed
 * them). The rollover keeps the bound on its own: it runs at every model step
 * and as an admission joins, and its 96-message margin is more than one step
 * can add. What stage 1 could fold that the rollover cannot — the older tool
 * rounds inside one turn, whose tail opens where the turn does — matters only
 * for a turn longer than the trigger, and a turn dispatches at most
 * `maxToolCalls` calls (64 by default) over at most `MAX_TASK_STEPS` steps;
 * stage 1 never folded a turn's refusals either (`isError`). Checkpoints holding
 * `[compaction]` summaries still load: they are system-role summaries, which
 * every fold protects (`eligibleFoldCandidateIds`, `isSummaryMessage`) and an
 * epoch summary carries forward, and their archives are untouched.
 */
/** Never fold the most recent messages — kept verbatim regardless of age. */
export const DEFAULT_COMPACTION_KEEP_RECENT_MESSAGES = 40;

/**
 * Stage 2's token-pressure trigger (only under remaining
 * pressure may a budgeted model summarize eligible history): a handful of
 * very large messages can create real pressure long before the rollover's
 * message count is ever reached.
 */
export const DEFAULT_COMPACTION_MODEL_TRIGGER_TOKENS = 32_000;

/**
 * With the model's context window known:
 * stage 2 summarizes once the conversation passes half the window, capped by
 * `compactionMaxContextTokens` so a large window is not filled at its price;
 * a request estimated past 85% of the window is folded before it is sent;
 * and the verbatim tail is held to 2.5% of the window, between 10,000 and
 * 25,000 tokens.
 */
export const COMPACTION_WINDOW_FRACTION = 0.5;

export const CONTEXT_WINDOW_HARD_FRACTION = 0.85;

export const KEEP_RECENT_WINDOW_FRACTION = 0.025;

export const KEEP_RECENT_MIN_TOKENS = 10_000;

export const KEEP_RECENT_MAX_TOKENS = 25_000;

/** The cost budget on stage 2's window-relative trigger, in estimated tokens. */
export const DEFAULT_COMPACTION_MAX_CONTEXT_TOKENS = 64_000;

/**
 * The same budget once the provider reports prompt-cache reads for the task: its history then costs a
 * tenth of its price or less on each call, so folding it early saves less than the fold's own call and the
 * cache it re-writes. Half the window still applies below it.
 */
export const DEFAULT_COMPACTION_CACHED_MAX_CONTEXT_TOKENS = 128_000;

/**
 * Stage 2's hysteresis: once the trigger fires, a fold
 * takes the conversation down to this fraction of it, so the next fold waits
 * for real growth — the rest of the trigger — rather than the next turn. A fold
 * that cannot free that much (what it may not take, the person's messages and
 * earlier summaries, already fills the trigger) is not made: it would buy one
 * turn for a model call, every turn. A conversation already past the 85% hard
 * limit is folded as far as it can be, with no headroom required.
 */
export const COMPACTION_FOLD_TARGET_FRACTION = 0.5;

/** What a stage-2 summary adds back, in estimated tokens: its capped text and the host's quoted-data lines around it. */
export const COMPACTION_SUMMARY_HEAD_TOKENS = 150;

/** Consecutive stage-2 failures (archiving or summarization) before this admission stops attempting it. */
export const COMPACTION_CIRCUIT_BREAKER_THRESHOLD = 2;

/**
 * The messages a stage-2 fold may take (`planModelSummaryFold`): the oldest
 * messages, minus the protected roles and flags, minus either half of a
 * tool-call/result pair whose other half isn't also eligible. The rules came
 * with the retired stage-1 fold and are stage 2's "eligible
 * history". Excludes, at any age:
 *  - every `role: "user"` message — "preserve required
 *    instructions" includes the human's own request, and a rule that cannot
 *    tell "the task" apart from any other user turn protects all of them. That
 *    protects a stage-2 summary too, which is written as user-role quoted
 *    data (`foldsum-…`), so it is never re-folded as an ordinary message;
 *  - every `role: "system"` message — they are explicitly
 *    preserved. The only `role: "system"` entries that land in
 *    the checkpointed conversation are folds' own summaries: an epoch's, a
 *    stage-2 summary from an older checkpoint, and a stage-1 `[compaction]` summary
 *    from before stage 1 was retired. Excluding the role protects those directly, so a
 *    summary is never itself folded into a later archive;
 *  - any `isError: true` message (the closest a rule can get to
 *    "preserve ... recent failures" without semantic understanding);
 *  - either half of a tool-call/result pair whose other half isn't also a
 *    candidate — a pair is folded together or not at all, so a fold can
 *    never leave a dangling call or a result with no matching call.
 */
function eligibleFoldCandidateIds(conversation: readonly WorkflowMessage[], oldest: readonly WorkflowMessage[]): Set<string> {
  const candidateIds = new Set(
    oldest
      .filter((message) => message.role !== "user" && message.role !== "system" && message.isError !== true)
      .map((message) => message.id),
  );
  dropSplitPairs(conversation, oldest, candidateIds);
  return candidateIds;
}

/**
 * Remove from `candidateIds` either half of a tool-call/result pair whose
 * other half is not also a candidate — a pair is folded together or not at
 * all, so a fold can never leave a dangling call or a result with no call.
 */
export function dropSplitPairs(
  conversation: readonly WorkflowMessage[],
  oldest: readonly WorkflowMessage[],
  candidateIds: Set<string>,
): void {
  const resultsOf = pairToolResults(conversation);
  for (const message of oldest) {
    if (message.role !== "assistant" || message.toolCalls === undefined) continue;
    const resultIds = resultsOf.get(message) ?? [];
    const wholePairIsCandidate = resultIds.every((id) => id !== undefined && candidateIds.has(id));
    if (!wholePairIsCandidate) {
      candidateIds.delete(message.id);
      for (const id of resultIds) if (id !== undefined) candidateIds.delete(id);
    }
  }
}

/**
 * Each assistant message's tool calls, in order, paired with the id of the
 * result that answers each one (`undefined` when none does). A call is
 * answered by the first later `tool` message with its id that no earlier call
 * took — positionally, so a provider that reuses an id across steps still has
 * each call matched with its own result.
 */
function pairToolResults(conversation: readonly WorkflowMessage[]): Map<WorkflowMessage, (string | undefined)[]> {
  const resultsOf = new Map<WorkflowMessage, (string | undefined)[]>();
  const waiting = new Map<string, { readonly resultIds: (string | undefined)[]; readonly index: number }[]>();
  for (const message of conversation) {
    if (message.role === "tool" && message.toolCallId !== undefined) {
      const slot = waiting.get(message.toolCallId)?.shift();
      if (slot !== undefined) slot.resultIds[slot.index] = message.id;
    }
    if (message.role !== "assistant" || message.toolCalls === undefined) continue;
    const resultIds: (string | undefined)[] = message.toolCalls.map(() => undefined);
    resultsOf.set(message, resultIds);
    message.toolCalls.forEach((call, index) => {
      const queue = waiting.get(call.id);
      if (queue === undefined) waiting.set(call.id, [{ resultIds, index }]);
      else queue.push({ resultIds, index });
    });
  }
  return resultsOf;
}

/** A browser tool's output, as far as this file needs to tell that it holds an observation. */
function isBrowserObservation(value: unknown): value is BrowserObservation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof BrowserObservation, unknown>>;
  return (
    typeof candidate.sessionId === "string" &&
    typeof candidate.epoch === "number" &&
    typeof candidate.url === "string" &&
    Array.isArray(candidate.elements)
  );
}

/** The observations a browser tool result carries, if any: `navigate`/`observe` answer one; `create_session` with a `url`, `request_handoff`, and some `act`s nest one as `page`; `batch` nests them in `steps[i].page`. */
function observationOf(message: WorkflowMessage): readonly { readonly observation: BrowserObservation; readonly stepIndex?: number }[] {
  if (message.role !== "tool" || message.isError === true) return [];
  if (message.toolName === "browser.navigate" || message.toolName === "browser.observe") {
    return isBrowserObservation(message.output) ? [{ observation: message.output }] : [];
  }
  // `create_session` with a `url`, `request_handoff`, and an `act` whose next step needs the page's elements, nest one as `page`.
  if (
    (message.toolName === "browser.create_session" ||
      message.toolName === "browser.act" ||
      message.toolName === "browser.request_handoff") &&
    typeof message.output === "object" &&
    message.output !== null
  ) {
    const page = (message.output as { readonly page?: unknown }).page;
    return isBrowserObservation(page) ? [{ observation: page }] : [];
  }
  if (message.toolName === "browser.batch" && typeof message.output === "object" && message.output !== null) {
    const steps = (message.output as { readonly steps?: unknown }).steps;
    if (!Array.isArray(steps)) return [];
    const found: { readonly observation: BrowserObservation; readonly stepIndex: number }[] = [];
    steps.forEach((step, stepIndex) => {
      const page = typeof step === "object" && step !== null ? (step as { readonly page?: unknown }).page : undefined;
      if (isBrowserObservation(page)) found.push({ observation: page, stepIndex });
    });
    return found;
  }
  return [];
}

/**
 * How far the conversation grows between rewrites of its superseded browser
 * observations: about 35,000 tokens. A provider's prompt cache reuses the
 * request's longest unchanged prefix, so rewriting an older observation makes
 * every message after it be sent — and paid for — again, at a cache write's
 * price. Shrinking each observation as soon as the next arrived did that on
 * every navigate: in a research task on an Anthropic model, every other call
 * read back only the system prompt and tools, and cache writes came to a
 * quarter of the input. A digest saves a couple of thousand tokens a call,
 * which a cache serves at a tenth of the price anyway, so the view only moves
 * when there is real growth to recover.
 */
export const SUPERSEDED_OBSERVATION_STRIDE_CHARS = 120_000;

/** A message's size as checkpointed: what the stride measures. */
function storedMessageChars(message: WorkflowMessage): number {
  return (
    message.text.length +
    (message.output === undefined ? 0 : (JSON.stringify(message.output)?.length ?? 0)) +
    (message.toolCalls === undefined ? 0 : JSON.stringify(message.toolCalls).length)
  );
}

/**
 * How many leading messages the view may rewrite: the shortest prefix holding
 * the conversation's last whole multiple of `strideChars`. It depends only on
 * those messages, which never change, so it moves — and the view with it —
 * only when the conversation has grown by another stride. 0 settles all of it.
 */
function settledPrefixLength(conversation: readonly WorkflowMessage[], strideChars: number): number {
  if (strideChars <= 0) return conversation.length;
  const sizes = conversation.map(storedMessageChars);
  const boundary = Math.floor(sizes.reduce((sum, size) => sum + size, 0) / strideChars) * strideChars;
  if (boundary === 0) return 0;
  let chars = 0;
  for (const [index, size] of sizes.entries()) {
    chars += size;
    if (chars >= boundary) return index + 1;
  }
  return conversation.length;
}

/**
 * The conversation as the model is sent it, with every browser observation
 * that a later one of the same session superseded shrunk by
 * `supersedeBrowserObservation`: to its links when the session moved on to
 * another URL, and to a one-line stub when it observed the same URL again.
 * The session's latest observation is left as it is, and so is one whose
 * digest would be no smaller.
 *
 * Only the settled prefix is rewritten (`settledPrefixLength`): an
 * observation is shrunk once it and the one that superseded it both lie in
 * it, so the view of a growing conversation changes once per `strideChars`
 * of growth rather than on every navigate, and a provider's prompt cache keeps
 * the history in between.
 *
 * Settled tool results past the browser are shrunk in the same stride
 * (`settledToolOutput`): an `fs.read` a later read or write of its file
 * superseded, an archived result's preview, and a long `sandbox.run`,
 * `fs.grep` or `web_fetch` result — the last two only once a step answered
 * them, so the model always reads a result whole first. Each of these moves
 * forward once (whole, then shorter) and never back.
 *
 * This is a view only. The checkpoint keeps every observation whole, so
 * transcripts, folds and their archives are unchanged, and nothing is lost if
 * these rules change. The view is a pure function of the conversation, and
 * each message's form only moves forward (whole, then links, then stub), so
 * an observation is re-rendered at most twice, each time just as a newer
 * observation joins the conversation's tail.
 */
export function compactSupersededObservations(
  conversation: readonly WorkflowMessage[],
  strideChars: number = SUPERSEDED_OBSERVATION_STRIDE_CHARS,
): readonly WorkflowMessage[] {
  const settled = settledPrefixLength(conversation, strideChars);
  const observations = conversation
    .slice(0, settled)
    .flatMap((message, index) => observationOf(message).map((entry) => ({ index, ...entry })));
  const replaced = new Map<number, WorkflowMessage>();
  observations.forEach(({ index, observation, stepIndex }, position) => {
    const later = observations
      .slice(position + 1)
      .map((entry) => entry.observation)
      .filter((next) => next.sessionId === observation.sessionId);
    const next = later[0];
    if (next === undefined) return;
    const sameUrl = later.find((candidate) => candidate.url === observation.url);
    const digest = supersedeBrowserObservation(
      observation,
      sameUrl === undefined ? { epoch: next.epoch, sameUrl: false } : { epoch: sameUrl.epoch, sameUrl: true },
    );
    // An observation with next to nothing in it (a page that had not rendered) is smaller whole.
    if (JSON.stringify(digest).length >= JSON.stringify(observation).length) return;
    const message = replaced.get(index) ?? (conversation[index] as WorkflowMessage);
    const output =
      message.toolName === "browser.create_session" || message.toolName === "browser.act" || message.toolName === "browser.request_handoff"
        ? { ...(message.output as object), page: digest }
        : message.toolName === "browser.batch" && stepIndex !== undefined
          ? {
              ...(message.output as object),
              steps: ((message.output as { readonly steps: readonly unknown[] }).steps ?? []).map((step, i) =>
                i === stepIndex && typeof step === "object" && step !== null ? { ...step, page: digest } : step,
              ),
            }
          : digest;
    replaced.set(index, { ...message, output });
  });
  // Past the browser: a file read the task read again or wrote, a long command, search or fetch output, an
  // archived result — each settled message once, in the same stride.
  for (let index = 0; index < settled; index += 1) {
    if (replaced.has(index) && conversation[index]?.toolName !== "browser.batch") continue;
    const message = replaced.get(index) ?? (conversation[index] as WorkflowMessage);
    const output = settledToolOutput(message, conversation, index, settled);
    if (output !== undefined) replaced.set(index, { ...message, output });
  }
  return replaced.size === 0 ? conversation : conversation.map((message, index) => replaced.get(index) ?? message);
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** A result longer than this, as JSON, keeps its head, tail and counts once settled (`shortenedOutput`). */
const LONG_TOOL_OUTPUT_CHARS = 4_000;
/** Tools whose long output is mostly seen once: a command's streams, a search's matches, a fetched or read page, extracted records, or a batch. */
const LONG_OUTPUT_TOOLS: ReadonlySet<string> = new Set([
  "sandbox.run",
  "fs.grep",
  "web_fetch",
  "browser.read",
  "browser.find",
  "browser.extract",
  "browser.batch",
]);
/** How much of a long string a shortened output keeps, at each end. */
const KEPT_STRING_END = 800;
/** A string longer than this inside a long output is cut to its two ends. */
const LONG_STRING_CHARS = 2 * KEPT_STRING_END + 200;
/** How many items of a long list a shortened output keeps: the first ones, then the last. */
const KEPT_LIST_HEAD = 20;
const KEPT_LIST_TAIL = 10;

/** The path a file tool's result names: what `fs.read`, `fs.write` and `fs.edit` all answer with. */
function resultPath(message: WorkflowMessage): string | undefined {
  const path = (message.output as { readonly path?: unknown } | undefined)?.path;
  return message.isError !== true && typeof path === "string" ? path : undefined;
}

/**
 * A settled tool result's shorter form, or `undefined` to keep it whole:
 * - an `fs.read` the task read again (same path and offset) or wrote (`fs.write`, `fs.edit`) later in the
 *   settled prefix, as a pointer to the newer one;
 * - an archived result (`archiveToolOutput`), as its note and artifact without the preview;
 * - a `sandbox.run`, `fs.grep`, `web_fetch`, `browser.read`, `browser.find`, `browser.extract`, or
 *   `browser.batch` result over `LONG_TOOL_OUTPUT_CHARS`, as its head, tail and counts (`shortenedOutput`).
 * Only a form that is smaller is used. The message keeps its label and taint: they are the message's, not
 * its output's.
 */
function settledToolOutput(message: WorkflowMessage, conversation: readonly WorkflowMessage[], index: number, settled: number): unknown {
  if (message.role !== "tool" || message.output === undefined) return undefined;
  // Serialised only for a result a rule may shrink: most settled results are kept as they are.
  let wholeLength: number | undefined;
  const lengthOf = (): number => (wholeLength ??= (JSON.stringify(message.output) ?? "").length);
  const smaller = (output: unknown): unknown => ((JSON.stringify(output) ?? "").length < lengthOf() ? output : undefined);
  // The model has read this result whole once a step answered it: a result the stride settled as it arrived
  // (the one that crossed the boundary) is sent whole first. The settled prefix only grows, so once true it stays.
  const seen = conversation.slice(index + 1, settled).some((later) => later.role === "assistant");
  if (message.toolName === "fs.read") {
    const path = resultPath(message);
    const offset = (message.output as { readonly offset?: unknown }).offset ?? 0;
    if (path !== undefined)
      for (const later of conversation.slice(index + 1, settled)) {
        if (later.role !== "tool" || resultPath(later) !== path) continue;
        if (later.toolName === "fs.read" && ((later.output as { readonly offset?: unknown }).offset ?? 0) === offset)
          return smaller({ path, offset, superseded: "read again later in this conversation; the later read is current" });
        if (later.toolName === "fs.write" || later.toolName === "fs.edit")
          return smaller({
            path,
            offset,
            superseded: `changed later in this conversation by ${later.toolName}; read it again for its contents`,
          });
      }
  }
  if (!seen) return undefined;
  const archived = message.output as { readonly truncated?: unknown; readonly artifactId?: unknown; readonly note?: unknown };
  if (archived.truncated === true && typeof archived.artifactId === "string" && typeof archived.note === "string")
    return smaller({ truncated: true, note: archived.note, artifactId: archived.artifactId });
  if (message.toolName !== undefined && LONG_OUTPUT_TOOLS.has(message.toolName) && lengthOf() > LONG_TOOL_OUTPUT_CHARS) {
    const first = shortenedOutput(message.output, message.toolName);
    if ((JSON.stringify(first) ?? "").length < lengthOf()) return first;
    return smaller(shortenedOutput(message.output, message.toolName, { listHead: 2, listTail: 1, stringEnd: 300 }));
  }
  return undefined;
}

interface ShortenBounds {
  readonly listHead?: number;
  readonly listTail?: number;
  readonly stringEnd?: number;
}

function shortenHint(toolName: string | undefined): string {
  if (toolName === "browser.read") return "; re-read with `offset`";
  if (toolName === "browser.extract") return "; records are in `findings.list`";
  return "";
}

/**
 * A long result's head, tail and counts: each long string cut to its two ends with how much was left out,
 * each long list to its first and last items with how many were left out. Every other field — exit codes,
 * counts, paths, artifact references — is kept as it was.
 */
function shortenedOutput(value: unknown, toolName?: string, bounds?: ShortenBounds): unknown {
  const hint = shortenHint(toolName);
  const stringEnd = bounds?.stringEnd ?? KEPT_STRING_END;
  const maxString = bounds?.stringEnd === undefined ? LONG_STRING_CHARS : 2 * stringEnd + 200;
  if (typeof value === "string") {
    if (value.length <= maxString) return value;
    // Each cut moved off a surrogate pair, so neither end holds half a character.
    const head = isHighSurrogate(value.charCodeAt(stringEnd - 1)) ? stringEnd - 1 : stringEnd;
    const tailStart = isLowSurrogate(value.charCodeAt(value.length - stringEnd)) ? value.length - stringEnd + 1 : value.length - stringEnd;
    return `${value.slice(0, head)}\n… [${tailStart - head} characters left out of this earlier result${hint}] …\n${value.slice(tailStart)}`;
  }

  const listHead = bounds?.listHead ?? KEPT_LIST_HEAD;
  const listTail = bounds?.listTail ?? KEPT_LIST_TAIL;
  if (Array.isArray(value)) {
    const items =
      value.length <= listHead + listTail
        ? value
        : [
            ...value.slice(0, listHead),
            `… [${value.length - listHead - listTail} items left out of this earlier result${hint}] …`,
            ...value.slice(-listTail),
          ];
    return items.map((item) => shortenedOutput(item, toolName, bounds));
  }
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shortenedOutput(entry, toolName, bounds)]));
  return value;
}

/** Rough per-message token contribution: text plus any tool output, same heuristic `assembleContext` uses. */
export function estimateMessageTokens(estimateTokens: (text: string) => number, message: WorkflowMessage): number {
  return (
    estimateTokens(message.text) +
    // A turn's context block under `models.promptLayout` `v2` is sent with the person's message it rides on.
    (message.contextText === undefined ? 0 : estimateTokens(message.contextText)) +
    (message.output === undefined ? 0 : estimateTokens(JSON.stringify(message.output))) +
    (message.toolCalls === undefined ? 0 : estimateTokens(JSON.stringify(message.toolCalls)))
  );
}

/**
 * Decide which messages a stage-2 model summary would cover, or that no
 * further reduction is needed.
 *
 * Draws from "eligible history" (`eligibleFoldCandidateIds`).
 * The trigger is token pressure, not a message count: it can arrive with far
 * fewer, much larger messages than `MAX_CONVERSATION_MESSAGES` ever requires.
 * Greedily removes the oldest eligible messages, cheapest-first ordering
 * being irrelevant here since age order is what "eligible history" means,
 * until the estimate, the fold's own summary counted, fits `targetTokens` or
 * eligible candidates run out — whichever first; a caller that still doesn't
 * fit after this has nothing further a deterministic or model-based pass can
 * safely remove this turn. With `targetTokens` below the budget (hysteresis)
 * a fold that cannot free the difference is not made: what it
 * may not take (the person's messages, earlier summaries) already fills the
 * trigger, and folding a turn's worth would only buy the next turn.
 */
export function planModelSummaryFold(
  conversation: readonly WorkflowMessage[],
  options: {
    readonly keepRecent: number;
    /** When set, the verbatim tail holds at most this many estimated tokens, even when that is fewer than `keepRecent` messages. */
    readonly keepRecentTokens?: number;
    readonly tokenBudget: number;
    /**
     * Where a fold that runs takes the estimate down to (hysteresis):
     * at most `tokenBudget`. When below it, a fold that cannot free at
     * least the difference is not made. Defaults to `tokenBudget`.
     */
    readonly targetTokens?: number;
    /** What the fold's own summary adds back, counted against the target. Defaults to 0. */
    readonly summaryTokens?: number;
    readonly currentTokens: number;
    readonly estimateTokens: (text: string) => number;
  },
): { readonly removeIds: readonly string[] } | undefined {
  if (options.currentTokens <= options.tokenBudget) return undefined;
  const target = Math.min(options.targetTokens ?? options.tokenBudget, options.tokenBudget);
  const headroom = options.targetTokens === undefined ? 0 : options.tokenBudget - target;
  let boundary = conversation.length - options.keepRecent;
  if (options.keepRecentTokens !== undefined) {
    let tail = 0;
    for (let index = conversation.length - 1; index >= Math.max(0, boundary); index -= 1) {
      tail += estimateMessageTokens(options.estimateTokens, conversation[index] as WorkflowMessage);
      if (tail > options.keepRecentTokens) {
        // The newest message stays whatever its size: the model has not seen it yet.
        boundary = Math.min(index + 1, conversation.length - 1);
        break;
      }
    }
  }
  if (boundary <= 0) return undefined;
  const oldest = conversation.slice(0, boundary);
  const eligibleIds = eligibleFoldCandidateIds(conversation, oldest);
  if (eligibleIds.size === 0) return undefined;

  let remaining = options.currentTokens + (options.summaryTokens ?? 0);
  let freed = 0;
  const removeIds: string[] = [];
  // A call is folded with its results: the target is checked only once every call taken so far has them.
  // Results always follow their call, so a provider that reuses an id opens it again with its next call.
  const open = new Set<string>();
  for (const message of oldest) {
    if (!eligibleIds.has(message.id)) continue;
    removeIds.push(message.id);
    const tokens = estimateMessageTokens(options.estimateTokens, message);
    remaining -= tokens;
    freed += tokens;
    if (message.toolCallId !== undefined) open.delete(message.toolCallId);
    for (const call of message.toolCalls ?? []) open.add(call.id);
    if (remaining <= target && open.size === 0) break;
  }
  // Too little to take: what is left would be over the trigger again within a turn or two.
  if (headroom > 0 && freed < headroom) return undefined;
  return removeIds.length === 0 ? undefined : { removeIds };
}

/**
 * Filter `conversation` down to `removeIds` and archive them as one
 * artifact — the first step of `buildModelSummaryFold`.
 * Returns `undefined`
 * when there's nothing to fold or archiving itself fails (a thrown
 * `putArtifact`), so the caller can fall back without a durable copy of
 * what would have been removed — folding without one would be silent data
 * loss, worse than not folding this turn.
 */
export async function archiveFoldedMessages(
  artifacts: ArtifactRepositoryPort,
  context: InvocationContext,
  conversation: readonly WorkflowMessage[],
  removeIds: readonly string[],
  fold: ArtifactFold,
  label: ContentLabel | undefined,
): Promise<{ readonly folded: readonly WorkflowMessage[]; readonly artifactId: string } | undefined> {
  const removeIdSet = new Set(removeIds);
  const folded = conversation.filter((message) => removeIdSet.has(message.id));
  if (folded.length === 0) return undefined;
  try {
    // Tagged with what folded it: the run id is the task's, so forgetting the chat's history finds it.
    // Labelled with its span's join, so reading it back cannot launder the span; one stored
    // without a label reads as untrusted (`artifactLabel`).
    const record = await artifacts.putArtifact({
      workspaceId: context.workspaceId,
      runId: context.runId,
      contentType: "application/json",
      // Without the context blocks kept on person messages (`contextText` under `v2`): reference material the
      // runtime gathered, never the chat's words, and the copy a later forget could not reach (`artifacts.read`).
      body: new TextEncoder().encode(JSON.stringify(folded.map(({ contextText: _block, contextShown: _shown, ...message }) => message))),
      fold,
      ...(label === undefined ? {} : { label }),
    });
    return { folded, artifactId: record.artifactId };
  } catch {
    return undefined;
  }
}

/**
 * Combine two folds computed in the same step (a rollover's, then stage 2's
 * or a forced rollover's) into one state update. A later fold never removes what an earlier
 * one added: a fold's summary joins after every existing message, and the
 * later folds take only older messages.
 */
export function combineFolds(a: ConversationFold | undefined, b: ConversationFold | undefined): ConversationFold | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return {
    removeIds: [...a.removeIds, ...b.removeIds],
    summary: a.summary,
    append: [b.summary, ...b.append, ...a.append],
  };
}
