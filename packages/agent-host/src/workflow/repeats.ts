import { isPersonMessage, toolAnnotationsOf, type ToolRegistryPort, type WorkflowMessage } from "@tavi/contracts";

/**
 * How many of the conversation's latest tool calls are compared for a loop; at
 * how many alike the model is told it loops (after 2 repeats), at how many the
 * same call again is refused rather than run (after 3), and at how many the
 * person is asked how to go on (after 4: the model went on past a refusal).
 * A back-and-forth between two calls (`A, B, A, B`) counts its rounds against
 * the same marks.
 */
export const REPEAT_WINDOW = 12;

export const REPEAT_THRESHOLD = 2;

export const REPEAT_REFUSED_AT = 3;

export const REPEAT_ASK_AT = 4;

export const NO_PROGRESS_NUDGE_AT = 4;

export const NO_PROGRESS_REFUSED_AT = 6;

export const NO_PROGRESS_NUDGE = "No change in the last 4 actions: observe, try another approach, or hand off";

export interface BrowserProgressSignature {
  readonly url: string;
  readonly elementsHash: string;
}

export interface SessionProgress {
  readonly sessionId: string;
  readonly signature: BrowserProgressSignature;
  readonly noChangeActions: number;
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** What a result carries that is no part of its answer: the observation's `epoch`. */
const RESULT_NOISE_KEYS: ReadonlySet<string> = new Set(["epoch"]);

/**
 * `value` as JSON for comparing two calls or results: object keys sorted, so
 * `{a, b}` and `{b, a}` are the same, and without `ignored` keys at any depth —
 * by default the observation's `epoch`, which changes on every look at an
 * unchanged page.
 */
function fingerprintJson(value: unknown, ignored: ReadonlySet<string> = RESULT_NOISE_KEYS): string {
  return (
    JSON.stringify(value, (key, entry: unknown) => {
      if (ignored.has(key)) return undefined;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
      return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
    }) ?? ""
  );
}

function hashElements(elements: unknown): string {
  if (!Array.isArray(elements)) return "";
  return fnv1aHex(fingerprintJson(elements));
}

const SCROLL_DETAIL_PATTERN = /scrolled to -?\d+ of \d+ px/;

interface MutableSessionProgress {
  url: string;
  elementsHash: string;
  noChangeActions: number;
  hasSignature: boolean;
}

function extractObservation(
  toolName: string | undefined,
  output: unknown,
): { readonly sessionId?: string; readonly url: string; readonly elements: readonly unknown[] } | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const candidate =
    toolName === "browser.navigate" || toolName === "browser.observe"
      ? output
      : toolName === "browser.create_session" || toolName === "browser.act" || toolName === "browser.request_handoff"
        ? (output as { readonly page?: unknown }).page
        : undefined;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const rec = candidate as { readonly sessionId?: unknown; readonly url?: unknown; readonly elements?: unknown };
  if (typeof rec.url !== "string" || !Array.isArray(rec.elements)) return undefined;
  return {
    ...(typeof rec.sessionId === "string" ? { sessionId: rec.sessionId } : {}),
    url: rec.url,
    elements: rec.elements,
  };
}

function applyActionProgress(state: MutableSessionProgress, _stepInput: unknown, stepOutput: unknown): void {
  if (typeof stepOutput !== "object" || stepOutput === null) {
    state.noChangeActions += 1;
    return;
  }
  const out = stepOutput as {
    readonly status?: unknown;
    readonly detail?: unknown;
    readonly changes?: unknown;
    readonly page?: unknown;
  };
  const detail = typeof out.detail === "string" ? out.detail : "";
  // A scroll is progress unless the browser says it reached the bottom and the page stopped growing.
  const scrollProgressed = SCROLL_DETAIL_PATTERN.test(detail) && !detail.includes("(end of page)");

  let sigChanged = false;
  const pageObs = extractObservation("browser.act", stepOutput);
  if (pageObs !== undefined) {
    const nextHash = hashElements(pageObs.elements);
    sigChanged = !state.hasSignature || pageObs.url !== state.url || nextHash !== state.elementsHash;
    state.url = pageObs.url;
    state.elementsHash = nextHash;
    state.hasSignature = true;
  }

  const changes = Array.isArray(out.changes) ? out.changes.filter((c): c is string => typeof c === "string") : [];
  for (const line of changes) {
    if (line.startsWith("url -> ")) {
      const nextUrl = line.slice("url -> ".length).trim();
      if (nextUrl !== state.url) {
        state.url = nextUrl;
      }
    }
  }
  const hasChanges = changes.some((line) => !line.startsWith("focus is on "));

  if (sigChanged || hasChanges || scrollProgressed) {
    state.noChangeActions = 0;
  } else {
    state.noChangeActions += 1;
  }
}

