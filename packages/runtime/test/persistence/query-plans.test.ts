/**
 * The query-plan gate: every SQL string the runtime hands to
 * `prepare()` — directly, or through the statement cache's `stmt(db, sql)` —
 * is run through `EXPLAIN QUERY PLAN` against a fresh schema, and
 * a full `SCAN` of a hot table — of its rows, or a walk of a whole index —
 * fails the suite.
 *
 * The SQL is extracted statically from `src/persistence/**`,
 * `src/routines/**` (the routine tables' queries live there) and `src/router/**`, the
 * directories that call `prepare()`: string literals,
 * template literals without interpolation, and `const` identifiers of the
 * same file that hold one. Dynamically built SQL (interpolated templates,
 * concatenation) is skipped — its plan depends on the pieces. Statements that
 * do not prepare against the main schema are skipped too, and pinned in
 * `UNPLANNABLE`.
 *
 * `KNOWN_SCANS` is the baseline of hot-table scans the schema has today, one
 * entry per scanning statement. A scan not on it fails: add an index, or, when
 * the scan is deliberate, add it to the list with a reason. A scan on it that
 * no longer happens also fails, so whoever removes one shrinks the list.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, expect, it } from "vitest";

import { SqliteStore } from "../../src/persistence/store.js";

const SOURCE_ROOT = join(import.meta.dirname, "../../src");
const SCANNED_DIRECTORIES = ["persistence", "router", "routines"];

/** Tables that grow with use and are read on hot paths: a full scan of one is a bug. */
const HOT_TABLES = new Set<string>([
  "tavi_admissions",
  "tavi_approval_links",
  "tavi_artifacts",
  "tavi_executions",
  "tavi_gate_observations",
  "tavi_memory_deletions",
  "tavi_memory_records",
  "tavi_messaging_inbox",
  "tavi_messaging_outbox",
  "tavi_plugin_hook_events",
  "tavi_routine_blob_refs",
  "tavi_routine_delivery_jobs",
  "tavi_routine_details",
  "tavi_routine_runs",
  "tavi_router_decisions",
  "tavi_tasks",
  "tavi_transcript_entries",
]);

/**
 * Scans of hot tables the schema has today, as `file | table | first 80
 * characters of the SQL`, listed once for each statement that scans (two
 * statements with the same key are two entries). Migration
 * `0024_hot_query_indexes` removed the entries it fixed; the rest are bounded or
 * scans nobody has filed yet.
 */
const KNOWN_SCANS = [
  // Bounded: `tavi_tasks_created_idx` (migration `0024_hot_query_indexes`) serves the order, so the
  // walk stops after `LIMIT` rows instead of sorting the table.
  "persistence/store/tasks.ts | tavi_tasks | SELECT * FROM tavi_tasks ORDER BY created_at DESC LIMIT ?",
  // Not filed. A restore carries the whole deletion journal over on purpose; the
  // pending count runs on the memory status read; the start-up reconcile walks the
  // journal once (pinned as the outer loop, so it never walks every memory record).
  "persistence/store/memory.ts | tavi_memory_deletions | SELECT DISTINCT r.record_id FROM tavi_memory_deletions d CROSS JOIN tavi_memory_",
  "persistence/administration.ts | tavi_memory_deletions | SELECT * FROM tavi_memory_deletions ORDER BY requested_at, deletion_id",
  "persistence/store/memory.ts | tavi_memory_deletions | SELECT COUNT(*) AS n FROM tavi_memory_deletions WHERE cleanup_status = 'pending'",
  // Not filed: `tavi_messaging_inbox_state_idx` is `(connection_id, state)`, so a count across connections walks it.
  "persistence/store/messaging.ts | tavi_messaging_inbox | SELECT COUNT(*) AS n FROM tavi_messaging_inbox WHERE state = 'received' AND (? I",
  // Not filed: the private-chat idle sweep groups the transcript of every chat.
  "persistence/transcript-repository.ts | tavi_transcript_entries | SELECT e.task_id, max(e.created_at) AS last_at FROM tavi_transcript_entries e JO",
  // Router. Not filed: no index on `tavi_router_decisions(owner_session)`, which
  // `recoverPreviousOwner` filters on.
  "router/repository.ts | tavi_router_decisions | SELECT task_id, operation_id, data FROM tavi_router_decisions WHERE owner_sessio",
];

/**
 * Statements that do not prepare against a fresh schema, as `file: error`: the
 * checkpoint tables live in their own database, and `tavi_owner` in the
 * ownership file. A new entry here is a statement the gate cannot see.
 */
const UNPLANNABLE = [
  "persistence/administration.ts: no such table: tavi_owner",
  "persistence/checkpoints.ts: no such table: checkpoints",
  "persistence/checkpoints.ts: no such table: writes",
  "persistence/ownership.ts: no such table: tavi_owner",
  "persistence/store/maintenance.ts: no such table: checkpoints",
];

type Statement = { readonly file: string; readonly line: number; readonly sql: string };

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** Reads the string or template literal starting at `start`, or `undefined` when it interpolates. */
function readLiteral(text: string, start: number): { value: string; end: number } | undefined {
  const quote = text[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
  let value = "";
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === quote) return { value, end: index + 1 };
    if (char === "\\") {
      const next = text[index + 1] as string;
      value += next === "n" ? "\n" : next === "t" ? "\t" : next === "\n" ? "" : next;
      index += 1;
    } else if (quote === "`" && char === "$" && text[index + 1] === "{") {
      return undefined;
    } else {
      value += char;
    }
  }
  return undefined;
}

