import { z } from "zod";
import { sha256Hex } from "@tavi/node-kit";

export const EVALUATION_ARMS = [
  "baseline",
  "fixed-main",
  "fixed-fast",
  "lexical",
  "router-model",
  "router-memory",
  "router-tools",
  "router-skills",
  "combined",
] as const;
/** The provider behind routed arms that name none: the built-in Jev provider. */
const DEFAULT_PROVIDER = "tavi.router";
const ROUTER_EVALUATION_PROTOCOL = {
  version: "router-eval-v2",
  calibrationCases: 50,
  heldOutCases: 100,
  repetitions: 3,
  bootstrapDraws: 2000,
  clusterUnit: "task",
  seed: 260925,
  qualityLowerBound: -0.02,
  costRatioUpperBound: 0.85,
  toolRecall: 0.98,
  taskLatencyRatio: 1.1,
  routerWaitMaxMs: 1500,
  memoryMargin: "not-ratified",
  arms: EVALUATION_ARMS,
} as const;
const id = z.string().min(1).max(128);
const quantity = z.number().finite().nonnegative().max(1_000_000_000_000);
const count = z.number().int().nonnegative().max(1_000_000);
const ObservationSchema = z
  .strictObject({
    caseId: id,
    arm: z.enum(EVALUATION_ARMS),
    /** The routing provider behind the routed arms; absent means the built-in Jev provider (`tavi.router`). */
    providerId: id.optional(),
    repetition: z.number().int().min(0).max(2),
    success: z.boolean(),
    usd: quantity.max(1_000_000).nullable(),
    inputTokens: count.nullable(),
    outputTokens: count.nullable(),
    cacheReadTokens: count.nullable(),
    totalLatencyMs: quantity,
    routerWaitMs: quantity,
    invariantViolations: count,
    requiredTools: count.nullable(),
    offeredRequiredTools: count.nullable(),
    discoveryRecovered: z.boolean().nullable(),
    mandatoryEvidenceLost: count.nullable(),
    explicitSkillPreserved: z.boolean().nullable(),
    judgedBy: z.enum(["executable", "blinded-human"]),
  })
  .superRefine((row, ctx) => {
    if (
      (row.requiredTools === null) !== (row.offeredRequiredTools === null) ||
      (row.requiredTools !== null && row.offeredRequiredTools !== null && row.offeredRequiredTools > row.requiredTools)
    )
      ctx.addIssue({ code: "custom", message: "Invalid required-tool counts" });
    if (row.cacheReadTokens !== null && row.inputTokens !== null && row.cacheReadTokens > row.inputTokens)
      ctx.addIssue({ code: "custom", message: "Cache reads exceed input" });
  });
export const RouterEvaluationEvidenceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    protocolVersion: z.literal("router-eval-v2"),
    corpusRevision: id,
    policyRevision: id,
    environmentRevision: id,
    priceRevisions: z.array(id).min(1).max(32),
    modelRevisions: z.array(id).min(1).max(32),
    cases: z
      .array(z.strictObject({ id, family: id, split: z.enum(["calibration", "held-out"]) }))
      .min(1)
      .max(1000),
    observations: z.array(ObservationSchema).max(27000),
  })
  .superRefine((input, ctx) => {
    const ids = new Set<string>();
    const families = new Map<string, string>();
    const observed = new Set<string>();
    for (const item of input.cases) {
      if (ids.has(item.id) || (families.has(item.family) && families.get(item.family) !== item.split))
        ctx.addIssue({ code: "custom", message: "Duplicate case or family crosses calibration/held-out split" });
      ids.add(item.id);
      families.set(item.family, item.split);
    }
    for (const row of input.observations) {
      const key = JSON.stringify([row.caseId, row.arm, row.repetition]);
      if (!ids.has(row.caseId) || observed.has(key)) ctx.addIssue({ code: "custom", message: "Unknown case or duplicate observation" });
      observed.add(key);
    }
    // One evidence file measures one routing provider: pooling providers would blur every comparison.
    if (
      new Set(
        input.observations
          .filter((row) => row.arm.startsWith("router-") || row.arm === "combined")
          .map((row) => row.providerId ?? DEFAULT_PROVIDER),
      ).size > 1
    )
      ctx.addIssue({ code: "custom", message: "Routed arms mix routing providers; evaluate one provider per evidence file" });
  });
