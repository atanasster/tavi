import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pin, RunSummary, Spend } from "./eval.js";

/**
 * The cache-stable layout's gate (recalled memory in a user-role context
 * block rather than the system text): on a provider that
 * caches, is the step-1 prefix-equality share of Home turns under 50%, over at
 * least 200 turns? This driver makes the measurement doctor reads: a copy of a
 * template data directory with Home on and ~15 records remembered, then N
 * person messages into Home, one at a time, each on a topic that recalls
 * different records (as real use does), and doctor's
 * `chatMeasurement.promptCacheByChatKind` for Home afterwards.
 *
 * Live only (it spends model tokens), like the eval it sits beside; its pure
 * parts are tested in `tests/memory-cache-gate.test.ts`.
 */

/** What the person keeps: facts and preferences across topics, so each topic's message recalls its own. */
export const CACHE_GATE_RECORDS: readonly {
  readonly kind: "fact" | "preference" | "lesson";
  readonly body: string;
  readonly key?: string;
  readonly value?: string;
  readonly topicKey?: string;
}[] = [
  { kind: "fact", body: "The person lives in Lisbon, in the Alfama district." },
  { kind: "fact", body: "The person works as a data analyst at Contoso." },
  { kind: "fact", body: "The person's dog is a beagle named Biscuit." },
  { kind: "fact", body: "The person's partner Sam has a birthday on 14 March." },
  { kind: "fact", body: "The person is training for the Lisbon half marathon in March." },
  { kind: "fact", body: "The person is learning Japanese and takes a class on Tuesdays." },
  { kind: "fact", body: "The person keeps a vegetable garden with tomatoes and basil." },
  { kind: "fact", body: "The person's sister Ana lives in Porto and has two children." },
  { kind: "fact", body: "The person drives a 2019 electric Renault Zoe." },
  { kind: "fact", body: "The person is allergic to peanuts." },
  { kind: "preference", body: "Prefers temperatures in Celsius.", key: "units.temperature", value: "celsius" },
  { kind: "preference", body: "Is vegetarian: no meat or fish in recipe ideas.", key: "diet", value: "vegetarian" },
  { kind: "preference", body: "Likes short answers in bullet points.", key: "reply.style", value: "short bullet points" },
  { kind: "preference", body: "Prefers trains to flights for trips under 600 km.", key: "travel.mode", value: "train under 600 km" },
  { kind: "preference", body: "Reads science fiction, especially Ursula K. Le Guin.", key: "books.genre", value: "science fiction" },
];

/** Profile records (lessons and `me.*` facts) shown once per conversation under `v2` via `contextDelta`. */
export const CACHE_GATE_PROFILE_RECORDS: readonly {
  readonly kind: "fact" | "lesson";
  readonly body: string;
  readonly topicKey?: string;
}[] = [
  { kind: "lesson", body: "When suggesting code edits, show a unified diff before applying changes." },
  { kind: "fact", body: "The person lives in Lisbon.", topicKey: "me.home_city" },
  { kind: "fact", body: "The person works as a data analyst at Contoso.", topicKey: "me.role" },
];

/** Messages on different topics, cycled, so the evidence recalled changes from one turn to the next. */
export const CACHE_GATE_TOPICS: readonly string[] = [
  "What should I cook for dinner tonight?",
  "Any tips for my long run this weekend?",
  "What's a good gift idea for Sam?",
  "How warm will it feel in my neighbourhood this afternoon?",
  "Help me plan a short trip to visit my sister.",
  "Suggest a Japanese phrase I could practise before class.",
  "What should I plant in the garden next month?",
  "Recommend a book for the weekend.",
  "How should I look after Biscuit in the heat?",
  "Draft a two-line status update for my manager.",
  "Is a road trip in my car to Madrid practical?",
  "What snacks can I bring to a party safely?",
];

/** The `index`th message (from 0): its topic, numbered so no two are the same text. */
export function cacheGateTurn(index: number): string {
  const topic = CACHE_GATE_TOPICS[index % CACHE_GATE_TOPICS.length] ?? "";
  return `(${index + 1}) ${topic}`;
}

