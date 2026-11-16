import { describe, expect, it } from "vitest";

import {
  CACHE_GATE_PROFILE_RECORDS,
  CACHE_GATE_RECORDS,
  CACHE_GATE_TOPICS,
  cacheGateRememberArgs,
  cacheGateReport,
  cacheGateTurn,
  cacheGateVerdict,
  formatCacheGateReport,
  type PromptCacheEntry,
} from "../evals/memory/cache-gate.js";

/** The cache-stable layout's gate driver: its turns, its records and its verdict. */

const entry = (compared: number, same: number, cacheRead = 100): PromptCacheEntry => ({
  kind: "home",
  firstStep: { calls: compared + 1, inputTokens: 1000, cacheReadTokens: 0, share: 0 },
  laterSteps: { calls: 10, inputTokens: 1000, cacheReadTokens: cacheRead, share: cacheRead / 1000 },
  callsWithoutCacheUsage: 0,
  firstStepPrefix: {
    turnsCompared: compared,
    sameAsPreviousTurn: same,
    share: compared === 0 ? null : Math.round((same / compared) * 1000) / 1000,
  },
});

describe("the cache gate driver", () => {
  it("cycles its topics, numbering each message, and remembers about fifteen facts and preferences", () => {
    expect(cacheGateTurn(0)).toBe(`(1) ${CACHE_GATE_TOPICS[0]}`);
    expect(cacheGateTurn(CACHE_GATE_TOPICS.length)).toBe(`(${CACHE_GATE_TOPICS.length + 1}) ${CACHE_GATE_TOPICS[0]}`);
    expect(new Set(Array.from({ length: 200 }, (_, index) => cacheGateTurn(index))).size).toBe(200);
    expect(CACHE_GATE_RECORDS.length).toBe(15);
    expect(new Set(CACHE_GATE_RECORDS.map((record) => record.kind))).toEqual(new Set(["fact", "preference"]));
    expect(cacheGateRememberArgs({ kind: "preference", body: "Celsius.", key: "units.temperature", value: "celsius" })).toEqual([
      "memory",
      "remember",
      "--scope",
      "personal",
      "--kind",
      "preference",
      "--body",
      "Celsius.",
      "--key",
      "units.temperature",
      "--value",
      "celsius",
      "--reason",
      "cache gate seed",
    ]);
    expect(CACHE_GATE_PROFILE_RECORDS.length).toBeGreaterThanOrEqual(2);
    expect(cacheGateRememberArgs({ kind: "fact", body: "Lives in Lisbon.", topicKey: "me.home_city" })).toContain("--topic");
    expect(cacheGateRememberArgs({ kind: "lesson", body: "When editing code, show a diff first." })).toContain("lesson");
  });

  it("builds the cache-stable layout under 50% over 200 turns, drops it at 50% or more, and says too few turns or no caching is not enough", () => {
    expect(cacheGateVerdict(entry(220, 20)).verdict).toBe("build");
    expect(cacheGateVerdict(entry(220, 150)).verdict).toBe("drop");
    // 200 turns give 199 comparisons with the turn before: enough.
    expect(cacheGateVerdict(entry(199, 2)).verdict).toBe("build");
    expect(cacheGateVerdict(entry(198, 2)).verdict).toBe("insufficient");
    expect(cacheGateVerdict(entry(4, 0))).toMatchObject({ verdict: "insufficient", reason: expect.stringContaining("at least 200") });
    expect(cacheGateVerdict(entry(220, 20, 0))).toMatchObject({
      verdict: "insufficient",
      reason: expect.stringContaining("no cache reads"),
    });
    expect(cacheGateVerdict(undefined).verdict).toBe("insufficient");
  });

  it("reports Home's measurement from doctor, the turns' tokens and the ledger's spend", () => {
    const doctor = {
      chatMeasurement: {
        promptCacheByChatKind: [entry(4, 0), { ...entry(3, 3), kind: "run" }],
        usageByChatKind: [{ kind: "home", turns: 5, inputTokensPerTurn: 30_000 }],
      },
    };
    const spend = { calls: 18, inputTokens: 274_538, outputTokens: 6_671, cacheReadTokens: 143_767, estimatedUsd: 0, unpriced: 18 };
    const report = cacheGateReport({
      startedAt: "2026-10-12T12:00:00.000Z",
      reader: { connection: "openrouter", model: "m" },
      requested: 5,
      doctor,
      spend,
      runs: [
        { status: "completed", finalText: "a", toolCalls: 0, tokens: 100, cacheReadTokens: 10 },
        { status: "failed", finalText: "", toolCalls: 0 },
      ],
    });
    expect(report).toMatchObject({
      turns: { requested: 5, completed: 1, failed: 1 },
      prefixEqualityShare: 0,
      cacheReadShare: { firstStep: 0, laterSteps: 0.1 },
      turnTokens: { total: 100, cacheRead: 10 },
      homeUsage: { turns: 5 },
      gate: { verdict: "insufficient" },
    });
    expect(formatCacheGateReport(report)).toContain("step-1 prefix equality: 0% over 4 turns compared");
    // A doctor from before per-site accounting: no chat sites and no churn.
    expect(report.chatSites).toEqual([]);
    expect(report).not.toHaveProperty("prefixChurn");
  });

  it("reports a chat turn's own sites and the prefix churn from doctor's per-site measurement", () => {
    const report = cacheGateReport({
      startedAt: "2026-10-12T12:00:00.000Z",
      reader: { connection: "openrouter", model: "m" },
      requested: 1,
      doctor: {
        chatMeasurement: {
          promptCacheByChatKind: [entry(4, 0)],
          usageBySite: [
            { site: "chat-step1", calls: 4, inputTokens: 4000, cacheReadTokens: 1000, cacheWriteTokens: 3000 },
            { site: "compaction", calls: 1, inputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
            { site: "chat-stepN", calls: 6, inputTokens: 9000, cacheReadTokens: 8000, cacheWriteTokens: 900 },
          ],
          prefixChurn: { windowDays: 30, modelSwitches: 1, chatsWithModelSwitch: 1, folds: 2, chatsWithFold: 1 },
        },
      },
      spend: { calls: 11, inputTokens: 13_500, outputTokens: 100, cacheReadTokens: 9000, estimatedUsd: 0, unpriced: 11 },
      runs: [{ status: "completed", finalText: "a", toolCalls: 0, tokens: 100, cacheReadTokens: 10 }],
    });
    expect(report.chatSites.map((site) => site["site"])).toEqual(["chat-step1", "chat-stepN"]);
    expect(report.prefixChurn).toMatchObject({ modelSwitches: 1, folds: 2 });
    const text = formatCacheGateReport(report);
    expect(text).toContain("chat-step1: 4 calls, 4000 input tokens, 1000 cache reads, 3000 cache writes");
    expect(text).toContain("prefix churn: 1 model switches, 2 folds");
  });
});