export type RouterEvaluationEvidence = z.infer<typeof RouterEvaluationEvidenceSchema>;
type Observation = RouterEvaluationEvidence["observations"][number];

function random(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}
function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? Number.POSITIVE_INFINITY;
}
function metrics(rows: readonly Observation[]) {
  const successes = rows.filter((row) => row.success).length;
  const completeCost = rows.length > 0 && rows.every((row) => row.usd !== null);
  const knownUsd = rows.reduce((sum, row) => sum + (row.usd ?? 0), 0);
  return {
    attempts: rows.length,
    successes,
    successRate: rows.length === 0 ? null : successes / rows.length,
    completeCost,
    knownUsd,
    costPerSuccess: completeCost && successes > 0 ? knownUsd / successes : null,
    inputTokens:
      rows.every((row) => row.inputTokens !== null) && rows.length > 0 ? rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0) : null,
    outputTokens:
      rows.every((row) => row.outputTokens !== null) && rows.length > 0
        ? rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0)
        : null,
    cacheReadTokens:
      rows.every((row) => row.cacheReadTokens !== null) && rows.length > 0
        ? rows.reduce((sum, row) => sum + (row.cacheReadTokens ?? 0), 0)
        : null,
    p95LatencyMs:
      rows.length === 0
        ? null
        : percentile(
            rows.map((row) => row.totalLatencyMs),
            0.95,
          ),
  };
}
const finiteOrNull = (value: number) => (Number.isFinite(value) ? value : null);

/** Pure evidence analysis: never calls a model, mutates settings or treats repetitions as independent tasks. */
/**
 * `tavi router evaluate` with no file: the verdict and why, first, and nothing
 * else of the report — with no evidence every comparison is zeros and the
 * arm-order plan is empty, so the tables would only bury the answer.
 */
export function routerNoEvidenceReport() {
  const report = evaluateRouterEvidence();
  return {
    activation: report.activation,
    reasons: report.reasons,
    evidenceSha256: report.evidenceSha256,
    protocol: report.protocol.version,
    liveExecution: report.liveExecution,
  };
}

