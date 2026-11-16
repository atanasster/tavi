import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The `security.taint` rollout report: what `enforce` would have changed on a real data
 * directory, read from `tavi_gate_observations` and the approvals it joins.
 *
 *   node evals/injection/taint-report.ts [--data-dir <dir>] [--days 7] [--json]
 *
 * It never opens the data directory's database: it copies `tavi.sqlite` (and
 * its `-wal`/`-shm`) to a temporary directory, opens the copy (read-write, so
 * SQLite folds the copied WAL in), and deletes it. A running owner is not
 * disturbed. A copy taken while the owner checkpoints can be torn: it fails
 * its integrity check, and the report says to run again.
 *
 * The pure part (`taintReport`) scores rows and is tested in
 * `apps/cli/test/injection/taint-report.test.ts`. Erasable TypeScript, so
 * `node evals/injection/taint-report.ts` runs it with no build.
 */

// ------------------------------------------------------------------ rows

/** One `tavi_gate_observations` row, joined to the approval of the same call when there is one. */
export interface ObservationRow {
  readonly taskId: string;
  readonly callId: string;
  readonly toolId: string;
  readonly effect: string;
  readonly sink: string | null;
  /** What the gate decided: `allow` means the call ran unasked, so `enforce` would add an approval. */
  readonly decisionEnforced: "allow" | "ask" | "deny";
  readonly gateReason: string;
  readonly createdAt: string;
  /** The approval of that call (`tavi_approvals.state`), when the gate asked: granted, denied, expired, cancelled, pending. */
  readonly approvalState: string | null;
}

/** The data the report reads besides the observations: the window's tasks, and its ledgered calls per tool (the gated-rate denominator). */
export interface ReportInput {
  readonly now: string;
  readonly days: number;
  /** When the install first could record (migration `0138_gate_observations` applied); absent if it never did. */
  readonly recordingSince?: string | undefined;
  readonly observations: readonly ObservationRow[];
  /** Tasks active (updated) in the window since recording began. */
  readonly tasks: number;
  /** Ledgered (`tavi_effects`) calls per tool in the window: mutating and external calls only, so read-only tools have none. */
  readonly callsByTool: Readonly<Record<string, number>>;
}

// ------------------------------------------------------------------ the bars

/**
 * When `enforce` may become the default (bars proposed here):
 *
 * - at least 7 days of recording, and at least
 *   `minTasks` tasks in the window, so a rate means something;
 * - at most `maxExtraPerTask` extra approvals per task in the window;
 * - at most 1 extra approval per task that had an observation (more is a
 *   finding to fix before `enforce`);
 * - no tool with at least `minToolCalls` ledgered calls in the window that
 *   would have been asked, unasked today, on more than `maxToolGatedShare`
 *   of them (one tool class the taint step would make tedious).
 */
export const ENFORCE_BARS = {
  minDays: 7,
  minTasks: 30,
  maxExtraPerTask: 0.2,
  maxExtraPerObservedTask: 1,
  minToolCalls: 5,
  maxToolGatedShare: 0.25,
} as const;

// ------------------------------------------------------------------ the report

export interface Breakdown {
  readonly key: string;
  readonly calls: number;
  /** Of `calls`, run unasked today: the approvals `enforce` would add. */
  readonly neverAsked: number;
  readonly approved: number;
  readonly rejected: number;
  /** Asked, and the round expired, was cancelled or is still pending. */
  readonly unanswered: number;
  /** Denied by a rule or an unattended run, never asked. */
  readonly denied: number;
}

export interface FalseGateCandidate {
  readonly taskId: string;
  readonly callId: string;
  readonly toolId: string;
  readonly sink: string | null;
  readonly gateReason: string;
  /** Why it looks benign: it ran unasked under a rule or grant, or the person approved it when asked. */
  readonly why: "ran-unasked" | "approved";
  readonly createdAt: string;
}

