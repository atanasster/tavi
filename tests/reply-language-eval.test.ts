import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { replyLanguageFact } from "../packages/agent-host/src/prompts/system-prompt.js";
import {
  expectedReply,
  formatSummary,
  parseArgs,
  parseCasesFile,
  readLanguage,
  scoreRun,
  summarize,
  type LanguageCase,
} from "../evals/reply-language/eval.js";

/**
 * The live reply-language eval's pure parts (evals/reply-language): its cases
 * hold to decision 8's reply-language fact, the language is read from an
 * answer's letters with no model, and runs are scored and summed. Offline:
 * the runs themselves spend model tokens and are run by hand.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = parseCasesFile(JSON.parse(readFileSync(join(root, "evals", "reply-language", "cases.json"), "utf8")));
const completed = (finalText: string) => ({ status: "completed" as const, finalText, toolCalls: 0 });
const entry = (id: string): LanguageCase => {
  const found = file.cases.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no case ${id}`);
  return found;
};

describe("the reply-language eval", () => {
  it("expects what the agent's reply-language fact asks for", () => {
    // The fact the expectations are read from: a Bulgarian workspace, unless the person writes in another language.
    expect(replyLanguageFact("bg")).toBe("- The person's language is Bulgarian: reply in Bulgarian unless they write in another language.");
    // An English workspace has no fact: replies are as before languages.
    expect(replyLanguageFact("en")).toBeUndefined();
    expect(replyLanguageFact(undefined)).toBeUndefined();
    expect(expectedReply("bg", "bg")).toBe("bg");
    expect(expectedReply("bg", "en")).toBe("en");
    expect(expectedReply("bg", "neutral")).toBe("bg");
    expect(expectedReply("en", "bg")).toBe("bg");
    expect(expectedReply("en", "en")).toBe("en");
    expect(expectedReply("en", "neutral")).toBe("en");
  });

  it("covers each workspace with each kind of prompt", () => {
    const pairs = new Set(file.cases.map((entry) => `${entry.workspace}/${entry.promptLanguage}`));
    expect([...pairs].sort()).toEqual(["bg/bg", "bg/en", "bg/neutral", "en/bg", "en/en", "en/neutral"]);
    expect(entry("bg-workspace-en-sleep")).toMatchObject({ workspace: "bg", promptLanguage: "en", expect: "en" });
    expect(entry("en-workspace-bg-sleep")).toMatchObject({ workspace: "en", promptLanguage: "bg", expect: "bg" });
  });

  it("refuses a case that drifts from the fact or whose prompt is in another language than it says", () => {
    const one = (changes: Partial<LanguageCase>) => ({
      version: 1,
      cases: [{ id: "a", workspace: "bg", prompt: "Какво е времето днес в София?", promptLanguage: "bg", expect: "bg", ...changes }],
    });
    expect(() => parseCasesFile(one({}))).not.toThrow();
    expect(() => parseCasesFile(one({ prompt: "What's the weather in Sofia today?", promptLanguage: "en" }))).toThrow(
      /expects bg, but decision 8 asks for en/,
    );
    expect(() => parseCasesFile(one({ promptLanguage: "en", expect: "en" }))).toThrow(/reads as bg, not en/);
    expect(() => parseCasesFile(one({ prompt: "🙂", promptLanguage: "bg" }))).toThrow(/reads as unknown, not bg/);
    // Neutral means no letters at all: a short worded prompt is written in a language, so decision 8 answers in it.
    expect(() => parseCasesFile(one({ prompt: "😴❓", promptLanguage: "neutral", expect: "bg" }))).not.toThrow();
    expect(() => parseCasesFile(one({ prompt: "Thanks!", promptLanguage: "neutral", expect: "bg" }))).toThrow(
      /reads as words, not neutral/,
    );
    expect(() => parseCasesFile(one({ prompt: "Как си?", promptLanguage: "neutral", expect: "bg" }))).toThrow(
      /reads as words, not neutral/,
    );
    expect(() => parseCasesFile(one({ workspace: "de" as never }))).toThrow(/workspace language/);
    expect(() => parseCasesFile({ version: 1, cases: [one({}).cases[0], one({}).cases[0]] })).toThrow(/duplicate/);
  });

  it("reads a reply's language from its letters, code and addresses aside", () => {
    expect(readLanguage("Ето три съвета: лягай по едно и също време, без екрани час преди сън.").language).toBe("bg");
    expect(readLanguage("Here are three tips: go to bed at the same time, no screens an hour before.").language).toBe("en");
    // Names, units and a code block in Latin do not make a Bulgarian answer English.
    expect(
      readLanguage("Пусни `sleep 8h` в Terminal или виж https://example.com/sleep-guide — там е обяснено подробно за Tavi.").language,
    ).toBe("bg");
    expect(readLanguage("Ето командата:\n```bash\necho hello world from the shell\n```\nПусни я и готово.").language).toBe("bg");
    // Half and half is neither.
    expect(readLanguage("Sleep well tonight. Спи спокойно довечера.").language).toBe("mixed");
    // Too few letters say nothing.
    expect(readLanguage("😴 OK").language).toBe("unknown");
    expect(readLanguage("👍").language).toBe("unknown");
  });

  it("passes a run that completed in the expected language, and says why another failed", () => {
    const bg = entry("bg-workspace-neutral");
    expect(scoreRun(bg, completed("Изглеждаш уморен. Искаш ли няколко съвета за по-добър сън?"))).toMatchObject({ passed: true });
    expect(scoreRun(bg, completed("You look tired. Want a few tips for better sleep?"))).toMatchObject({
      passed: false,
      problem: "answered in en, expected bg",
    });
    expect(scoreRun(bg, completed("😴"))).toMatchObject({ passed: false, problem: "answered in too few words to tell, expected bg" });
    expect(scoreRun(bg, { status: "failed", finalText: "", toolCalls: 0 })).toMatchObject({ passed: false, problem: "the run failed" });
    expect(scoreRun(bg, { ...completed("Спи."), timedOut: true })).toMatchObject({ passed: false, problem: "timed out" });
    const en = entry("bg-workspace-en-sleep");
    expect(scoreRun(en, completed("1. Keep a schedule. 2. Cut caffeine after noon. 3. Keep the room cool."))).toMatchObject({
      passed: true,
    });
  });

  it("sums runs as a pass rate and pass^k", () => {
    const bg = entry("bg-workspace-bg-sleep");
    const en = entry("en-workspace-en-sleep");
    const runs = [
      scoreRun(bg, completed("Лягай и ставай по едно и също време всеки ден."), 1),
      scoreRun(bg, completed("Go to bed and get up at the same time every day."), 2),
      scoreRun(en, completed("Go to bed and get up at the same time every day."), 1),
    ];
    const summary = summarize(runs);
    expect(summary).toEqual({ cases: 2, runs: 3, passRate: 2 / 3, passAllK: 0.5, failing: ["bg-workspace-bg-sleep"] });
    expect(formatSummary(summary, runs, "x").split("\n")[0]).toBe(
      "reply-language eval (x): 3 runs over 2 cases, pass rate 67%, pass^k 50%",
    );
  });

  it("never runs in the default data directory", async () => {
    await expect(parseArgs([])).rejects.toThrow(/--template/);
    await expect(parseArgs(["--template", "/a", "--data-dir", "/b"])).rejects.toThrow(/not both/);
    expect(await parseArgs(["--data-dir", "/nowhere", "--repeat", "1", "--case", "bg-workspace-neutral"])).toMatchObject({
      // Resolved as a path: `C:\\nowhere` on Windows.
      data: { dataDir: resolve("/nowhere") },
      repeat: 1,
      only: ["bg-workspace-neutral"],
    });
    await expect(parseArgs(["--data-dir", "/nowhere", "--repeat", "0"])).rejects.toThrow(/--repeat/);
  });
});