/** Tracks per-session browser progress signatures `(url, elementsHash)` and consecutive no-change counts across `conversation`. */
export function browserSessionProgress(conversation: readonly WorkflowMessage[]): ReadonlyMap<string, SessionProgress> {
  const callsById = new Map<string, { readonly name: string; readonly input: unknown }>();
  for (const message of conversation) {
    if (message.role !== "assistant" || message.toolCalls === undefined) continue;
    for (const call of message.toolCalls) {
      callsById.set(call.id, { name: call.name, input: call.input });
    }
  }

  const states = new Map<string, MutableSessionProgress>();
  const stateOf = (sessionId: string): MutableSessionProgress => {
    let state = states.get(sessionId);
    if (state === undefined) {
      state = {
        url: "",
        elementsHash: "",
        noChangeActions: 0,
        hasSignature: false,
      };
      states.set(sessionId, state);
    }
    return state;
  };

  for (const message of conversation) {
    if (message.role !== "tool" || message.isError === true) continue;
    const call = message.toolCallId === undefined ? undefined : callsById.get(message.toolCallId);
    const toolName = message.toolName ?? call?.name;
    if (toolName === undefined || !toolName.startsWith("browser.")) continue;
    const inputObj = (typeof call?.input === "object" && call.input !== null ? call.input : {}) as {
      readonly sessionId?: unknown;
      readonly actions?: unknown;
    };
    const outObj = (typeof message.output === "object" && message.output !== null ? message.output : {}) as {
      readonly sessionId?: unknown;
      readonly page?: { readonly sessionId?: unknown } | null;
      readonly steps?: unknown;
    };
    const sessionId =
      typeof inputObj.sessionId === "string"
        ? inputObj.sessionId
        : typeof outObj.sessionId === "string"
          ? outObj.sessionId
          : typeof outObj.page?.sessionId === "string"
            ? outObj.page.sessionId
            : undefined;
    if (sessionId === undefined) continue;
    const state = stateOf(sessionId);

    if (toolName === "browser.navigate" || toolName === "browser.create_session" || toolName === "browser.request_handoff") {
      const obs = extractObservation(toolName, message.output);
      if (obs !== undefined) {
        state.url = obs.url;
        state.elementsHash = hashElements(obs.elements);
        state.noChangeActions = 0;
        state.hasSignature = true;
      }
      continue;
    }

    if (toolName === "browser.observe") {
      const obs = extractObservation(toolName, message.output);
      if (obs !== undefined) {
        const nextHash = hashElements(obs.elements);
        if (!state.hasSignature || obs.url !== state.url || nextHash !== state.elementsHash) {
          state.url = obs.url;
          state.elementsHash = nextHash;
          state.noChangeActions = 0;
          state.hasSignature = true;
        }
      }
      continue;
    }

    if (toolName === "browser.act") {
      applyActionProgress(state, call?.input, message.output);
      continue;
    }

    if (toolName === "browser.batch" && Array.isArray(outObj.steps)) {
      const actions = Array.isArray(inputObj.actions) ? inputObj.actions : [];
      outObj.steps.forEach((stepOut, index) => {
        applyActionProgress(state, actions[index], stepOut);
      });
    }
  }

  const result = new Map<string, SessionProgress>();
  for (const [sessionId, state] of states.entries()) {
    result.set(sessionId, {
      sessionId,
      signature: {
        url: state.url,
        elementsHash: state.elementsHash,
      },
      noChangeActions: state.noChangeActions,
    });
  }
  return result;
}

/**
 * Adds a progress nudge ("No change in the last 4 actions...") or "end of page"
 * to a browser action's result when the session's progress signature did not advance.
 */
