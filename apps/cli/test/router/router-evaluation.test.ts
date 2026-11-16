import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../../src/cli/parse.js";
import { expect, it, afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import {
  EVALUATION_ARMS,
  RouterEvaluationEvidenceSchema,
  evaluateRouterEvidence,
  type RouterEvaluationEvidence,
} from "../../src/features/router/evaluation.js";
import { main } from "../../src/main.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

function evidence(): RouterEvaluationEvidence {
  const cases = [
    { id: "cal", family: "calibration-family", split: "calibration" as const },
    ...["one", "two", "three"].map((id) => ({ id, family: id, split: "held-out" as const })),
  ];
  return {
    schemaVersion: 1,
    protocolVersion: "router-eval-v2",
    corpusRevision: "corpus",
    policyRevision: "policy",
    environmentRevision: "snapshot",
    priceRevisions: ["price"],
    modelRevisions: ["provider/model@revision"],
    cases,
    observations: cases.flatMap((item) =>
      EVALUATION_ARMS.flatMap((arm) =>
        Array.from({ length: 3 }, (_, repetition) => ({
          caseId: item.id,
          arm,
          repetition,
          success: repetition !== 2,
          usd: arm === "baseline" ? 1 : 0.5,
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 20,
          totalLatencyMs: 100,
          routerWaitMs: arm === "baseline" ? 0 : 1,
          invariantViolations: 0,
          requiredTools: 2,
          offeredRequiredTools: 2,
          discoveryRecovered: false,
          mandatoryEvidenceLost: 0,
          explicitSkillPreserved: true,
          judgedBy: "executable" as const,
        })),
      ),
    ),
  };
}
it("includes failed attempts in total cost per success and clusters repetitions by task", () => {
  const report = evaluateRouterEvidence(evidence());
  const tools = report.comparisons.find((item) => item.arm === "router-tools");
  expect(tools).toMatchObject({
    pairedTasks: 3,
    baseline: { attempts: 9, successes: 6, costPerSuccess: 1.5 },
    candidate: { costPerSuccess: 0.75 },
    successDifference95: [0, 0],
    costRatio95: [0.5, 0.5],
    requiredToolRecall: 1,
    requiredToolRecall95: [1, 1],
    allRequiredToolsPerTask: 1,
    statisticalTargetsMet: false,
  });
  expect(report.activation).toBe("inconclusive");
  expect(report.missingObservations).toBe(0);
  expect(report.schedule).toHaveLength(12);
  expect(report.schedule[0]?.arms.slice().sort()).toEqual([...EVALUATION_ARMS].sort());
  expect(evaluateRouterEvidence(evidence())).toEqual(report);
});
it("names the routing provider an evidence file measures, one per file", () => {
  const input = evidence();
  expect(RouterEvaluationEvidenceSchema.safeParse({ ...input, protocolVersion: "router-eval-v1" }).success).toBe(false);
  const acme = RouterEvaluationEvidenceSchema.parse({
    ...input,
    observations: input.observations.map((row) => ({ ...row, providerId: "acme.router" })),
  });
  expect(evaluateRouterEvidence(acme).providerId).toBe("acme.router");
  expect(evaluateRouterEvidence(input).providerId).toBe("tavi.router");
  // One file measures one provider: mixing them would pool unlike comparisons.
  const mixed = {
    ...input,
    observations: input.observations.map((row, index) => (index % 2 === 0 ? { ...row, providerId: "acme.router" } : row)),
  };
  expect(RouterEvaluationEvidenceSchema.safeParse(mixed).success).toBe(false);
});
it("unknown usage and zero successes cannot become a finite savings claim", () => {
  const input = evidence();
  for (const row of input.observations) {
    if (row.arm === "router-model") row.usd = null;
    if (row.arm === "router-tools") row.success = false;
  }
  const report = evaluateRouterEvidence(input);
  expect(report.comparisons.find((item) => item.arm === "router-model")).toMatchObject({
    candidate: { completeCost: false, costPerSuccess: null },
    costRatio95: [null, null],
    statisticalTargetsMet: false,
  });
  expect(report.comparisons.find((item) => item.arm === "router-tools")).toMatchObject({
    candidate: { successes: 0, costPerSuccess: null },
    costRatio95: [null, null],
    statisticalTargetsMet: false,
  });
});
it("rejects duplicate rows and split leakage; missing pairs and invariant failures block activation", () => {
  const input = evidence();
  expect(RouterEvaluationEvidenceSchema.safeParse({ ...input, observations: [...input.observations, input.observations[0]] }).success).toBe(
    false,
  );
  expect(
    RouterEvaluationEvidenceSchema.safeParse({ ...input, cases: [...input.cases, { id: "leak", family: "one", split: "calibration" }] })
      .success,
  ).toBe(false);
  input.observations.shift();
  const first = input.observations[0];
  if (first === undefined) throw new Error("missing fixture");
  first.invariantViolations = 1;
  const report = evaluateRouterEvidence(input);
  expect(report).toMatchObject({ activation: "blocked-invariant-violation", missingObservations: 1, invariantViolations: 1 });
});
it("CLI produces an honest no-evidence decision without opening a runtime or making paid calls", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const result = await main(["router", "evaluate"], {
    io: {
      isTty: false,
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
    },
  });
  expect(result).toBe(0);
  expect(errors).toEqual([]);
  const report = JSON.parse(output.join("")) as Record<string, unknown>;
  expect(report).toMatchObject({
    activation: "inconclusive",
    reasons: expect.arrayContaining(["No frozen corpus or recorded outcomes supplied"]),
    evidenceSha256: null,
    liveExecution: { performed: false, spentUsd: 0 },
  });
  // The verdict first, and no per-arm tables of zeros: there is nothing to compare.
  expect(Object.keys(report)[0]).toBe("activation");
  expect(report).not.toHaveProperty("comparisons");
  expect(report).not.toHaveProperty("schedule");
  const text: string[] = [];
  expect(
    await main(["router", "evaluate", "--format", "text"], {
      io: { isTty: false, stdout: (line) => text.push(line), stderr: (line) => errors.push(line) },
    }),
  ).toBe(0);
  expect(text.join("").trimEnd().split("\n").length).toBeLessThanOrEqual(20);
});

it("accepts recorded files but rejects unrequested live execution and malformed evidence", async () => {
  const directory = directories.create("tavi-router-evaluation-");
  const output: string[] = [];
  const errors: string[] = [];
  const io = { isTty: false, stdout: (text: string) => output.push(text), stderr: (text: string) => errors.push(text) };
  const file = join(directory, "evidence.json");
  writeFileSync(file, JSON.stringify(evidence()));
  expect(await main(["router", "evaluate", "--file", file], { io })).toBe(0);
  expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({ cases: { calibration: 1, heldOut: 3 }, activation: "inconclusive" });
  writeFileSync(file, '{"secret": "must-not-appear"');
  expect(await main(["router", "evaluate", "--file", file], { io })).not.toBe(0);
  expect(errors.join("")).not.toContain("must-not-appear");
  expect(() => parseArgs(["router", "evaluate", "--live"])).toThrow();
});
it("resamples correlated repetitions together instead of manufacturing a narrower interval", () => {
  const input = evidence();
  for (const row of input.observations) {
    if (row.caseId === "cal") continue;
    row.success = row.arm === "baseline" ? row.caseId !== "one" : row.caseId !== "two";
  }
  // Paired task effects are +1, -1, 0. Each task carries all three repeated outcomes.
  expect(evaluateRouterEvidence(input).comparisons[0]?.successDifference95).toEqual([-1, 1]);
});
