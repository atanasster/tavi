import { foldText } from "./text.js";

/**
 * Coordinated amplification: different authors posting the same
 * text within 10 minutes form a component; a component of 5 or more authors
 * is excluded, as "possible coordinated amplification (N accounts, identical
 * text within 10 min)". Fewer is not evidence of anything.
 */
export const COORDINATION_WINDOW_MS = 10 * 60_000;
export const COORDINATION_MIN_AUTHORS = 5;

export interface CoordinationInput {
  readonly index: number;
  readonly text: string;
  readonly authorHash?: string | undefined;
  readonly at?: string | undefined;
}

/** The components found: the indexes of their items, and how many authors each holds. */
export function coordinatedGroups(
  items: readonly CoordinationInput[],
): { readonly members: readonly number[]; readonly authors: number }[] {
  const byText = new Map<string, CoordinationInput[]>();
  for (const item of items) {
    if (item.authorHash === undefined || item.at === undefined || !Number.isFinite(Date.parse(item.at))) continue;
    const key = foldText(item.text);
    if (key.length < 20) continue;
    byText.set(key, [...(byText.get(key) ?? []), item]);
  }
  const groups: { members: number[]; authors: number }[] = [];
  for (const same of byText.values()) {
    const sorted = [...same].sort((a, b) => Date.parse(a.at ?? "") - Date.parse(b.at ?? ""));
    // A run of posts each within the window of the one before: one burst.
    let burst: CoordinationInput[] = [];
    const close = (): void => {
      const authors = new Set(burst.map((item) => item.authorHash)).size;
      if (authors >= COORDINATION_MIN_AUTHORS) groups.push({ members: burst.map((item) => item.index), authors });
      burst = [];
    };
    for (const item of sorted) {
      const last = burst.at(-1);
      if (last !== undefined && Date.parse(item.at ?? "") - Date.parse(last.at ?? "") > COORDINATION_WINDOW_MS) close();
      burst.push(item);
    }
    close();
  }
  return groups;
}
