import { type ToolHandler, waitRowId, connectNeedText, type AgentStateData } from "@tavi/contracts";
import { disarmedQuestion } from "../../dispatch.js";
import { type ToolCall, type ToolRound, earliestInstant } from "./round.js";

/**
 * A tool's question to the person (`ToolHandler`'s `ask`): a
 * "Needs you" question on this task, as `operator.ask_user`'s, with the
 * same wait row, delivery and deadline cap. Its wait id is derived from
 * the call and the question's key, so a call run again after the answer
 * finds it settled. Absent where nobody may be asked: an unattended run,
 * or one that may ask only with a default, which a tool's question never
 * has, or with no channel to ask on.
 */
export function toolQuestionFor(
  round: ToolRound,
  state: AgentStateData,
  call: ToolCall,
): NonNullable<Parameters<ToolHandler>[0]["ask"]> | undefined {
  const { toolsPolicy, humanQuestionsAllowedHere } = round;
  const { now, options, replyDisarm, turnTainted } = round.scope;
  const agents = options.agents?.();
  const askUser = options.askUser;
  if (
    !humanQuestionsAllowedHere ||
    toolsPolicy.mode === "unattended" ||
    toolsPolicy.requiresDefault === true ||
    agents === undefined ||
    askUser === undefined
  )
    return undefined;
  // Read when the call first asks: a tool that never asks pays nothing for them.
  let reads: Promise<{ readonly disarm: ((text: string) => string) | undefined; readonly deadlineCap: string | undefined }> | undefined;
  return async (asked) => {
    reads ??= (async () => ({
      disarm: turnTainted(state) ? await replyDisarm(state) : undefined,
      deadlineCap: options.askUserDeadlineCap === undefined ? undefined : await options.askUserDeadlineCap(state.runId),
    }))();
    const { disarm, deadlineCap } = await reads;
    // A question written in a tainted turn goes out with its unknown URLs defanged, its choices too.
    const shown =
      disarm === undefined
        ? asked
        : (() => {
            const disarmed = disarmedQuestion(
              {
                question: asked.question,
                ...(asked.context === undefined ? {} : { context: asked.context }),
                ...(asked.choices === undefined
                  ? {}
                  : {
                      options: asked.choices.options,
                      ...(asked.choices.header === undefined ? {} : { header: asked.choices.header }),
                    }),
              },
              disarm,
            );
            return {
              ...asked,
              question: disarmed.question,
              ...(disarmed.context === undefined ? {} : { context: disarmed.context }),
              ...(asked.choices === undefined || disarmed.options === undefined
                ? {}
                : {
                    choices: {
                      ...asked.choices,
                      options: disarmed.options,
                      ...(disarmed.header === undefined ? {} : { header: disarmed.header }),
                    },
                  }),
            };
          })();
    const waitId = waitRowId(state.runId, state.steps, `${call.id}:${asked.key}`);
    // An app to sign in again: no question to answer, and only Tavi's words go to a chat.
    if (asked.connect !== undefined) {
      const connect = asked.connect;
      const tell = options.tellConnect;
      return (
        await agents.waitFor({
          actor: {
            principalId: state.invocation.principalId,
            workspaceId: state.invocation.workspaceId,
            runId: state.runId,
            caller: state.invocation.caller,
          },
          taskId: state.runId,
          waitId,
          // No `question`: a connect wait is never a question a typed line answers.
          connect,
          ...(tell === undefined
            ? {}
            : { deliver: async () => await tell({ taskId: state.runId, waitId, text: connectNeedText(connect), connect }) }),
          deadlineAt: earliestInstant(new Date(Date.parse(now()) + asked.deadlineMs).toISOString(), deadlineCap),
        })
      ).outcome;
    }
    const result = await agents.waitFor({
      actor: {
        principalId: state.invocation.principalId,
        workspaceId: state.invocation.workspaceId,
        runId: state.runId,
        caller: state.invocation.caller,
      },
      taskId: state.runId,
      waitId,
      question: shown.question,
      ...(shown.choices === undefined ? {} : { choices: shown.choices }),
      ...(shown.context === undefined ? {} : { context: shown.context }),
      deliver: async () => {
        await askUser({
          question: shown.question,
          ...(shown.choices === undefined ? {} : { choices: shown.choices }),
          ...(shown.context === undefined ? {} : { context: shown.context }),
          invocation: state.invocation,
          taskId: state.runId,
          waitId,
          bestEffort: true,
        });
      },
      deadlineAt: earliestInstant(new Date(Date.parse(now()) + asked.deadlineMs).toISOString(), deadlineCap),
    });
    return result.outcome;
  };
}