/** `tavi memory remember` arguments for one of the records. */
export function cacheGateRememberArgs(record: (typeof CACHE_GATE_RECORDS)[number]): string[] {
  return [
    "memory",
    "remember",
    "--scope",
    "personal",
    "--kind",
    record.kind,
    "--body",
    record.body,
    ...(record.kind === "preference" ? ["--key", record.key ?? "", "--value", record.value ?? ""] : []),
    ...(record.kind === "fact" && record.topicKey !== undefined ? ["--topic", record.topicKey] : []),
    "--reason",
    "cache gate seed",
  ];
}

/** Doctor's prompt-cache measurement of one chat kind, as `tavi doctor` prints it. */
export interface PromptCacheEntry {
  readonly kind: string;
  readonly firstStep: {
    readonly calls: number;
    readonly inputTokens: number;
    readonly cacheReadTokens: number;
    readonly share: number | null;
  };
  readonly laterSteps: {
    readonly calls: number;
    readonly inputTokens: number;
    readonly cacheReadTokens: number;
    readonly share: number | null;
  };
  readonly callsWithoutCacheUsage: number;
  readonly firstStepPrefix: { readonly turnsCompared: number; readonly sameAsPreviousTurn: number; readonly share: number | null };
}

export const CACHE_GATE_SHARE = 0.5;
export const CACHE_GATE_MIN_TURNS = 200;

/**
 * The cache-stable layout's gate from Home's measurement: `build` when the provider caches
 * (some cache reads) and the step-1 prefix-equality share is under 50% over
 * at least 200 compared turns; `drop` when it is 50% or more over as many;
 * `insufficient` otherwise (too few turns, or a provider that reports no cache reads).
 */
export function cacheGateVerdict(
  home: PromptCacheEntry | undefined,
  minTurns: number = CACHE_GATE_MIN_TURNS,
): { readonly verdict: "build" | "drop" | "insufficient"; readonly reason: string } {
  if (home === undefined) return { verdict: "insufficient", reason: "doctor measured no Home call" };
  const caches = home.firstStep.cacheReadTokens + home.laterSteps.cacheReadTokens > 0;
  const { turnsCompared, share } = home.firstStepPrefix;
  if (!caches) return { verdict: "insufficient", reason: "the provider reported no cache reads: the gate needs one that caches" };
  // N turns give N − 1 comparisons with the turn before: the gate counts turns.
  const turns = turnsCompared + 1;
  if (turns < minTurns || share === null)
    return { verdict: "insufficient", reason: `${turns} turns measured; the gate needs at least ${minTurns}` };
  return share < CACHE_GATE_SHARE
    ? {
        verdict: "build",
        reason: `step-1 prefix equality ${share} < ${CACHE_GATE_SHARE} over ${turns} turns: the cache-stable layout is built`,
      }
    : {
        verdict: "drop",
        reason: `step-1 prefix equality ${share} ≥ ${CACHE_GATE_SHARE} over ${turns} turns: the cache-stable layout is dropped`,
      };
}

export interface CacheGateReport {
  readonly label?: string;
  readonly startedAt: string;
  readonly reader: Pin;
  readonly turns: { readonly requested: number; readonly completed: number; readonly failed: number };
  readonly records: number;
  /** Doctor's `promptCacheByChatKind` entry for Home, and its usage entry. */
  readonly home?: PromptCacheEntry;
  readonly homeUsage?: Record<string, unknown>;
  readonly prefixEqualityShare: number | null;
  readonly cacheReadShare: { readonly firstStep: number | null; readonly laterSteps: number | null };
  /** Summed from the turns' own streams. */
  readonly turnTokens: { readonly total: number; readonly cacheRead: number };
  /** Every model call the copy made, from its ledger. */
  readonly spend: Spend;
  /**
   * Doctor's `usageBySite` entries for a chat turn's own calls (`chat-step1`,
   * `chat-stepN`, `final-step`): their cache reads beside the cache writes
   * a prefix change costs. Empty against a doctor from before sites.
   */
  readonly chatSites: readonly Record<string, unknown>[];
  /** Doctor's `prefixChurn`: model switches and folds, each of which re-sends the prefix. Absent against an older doctor. */
  readonly prefixChurn?: Record<string, unknown>;
  readonly gate: ReturnType<typeof cacheGateVerdict>;
}

/** The sites of a chat turn's own model calls. */
const CHAT_SITES = new Set(["chat-step1", "chat-stepN", "final-step"]);

