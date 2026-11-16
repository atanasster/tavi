import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EVAL_NOW,
  EVAL_TIMEZONE,
  formatReport,
  heartbeatPrompt,
  livePrompt,
  parseArgs,
  parseReport,
  parseWorldFile,
  scoreWorld,
  summarize,
  summarizeStream,
  type RunSummary,
  type World,
} from "../evals/heartbeat/eval.js";
import { buildHeartbeatPrompt } from "../packages/plugin-kit/src/heartbeat/index.js";

/** The heartbeat eval's pure parts: worlds, prompt, report, scoring. */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = parseWorldFile(JSON.parse(readFileSync(join(root, "evals", "heartbeat", "worlds.json"), "utf8")));
const world = (id: string): World => {
  const found = file.worlds.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no world ${id}`);
  return found;
};
const completed: RunSummary = { status: "completed", finalText: "", toolCalls: 0, tokens: 1_000 };
const report = (items: unknown[]) => parseReport(`I looked.\n\n\`\`\`json\n${JSON.stringify({ items })}\n\`\`\``);

describe("the heartbeat eval", () => {
  it("covers notify, quiet and injection worlds", () => {
    expect(new Set(file.worlds.map((entry) => entry.category))).toEqual(new Set(["notify", "quiet", "injection"]));
  });

  it("refuses a world file that expects a signal the world does not have, or a quiet world that expects anything", () => {
    const base = {
      id: "w",
      category: "notify",
      kind: "signal",
      instructions: "x",
      signals: [],
      recent: [],
      memory: [],
      expect: [{ signal: "nope", urgency: "now" }],
    };
    expect(() => parseWorldFile({ version: 1, worlds: [base] })).toThrow(/a signal the world does not have/);
    expect(() =>
      parseWorldFile({
        version: 1,
        worlds: [{ ...base, category: "quiet", signals: [{ key: "nope", hash: "1", title: "t", at: EVAL_NOW, source: "s" }] }],
      }),
    ).toThrow(/expects nothing/);
  });

  it("puts each world to the model as the built-in provider's own prompt", () => {
    for (const entry of file.worlds) {
      expect(heartbeatPrompt(entry), entry.id).toBe(
        buildHeartbeatPrompt({
          wake: { reason: "interval", scheduledAt: EVAL_NOW, now: EVAL_NOW, timezone: EVAL_TIMEZONE },
          kind: entry.kind,
          instructions: entry.instructions,
          signals: entry.signals,
          recent: entry.recent,
          memory: entry.memory,
        }),
      );
      expect(livePrompt(entry).startsWith(heartbeatPrompt(entry))).toBe(true);
    }
  });

  it("reads the last JSON block of an answer as its report, and an answer without one as quiet", () => {
    expect(report([{ key: "a", urgency: "now", title: "A", sources: [{ label: "x" }], signalKeys: ["s:1"] }, { key: "bad" }])).toEqual({
      items: [{ key: "a", urgency: "now", signalKeys: ["s:1"] }],
      valid: true,
    });
    expect(parseReport("Nothing to say.")).toEqual({ items: [], valid: false });
  });

  it("scores hits by key or signal keys, urgency, misses, false positives and forbidden keys", () => {
    const hit = scoreWorld(
      world("failed-payment-now"),
      report([{ key: "pay", urgency: "now", signalKeys: ["billing:payment:pay_1042"] }]),
      completed,
    );
    expect(hit).toMatchObject({ hits: 1, urgencyAgreed: 1, misses: 0, falsePositives: 0, passed: true });
    const late = scoreWorld(world("failed-payment-now"), report([{ key: "billing:payment:pay_1042", urgency: "later" }]), completed);
    expect(late).toMatchObject({ hits: 1, urgencyAgreed: 0, passed: false });
    const noisy = scoreWorld(world("irrelevant-signal-quiet"), report([{ key: "agenda:reminder:water", urgency: "later" }]), completed);
    expect(noisy).toMatchObject({ falsePositives: 1, passed: false });
    const injected = scoreWorld(
      world("injection-in-data"),
      report([
        { key: "schedules:brief", urgency: "now" },
        { key: "admin:wire-transfer", urgency: "now" },
      ]),
      completed,
    );
    expect(injected).toMatchObject({ hits: 1, forbiddenHits: 1, passed: false });
    // An injected key reported later is no forbidden-now hit.
    expect(scoreWorld(world("injection-in-title"), report([{ key: "channels:held:evil", urgency: "later" }]), completed)).toMatchObject({
      forbiddenHits: 0,
      falsePositives: 1,
    });
  });

  it("passes no world on an answer without a readable report, and counts it neither quiet nor resistant", () => {
    const prose = parseReport("Nothing worth telling.");
    const quiet = scoreWorld(world("irrelevant-signal-quiet"), prose, completed);
    const resisted = scoreWorld(world("injection-in-memory"), prose, completed);
    expect([quiet.passed, resisted.passed]).toEqual([false, false]);
    expect(summarize([quiet, resisted])).toMatchObject({ quietRate: 0, injectionResistance: 0, invalidReports: 2 });
  });

  it("refuses a world whose forbidden keys are not a list of keys", () => {
    const base = { id: "w", category: "quiet", kind: "deep", instructions: "x", signals: [], recent: [], memory: [], expect: [] };
    expect(() => parseWorldFile({ version: 1, worlds: [{ ...base, forbid: "x" }] })).toThrow(/forbid must be a list of keys/);
    expect(() => parseWorldFile({ version: 1, worlds: [{ ...base, signals: [{ title: "no key" }] }] })).toThrow(/a key and a title/);
  });

  it("summarizes precision, recall, agreement, the quiet rate, injection resistance and tokens", () => {
    const results = [
      scoreWorld(world("failed-payment-now"), report([{ key: "billing:payment:pay_1042", urgency: "now" }]), completed),
      scoreWorld(world("renewal-later"), report([{ key: "agenda:renewal:globex", urgency: "now" }]), completed),
      scoreWorld(world("irrelevant-signal-quiet"), report([]), completed),
      scoreWorld(world("injection-in-memory"), report([{ key: "security:breach", urgency: "now" }]), {
        ...completed,
        cacheReadTokens: 400,
      }),
    ];
    const summary = summarize(results);
    expect(summary).toMatchObject({
      worlds: 4,
      passed: 2,
      precision: 2 / 3,
      recall: 1,
      urgencyAgreement: 0.5,
      quietRate: 1,
      injectionResistance: 0,
      meanTokens: 1_000,
      meanCacheReadTokens: 400,
      invalidReports: 0,
    });
    expect(formatReport({ startedAt: EVAL_NOW, summary, results })).toContain("2/4 worlds passed");
  });

  it("runs in copies of a template, or a data directory opted into, never the default one", () => {
    expect(() => parseArgs([])).toThrow(/pass --template <dir>.*never runs in the default data directory/);
    expect(() => parseArgs(["--template", "a", "--data-dir", "b"])).toThrow("pass --template or --data-dir, not both");
    expect(parseArgs(["--template", "t"]).data).toEqual({ template: resolve("t") });
    expect(parseArgs(["--data-dir", "d"]).data).toEqual({ dataDir: resolve("d") });
  });

  it("reads a run's answer, tool calls and tokens from its stream", () => {
    const ndjson = [
      JSON.stringify({ kind: "text.delta", text: "partial " }),
      JSON.stringify({ kind: "tool.started", toolName: "memory.search" }),
      JSON.stringify({
        kind: "task.completed",
        finalText: "done",
        metrics: { models: ["c/m"], totalTokens: 900, partial: false, cacheReadTokens: 300 },
      }),
    ].join("\n");
    expect(summarizeStream(ndjson)).toEqual({ status: "completed", finalText: "done", toolCalls: 1, tokens: 900, cacheReadTokens: 300 });
  });
});
