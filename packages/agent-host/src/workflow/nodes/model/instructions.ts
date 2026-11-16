import type { AgentDefinition } from "@tavi/contracts";
import { composeAgentPrompt } from "../../prompt.js";
import { executionLeaseOf } from "../../run-config.js";
import type { ModelStep } from "./context.js";

/** The step's instructions: its persona, its selected base and its chat's instructions, composed. */
export async function resolveInstructions(step: ModelStep) {
  const { config, current, facts } = step;
  const { options, selectedPromptSnapshot } = step.scope;
  // The persona for this turn, resolved from the checkpointed reference. See
  // `admit` for why an unknown definition is refused there but merely
  // degraded here.
  // `enabled` is re-checked here, not only at admission: a task admitted while
  // its persona was enabled must stop using it if an operator disables the
  // agent mid-task, and a resume deliberately skips admission validation
  // (see `admit`), so this is the only place that can catch it.
  // Resolution failure degrades the persona, never the turn: `get` *throws* a
  // typed `INTERNAL` on a row that no longer matches `AgentDefinitionSchema`
  // (a hand-edited prompt, a restored backup from an older schema), and this
  // call sits on the per-turn path of every task that names an agent — so an
  // unguarded read made one corrupt row fail every turn of every one of
  // those tasks, forever, with no way for the task to make progress. Losing
  // the persona is the same degradation a definition removed mid-task already
  // takes, and `tavi agents list` names the unreadable row for repair.
  const resolvedAgent = await (async (): Promise<AgentDefinition | undefined> => {
    if (options.agentDefinitions === undefined || current.invocation.agentDefinitionId === undefined) return undefined;
    try {
      return await options.agentDefinitions.get(current.invocation.workspaceId, current.invocation.agentDefinitionId);
    } catch {
      return undefined;
    }
  })();
  const agentDefinition = resolvedAgent?.enabled === true ? resolvedAgent : undefined;
  // The task's own selected base, read from its durable snapshot — deliberately
  // *outside* the persona's catch-and-degrade above. A corrupt persona row
  // costs a task its persona; a corrupt or missing prompt snapshot costs it the
  // turn, because running under a base the task never selected is worse than
  // failing. `runInvocation` already ensured and bound this before the
  // graph started, so the read here is a deliberate per-call re-read
  // rather than a cache.
  // Read as this turn's admission pinned it, like the instructions below.
  const turn = executionLeaseOf(config)?.admissionId;
  const promptSnapshot = await selectedPromptSnapshot(current.runId, current.invocation.workspaceId, turn);
  const executionPolicy = await facts.policy();
  // The chat's instructions as this turn's admission pinned them. Like
  // the snapshot, and unlike the persona, an unreadable revision costs the
  // turn: running without instructions the reader set is a silent change in
  // behaviour, which a failed turn is not.
  const chatInstructions = turn === undefined ? undefined : await options.chatInstructions?.forAdmission(turn);
  // Base instructions first, then the persona, then the chat's own: an agent
  // definition adds to the runtime's operating instructions rather than
  // replacing them, so a persona cannot accidentally drop the tool discipline
  // every task needs, and a chat's instructions refine both.
  const instructionPrefix = composeAgentPrompt(promptSnapshot, agentDefinition, chatInstructions);
  return { promptSnapshot, executionPolicy, instructionPrefix };
}

/** What `resolveInstructions` resolved. */
export type Instructions = Awaited<ReturnType<typeof resolveInstructions>>;
