import { chmodSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import {
  CHECKPOINTS_KEPT,
  DEFAULT_KEPT_MODEL_REQUESTS,
  MAX_CONVERSATION_MESSAGES,
  type InvocationContext,
  type ModelEvent,
  type ModelOutcome,
  type ModelPort,
  type ModelRequest,
} from "@tavi/contracts";
import { EPOCH_LINE_PATTERN } from "@tavi/test-support/fakes";
import { DEFAULT_COMPACTION_SUMMARY_PROMPT, EPOCH_FLUSH_ATTEMPT_NUMBER, EPOCH_MARKER_PATTERN } from "@tavi/agent-host/workflow";
import { describe, expect, it, afterEach } from "vitest";
import { temporaryDirectories, delay } from "@tavi/test-support";

import { loadBetterSqlite3 } from "../../../../packages/runtime/src/persistence/sqlite-loader.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

/**
 * The epoch rollover soak: one chat
 * of `TAVI_SOAK_TURNS` turns (10,000 by default) through the composed owner —
 * the real workflow, the SQLite store, and the real per-turn checkpoint prune
 * — every default as shipped. A stub
 * model mixes its turns: a plain answer, one `memory.search` round trip, or
 * two `memory.search` calls in one step (read-only, local, offered without
 * approval); it answers stage 2's summarization requests and the
 * pre-compaction flush too, and checks every request's provider pairing.
 *
 * It passes when every turn completes (no `BUDGET_EXCEEDED`), the epoch
 * advances, every request is valid and under `MAX_CONVERSATION_MESSAGES`, the
 * chat's checkpoint rows after every turn are at most `CHECKPOINTS_KEPT`, at
 * most `DEFAULT_KEPT_MODEL_REQUESTS` attempts still carry their request, the
 * database stays under `DATABASE_BASE_MIB` plus `DATABASE_MIB_PER_1000_TURNS`
 * a thousand turns, and the owner's heap stays flat.
 *
 * Heap: sampled every `SAMPLE_EVERY` turns after a full collection (`gc` is
 * exposed at run time through `v8.setFlagsFromString`; without it the minimum
 * of five spaced samples). From the sample at `WARMUP_TURNS` on, `heapUsed`
 * may grow at most `HEAP_GROWTH_MIB` (64 MiB): a leak of one kilobyte a turn
 * over 9,000 turns is ~9 MiB and passes, so the bound catches what retains a
 * conversation or a request per turn (each tens of kilobytes), not a slow
 * drift; the report's samples show the drift. Runs only with `TAVI_SOAK=1`;
 * `TAVI_SOAK_REPORT=<file>` writes the samples there as JSON.
 */

const SOAK = process.env["TAVI_SOAK"] === "1";
const TURNS = Number(process.env["TAVI_SOAK_TURNS"] ?? "10000");
const WARMUP_TURNS = Math.min(1_000, Math.floor(TURNS / 5));
const SAMPLE_EVERY = Math.max(1, Math.min(500, Math.floor(TURNS / 10)));
const HEAP_GROWTH_MIB = 64;
/**
 * The database's bound: what a turn still adds for good — its
 * transcript entry, admission and receipt, and its model calls' attempt rows
 * without their requests — is a few kilobytes; the requests kept and the
 * checkpoints are bounded. Measured on 2026-10-05: 3,000 turns in 35.4 MiB,
 * about 10 MiB a thousand turns, nearly all of it the ledger (attempt and
 * operation rows, ~2 KB a model call); before the per-turn prune they took 669 MiB.
 */
const DATABASE_BASE_MIB = 8;
const DATABASE_MIB_PER_1000_TURNS = 12;

const workspaces = [
  { workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] },
] as const;

/** A full collection when the flag can be set at run time, else none. Called only by the gated soak: a skipped run leaves V8's flags alone. */
function exposeGc(): (() => void) | undefined {
  try {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as unknown;
    return typeof gc === "function" ? (gc as () => void) : undefined;
  } catch {
    return undefined;
  }
}