export function annotateBrowserProgress(conversation: readonly WorkflowMessage[], name: string, input: unknown, output: unknown): unknown {
  if ((name !== "browser.act" && name !== "browser.batch") || typeof output !== "object" || output === null) {
    return output;
  }
  const syntheticCallId = "__progress_check__";
  const nextConversation: readonly WorkflowMessage[] = [
    ...conversation.filter(
      (message) => message.role !== "assistant" || message.toolCalls?.some((made) => made.id === syntheticCallId) !== true,
    ),
    {
      id: "a-progress-check",
      role: "assistant",
      text: "",
      toolCalls: [{ id: syntheticCallId, name, input }],
    },
    {
      id: "t-progress-check",
      role: "tool",
      text: "",
      toolCallId: syntheticCallId,
      toolName: name,
      output,
    },
  ];
  const sessionId = typeof input === "object" && input !== null ? (input as { readonly sessionId?: unknown }).sessionId : undefined;
  if (typeof sessionId !== "string") return output;
  const progress = browserSessionProgress(nextConversation).get(sessionId);
  if (progress === undefined) return output;

  const outRecord = output as { readonly detail?: unknown };
  let detail = typeof outRecord.detail === "string" ? outRecord.detail : undefined;
  if (progress.noChangeActions >= NO_PROGRESS_NUDGE_AT) {
    if (detail === undefined) detail = NO_PROGRESS_NUDGE;
    else if (!detail.includes(NO_PROGRESS_NUDGE)) detail = `${detail}. ${NO_PROGRESS_NUDGE}`;
  }
  return detail !== outRecord.detail ? { ...output, detail } : output;
}

/**
 * What a call's input carries that is no part of what it asks, at any depth:
 * the observation's `epoch`, an idempotency key (`operationKey`,
 * `idempotencyKey`), a nonce or request id, and a timestamp stamped on the
 * call. Two calls alike in all but these ask the same thing — a spawn retried
 * with a fresh `operationKey` is the same spawn.
 */
const INPUT_NOISE_KEYS: ReadonlySet<string> = new Set(["epoch", "operationKey", "idempotencyKey", "nonce", "requestId", "timestamp"]);

/**
 * The fields that say what a call asks, for tools whose other fields do not:
 * a task's status is the same look whatever else rides along, and a second
 * cancel of the same task is the same cancel whatever reason it gives. A tool
 * not listed is named by its whole input, less `INPUT_NOISE_KEYS`.
 */
const SEMANTIC_INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "agents.status": ["taskId"],
  "agents.cancel": ["taskId"],
};

/** The part of `input` that says what `name` is asked: its `SEMANTIC_INPUT_FIELDS`, or all of it. */
function semanticInput(name: string, input: unknown): unknown {
  const fields = SEMANTIC_INPUT_FIELDS[name];
  if (fields === undefined || typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const record = input as Readonly<Record<string, unknown>>;
  return Object.fromEntries(fields.filter((field) => field in record).map((field) => [field, record[field]]));
}

/** A call's identity for loop detection: its tool and what it asks (`semanticInput`), without its noise (`INPUT_NOISE_KEYS`). */
function callFingerprint(name: string, input: unknown): string {
  return fingerprintJson([name, semanticInput(name, input)], INPUT_NOISE_KEYS);
}

/**
 * Calls that are alike on purpose when repeated: looking at the page again, and
 * moving through it — a scroll down a long list, a key, a wait — act on no
 * element, so each one is the same call doing new work; and waiting on a
 * worker again, which is what a long worker takes.
 */
function repeatsByDesign(name: string, input: unknown): boolean {
  if (name === "browser.observe" || name === "browser.read" || name === "agents.wait") return true;
  if (name !== "browser.act") return false;
  const action = (typeof input === "object" && input !== null ? input : {}) as { readonly kind?: unknown; readonly ref?: unknown };
  return action.ref === undefined && (action.kind === "scroll" || action.kind === "press" || action.kind === "wait_for");
}

/** A result's identity for loop detection: what it said, without the observation's `epoch`. */
function resultFingerprint(output: unknown): string {
  return fingerprintJson(output);
}

/** The error a call refused as a repeat gets in place of its result. */
export const REPEATED_CALL_ERROR = "REPEATED_CALL";

/** A refusal is no answer: it neither matches nor breaks the answers before it, and it still counts as the call made again. */
function isRepeatRefusal(message: WorkflowMessage): boolean {
  if (message.isError !== true || typeof message.output !== "object" || message.output === null) return false;
  return (message.output as { readonly error?: unknown }).error === REPEATED_CALL_ERROR;
}

/**
 * Whether a tool only reads (its `readOnly` annotation). The callers know it
 * from the registry; without it no call is taken for a read, so neither
 * exemption below applies.
 */
export type ReadOnlyTool = (name: string) => boolean;

/** `ReadOnlyTool` from a tool registry: an unknown tool is no read. */
export function readOnlyToolOf(tools: Pick<ToolRegistryPort, "get">): ReadOnlyTool {
  return (name) => {
    const definition = tools.get(name);
    return definition !== undefined && toolAnnotationsOf(definition).readOnly;
  };
}

/** A loop the model is in. */
export interface RepeatedCall {
  /** The latest call's tool. */
  readonly tool: string;
  /** How many times the latest call was made in the loop, it included. */
  readonly times: number;
  /** The latest call's identity. */
  readonly call: string;
  /** For a back-and-forth (`A, B, A, B`): the other call's tool, which took turns with `tool`. */
  readonly alternate?: string;
}

/** One call in the window, with what loop detection reads of it. */
interface WindowCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly key: string;
  /** The assistant message it came in: calls of one message ran as one step. */
  readonly step: number;
  /** Made beside other calls in one step: a fan-out, which the tools node runs together when they all read. */
  readonly fanOut: boolean;
  /** Its result's identity; `undefined` while it has none, or when it was refused as a repeat. */
  readonly answer: string | undefined;
}

