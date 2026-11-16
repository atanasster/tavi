/**
 * How the active skills are listed in a chat's context and found by
 * `skills.search`: by name and a short description, the body loaded with
 * `skills.read` when one applies.
 *
 * Up to `SKILL_LISTING_MAX` skills are listed in `skillId` order, so the
 * listing is the same bytes turn after turn (a provider's prefix cache, the
 * context block's once-shown ids). Past it, the ones the person used lately
 * and whose words best match the turn's query are listed, best first, and the
 * rest are counted for `skills.search`.
 */
import type { SkillUsage } from "@tavi/contracts";

import { retrievalKeywordsFrom } from "./retrieval-query.js";

/** The most skills a context lists; more are found with `skills.search`. */
export const SKILL_LISTING_MAX = 25;
/** The most characters of a skill's description a listing shows; `skills.read` has the whole skill. */
export const SKILL_DESCRIPTION_MAX_CHARS = 160;

/** How fast a use stops counting: a skill last used this many days ago weighs half as much as one used today. */
const SKILL_USE_HALF_LIFE_DAYS = 14;

/** A skill's kept uses as ranking reads them (`SkillRepositoryPort.listUsage`). */
export type SkillUseRecord = Pick<SkillUsage, "skillId" | "uses" | "lastUsedAt">;

/** A skill as a listing or a search sees it. */
export interface ListedSkill {
  readonly skillId: string;
  readonly name: string;
  readonly description?: string;
}

/** A description cut to `SKILL_DESCRIPTION_MAX_CHARS`, at a word where it can be, with an ellipsis. */
export function clippedSkillDescription(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  if (text.length <= SKILL_DESCRIPTION_MAX_CHARS) return text;
  const cut = text.slice(0, SKILL_DESCRIPTION_MAX_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > SKILL_DESCRIPTION_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** How many of `keywords` a skill's id, name or description holds. */
export function skillMatchScore(skill: ListedSkill, keywords: readonly string[]): number {
  const haystack = `${skill.skillId} ${skill.name} ${skill.description ?? ""}`.toLowerCase();
  return keywords.filter((keyword) => haystack.includes(keyword.toLowerCase())).length;
}

/**
 * How recently a skill was used, from 0 (never, or long ago) to 1 (today),
 * halving every `SKILL_USE_HALF_LIFE_DAYS`: one use today weighs as one
 * keyword of the turn's query matched.
 */
function skillRecencyScore(use: SkillUseRecord | undefined, now: number): number {
  if (use === undefined || use.uses <= 0) return 0;
  const days = Math.max(0, now - Date.parse(use.lastUsedAt)) / 86_400_000;
  return Number.isFinite(days) ? 0.5 ** (days / SKILL_USE_HALF_LIFE_DAYS) : 0;
}

/**
 * `skills` best first: keywords of `query` matched plus how recently each was
 * used (`skillRecencyScore`, when `usage` is given), then the more used, then
 * by `skillId`. With no usage it is the order a search answers in.
 */
export function rankSkills<Skill extends ListedSkill>(
  skills: readonly Skill[],
  query: string,
  usage: readonly SkillUseRecord[] = [],
  now: number = Date.now(),
): Skill[] {
  const keywords = query.trim() === "" ? [] : retrievalKeywordsFrom(query, { bigrams: true });
  const used = new Map(usage.map((use) => [use.skillId, use]));
  return skills
    .map((skill) => ({
      skill,
      score: skillMatchScore(skill, keywords) + skillRecencyScore(used.get(skill.skillId), now),
      uses: used.get(skill.skillId)?.uses ?? 0,
    }))
    .sort((a, b) => b.score - a.score || b.uses - a.uses || compareIds(a.skill.skillId, b.skill.skillId))
    .map((entry) => entry.skill);
}

/**
 * The skills a context lists, in order, and how many are left for
 * `skills.search`: all of them by `skillId` when they fit the cap — usage is
 * not read then, so the listing stays the same bytes however the skills are
 * used — else the cap's worth ranked by recent use (`usage`, read only past
 * the cap) and `query`, best first, so a short budget cuts the weakest (past
 * the cap the set depends on the turn anyway).
 */
export async function skillListing<Skill extends ListedSkill>(
  skills: readonly Skill[],
  query: string | undefined,
  usage?: () => Promise<readonly SkillUseRecord[]>,
  now: number = Date.now(),
): Promise<{ readonly listed: Skill[]; readonly omitted: number }> {
  const byId = [...skills].sort((a, b) => compareIds(a.skillId, b.skillId));
  if (byId.length <= SKILL_LISTING_MAX) return { listed: byId, omitted: 0 };
  // A failed usage read ranks by the query alone: the listing never fails a turn.
  const uses = usage === undefined ? [] : await usage().catch(() => []);
  const chosen = rankSkills(byId, query ?? "", uses, now).slice(0, SKILL_LISTING_MAX);
  return { listed: chosen, omitted: byId.length - SKILL_LISTING_MAX };
}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
