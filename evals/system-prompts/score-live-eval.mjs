#!/usr/bin/env node
// Score one live behavioral-comparison run of the system prompt cases
// (`packages/agent-host/test/system-prompt-cases.test.ts`, "live model").
//
// The point is **not** a single number that decides a release; the traces are
// meant to be read: task success, model calls, budget failures, questions asked
// that were not needed, claims without a supporting tool result, and material
// omissions. So this derives those countable facts per task, prints them next to
// each other for the two templates, and writes them beside the trace file it read.
//
// Usage: node evals/system-prompts/score-live-eval.mjs [trace.json]
//        (default: the newest .evidence/system-prompts/live-eval-*.json)
//
// Exit 0 when every task ran under the template it was supposed to; exit 2 when
// there is no trace to score or the treatment did not hold.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, ".evidence/system-prompts");

function newestTrace() {
  if (!existsSync(OUT)) {
    console.error(`no ${OUT} directory yet; run the opt-in harness first`);
    process.exit(2);
  }
  const entries = readdirSync(OUT)
    // `-score.json` is this script's own output, and it is newer than the trace it
    // scored — selecting it would be a confusing crash rather than a trace.
    .filter((name) => name.startsWith("live-eval-") && name.endsWith(".json") && !name.endsWith("-score.json"))
    .map((name) => ({ name, at: statSync(join(OUT, name)).mtimeMs }))
    .sort((left, right) => right.at - left.at);
  if (entries.length === 0) {
    console.error(`no live-eval trace under ${OUT}; run the opt-in harness first`);
    process.exit(2);
  }
  return join(OUT, entries[0].name);
}

