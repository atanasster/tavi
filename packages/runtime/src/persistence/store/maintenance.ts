import { errorMessage } from "@tavi/contracts/util";
import { MIGRATIONS, SAVER_TABLES } from "../migrations.js";
import type { StoreContext } from "./context.js";
import { EXPIRED_HELD_STRANGER_ROW } from "./messaging.js";

/** Free space below which `reclaimSpace` leaves the file alone: later writes reuse it. */
export const RECLAIM_MIN_FREE_BYTES = 32 * 1024 * 1024;

/**
 * Tables present in this database, for diagnostics and boundary checks. The
 * planner's `sqlite_stat*` tables (`PRAGMA optimize`) are SQLite's, not the schema's.
 */
export function listTables(store: StoreContext): readonly string[] {
  const rows = store.handle
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_stat%' ESCAPE '\\' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

export function listApplicationTables(store: StoreContext): readonly string[] {
  return listTables(store).filter((name) => name.startsWith("tavi_"));
}

/**
 * A fact about the directory itself, from `tavi_meta`.
 *
 * Distinct from application rows on purpose: the saver-schema marker is
 * written by *this* build about the shape it verified, and reading it back is
 * how `doctor` can tell that a directory was last opened by a different saver.
 */
export function getMeta(store: StoreContext, key: string): string | undefined {
  const row = store.handle.prepare("SELECT value FROM tavi_meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(store: StoreContext, key: string, value: string, now: string): void {
  store.handle
    .prepare(
      `INSERT INTO tavi_meta (key, value, updated_at) VALUES (@key, @value, @now)
       ON CONFLICT (key) DO UPDATE SET value = @value, updated_at = @now`,
    )
    .run({ key, value, now });
}

/**
 * SQLite's own integrity check.
 *
 * `quick` skips the index-vs-table cross-checks and is what a startup can
 * afford; `full` is the operator-invoked one. Both read every page of the
 * database, so this is never run on a one-shot command's ordinary path.
 */
export function integrityCheck(
  store: StoreContext,
  mode: "quick" | "full" = "quick",
): { readonly ok: boolean; readonly problems: readonly string[] } {
  try {
    const rows = store.handle.prepare(`PRAGMA ${mode === "quick" ? "quick_check" : "integrity_check"}`).all() as Record<string, unknown>[];
    // The pragma returns a single `ok` row when healthy, and one row per
    // problem otherwise; the column is named after the pragma.
    const problems = rows.map((row) => String(Object.values(row)[0] ?? "")).filter((text) => text !== "ok" && text !== "");
    return { ok: problems.length === 0, problems };
  } catch (error) {
    // A badly corrupt file makes SQLite's own check *throw* rather than return
    // a row — `SQLITE_NOTADB` ("file is not a database") or `SQLITE_CORRUPT`
    // ("database disk image is malformed"). That is the worst verdict the check
    // can give, never a reason to abort the caller: unhandled, it made `serve`
    // refuse to start (the opposite of this check's purpose) and made `doctor`
    // exit 70 with no report at all, bypassing the very branch it was added
    // for.
    return { ok: false, problems: [errorMessage(error)] };
  }
}

/**
 * Returns the file's free pages to the operating system. Deleting
 * rows — stripped model requests, pruned checkpoints — frees pages that
 * later writes reuse, so the file stops growing without this; this shrinks
 * it. With `auto_vacuum = INCREMENTAL` (every file this build creates) an
 * `incremental_vacuum` truncates the free pages; a file from an older build
 * (`auto_vacuum = NONE`) is rebuilt once with `VACUUM`, which also switches
 * it to incremental — only when at least half of it is free, so the copy is
 * no larger than what it frees. Either rewrite passes through the
 * write-ahead log, which keeps its size until truncated, so a
 * `wal_checkpoint(TRUNCATE)` follows (best effort: a reader holding an old
 * snapshot leaves it for the next pass). Below `RECLAIM_MIN_FREE_BYTES`
 * free, or in memory, nothing runs. Not inside a transaction: `VACUUM`
 * cannot be.
 */
export function reclaimSpace(store: StoreContext): {
  readonly autoVacuum: "none" | "full" | "incremental";
  readonly freeBytes: number;
  readonly reclaimedBytes: number;
  readonly action: "none" | "incremental_vacuum" | "vacuum";
} {
  const modes = ["none", "full", "incremental"] as const;
  const read = () => ({
    pageSize: store.handle.pragma("page_size", { simple: true }) as number,
    pages: store.handle.pragma("page_count", { simple: true }) as number,
    free: store.handle.pragma("freelist_count", { simple: true }) as number,
    mode: modes[store.handle.pragma("auto_vacuum", { simple: true }) as number] ?? "none",
  });
  const before = read();
  const freeBytes = before.free * before.pageSize;
  let action: "none" | "incremental_vacuum" | "vacuum" = "none";
  if (store.handle.name !== ":memory:" && freeBytes >= RECLAIM_MIN_FREE_BYTES) {
    if (before.mode === "incremental") {
      store.handle.pragma("incremental_vacuum");
      action = "incremental_vacuum";
    } else if (before.mode === "none" && before.free * 2 >= before.pages) {
      store.handle.pragma("auto_vacuum = INCREMENTAL");
      store.handle.exec("VACUUM");
      action = "vacuum";
    }
  }
  if (action !== "none") store.handle.pragma("wal_checkpoint(TRUNCATE)");
  const after = action === "none" ? before : read();
  return { autoVacuum: after.mode, freeBytes, reclaimedBytes: Math.max(0, (before.pages - after.pages) * before.pageSize), action };
}

/**
 * Refreshes the query planner's statistics where they have drifted
 * (`PRAGMA optimize`): `ANALYZE` on just the tables whose row counts moved
 * enough to change a plan, each sampling at most the connection's
 * `analysis_limit` (1000) rows per index, so it stays cheap on a large file. The
 * retention sweep runs it after its deletions; opening the file runs the
 * `0x10002` form once.
 */
export function optimizeQueryPlanner(store: StoreContext): void {
  store.handle.pragma("optimize");
}

/**
 * The migration ledger against the migrations this build ships: what has been
 * applied, what is pending, and any id this build does not know (which
 * `runMigrations` would refuse to open — reported here so `doctor` can say so
 * without composing a workflow).
 */
export function migrationStatus(store: StoreContext): {
  readonly applied: readonly string[];
  readonly latest: string | null;
  readonly unknown: readonly string[];
} {
  const applied = (
    store.handle.prepare("SELECT migration_id FROM tavi_schema_migrations ORDER BY migration_id").all() as {
      migration_id: string;
    }[]
  ).map((row) => row.migration_id);
  const known = new Set(MIGRATIONS.map((migration) => migration.id));
  // No `pending`: the constructor runs `runMigrations`, so by the time a store
  // exists every shipped migration has been applied — reporting a field that
  // cannot be non-empty invites a reader to treat "pending: []" as evidence.
  // `unknown` *is* reachable in
  // principle (a future refactor that stops refusing), and is the guard's
  // mirror, so it stays.
  return {
    applied,
    latest: applied.at(-1) ?? null,
    unknown: applied.filter((id) => !known.has(id)),
  };
}

/**
 * Row counts of the transport tables, for `doctor`.
 *
 * These are the tables a daily daemon grows without bound — one inbox row per
 * inbound chat message, one outbox row per send, one mailbox row per delegation
 * — so their size is the operator's early warning, before the disk is full.
 */
export function transportRowCounts(store: StoreContext): {
  readonly inbox: number;
  readonly inboxUnprocessed: number;
  readonly outbox: number;
  readonly mailbox: number;
  readonly waitIntents: number;
} {
  const count = (sql: string): number => (store.handle.prepare(sql).get() as { n: number }).n;
  return {
    inbox: count("SELECT COUNT(*) AS n FROM tavi_messaging_inbox"),
    // The rows that still need a decision or a reader: a design that holds a
    // message forever is invisible in the total.
    inboxUnprocessed: count("SELECT COUNT(*) AS n FROM tavi_messaging_inbox WHERE state = 'received'"),
    outbox: count("SELECT COUNT(*) AS n FROM tavi_messaging_outbox"),
    mailbox: count("SELECT COUNT(*) AS n FROM tavi_agent_mailbox"),
    waitIntents: count("SELECT COUNT(*) AS n FROM tavi_agent_wait_intents"),
  };
}

/**
 * A memory job's spend since `since` across `workspaceIds`, for `doctor`: its calls are the `purpose` attempts whose id
 * starts with `attemptPrefix` (the idle review's and consolidation's
 * `extraction`, the epoch flush's `summary`), on those workspaces' chats.
 * Failed counts the calls that ended without completing; one still running
 * is neither. Usage only: the calls keep no request.
 */
export function memoryCallSpend(
  store: StoreContext,
  input: {
    readonly workspaceIds: readonly string[];
    readonly since: string;
    readonly purpose: "extraction" | "summary";
    readonly attemptPrefix: string;
  },
): {
  readonly calls: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedUsd: number;
} {
  const row = store.handle
    .prepare(`SELECT count(*) AS calls,
      coalesce(sum(CASE WHEN a.state IN ('completed', 'started') THEN 0 ELSE 1 END), 0) AS failed,
      coalesce(sum(json_extract(a.data, '$.usage.inputTokens')), 0) AS input_tokens,
      coalesce(sum(json_extract(a.data, '$.usage.outputTokens')), 0) AS output_tokens,
      coalesce(sum(json_extract(a.data, '$.estimatedUsd')), 0) AS usd
    FROM tavi_provider_attempts a JOIN tavi_tasks t ON t.task_id = a.run_id
    WHERE t.workspace_id IN (SELECT value FROM json_each(?)) AND a.purpose = ? AND a.started_at >= ? AND substr(a.attempt_id, 1, ?) = ?`)
    .get(JSON.stringify(input.workspaceIds), input.purpose, input.since, input.attemptPrefix.length, input.attemptPrefix) as {
    readonly calls: number;
    readonly failed: number;
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly usd: number;
  };
  return { calls: row.calls, failed: row.failed, inputTokens: row.input_tokens, outputTokens: row.output_tokens, estimatedUsd: row.usd };
}

/**
 * Memory's embedding spend since `since` across the owner,
 * for `doctor`: the `embedding` attempts whose id starts with
 * `attemptPrefix` — the backfill's (run `memory-embeddings`, no task of a
 * workspace) and every turn's query. Usage only: the calls keep no request.
 */
export function memoryEmbeddingSpend(
  store: StoreContext,
  input: { readonly since: string; readonly attemptPrefix: string },
): { readonly calls: number; readonly failed: number; readonly inputTokens: number; readonly estimatedUsd: number } {
  const row = store.handle
    .prepare(`SELECT count(*) AS calls,
      coalesce(sum(CASE WHEN a.state IN ('completed', 'started') THEN 0 ELSE 1 END), 0) AS failed,
      coalesce(sum(json_extract(a.data, '$.usage.inputTokens')), 0) AS input_tokens,
      coalesce(sum(json_extract(a.data, '$.estimatedUsd')), 0) AS usd
    FROM tavi_provider_attempts a
    WHERE a.purpose = 'embedding' AND a.started_at >= ? AND substr(a.attempt_id, 1, ?) = ?`)
    .get(input.since, input.attemptPrefix.length, input.attemptPrefix) as {
    readonly calls: number;
    readonly failed: number;
    readonly input_tokens: number;
    readonly usd: number;
  };
  return { calls: row.calls, failed: row.failed, inputTokens: row.input_tokens, estimatedUsd: row.usd };
}

/**
 * Delete transport rows that are finished and older than the cutoff.
 *
 * Deliberately narrow: only rows whose state says nothing will read
 * them again — a resolved outbox row, a *processed* inbox row, a mailbox
 * envelope that is not `pending`, a settled wait intent. An unprocessed inbox
 * row is left alone because it is still somebody's message — unless its sender
 * has no binding and no turn has claimed it since the cutoff, a stranger's message held past the
 * cutoff (counted under `inbox`); the tasks, effects,
 * approvals, reports, artifacts and `tavi_task_prompt_snapshots` tables are
 * untouched because they are the audit trail rather than transport state, and a
 * delivered PDF is the deliverable. `dryRun` counts what would go without
 * deleting anything.
 */
export function pruneTransport(
  store: StoreContext,
  input: { readonly olderThan: string; readonly dryRun: boolean },
): {
  readonly inbox: number;
  readonly outbox: number;
  readonly mailbox: number;
  readonly waitIntents: number;
} {
  const targets = [
    { key: "inbox", table: "tavi_messaging_inbox", where: "state = 'processed' AND received_at < @olderThan" },
    // A stranger's held message expires too: nobody allowed its sender, so nothing will admit it, and anyone can send
    // one. Never a bound sender's, nor one a turn has claimed since the cutoff (`EXPIRED_HELD_STRANGER_ROW`).
    { key: "inbox", table: "tavi_messaging_inbox", where: EXPIRED_HELD_STRANGER_ROW },
    { key: "outbox", table: "tavi_messaging_outbox", where: "state = 'resolved' AND COALESCE(resolved_at, created_at) < @olderThan" },
    {
      key: "mailbox",
      table: "tavi_agent_mailbox",
      // Only when the *recipient task* is terminal: a `delivered` envelope for
      // a task that is still running is a reply that task has not read yet, and
      // `delivery_state` alone cannot tell the two apart.
      // The positive list is deliberate — an unrecognised status is kept.
      where:
        "delivery_state <> 'pending' AND created_at < @olderThan " +
        "AND recipient_task_id IN (SELECT task_id FROM tavi_tasks WHERE status IN ('completed', 'failed', 'stopped', 'cancelled'))",
    },
    { key: "waitIntents", table: "tavi_agent_wait_intents", where: "state = 'settled' AND deadline_at < @olderThan" },
  ] as const;
  const counts = { inbox: 0, outbox: 0, mailbox: 0, waitIntents: 0 };
  const run = (): void => {
    for (const target of targets) {
      if (input.dryRun) {
        const row = store.handle
          .prepare(`SELECT COUNT(*) AS n FROM ${target.table} WHERE ${target.where}`)
          .get({ olderThan: input.olderThan }) as { n: number };
        counts[target.key] += row.n;
        continue;
      }
      const result = store.handle.prepare(`DELETE FROM ${target.table} WHERE ${target.where}`).run({ olderThan: input.olderThan });
      counts[target.key] += result.changes;
    }
  };
  // One transaction: a prune that failed halfway would leave the tables
  // disagreeing about which era they hold.
  store.transaction(run);
  return counts;
}

/** Column names of one table, for the saver-shape check. */
export function tableColumns(store: StoreContext, table: string): readonly string[] {
  // The name comes from a fixed constant in `migrations.ts`, never from
  // operator input, and it is quoted regardless.
  const rows = store.handle.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
  return rows.map((row) => row.name);
}

export function listMeta(store: StoreContext): Readonly<Record<string, string>> {
  const rows = store.handle.prepare("SELECT key, value FROM tavi_meta ORDER BY key").all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

/** Tables owned by the pinned LangGraph saver; application code never migrates them. */
export function listSaverTables(store: StoreContext): readonly string[] {
  const owned = new Set<string>(SAVER_TABLES);
  return listTables(store).filter((name) => owned.has(name));
}

export function countCheckpoints(store: StoreContext): number {
  if (!listSaverTables(store).includes("checkpoints")) return 0;
  return (store.handle.prepare("SELECT COUNT(*) AS count FROM checkpoints").get() as { count: number }).count;
}
