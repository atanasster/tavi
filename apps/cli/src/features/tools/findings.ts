import {
  FindingWriteInputSchema,
  TASK_FINDING_MAX_CHARS,
  TaviError,
  oversizedFindingIndex,
  type TaskFinding,
  type TaskFindingRepositoryPort,
} from "@tavi/contracts";
import { clip } from "@tavi/contracts/util";
import type { ToolRegistry } from "@tavi/runtime";
import { z } from "zod";

/**
 * The task's findings and their check.
 *
 * - `findings.add` keeps records the agent gathered; `browser.extract` adds its
 *   own by itself. They stay with the task when its conversation is compacted.
 * - `findings.list` reads them back.
 * - `findings.check` holds them to the request's constraints — a maximum
 *   duration, a date window, a price limit — in code, not by a model's reading,
 *   and names the best by a field. The Sofia → Tampa answer gave ranges and no
 *   flight: a check over concrete records is what stops that.
 */

/** The most findings one `findings.list` or `findings.check` reads. */
const READ_LIMIT = 500;

const KindSchema = FindingWriteInputSchema.shape.kind;

const ListInputSchema = z.object({
  kind: KindSchema.optional(),
  afterSeq: z.number().int().nonnegative().optional(),
  /** With `afterSeq`, the task it counts in: a worker's, from a page's `nextAfterWorker`. */
  afterWorker: z.string().min(1).max(128).optional(),
  limit: z.number().int().positive().max(READ_LIMIT).optional(),
});

/** The most passing records one check shows, the best first: the rest are counted, and read with findings.list. */
const PASSING_SHOWN = 30;

const CONSTRAINT_OPERATORS = ["<", "<=", ">", ">=", "=", "!=", "between", "in", "contains", "exists"] as const;

const ConstraintSchema = z.object({
  field: z.string().min(1).max(200).describe("A field of the record, dotted for a nested one: price, outbound.durationHours"),
  op: z.enum(CONSTRAINT_OPERATORS),
  value: z
    .unknown()
    .optional()
    .describe("A number, a string (a date as YYYY-MM-DD compares in order), [low, high] for between, a list for in"),
  label: z.string().max(200).optional().describe("The constraint in the request's words: 'each direction under 21 hours'"),
});
export type FindingConstraint = z.infer<typeof ConstraintSchema>;

const CheckInputSchema = z.object({
  kind: KindSchema,
  constraints: z.array(ConstraintSchema).max(20),
  best: z
    .object({ field: z.string().min(1).max(200), order: z.enum(["lowest", "highest"]) })
    .optional()
    .describe("Which passing record is best: the lowest price, the shortest duration"),
});

/** `record`'s value at a dotted `path`. */
export function fieldOf(record: unknown, path: string): unknown {
  let value: unknown = record;
  for (const part of path.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/**
 * A price or amount as written, as its number: `€898`, `1,203.50 USD`,
 * `1.203,50 €`, `898,50 лв.`, `1 203 €`. With both separators the last is the
 * decimal one; a lone comma is a decimal comma unless three digits follow it
 * (`1,203`). `undefined` for anything else, a date (`2026-11-23`) included.
 */
export function amountOf(text: string): number | undefined {
  const plain = text.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(plain)) return undefined;
  const numeric = /^[^\d-]{0,5}(-?\d[\d.,\s\u00a0\u202f]*)[^\d]{0,6}$/.exec(plain)?.[1]?.replace(/[\s\u00a0\u202f]/g, "");
  if (numeric === undefined) return undefined;
  const dot = numeric.lastIndexOf(".");
  const comma = numeric.lastIndexOf(",");
  let normal: string;
  if (dot !== -1 && comma !== -1) normal = dot > comma ? numeric.replace(/,/g, "") : numeric.replace(/\./g, "").replace(",", ".");
  else if (comma !== -1)
    normal = /^-?\d{1,3}(,\d{3})+$/.test(numeric)
      ? numeric.replace(/,/g, "")
      : /^-?\d+,\d+$/.test(numeric)
        ? numeric.replace(",", ".")
        : "";
  else if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(numeric)) normal = numeric.replace(/\./g, "");
  else normal = numeric;
  const number = normal === "" ? Number.NaN : Number(normal);
  return Number.isFinite(number) ? number : undefined;
}