/** The report from what the turns said and doctor's document. */
export function cacheGateReport(input: {
  readonly label?: string;
  readonly startedAt: string;
  readonly reader: Pin;
  readonly requested: number;
  readonly runs: readonly RunSummary[];
  readonly doctor: unknown;
  readonly spend: Spend;
  readonly minTurns?: number;
}): CacheGateReport {
  const measurement = ((input.doctor as { readonly chatMeasurement?: unknown } | undefined)?.chatMeasurement ?? {}) as {
    readonly promptCacheByChatKind?: readonly PromptCacheEntry[];
    readonly usageByChatKind?: readonly Record<string, unknown>[];
    readonly usageBySite?: readonly Record<string, unknown>[];
    readonly prefixChurn?: Record<string, unknown>;
  };
  const home = measurement.promptCacheByChatKind?.find((entry) => entry.kind === "home");
  const homeUsage = measurement.usageByChatKind?.find((entry) => entry["kind"] === "home");
  const completed = input.runs.filter((run) => run.status === "completed").length;
  return {
    ...(input.label === undefined ? {} : { label: input.label }),
    startedAt: input.startedAt,
    reader: input.reader,
    turns: { requested: input.requested, completed, failed: input.runs.length - completed },
    records: CACHE_GATE_RECORDS.length,
    ...(home === undefined ? {} : { home }),
    ...(homeUsage === undefined ? {} : { homeUsage }),
    prefixEqualityShare: home?.firstStepPrefix.share ?? null,
    cacheReadShare: { firstStep: home?.firstStep.share ?? null, laterSteps: home?.laterSteps.share ?? null },
    turnTokens: {
      total: input.runs.reduce((sum, run) => sum + (run.tokens ?? 0), 0),
      cacheRead: input.runs.reduce((sum, run) => sum + (run.cacheReadTokens ?? 0), 0),
    },
    spend: input.spend,
    chatSites: (measurement.usageBySite ?? []).filter((entry) => CHAT_SITES.has(String(entry["site"]))),
    ...(measurement.prefixChurn === undefined ? {} : { prefixChurn: measurement.prefixChurn }),
    gate: cacheGateVerdict(home, input.minTurns),
  };
}

export function formatCacheGateReport(report: CacheGateReport): string {
  const share = (value: number | null): string => (value === null ? "n/a" : `${Math.round(value * 1000) / 10}%`);
  return [
    `cache gate${report.label === undefined ? "" : ` (${report.label})`}: reader ${report.reader.connection === undefined ? "" : `${report.reader.connection}/`}${report.reader.model}, ${report.turns.completed}/${report.turns.requested} Home turns (${report.turns.failed} failed)`,
    `step-1 prefix equality: ${share(report.prefixEqualityShare)} over ${report.home?.firstStepPrefix.turnsCompared ?? 0} turns compared`,
    `cache-read share: step 1 ${share(report.cacheReadShare.firstStep)}, later steps ${share(report.cacheReadShare.laterSteps)}`,
    ...report.chatSites.map(
      (site) =>
        `${String(site["site"])}: ${String(site["calls"])} calls, ${String(site["inputTokens"])} input tokens, ${String(site["cacheReadTokens"])} cache reads, ${String(site["cacheWriteTokens"])} cache writes`,
    ),
    ...(report.prefixChurn === undefined
      ? []
      : [`prefix churn: ${String(report.prefixChurn["modelSwitches"])} model switches, ${String(report.prefixChurn["folds"])} folds`]),
    `spend: ${report.spend.calls} calls, ${report.spend.inputTokens} input tokens (${report.spend.cacheReadTokens} cache reads), ${report.spend.outputTokens} output, about $${report.spend.estimatedUsd.toFixed(4)}${report.spend.unpriced === 0 ? "" : ` plus ${report.spend.unpriced} unpriced calls`}`,
    `gate: ${report.gate.verdict} — ${report.gate.reason}`,
  ].join("\n");
}

// ------------------------------------------------------------------ the live driver

interface DriverOptions {
  readonly template: string;
  readonly reader: Pin;
  readonly turns: number;
  readonly outDir: string;
  readonly timeoutMs: number;
  readonly keep: boolean;
  readonly label?: string;
}

