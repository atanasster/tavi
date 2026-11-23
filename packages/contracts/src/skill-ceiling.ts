import { z } from "zod";

import { canvasCoreEnglish, type CanvasCoreT } from "./locales/core-canvas.js";
import { ToolIdSchema } from "./tools.js";

/**
 * A skill's `allowed-tools` as a ceiling, never a grant (Decision R6).
 *
 * A skill loaded this turn (`skills.read`) that declares the field narrows
 * what the turn's calls may do without a person: a call outside the union
 * of the declared lists of the skills in scope asks in an attended chat, and
 * is refused in a run nobody attends. A tool on a list is decided exactly as
 * before — the ceiling pre-approves nothing — and a skill in scope that
 * declares nothing lifts the ceiling. A skill written for Claude Code's grant
 * semantics so fails safe: its tools just follow normal approval.
 *
 * Pure. Imports only zod and the `core` words, so `tool-policy.ts` can read it.
 */

/** Agent Skills (Claude Code) tool names, and the Tavi tool each stands for. `Bash(…)` is any form of `Bash`. */
export const AGENT_SKILL_TOOL_IDS: Readonly<Record<string, string>> = {
  Read: "fs.read",
  Write: "fs.write",
  Edit: "fs.edit",
  MultiEdit: "fs.edit",
  Grep: "fs.grep",
  Glob: "fs.glob",
  LS: "fs.list",
  Bash: "sandbox.run",
  WebSearch: "web_search",
  WebFetch: "web_fetch",
};

/**
 * The tools no ceiling holds: the skill system's own reads (loading another
 * skill or a reference, finding one), finding a tool, and the turn's reply —
 * a ceiling narrows what the turn does, never whether it can answer — and the turn's own control: asking the person,
 * and waiting on and reading back the workers it started.
 */
export const SKILL_CEILING_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  "skills.read",
  "skills.search",
  "tools.search",
  "messaging.send",
  "operator.ask_user",
  "agents.wait",
  "agents.read_payload",
]);

/**
 * The Tavi tool a declared name stands for: an Agent Skills name (`Read`,
 * `Bash(git:*)` → `sandbox.run`), or a Tavi id written as is. `undefined`:
 * declared but not enforceable here.
 */
export function taviToolForSkillName(name: string): string | undefined {
  const trimmed = name.trim();
  // `Bash(git:*)`: the argument pattern narrows Claude Code's grant; here the ceiling is the whole tool.
  const bare = /^([A-Za-z]+)\(.*\)$/.exec(trimmed)?.[1] ?? trimmed;
  return Object.hasOwn(AGENT_SKILL_TOOL_IDS, bare)
    ? AGENT_SKILL_TOOL_IDS[bare]
    : ToolIdSchema.safeParse(trimmed).success
      ? trimmed
      : undefined;
}

/** One skill loaded this turn: its id, and its declared `allowed-tools` (absent: it declares none). */
export interface SkillInScope {
  readonly skillId: string;
  readonly allowedTools?: readonly string[] | undefined;
}

/** The bounds of a ceiling a verdict carries for its card. */
export const SKILL_CEILING_LIMITS = { skills: 16, names: 64, nameChars: 200 } as const;

const ceilingName = z.string().min(1).max(SKILL_CEILING_LIMITS.nameChars);

/**
 * The ceiling a call was decided under, as its card names it: the skills
 * whose lists make it, the names they declared, and those no Tavi tool
 * answers to ("declared but not enforceable here").
 */
export const SkillCeilingSchema = z.strictObject({
  skillIds: z.array(z.string().min(1).max(128)).min(1).max(SKILL_CEILING_LIMITS.skills),
  declared: z.array(ceilingName).max(SKILL_CEILING_LIMITS.names),
  unenforceable: z.array(ceilingName).max(SKILL_CEILING_LIMITS.names),
});
export type SkillCeilingSummary = z.infer<typeof SkillCeilingSchema>;

/** A ceiling in force: its card summary, and the Tavi tools it lets through to normal approval. */
export interface SkillCeiling extends SkillCeilingSummary {
  readonly tools: ReadonlySet<string>;
}

/**
 * The ceiling the skills in scope set: the union of their declared lists,
 * mapped to Tavi tools. `undefined` — no ceiling — when no skill is in scope
 * or any one of them declares nothing.
 */
