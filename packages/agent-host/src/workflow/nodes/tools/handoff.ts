import { interrupt } from "@langchain/langgraph";
import {
  BROWSER_HANDOFF_DEFAULT_MINUTES,
  BROWSER_HANDOFF_INSTRUCTIONS_MAX,
  BROWSER_HANDOFF_MAX_MINUTES,
  BROWSER_REQUEST_HANDOFF_TOOL_ID,
  BrowserRequestHandoffInputSchema,
  type BrowserHandoff,
  type BrowserHandoffResult,
  TaviError,
  labelledResult,
  type ToolResultLabel,
  waitRowId,
  WorkflowWaitSuspend,
  displaySafe,
} from "@tavi/contracts";
import { toModelError } from "../../../models/models.js";
import { failureOutput, invalidInputOutput } from "../../dispatch.js";
import { toWaitInterruptPayload, browserCallWaits, handoffAllowed } from "../../waits.js";
import { type ToolCall, type ToolRound, startDirectCall } from "./round.js";

// A person in the browser: the agent asks for one, or its browser
// call finds one in control of the session. Either way the task waits,
// durably, until the page is handed back.
/** A browser handoff: `true` when `call` asks for one or finds a person in control of its session, and its result is pushed. */
export async function runHandoffCall(round: ToolRound, call: ToolCall): Promise<boolean> {
  const { current, calls, toolsPolicy } = round;
  const { now, options, replyDisarm, turnTainted } = round.scope;
  const handoffPort = options.browserHandoff?.();
  const takenOver =
    handoffPort === undefined || calls.length !== 1 || call.name === BROWSER_REQUEST_HANDOFF_TOOL_ID || !call.name.startsWith("browser.")
      ? undefined
      : await browserCallWaits(handoffPort, current, call);
  if (call.name === BROWSER_REQUEST_HANDOFF_TOOL_ID || takenOver !== undefined) {
    const finish = await startDirectCall(round, call, true);
    const agents = options.agents?.();
    if (handoffPort === undefined || agents === undefined) {
      await finish(
        {
          error: "HUMAN_INPUT_UNAVAILABLE",
          detail: "Nobody can take over this browser from here. Say what you could not do, and why.",
        },
        true,
      );
      return true;
    }
    const missingForHandoff = options.access.missingPermissions(current.invocation, ["tools.invoke"]);
    if (missingForHandoff.length > 0) {
      await finish({ error: "NOT_AUTHORIZED", missingPermissions: missingForHandoff }, true);
      return true;
    }
    let modelSessionId: string;
    let asked: { readonly reason: BrowserHandoff["reason"]; readonly instructions?: string; readonly minutes: number };
    if (takenOver !== undefined) {
      modelSessionId = takenOver.sessionId;
      asked = { reason: "operator", minutes: BROWSER_HANDOFF_MAX_MINUTES };
    } else {
      // Checked here as well as when the tool list is built: a replay or a provider ignoring the list still arrives.
      if (!handoffAllowed(toolsPolicy)) {
        await finish(
          {
            error: "HUMAN_INPUT_UNAVAILABLE",
            detail: "This run is unattended: nobody can act in the browser for you. Say what you could not do, and why.",
          },
          true,
        );
        return true;
      }
      const parsedHandoff = BrowserRequestHandoffInputSchema.safeParse(call.input);
      if (!parsedHandoff.success) {
        await finish(invalidInputOutput(parsedHandoff.error.issues.map((issue) => issue.message)), true);
        return true;
      }
      modelSessionId = parsedHandoff.data.sessionId;
      // Its instructions reach the person's chat and the live view: in a tainted turn with every URL the
      // conversation does not know defanged, as a reply's are, held to their bound. Like `ask_user`, it
      // is the chat's own question, so it is not asked about in a group.
      // What they would hide is marked, as a question's is.
      const given = parsedHandoff.data.instructions === undefined ? undefined : displaySafe(parsedHandoff.data.instructions);
      const instructions =
        given === undefined
          ? undefined
          : (turnTainted(current) ? (await replyDisarm(current))(given) : given).slice(0, BROWSER_HANDOFF_INSTRUCTIONS_MAX);
      asked = {
        reason: parsedHandoff.data.reason,
        ...(instructions === undefined ? {} : { instructions }),
        minutes: parsedHandoff.data.timeoutMinutes ?? BROWSER_HANDOFF_DEFAULT_MINUTES,
      };
    }
    const target = await handoffPort.target({ taskId: current.runId, sessionId: modelSessionId });
    if ("refusal" in target) {
      await finish(invalidInputOutput(target.refusal), true);
      return true;
    }
    const handoff: BrowserHandoff = {
      sessionId: target.historyId,
      reason: asked.reason,
      ...(asked.instructions === undefined ? {} : { instructions: asked.instructions }),
    };
    const waitId = waitRowId(current.runId, current.steps, call.id);
    try {
      const output = await agents.waitFor({
        actor: {
          principalId: current.invocation.principalId,
          workspaceId: current.invocation.workspaceId,
          runId: current.runId,
          caller: current.invocation.caller,
        },
        taskId: current.runId,
        waitId,
        handoff,
        // The agent's own request: the session waits for a person once the wait is active. A take needs no asking.
        // A take needs no asking; but a person who handed back before this wait was active must not leave it waiting.
        deliver:
          takenOver !== undefined
            ? async () => {
                if (handoffPort.controlState({ taskId: current.runId, sessionId: modelSessionId }) === "agent")
                  throw new TaviError("CONFLICT", "handed back before the wait began", { details: { handedBack: true } });
              }
            : () => handoffPort.request({ taskId: current.runId, historyId: target.historyId, handoff, waitId }),
        deadlineAt: new Date(Date.parse(now()) + asked.minutes * 60_000).toISOString(),
      });
      const settled = output.outcome;
      const outcome: BrowserHandoffResult["outcome"] =
        settled.handoff !== undefined ? settled.handoff.outcome : settled.kind === "wait-timeout" ? "timeout" : "cancelled";
      // Nobody handed it back: the agent acts in the page again.
      if (outcome === "timeout" || outcome === "cancelled") handoffPort.end({ historyId: target.historyId, outcome });
      let page: unknown;
      let label: ToolResultLabel | undefined;
      let detail: string | undefined;
      try {
        // A page the host labelled (its site and title now) labels the result, as any browser read's does: where the
        // chat's next card says it read, it names the page handed back, not the one before the person signed in.
        const observed = labelledResult(await handoffPort.observe(modelSessionId));
        page = observed.output;
        label = observed.label;
      } catch (error) {
        detail = `The page could not be observed: ${toModelError(error).message}`;
      }
      const result: BrowserHandoffResult = {
        outcome,
        reason: asked.reason,
        ...(settled.replyText === undefined || settled.handoff === undefined ? {} : { note: settled.replyText }),
        controlledMs: settled.handoff?.controlledMs ?? 0,
        ...(page === undefined ? {} : { page }),
        ...(detail === undefined ? {} : { detail }),
      };
      await finish(
        takenOver === undefined
          ? result
          : {
              ...result,
              error: "OPERATOR_CONTROL",
              ran: false,
              detail: `A person took over this browser session, so ${call.name} did not run. Look at the page below, then call it again if it is still needed.${detail === undefined ? "" : ` ${detail}`}`,
            },
        false,
        undefined,
        label,
      );
    } catch (error) {
      if (error instanceof WorkflowWaitSuspend) {
        interrupt(toWaitInterruptPayload(error));
        throw new TaviError("INTERNAL", `browser handoff resumed unexpectedly for wait ${error.waitId}`);
      }
      if (takenOver !== undefined && error instanceof TaviError && error.details?.["handedBack"] === true) {
        await finish(
          {
            error: "OPERATOR_CONTROL",
            ran: false,
            detail: `A person had this browser session and has handed it back, so ${call.name} did not run. Observe the page, then call it again if it is still needed.`,
          },
          false,
        );
        return true;
      }
      await finish(failureOutput(undefined, toModelError(error).message, error), true);
    }
    return true;
  }
  return false;
}
