#!/usr/bin/env node
/**
 * Summarize the traces `packages/runtime/test/routine-live.eval.test.ts` wrote.
 *
 * Reads every `.evidence/routines/live-eval-*.json`, prints per-role precision and
 * recall as a spread across repetitions (a live run is stochastic; one number is
 * not a measurement), the model identity and connection, the corpus hash, and the
 * calls and tokens actually spent. Thresholds are read from the traces themselves
 * — the values the gate applied — rather than restated here, so this summarizer
 * cannot disagree with the runtime about what "below threshold" means. Exits
 * non-zero when any repetition is incomplete or below threshold, so it can be used
 * as a gate rather than read by eye.
 *
 * Usage: node evals/routines/score-live-eval.mjs [traceDirectory]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const directory = process.argv[2] ?? ".evidence/routines";
/** The thresholds a trace was scored under, as the quality row recorded them. */
const thresholdsOf = (traces) => {
  for (const entry of traces) {
    const thresholds = entry.measured?.thresholds;
    if (typeof thresholds?.precision === "number" && typeof thresholds?.recall === "number") return thresholds;
  }
  return null;
};

function traceFiles(directory) {
  try {
    if (!statSync(directory).isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => name.startsWith("live-eval-") && name.endsWith(".json"))
    .map((name) => join(directory, name));
}

const files = traceFiles(directory);
if (files.length === 0) {
  console.error(`no live-eval traces in ${directory}; run the harness with TAVI_LIVE_EVAL=1 first`);
  process.exit(2);
}

const spread = (values) =>
  values.length === 0
    ? { min: null, max: null, mean: null }
    : { min: Math.min(...values), max: Math.max(...values), mean: values.reduce((sum, value) => sum + value, 0) / values.length };
const round = (value) => (value === null ? null : Number(value.toFixed(4)));

let failed = false;
for (const file of files) {
  const trace = JSON.parse(readFileSync(file, "utf8"));
  const traces = Array.isArray(trace.traces) ? trace.traces : [];
  const rows = traces.map((entry) => {
    const measured = entry.measured ?? {};
    const roles = measured.roles ?? {};
    return {
      repetition: entry.repetition,
      model: entry.model,
      complete: measured.complete === true,
      corpusHash: measured.corpusHash,
      corpusVersion: measured.corpusVersion,
      scorerVersion: measured.scorerVersion,
      promptVersion: measured.promptVersion,
      calls: measured.calls,
      tokensReserved: measured.tokensReserved,
      tokensKnown: measured.tokensKnown,
      usageComplete: measured.usageComplete,
      research: roles.research && { precision: roles.research.precision, recall: roles.research.recall, scored: roles.research.scored },
      synthesis: roles.synthesis && {
        precision: roles.synthesis.precision,
        recall: roles.synthesis.recall,
        scored: roles.synthesis.scored,
      },
    };
  });
  const incomplete = rows.filter((row) => !row.complete);
  const thresholds = thresholdsOf(traces);
  const below =
    thresholds === null
      ? []
      : rows.filter(
          (row) =>
            row.complete &&
            (row.research?.precision < thresholds.precision ||
              row.research?.recall < thresholds.recall ||
              row.synthesis?.precision < thresholds.precision ||
              row.synthesis?.recall < thresholds.recall),
        );
  const incompleteTraces = traces.filter((entry) => entry.measured?.complete !== true).map((entry) => entry.repetition);
  console.log(`\n${file}`);
  console.log(
    `  connection ${trace.config?.baseUrl ?? "unknown"} · model ${trace.config?.model ?? "unknown"} · corpus ${trace.corpusHash?.slice(0, 12) ?? "unknown"}`,
  );
  console.log(`  thresholds precision ${thresholds?.precision ?? "unknown"} / recall ${thresholds?.recall ?? "unknown"}`);
  console.log(`  repetitions ${rows.length} · provider calls ${trace.calls ?? "unknown"}`);
  console.log(
    `  research  precision ${JSON.stringify(spread(rows.map((row) => row.research?.precision ?? 0).map(round)))} recall ${JSON.stringify(spread(rows.map((row) => row.research?.recall ?? 0).map(round)))}`,
  );
  console.log(
    `  synthesis precision ${JSON.stringify(spread(rows.map((row) => row.synthesis?.precision ?? 0).map(round)))} recall ${JSON.stringify(spread(rows.map((row) => row.synthesis?.recall ?? 0).map(round)))}`,
  );
  for (const row of rows)
    console.log(
      `  rep ${row.repetition}: complete=${row.complete} research ${round(row.research?.precision)}/${round(row.research?.recall)} synthesis ${round(row.synthesis?.precision)}/${round(row.synthesis?.recall)} calls=${row.calls} tokens=${row.tokensReserved} (known ${row.tokensKnown}${row.usageComplete ? "" : ", incomplete usage"})`,
    );
  if (thresholds === null)
    console.error("  UNKNOWN THRESHOLDS: no trace records the thresholds it was scored under; this file cannot be gated");
  if (incomplete.length > 0)
    console.error(`  INCOMPLETE: repetitions ${incompleteTraces.join(", ")} did not score every case; those numbers are not a measurement`);
  if (below.length > 0)
    console.error(
      `  BELOW THRESHOLD: repetitions ${below.map((row) => row.repetition).join(", ")} missed precision ${thresholds.precision} / recall ${thresholds.recall}`,
    );
  if (incomplete.length > 0 || below.length > 0 || thresholds === null) failed = true;
}

process.exit(failed ? 1 : 0);
