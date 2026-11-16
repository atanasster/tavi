import { describe, expect, it } from "vitest";

import {
  GATE_REASON_WORDS,
  evaluateGate,
  gateObservationOf,
  requestTainted,
  skillCeilingAllows,
  skillCeilingOf,
  skillToolsEscalation,
  skillToolsEscalationText,
  taviToolForSkillName,
  unattendedDenial,
  whyAskedText,
  type GateEvaluationInput,
  type ToolRule,
} from "../src/index.js";

/** A skill's `allowed-tools` as a ceiling, never a grant (E10, Decision R6). */

describe("the Agent Skills name mapping", () => {
  it("maps each Agent Skills tool name to the Tavi tool it stands for", () => {
    expect(taviToolForSkillName("Read")).toBe("fs.read");
    expect(taviToolForSkillName("Write")).toBe("fs.write");
    expect(taviToolForSkillName("Edit")).toBe("fs.edit");
    expect(taviToolForSkillName("Grep")).toBe("fs.grep");
    expect(taviToolForSkillName("Glob")).toBe("fs.glob");
    expect(taviToolForSkillName("WebSearch")).toBe("web_search");
    expect(taviToolForSkillName("WebFetch")).toBe("web_fetch");
    expect(taviToolForSkillName("Bash")).toBe("sandbox.run");
  });

  it("reads Bash(…) as the whole sandbox tool, and a Tavi id as written", () => {
    expect(taviToolForSkillName("Bash(git:*)")).toBe("sandbox.run");
    expect(taviToolForSkillName(" Bash(npm test) ")).toBe("sandbox.run");
    expect(taviToolForSkillName("fs.read")).toBe("fs.read");
    // Any Tavi tool id, not only those an Agent Skills name maps to.
    expect(taviToolForSkillName("memory.forget")).toBe("memory.forget");
    expect(taviToolForSkillName("reports.generate")).toBe("reports.generate");
  });

  it("knows no other name: declared but not enforceable here", () => {
    expect(taviToolForSkillName("Frobnicate")).toBeUndefined();
    expect(taviToolForSkillName("read")).toBeUndefined();
    expect(taviToolForSkillName("toString")).toBeUndefined();
    expect(taviToolForSkillName("Memory.Forget")).toBeUndefined();
  });
});

describe("the ceiling of the skills in scope", () => {
  it("is the union of the declared lists, mapped, with the unknown names apart", () => {
    const ceiling = skillCeilingOf([
      { skillId: "a", allowedTools: ["Read", "Grep"] },
      { skillId: "b", allowedTools: ["Read", "Bash(git:*)", "Frobnicate"] },
    ]);
    expect(ceiling).toMatchObject({
      skillIds: ["a", "b"],
      declared: ["Read", "Grep", "Bash(git:*)", "Frobnicate"],
      unenforceable: ["Frobnicate"],
    });
    expect([...(ceiling?.tools ?? [])].sort()).toEqual(["fs.grep", "fs.read", "sandbox.run"]);
    expect(skillCeilingAllows(ceiling, "fs.read")).toBe(true);
    expect(skillCeilingAllows(ceiling, "sandbox.run")).toBe(true);
    expect(skillCeilingAllows(ceiling, "fs.write")).toBe(false);
  });

  it("is lifted by any skill in scope that declares nothing, and absent with none in scope", () => {
    expect(skillCeilingOf([{ skillId: "a", allowedTools: ["Read"] }, { skillId: "b" }])).toBeUndefined();
    expect(skillCeilingOf([])).toBeUndefined();
    expect(skillCeilingAllows(undefined, "fs.write")).toBe(true);
  });

  it("holds an empty list to nothing but the exempt tools", () => {
    const ceiling = skillCeilingOf([{ skillId: "a", allowedTools: [] }]);
    expect(skillCeilingAllows(ceiling, "fs.read")).toBe(false);
    // Loading a skill, finding a tool and the turn's reply are never held.
    // Nor are asking the person and collecting the turn's workers.
    for (const tool of [
      "skills.read",
      "skills.search",
      "tools.search",
      "messaging.send",
      "operator.ask_user",
      "agents.wait",
      "agents.read_payload",
    ])
      expect(skillCeilingAllows(ceiling, tool)).toBe(true);
  });

  it("drops control and bidi characters from the names a card shows", () => {
    const ceiling = skillCeilingOf([{ skillId: "a", allowedTools: ["Frob\u202Enic\u0007ate"] }]);
    expect(ceiling?.unenforceable).toEqual(["Frobnicate"]);
  });
});

const ALLOW_WRITE: ToolRule = {
  ruleId: "allow-write",
  workspaceId: "default",
  toolPattern: "fs.write",
  decision: "allow",
  source: "operator",
  createdBy: "operator",
  createdVia: "cli",
  createdAt: "2026-09-27T00:00:00.000Z",
};

