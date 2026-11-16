import { protectedValueClass } from "@tavi/contracts";

import type { SkillIndex } from "./skills.js";

/**
 * `tailor_check`: what to look at again in a cover letter or
 * CV text the agent drafted with the person, before it is used. Advisory.
 */

/** A run of this many words copied from the posting is flagged. */
export const COPIED_RUN_WORDS = 40;
const ZERO_WIDTH_OR_BIDI = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;
/** A sentence that answers an AI-use question for the person (theirs to answer). */
const AI_USE_ANSWER =
  /\b(i (did not|didn't|do not|don't) use (ai|chatgpt|generative ai|any ai)|(written|completed|prepared) (entirely )?(by me|myself|personally)|without (the use of |using )?(ai|artificial intelligence|chatgpt))\b/i;

export interface TailorWarning {
  readonly kind: "copied" | "posting-text-gone" | "hidden-characters" | "skill-not-in-profile" | "ai-attestation";
  readonly detail: string;
}

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** The longest run of words `draft` shares with `source`, at least `COPIED_RUN_WORDS` long, or `undefined`. */
function copiedRun(draft: readonly string[], source: readonly string[]): string | undefined {
  if (draft.length < COPIED_RUN_WORDS || source.length < COPIED_RUN_WORDS) return undefined;
  const windows = new Set<string>();
  for (let index = 0; index + COPIED_RUN_WORDS <= source.length; index += 1)
    windows.add(source.slice(index, index + COPIED_RUN_WORDS).join(" "));
  for (let index = 0; index + COPIED_RUN_WORDS <= draft.length; index += 1) {
    const window = draft.slice(index, index + COPIED_RUN_WORDS).join(" ");
    if (windows.has(window)) return window;
  }
  return undefined;
}

export function tailorCheck(input: {
  readonly text: string;
  readonly postingText: string;
  readonly profileSkills: readonly string[];
  readonly skills?: SkillIndex;
}): TailorWarning[] {
  const warnings: TailorWarning[] = [];
  // Retention blanks a posting's text: with nothing to compare, say so rather than find nothing.
  if (input.postingText.trim() === "")
    warnings.push({
      kind: "posting-text-gone",
      detail: "the posting's text is no longer kept, so copying from it was not checked: compare by eye, or open the posting again",
    });
  const copied = copiedRun(wordsOf(input.text), wordsOf(input.postingText));
  if (copied !== undefined)
    warnings.push({
      kind: "copied",
      detail: `${String(COPIED_RUN_WORDS)} or more words copied from the posting: "${copied.split(" ").slice(0, 12).join(" ")}…"`,
    });
  if (ZERO_WIDTH_OR_BIDI.test(input.text))
    warnings.push({ kind: "hidden-characters", detail: "zero-width or text-direction characters a reader does not see" });
  if (input.skills !== undefined) {
    const own = new Set(input.profileSkills.map((skill) => skill.toLowerCase()));
    for (const skill of input.skills.extract(input.text)) {
      if (!own.has(skill.label.toLowerCase()))
        warnings.push({ kind: "skill-not-in-profile", detail: `${skill.label} is claimed but not in the person's skills` });
    }
  }
  if (AI_USE_ANSWER.test(input.text) || protectedValueClass(input.text) !== undefined)
    warnings.push({
      kind: "ai-attestation",
      detail: "it answers an attestation (the use of AI, or that the person wrote it): only the person answers that",
    });
  return warnings;
}
