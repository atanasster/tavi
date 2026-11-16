import { describe, expect, it } from "vitest";
import { decisionBody, parseDecision, parseUsage } from "../src/typesafe.js";

const candidates = [
  { id: "main", revision: "1", description: "Complex work" },
  { id: "fast", revision: "1", description: "Simple work" },
];

describe("TypeSafe direct protocol", () => {
  it("sends native questions with explicit candidate references", () => {
    const request = JSON.parse(decisionBody("jev-1.13.0", "tools", "read a file", candidates));
    expect(Object.keys(request)).toEqual(["model", "state", "questions"]);
    expect(request.questions.q0).toMatchObject({ type: "noul", instructions: expect.stringContaining('candidate "main"') });
    expect(JSON.parse(decisionBody("jev-1.13.0", "model", "edit", candidates)).questions.selection).toMatchObject({
      type: "choice",
      criteria: { main: "Complex work", fast: "Simple work" },
    });
  });
  it("does not use distribution confidence as chosen option probability", () => {
    const response = {
      answers: { selection: { type: "choice", choice: "fast", probabilities: { main: 0.4, fast: 0.6 }, confidence: 0.99 } },
    };
    expect(parseDecision(response, "model", candidates, 0.9)).toEqual({
      selectedIds: [],
      probabilities: { main: 0.4, fast: 0.6 },
      confidence: 0.99,
    });
  });
  it.each([
    { choice: "unknown", probabilities: { main: 0, fast: 1 } },
    { choice: "fast", probabilities: { main: 0.5, fast: 0.8 } },
    { choice: "fast", probabilities: { main: 0, fast: 1, hidden: 0 } },
    { choice: "fast", probabilities: { main: 0, fast: NaN } },
    { choice: "fast", probabilities: { main: -1, fast: 2 } },
  ])("rejects invalid choice distributions %#", (answer) => {
    expect(() => parseDecision({ answers: { selection: { type: "choice", ...answer } } }, "model", candidates, 0.9)).toThrow("invalid");
  });
  it("rejects partial answers and does not invent Noul confidence", () => {
    expect(() => parseDecision({ answers: { q0: { type: "noul", noul: 0.9 } } }, "tools", candidates, 0.5)).toThrow("invalid");
    expect(
      parseDecision({ answers: { q0: { type: "noul", noul: 0.95 }, q1: { type: "noul", noul: 0.1 } } }, "tools", candidates, 0.5),
    ).toEqual({ selectedIds: ["main"], probabilities: { main: 0.95, fast: 0.1 } });
  });
  it("retains valid usage without assuming missing output is zero", () => {
    expect(parseUsage({ usage: null })).toEqual({});
    expect(parseUsage({ usage: { input_tokens: 10 } })).toEqual({ inputTokens: 10 });
    expect(parseUsage({ usage: { input_tokens: Infinity, output_tokens: -1 } })).toEqual({});
  });
});
