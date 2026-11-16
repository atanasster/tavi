import { evaluateGate, type ToolRule } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { capture } from "../support/attached-owner.js";

/**
 * A memory or skill proposal is filed without an approval card: every workspace is seeded once with a revocable
 * allow rule for `memory.propose` and `skills.propose`, so the proposal's own card is the review. Revoked, the
 * rule is never put back, and the call asks again.
 */

const directories = temporaryDirectories({ prefix: "tavi-proposal-rules-" });
afterEach(() => directories.cleanup());

/** The workspace's rules after the runtime started over `directory` (its start is what seeds them). */
const rulesIn = async (directory: string): Promise<readonly ToolRule[]> => {
  expect(await main(["doctor", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
  const captured = capture();
  expect(await main(["permissions", "list", "--format", "json", "--data-dir", directory], { io: captured.io })).toBe(EXIT.ok);
  return (JSON.parse(captured.stdout()) as { readonly rules: readonly ToolRule[] }).rules;
};

const decisionOf = (toolId: string, rules: readonly ToolRule[]) =>
  evaluateGate({
    toolId,
    effect: "mutating",
    sink: "persist",
    rules,
    sessionGrants: [],
    gatedEffects: new Set(["mutating", "external"]),
    tainted: false,
  } as never).decision;

describe("the proposal tools' seeded allow rules", () => {
  it("let memory.propose and skills.propose run unasked, and asking comes back once a rule is revoked", async () => {
    const directory = directories.create();
    const seeded = await rulesIn(directory);
    expect(seeded.filter((rule) => rule.ruleId.endsWith("-propose")).map((rule) => [rule.ruleId, rule.toolPattern, rule.decision])).toEqual(
      [
        ["seeded-memory-propose", "memory.propose", "allow"],
        ["seeded-skills-propose", "skills.propose", "allow"],
      ],
    );
    expect(decisionOf("memory.propose", seeded)).toBe("allow");
    expect(decisionOf("skills.propose", seeded)).toBe("allow");
    // Another proposal tool is not covered: a heartbeat change still asks.
    expect(decisionOf("heartbeat.propose", seeded)).toBe("ask");

    expect(await main(["permissions", "rm", "seeded-memory-propose", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    // Removed once, it is never seeded again: the next start leaves it out, and memory.propose asks.
    const after = await rulesIn(directory);
    expect(after.map((rule) => rule.ruleId)).not.toContain("seeded-memory-propose");
    expect(after.map((rule) => rule.ruleId)).toContain("seeded-skills-propose");
    expect(decisionOf("memory.propose", after)).toBe("ask");
    expect(decisionOf("skills.propose", after)).toBe("allow");
  }, 60_000);
});
