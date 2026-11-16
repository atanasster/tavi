import { isPersonMessage, skillCeilingOf, type SkillCeiling, type SkillInScope, type WorkflowMessage } from "@tavi/contracts";

/** The tool whose results put a skill in scope. */
const SKILLS_READ_TOOL = "skills.read";

/**
 * The skills in scope for the next call: each `skills.read` that answered
 * since the latest person message — the end of the last turn — with the
 * `allowed-tools` its answer carries. A later load (a reference file, the
 * same skill again) puts it in scope again. A failed read loads nothing. A
 * result that names no skill (archived, or rewritten past reading) is no
 * load either, so it sets no ceiling: the ceiling only ever narrows, and
 * nothing in a conversation can widen a call by it.
 */
export function skillsInScope(conversation: readonly WorkflowMessage[]): readonly SkillInScope[] {
  const skills: SkillInScope[] = [];
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (message === undefined) continue;
    if (isPersonMessage(message)) break;
    if (message.role !== "tool" || message.toolName !== SKILLS_READ_TOOL || message.isError === true) continue;
    const output = message.output as { readonly skillId?: unknown; readonly allowedTools?: unknown } | null | undefined;
    if (typeof output !== "object" || output === null || typeof output.skillId !== "string" || output.skillId === "") continue;
    const allowedTools = Array.isArray(output.allowedTools)
      ? output.allowedTools.filter((name): name is string => typeof name === "string")
      : undefined;
    skills.push({ skillId: output.skillId, ...(allowedTools === undefined ? {} : { allowedTools }) });
  }
  return skills.reverse();
}

/** The `allowed-tools` ceiling in force for a turn's next call (`skillCeilingOf` of `skillsInScope`). */
export function turnSkillCeiling(conversation: readonly WorkflowMessage[]): SkillCeiling | undefined {
  return skillCeilingOf(skillsInScope(conversation));
}