/**
 * The conversation's latest `REPEAT_WINDOW` calls since the person last spoke,
 * oldest first. A person who asks for the same thing again ("run it again")
 * is no loop of the model's, and is not to be asked about one.
 */
function windowCalls(conversation: readonly WorkflowMessage[]): readonly WindowCall[] {
  const answers = new Map<string, string>();
  for (const message of conversation)
    if (message.role === "tool" && message.toolCallId !== undefined && !isRepeatRefusal(message))
      answers.set(message.toolCallId, resultFingerprint(message.output));
  // Counting restarts where the person last spoke: their own message, or their answer to the repeated-call question
  // (it comes back on the refusal), so going on as they said is not counted against the calls before it.
  const spoke = conversation.findLastIndex(
    (message) =>
      isPersonMessage(message) || (isRepeatRefusal(message) && (message.output as { readonly person?: unknown }).person !== undefined),
  );
  return conversation
    .flatMap((message, step) =>
      step <= spoke || message.role !== "assistant"
        ? []
        : (message.toolCalls ?? []).map((call, _index, made) => ({
            id: call.id,
            name: call.name,
            input: call.input,
            key: callFingerprint(call.name, call.input),
            step,
            fanOut: made.length > 1,
            answer: answers.get(call.id),
          })),
    )
    .slice(-REPEAT_WINDOW);
}

/**
 * The latest call made again with the same answer. A read made again after a
 * write (another call that does not only read) is checking what the write did,
 * so only its reads since the last write count; and reads fanned out in one
 * step are one look, however often they name the same call.
 */
function sameCallRepeat(calls: readonly WindowCall[], readOnly: ReadOnlyTool | undefined): RepeatedCall | undefined {
  const latest = calls.at(-1);
  if (latest === undefined || repeatsByDesign(latest.name, latest.input)) return undefined;
  // The answer to match: the latest the call got, when its latest try has none yet or was refused.
  const answer = calls.findLast((call) => call.key === latest.key && call.answer !== undefined)?.answer;
  const from = readOnly?.(latest.name) === true ? calls.findLastIndex((call) => call.key !== latest.key && !readOnly(call.name)) + 1 : 0;
  const made = new Set<string>();
  for (const call of calls.slice(from)) {
    if (call.key !== latest.key || (answer !== undefined && call.answer !== undefined && call.answer !== answer)) continue;
    made.add(call.fanOut && readOnly?.(call.name) === true ? `step:${String(call.step)}` : `call:${call.id}`);
  }
  return made.size >= REPEAT_THRESHOLD ? { tool: latest.name, times: made.size, call: latest.key } : undefined;
}

/**
 * Two calls taking turns, `A, B, A, B`, each with its same input and its same
 * answer every time: neither moves the other on. Polling whose answer changes
 * breaks the run there, and a fan-out step is no turn. A write and the read
 * that checks it are one pair; the same pair again with the same answers is a
 * write that did nothing, and counts. `times` is how often the latest call was
 * made in the run, from its second round on.
 */
