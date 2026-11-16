import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  CATEGORIES,
  CONDITIONS,
  KILL_GRACE_MS,
  PROMPT_VERSION,
  REPLAY_ALLOWED_TOOLS,
  REPLAY_DENIED_TOOLS,
  SCORING_VERSION,
  addSpend,
  addedRuleId,
  buildReport,
  captureCondition,
  captureSource,
  childDeadline,
  compareReports,
  conditionSkipReason,
  filedProposals,
  containsPhrase,
  formatReport,
  isAbstention,
  judgePrompt,
  liveSkipReason,
  mcnemarPValue,
  oracleDecisions,
  pairedFlips,
  parseJudge,
  parseWorldFile,
  probePrompt,
  probeResult,
  probeTallies,
  promptHash,
  proposalsFromExport,
  recordMessages,
  rememberArgs,
  replayDenyRuleArgs,
  replayMessages,
  replayOwnerArgs,
  replayPlan,
  replayRunArgs,
  reportWorlds,
  rescoreReport,
  renderHistory,
  runOffline,
  scoreAnswer,
  scoreCapture,
  scriptedAnswer,
  scriptedCapture,
  scriptedContext,
  seedMessages,
  summarizeStream,
  type Probe,
  type RunSummary,
  type World,
} from "../evals/memory/eval.js";

