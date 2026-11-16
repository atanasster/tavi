import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseWorldFile } from "../evals/memory/eval.js";
import {
  DEFAULT_BASELINE_PATH,
  RETRIEVAL_DIAGNOSTIC_WORLDS,
  compareRetrievalReports,
  deterministicTextVector,
  formatRetrievalReport,
  runRetrievalEval,
  scoreProbeRetrieval,
  summarizeRetrieval,
  type RetrievalEvalReport,
} from "../evals/memory/retrieval.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const worldsFile = parseWorldFile(JSON.parse(readFileSync(join(root, "evals", "memory", "worlds.json"), "utf8")));

describe("the offline memory retrieval eval", () => {
  it("scores recall@k, precision@k, MRR, noise rate and empty rate per probe and per category", () => {
    const exact = scoreProbeRetrieval({
      world: "w1",
      probe: "p1",
      category: "recall",
      query: { keywords: "dog biscuit" },
      relevant: ["r1", "r2"],
      irrelevant: ["bad"],
      hits: ["other", "r1", "r2"],
    });
    expect(exact).toMatchObject({
      recallAtK: 1,
      precisionAtK: 0.6667,
      mrr: 0.5,
      noisy: false,
      empty: false,
      passed: true,
    });

    const noisyAndPartial = scoreProbeRetrieval({
      world: "w1",
      probe: "p2",
      category: "recall",
      query: { keywords: "dog" },
      relevant: ["r1", "r2"],
      irrelevant: ["bad"],
      hits: ["bad", "r1"],
    });
    expect(noisyAndPartial).toMatchObject({
      recallAtK: 0.5,
      precisionAtK: 0.5,
      mrr: 0.5,
      noisy: true,
      empty: false,
      passed: false,
    });

    const empty = scoreProbeRetrieval({
      world: "w1",
      probe: "p3",
      category: "morphology",
      query: { keywords: "meeting" },
      relevant: ["r1"],
      hits: [],
    });
    expect(empty).toMatchObject({
      recallAtK: 0,
      precisionAtK: 0,
      mrr: 0,
      noisy: false,
      empty: true,
      passed: false,
    });

    const abstentionClean = scoreProbeRetrieval({
      world: "w2",
      probe: "p4",
      category: "abstention",
      query: { keywords: "sister" },
      relevant: [],
      irrelevant: ["dog"],
      hits: [],
    });
    expect(abstentionClean).toMatchObject({
      noisy: false,
      empty: false,
      passed: true,
    });
    expect(abstentionClean.recallAtK).toBeUndefined();

    // A record returned twice (its current and a superseded revision) counts once.
    expect(
      scoreProbeRetrieval({
        world: "w3",
        probe: "p5",
        category: "temporal-past",
        query: { keywords: "editor before helix" },
        relevant: ["editor"],
        hits: ["editor", "editor", "gym"],
      }),
    ).toMatchObject({ recallAtK: 1, precisionAtK: 0.5, mrr: 1, passed: true });

    const report = summarizeRetrieval([exact, noisyAndPartial, empty, abstentionClean], 10);
    expect(report.overall).toEqual({
      probes: 4,
      passed: 2,
      recallAtK: 0.5,
      precisionAtK: 0.3889,
      mrr: 0.3333,
      noiseRate: 0.25,
      emptyRate: 0.3333,
    });
    expect(formatRetrievalReport(report)).toContain("memory retrieval eval (limit=10): 2/4 probes passed");
  });

  it("detects regressions past tolerance and reports improvements in compareRetrievalReports", () => {
    const base = summarizeRetrieval(
      [
        scoreProbeRetrieval({
          world: "w1",
          probe: "p1",
          category: "morphology",
          query: { keywords: "meeting" },
          relevant: ["r1"],
          hits: [],
        }),
      ],
      10,
    );
    const improved = summarizeRetrieval(
      [
        scoreProbeRetrieval({
          world: "w1",
          probe: "p1",
          category: "morphology",
          query: { keywords: "meeting" },
          relevant: ["r1"],
          hits: ["r1"],
        }),
      ],
      10,
    );
    const up = compareRetrievalReports(base, improved);
    expect(up.ok).toBe(true);
    expect(up.improved).toBe(true);
    expect(up.improvements).toContain("probe w1/p1 now passes (recall@k 0.0000 -> 1.0000)");

    const down = compareRetrievalReports(improved, base);
    expect(down.ok).toBe(false);
    expect(down.regressions.some((entry) => entry.includes("probe w1/p1 regressed"))).toBe(true);
    expect(down.regressions).toContain("morphology emptyRate rose: 0.0000 -> 1.0000");
  });

  it("validates retrieval fields (relevant, irrelevant, priorTurns, remoteChat) in parseWorldFile", () => {
    const valid = parseWorldFile({
      version: 1,
      now: worldsFile.now,
      worlds: [
        {
          id: "w-ret",
          category: "recall",
          records: [{ id: "rec-1", kind: "fact", body: "Fact body." }],
          sessions: [],
          captures: [],
          probes: [
            {
              id: "p-1",
              priorTurns: [{ role: "person", text: "Hello" }],
              question: "What?",
              remoteChat: true,
              relevant: ["rec-1"],
              irrelevant: [],
              expect: ["Fact"],
            },
          ],
        },
      ],
    });
    expect(valid.worlds[0]?.probes[0]?.relevant).toEqual(["rec-1"]);

    expect(() =>
      parseWorldFile({
        version: 1,
        now: worldsFile.now,
        worlds: [
          {
            id: "w-bad",
            category: "recall",
            records: [{ id: "rec-1", kind: "fact", body: "Fact body." }],
            sessions: [],
            captures: [],
            probes: [{ id: "p-1", question: "What?", relevant: ["unknown-id"], expect: ["Fact"] }],
          },
        ],
      }),
    ).toThrow(/relevant names unknown id unknown-id/);
  });

  it("runs deterministically in under 10 seconds and matches or improves on the committed baseline", () => {
    const started = performance.now();
    const current = runRetrievalEval(worldsFile);
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(10_000);

    const repeat = runRetrievalEval(worldsFile);
    expect(repeat).toEqual(current);

    // Every diagnostic world (F1, F2, F7, F10) is present in the run.
    const worldIds = new Set(current.results.map((result) => result.world));
    for (const diagnostic of RETRIEVAL_DIAGNOSTIC_WORLDS) {
      expect(worldIds.has(diagnostic.id), `diagnostic world ${diagnostic.id}`).toBe(true);
    }

    if (process.env["UPDATE_RETRIEVAL_BASELINE"] === "1") {
      writeFileSync(DEFAULT_BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    }

    const baseline = JSON.parse(readFileSync(DEFAULT_BASELINE_PATH, "utf8")) as RetrievalEvalReport;
    const comparison = compareRetrievalReports(baseline, current);
    if (comparison.improved) {
      process.stdout.write(`${comparison.summary}\n`);
    }
    expect(comparison.regressions, comparison.summary).toEqual([]);
    expect(comparison.ok).toBe(true);
  });

  it("builds deterministic normalized vectors for meaning-only follow-up probes", () => {
    const first = deterministicTextVector("Sister Ana was born in Coimbra");
    const second = deterministicTextVector("Sister Ana was born in Coimbra");
    expect(first).toEqual(second);
    const norm = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 3);
  });
});
