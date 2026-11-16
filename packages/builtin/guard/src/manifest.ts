import { MODS_ABI, type ModsDeclaration } from "@tavi/contracts";

/**
 * `tavi.guard`: a first-party mod, off until the
 * operator enables it, that asks before a `sandbox.run` command that deletes
 * or overwrites — and says what it would touch — or refuses it where nobody
 * can answer. It overlaps the approval rules on purpose: a rule can ask, but
 * cannot explain.
 */
export const GUARD_PLUGIN_ID = "tavi.guard";

export const GUARD_MODS: ModsDeclaration = {
  abi: MODS_ABI,
  hooks: [
    {
      event: "tool.check",
      match: { tools: ["sandbox.run"] },
      disclosure: "Asks before a shell command that deletes or overwrites files, and says what it would touch.",
    },
  ],
  commands: [],
};
