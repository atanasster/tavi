import { describe, expect, it } from "vitest";

import {
  AskUserInputSchema,
  askUserChoicesOf,
  askUserTimeoutMs,
  askUserTimeoutOutcome,
  boundAskUserDeadline,
  matchChoiceAnswer,
  type AskUserChoices,
} from "../src/index.js";

const single: AskUserChoices = {
  options: [{ label: "Acme" }, { label: "Globex" }, { label: "Initech" }],
  multiSelect: false,
  allowOther: true,
};

describe("askUserChoicesOf", () => {
  it("applies the defaults, and is absent for a free-text question", () => {
    expect(askUserChoicesOf({ question: "q", options: [{ label: "a" }, { label: "b" }] })).toEqual({
      options: [{ label: "a" }, { label: "b" }],
      multiSelect: false,
      allowOther: true,
    });
    expect(askUserChoicesOf({ question: "q" })).toBeUndefined();
  });
});

describe("matchChoiceAnswer", () => {
  it("picks an option by number or by label, case-insensitively", () => {
    expect(matchChoiceAnswer("2", single)).toEqual({ answers: ["Globex"] });
    expect(matchChoiceAnswer("  acme ", single)).toEqual({ answers: ["Acme"] });
  });

  it("reads several numbers or labels for a multi-select", () => {
    expect(matchChoiceAnswer("1, 3", { ...single, multiSelect: true })).toEqual({ answers: ["Acme", "Initech"] });
    expect(matchChoiceAnswer("globex acme", { ...single, multiSelect: true })).toEqual({ answers: ["Globex", "Acme"] });
  });

  it("keeps anything else as `other` where allowed, and refuses it where not", () => {
    expect(matchChoiceAnswer("neither, use Hooli", single)).toEqual({ answers: [], other: "neither, use Hooli" });
    expect(matchChoiceAnswer("Hooli", { ...single, allowOther: false })).toEqual({
      refusal: "Reply with one of: 1. Acme, 2. Globex, 3. Initech.",
    });
    expect(matchChoiceAnswer("1 2", { ...single, allowOther: false })).toEqual({ refusal: "Pick one option." });
    expect(matchChoiceAnswer("7", { ...single, allowOther: false })).toMatchObject({
      refusal: expect.stringContaining("Reply with one of"),
    });
  });
});

describe("several picks with labels that contain spaces", () => {
  const spaced: AskUserChoices = {
    options: [{ label: "Use staging" }, { label: "Use prod" }, { label: "Skip" }],
    multiSelect: true,
    allowOther: false,
  };

  it("reads comma-separated labels whole, as the canvas sends them", () => {
    expect(matchChoiceAnswer("Use staging, Use prod", spaced)).toEqual({ answers: ["Use staging", "Use prod"] });
    expect(matchChoiceAnswer("1 3", spaced)).toEqual({ answers: ["Use staging", "Skip"] });
    expect(matchChoiceAnswer("Use staging Use prod", spaced)).toMatchObject({ refusal: expect.any(String) });
  });
});

describe("askUserTimeoutMs", () => {
  it("gives a terminal or IPC run 30 minutes and everything else a day", () => {
    expect(askUserTimeoutMs("cli")).toBe(30 * 60 * 1000);
    expect(askUserTimeoutMs("ipc")).toBe(30 * 60 * 1000);
    expect(askUserTimeoutMs("web")).toBe(30 * 60 * 1000);
    for (const origin of ["messaging", "schedule", "agent", null, undefined]) expect(askUserTimeoutMs(origin)).toBe(24 * 60 * 60 * 1000);
  });
});

describe("boundAskUserDeadline", () => {
  const now = "2026-10-02T12:00:00.000Z";
  it("keeps a deadline between a minute and a week from now", () => {
    expect(boundAskUserDeadline("2026-10-02T13:00:00.000Z", now)).toBe("2026-10-02T13:00:00.000Z");
  });
  it("moves a past or too-soon deadline to a minute from now", () => {
    expect(boundAskUserDeadline("2020-01-01T00:00:00.000Z", now)).toBe("2026-10-02T12:01:00.000Z");
    expect(boundAskUserDeadline("2026-10-02T12:00:10.000Z", now)).toBe("2026-10-02T12:01:00.000Z");
  });
  it("holds a far deadline to a week", () => {
    expect(boundAskUserDeadline("9999-12-31T23:59:59.000Z", now)).toBe("2026-10-09T12:00:00.000Z");
  });
});

describe("an ask_user question's recommendation and default", () => {
  const options = [{ label: "Ship it" }, { label: "Wait" }];
  it("keeps both on the choices, and refuses a number that names no option", () => {
    expect(askUserChoicesOf(AskUserInputSchema.parse({ question: "Ship?", options, recommended: 1, defaultOption: 2 }))).toMatchObject({
      recommended: 1,
      defaultOption: 2,
    });
    expect(AskUserInputSchema.safeParse({ question: "Ship?", options, defaultOption: 3 }).success).toBe(false);
    expect(AskUserInputSchema.safeParse({ question: "Ship?", recommended: 1 }).success).toBe(false);
  });
  it("answers a question that times out with its default, and says so", () => {
    expect(askUserTimeoutOutcome({ options, multiSelect: false, allowOther: true, defaultOption: 2 })).toEqual({
      kind: "wait-timeout",
      answers: ["Wait"],
      replyText: "No answer came by the deadline; going with the default: Wait",
    });
    expect(askUserTimeoutOutcome({ options, multiSelect: false, allowOther: true })).toEqual({ kind: "wait-timeout" });
    expect(askUserTimeoutOutcome(undefined)).toEqual({ kind: "wait-timeout" });
  });
});