/**
 * The `prepare()` and `stmt(db, …)` calls whose SQL argument is a static literal, or a
 * `const` of the same file that holds one. (A small scanner rather than a
 * parser: the repository's TypeScript 7 ships no JavaScript compiler API.)
 */
function extractStatements(path: string): Statement[] {
  const text = readFileSync(path, "utf8");
  const constants = new Map<string, string>();
  for (const match of text.matchAll(/\bconst\s+(\w+)(?:\s*:\s*string)?\s*=\s*/g)) {
    const literal = readLiteral(text, (match.index as number) + match[0].length);
    if (literal !== undefined && /^\s*;/.test(text.slice(literal.end))) constants.set(match[1] as string, literal.value);
  }
  const file = relative(SOURCE_ROOT, path);
  const statements: Statement[] = [];
  for (const match of text.matchAll(/(?:\.prepare\(|(?<![.\w])stmt\(\s*[\w.#]+(?:\(\))?\s*,)\s*/g)) {
    const start = (match.index as number) + match[0].length;
    const identifier = /^(\w+)\s*\)/.exec(text.slice(start));
    const literal = identifier === null ? readLiteral(text, start) : undefined;
    const sql =
      identifier !== null
        ? constants.get(identifier[1] as string)
        : literal !== undefined && /^\s*,?\s*\)/.test(text.slice(literal.end))
          ? literal.value
          : undefined;
    if (sql === undefined) continue;
    const line = text.slice(0, start).split("\n").length;
    statements.push({ file, line, sql });
  }
  return statements;
}

/** Removes quoted strings and comments, so placeholders and names are found only in SQL. */
function stripLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, "''");
}

/** Nulls for every placeholder: positional `?`/`?NNN`, and named `@x`/`:x`/`$x`. */
function nullBindings(sql: string): unknown[] {
  const bare = stripLiterals(sql);
  const numbered = [...bare.matchAll(/\?(\d+)/g)].map((match) => Number(match[1]));
  const anonymous = (bare.match(/\?(?!\d)/g) ?? []).length;
  const positional = Math.max(anonymous, ...numbered, 0);
  const named = [...bare.matchAll(/[@:$]([A-Za-z_]\w*)/g)].map((match) => match[1] as string);
  const bindings: unknown[] = Array.from({ length: positional }, () => null);
  if (named.length > 0) bindings.push(Object.fromEntries(named.map((name) => [name, null])));
  return bindings;
}

/** Alias → table, for `FROM`/`JOIN`/`UPDATE`/`INTO` clauses (the plan names a table by its alias). */
function aliases(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  const keywords = new Set([
    "WHERE",
    "ON",
    "SET",
    "JOIN",
    "LEFT",
    "INNER",
    "CROSS",
    "ORDER",
    "GROUP",
    "LIMIT",
    "USING",
    "VALUES",
    "RETURNING",
    "AS",
  ]);
  for (const match of stripLiterals(sql).matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi)) {
    const table = match[1] as string;
    map.set(table, table);
    const alias = match[2];
    if (alias !== undefined && !keywords.has(alias.toUpperCase())) map.set(alias, table);
  }
  return map;
}

/** `file | table | the statement's first 80 characters`: stable across line moves, readable in the list. */
function scanKey(file: string, table: string, sql: string): string {
  return `${file} | ${table} | ${sql.replace(/\s+/g, " ").trim().slice(0, 80)}`;
}

/** How many times each key occurs. */
function countKeys(keys: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
afterAll(() => {
  store.close();
});

it("no prepared statement fully scans a hot table beyond the known baseline", () => {
  const db = store.handle;
  const statements = SCANNED_DIRECTORIES.flatMap((directory) => sourceFiles(join(SOURCE_ROOT, directory))).flatMap(extractStatements);
  expect(statements.length).toBeGreaterThan(1000);

  const scans = new Map<string, string[]>();
  const skipped = new Set<string>();
  for (const { file, line, sql } of statements) {
    let rows: { detail: string }[];
    try {
      rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...nullBindings(sql)) as { detail: string }[];
    } catch (error) {
      skipped.add(`${file}: ${(error as Error).message}`);
      continue;
    }
    const tables = aliases(sql);
    for (const { detail } of rows) {
      const match = /^SCAN (\w+)/.exec(detail);
      if (match === null) continue;
      const table = tables.get(match[1] as string) ?? (match[1] as string);
      if (!HOT_TABLES.has(table)) continue;
      const key = scanKey(file, table, sql);
      const location = `${file}:${line}: ${detail}`;
      const locations = scans.get(key) ?? [];
      if (!locations.some((seen) => seen.startsWith(`${file}:${line}:`))) locations.push(location);
      scans.set(key, locations);
    }
  }

  expect([...skipped].sort(), "statements that no longer prepare against the schema").toEqual(UNPLANNABLE);
  const known = countKeys(KNOWN_SCANS);
  const added = [...scans].filter(([key, locations]) => locations.length > (known.get(key) ?? 0));
  const gone = [...known].filter(([key, count]) => (scans.get(key)?.length ?? 0) < count).map(([key]) => key);
  expect(
    added.map(([key, locations]) => `${locations.join("\n")}\n  ${key}`),
    "new full scans of hot tables",
  ).toEqual([]);
  expect(gone, "known scans that no longer happen: remove them from KNOWN_SCANS").toEqual([]);
});