export function skillCeilingOf(skills: readonly SkillInScope[]): SkillCeiling | undefined {
  if (skills.length === 0 || skills.some((skill) => skill.allowedTools === undefined)) return undefined;
  const skillIds = [...new Set(skills.map((skill) => skill.skillId))];
  const declared = [...new Set(skills.flatMap((skill) => skill.allowedTools ?? []).map((name) => name.trim()))].filter(
    (name) => name !== "",
  );
  const tools = new Set<string>();
  const unenforceable: string[] = [];
  for (const name of declared) {
    const tool = taviToolForSkillName(name);
    if (tool === undefined) unenforceable.push(name);
    else tools.add(tool);
  }
  // A package's names reach the card: control and bidi characters are dropped, as from its other words.
  const clipped = (names: readonly string[]) =>
    names
      .slice(0, SKILL_CEILING_LIMITS.names)
      .map((name) => name.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, SKILL_CEILING_LIMITS.nameChars) || "?");
  return {
    skillIds: skillIds.slice(0, SKILL_CEILING_LIMITS.skills),
    declared: clipped(declared),
    unenforceable: clipped(unenforceable),
    tools,
  };
}

/** Whether a call of `toolId` is inside `ceiling` (or no ceiling is in force): it then goes on to the gate's other steps. */
export function skillCeilingAllows(ceiling: SkillCeiling | undefined, toolId: string): boolean {
  return ceiling === undefined || SKILL_CEILING_EXEMPT_TOOLS.has(toolId) || ceiling.tools.has(toolId);
}

/** A ceiling's skills, named: `skill “pdf-forms”`, `skills “a”, “b”`. */
function skillsNamed(ceiling: SkillCeilingSummary): string {
  const names = ceiling.skillIds.map((id) => `“${id}”`).join(", ");
  return `${ceiling.skillIds.length === 1 ? "skill" : "skills"} ${names}`;
}

/** The declared list, as a card or a refusal shows it. */
function declaredText(ceiling: SkillCeilingSummary): string {
  return ceiling.declared.length === 0 ? "no tools" : ceiling.declared.join(", ");
}

/** "Why am I asked?" for a call outside the ceiling, naming the skill and what it declared. */
export function skillCeilingWords(ceiling: SkillCeilingSummary, t: CanvasCoreT = canvasCoreEnglish): string {
  const why = t("skill.ceiling.why", {
    count: ceiling.skillIds.length,
    skills: ceiling.skillIds.map((id) => t("skill.ceiling.name", { id })).join(", "),
    declared: ceiling.declared.length === 0 ? t("skill.ceiling.noTools") : ceiling.declared.join(", "),
  });
  return ceiling.unenforceable.length === 0
    ? why
    : `${why} ${t("skill.ceiling.unenforceable", { names: ceiling.unenforceable.join(", ") })}`;
}

/** What the model is told when a run nobody attends refuses a call outside the ceiling: English, as the model reads it. */
export function skillCeilingRefusal(ceiling: SkillCeilingSummary | undefined): string {
  return ceiling === undefined
    ? "This call is outside the allowed-tools of a skill loaded this turn."
    : `This call is outside the allowed-tools ceiling of ${skillsNamed(ceiling)} (${declaredText(ceiling)}).`;
}

/**
 * How a new version's `allowed-tools` widens its parent's: the names it adds,
 * or that it drops the field (no ceiling at all). Absent: it widens nothing —
 * the same list, a narrower one, or a first list where none was declared
 * (no ceiling before, so a list only narrows).
 */
export function skillToolsEscalation(
  parent: readonly string[] | undefined,
  next: readonly string[] | undefined,
): { readonly added: readonly string[]; readonly removedCeiling: boolean } | undefined {
  if (parent === undefined) return undefined;
  if (next === undefined) return { added: [], removedCeiling: true };
  const before = new Set(parent.map((name) => name.trim()));
  const added = [...new Set(next.map((name) => name.trim()))].filter((name) => name !== "" && !before.has(name));
  return added.length === 0 ? undefined : { added, removedCeiling: false };
}

/** The escalation line a review shows, or `undefined` when the version widens nothing. */
export function skillToolsEscalationText(
  parent: readonly string[] | undefined,
  next: readonly string[] | undefined,
  t: CanvasCoreT = canvasCoreEnglish,
): string | undefined {
  const escalation = skillToolsEscalation(parent, next);
  if (escalation === undefined) return undefined;
  return escalation.removedCeiling
    ? t("skill.escalation.dropped", { tools: parent?.join(", ") ?? "" })
    : t("skill.escalation.widened", { tools: escalation.added.join(", ") });
}