function backAndForth(calls: readonly WindowCall[]): RepeatedCall | undefined {
  const latest = calls.at(-1);
  const before = calls.at(-2);
  if (latest === undefined || before === undefined || latest.key === before.key) return undefined;
  if (repeatsByDesign(latest.name, latest.input) || repeatsByDesign(before.name, before.input)) return undefined;
  const answers = new Map<string, string>();
  let length = 0;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call === undefined || call.fanOut || call.key !== (length % 2 === 0 ? latest.key : before.key)) break;
    if (call.answer !== undefined) {
      const seen = answers.get(call.key);
      if (seen !== undefined && seen !== call.answer) break;
      answers.set(call.key, call.answer);
    }
    length += 1;
  }
  const times = Math.ceil(length / 2);
  return length >= 2 * REPEAT_THRESHOLD ? { tool: latest.name, times, call: latest.key, alternate: before.name } : undefined;
}

/**
 * The model's latest tool call, when it has made it `REPEAT_THRESHOLD` or more
 * times among its last `REPEAT_WINDOW` calls with the same answer each time
 * (a click that does nothing, a navigate to the same blocked page, the same
 * search again), or has taken turns with another call that long
 * (`backAndForth`). A call whose answer changed — a "Show more" that showed
 * more, a worker's status that moved on — made progress, and is no repeat.
 * Only the latest call counts, so a model that changed approach is no longer
 * told it is looping; calls alike by design (`repeatsByDesign`) never count.
 * `readOnly` lets a read checking a write, and a fan-out of reads, go
 * uncounted. `undefined` when there is no loop.
 */
export function repeatedToolCall(conversation: readonly WorkflowMessage[], readOnly?: ReadOnlyTool): RepeatedCall | undefined {
  const calls = windowCalls(conversation);
  const same = sameCallRepeat(calls, readOnly);
  const alternating = backAndForth(calls);
  if (alternating !== undefined && (same === undefined || alternating.times >= same.times)) return alternating;
  return same;
}

/** The id `repeatEscalation` gives the call it weighs, made after the conversation so far. */
const WEIGHED_CALL_ID = "__repeat_check__";

/**
 * What to do with `name(input)` in place of running it, or `undefined` to run
 * it. The call is weighed as the latest of the conversation, so `times`
 * counts it too. Past `REPEAT_REFUSED_AT` the same call (or the same turn of a
 * back-and-forth) is refused: the model was told it loops, at
 * `REPEAT_THRESHOLD`, and went on. Past `REPEAT_ASK_AT` it went on past a
 * refusal too, and the person is asked how to go on (`ask`) — where the run
 * may ask nobody the tools node refuses it as before. A browser session with
 * `NO_PROGRESS_REFUSED_AT` actions and no change is refused as well.
 */
export function repeatEscalation(
  conversation: readonly WorkflowMessage[],
  name: string,
  input: unknown,
  readOnly?: ReadOnlyTool,
): { readonly kind: "refuse" | "ask"; readonly reason: string; readonly alternate?: string } | undefined {
  const loop = repeatedToolCall(
    [...conversation, { id: WEIGHED_CALL_ID, role: "assistant", text: "", toolCalls: [{ id: WEIGHED_CALL_ID, name, input }] }],
    readOnly,
  );
  if (loop !== undefined && loop.times > REPEAT_REFUSED_AT) {
    const made = loop.times - 1;
    const what =
      loop.alternate === undefined
        ? `this exact ${name} call has given the same answer ${made} times`
        : `${name} and ${loop.alternate} have taken turns ${made} times with the same answers`;
    return {
      kind: loop.times > REPEAT_ASK_AT ? "ask" : "refuse",
      ...(loop.alternate === undefined ? {} : { alternate: loop.alternate }),
      reason: `${what}: it was not run again. Change approach — another element, another site or source, hand the page to the person — or answer with what you have and say what you could not get`,
    };
  }
  if (name === "browser.act" || name === "browser.batch") {
    const sessionId = typeof input === "object" && input !== null ? (input as { readonly sessionId?: unknown }).sessionId : undefined;
    if (typeof sessionId === "string") {
      const progress = browserSessionProgress(conversation).get(sessionId);
      if (progress !== undefined && progress.noChangeActions >= NO_PROGRESS_REFUSED_AT) {
        return {
          kind: "refuse",
          reason: `No change in the last ${progress.noChangeActions} actions: observe, try another approach, or hand off — this ${name} call was not run`,
        };
      }
    }
  }
  return undefined;
}

/** Why `name(input)` is refused rather than run (`repeatEscalation`'s reason, whether refused or asked about), or `undefined` to run it. */
export function repeatRefusal(
  conversation: readonly WorkflowMessage[],
  name: string,
  input: unknown,
  readOnly?: ReadOnlyTool,
): string | undefined {
  return repeatEscalation(conversation, name, input, readOnly)?.reason;
}