/** A value made comparable: a number as it is, an amount as written as its number (`amountOf`), else the string. */
function comparable(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  return amountOf(value) ?? value.trim();
}

function compare(left: number | string, right: number | string): number | undefined {
  if (typeof left !== typeof right) return undefined;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Why `record` fails `constraint`, or `undefined` when it holds. */
export function constraintFailure(record: unknown, constraint: FindingConstraint): string | undefined {
  const name =
    constraint.label ??
    `${constraint.field} ${constraint.op}${constraint.value === undefined ? "" : ` ${JSON.stringify(constraint.value)}`}`;
  const raw = fieldOf(record, constraint.field);
  if (constraint.op === "exists")
    return raw === undefined || raw === null || raw === "" ? `${name}: ${constraint.field} is missing` : undefined;
  if (raw === undefined || raw === null) return `${name}: ${constraint.field} is missing`;
  const actual = comparable(raw);
  const shown = JSON.stringify(raw);
  switch (constraint.op) {
    case "contains":
      return String(raw)
        .toLowerCase()
        .includes(String(constraint.value ?? "").toLowerCase())
        ? undefined
        : `${name}: ${shown}`;
    case "in":
      return Array.isArray(constraint.value) && constraint.value.some((option) => compare(comparable(option) ?? "", actual ?? "") === 0)
        ? undefined
        : `${name}: ${shown}`;
    case "between": {
      const bounds = Array.isArray(constraint.value) ? constraint.value.map(comparable) : [];
      const [low, high] = bounds;
      if (actual === undefined || low === undefined || high === undefined) return `${name}: ${shown} cannot be compared`;
      const above = compare(actual, low);
      const below = compare(actual, high);
      if (above === undefined || below === undefined) return `${name}: ${shown} cannot be compared`;
      return above >= 0 && below <= 0 ? undefined : `${name}: ${shown}`;
    }
    default: {
      const expected = comparable(constraint.value);
      if (actual === undefined || expected === undefined) return `${name}: ${shown} cannot be compared`;
      const order = compare(actual, expected);
      if (order === undefined) return `${name}: ${shown} cannot be compared with ${JSON.stringify(constraint.value)}`;
      const holds =
        constraint.op === "<"
          ? order < 0
          : constraint.op === "<="
            ? order <= 0
            : constraint.op === ">"
              ? order > 0
              : constraint.op === ">="
                ? order >= 0
                : constraint.op === "="
                  ? order === 0
                  : order !== 0;
      return holds ? undefined : `${name}: ${shown}`;
    }
  }
}

/** The findings that pass every constraint, the failures of those that do not, and the best of the passing. */
export function checkFindings(
  findings: readonly TaskFinding[],
  constraints: readonly FindingConstraint[],
  best?: { readonly field: string; readonly order: "lowest" | "highest" },
) {
  const passing: TaskFinding[] = [];
  const failing: { taskId: string; seq: number; failures: string[] }[] = [];
  for (const finding of findings) {
    const failures = constraints.flatMap((constraint) => constraintFailure(finding.record, constraint) ?? []);
    if (failures.length === 0) passing.push(finding);
    else failing.push({ taskId: finding.taskId, seq: finding.seq, failures });
  }
  let top: TaskFinding | undefined;
  if (best !== undefined) {
    for (const finding of passing) {
      const value = comparable(fieldOf(finding.record, best.field));
      if (value === undefined) continue;
      const current = top === undefined ? undefined : comparable(fieldOf(top.record, best.field));
      if (current === undefined) {
        top = finding;
        continue;
      }
      const order = compare(value, current);
      if (order !== undefined && (best.order === "lowest" ? order < 0 : order > 0)) top = finding;
    }
  }
  return { passing, failing, ...(top === undefined ? {} : { best: top }) };
}

/** The most findings a final step's digest lists. */
const KEPT_FINDINGS_DIGEST_MAX = 40;
/** The longest a final step's digest grows, in UTF-16 units. */
const DIGEST_MAX_CHARS = 8_000;
/** The longest one record's line in a digest: a large record is cut rather than crowding the rest out. */
const DIGEST_LINE_MAX_CHARS = 1_000;

/**
 * Findings as a final step reads them: one line each, with its kind
 * and source, a long one cut, the whole cut to the digest's bound; `more` says
 * the task kept others past these. `undefined` for none.
 */
export function digestFindings(findings: readonly TaskFinding[], more = false): string | undefined {
  if (findings.length === 0) return undefined;
  const lines: string[] = [];
  let chars = 0;
  for (const finding of findings) {
    const whole = `- [${finding.kind}] ${JSON.stringify(finding.record)}${finding.sourceUrl === undefined ? "" : ` (from ${finding.sourceUrl})`}`;
    const line = clip(whole, DIGEST_LINE_MAX_CHARS);
    if (chars + line.length > DIGEST_MAX_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
  }
  const left = findings.length - lines.length;
  if (left > 0 || more)
    lines.push(`- …and ${left > 0 ? `${left} more` : "more"}${more ? " the task kept (findings.list reads them)" : ""}`);
  return lines.join("\n");
}

/** The digest of what a task and its workers kept, for its final step (`WorkflowAdapterOptions.keptFindings`). */
export async function keptFindingsDigest(
  options: Pick<FindingsToolOptions, "findings" | "taskTree">,
  workspaceId: string,
  taskId: string,
): Promise<string | undefined> {
  const found = await treeFindings(options, workspaceId, taskId, undefined, KEPT_FINDINGS_DIGEST_MAX + 1);
  return digestFindings(found.slice(0, KEPT_FINDINGS_DIGEST_MAX), found.length > KEPT_FINDINGS_DIGEST_MAX);
}

export interface FindingsToolOptions {
  readonly findings: TaskFindingRepositoryPort;
  readonly now: () => string;
  /** The task and the workers under it: a planner reads what its browser workers kept. Without it, the task alone. */
  readonly taskTree?: (workspaceId: string, taskId: string) => Promise<readonly string[]>;
}

/** Each task of the tree's findings of `kind`, the task's own first, at most `limit` in all. */
async function treeFindings(
  options: Pick<FindingsToolOptions, "findings" | "taskTree">,
  workspaceId: string,
  taskId: string,
  kind: string | undefined,
  limit: number,
  after?: { readonly seq: number; readonly taskId: string },
): Promise<TaskFinding[]> {
  const tree =
    options.taskTree === undefined ? [taskId] : [taskId, ...(await options.taskTree(workspaceId, taskId)).filter((id) => id !== taskId)];
  // A page goes on from the task it ended in (the task's own, or a worker's), in the tree's order.
  const from = after === undefined ? 0 : tree.indexOf(after.taskId);
  if (from === -1) return [];
  const found: TaskFinding[] = [];
  for (const id of tree.slice(from)) {
    if (found.length >= limit) break;
    found.push(
      ...(await options.findings.list({
        taskId: id,
        workspaceId,
        kind,
        ...(after !== undefined && id === after.taskId ? { afterSeq: after.seq } : {}),
        limit: limit - found.length,
      })),
    );
  }
  return found;
}

const view = (finding: TaskFinding, own: string) => ({
  seq: finding.seq,
  kind: finding.kind,
  record: finding.record,
  ...(finding.sourceUrl === undefined ? {} : { sourceUrl: finding.sourceUrl }),
  ...(finding.taskId === own ? {} : { worker: finding.taskId }),
});

export function registerFindingsTools(registry: ToolRegistry, options: FindingsToolOptions): void {
  registry.register({
    id: "findings.add",
    sink: "none",
    version: "1.0.0",
    description:
      "Keep records you gathered for this task — flights, prices, listings — with the page they came from. They stay with the task when the conversation is shortened; browser.extract keeps its records by itself. Read them back with findings.list, and check them with findings.check before you answer.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: FindingWriteInputSchema,
    handler: async ({ input, context }) => {
      const parsed = FindingWriteInputSchema.parse(input);
      const oversized = oversizedFindingIndex(parsed.records);
      if (oversized !== -1)
        throw new TaviError(
          "INVALID_INPUT",
          `record ${oversized} is over ${TASK_FINDING_MAX_CHARS} characters: keep the fields the task needs`,
        );
      const added = await options.findings.add({
        taskId: context.runId,
        workspaceId: context.workspaceId,
        kind: parsed.kind,
        records: parsed.records,
        sourceUrl: parsed.sourceUrl,
        createdAt: options.now(),
      });
      return { added: added.length, ...(added.length === 0 ? {} : { from: added[0]?.seq, to: added.at(-1)?.seq }) };
    },
  });

  registry.register({
    id: "findings.list",
    sink: "none",
    version: "1.0.0",
    description:
      "The records this task and its workers have kept (findings.add, browser.extract), the task's own first, in the order they were found, of one kind or all. A worker's record names its task in `worker`. The next page: afterSeq (and afterWorker) from nextAfterSeq (and nextAfterWorker).",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: ListInputSchema,
    // Records are what pages said.
    untrustedOutput: true,
    outputSource: "routine-output",
    handler: async ({ input, context }) => {
      const parsed = ListInputSchema.parse(input);
      const limit = parsed.limit ?? 100;
      const after = parsed.afterSeq === undefined ? undefined : { seq: parsed.afterSeq, taskId: parsed.afterWorker ?? context.runId };
      const found = await treeFindings(options, context.workspaceId, context.runId, parsed.kind, limit + 1, after);
      const shown = found.slice(0, limit);
      const last = shown.at(-1);
      return {
        findings: shown.map((finding) => view(finding, context.runId)),
        // The next page starts after the last shown, in its own task: several tasks' records share numbers.
        ...(found.length > limit && last !== undefined
          ? { nextAfterSeq: last.seq, ...(last.taskId === context.runId ? {} : { nextAfterWorker: last.taskId }) }
          : {}),
      };
    },
  });

  registry.register({
    id: "findings.check",
    sink: "none",
    version: "1.0.0",
    description:
      'Check this task\'s records of a kind against the request\'s constraints, before answering: each constraint a field, an operator and a value (outbound.durationHours <= 21, departDate between ["2026-11-21", "2026-11-27"], price exists). ' +
      "Answers the records that pass, why the others fail, and with `best` the best passing one (the lowest price). Answer from passing records; when none pass, say which constraint none met rather than giving ranges.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: CheckInputSchema,
    untrustedOutput: true,
    outputSource: "routine-output",
    handler: async ({ input, context }) => {
      const parsed = CheckInputSchema.parse(input);
      const found = await treeFindings(options, context.workspaceId, context.runId, parsed.kind, READ_LIMIT);
      if (found.length === 0)
        return { checked: 0, passing: [], note: `no ${parsed.kind} records kept for this task: extract or add them first` };
      const result = checkFindings(found, parsed.constraints, parsed.best);
      // The answer first, the lists after — a long answer is cut from its end — and the best passing record first among them.
      const best = result.best;
      const ordered = best === undefined ? result.passing : [best, ...result.passing.filter((entry) => entry !== best)];
      return {
        checked: found.length,
        passed: result.passing.length,
        ...(best === undefined ? {} : { best: view(best, context.runId) }),
        ...(result.passing.length === 0 ? { note: "no record meets every constraint: say which constraint none met, not a range" } : {}),
        ...(result.passing.length > PASSING_SHOWN ? { morePassing: result.passing.length - PASSING_SHOWN } : {}),
        passing: ordered.slice(0, PASSING_SHOWN).map((entry) => view(entry, context.runId)),
        // A worker's record names its task: several tasks' records share numbers.
        failing: result.failing
          .slice(0, 50)
          .map(({ taskId, ...entry }) => (taskId === context.runId ? entry : { ...entry, worker: taskId })),
      };
    },
  });
}