async function heapMiB(collect: (() => void) | undefined): Promise<number> {
  const readings: number[] = [];
  for (let index = 0; index < (collect === undefined ? 5 : 2); index += 1) {
    collect?.();
    await delay(collect === undefined ? 50 : 5);
    readings.push(process.memoryUsage().heapUsed);
  }
  return Math.round((Math.min(...readings) / (1024 * 1024)) * 10) / 10;
}

const turnOf = (text: string): number | undefined => {
  const match = /^turn (\d+)\b/.exec(text);
  return match === null ? undefined : Number(match[1]);
};

/** The stub: mixed turns by the turn's number, pairing checked on every request, nothing kept but counters. */
function soakModel() {
  const stats = {
    requests: 0,
    summaries: 0,
    flushes: 0,
    toolSteps: 0,
    plainTurns: 0,
    maxMessages: 0,
    latestEpoch: 0,
    toolOffered: false,
    violations: [] as string[],
  };
  let calls = 0;
  const model: ModelPort = {
    async stream(request: ModelRequest, options: { readonly onEvent: (event: ModelEvent) => void }): Promise<ModelOutcome> {
      const done = (text: string): ModelOutcome => {
        options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: `block-${request.attemptId}`, text });
        return { status: "completed", attemptId: request.attemptId, text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      };
      if (request.messages[0]?.role === "system" && request.messages[0].text === DEFAULT_COMPACTION_SUMMARY_PROMPT) {
        stats.summaries += 1;
        return done("Earlier turns: memory searches that found nothing, each answered.");
      }
      if (request.attemptNumber === EPOCH_FLUSH_ATTEMPT_NUMBER) {
        stats.flushes += 1;
        return done(JSON.stringify({ memories: [] }));
      }
      stats.requests += 1;
      stats.maxMessages = Math.max(stats.maxMessages, request.messages.length);
      const open = new Set<string>();
      for (const message of request.messages) {
        if (message.role === "tool") {
          for (const result of message.toolResults ?? [])
            if (!open.delete(result.toolCallId) && stats.violations.length < 20)
              stats.violations.push(`result ${result.toolCallId} answers no open call`);
          continue;
        }
        if (message.role === "system" && !EPOCH_MARKER_PATTERN.test(message.text)) continue;
        if (open.size > 0 && stats.violations.length < 20)
          stats.violations.push(`calls ${[...open].join(",")} unanswered before ${message.id}`);
        for (const toolCall of message.toolCalls ?? []) open.add(toolCall.id);
        // An ordinary chat's summary rides in the call's context block: its marker opens a line there.
        const epoch = (EPOCH_MARKER_PATTERN.exec(message.text) ?? EPOCH_LINE_PATTERN.exec(message.text))?.[1];
        if (epoch !== undefined) stats.latestEpoch = Math.max(stats.latestEpoch, Number(epoch));
      }
      if (open.size > 0 && stats.violations.length < 20)
        stats.violations.push(`calls ${[...open].join(",")} unanswered at the end of ${request.attemptId}`);
      const last = request.messages.filter((message) => message.role !== "system" && !message.text.startsWith("Runtime facts")).at(-1);
      const turn = last?.role === "user" ? turnOf(last.text) : undefined;
      const offered = request.tools.some((tool) => tool.id === "memory.search");
      stats.toolOffered ||= offered;
      if (turn !== undefined && offered && turn % 3 !== 0) {
        // One call, or two in one step.
        stats.toolSteps += 1;
        const toolCalls = Array.from({ length: turn % 3 }, (_, index) => {
          calls += 1;
          return {
            id: `toolu_${String(calls).padStart(8, "0")}`,
            name: "memory.search",
            input: { query: index === 0 ? "deploy schedule" : "release notes" },
          };
        });
        return { status: "completed", attemptId: request.attemptId, text: "", toolCalls, usage: { inputTokens: 1, outputTokens: 1 } };
      }
      if (turn !== undefined) stats.plainTurns += 1;
      return done(turn === undefined ? "Nothing in memory; carrying on." : `ok ${turn}`);
    },
  };
  return { model, stats };
}

/**
 * The closed store: its largest tables and indexes by the pages they hold, in
 * MiB, with its free pages (SQLite's `dbstat`; none where it is not compiled
 * in), and the most attempts of one run still carrying their request.
 */