export interface TaintReport {
  readonly now: string;
  readonly since: string;
  readonly days: number;
  readonly recordingSince?: string | undefined;
  /** Days of recording inside the window (0 when the install never recorded). */
  readonly recordingDays: number;
  readonly tasks: number;
  readonly observedTasks: number;
  readonly totals: Omit<Breakdown, "key">;
  readonly byReason: readonly Breakdown[];
  readonly byTool: readonly (Breakdown & { readonly ledgeredCalls?: number; readonly gatedShare?: number })[];
  readonly bySink: readonly Breakdown[];
  /** `enforce`'s extra approvals over the window's tasks, and over the tasks that had an observation. */
  readonly extraApprovalsPerTask: number;
  readonly extraApprovalsPerObservedTask: number;
  readonly falseGateCandidates: readonly FalseGateCandidate[];
  /** Of the observations, the share that look benign (`falseGateCandidates` over `calls`). */
  readonly falseGateRate: number;
  readonly verdict: { readonly decision: "enough-data" | "not-enough-data" | "over-the-bar"; readonly reasons: readonly string[] };
}

function outcomeOf(row: ObservationRow): "neverAsked" | "approved" | "rejected" | "unanswered" | "denied" {
  if (row.decisionEnforced === "allow") return "neverAsked";
  if (row.decisionEnforced === "deny") return "denied";
  if (row.approvalState === "granted") return "approved";
  if (row.approvalState === "denied") return "rejected";
  return "unanswered";
}

function breakdown(rows: readonly ObservationRow[], keyOf: (row: ObservationRow) => string): Breakdown[] {
  const groups = new Map<
    string,
    { calls: number; neverAsked: number; approved: number; rejected: number; unanswered: number; denied: number }
  >();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? { calls: 0, neverAsked: 0, approved: 0, rejected: 0, unanswered: 0, denied: 0 };
    group.calls += 1;
    group[outcomeOf(row)] += 1;
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => ({ key, ...group })).sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));
}

const ratio = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

/** Scores the observations of a window against `ENFORCE_BARS`. Pure. */
export function taintReport(input: ReportInput, bars: typeof ENFORCE_BARS = ENFORCE_BARS): TaintReport {
  const nowMs = Date.parse(input.now);
  const sinceMs = nowMs - input.days * 86_400_000;
  const since = new Date(sinceMs).toISOString();
  const rows = input.observations.filter((row) => Date.parse(row.createdAt) >= sinceMs && Date.parse(row.createdAt) <= nowMs);
  const recordingDays =
    input.recordingSince === undefined ? 0 : Math.max(0, (nowMs - Math.max(sinceMs, Date.parse(input.recordingSince))) / 86_400_000);
  const [all] = breakdown(rows, () => "all");
  const totals =
    all === undefined
      ? { calls: 0, neverAsked: 0, approved: 0, rejected: 0, unanswered: 0, denied: 0 }
      : (({ key: _key, ...rest }) => rest)(all);
  const observedTasks = new Set(rows.map((row) => row.taskId)).size;
  const byTool = breakdown(rows, (row) => row.toolId).map(
    (entry): Breakdown & { readonly ledgeredCalls?: number; readonly gatedShare?: number } => {
      const ledgered = input.callsByTool[entry.key];
      return ledgered === undefined || ledgered === 0
        ? entry
        : { ...entry, ledgeredCalls: ledgered, gatedShare: ratio(entry.neverAsked, ledgered) };
    },
  );
  const falseGateCandidates: FalseGateCandidate[] = rows
    .filter((row) => outcomeOf(row) === "neverAsked" || outcomeOf(row) === "approved")
    .map((row) => ({
      taskId: row.taskId,
      callId: row.callId,
      toolId: row.toolId,
      sink: row.sink,
      gateReason: row.gateReason,
      why: outcomeOf(row) === "approved" ? "approved" : "ran-unasked",
      createdAt: row.createdAt,
    }));
  const extraApprovalsPerTask = ratio(totals.neverAsked, input.tasks);
  const extraApprovalsPerObservedTask = ratio(totals.neverAsked, observedTasks);

  const short: string[] = [];
  if (recordingDays < bars.minDays) short.push(`${recordingDays.toFixed(1)} days of recording (needs ${bars.minDays})`);
  if (input.tasks < bars.minTasks) short.push(`${input.tasks} tasks in the window (needs ${bars.minTasks})`);
  const over: string[] = [];
  if (extraApprovalsPerTask > bars.maxExtraPerTask)
    over.push(`${extraApprovalsPerTask.toFixed(2)} extra approvals per task (bar ${bars.maxExtraPerTask})`);
  if (extraApprovalsPerObservedTask > bars.maxExtraPerObservedTask)
    over.push(
      `${extraApprovalsPerObservedTask.toFixed(2)} extra approvals per task with an observation (bar ${bars.maxExtraPerObservedTask})`,
    );
  for (const tool of byTool) {
    if (tool.ledgeredCalls !== undefined && tool.ledgeredCalls >= bars.minToolCalls && (tool.gatedShare ?? 0) > bars.maxToolGatedShare) {
      over.push(
        `${tool.key} would be asked on ${(100 * (tool.gatedShare ?? 0)).toFixed(0)}% of its ${tool.ledgeredCalls} calls (bar ${100 * bars.maxToolGatedShare}%)`,
      );
    }
  }
  const decision = short.length > 0 ? "not-enough-data" : over.length > 0 ? "over-the-bar" : "enough-data";
  return {
    now: input.now,
    since,
    days: input.days,
    ...(input.recordingSince === undefined ? {} : { recordingSince: input.recordingSince }),
    recordingDays,
    tasks: input.tasks,
    observedTasks,
    totals,
    byReason: breakdown(rows, (row) => row.gateReason),
    byTool,
    bySink: breakdown(rows, (row) => row.sink ?? "(none recorded)"),
    extraApprovalsPerTask,
    extraApprovalsPerObservedTask,
    falseGateCandidates,
    falseGateRate: ratio(falseGateCandidates.length, totals.calls),
    verdict: { decision, reasons: [...short, ...over] },
  };
}

