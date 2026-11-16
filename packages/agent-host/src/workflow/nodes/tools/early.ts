import { toolAnnotationsOf, type ToolHandler, TaviError, DEFAULT_PARALLEL_READS } from "@tavi/contracts";
import { TOOL_SEARCH_ID } from "../../../tools/tool-routing.js";
import { repeatRefusal } from "../../repeats.js";
import { assertLeaseCurrent } from "../../run-config.js";
import { type ToolCall, type ToolRound, runDispatch } from "./round.js";
import { toolQuestionFor } from "./questions.js";

async function runsEarly(round: ToolRound, call: ToolCall): Promise<boolean> {
  const { current, toolInvocation, readOnlyTool } = round;
  const { callNeedsApproval, hardDenyOf, options, toolDisclosureRefusal, verdictOf } = round.scope;
  const definition = options.tools.get(call.name);
  const verdict = verdictOf(current, call);
  return !(
    definition === undefined ||
    call.name === TOOL_SEARCH_ID ||
    (verdict?.effect ?? definition.effect) !== "read-only" ||
    !toolAnnotationsOf(definition).readOnly ||
    verdict?.decision === "deny" ||
    current.denials[call.id] !== undefined ||
    callNeedsApproval(current, call) ||
    (verdict === undefined && definition.assess !== undefined && hardDenyOf(definition, call.input, toolInvocation) !== undefined) ||
    (await toolDisclosureRefusal(current, call.name, call.input)) !== undefined ||
    repeatRefusal(
      current.conversation.filter(
        (message) => message.role !== "assistant" || message.toolCalls?.some((made) => made.id === call.id) !== true,
      ),
      call.name,
      call.input,
      readOnlyTool,
    ) !== undefined
  );
}

function sessionOf(call: ToolCall): string | undefined {
  const id = (call.input as { readonly sessionId?: unknown } | null)?.sessionId;
  return typeof id === "string" ? id : undefined;
}

/** Starts the run of calls from `from` that may go early together, when there are two or more. */
export async function startEarlyRun(round: ToolRound, from: number): Promise<void> {
  const { config, current, calls, prefetched, earlySignal } = round;
  const { options } = round.scope;
  const run: number[] = [];
  const sessions = new Set<string>();
  let end = from;
  for (; end < calls.length; end += 1) {
    const call = calls[end] as (typeof calls)[number];
    if (!(await runsEarly(round, call))) break;
    const session = sessionOf(call);
    // A second call on a session waits its turn; the calls after it may still go.
    if (session !== undefined && sessions.has(session)) continue;
    if (session !== undefined) sessions.add(session);
    run.push(end);
  }
  if (run.length > 1) round.parallelReads ??= (await options.parallelReads?.(current.invocation.workspaceId)) ?? DEFAULT_PARALLEL_READS;
  // At 1 every call runs in its turn: no later scan could start anything.
  if (round.parallelReads !== undefined && round.parallelReads < 2) {
    round.scannedUntil = calls.length;
    return;
  }
  const together = run.slice(0, round.parallelReads ?? 1);
  // Past the cap, the next scan starts at the first call left out.
  round.scannedUntil = Math.max(from + 1, run.length > together.length ? (run[together.length] as number) : end);
  if (together.length < 2) return;
  await assertLeaseCurrent(options, config);
  if ((await options.cancellations.get(current.runId)) !== undefined) return;
  for (const index of together) {
    const call = calls[index] as (typeof calls)[number];
    let asked = false;
    // Where nobody may be asked, the call gets no `ask`, as it would in its turn.
    const deferAsk: NonNullable<Parameters<ToolHandler>[0]["ask"]> | undefined =
      toolQuestionFor(round, current, call) === undefined
        ? undefined
        : async () => {
            asked = true;
            throw new TaviError("CONFLICT", `${call.name} asks the person: it runs again in order`);
          };
    const startedAt = performance.now();
    prefetched.set(index, {
      startedAt,
      settled: runDispatch(round, call, deferAsk, earlySignal).then(
        (message) => ({ message }),
        (error: unknown) => ({ error }),
      ),
      asked: () => asked,
    });
  }
}
