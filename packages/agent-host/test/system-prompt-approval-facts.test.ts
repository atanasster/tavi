import { describe, expect, it } from "vitest";

import { renderRuntimeFacts } from "../src/prompts/system-prompt.js";

/** The finality of a refusal and the ask_user options instruction. */
describe("runtime facts about approvals", () => {
  const unattended = { mode: "unattended", humanQuestionsAllowed: false, workerWaitsAllowed: true } as const;
  const attended = { mode: "attended", humanQuestionsAllowed: true, workerWaitsAllowed: true } as const;
  const base = {
    stepIndex: 1,
    maxSteps: 4,
    toolCallsRemaining: 3,
    askUserOffered: true,
    waitsOffered: true,
    outputLimitBytes: 1024,
    reviewEnabled: false,
  } as const;

  it("says a refusal is final whenever tools are offered, even with no approval categories", () => {
    // A routine runs with none, and still meets hard refusals and deny rules.
    const routine = renderRuntimeFacts({ ...base, policy: unattended, approvalRequiredFor: [], toolsOffered: true });
    expect(routine).toContain("is final for that call: never try to evade it by another route");
    expect(routine).not.toContain("ask for a decision by default");
    const noTools = renderRuntimeFacts({ ...base, policy: unattended, approvalRequiredFor: [], toolsOffered: false });
    expect(noTools).not.toContain("is final for that call");
  });

  it("names the default categories and that rules can decide any tool", () => {
    const facts = renderRuntimeFacts({ ...base, policy: attended, approvalRequiredFor: ["mutating", "external"], toolsOffered: true });
    expect(facts).toContain(
      "ask for a decision by default (mutating, external), and the operator's rules can allow, ask about or refuse a call of any tool",
    );
    expect(facts.match(/is final for that call/g)).toHaveLength(1);
  });

  it("tells the model to offer options when the answer is a choice", () => {
    const facts = renderRuntimeFacts({ ...base, policy: attended, approvalRequiredFor: [], toolsOffered: true });
    expect(facts).toContain("When the answer is a choice, pass 2-4 `options` (with `multiSelect` when several may apply).");
    expect(facts).toContain(
      "Say why you ask in `context`; name the option you suggest in `recommended`, and the one to go with if nobody answers in `defaultOption`.",
    );
  });
});
