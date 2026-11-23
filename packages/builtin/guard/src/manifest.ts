import { MODS_ABI, type ModsDeclaration } from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";

/**
 * `tavi.guard`: a first-party mod, off until the
 * operator enables it, that asks before a `sandbox.run` command that deletes
 * or overwrites — and says what it would touch — or refuses it where nobody
 * can answer. It overlaps the approval rules on purpose: a rule can ask, but
 * cannot explain.
 */
export const GUARD_PLUGIN_ID = "tavi.guard";

/** Its hooks, with the disclosure a person reads in `t`'s words: English by default. */
export function guardMods(t: CoreT = coreEnglish): ModsDeclaration {
  return {
    abi: MODS_ABI,
    hooks: [{ event: "tool.check", match: { tools: ["sandbox.run"] }, disclosure: t("plugins.guard.disclosure") }],
    commands: [],
  };
}

export const GUARD_MODS: ModsDeclaration = guardMods();