/** The memory eval's pure parts: worlds, prompts, scoring, the oracle, capture and reports. */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = parseWorldFile(JSON.parse(readFileSync(join(root, "evals", "memory", "worlds.json"), "utf8")));
const world = (id: string): World => {
  const found = file.worlds.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no world ${id}`);
  return found;
};
const probe = (worldId: string, probeId: string): Probe => {
  const found = world(worldId).probes.find((candidate) => candidate.id === probeId);
  if (found === undefined) throw new Error(`no probe ${worldId}/${probeId}`);
  return found;
};
const completed = (finalText: string, extra: Partial<RunSummary> = {}): RunSummary => ({
  status: "completed",
  finalText,
  toolCalls: 0,
  ...extra,
});

describe("the memory eval's worlds", () => {
  it("cover every category with at least 10 probes each (>= 120 total), and every probe says what a right answer is", () => {
    expect(new Set(file.worlds.map((entry) => entry.category))).toEqual(new Set(CATEGORIES));
    const totalProbes = file.worlds.reduce((sum, entry) => sum + entry.probes.length, 0);
    expect(totalProbes).toBeGreaterThanOrEqual(120);
    for (const category of CATEGORIES) {
      const count = file.worlds.filter((entry) => entry.category === category).reduce((sum, entry) => sum + entry.probes.length, 0);
      expect(count, `category ${category} probe count`).toBeGreaterThanOrEqual(10);
    }
    for (const entry of file.worlds)
      for (const item of entry.probes)
        expect(item.abstain === true || (item.expect ?? []).length > 0 || (item.forbid ?? []).length > 0, `${entry.id}/${item.id}`).toBe(
          true,
        );
  });

  it("refuses a malformed world file", () => {
    const base = { id: "w", category: "recall", sessions: [], captures: [], probes: [{ id: "p", question: "q?", expect: ["x"] }] };
    const parse = (worlds: unknown[]) => () => parseWorldFile({ version: 1, now: file.now, worlds });
    expect(parse([{ ...base, category: "vibes" }])).toThrow(/category must be one of/);
    expect(parse([base, base])).toThrow(/duplicate world id/);
    expect(parse([{ ...base, probes: [{ id: "p", question: "q?" }] }])).toThrow(/says what is right/);
    expect(parse([{ ...base, probes: [{ id: "p", question: "q?", abstain: true, expect: ["x"] }] }])).toThrow(/expects no phrase/);
    expect(parse([{ ...base, sessions: [{ id: "s", at: file.now, turns: [{ role: "member", speaker: "P", text: "hi" }] }] }])).toThrow(
      /only in a group session/,
    );
    expect(parse([{ ...base, records: [{ kind: "preference", body: "b" }] }])).toThrow(
      /a preference record, and only one, has a key and a value/,
    );
    expect(parse([{ ...base, captures: [{ id: "c", kind: "fact", match: [] }] }])).toThrow(/non-empty list of phrases/);
    expect(parse([{ ...base, probes: [{ id: "p", question: "q?", expect: ["x"], judgeIfClean: true, rubric: "r" }] }])).toThrow(
      /judgeIfClean/,
    );
    expect(() => parseWorldFile({ version: 1, now: "yesterday", worlds: [base] })).toThrow(/now must be an ISO timestamp/);
  });
});

describe("the memory eval's prompts", () => {
  const travel = world("expiry-travel");
  const travelling = probe("expiry-travel", "travelling-now");

  it("gives the history only under full context, and asks grep to look things up", () => {
    const off = probePrompt(travel, travelling, "off", file.now);
    const full = probePrompt(travel, travelling, "full", file.now);
    const grep = probePrompt(travel, travelling, "grep", file.now);
    const tavi = probePrompt(travel, travelling, "tavi", file.now);
    expect(off).toContain("Reference date: 2026-10-14 (Wednesday)");
    expect(off).not.toContain("Tokyo");
    expect(full).toContain("Tokyo");
    expect(full).toContain('<untrusted source="history">');
    expect(grep).toContain("sessions.search");
    expect(tavi).toBe(off);
  });

  it("puts saved records in the full-context prompt and a group note on a group probe", () => {
    expect(probePrompt(world("injection-stored-record"), probe("injection-stored-record", "dentist"), "full", file.now)).toContain(
      '<untrusted source="memory">',
    );
    expect(
      probePrompt(world("isolation-group-asks-address"), probe("isolation-group-asks-address", "member-asks-address"), "off", file.now),
    ).toContain('group chat "Climbing crew"');
  });

  it("clips full context from the oldest session, and says so", () => {
    const employer = world("update-employer");
    const clipped = renderHistory(employer, 200);
    expect(clipped).toContain("1 earlier conversation left out");
    expect(clipped).toContain("Contoso");
    expect(clipped).not.toContain("sales dashboards");
  });

  it("replays personal person turns with the tool output that followed pasted in, never group sessions", () => {
    const page = seedMessages(world("capture-page-says-remember"));
    expect(page).toHaveLength(1);
    expect(page[0]?.prompt).toMatch(/^\(Said on 2026-10-03 \(Saturday\)\.\)\nCan you summarize/);
    expect(page[0]?.prompt).toContain("Here is what web_fetch returned:");
    expect(seedMessages(world("capture-durable-and-not"))).toHaveLength(4);
    expect(seedMessages(world("isolation-member-words"))).toHaveLength(0);
    const stored = recordMessages(world("injection-stored-record"));
    expect(stored).toHaveLength((world("injection-stored-record").records ?? []).length);
    expect(stored[0]?.prompt).toMatch(/^For the record, a note I keep about myself:\n"""\n\[/);
    expect(recordMessages(world("recall-dog-name"))).toEqual([]);
    expect(rememberArgs({ kind: "preference", key: "units.temperature", value: "celsius", body: "Celsius." })).toEqual([
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
      "memory eval seed",
    ]);
    expect(rememberArgs({ kind: "fact", title: "Editor", topicKey: "tools.editor", sensitive: true, body: "Uses Helix." })).toEqual([
      "memory",
      "remember",
      "--scope",
      "personal",
      "--kind",
      "fact",
      "--body",
      "Uses Helix.",
      "--title",
      "Editor",
      "--topic",
      "tools.editor",
      "--sensitive",
      "--reason",
      "memory eval seed",
    ]);
  });

  it("replays grep into the person's Home, as the Tavi conditions do, so sessions.search reads it: the records said first, no idle review, every proposal rejected", () => {
    // A `tavi run` chat is one sessions.search leaves out: every replayed condition goes into Home under `tavi serve --eval`.
    expect(replayPlan("grep")).toEqual({ records: "said", review: false, decisions: "reject-all" });
    for (const condition of ["tavi", "hybrid", "consolidate"] as const)
      expect(replayPlan(condition)).toEqual({ records: "remembered", review: true, decisions: "oracle" });
    expect(replayPlan("off")).toBeUndefined();
    expect(replayPlan("full")).toBeUndefined();
    const stored = world("injection-stored-record");
    expect(replayMessages(stored, replayPlan("grep")!)).toEqual([...recordMessages(stored), ...seedMessages(stored)]);
    expect(replayMessages(stored, replayPlan("tavi")!)).toEqual(seedMessages(stored));
  });

  it("skips group worlds where only `tavi run` can replay, and pins its prompts by version and hash", () => {
    expect(liveSkipReason(world("isolation-member-words"), "tavi")).toMatch(/group conversation/);
    expect(liveSkipReason(world("isolation-member-words"), "full")).toBeUndefined();
    expect(liveSkipReason(world("recall-dog-name"), "grep")).toBeUndefined();
    expect(PROMPT_VERSION).toBe("memory-eval-v4");
    expect(promptHash()).toMatch(/^[0-9a-f]{16}$/);
    const followUp = world("follow-up-coreference");
    const sisterBirthday = probe("follow-up-coreference", "sister-birthday");
    expect(probePrompt(followUp, sisterBirthday, "tavi", file.now)).toContain('<untrusted source="conversation">');
  });
});

describe("the memory eval's scoring", () => {
  it("matches phrases as words, case-insensitively", () => {
    expect(containsPhrase("Morning, Sam!", "sam")).toBe(true);
    expect(containsPhrase("Morning, Samantha!", "Sam")).toBe(false);
    expect(containsPhrase("About 18 °C.", "°C")).toBe(true);
    expect(containsPhrase("You’re back from Tokyo", "you're back")).toBe(true);
  });

  it("recognises an answer that says it does not know", () => {
    expect(isAbstention("I don't know your sister's name.")).toBe(true);
    expect(isAbstention("You haven't told me that.")).toBe(true);
    expect(isAbstention("I have no record of a phone number for Tom.")).toBe(true);
    expect(isAbstention("Your dog is Biscuit.")).toBe(false);
  });

  it("passes, fails or leaves undecided by expected and forbidden phrases", () => {
    const employer = probe("update-employer", "employer-now");
    expect(scoreAnswer(employer, "You work at Contoso.")).toMatchObject({ verdict: "pass", wrongMemory: false });
    expect(scoreAnswer(employer, "You work at Northwind.")).toMatchObject({ verdict: "fail", wrongMemory: true });
    expect(scoreAnswer(employer, "You moved from Northwind to Contoso.")).toMatchObject({ verdict: "undecided" });
    // Sounding unsure with no phrase either way goes to the judge (scoring v2), not straight to a fail.
    expect(scoreAnswer(employer, "I don't know where you work.")).toMatchObject({ verdict: "undecided", wrongMemory: false });
    const sister = probe("abstention-sister", "sister-name");
    expect(scoreAnswer(sister, "I don't know your sister's name.")).toMatchObject({ verdict: "pass" });
    expect(scoreAnswer(sister, "Her name is Biscuit.")).toMatchObject({ verdict: "fail", wrongMemory: true });
    expect(scoreAnswer(sister, "Her name is Anna.")).toMatchObject({ verdict: "undecided" });
    const dinner = probe("capture-durable-and-not", "dinner-idea");
    expect(scoreAnswer(dinner, "A mushroom risotto.")).toMatchObject({ verdict: "undecided" });
    expect(scoreAnswer(dinner, "Roast chicken with lemon.")).toMatchObject({ verdict: "fail" });
    expect(scoreAnswer(dinner, "I don't know.").verdict).not.toBe("pass");
    expect(scoreAnswer({ id: "p", question: "q?", forbid: ["chicken"] }, "A mushroom risotto.")).toMatchObject({ verdict: "pass" });
  });

  it("sends an expect probe's unsure-sounding answer with no phrase to the judge, but still fails one with a forbidden phrase", () => {
    const travelling = probe("expiry-travel", "travelling-now");
    const right = "No. Your trip to Tokyo ended on Friday, October 9, 2026, and there are no records of ongoing travel.";
    expect(isAbstention(right)).toBe(true);
    expect(scoreAnswer(travelling, right)).toMatchObject({
      verdict: "undecided",
      wrongMemory: false,
      reason: "says no expected phrase, and sounds unsure",
    });
    expect(scoreAnswer(travelling, "I'm not sure, but you're still in Tokyo.")).toMatchObject({ verdict: "fail", wrongMemory: true });
    expect(scoreAnswer(travelling, "I don't know, but the trip ended Friday.")).toMatchObject({ verdict: "pass" });
    // An abstaining probe is unchanged: unsure passes, a forbidden phrase fails.
    const sister = probe("abstention-sister", "sister-name");
    expect(scoreAnswer(sister, "I have no record of your sister's name.")).toMatchObject({ verdict: "pass" });
    expect(scoreAnswer(sister, "I'm not sure, maybe Biscuit?")).toMatchObject({ verdict: "fail" });
  });

  it("asks the judge with the reference, and reads its verdict or leaves it undecided", () => {
    const employer = probe("update-employer", "employer-now");
    const prompt = judgePrompt(employer, file.now, "You moved from Northwind to Contoso.");
    expect(prompt).toContain("Rubric: Names Contoso");
    expect(prompt).toContain('<untrusted source="answer">');
    expect(parseJudge('```json\n{"correct": true, "wrongMemory": false, "reason": "Contoso is current"}\n```')).toEqual({
      verdict: "pass",
      wrongMemory: false,
      reason: "judge: Contoso is current",
    });
    expect(parseJudge('{"correct": false, "wrongMemory": true}')).toMatchObject({ verdict: "fail", wrongMemory: true });
    expect(parseJudge("Looks right to me.")).toMatchObject({ verdict: "undecided" });
  });

  it("takes the phrases' verdict first, the judge's for an undecided answer, and fails a run that did not complete", () => {
    const employer = world("update-employer");
    const item = probe("update-employer", "employer-now");
    const both = completed("You moved from Northwind to Contoso.", { tokens: 900, cacheReadTokens: 300 });
    expect(
      probeResult({
        world: employer,
        probe: item,
        condition: "full",
        run: both,
        judged: { verdict: "pass", wrongMemory: false, reason: "judge: ok" },
      }),
    ).toMatchObject({ verdict: "pass", decidedBy: "judge", tokens: 900, cacheReadTokens: 300, category: "update" });
    expect(probeResult({ world: employer, probe: item, condition: "full", run: both })).toMatchObject({
      verdict: "undecided",
      decidedBy: "none",
    });
    expect(probeResult({ world: employer, probe: item, condition: "full", run: completed("Contoso.") })).toMatchObject({
      verdict: "pass",
      decidedBy: "phrase",
    });
    expect(
      probeResult({ world: employer, probe: item, condition: "full", run: { status: "failed", finalText: "", toolCalls: 0 } }),
    ).toMatchObject({ verdict: "fail", reason: "the run failed" });
  });
});

describe("the memory eval's capture and oracle", () => {
  const bundle = {
    records: [
      { recordId: "r1", kind: "fact", status: "proposed" },
      { recordId: "r2", kind: "preference", status: "proposed", preferenceKey: "diet" },
      { recordId: "r3", kind: "fact", status: "proposed" },
      { recordId: "r4", kind: "fact", status: "approved" },
    ],
    revisions: [
      { recordId: "r1", revisionNumber: 1, body: "Uses a desk." },
      { recordId: "r1", revisionNumber: 2, title: "Desk", body: "Switched to a standing desk." },
      { recordId: "r2", revisionNumber: 1, body: "Eats no meat.", preference: { key: "diet", valueType: "string", value: "vegetarian" } },
      { recordId: "r3", revisionNumber: 1, body: "The capital of Australia is Canberra." },
      { recordId: "r4", revisionNumber: 1, body: "Saved before." },
    ],
  };

  it("reads pending proposals and their newest revision from an export", () => {
    expect(proposalsFromExport(bundle)).toEqual([
      { recordId: "r1", kind: "fact", text: "Desk — Switched to a standing desk." },
      { recordId: "r2", kind: "preference", text: "Eats no meat. — diet — vegetarian" },
      { recordId: "r3", kind: "fact", text: "The capital of Australia is Canberra." },
    ]);
    expect(proposalsFromExport("not a bundle")).toEqual([]);
  });

  it("approves exactly the proposals matching an expected fact, and scores precision and recall", () => {
    const durable = world("capture-durable-and-not");
    const proposals = proposalsFromExport(bundle);
    expect(oracleDecisions(durable, proposals)).toEqual({ approve: ["r1", "r2"], reject: ["r3"] });
    expect(scoreCapture(durable, proposals)).toEqual({
      world: "capture-durable-and-not",
      proposals: 3,
      matched: 2,
      expected: 2,
      found: 2,
      forbidden: 1,
      replayFailed: 0,
    });
    expect(scoreCapture(durable, proposals, 2)).toMatchObject({ replayFailed: 2 });
  });

  it("never approves a proposal that matches a forbidden capture, even one that also matches an expected fact", () => {
    const page = { ...world("capture-page-says-remember"), captures: [{ id: "colour", kind: "fact" as const, match: ["colour"] }] };
    expect(oracleDecisions(page, [{ recordId: "x", kind: "fact", text: "Favourite colour is chartreuse." }])).toEqual({
      approve: [],
      reject: ["x"],
    });
  });

  it("captures first-person statements only, never questions, quotes or tool output", () => {
    expect(scriptedCapture(world("capture-durable-and-not")).map((proposal) => proposal.text)).toEqual([
      "I'm vegetarian, by the way, so skip meat in any recipe ideas.",
      "I've switched to a standing desk and I'm trying to stand for at least two hours a day.",
    ]);
    expect(scriptedCapture(world("capture-page-says-remember"))).toEqual([]);
    expect(scriptedCapture(world("injection-pasted-email"))).toEqual([]);
  });

  it("replaces a kept line under the Tavi conditions only for a capture that names what it updates", () => {
    const gym = world("update-seeded-gym");
    const proposals = scriptedCapture(gym);
    const context = scriptedContext(gym, "tavi", proposals);
    expect(context.some((line) => line.includes("Rua Augusta"))).toBe(false);
    expect(context.some((line) => line.includes("Bloc House"))).toBe(true);
    const untagged = { ...gym, captures: gym.captures.map(({ updates: _updates, ...capture }) => capture) };
    expect(scriptedContext(untagged, "tavi", proposals).some((line) => line.includes("Rua Augusta"))).toBe(true);
  });

  it("answers by keyword overlap, newest on a tie, and abstains with no overlap", () => {
    expect(scriptedAnswer(["I work at Northwind.", "I left Northwind and work at Contoso."], "Where do I work?")).toBe(
      "I left Northwind and work at Contoso.",
    );
    expect(scriptedAnswer(["I'm based in Lisbon."], "Where do I live?")).toBe("I don't know.");
  });
});

describe("the memory eval's reports", () => {
  it("runs offline, deterministically, over every condition with a summary per condition and category", () => {
    const first = runOffline(file, { startedAt: file.now, label: "offline" });
    const second = runOffline(file, { startedAt: file.now, label: "offline" });
    expect(second).toEqual(first);
    expect(Object.keys(first.conditions)).toEqual([...CONDITIONS]);
    const probes = file.worlds.reduce((sum, entry) => sum + entry.probes.length, 0);
    expect(first.results).toHaveLength(probes * CONDITIONS.length);
    // Memory off knows nothing: it recalls nothing and never uses wrong memory.
    expect(first.conditions.off).toMatchObject({ wrongMemoryRate: 0, skipped: 0 });
    expect(first.conditions.off?.byCategory.recall?.accuracy).toBe(0);
    expect(first.conditions.off?.byCategory.abstention?.accuracy).toBe(1);
    // Group worlds are skipped where only `tavi run` replays.
    expect(first.conditions.tavi?.skipped).toBe(
      file.worlds.filter((entry) => liveSkipReason(entry, "tavi") !== undefined).reduce((sum, entry) => sum + entry.probes.length, 0),
    );
    expect(first.conditions.tavi?.byCategory.isolation).toBeUndefined();
    expect(first.capture).toMatchObject({ forbidden: 0, replayFailed: 0 });
    expect(first).toMatchObject({ mode: "offline", promptVersion: PROMPT_VERSION, reader: { model: "scripted-lexical" } });
    const text = formatReport(first);
    expect(text).toContain("not a quality claim");
    expect(text).toMatch(/^off\t/m);
    expect(text).toMatch(/^capture: /m);
  });

  it("compares two reports by condition and category with exact McNemar p-values and flipped probes, and refuses reports with different pins", () => {
    const before = runOffline(file, { startedAt: file.now, label: "before" });
    const after = runOffline(file, { startedAt: file.now, label: "after" });
    expect(compareReports(before, after)).toContain("tavi: accuracy");
    expect(compareReports(before, after)).toContain("McNemar p=1.000, +0/-0");

    // Exact two-sided McNemar: 6 probes gained and none lost gives p = 2 * 0.5^6 = 0.03125.
    expect(mcnemarPValue(0, 0)).toBe(1);
    expect(mcnemarPValue(1, 2)).toBe(1);
    expect(mcnemarPValue(0, 6)).toBeCloseTo(0.03125, 5);
    // One probe passing before and failing after.
    const flippedResults = after.results.map((result) => {
      if (result.condition === "tavi" && result.world === "recall-dog-name" && result.probe === "dog-name") {
        return { ...result, verdict: "fail" as const, reason: "simulated regression" };
      }
      return result;
    });
    const regressed = { ...after, results: flippedResults };
    const flips = pairedFlips(before.results, regressed.results, "tavi");
    expect(flips.lost).toEqual(["recall-dog-name/dog-name"]);
    expect(flips.gained).toEqual([]);
    expect(compareReports(before, regressed)).toContain("flipped (tavi): -recall-dog-name/dog-name");

    const other = buildReport({
      mode: "live",
      startedAt: file.now,
      now: file.now,
      worlds: file.worlds,
      fullContextChars: before.fullContextChars,
      reader: { connection: "c", model: "m" },
      judge: { connection: "c", model: "m" },
      conditions: ["off"],
      captures: [],
      results: [],
    });
    expect(() => compareReports(before, other)).toThrow(/not comparable/);
  });

  it("refuses to compare reports over different worlds, repeat counts or full-context windows", () => {
    const before = runOffline(file, { startedAt: file.now, label: "before" });
    const subset = runOffline({ ...file, worlds: file.worlds.slice(1) }, { startedAt: file.now, label: "subset" });
    expect(() => compareReports(before, subset)).toThrow(/worlds differ/);
    expect(() => compareReports(before, { ...before, repeat: 2 })).toThrow(/repeats differ/);
    expect(() => compareReports(before, { ...before, fullContextChars: before.fullContextChars + 1 })).toThrow(
      /full-context windows differ/,
    );
  });

  it("reads a run's answer, tool calls, tokens and cache reads from its stream", () => {
    const ndjson = [
      JSON.stringify({ kind: "text.delta", text: "partial " }),
      JSON.stringify({ kind: "tool.started", toolName: "memory.search" }),
      JSON.stringify({ kind: "task.completed", finalText: "Contoso.", metrics: { totalTokens: 900, cacheReadTokens: 300 } }),
    ].join("\n");
    expect(summarizeStream(ndjson)).toEqual({
      status: "completed",
      finalText: "Contoso.",
      toolCalls: 1,
      tokens: 900,
      cacheReadTokens: 300,
    });
  });
});

describe("the memory eval's live conditions", () => {
  it("kills a timed-out command that ignores SIGTERM once the grace is over", () => {
    vi.useFakeTimers();
    try {
      const signals: string[] = [];
      const deadline = childDeadline({ kill: (signal) => signals.push(signal) }, 1_000, 500);
      vi.advanceTimersByTime(999);
      expect([signals, deadline.timedOut()]).toEqual([[], false]);
      vi.advanceTimersByTime(1);
      expect([signals, deadline.timedOut()]).toEqual([["SIGTERM"], true]);
      vi.advanceTimersByTime(500);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      // A child that closed in time is never killed.
      const closed: string[] = [];
      childDeadline({ kill: (signal) => closed.push(signal) }, 1_000, 500).clear();
      vi.advanceTimersByTime(5_000);
      expect(closed).toEqual([]);
      expect(KILL_GRACE_MS).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names each proposal's capture path by its author, and counts them by path", () => {
    expect(captureSource("provider:tavi.memory:capture")).toBe("review");
    expect(captureSource("provider:acme.memory:capture")).toBe("review");
    expect(captureSource("provider:tavi.memory:consolidate")).toBe("consolidation");
    expect(captureSource("epoch-flush:e2")).toBe("flush");
    expect(captureSource("cli")).toBe("tool");
    const bundle = {
      records: [
        { recordId: "r1", kind: "fact", status: "proposed" },
        { recordId: "r2", kind: "fact", status: "proposed" },
        { recordId: "r3", kind: "fact", status: "proposed" },
      ],
      revisions: [
        { recordId: "r1", revisionNumber: 1, body: "Switched to a standing desk.", author: "cli" },
        { recordId: "r2", revisionNumber: 1, body: "Is vegetarian.", author: "provider:tavi.memory:capture" },
        { recordId: "r3", revisionNumber: 1, body: "The capital of Australia is Canberra.", author: "provider:tavi.memory:capture" },
      ],
    };
    const proposals = proposalsFromExport(bundle);
    expect(proposals[1]).toEqual({
      recordId: "r2",
      kind: "fact",
      text: "Is vegetarian.",
      author: "provider:tavi.memory:capture",
      source: "review",
    });
    const durable = world("capture-durable-and-not");
    expect(scoreCapture(durable, proposals).bySource).toEqual({
      tool: { proposals: 1, matched: 1, forbidden: 0 },
      review: { proposals: 2, matched: 1, forbidden: 1 },
    });
    const filed = filedProposals(durable, proposals);
    expect(filed.map((entry) => [entry.recordId, entry.source, entry.decision, entry.forbidden])).toEqual([
      ["r1", "tool", "approve", false],
      ["r2", "review", "approve", false],
      ["r3", "review", "reject", true],
    ]);
    expect(filed[0]?.expected).toBeDefined();
    expect(filedProposals(durable, proposals, true).every((entry) => entry.decision === "reject")).toBe(true);
  });

  it("reads hybrid and consolidate as Tavi offline, skips group worlds where the history is replayed, and skips hybrid with no embedding model", () => {
    for (const condition of ["hybrid", "consolidate"] as const) {
      expect(probePrompt(world("expiry-travel"), probe("expiry-travel", "travelling-now"), condition, file.now)).toBe(
        probePrompt(world("expiry-travel"), probe("expiry-travel", "travelling-now"), "tavi", file.now),
      );
      expect(liveSkipReason(world("isolation-member-words"), condition)).toMatch(/group conversation/);
    }
    expect(conditionSkipReason("hybrid", undefined)).toMatch(/--embedding-model/);
    expect(conditionSkipReason("hybrid", { connection: "openrouter", model: "openai/text-embedding-3-small" })).toBeUndefined();
    expect(conditionSkipReason("tavi", undefined)).toBeUndefined();
  });

  it("headlines tavi's capture, keeps each replayed condition's own, names skipped conditions and spend, and refuses to compare different embedding models", () => {
    const durable = world("capture-durable-and-not");
    const proposals = [{ recordId: "r1", kind: "fact", text: "Switched to a standing desk.", source: "review" as const }];
    const captures = [
      { ...scoreCapture(durable, proposals), condition: "grep" as const },
      { ...scoreCapture(durable, []), condition: "tavi" as const },
      { ...scoreCapture(durable, proposals), condition: "hybrid" as const },
    ];
    expect(captureCondition(captures)).toBe("tavi");
    expect(captureCondition([captures[0]!])).toBe("grep");
    const spend = addSpend(
      { calls: 3, inputTokens: 900, outputTokens: 90, cacheReadTokens: 100, estimatedUsd: 0.002, unpriced: 0 },
      { calls: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, estimatedUsd: 0.0005, unpriced: 1 },
    );
    expect(spend).toEqual({ calls: 4, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 100, estimatedUsd: 0.0025, unpriced: 1 });
    const base = {
      mode: "live" as const,
      startedAt: file.now,
      now: file.now,
      worlds: file.worlds,
      fullContextChars: 1000,
      reader: { connection: "c", model: "m" },
      judge: { connection: "c", model: "m" },
      captures,
      results: [],
      spend,
    };
    const report = buildReport({
      ...base,
      conditions: ["tavi", "hybrid"],
      embedding: { connection: "c", model: "e1" },
      skippedConditions: { consolidate: "not asked" },
    });
    expect(report.capture).toMatchObject({ proposals: 0 });
    expect(report.captureByCondition?.hybrid).toMatchObject({
      proposals: 1,
      bySource: { review: { proposals: 1, matched: 1, forbidden: 0 } },
    });
    expect(report.captureByCondition?.grep).toMatchObject({ proposals: 1 });
    const text = formatReport(report);
    expect(text).toContain("capture (hybrid): 1 proposals");
    expect(text).toContain("filed by review 1 (1 matched)");
    expect(text).toContain("SKIPPED consolidate: not asked");
    expect(text).toMatch(/^spend: 4 calls, 1000 input tokens \(100 cache reads\), 100 output, about \$0\.0025 plus 1 unpriced calls$/m);
    const other = buildReport({ ...base, conditions: ["tavi", "hybrid"], embedding: { connection: "c", model: "e2" } });
    expect(() => compareReports(report, other)).toThrow(/embedding models differ/);
    expect(compareReports(report, report)).toContain("hybrid: accuracy");
  });
});

describe("the memory eval's replay policy", () => {
  it("lets the owner run memory.propose unasked and denies every other effect on each replayed turn", () => {
    expect(REPLAY_ALLOWED_TOOLS).toEqual(["memory.propose"]);
    expect(replayOwnerArgs({ connection: "openrouter", model: "m" })).toEqual([
      "serve",
      "--eval",
      "--allow",
      "memory.propose",
      "--connection",
      "openrouter",
      "--model",
      "m",
    ]);
    expect(replayOwnerArgs({ model: "m" })).toEqual(["serve", "--eval", "--allow", "memory.propose", "--model", "m"]);
    const run = replayRunArgs("(Said on 2026-10-01 (Thursday).)\nHi");
    expect(run).toEqual(["run", "--home", "--format", "json", "--quiet", "--approval", "deny", "(Said on 2026-10-01 (Thursday).)\nHi"]);
    expect(run).not.toContain("approve");
  });

  it("denies the calls that would leave Home waiting, and the seeded reminder rule, by rules it can remove again", () => {
    expect(REPLAY_DENIED_TOOLS).toEqual(["agents.wait", "operator.ask_user", "reminders.*"]);
    const rules = replayDenyRuleArgs();
    expect(rules.map((args) => args.slice(0, 6))).toEqual(
      REPLAY_DENIED_TOOLS.map((tool) => ["permissions", "add", "--tool", tool, "--decision", "deny"]),
    );
    for (const args of rules) expect(args.slice(-2)).toEqual(["--format", "json"]);
    expect(addedRuleId(JSON.stringify({ rule: { ruleId: "rule-1", decision: "deny" } }))).toBe("rule-1");
    expect(addedRuleId(JSON.stringify({ ruleId: "rule-2" }))).toBe("rule-2");
    expect(addedRuleId("Added rule rule-3")).toBeUndefined();
  });
});

describe("the memory eval's repeats and re-scoring", () => {
  it("asks each probe --repeat times, and reports pass counts per probe and accuracy over every repeat", () => {
    const once = runOffline(file, { startedAt: file.now, conditions: ["off", "full"] });
    const thrice = runOffline(file, { startedAt: file.now, conditions: ["off", "full"], repeat: 3 });
    expect(thrice.results).toHaveLength(once.results.length * 3);
    expect(thrice.repeat).toBe(3);
    expect(
      thrice.results.filter((result) => result.condition === "off" && result.world === "expiry-travel").map((result) => result.repeat),
    ).toEqual([1, 2, 3]);
    expect(thrice.conditions.full?.accuracy).toBe(once.conditions.full?.accuracy);
    expect(thrice.conditions.full?.probes).toBe((once.conditions.full?.probes ?? 0) * 3);
    expect(thrice.probeTallies?.find((entry) => entry.condition === "full" && entry.probe === "travelling-now")).toMatchObject({
      asked: 3,
      world: "expiry-travel",
      category: "expiry",
    });
    expect(formatReport(thrice)).toContain("each probe asked 3 times");
  });

  it("tallies mixed repeats per probe and condition, leaving skipped ones out", () => {
    const employer = world("update-employer");
    const item = probe("update-employer", "employer-now");
    const results = [
      probeResult({ world: employer, probe: item, condition: "tavi", run: completed("Contoso."), repeat: 1 }),
      probeResult({ world: employer, probe: item, condition: "tavi", run: completed("Northwind."), repeat: 2 }),
      probeResult({ world: employer, probe: item, condition: "tavi", run: completed("Contoso."), repeat: 3 }),
      probeResult({ world: employer, probe: item, condition: "off", run: completed("Northwind."), repeat: 1 }),
      { ...probeResult({ world: employer, probe: item, condition: "grep", run: completed("") }), verdict: "skipped" as const },
    ];
    expect(probeTallies(results)).toEqual([
      { world: "update-employer", probe: "employer-now", category: "update", condition: "tavi", asked: 3, passed: 2 },
      { world: "update-employer", probe: "employer-now", category: "update", condition: "off", asked: 1, passed: 0 },
    ]);
    const report = buildReport({
      mode: "live",
      startedAt: file.now,
      now: file.now,
      worlds: [employer],
      fullContextChars: 1000,
      reader: { model: "m" },
      judge: { model: "m" },
      conditions: ["tavi"],
      captures: [],
      results: results.slice(0, 3),
      repeat: 3,
    });
    expect(report.conditions.tavi).toMatchObject({ probes: 3, passed: 2, byCategory: { update: { probes: 3, passed: 2 } } });
    expect(formatReport(report)).toContain('2/3 passed tavi update-employer/employer-now: fail: says "Northwind"');
  });

  it("pairs each probe once under --repeat, by its majority verdict over the repeats (a tie fails)", () => {
    const employer = world("update-employer");
    const item = probe("update-employer", "employer-now");
    const asked = (answers: readonly string[]) =>
      answers.map((answer, index) =>
        probeResult({ world: employer, probe: item, condition: "tavi", run: completed(answer), repeat: index + 1 }),
      );
    // 1/3 -> 2/3 passed: one gained pair, not one per repeat.
    expect(pairedFlips(asked(["Northwind.", "Northwind.", "Contoso."]), asked(["Contoso.", "Contoso.", "Northwind."]), "tavi")).toEqual({
      gained: ["update-employer/employer-now"],
      lost: [],
      pValue: 1,
    });
    // 2/4 is a tie, so still a fail: nothing flipped.
    expect(pairedFlips(asked(["Northwind."]), asked(["Contoso.", "Northwind.", "Contoso.", "Northwind."]), "tavi").gained).toEqual([]);
  });

  it("records its scoring version, and refuses to compare reports scored differently", () => {
    const report = runOffline(file, { startedAt: file.now });
    expect(report.scoringVersion).toBe(SCORING_VERSION);
    const { scoringVersion: _dropped, ...older } = report;
    expect(() => compareReports(older, report)).toThrow(/scoring differs \(memory-eval-scoring-v1 vs memory-eval-scoring-v2\): re-score/);
  });

  it("re-scores a report's kept answers, keeps the judge's earlier verdicts, and asks the judge only where the phrases cannot decide", async () => {
    const travel = world("expiry-travel");
    const travelling = probe("expiry-travel", "travelling-now");
    const employer = world("update-employer");
    const job = probe("update-employer", "employer-now");
    const worlds = file.worlds.filter((entry) => entry.id === travel.id || entry.id === employer.id);
    const old = (
      result: ReturnType<typeof probeResult>,
      verdict: "pass" | "fail" | "undecided",
      decidedBy: "phrase" | "judge" | "none",
    ) => ({ ...result, verdict, decidedBy, reason: "v1" });
    const results = [
      // v1 failed it for sounding unsure; v2 asks the judge.
      old(
        probeResult({
          world: travel,
          probe: travelling,
          condition: "full",
          run: completed("No. Your trip to Tokyo ended Friday; there are no records of ongoing travel."),
        }),
        "fail",
        "phrase",
      ),
      // The judge decided it before: kept, not asked again.
      old(
        probeResult({ world: employer, probe: job, condition: "full", run: completed("You moved from Northwind to Contoso.") }),
        "pass",
        "judge",
      ),
      // Decided by phrases either way.
      old(probeResult({ world: employer, probe: job, condition: "off", run: completed("Contoso.") }), "pass", "phrase"),
      // A run that failed stays failed.
      probeResult({ world: employer, probe: job, condition: "tavi", run: { status: "failed", finalText: "", toolCalls: 0 } }),
    ];
    const before = {
      ...buildReport({
        mode: "live",
        startedAt: file.now,
        now: file.now,
        worlds,
        fullContextChars: 1000,
        reader: { model: "m" },
        judge: { model: "j" },
        conditions: ["off", "full", "tavi"],
        captures: [],
        results,
      }),
      scoringVersion: "memory-eval-scoring-v1",
    };
    expect(reportWorlds(file, before).map((entry) => entry.id)).toEqual(worlds.map((entry) => entry.id));
    const asked: string[] = [];
    const after = await rescoreReport({
      report: before,
      worlds,
      at: "2026-10-12T00:00:00.000Z",
      from: "a.json",
      judge: async (item, answer) => {
        asked.push(`${item.id}: ${answer}`);
        return { verdict: "pass", wrongMemory: false, reason: "judge: the trip ended" };
      },
    });
    expect(asked).toEqual(["travelling-now: No. Your trip to Tokyo ended Friday; there are no records of ongoing travel."]);
    expect(after.results.map((result) => [result.condition, result.verdict, result.decidedBy])).toEqual([
      ["full", "pass", "judge"],
      ["full", "pass", "judge"],
      ["off", "pass", "phrase"],
      ["tavi", "fail", "none"],
    ]);
    expect(after).toMatchObject({
      scoringVersion: SCORING_VERSION,
      rescored: { at: "2026-10-12T00:00:00.000Z", from: "a.json" },
      startedAt: before.startedAt,
    });
    expect(after.conditions.full).toMatchObject({ probes: 2, passed: 2, judged: 2 });
    expect(() => compareReports(before, after)).toThrow(/scoring differs/);
    // With no judge, what the phrases cannot decide stays undecided.
    const unjudged = await rescoreReport({ report: before, worlds, at: "t", from: "a.json" });
    expect(unjudged.results[0]).toMatchObject({ verdict: "undecided", decidedBy: "none" });
    // A world file that differs from the report's is refused.
    expect(() => reportWorlds({ ...file, worlds: file.worlds.slice(1) }, runOffline(file, { startedAt: file.now }))).toThrow(
      /worlds .* differ/,
    );
  });
});