const write: GateEvaluationInput = {
  toolId: "fs.write",
  effect: "mutating",
  rules: [ALLOW_WRITE],
  sessionGrants: [],
  gatedEffects: new Set(["mutating", "external"]),
  tainted: false,
};

describe("the ceiling at evaluateGate", () => {
  const ceiling = skillCeilingOf([{ skillId: "pdf", allowedTools: ["Read", "Frobnicate"] }]);

  it("asks a call outside it once, whatever an allow rule says, with the ceiling on the verdict", () => {
    expect(evaluateGate(write).decision).toBe("allow");
    const verdict = evaluateGate({ ...write, skillCeiling: ceiling });
    expect(verdict).toMatchObject({
      decision: "ask",
      gateReason: "outside-skill-ceiling",
      allowedScopes: ["once"],
      skillCeiling: { skillIds: ["pdf"], declared: ["Read", "Frobnicate"], unenforceable: ["Frobnicate"] },
    });
    expect(verdict.risk.tainted).toBe(false);
  });

  it("lets a call inside it be decided as with none: nothing is pre-approved", () => {
    const read: GateEvaluationInput = { ...write, toolId: "fs.read", effect: "read-only", rules: [] };
    expect(evaluateGate({ ...read, skillCeiling: ceiling })).toEqual(evaluateGate(read));
    // A listed write still asks as it would: the ceiling is no grant.
    const listed = skillCeilingOf([{ skillId: "pdf", allowedTools: ["Write"] }]);
    expect(evaluateGate({ ...write, rules: [], skillCeiling: listed })).toEqual(evaluateGate({ ...write, rules: [] }));
  });

  it("never relaxes a deny: a hard deny and a deny rule still refuse", () => {
    const deny: ToolRule = { ...ALLOW_WRITE, ruleId: "deny-write", decision: "deny" };
    expect(evaluateGate({ ...write, rules: [deny], skillCeiling: ceiling })).toMatchObject({ decision: "deny", ruleId: "deny-write" });
    const hard = evaluateGate({
      ...write,
      skillCeiling: ceiling,
      assessment: { display: { title: "Write" }, subjects: [], risk: "medium", reasons: [], hardDeny: "no" },
    });
    expect(hard).toMatchObject({ decision: "deny", ruleId: "hard-deny" });
  });

  it("is no taint: never a gate observation, nor a tainted request", () => {
    const verdict = evaluateGate({ ...write, skillCeiling: ceiling });
    expect(gateObservationOf(verdict, { taskId: "t1", callId: "c1", effect: "mutating", at: "2026-01-01T00:00:00.000Z" })).toBeUndefined();
    expect(
      requestTainted({ provenance: { gateReason: "outside-skill-ceiling", sources: [], principals: [], refs: [], argOrigins: [] } }),
    ).toBe(false);
  });

  it("names the skill on the card and in an unattended refusal", () => {
    const verdict = evaluateGate({ ...write, skillCeiling: ceiling });
    const why = whyAskedText(verdict.gateReason, false, verdict.skillCeiling);
    expect(why).toContain("skill “pdf”");
    expect(why).toContain("allowed-tools: Read, Frobnicate");
    expect(why).toContain("Declared but not enforceable here: Frobnicate.");
    expect(whyAskedText("outside-skill-ceiling", false)).toBe(GATE_REASON_WORDS["outside-skill-ceiling"]);
    expect(unattendedDenial(verdict)).toContain("outside the allowed-tools ceiling of skill “pdf” (Read, Frobnicate)");
    expect(unattendedDenial({ gateReason: "outside-skill-ceiling", provenance: { skillCeiling: verdict.skillCeiling } })).toContain(
      "skill “pdf”",
    );
  });
});

describe("a widened list in review", () => {
  it("is an escalation when a version adds names or drops the field", () => {
    expect(skillToolsEscalation(["Read"], ["Read", "Write"])).toEqual({ added: ["Write"], removedCeiling: false });
    expect(skillToolsEscalation(["Read"], undefined)).toEqual({ added: [], removedCeiling: true });
    expect(skillToolsEscalationText(["Read"], ["Read", "Bash(git:*)"])).toBe(
      "Escalation: this version widens allowed-tools, adding Bash(git:*)",
    );
    expect(skillToolsEscalationText(["Read"], undefined)).toContain("drops allowed-tools (Read)");
  });

  it("is none for the same list, a narrower one, or a first list where none was declared", () => {
    expect(skillToolsEscalation(["Read", "Write"], ["Write", "Read"])).toBeUndefined();
    expect(skillToolsEscalation(["Read", "Write"], ["Read"])).toBeUndefined();
    expect(skillToolsEscalation(undefined, ["Read"])).toBeUndefined();
    expect(skillToolsEscalation(undefined, undefined)).toBeUndefined();
  });
});
