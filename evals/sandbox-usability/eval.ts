import {
  type ApprovalScope,
  type RiskLevel,
  SHIPPED_TOOL_RULES,
  evaluateGate,
  type ToolRule,
  type ToolRuleDecision,
} from "@tavi/contracts";

import { assessSandboxRun } from "../../apps/cli/src/features/approvals/call-assessors.js";

/**
 * The sandbox usability benchmark: how often `sandbox.run` asks, and for
 * what, over ordinary coding commands. Each case is one line a model would
 * run; its decision is read from the real assessor and gate with the shipped
 * rules, in an untainted chat and in a tainted one. No model, no sandbox: the
 * same input always gives the same numbers, pinned in `baseline.json` by
 * `tests/sandbox-usability-eval.test.ts`, so a change that adds or removes a
 * prompt is seen. The cases marked `real` also run in the real sandbox
 * (`tests/integration/sandbox-usability.real.test.ts`), which counts failures.
 */

export interface UsabilityCase {
  readonly id: string;
  readonly category: string;
  /** The whole command line, as a model passes it in `command`. */
  readonly line: string;
  readonly stdin?: string;
  /** Run in the real sandbox too (the real suite). */
  readonly real?: boolean;
  /** Programs the real run needs on `PATH`; a case missing one is skipped there. */
  readonly requires?: readonly string[];
  /** The platforms whose spelling of the command this is (`darwin`, `linux`); absent: every one. Elsewhere the real run skips it. */
  readonly platforms?: readonly string[];
}

export interface CasesFile {
  readonly version: 1;
  readonly cases: readonly UsabilityCase[];
}

/**
 * What the gate does with one call: its decision and, when it asks, the
 * scopes the card offers (a call offered only `once` asks every time, however
 * often it is approved) and the risk the card shows.
 */
export interface GateOutcome {
  readonly decision: ToolRuleDecision;
  readonly scopes?: readonly ApprovalScope[];
  readonly risk: RiskLevel;
}

/** One case's outcome without and with taint. */
export interface CaseDecision {
  readonly untainted: GateOutcome;
  readonly tainted: GateOutcome;
}

export interface Tally {
  readonly allow: number;
  readonly ask: number;
  readonly deny: number;
  /** Asks offered only `once`: no grant ever stops them. */
  readonly askEveryTime: number;
}

export interface BenchmarkReport {
  readonly cases: number;
  readonly untainted: Tally;
  readonly tainted: Tally;
  /** Prompts per 100 commands in an untainted chat: the headline number. */
  readonly promptsPer100: number;
  readonly decisions: Readonly<Record<string, CaseDecision>>;
}

const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`sandbox usability case: ${field} must be a non-empty string`);
  return value;
};

/** The cases file, checked: unique ids, a line each. */
export function parseCasesFile(raw: unknown): CasesFile {
  const file = raw as { version?: unknown; cases?: unknown };
  if (file.version !== 1 || !Array.isArray(file.cases)) throw new Error("sandbox usability cases: expected { version: 1, cases: [...] }");
  const seen = new Set<string>();
  const cases = file.cases.map((entry: Record<string, unknown>): UsabilityCase => {
    const id = text(entry["id"], "id");
    if (seen.has(id)) throw new Error(`sandbox usability cases: duplicate id ${id}`);
    seen.add(id);
    const requires = entry["requires"];
    if (requires !== undefined && (!Array.isArray(requires) || !requires.every((name) => typeof name === "string")))
      throw new Error(`sandbox usability case ${id}: requires must list program names`);
    return {
      id,
      category: text(entry["category"], "category"),
      line: text(entry["line"], "line"),
      ...(entry["stdin"] === undefined ? {} : { stdin: text(entry["stdin"], "stdin") }),
      ...(entry["real"] === true ? { real: true } : {}),
      ...(requires === undefined ? {} : { requires: requires as string[] }),
      ...(Array.isArray(entry["platforms"]) ? { platforms: entry["platforms"] as string[] } : {}),
    };
  });
  return { version: 1, cases };
}

/** The gate's outcome for one case, as `sandbox.run` would be gated with `rules`. */
export function decide(entry: UsabilityCase, tainted: boolean, rules: readonly ToolRule[] = SHIPPED_TOOL_RULES): GateOutcome {
  const assessment = assessSandboxRun({ command: entry.line, ...(entry.stdin === undefined ? {} : { stdin: entry.stdin }) });
  const verdict = evaluateGate({
    toolId: "sandbox.run",
    effect: "external",
    assessment,
    rules,
    sessionGrants: [],
    gatedEffects: new Set(["external"]),
    tainted,
    sink: "none",
  });
  return {
    decision: verdict.decision,
    ...(verdict.decision === "ask" ? { scopes: verdict.allowedScopes } : {}),
    risk: verdict.risk.level,
  };
}

const tally = (outcomes: readonly GateOutcome[]): Tally => ({
  allow: outcomes.filter((outcome) => outcome.decision === "allow").length,
  ask: outcomes.filter((outcome) => outcome.decision === "ask").length,
  deny: outcomes.filter((outcome) => outcome.decision === "deny").length,
  askEveryTime: outcomes.filter((outcome) => outcome.decision === "ask" && outcome.scopes?.length === 1).length,
});

/** Every case's decisions and the totals. */
export function runBenchmark(cases: readonly UsabilityCase[], rules?: readonly ToolRule[]): BenchmarkReport {
  const decisions: Record<string, CaseDecision> = {};
  for (const entry of cases) decisions[entry.id] = { untainted: decide(entry, false, rules), tainted: decide(entry, true, rules) };
  const values = Object.values(decisions);
  const untainted = tally(values.map((value) => value.untainted));
  return {
    cases: cases.length,
    untainted,
    tainted: tally(values.map((value) => value.tainted)),
    promptsPer100: cases.length === 0 ? 0 : Math.round((untainted.ask / cases.length) * 1000) / 10,
    decisions,
  };
}

/** The cases whose decision differs from the baseline's, for the failure message. */
export function changedFrom(baseline: BenchmarkReport, current: BenchmarkReport): string[] {
  const ids = new Set([...Object.keys(baseline.decisions), ...Object.keys(current.decisions)]);
  return [...ids]
    .filter((id) => JSON.stringify(baseline.decisions[id]) !== JSON.stringify(current.decisions[id]))
    .map((id) => `${id}: ${JSON.stringify(baseline.decisions[id])} -> ${JSON.stringify(current.decisions[id])}`);
}