export function evaluateRouterEvidence(raw?: unknown) {
  const evidence = raw === undefined ? undefined : RouterEvaluationEvidenceSchema.parse(raw);
  const cases = evidence?.cases ?? [];
  const rows = evidence?.observations ?? [];
  const heldOut = cases.filter((item) => item.split === "held-out");
  const calibration = cases.filter((item) => item.split === "calibration");
  const heldIds = new Set(heldOut.map((item) => item.id));
  const heldRows = rows.filter((row) => heldIds.has(row.caseId));
  const missing: string[] = [];
  const rowMap = new Map(rows.map((row) => [JSON.stringify([row.caseId, row.arm, row.repetition]), row]));
  let missingObservations = 0;
  for (const item of cases)
    for (const arm of EVALUATION_ARMS)
      for (let repetition = 0; repetition < 3; repetition++) {
        if (!rowMap.has(JSON.stringify([item.id, arm, repetition]))) missingObservations++;
      }
  if (evidence === undefined) missing.push("No frozen corpus or recorded outcomes supplied");
  if (calibration.length < 50 || heldOut.length < 100)
    missing.push("Pilot requires at least 50 calibration and 100 held-out cases in disjoint families");
  if (missingObservations > 0) missing.push("Missing paired arm/repetition observations");
  if (rows.length === 0 || rows.some((row) => row.usd === null))
    missing.push("Complete provider-attempt costs including failures, summaries, retries and router overhead are unavailable");
  const violations = rows.reduce((sum, row) => sum + row.invariantViolations, 0);
  const comparisons = EVALUATION_ARMS.filter((arm) => arm !== "baseline").map((arm) => {
    const paired = heldOut
      .map((item) => ({
        baseline: heldRows.filter((row) => row.caseId === item.id && row.arm === "baseline"),
        candidate: heldRows.filter((row) => row.caseId === item.id && row.arm === arm),
      }))
      .filter((pair) => pair.baseline.length === 3 && pair.candidate.length === 3);
    const baseline = metrics(paired.flatMap((pair) => pair.baseline));
    const candidate = metrics(paired.flatMap((pair) => pair.candidate));
    const differences: number[] = [];
    const ratios: number[] = [];
    const recalls: number[] = [];
    const rand = random(ROUTER_EVALUATION_PROTOCOL.seed);
    const clusters = paired.map((pair) => ({
      baseSuccess: pair.baseline.filter((row) => row.success).length,
      chosenSuccess: pair.candidate.filter((row) => row.success).length,
      baseUsd: pair.baseline.reduce((sum, row) => sum + (row.usd ?? 0), 0),
      chosenUsd: pair.candidate.reduce((sum, row) => sum + (row.usd ?? 0), 0),
      required: pair.candidate.reduce((sum, row) => sum + (row.requiredTools ?? 0), 0),
      offered: pair.candidate.reduce((sum, row) => sum + (row.offeredRequiredTools ?? 0), 0),
    }));
    const completeLabels = paired.every((pair) => pair.candidate.every((row) => row.requiredTools !== null));
    if (paired.length >= 2)
      for (let draw = 0; draw < ROUTER_EVALUATION_PROTOCOL.bootstrapDraws; draw++) {
        let baseSuccess = 0;
        let chosenSuccess = 0;
        let baseUsd = 0;
        let chosenUsd = 0;
        let required = 0;
        let offered = 0;
        for (let task = 0; task < clusters.length; task++) {
          const cluster = clusters[Math.floor(rand() * clusters.length)];
          if (cluster === undefined) throw new Error("Missing bootstrap cluster");
          baseSuccess += cluster.baseSuccess;
          chosenSuccess += cluster.chosenSuccess;
          baseUsd += cluster.baseUsd;
          chosenUsd += cluster.chosenUsd;
          required += cluster.required;
          offered += cluster.offered;
        }
        differences.push((chosenSuccess - baseSuccess) / (paired.length * 3));
        ratios.push(
          !baseline.completeCost || !candidate.completeCost || baseSuccess === 0 || chosenSuccess === 0 || baseUsd === 0
            ? Infinity
            : chosenUsd / chosenSuccess / (baseUsd / baseSuccess),
        );
        if (required > 0 && completeLabels) recalls.push(offered / required);
      }
    const successDifference95 = differences.length === 0 ? null : [percentile(differences, 0.025), percentile(differences, 0.975)];
    const costRatio95 = ratios.length === 0 ? null : [finiteOrNull(percentile(ratios, 0.025)), finiteOrNull(percentile(ratios, 0.975))];
    const candidateRows = paired.flatMap((pair) => pair.candidate);
    const labeled = candidateRows.filter((row) => row.requiredTools !== null);
    const required = labeled.reduce((sum, row) => sum + (row.requiredTools ?? 0), 0);
    const offered = labeled.reduce((sum, row) => sum + (row.offeredRequiredTools ?? 0), 0);
    const latencyRatio =
      baseline.p95LatencyMs !== null && baseline.p95LatencyMs > 0 && candidate.p95LatencyMs !== null
        ? candidate.p95LatencyMs / baseline.p95LatencyMs
        : null;
    return {
      arm,
      pairedTasks: paired.length,
      baseline,
      candidate,
      successDifference95,
      costRatio95,
      requiredToolRecall: required === 0 ? null : offered / required,
      requiredToolRecall95:
        recalls.length !== ROUTER_EVALUATION_PROTOCOL.bootstrapDraws ? null : [percentile(recalls, 0.025), percentile(recalls, 0.975)],
      allRequiredToolsPerTask:
        paired.length === 0 || candidateRows.some((row) => row.requiredTools === null)
          ? null
          : paired.filter((pair) => pair.candidate.every((row) => row.requiredTools === row.offeredRequiredTools)).length / paired.length,
      allRequiredToolsPerAttempt:
        labeled.length === 0 ? null : labeled.filter((row) => row.requiredTools === row.offeredRequiredTools).length / labeled.length,
      discoveryRecoveries: candidateRows.filter((row) => row.discoveryRecovered === true).length,
      mandatoryEvidenceLosses:
        candidateRows.length === 0 || candidateRows.some((row) => row.mandatoryEvidenceLost === null)
          ? null
          : candidateRows.reduce((sum, row) => sum + (row.mandatoryEvidenceLost ?? 0), 0),
      explicitSkillPreserved:
        candidateRows.length === 0 || candidateRows.some((row) => row.explicitSkillPreserved === null)
          ? null
          : candidateRows.every((row) => row.explicitSkillPreserved),
      latencyRatio,
      maxRouterWaitMs: candidateRows.length ? Math.max(...candidateRows.map((row) => row.routerWaitMs)) : null,
      statisticalTargetsMet:
        baseline.completeCost &&
        candidate.completeCost &&
        paired.length >= 100 &&
        successDifference95 !== null &&
        (successDifference95[0] ?? -Infinity) >= -0.02 &&
        costRatio95 !== null &&
        costRatio95[1] !== null &&
        (costRatio95[1] ?? Infinity) <= 0.85 &&
        latencyRatio !== null &&
        latencyRatio <= 1.1 &&
        candidateRows.every((row) => row.routerWaitMs <= 1500),
    };
  });
  // Reproducible pilot ordering is a plan, never evidence that these tasks ran.
  const rand = random(ROUTER_EVALUATION_PROTOCOL.seed);
  const schedule = cases.flatMap((item) =>
    Array.from({ length: 3 }, (_, repetition) => {
      const arms = [...EVALUATION_ARMS];
      for (let index = arms.length - 1; index > 0; index--) {
        const other = Math.floor(rand() * (index + 1));
        const left = arms[index];
        const right = arms[other];
        if (left !== undefined && right !== undefined) {
          arms[index] = right;
          arms[other] = left;
        }
      }
      return { caseId: item.id, repetition, arms };
    }),
  );
  const routedRow = rows.find((row) => row.arm.startsWith("router-") || row.arm === "combined");
  return {
    protocol: ROUTER_EVALUATION_PROTOCOL,
    providerId: routedRow === undefined ? null : (routedRow.providerId ?? DEFAULT_PROVIDER),
    evidenceSha256: evidence === undefined ? null : sha256Hex(JSON.stringify(evidence)),
    provenance:
      evidence === undefined
        ? null
        : {
            corpusRevision: evidence.corpusRevision,
            policyRevision: evidence.policyRevision,
            environmentRevision: evidence.environmentRevision,
            priceRevisions: evidence.priceRevisions,
            modelRevisions: evidence.modelRevisions,
          },
    source: "operator-supplied observations; provenance and independent judgments require audit",
    activation: violations > 0 ? "blocked-invariant-violation" : "inconclusive",
    reasons: [
      ...missing,
      "Memory margin and feature-specific recall/utility judgments must be ratified before activation",
      "No automatic activation; independently audit executable/blinded judgments and matched environment snapshots",
    ],
    cases: { calibration: calibration.length, heldOut: heldOut.length },
    missingObservations,
    invariantViolations: violations,
    comparisons,
    schedule,
    liveExecution: {
      performed: false,
      spentUsd: 0,
      reason:
        "This command analyzes recorded evidence and plans pair ordering. Live task execution requires an independently judged corpus, an explicit authorized spend cap, credentials and a controlled experiment harness.",
    },
  };
}
