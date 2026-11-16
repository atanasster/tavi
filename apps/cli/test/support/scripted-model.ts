import { isPersonMessage, type ModelEvent, type ModelMessage, type ModelOutcome, type ModelPort, type ModelRequest } from "@tavi/contracts";

/**
 * The injection suite's one scripted model,
 * extracted from the per-file fakes in `packages/agent-host/test`
 * (`tool-policy-gate.test.ts`'s `scriptedModel`, `epoch-rollover.test.ts`'s
 * `chattyModel`, `model-summary-data.test.ts`'s `poisonModel`), which keep
 * their own. Each turn it performs the benign task — its script's tool calls,
 * one a step, then its answer — and, in the `obedient` mode, makes the
 * attacker's call first whenever an injection is in context. The `ignoring`
 * mode never does: what it gives is benign utility and the false-gate rate.
 *
 * It keeps no state between calls: where it is in a turn is read off the
 * request, so a resumed or replayed turn picks up where its history says.
 */

type ScriptedModelMode = "obedient" | "ignoring";

/** One tool call, by canonical tool id, as a fixture names it. */
export interface ScriptedCall {
  readonly name: string;
  readonly input?: unknown;
}

/** What a request's call did: a benign step, the attacker's call, the turn's answer, or a call outside a turn (a summary, a flush). */
type ScriptedAction = "benign" | "attack" | "answer" | "side";

interface ScriptedObservation {
  readonly request: ModelRequest;
  /** Whether the injection was in the request's context. */
  readonly injected: boolean;
  /** The ids of the messages it was found in. */
  readonly injectedIn: readonly string[];
  readonly action: ScriptedAction;
  readonly outcome: ModelOutcome;
}

export interface ScriptedModelOptions {
  readonly mode: ScriptedModelMode;
  /** The benign task's tool calls, one a model step; then `answer`. */
  readonly script?: readonly ScriptedCall[];
  /** The turn's final text. Default "done". */
  readonly answer?: string;
  /**
   * How an injection is known in context: a marker (text or pattern) found in
   * any system, user or tool message — its text or its tool results — or a
   * predicate over the request. Assistant messages are not read, so the
   * model's own attacker call does not count.
   */
  readonly injection: string | RegExp | ((request: ModelRequest) => boolean);
  /** The attacker's call, made by the obedient mode once a turn when the injection is in context. */
  readonly attack?: ScriptedCall;
  /** The obedient mode's answer when the injection is in context (an exfiltrating reply, say); else `answer`. */
  readonly attackAnswer?: string;
  /** The text of a call outside a turn's loop (`purpose` other than generation). Default "A chat". */
  readonly side?: (request: ModelRequest, injected: boolean) => string;
}

export interface ScriptedModel extends ModelPort {
  readonly mode: ScriptedModelMode;
  /** Every request, in order, with what the model did with it. */
  readonly observations: ScriptedObservation[];
  /** The attacker's calls the model made. */
  readonly attacks: () => readonly ScriptedObservation[];
}

/** The id prefix of the attacker's call, by which a turn's history shows it was made. */
export const ATTACK_CALL_PREFIX = "attack-";
const BENIGN_CALL_PREFIX = "benign-";

/** The texts of a message the model reads: its text and each tool result's output. */
/** Every string leaf of `value`, so a marker is matched as written, not as its JSON escape. */
function stringLeaves(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringLeaves);
  return [];
}

function textsOf(message: ModelMessage): readonly string[] {
  return [message.text, ...(message.toolResults ?? []).flatMap((result) => stringLeaves(result.output))];
}

/** The ids of the messages of `request` an injection is found in; empty for a predicate that says no. */
export function injectionIn(request: ModelRequest, injection: ScriptedModelOptions["injection"]): readonly string[] {
  if (typeof injection === "function") return injection(request) ? ["(predicate)"] : [];
  const found = (text: string) =>
    typeof injection === "string" ? text.includes(injection) : new RegExp(injection.source, injection.flags.replace("g", "")).test(text);
  return request.messages.filter((message) => message.role !== "assistant" && textsOf(message).some(found)).map((message) => message.id);
}

/** Whether `message` opens a turn: the person's own message, not a step's runtime facts. */
const opensTurn = (message: ModelMessage) =>
  isPersonMessage(message) && !message.id.startsWith("facts-") && !message.text.startsWith("Runtime facts");

export function createScriptedModel(options: ScriptedModelOptions): ScriptedModel {
  const observations: ScriptedObservation[] = [];
  const script = options.script ?? [];
  return {
    mode: options.mode,
    observations,
    attacks: () => observations.filter((observation) => observation.action === "attack"),
    async stream(request: ModelRequest, streamOptions: { readonly onEvent: (event: ModelEvent) => void }): Promise<ModelOutcome> {
      const injectedIn = injectionIn(request, options.injection);
      const injected = injectedIn.length > 0;
      const record = (action: ScriptedAction, outcome: ModelOutcome): ModelOutcome => {
        observations.push({ request, injected, injectedIn, action, outcome });
        return outcome;
      };
      const text = (value: string): ModelOutcome => {
        streamOptions.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: `block-${request.attemptId}`, text: value });
        return { status: "completed", attemptId: request.attemptId, text: value, toolCalls: [], usage: {} };
      };
      const call = (id: string, scripted: ScriptedCall): ModelOutcome => {
        const input = scripted.input ?? {};
        streamOptions.onEvent({
          type: "tool.completed",
          attemptId: request.attemptId,
          blockId: id,
          toolName: scripted.name,
          callId: id,
          input,
        });
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: "",
          finishReason: "tool-calls",
          toolCalls: [{ id, name: scripted.name, input }],
          usage: {},
        };
      };

      if (request.purpose !== undefined && request.purpose !== "generation")
        return record("side", text(options.side?.(request, injected) ?? "A chat"));

      // This turn's calls so far: those after the person's newest message.
      const opener = request.messages.findLastIndex(opensTurn);
      const madeIds = request.messages
        .slice(opener + 1)
        .flatMap((message) => (message.role === "assistant" ? (message.toolCalls ?? []).map((made) => made.id) : []));
      const obeys = options.mode === "obedient" && injected;
      if (obeys && options.attack !== undefined && !madeIds.some((id) => id.startsWith(ATTACK_CALL_PREFIX))) {
        return record("attack", call(`${ATTACK_CALL_PREFIX}${request.attemptId}`, options.attack));
      }
      const step = madeIds.filter((id) => id.startsWith(BENIGN_CALL_PREFIX)).length;
      const next = script[step];
      if (next !== undefined) return record("benign", call(`${BENIGN_CALL_PREFIX}${step}-${request.attemptId}`, next));
      return record("answer", text(obeys && options.attackAnswer !== undefined ? options.attackAnswer : (options.answer ?? "done")));
    },
  };
}