function parseArgs(argv: readonly string[], here: string): DriverOptions {
  const flags = new Map<string, string>();
  let keep = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (flag === "--keep") {
      keep = true;
      continue;
    }
    if (!["--template", "--connection", "--model", "--turns", "--out", "--timeout-s", "--label"].includes(flag))
      throw new Error(`unknown option ${flag}; see evals/memory/README.md`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    flags.set(flag, value);
    index += 1;
  }
  const template = flags.get("--template");
  const model = flags.get("--model");
  if (template === undefined || model === undefined)
    throw new Error("the cache gate needs --template <dir> and --model (and --connection)");
  const turns = Number(flags.get("--turns") ?? "200");
  if (!Number.isInteger(turns) || turns <= 0) throw new Error("--turns must be a positive whole number");
  const timeoutSeconds = Number(flags.get("--timeout-s") ?? "180");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("--timeout-s must be a positive whole number");
  const connection = flags.get("--connection");
  const label = flags.get("--label");
  return {
    template: resolve(template),
    reader: { ...(connection === undefined ? {} : { connection }), model },
    turns,
    outDir: resolve(flags.get("--out") ?? join(here, "results")),
    timeoutMs: timeoutSeconds * 1000,
    keep,
    ...(label === undefined ? {} : { label }),
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const here = dirname(fileURLToPath(import.meta.url));
  const options = parseArgs(argv, here);
  // The live helpers are the eval's and the shared template's (`node` runs the .ts files; the types come from them too).
  const template = (await import(new URL("../template.ts", import.meta.url).href)) as typeof import("../template.js");
  const unusable = template.templateUnusable(options.template);
  if (unusable !== undefined) throw new Error(unusable);
  const live = (await import(new URL("./eval.ts", import.meta.url).href)) as typeof import("./eval.js");
  const log = (message: string): void => {
    process.stderr.write(`[cache gate] ${message}\n`);
  };
  const startedAt = new Date().toISOString();
  // Short: the owner's socket lives under the data directory.
  const scratch = mkdtempSync(join(tmpdir(), "tcg-"));
  chmodSync(scratch, 0o700);
  // Interrupted, the gate still stops its owner and removes its copy (it holds credentials).
  const removeSignalCleanup = template.cleanupOnSignal({ ...live.runningProcesses, scratch: [scratch], keep: options.keep, log });
  const cwd = join(scratch, "cwd");
  const dataDir = join(scratch, "d");
  const ok = (args: readonly string[]): Promise<string> => live.taviOk(args, dataDir, cwd, options.timeoutMs);
  const runs: RunSummary[] = [];
  let doctor: unknown;
  let spend: Spend;
  try {
    mkdirSync(cwd);
    await template.checkTemplate(options.template, scratch);
    template.privateCopy(options.template, dataDir);
    const baseline = await live.ledgerSpend(dataDir);
    await ok(["config", "set", "chat.home", "on"]);
    await ok(["models", "set-default", ...live.pinArgs(options.reader)]);
    const seededRecords = [...CACHE_GATE_RECORDS, ...CACHE_GATE_PROFILE_RECORDS];
    for (const record of seededRecords) await ok(cacheGateRememberArgs(record));
    // As the eval's replay: a turn left waiting on a deadline, a question or a reminder would hold Home and refuse every later turn.
    for (const args of live.replayDenyRuleArgs()) await ok(args);
    log(`${seededRecords.length} records remembered in ${dataDir}`);
    const owner = await live.startOwner(dataDir, options.reader, cwd);
    try {
      for (let index = 0; index < options.turns; index += 1) {
        const run = await live.taviHome(cacheGateTurn(index), "deny", dataDir, cwd, options.timeoutMs);
        runs.push(run);
        log(
          `turn ${index + 1}/${options.turns}: ${run.timedOut === true ? "timed out" : run.status}, ${run.tokens ?? "?"} tokens, ${run.cacheReadTokens ?? 0} cache reads`,
        );
      }
    } finally {
      await owner.stop();
    }
    doctor = JSON.parse(await ok(["doctor"]));
    spend = live.addSpend(await live.ledgerSpend(dataDir), baseline, -1);
  } finally {
    if (options.keep) log(`data directory kept in ${dataDir}`);
    else rmSync(scratch, { recursive: true, force: true });
    removeSignalCleanup();
  }
  const report = cacheGateReport({
    ...(options.label === undefined ? {} : { label: options.label }),
    startedAt,
    reader: options.reader,
    requested: options.turns,
    runs,
    doctor,
    spend,
  });
  mkdirSync(options.outDir, { recursive: true });
  const path = join(options.outDir, `cache-gate-${startedAt.replaceAll(":", "-").replace(".", "-")}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${formatCacheGateReport(report)}\n\nreport: ${path}\n`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