// ------------------------------------------------------------------ text

function table(title: string, rows: readonly Breakdown[]): string[] {
  if (rows.length === 0) return [];
  return [
    `\n${title}`,
    "| key | would ask | never asked | approved | rejected | unanswered | denied |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map(
      (row) => `| ${row.key} | ${row.calls} | ${row.neverAsked} | ${row.approved} | ${row.rejected} | ${row.unanswered} | ${row.denied} |`,
    ),
  ];
}

export function formatTaintReport(report: TaintReport): string {
  const lines = [
    `security.taint rollout report, ${report.since.slice(0, 10)} to ${report.now.slice(0, 10)} (${report.days} days)`,
    `recording since: ${report.recordingSince ?? "never (migration 0138_gate_observations not applied)"}; ${report.recordingDays.toFixed(1)} days in the window`,
    `tasks in the window: ${report.tasks}; with an observation: ${report.observedTasks}`,
    `calls enforce would have asked: ${report.totals.calls} — never asked ${report.totals.neverAsked}, approved ${report.totals.approved}, rejected ${report.totals.rejected}, unanswered ${report.totals.unanswered}, denied ${report.totals.denied}`,
    `extra approvals per task: ${report.extraApprovalsPerTask.toFixed(2)} (per task with an observation: ${report.extraApprovalsPerObservedTask.toFixed(2)})`,
    `false-gate candidates: ${report.falseGateCandidates.length} (${(100 * report.falseGateRate).toFixed(0)}% of observations)`,
    ...table("By reason", report.byReason),
    ...table("By tool", report.byTool),
    ...table("By sink", report.bySink),
  ];
  if (report.falseGateCandidates.length > 0) {
    lines.push("\nFalse-gate candidates (benign-looking calls enforce would have asked; review each)");
    for (const candidate of report.falseGateCandidates)
      lines.push(
        `- ${candidate.createdAt} ${candidate.toolId} (${candidate.sink ?? "?"}, ${candidate.gateReason}) ${candidate.why} — task ${candidate.taskId}`,
      );
  }
  lines.push(
    `\nverdict: ${report.verdict.decision}${report.verdict.reasons.length === 0 ? "" : ` — ${report.verdict.reasons.join("; ")}`}`,
  );
  return `${lines.join("\n")}\n`;
}