const path = process.argv[2] === undefined ? newestTrace() : resolve(process.argv[2]);
if (!existsSync(path)) {
  console.error(`no such trace: ${path}`);
  process.exit(2);
}
let report;
try {
  report = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  console.error(`${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
if (!Array.isArray(report.tasks) || report.tasks.length === 0) {
  console.error(`${path} is not a live-eval trace (no tasks); pass the trace path explicitly`);
  process.exit(2);
}

/** The countable facts, per task. The judgement is the reader's. */
function score(task) {
  const calls = task.calls ?? [];
  const toolCalls = calls.flatMap((call) => call.toolCalls.map((entry) => entry.name));
  // Batches, not a flat list: how many calls one *response* asked for is what the
  // per-response budget is about, and a flat list hid that distinction.
  const toolBatches = calls.map((call) => call.toolCalls.map((entry) => entry.name).join("+") || "-");
  const toolErrors = calls
    .flatMap((call) => call.messages ?? [])
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.toolResults ?? [])
    .filter((result) => String(result).includes('"error"')).length;
  const toolResults = calls
    .flatMap((call) => call.messages)
    .filter((message) => message.role === "tool")
    .map((message) => message.text);
  const accepted = task.effects.filter((effect) => effect.state === "accepted");
  // Deliberately broad, and reported as the coarser count beside the reader's
  // own: a run that says "I have no remaining tool calls left in this turn" has
  // named the budget without using the word "limit".
  const refusal =
    /cannot|unable|can't|not able|would need|no (?:way|tool|access)|not permitted|gated|approval|budget|limit|no remaining tool call|calls? left|used all .{0,20}tool calls/i;
  return {
    status: task.status,
    errorCode: task.errorCode,
    modelCalls: calls.length,
    providerFailures: calls.filter((call) => call.error !== undefined).length,
    toolCalls,
    toolBatches,
    toolResults: toolResults.length,
    toolErrorResults: toolErrors,
    // A question that the run delivered to a person. Unattended runs must have
    // none; attended runs may have one when the brief leaves a genuine gap.
    questionsDelivered: task.askedQuestions.length,
    approvalRows: task.approvals.map((row) => `${row.toolId}:${row.state}`),
    acceptedEffects: accepted.map((effect) => effect.toolId),
    // A "claim without a supporting tool result" is only countable where the case
    // is about a retrieved value: the reader checks it against the brief.
    finalTextChars: task.finalText.length,
    statesLimitOrGap: refusal.test(task.finalText),
    answer: task.finalText.replace(/\s+/g, " ").slice(0, 240),
    baseMatchesTemplate: task.baseMatchesTemplate,
  };
}

const byScenario = new Map();
for (const task of report.tasks) {
  const key = task.scenario;
  if (!byScenario.has(key)) byScenario.set(key, new Map());
  const perTemplate = byScenario.get(key);
  if (!perTemplate.has(task.templateVersion)) perTemplate.set(task.templateVersion, []);
  perTemplate.get(task.templateVersion).push({ task, score: score(task) });
}

const versions = [...new Set(report.tasks.map((task) => task.templateVersion))].sort();
const summary = {
  trace: path,
  complete: report.complete,
  ...(report.aborted === undefined ? {} : { aborted: report.aborted }),
  model: report.model,
  connectionId: report.connectionId,
  toolFixture: report.toolFixture,
  reps: report.reps,
  modelCallCeiling: report.modelCallCeiling,
  promptHashes: Object.fromEntries((report.templates ?? []).map((template) => [template.version, template.promptHash])),
  scenarios: {},
};

console.log(`trace: ${path}`);
console.log(`model: ${report.model} (${report.connectionId}), tool fixture: ${report.toolFixture}, reps: ${report.reps}`);
console.log(
  `prompt hashes: ${(report.templates ?? []).map((template) => `${template.version}=${template.promptHash.slice(0, 12)}`).join(" ")}`,
);
console.log(
  `complete: ${report.complete}${report.aborted === undefined ? "" : ` (aborted: ${report.aborted})`}, ceiling: ${report.modelCallCeiling} calls`,
);
console.log(`model calls: ${report.modelCalls}\n`);
if (report.complete !== true) console.error("note: this trace is not a completed run; the counts below are partial\n");

for (const [scenario, perTemplate] of byScenario) {
  console.log(`== ${scenario}`);
  const entry = {};
  for (const version of versions) {
    const rows = perTemplate.get(version) ?? [];
    const facts = {
      runs: rows.length,
      statuses: rows.map((row) => row.score.status),
      modelCalls: rows.map((row) => row.score.modelCalls),
      toolBatches: rows.map((row) => row.score.toolBatches.join(" | ")),
      questionsDelivered: rows.map((row) => row.score.questionsDelivered),
      approvalRows: rows.map((row) => row.score.approvalRows.join("+") || "-"),
      acceptedEffects: rows.map((row) => row.score.acceptedEffects.join("+") || "-"),
      statesLimitOrGap: rows.map((row) => row.score.statesLimitOrGap),
      baseMatchesTemplate: rows.every((row) => row.score.baseMatchesTemplate),
      answers: rows.map((row) => row.score.answer),
    };
    entry[version] = facts;
    console.log(
      `   ${version.padEnd(16)} runs=${facts.runs} status=[${facts.statuses.join(", ")}] calls=[${facts.modelCalls.join(", ")}] ` +
        `tools=[${facts.toolBatches.join(", ")}] questions=[${facts.questionsDelivered.join(", ")}] ` +
        `approvals=[${facts.approvalRows.join(", ")}] accepted=[${facts.acceptedEffects.join(", ")}] gap-stated=[${facts.statesLimitOrGap.join(", ")}]`,
    );
    for (const answer of facts.answers) console.log(`      · ${answer}`);
  }
  summary.scenarios[scenario] = entry;
}

const summaryPath = path.replace(/\.json$/, "-score.json");
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\nwrote ${summaryPath}`);

const broken = report.tasks.filter((task) => task.baseMatchesTemplate !== true);
if (broken.length > 0) {
  console.error(`\nFAIL: ${broken.length} task(s) did not run under the template they were scored as`);
  process.exit(2);
}
console.log("PASS: every task ran under the template it was scored as (the judgement of the answers is the evidence document's)");