function inspect(path: string): { readonly tables: Record<string, number>; readonly requestsKept: number } {
  const db = new (loadBetterSqlite3())(path, { readonly: true });
  const mib = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;
  try {
    const requestsKept = (
      db
        .prepare("SELECT coalesce(max(n), 0) AS n FROM (SELECT count(*) AS n FROM tavi_provider_attempt_requests GROUP BY run_id)")
        .get() as { n: number }
    ).n;
    let tables: Record<string, number> = {};
    try {
      const rows = db.prepare("SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 12").all() as {
        name: string;
        bytes: number;
      }[];
      const free = (db.pragma("freelist_count", { simple: true }) as number) * (db.pragma("page_size", { simple: true }) as number);
      tables = Object.fromEntries([...rows.map((row) => [row.name, mib(row.bytes)]), ["(free pages)", mib(free)]]);
    } catch {
      // No dbstat in this build of SQLite: the report goes without the breakdown.
    }
    return { tables, requestsKept };
  } finally {
    db.close();
  }
}

interface Sample {
  readonly turn: number;
  readonly elapsedMs: number;
  readonly epoch: number;
  readonly heapMiB?: number;
  readonly checkpointRows: number;
  readonly databaseMiB: number;
  readonly afterRollover: boolean;
}

/** The store's files, write-ahead log included, in MiB: what the chat's history costs on disk. */
function databaseMiBOf(directory: string): number {
  const bytes = readdirSync(directory)
    .filter((name) => name.startsWith("tavi.sqlite"))
    .reduce((sum, name) => sum + statSync(join(directory, name)).size, 0);
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

describe.skipIf(!SOAK)("a chat that never ends, through the composed owner (soak)", () => {
  it(
    `takes ${TURNS} turns: every one completes, epochs advance, checkpoints and the database stay bounded and the heap stays flat`,
    async () => {
      const collect = exposeGc();
      const directory = directories.create("tavi-rollover-soak-");
      chmodSync(directory, 0o700);
      const logged: string[] = [];
      const { model, stats } = soakModel();
      const runtime = await composeTaviRuntime(
        fixtureRuntimeOptions(directory, {
          workspaces: [...workspaces],
          logger: { level: "error", sink: (entry: unknown) => void logged.push(JSON.stringify(entry)) },
          approvalRequiredFor: [],
        }),
        { modelOverride: model },
      );
      const samples: Sample[] = [];
      const failures: string[] = [];
      let databaseMiB = 0;
      let tables: Record<string, number> = {};
      let requestsKept = 0;
      let completed = 0;
      const started = performance.now();
      try {
        const workflow = runtime.workflow;
        if (workflow === undefined) throw new Error("workflow unavailable");
        const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "soak" };
        const rows = async (threadId: string) => (await workflow.checkpoints.listCheckpoints(threadId, 100_000)).length;
        let taskId: string | undefined;
        let threadId = "";
        let epochSeen = 0;
        for (let turn = 0; turn < TURNS; turn += 1) {
          const admitted = await workflow.admit({
            context,
            ...(taskId === undefined ? { kind: "start" as const } : { taskId, kind: "reply" as const }),
            operationKey: `soak-${turn}`,
            prompt: `turn ${turn}`,
          });
          if (admitted.outcome.status !== "completed")
            failures.push(`turn ${turn}: ${admitted.outcome.status} ${admitted.outcome.finalText ?? ""}`.slice(0, 300));
          if (failures.length > 0 || stats.violations.length > 0) break;
          completed += 1;
          taskId = admitted.taskId;
          threadId = admitted.threadId;
          const rolled = stats.latestEpoch > epochSeen;
          epochSeen = stats.latestEpoch;
          const periodic = (turn + 1) % SAMPLE_EVERY === 0 || turn === WARMUP_TURNS - 1 || turn === TURNS - 1;
          if (rolled || periodic) {
            samples.push({
              turn: turn + 1,
              elapsedMs: Math.round(performance.now() - started),
              epoch: stats.latestEpoch,
              checkpointRows: await rows(threadId),
              databaseMiB: databaseMiBOf(directory),
              afterRollover: rolled,
              ...(periodic ? { heapMiB: await heapMiB(collect) } : {}),
            });
          }
        }
      } finally {
        databaseMiB = databaseMiBOf(directory);
        await runtime.close();
        ({ tables, requestsKept } = inspect(join(directory, "tavi.sqlite")));
      }

      const durationMs = Math.round(performance.now() - started);
      const heap = samples.filter((sample) => sample.heapMiB !== undefined && sample.turn >= WARMUP_TURNS);
      const baseline = heap[0]?.heapMiB ?? 0;
      const peakHeap = Math.max(...heap.map((sample) => sample.heapMiB ?? 0));
      const afterRollover = samples.filter((sample) => sample.afterRollover);
      const report = {
        turns: TURNS,
        completed,
        durationMs,
        msPerTurn: Math.round((durationMs / Math.max(1, completed)) * 10) / 10,
        gcExposed: collect !== undefined,
        epochs: stats.latestEpoch,
        requests: stats.requests,
        toolSteps: stats.toolSteps,
        plainTurns: stats.plainTurns,
        toolOffered: stats.toolOffered,
        summaries: stats.summaries,
        flushes: stats.flushes,
        maxRequestMessages: stats.maxMessages,
        maxCheckpointRowsAfterRollover: Math.max(0, ...afterRollover.map((sample) => sample.checkpointRows)),
        databaseMiB,
        databaseBoundMiB: DATABASE_BASE_MIB + (DATABASE_MIB_PER_1000_TURNS * TURNS) / 1_000,
        tables,
        requestsKept,
        maxCheckpointRows: Math.max(0, ...samples.map((sample) => sample.checkpointRows)),
        heap: {
          baselineMiB: baseline,
          peakMiB: peakHeap,
          lastMiB: heap.at(-1)?.heapMiB,
          growthMiB: Math.round((peakHeap - baseline) * 10) / 10,
        },
        failures,
        violations: stats.violations,
        loggedErrors: logged.slice(-20),
        samples,
      };
      const out = process.env["TAVI_SOAK_REPORT"];
      if (out !== undefined) writeFileSync(out, JSON.stringify(report, null, 2));

      expect(failures).toEqual([]);
      expect(completed).toBe(TURNS);
      expect(stats.violations).toEqual([]);
      expect(logged.filter((line) => line.includes("BUDGET_EXCEEDED"))).toEqual([]);
      expect(stats.toolOffered, "memory.search is offered to the chat").toBe(true);
      expect(stats.maxMessages).toBeLessThan(MAX_CONVERSATION_MESSAGES);
      // Epochs advance: at least one rollover per ~1,000 turns.
      expect(stats.latestEpoch).toBeGreaterThanOrEqual(Math.max(1, Math.floor(TURNS / 1_000)));
      expect(afterRollover.length).toBeGreaterThan(0);
      // Every turn prunes its thread, rollover or not.
      for (const sample of samples)
        expect(sample.checkpointRows, `checkpoint rows after turn ${sample.turn}`).toBeLessThanOrEqual(CHECKPOINTS_KEPT);
      // Only the newest calls keep their whole request; the database grows by kilobytes a turn, not by requests.
      expect(requestsKept).toBeGreaterThan(0);
      expect(requestsKept).toBeLessThanOrEqual(DEFAULT_KEPT_MODEL_REQUESTS);
      expect(
        databaseMiB,
        `database MiB after ${TURNS} turns, samples ${samples.map((sample) => sample.databaseMiB).join(", ")}`,
      ).toBeLessThanOrEqual(DATABASE_BASE_MIB + (DATABASE_MIB_PER_1000_TURNS * TURNS) / 1_000);
      expect(heap.length).toBeGreaterThan(1);
      expect(
        peakHeap - baseline,
        `heap growth after warm-up (MiB), samples ${heap.map((sample) => sample.heapMiB).join(", ")}`,
      ).toBeLessThan(HEAP_GROWTH_MIB);
    },
    4 * 60 * 60 * 1_000,
  );
});