// ------------------------------------------------------------------ the database

/** A copy of the data directory's database, opened read-only; the copy is deleted by `close`. */
async function openCopy(dataDirectory: string): Promise<{
  readonly db: { prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown } };
  close(): void;
}> {
  const source = join(dataDirectory, "tavi.sqlite");
  if (!existsSync(source)) throw new Error(`no tavi.sqlite in ${dataDirectory}`);
  const directory = mkdtempSync(join(tmpdir(), "tavi-taint-report-"));
  const remove = (): void => rmSync(directory, { recursive: true, force: true });
  let db: import("node:sqlite").DatabaseSync | undefined;
  try {
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, join(directory, `tavi.sqlite${suffix}`));
    const { DatabaseSync } = await import("node:sqlite");
    // Not `readOnly`: SQLite folds the copied WAL into the copy on open, and the copy is ours.
    db = new DatabaseSync(join(directory, "tavi.sqlite"));
    const check = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== "ok")
      throw new Error(`the copy of ${source} is not consistent (the owner wrote while it was copied); run the report again`);
  } catch (error) {
    db?.close();
    remove();
    throw error;
  }
  const opened = db;
  return {
    db: opened as never,
    close: () => {
      opened.close();
      remove();
    },
  };
}

export async function readReportInput(dataDirectory: string, now: string, days: number): Promise<ReportInput> {
  const { db, close } = await openCopy(dataDirectory);
  try {
    const since = new Date(Date.parse(now) - days * 86_400_000).toISOString();
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name),
    );
    // The baseline migration creates the observation table, so an install records from when it applied.
    const migration = tables.has("tavi_schema_migrations")
      ? (db.prepare("SELECT applied_at AS at FROM tavi_schema_migrations WHERE migration_id = '0001_baseline'").get() as
          | { at: string }
          | undefined)
      : undefined;
    const observations = !tables.has("tavi_gate_observations")
      ? []
      : (db
          .prepare(
            `SELECT o.task_id AS taskId, o.call_id AS callId, o.tool_id AS toolId, o.effect, o.sink, o.decision_enforced AS decisionEnforced,
              o.gate_reason AS gateReason, o.created_at AS createdAt,
              (SELECT a.state FROM tavi_approvals a WHERE a.task_id = o.task_id AND a.call_id = o.call_id ORDER BY a.created_at DESC LIMIT 1) AS approvalState
         FROM tavi_gate_observations o WHERE julianday(o.created_at) >= julianday(?) ORDER BY o.created_at`,
          )
          .all(since) as ObservationRow[]);
    // Tasks count only from when the install could record: an older task could never have been observed.
    const from = migration === undefined ? now : new Date(Math.max(Date.parse(since), Date.parse(migration.at))).toISOString();
    const tasks = (
      db.prepare("SELECT COUNT(*) AS n FROM tavi_tasks WHERE julianday(updated_at) >= julianday(?)").get(from) as { n: number }
    ).n;
    const callsByTool = Object.fromEntries(
      (
        db
          .prepare("SELECT tool_id AS toolId, COUNT(*) AS n FROM tavi_effects WHERE julianday(created_at) >= julianday(?) GROUP BY tool_id")
          .all(since) as { toolId: string; n: number }[]
      ).map((row) => [row.toolId, row.n]),
    );
    return { now, days, ...(migration === undefined ? {} : { recordingSince: migration.at }), observations, tasks, callsByTool };
  } finally {
    close();
  }
}

// ------------------------------------------------------------------ main

async function main(argv: readonly string[]): Promise<void> {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };
  const named = value("--data-dir") ?? (process.env["TAVI_DATA_DIR"] || undefined);
  if (named === undefined) throw new Error("--data-dir, or TAVI_DATA_DIR, names the data directory to report on");
  const dataDirectory = resolve(named);
  const days = Number(value("--days") ?? "7");
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days takes a positive number");
  const report = taintReport(await readReportInput(dataDirectory, value("--now") ?? new Date().toISOString(), days));
  process.stdout.write(argv.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : formatTaintReport(report));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
