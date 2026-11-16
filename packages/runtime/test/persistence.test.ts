import { chmodSync, closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

import { EXECUTION_SUPERSEDED, MODEL_ROLES, TRUSTED_PUBLIC, TaviError, artifactLabel, untrustedLabel } from "@tavi/contracts";
import type { AdmitRequest } from "../src/persistence/internal-contracts.js";
import { APPLICATION_TABLES, FTS_SHADOW_TABLES, MIGRATIONS, SAVER_SCHEMA_VERSION, SAVER_SCHEMA_VERSION_KEY } from "@tavi/runtime";
import { runMigrations } from "../src/persistence/migrations.js";
import { loadBetterSqlite3 } from "../src/persistence/sqlite-loader.js";
import { SqliteStore } from "../src/persistence/store.js";
import { hasServiceOptions } from "../src/persistence/service-handlers.js";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@tavi/node-kit";
import { temporaryDirectories } from "@tavi/test-support";

const directories = temporaryDirectories();

function tempDirectory(): string {
  return directories.create("tavi-store-");
}

afterEach(() => {
  directories.cleanup();
});

describe("migrations", () => {
  it("creates only tavi_-prefixed application tables", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tables = store.listTables();
    // `sqlite_%` tables are SQLite's own bookkeeping (the `sqlite_sequence` row
    // counter behind an AUTOINCREMENT mapping table); every table this
    // application creates is `tavi_`-prefixed.
    expect(tables.filter((name) => !name.startsWith("tavi_") && !name.startsWith("sqlite_"))).toEqual([]);
    // Exact equality, not `arrayContaining`: the list is what a backup or an
    // export is qualified against, and a stale list would let anything built on
    // it report success while losing tables (messaging or delegation rows, say —
    // the conversational state a backup exists to keep). An omitted table fails here.
    expect([...tables].sort()).toEqual([...APPLICATION_TABLES, ...FTS_SHADOW_TABLES, "sqlite_sequence"].sort());
    store.close();
  });

  it("validates the collector settings row on the way out and on the way in", () => {
    // The settings row is validated like the project rows: a bare `JSON.parse` threw a raw
    // SyntaxError with no code out of `loadProjects`, killing collect.daily,
    // reports.generate and projects.get for the workspace, and a scalar JSON value
    // spread into a character-by-character `feedUrls`.
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const projects = store.asPort().repositories.projects;
    try {
      // A write outside the schema is refused before it can make the row unreadable.
      expect(() =>
        projects.putSettings({
          workspaceId: "default",
          settings: { news: { feedUrls: "https://a.example/rss" } } as never,
          now: "2026-01-01T00:00:00.000Z",
        }),
      ).toThrow(/not valid and was not written/);

      // A well-formed write round-trips.
      projects.putSettings({
        workspaceId: "default",
        settings: { lookbackDays: 7, news: { feedUrls: ["https://a.example/rss"], maxItemsPerProject: 3 } },
        now: "2026-01-01T00:00:00.000Z",
      });
      expect(projects.getSettings("default").news?.feedUrls).toEqual(["https://a.example/rss"]);

      // A hand-edited row is a typed refusal naming the row, not a raw SyntaxError.
      store.handle.prepare("UPDATE tavi_collector_settings SET news_feed_urls_json = ? WHERE workspace_id = 'default'").run("{oops");
      // Typed and named either way: the JSON parse reports the column, the schema
      // reports the row. What matters is that it is not a raw SyntaxError with no
      // code, which is what reached `collect.daily` before this.
      expect(() => projects.getSettings("default")).toThrow(/news feed URLs column is not valid JSON/);

      // …and a scalar JSON value is refused too, rather than iterated.
      store.handle
        .prepare("UPDATE tavi_collector_settings SET news_feed_urls_json = ? WHERE workspace_id = 'default'")
        .run('"https://a.example/rss"');
      expect(() => projects.getSettings("default")).toThrow(/collector settings row/);
    } finally {
      store.close();
    }
  });

  it("refuses a non-positive limit on the report history rather than reading everything", () => {
    // SQLite treats a negative LIMIT as
    // unbounded, so the guard is what makes it a typed refusal.
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    try {
      expect(() => store.asPort().repositories.reports.list({ workspaceId: "default", limit: -1 })).toThrow(/positive integer limit/);
      expect(() => store.asPort().repositories.reports.list({ workspaceId: "default", limit: 0 })).toThrow(/positive integer limit/);
    } finally {
      store.close();
    }
  });

  it("prunes artifacts past the window, never a pending one and never a report PDF", () => {
    // reports.generate writes a body plus a row per
    // call with no pruning, and browser.capture/download write one per step. The
    // sweep keeps the deliverable (a PDF a report row references) and the
    // undecided (a `pending` review item) and removes the rest.
    // File-backed: an artifact body is a file, and an in-memory store has no
    // artifacts directory at all.
    const directory = tempDirectory();
    const store = new SqliteStore({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      const artifacts = store.asPort().repositories.artifacts;
      const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
      const cutoff = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const shot = artifacts.putArtifact({ workspaceId: "default", contentType: "image/png", body: "png", extension: "png" });
      const pending = artifacts.putArtifact({
        workspaceId: "default",
        contentType: "text/plain",
        body: "review me",
        extension: "txt",
        reviewState: "pending",
      });
      const report = artifacts.putArtifact({ workspaceId: "default", contentType: "application/pdf", body: "%PDF", extension: "pdf" });
      const fresh = artifacts.putArtifact({ workspaceId: "default", contentType: "image/png", body: "new", extension: "png" });
      // Age three of them past the window, and reference the PDF from a report row.
      store.handle
        .prepare("UPDATE tavi_artifacts SET created_at = ? WHERE artifact_id IN (?, ?, ?)")
        .run(old, shot.artifactId, pending.artifactId, report.artifactId);
      store.asPort().repositories.reports.record({
        report: {
          reportId: "run-old",
          workspaceId: "default",
          runId: "run-old",
          artifactId: report.artifactId,
          periodStart: "2026-03-01",
          periodEnd: "2026-03-07",
          generatedAt: old,
          bytes: 4,
          projects: [],
        },
      });

      // Dry run counts only what would actually go.
      expect(store.pruneArtifacts({ olderThan: cutoff, dryRun: true })).toEqual({ artifacts: 1, bytes: 3 });
      expect(artifacts.getArtifact(shot.artifactId)).toBeDefined();

      expect(store.pruneArtifacts({ olderThan: cutoff, dryRun: false })).toEqual({ artifacts: 1, bytes: 3 });
      expect(artifacts.getArtifact(shot.artifactId)).toBeUndefined();
      // The row *and* the body: a row without its bytes would make a later read
      // fail with an I/O error instead of a clean refusal.
      expect(artifacts.readArtifactBody(shot.artifactId)).toBeUndefined();
      // The report PDF and the pending item stay; so does the fresh one.
      expect(artifacts.getArtifact(report.artifactId)).toBeDefined();
      expect(artifacts.readArtifactBody(report.artifactId)).toBeDefined();
      expect(artifacts.getArtifact(pending.artifactId)).toBeDefined();
      expect(artifacts.getArtifact(fresh.artifactId)).toBeDefined();

      // The explicit override takes the report too.
      expect(store.pruneArtifacts({ olderThan: cutoff, dryRun: false, includeReports: true }).artifacts).toBe(1);
      expect(artifacts.getArtifact(report.artifactId)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("prunes only finished transport rows past the cutoff, and can say so without deleting", () => {
    // Unpruned, these tables grow a daily daemon until the disk is full — and
    // then the alert about the disk being full cannot be
    // written. The sweep is deliberately narrow: a row whose state says nothing
    // will read it again, and old enough to be past the window.
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const handle = store.handle;
    const old = "2026-01-01T00:00:00.000Z";
    const cutoff = "2026-02-01T00:00:00.000Z";
    const fresh = "2026-03-01T00:00:00.000Z";
    const insertTask = handle.prepare(
      "INSERT INTO tavi_tasks (task_id, workspace_id, principal_id, thread_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertTask.run("task-1", "default", "operator", "thread-1", "completed", old, old);
    // A task that is still waiting: its delivered envelope is a reply it has not
    // read yet, so it must survive even though it is old and delivered.
    insertTask.run("task-waiting", "default", "operator", "thread-2", "waiting", old, old);

    const inbox = handle.prepare(
      "INSERT INTO tavi_messaging_inbox (connection_id, provider_event_id, kind, payload_json, state, received_at) VALUES (?, ?, 'message', '{}', ?, ?)",
    );
    inbox.run("telegram-main", "old-processed", "processed", old);
    inbox.run("telegram-main", "fresh-processed", "processed", fresh);
    // Still somebody's message: a bound sender's held row is never pruned, however old. (A stranger's is: the
    // held-stranger tests in `messaging-store.test.ts` cover that.)
    handle
      .prepare(
        "INSERT INTO tavi_messaging_inbox (connection_id, provider_event_id, kind, payload_json, state, received_at) VALUES ('telegram-main', 'old-received', 'message', ?, 'received', ?)",
      )
      .run(JSON.stringify({ externalSenderId: "friend" }), old);
    handle
      .prepare(
        "INSERT INTO tavi_messaging_identity_bindings (connection_id, external_sender_id, workspace_id, principal_id, approved_by, created_at) VALUES ('telegram-main', 'friend', 'default', 'alice', 'operator', ?)",
      )
      .run(old);

    const outbox = handle.prepare(
      "INSERT INTO tavi_messaging_outbox (effect_id, connection_id, message_json, state, created_at, resolved_at) VALUES (?, 'telegram-main', '{}', ?, ?, ?)",
    );
    outbox.run("msg-old", "resolved", old, old);
    outbox.run("msg-pending", "pending", old, null);

    const mailbox = handle.prepare(
      "INSERT INTO tavi_agent_mailbox (message_id, protocol_version, workspace_id, sender_agent_id, sender_task_id, recipient_agent_id, recipient_task_id, kind, created_at, delivery_state, retention_state) VALUES (?, 1, 'default', 'a', 'task-1', 'b', 'task-1', 'message', ?, ?, 'active')",
    );
    mailbox.run("mail-old", old, "delivered");
    mailbox.run("mail-pending", old, "pending");
    handle
      .prepare(
        "INSERT INTO tavi_agent_mailbox (message_id, protocol_version, workspace_id, sender_agent_id, sender_task_id, recipient_agent_id, recipient_task_id, kind, created_at, delivery_state, retention_state) VALUES (?, 1, 'default', 'a', 'task-1', 'b', 'task-waiting', 'message', ?, 'delivered', 'active')",
      )
      .run("mail-waiting", old);

    const wait = handle.prepare("INSERT INTO tavi_agent_wait_intents (wait_id, task_id, deadline_at, state) VALUES (?, 'task-1', ?, ?)");
    wait.run("wait-old", old, "settled");
    wait.run("wait-active", old, "active");

    expect(store.pruneTransport({ olderThan: cutoff, dryRun: true })).toEqual({ inbox: 1, outbox: 1, mailbox: 1, waitIntents: 1 });
    // Nothing moved yet.
    expect(handle.prepare("SELECT COUNT(*) AS n FROM tavi_messaging_inbox").get()).toEqual({ n: 3 });

    expect(store.pruneTransport({ olderThan: cutoff, dryRun: false })).toEqual({ inbox: 1, outbox: 1, mailbox: 1, waitIntents: 1 });
    expect(store.transportRowCounts()).toEqual({ inbox: 2, inboxUnprocessed: 1, outbox: 1, mailbox: 2, waitIntents: 1 });

    // The prompt tables are **outside** the sweep's scope by design: the snapshot
    // is the durable answer to "what did this task run under?", so a later
    // widening of this prune to the "audit trail" would be caught here rather
    // than silently dropping the only record of a task's base.
    const base = "the base it ran under";
    const digest = sha256Hex(base);
    handle
      .prepare(
        `INSERT INTO tavi_task_prompt_snapshots (task_id, workspace_id, source, text, hash, settings_revision, template_version, bound_at)
         VALUES ('task-1', 'default', 'workspace', ?, ?, 3, NULL, ?)`,
      )
      .run(base, digest, old);
    handle
      .prepare(
        `INSERT INTO tavi_workspace_system_prompts (workspace_id, text, revision, last_operation, previous_revision, actor, hash, updated_at)
         VALUES ('default', ?, 3, 'set', 2, 'operator:cli', ?, ?)`,
      )
      .run(base, digest, old);
    // Nothing left for the sweep to take, and it takes nothing else.
    expect(store.pruneTransport({ olderThan: cutoff, dryRun: false })).toEqual({ inbox: 0, outbox: 0, mailbox: 0, waitIntents: 0 });
    expect(handle.prepare("SELECT source, text, settings_revision FROM tavi_task_prompt_snapshots WHERE task_id = 'task-1'").get()).toEqual(
      { source: "workspace", text: base, settings_revision: 3 },
    );
    expect(handle.prepare("SELECT text, revision FROM tavi_workspace_system_prompts WHERE workspace_id = 'default'").get()).toEqual({
      text: base,
      revision: 3,
    });
    store.close();
  });

  it("reports integrity and the migration ledger against this build", () => {
    // `quick` is what a daemon startup
    // uses; `full` is what `doctor` uses.
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    expect(store.integrityCheck("quick")).toEqual({ ok: true, problems: [] });
    expect(store.integrityCheck("full")).toEqual({ ok: true, problems: [] });
    const status = store.migrationStatus();
    expect(status.unknown).toEqual([]);
    expect(status.latest).toBe(MIGRATIONS.at(-1)?.id ?? null);
    expect(status.applied).toHaveLength(MIGRATIONS.length);
    store.close();
  });

  it("records the saver schema it was set up with, so a version bump is visible", () => {
    // The pinned saver creates `checkpoints`/`writes` with `CREATE TABLE
    // IF NOT EXISTS`, so a changed shape is never applied to an existing
    // directory and the failure surfaces inside a graph run. `doctor` compares
    // this marker; composition writes it.
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    expect(store.getMeta(SAVER_SCHEMA_VERSION_KEY)).toBeUndefined();
    store.setMeta(SAVER_SCHEMA_VERSION_KEY, String(SAVER_SCHEMA_VERSION), "2026-01-01T00:00:00.000Z");
    expect(store.getMeta(SAVER_SCHEMA_VERSION_KEY)).toBe("1");
    store.setMeta(SAVER_SCHEMA_VERSION_KEY, "2", "2026-01-02T00:00:00.000Z");
    expect(store.listMeta()).toEqual({ [SAVER_SCHEMA_VERSION_KEY]: "2", "profile.format": "tavi-1" });
    store.close();
  });

  it("refuses a database written by a newer build instead of ignoring what it does not know", () => {
    // Migrations are forward-only, and unknown ids used to be skipped silently:
    // an older build would open a newer schema, skip the parts it does not know,
    // and write rows the newer build then reads under different assumptions.
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    store.handle
      .prepare("INSERT INTO tavi_schema_migrations (migration_id, applied_at) VALUES (?, ?)")
      .run("9999_future_from_newer_binary", "2026-01-01T00:00:00.000Z");
    try {
      runMigrations(store.handle);
      expect.unreachable("a newer schema must not be opened");
    } catch (error) {
      expect(error).toBeInstanceOf(TaviError);
      // `UNAVAILABLE`, not `INVALID_INPUT`: the operator's input was fine, and the
      // code is what keeps every CLI failure path agreeing on the exit code for
      // this refusal instead of one calling it a typo and another a crash.
      expect((error as TaviError).code).toBe("UNAVAILABLE");
      expect((error as TaviError).message).toContain("9999_future_from_newer_binary");
      expect((error as TaviError).message).toContain("not known to this build");
    } finally {
      store.close();
    }
  });

  it("is idempotent and records applied migrations", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const second = runMigrations(store.handle);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.length).toBeGreaterThan(0);
    const rows = store.handle.prepare("SELECT migration_id FROM tavi_schema_migrations ORDER BY migration_id").all() as {
      migration_id: string;
    }[];
    expect(rows.map((row) => row.migration_id)).toEqual(MIGRATIONS.map((migration) => migration.id));
    store.close();
  });

  it("stores exactly the roles the contract names: a role added to MODEL_ROLES needs a migration too", () => {
    // The tavi_model_roles CHECK lists these five; a new role would pass the schema and fail the table.
    expect([...MODEL_ROLES]).toEqual(["main", "extraction", "compaction", "fast", "embedding"]);
  });

  it("keeps configured search providers in the order added, refusing a duplicate or an invalid one before writing", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const providers = store.asPort().repositories.searchProviders;
    const now = "2026-01-01T00:00:00.000Z";
    providers.add({ providerId: "tavily-free", kind: "tavily", enabled: true, now });
    providers.add({ providerId: "home", kind: "searxng", baseUrl: "http://127.0.0.1:8888", enabled: true, now });
    providers.add({ providerId: "brave", kind: "brave", credentialRef: "brave.apiKey", enabled: true, now });
    expect(providers.list().providers.map((provider) => provider.providerId)).toEqual(["tavily-free", "home", "brave"]);
    expect(providers.get("home")).toMatchObject({ kind: "searxng", baseUrl: "http://127.0.0.1:8888", enabled: true });

    expect(() => providers.add({ providerId: "brave", kind: "serper", credentialRef: "serper.apiKey", enabled: true, now })).toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    for (const invalid of [
      { providerId: "no-key", kind: "brave" as const, enabled: true },
      { providerId: "keyed-searx", kind: "searxng" as const, baseUrl: "https://s.example", credentialRef: "k", enabled: true },
      { providerId: "no-base", kind: "searxng" as const, enabled: true },
      { providerId: "userinfo", kind: "searxng" as const, baseUrl: "https://user:pass@s.example", enabled: true },
      {
        providerId: "hosted-base",
        kind: "serper" as const,
        credentialRef: "serper.apiKey",
        baseUrl: "https://elsewhere.example",
        enabled: true,
      },
      { providerId: "Not A Slug", kind: "tavily" as const, enabled: true },
    ]) {
      expect(() => providers.add({ ...invalid, now }), invalid.providerId).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    }
    expect(providers.list().providers).toHaveLength(3);

    expect(providers.setEnabled("home", false, "2026-01-02T00:00:00.000Z")).toBe(true);
    expect(providers.get("home")).toMatchObject({ enabled: false, updatedAt: "2026-01-02T00:00:00.000Z" });
    expect(providers.remove("tavily-free")).toBe(true);
    expect(providers.remove("tavily-free")).toBe(false);
    // The table's CHECK is a second guard behind the schema.
    expect(() =>
      store.handle
        .prepare("INSERT INTO tavi_search_providers (provider_id, kind, enabled, created_at, updated_at) VALUES ('x', 'bing', 1, ?, ?)")
        .run(now, now),
    ).toThrowError(/CHECK/i);
    // A row that no longer parses is isolated, not thrown — and still a conflict for its id.
    store.handle
      .prepare("INSERT INTO tavi_search_providers (provider_id, kind, enabled, created_at, updated_at) VALUES ('broken', 'brave', 1, ?, ?)")
      .run(now, now);
    expect(providers.list()).toMatchObject({ unreadable: ["broken"] });
    expect(() => providers.add({ providerId: "broken", kind: "tavily", enabled: true, now })).toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    // The refusal says why, and a bad instant is refused before it can make a row unreadable.
    expect(() => providers.add({ providerId: "no-base", kind: "searxng", enabled: true, now })).toThrowError(
      /needs its instance's baseUrl/,
    );
    expect(() => providers.setEnabled("home", true, "yesterday")).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(providers.get("home")).toMatchObject({ enabled: false });
    store.close();
  });

  it("does not create or migrate a saver-owned table", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    expect(store.listSaverTables()).toEqual([]);
    store.close();
  });

  it("uses WAL and foreign keys", () => {
    const directory = tempDirectory();
    const store = new SqliteStore({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    expect(store.handle.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(store.handle.pragma("foreign_keys", { simple: true })).toBe(1);
    store.close();
  });

  it("tunes the page cache and planner on open, and refreshes statistics on demand", () => {
    const directory = tempDirectory();
    const store = new SqliteStore({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      expect(store.handle.pragma("cache_size", { simple: true })).toBe(-64000);
      expect(store.handle.pragma("temp_store", { simple: true })).toBe(2);
      expect(store.handle.pragma("mmap_size", { simple: true })).toBe(268435456);
      expect(store.handle.pragma("journal_size_limit", { simple: true })).toBe(67108864);
      expect(store.handle.pragma("analysis_limit", { simple: true })).toBe(1000);
      expect(() => store.optimize()).not.toThrow();
      // The planner's own tables are not the schema's.
      expect(store.listTables().filter((name) => name.startsWith("sqlite_stat"))).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("builds its repositories once", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    try {
      expect(store.asPort()).toBe(store.asPort());
      expect(store.asPort().repositories.tasks).toBe(store.asPort().repositories.tasks);
    } finally {
      store.close();
    }
  });

  it("adds the hot-query indexes to a data directory made before them", () => {
    const databasePath = join(tempDirectory(), "tavi.sqlite");
    const pre = new (loadBetterSqlite3())(databasePath);
    try {
      runMigrations(
        pre,
        MIGRATIONS.slice(
          0,
          MIGRATIONS.findIndex((migration) => migration.id === "0024_hot_query_indexes"),
        ),
      );
      expect(pre.prepare("SELECT 1 FROM sqlite_master WHERE name = 'tavi_tasks_created_idx'").get()).toBeUndefined();
    } finally {
      pre.close();
    }
    const store = new SqliteStore({ databasePath });
    try {
      const indexes = (
        store.handle
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (" + HOT_QUERY_INDEXES.map(() => "?").join(",") + ")")
          .all(...HOT_QUERY_INDEXES) as { name: string }[]
      ).map((row) => row.name);
      expect(indexes.sort()).toEqual([...HOT_QUERY_INDEXES].sort());
    } finally {
      store.close();
    }
  });
});

describe("service handlers", () => {
  it("shares the worker's handlers only with a request that configures nothing", () => {
    expect(hasServiceOptions(undefined)).toBe(false);
    expect(hasServiceOptions({})).toBe(false);
    expect(hasServiceOptions({ now: "2026-01-01T00:00:00.000Z" })).toBe(true);
    expect(hasServiceOptions({ ids: {} })).toBe(true);
    expect(hasServiceOptions({ quotas: { maxRecords: 1, maxBytes: 1 } })).toBe(true);
    expect(hasServiceOptions({ sharedRead: { workspaceId: "w", principalId: "p", allowed: false } })).toBe(true);
  });
});

const HOT_QUERY_INDEXES = [
  "tavi_plugin_hook_events_task_idx",
  "tavi_messaging_outbox_state_created_idx",
  "tavi_tasks_created_idx",
  "tavi_approval_links_question_idx",
  "tavi_memory_deletions_record_idx",
  "tavi_routine_details_run_idx",
  "tavi_routine_details_routine_idx",
  "tavi_routine_delivery_jobs_run_idx",
  "tavi_routine_blob_refs_routine_idx",
  "tavi_routine_blob_refs_artifact_idx",
];

describe("workspace settings", () => {
  const NOW = "2026-01-01T00:00:00.000Z";

  it("treats a workspace that never saved as revision zero with nothing set", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    expect(store.asPort().repositories.workspaceSettings.get("ws-1")).toEqual({
      workspaceId: "ws-1",
      settings: {},
      revision: 0,
      updatedAt: null,
      actor: null,
    });
    store.close();
  });

  it("replaces the whole document as a compare-and-set, keeping the row when every key is cleared", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const settings = store.asPort().repositories.workspaceSettings;
    const saved = settings.set({
      workspaceId: "ws-1",
      settings: { timezone: "Europe/Berlin" },
      expectedRevision: 0,
      actor: "operator:cli",
      now: NOW,
    });
    expect(saved).toEqual({
      workspaceId: "ws-1",
      settings: { timezone: "Europe/Berlin" },
      revision: 1,
      updatedAt: NOW,
      actor: "operator:cli",
    });
    const cleared = settings.set({ workspaceId: "ws-1", settings: {}, expectedRevision: 1, actor: "operator:ui", now: NOW });
    expect(cleared.settings).toEqual({});
    expect(cleared.revision).toBe(2);
    // A stale writer conflicts rather than overwriting, and names both revisions.
    let conflict: unknown;
    try {
      settings.set({ workspaceId: "ws-1", settings: { timezone: "UTC" }, expectedRevision: 1, actor: "operator:cli", now: NOW });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(TaviError);
    expect(conflict).toMatchObject({ code: "CONFLICT", details: { expectedRevision: 1, currentRevision: 2 } });
    expect(settings.get("ws-1").revision).toBe(2);
    expect(settings.get("ws-2").revision).toBe(0);
    store.close();
  });

  it("refuses a document the schema does not accept, reads past bad stored values, and keeps keys it does not know", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const settings = store.asPort().repositories.workspaceSettings;
    expect(() =>
      settings.set({ workspaceId: "ws-1", settings: { timezone: "Mars/Olympus" }, expectedRevision: 0, actor: "operator:cli", now: NOW }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(settings.get("ws-1").revision).toBe(0);
    settings.set({ workspaceId: "ws-1", settings: { timezone: "UTC" }, expectedRevision: 0, actor: "operator:cli", now: NOW });
    // Unparseable JSON reads as no settings rather than failing every model call.
    store.handle.prepare("UPDATE tavi_workspace_settings SET settings_json = '{not json' WHERE workspace_id = 'ws-1'").run();
    expect(settings.get("ws-1")).toMatchObject({ settings: {}, revision: 1 });
    // A bad value is dropped; a key from a newer build is ignored on read and kept on write.
    store.handle
      .prepare(
        `UPDATE tavi_workspace_settings SET settings_json = '{"timezone":"Mars/Olympus","futureKey":true}' WHERE workspace_id = 'ws-1'`,
      )
      .run();
    expect(settings.get("ws-1").settings).toEqual({});
    expect(
      settings.set({ workspaceId: "ws-1", settings: { timezone: "UTC" }, expectedRevision: 1, actor: "operator:cli", now: NOW }).settings,
    ).toEqual({ timezone: "UTC" });
    const raw = store.handle.prepare("SELECT settings_json FROM tavi_workspace_settings WHERE workspace_id = 'ws-1'").get() as {
      settings_json: string;
    };
    expect(JSON.parse(raw.settings_json)).toEqual({ futureKey: true, timezone: "UTC" });
    store.close();
  });
});

describe("workspace system prompt settings", () => {
  const NOW = "2026-01-01T00:00:00.000Z";

  it("treats a workspace that never saved as revision zero with no override", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const prompts = store.asPort().repositories.systemPrompts;
    expect(prompts.get("ws-1")).toEqual({
      workspaceId: "ws-1",
      text: null,
      revision: 0,
      updatedAt: null,
      lastOperation: null,
      previousRevision: null,
      actor: null,
      hash: null,
    });
    store.close();
  });

  it("stores the accepted text verbatim and keeps the revision monotonic across resets", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const prompts = store.asPort().repositories.systemPrompts;
    // Leading, trailing and repeated newlines are the case a trim-on-read design
    // silently loses, and `set --file` is exactly where they arrive.
    const text = "  keep\n\n  every\tcharacter  \n";
    const saved = prompts.set({ workspaceId: "ws-1", text, expectedRevision: 0, actor: "operator", now: NOW });
    expect(saved.text).toBe(text);
    expect(saved.revision).toBe(1);
    expect(saved.hash).toBe(sha256Hex(text));
    expect(saved.lastOperation).toBe("set");
    expect(saved.previousRevision).toBe(0);

    const reset = prompts.reset({ workspaceId: "ws-1", expectedRevision: 1, actor: "operator", now: NOW });
    expect(reset.text).toBeNull();
    expect(reset.revision).toBe(2);
    expect(reset.hash).toBeNull();
    expect(reset.lastOperation).toBe("reset");
    expect(reset.previousRevision).toBe(1);

    // The reset row survives, so an old revision can never match again (ABA).
    const again = prompts.reset({ workspaceId: "ws-1", expectedRevision: 2, actor: "operator", now: NOW });
    expect(again.revision).toBe(3);
    expect(() => prompts.set({ workspaceId: "ws-1", text: "x", expectedRevision: 1, actor: "operator", now: NOW })).toThrow(TaviError);
    expect(prompts.get("ws-1").revision).toBe(3);
    store.close();
  });

  it("isolates two workspaces", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const prompts = store.asPort().repositories.systemPrompts;
    prompts.set({ workspaceId: "ws-1", text: "one", expectedRevision: 0, actor: "operator", now: NOW });
    prompts.set({ workspaceId: "ws-2", text: "two", expectedRevision: 0, actor: "operator", now: NOW });
    expect(prompts.get("ws-1").text).toBe("one");
    expect(prompts.get("ws-2").text).toBe("two");
    expect(prompts.get("ws-3").text).toBeNull();
    store.close();
  });

  it("refuses a stale set or reset with CONFLICT, bounded revision details and no prompt text", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const prompts = store.asPort().repositories.systemPrompts;
    const sentinel = "UNIQUE-SENTINEL-CONFLICT-";
    const secretive = sentinel + "s".repeat(20_000 - sentinel.length);
    prompts.set({ workspaceId: "ws-1", text: secretive, expectedRevision: 0, actor: "operator", now: NOW });
    try {
      prompts.set({ workspaceId: "ws-1", text: "newer", expectedRevision: 0, actor: "operator", now: NOW });
      expect.unreachable("a stale write must not overwrite");
    } catch (error) {
      expect(error).toBeInstanceOf(TaviError);
      expect((error as TaviError).code).toBe("CONFLICT");
      expect((error as TaviError).details).toEqual({ expectedRevision: 0, currentRevision: 1 });
      // The whole error, not just `details`: a truncated prefix echoed into the
      // message would be the same leak.
      const whole = `${(error as TaviError).message} ${JSON.stringify((error as TaviError).details)}`;
      expect(whole).not.toContain(sentinel);
    }
    try {
      prompts.reset({ workspaceId: "ws-1", expectedRevision: 0, actor: "operator", now: NOW });
      expect.unreachable("a stale reset must not clear a newer override");
    } catch (error) {
      expect((error as TaviError).code).toBe("CONFLICT");
    }
    expect(prompts.get("ws-1").text).toBe(secretive);
    store.close();
  });

  it("rejects whitespace-only and over-limit text before writing, without echoing the text", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const prompts = store.asPort().repositories.systemPrompts;
    const overLimit = "UNIQUE-SENTINEL-OVERLIMIT-" + "x".repeat(20_000);
    for (const text of ["   ", "\n\t ", overLimit]) {
      try {
        prompts.set({ workspaceId: "ws-1", text, expectedRevision: 0, actor: "operator", now: NOW });
        expect.unreachable("invalid text must not be written");
      } catch (error) {
        expect((error as TaviError).code).toBe("INVALID_INPUT");
        const whole = `${(error as TaviError).message} ${JSON.stringify((error as TaviError).details)}`;
        expect(whole).not.toContain("UNIQUE-SENTINEL-OVERLIMIT-");
        // The documented shape, so an implementation that echoed a truncated
        // prefix into an extra detail key cannot pass this.
        expect(Object.keys((error as TaviError).details ?? {}).sort()).toEqual(["maxCodeUnits", "reason"]);
      }
    }
    expect(prompts.get("ws-1")).toEqual(expect.objectContaining({ revision: 0, text: null }));
    store.close();
  });

  it("reports a malformed expected revision as invalid input, not as a conflict", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const prompts = store.asPort().repositories.systemPrompts;
    // A fractional revision is a caller error: reporting it as `CONFLICT` would
    // tell the caller to re-read and retry a write that can never succeed.
    for (const expectedRevision of [0.5, -1, Number.MAX_SAFE_INTEGER + 2]) {
      try {
        prompts.set({ workspaceId: "ws-1", text: "base", expectedRevision, actor: "operator", now: NOW });
        expect.unreachable("a malformed revision must not be treated as a compare-and-set");
      } catch (error) {
        expect((error as TaviError).code).toBe("INVALID_INPUT");
      }
      expect(() => prompts.reset({ workspaceId: "ws-1", expectedRevision, actor: "operator", now: NOW })).toThrow(TaviError);
    }
    expect(prompts.get("ws-1").revision).toBe(0);
    store.close();
  });

  it("refuses a workspace id the record schema would not accept, before writing", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const prompts = store.asPort().repositories.systemPrompts;
    const tooLong = "w".repeat(200);
    try {
      prompts.set({ workspaceId: tooLong, text: "base", expectedRevision: 0, actor: "operator", now: NOW });
      expect.unreachable("an over-long workspace id must be refused");
    } catch (error) {
      expect((error as TaviError).code).toBe("INVALID_INPUT");
      expect(`${(error as TaviError).message} ${JSON.stringify((error as TaviError).details)}`).not.toContain(tooLong);
    }
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_workspace_system_prompts").get()).toEqual({ n: 0 });
    store.close();
  });

  it("refuses a stored setting whose hash does not describe its text", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const prompts = store.asPort().repositories.systemPrompts;
    prompts.set({ workspaceId: "ws-1", text: "real", expectedRevision: 0, actor: "operator", now: NOW });
    store.handle.prepare("UPDATE tavi_workspace_system_prompts SET hash = ? WHERE workspace_id = 'ws-1'").run("f".repeat(64));
    let refusal: TaviError | undefined;
    try {
      prompts.get("ws-1");
      expect.unreachable("a setting whose hash disagrees with its text must not be returned");
    } catch (error) {
      refusal = error as TaviError;
      expect(refusal.code).toBe("INTERNAL");
    }
    // The refusal must name the revision, because that is the only thing the
    // operator can assert to *clear* the override (`reset` is a
    // compare-and-set), and the message is all that reaches the CLI over IPC.
    expect(refusal?.message).toContain("revision 1");
    expect(refusal?.message).not.toContain("real");

    // Resetting at that revision repairs the row: the corruption must not be
    // able to block the one operation that removes it.
    const cleared = prompts.reset({ workspaceId: "ws-1", expectedRevision: 1, actor: "operator", now: NOW });
    expect(cleared).toEqual(expect.objectContaining({ text: null, revision: 2, hash: null, lastOperation: "reset", previousRevision: 1 }));
    // And the workspace is usable again: a new task resolves the shipped default
    // rather than failing on the row it could not read a moment ago.
    expect(prompts.get("ws-1").text).toBeNull();
    // A stale revision is still a CONFLICT rather than a second clear.
    expect(() => prompts.reset({ workspaceId: "ws-1", expectedRevision: 1, actor: "operator", now: NOW })).toThrow(
      /changed since it was read/,
    );
    store.close();
  });

  it("fails a hand-edited row on read rather than returning it", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const prompts = store.asPort().repositories.systemPrompts;
    prompts.set({ workspaceId: "ws-1", text: "fine", expectedRevision: 0, actor: "operator", now: NOW });
    // Two independent guards: the table's own CHECK refuses a value it can
    // state (a negative revision), and a row that passes the CHECK but fails the
    // schema (an over-long actor label, which the editor's bound covers) is
    // still a typed refusal (INTERNAL) on read rather than a silently wrong
    // prompt.
    expect(() => store.handle.prepare("UPDATE tavi_workspace_system_prompts SET revision = -1 WHERE workspace_id = 'ws-1'").run()).toThrow(
      /CHECK constraint failed/,
    );
    store.handle.prepare("UPDATE tavi_workspace_system_prompts SET actor = ? WHERE workspace_id = 'ws-1'").run("a".repeat(200));
    try {
      prompts.get("ws-1");
      expect.unreachable("an unreadable row must not be returned");
    } catch (error) {
      expect(error).toBeInstanceOf(TaviError);
      expect((error as TaviError).code).toBe("INTERNAL");
    }
    store.close();
  });

  it("persists an override across close and reopen", () => {
    const directory = tempDirectory();
    const databasePath = join(directory, "tavi.sqlite");
    const first = new SqliteStore({ databasePath, artifactsDirectory: join(directory, "artifacts") });
    first.asPort().repositories.systemPrompts.set({
      workspaceId: "ws-1",
      text: "line one\nline two\n",
      expectedRevision: 0,
      actor: "operator",
      now: NOW,
    });
    first.close();

    const second = new SqliteStore({ databasePath, artifactsDirectory: join(directory, "artifacts") });
    const reopened = second.asPort().repositories.systemPrompts.get("ws-1");
    expect(reopened.text).toBe("line one\nline two\n");
    expect(reopened.revision).toBe(1);
    second.close();
  });

  it("keeps two workspaces isolated, and their revisions monotonic, across close and reopen", () => {
    const directory = tempDirectory();
    const databasePath = join(directory, "tavi.sqlite");
    const first = new SqliteStore({ databasePath, artifactsDirectory: join(directory, "artifacts") });
    const prompts = first.asPort().repositories.systemPrompts;
    prompts.set({ workspaceId: "ws-1", text: "one", expectedRevision: 0, actor: "operator", now: NOW });
    prompts.reset({ workspaceId: "ws-1", expectedRevision: 1, actor: "operator", now: NOW });
    prompts.set({ workspaceId: "ws-2", text: "two", expectedRevision: 0, actor: "operator", now: NOW });
    first.close();

    const second = new SqliteStore({ databasePath, artifactsDirectory: join(directory, "artifacts") });
    const reopened = second.asPort().repositories.systemPrompts;
    expect(reopened.get("ws-1")).toEqual(expect.objectContaining({ text: null, revision: 2, lastOperation: "reset" }));
    expect(reopened.get("ws-2")).toEqual(expect.objectContaining({ text: "two", revision: 1 }));
    // The reset row survived the reopen, so the revision is still monotonic and
    // the pre-reset revision cannot be reused by a stale writer.
    expect(() => reopened.set({ workspaceId: "ws-1", text: "stale", expectedRevision: 1, actor: "operator", now: NOW })).toThrow(TaviError);
    second.close();
  });

  it("round-trips a bound task snapshot and refuses one whose hash does not match its text", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const { repositories } = store.asPort();
    const { task } = repositories.tasks.admit({
      workspaceId: "ws-1",
      principalId: "operator",
      operationKey: "op-snapshot",
      kind: "start",
      intent: { prompt: "hi" },
      checkpointNamespace: "",
      newTaskId: () => "task-snapshot",
      newAdmissionId: () => "adm-snapshot",
      newThreadId: () => "thread-snapshot",
      now: () => NOW,
    });
    // A task has no snapshot until the admission initializer supplies one, and
    // a missing row is corruption for a snapshot-bearing task — never a fallback.
    expect(repositories.tasks.getPromptSnapshot(task.taskId)).toBeUndefined();
    // An unknown task id is indistinguishable from a missing row at this read
    // (the port is documented that way).
    expect(repositories.tasks.getPromptSnapshot("task-that-does-not-exist")).toBeUndefined();

    const text = "x".repeat(30_000); // over the editor limit, inside the snapshot bound
    repositories.tasks.putTaskSnapshot({
      taskId: task.taskId,
      workspaceId: "ws-1",
      source: "explicit",
      text,
      hash: sha256Hex(text),
      revision: null,
      templateVersion: null,
      boundAt: NOW,
    });
    expect(repositories.tasks.getPromptSnapshot(task.taskId)).toEqual({
      taskId: task.taskId,
      workspaceId: "ws-1",
      source: "explicit",
      text,
      hash: sha256Hex(text),
      revision: null,
      templateVersion: null,
      boundAt: NOW,
    });

    // The identical snapshot is an idempotent retry (an initializer can replay),
    // but a different base for the same task is a typed CONFLICT: the snapshot is
    // immutable, and the row that is there must not change.
    expect(
      repositories.tasks.putTaskSnapshot({
        taskId: task.taskId,
        workspaceId: "ws-1",
        source: "explicit",
        text,
        hash: sha256Hex(text),
        revision: null,
        templateVersion: null,
        boundAt: "2026-02-01T00:00:00.000Z",
      }),
    ).toEqual(expect.objectContaining({ text, boundAt: NOW }));
    expect(() =>
      repositories.tasks.putTaskSnapshot({
        taskId: task.taskId,
        workspaceId: "ws-1",
        source: "builtin",
        text: "a different base",
        hash: sha256Hex("a different base"),
        revision: null,
        templateVersion: "v1",
        boundAt: NOW,
      }),
    ).toThrow(/already selected a different prompt base/);
    expect(repositories.tasks.getPromptSnapshot(task.taskId)).toEqual(expect.objectContaining({ text, source: "explicit" }));

    // A write whose hash is not the hash of its text is refused before it lands.
    expect(() =>
      repositories.tasks.putTaskSnapshot({
        taskId: "task-other",
        workspaceId: "ws-1",
        source: "builtin",
        text: "text",
        hash: sha256Hex("different"),
        revision: null,
        templateVersion: "v1",
        boundAt: NOW,
      }),
    ).toThrow(/hash does not match/);

    // Neither an orphan task id nor a workspace mismatch may surface as a raw
    // SqliteError from inside the store: admission runs this inside its
    // transaction, where an untyped throw aborts task creation with a SQL string.
    expect(() =>
      repositories.tasks.putTaskSnapshot({
        taskId: "task-not-admitted",
        workspaceId: "ws-1",
        source: "builtin",
        text: "text",
        hash: sha256Hex("text"),
        revision: null,
        templateVersion: "v1",
        boundAt: NOW,
      }),
    ).toThrow(TaviError);
    expect(() =>
      repositories.tasks.putTaskSnapshot({
        taskId: task.taskId,
        workspaceId: "ws-2",
        source: "builtin",
        text: "text",
        hash: sha256Hex("text"),
        revision: null,
        templateVersion: "v1",
        boundAt: NOW,
      }),
    ).toThrow(/must be in its task's workspace/);
    expect(repositories.tasks.getPromptSnapshot("task-not-admitted")).toBeUndefined();

    // A hand-edited row is refused on read instead of running a task on a base
    // it never selected.
    store.handle.prepare("UPDATE tavi_task_prompt_snapshots SET hash = ? WHERE task_id = ?").run(sha256Hex("other"), task.taskId);
    try {
      repositories.tasks.getPromptSnapshot(task.taskId);
      expect.unreachable("a corrupt snapshot must not be returned");
    } catch (error) {
      expect((error as TaviError).code).toBe("INTERNAL");
    }
    store.close();
  });
});

describe("TaskRepository", () => {
  const admitRequest = (operationKey: string, overrides: Partial<AdmitRequest> = {}): AdmitRequest => {
    let counter = 0;
    return {
      workspaceId: "ws-1",
      principalId: "operator",
      operationKey,
      kind: "start",
      intent: { prompt: "hello" },
      checkpointNamespace: "",
      newTaskId: () => `task-${operationKey}-${(counter += 1)}`,
      newAdmissionId: () => `adm-${operationKey}-${counter}`,
      newThreadId: () => `thread-${operationKey}`,
      now: () => "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  };

  it("admits a task and reads it back", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    const { task, admission, created } = tasks.admit(admitRequest("op-1"));
    expect(created).toBe(true);
    expect(task.status).toBe("admitted");
    expect(admission.state).toBe("pending");
    expect(tasks.get(task.taskId)?.threadId).toBe("thread-op-1");
    store.close();
  });

  it("resolves a retry to the same task and admission, never a second thread", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    const first = tasks.admit(admitRequest("op-retry"));
    const second = tasks.admit(admitRequest("op-retry"));
    expect(second.created).toBe(false);
    expect(second.task.taskId).toBe(first.task.taskId);
    expect(second.task.threadId).toBe(first.task.threadId);
    expect(second.admission.admissionId).toBe(first.admission.admissionId);
    expect(tasks.listAdmissions(first.task.taskId)).toHaveLength(1);
    store.close();
  });

  it("treats a same-key retry with different content as a conflict", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    tasks.admit(admitRequest("op-conflict", { intent: { prompt: "first" } }));
    expect(() => tasks.admit(admitRequest("op-conflict", { intent: { prompt: "different" } }))).toThrowError(
      /already admitted with different content/,
    );
    store.close();
  });

  it("ignores key ordering when hashing an intent", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    tasks.admit(admitRequest("op-order", { intent: { a: 1, b: { c: 2, d: 3 } } }));
    // Same intent, different literal key order: still the same admission.
    expect(() => tasks.admit(admitRequest("op-order", { intent: { b: { d: 3, c: 2 }, a: 1 } }))).not.toThrow();
    store.close();
  });

  it("records admission state transitions and status updates", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    const { task, admission } = tasks.admit(admitRequest("op-state"));
    tasks.setAdmissionState(admission.admissionId, "committed");
    expect(tasks.getAdmission(task.taskId, "op-state")?.state).toBe("committed");
    tasks.updateStatus(task.taskId, "completed", "done");
    expect(tasks.get(task.taskId)?.finalText).toBe("done");
    store.close();
  });

  it("lists tasks newest first", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    tasks.admit(admitRequest("older"));
    tasks.admit(admitRequest("newer", { now: () => "2026-02-01T00:00:00.000Z" }));
    expect(store.listTasks(10).map((task) => task.creationOperationKey)).toEqual(["newer", "older"]);
    store.close();
  });

  it("rolls a failed transaction back completely", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    expect(() =>
      store.transaction(() => {
        tasks.admit(admitRequest("op-rollback"));
        throw new Error("abort");
      }),
    ).toThrowError("abort");
    // The task and its admission intent are committed together or not at all.
    expect(tasks.getByOperationKey("ws-1", "operator", "op-rollback")).toBeUndefined();
    store.close();
  });

  it("supports re-entrant transactions", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    store.transaction(() => {
      store.transaction(() => tasks.admit(admitRequest("op-nested")));
    });
    expect(tasks.getByOperationKey("ws-1", "operator", "op-nested")).toBeDefined();
    store.close();
  });
});

describe("artifacts", () => {
  it("publishes a body, records its hash and reads it back", () => {
    const directory = tempDirectory();
    const store = new SqliteStore({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    const artifact = store.putArtifact({
      workspaceId: "ws-1",
      runId: "run-1",
      contentType: "text/plain",
      body: "hello",
      extension: "txt",
    });
    expect(artifact.byteSize).toBe(5);
    expect(artifact.sha256).toHaveLength(64);
    expect(store.getArtifact(artifact.artifactId)?.relativePath).toBe(artifact.relativePath);
    expect(new TextDecoder().decode(store.readArtifactBody(artifact.artifactId) ?? new Uint8Array())).toBe("hello");
    store.close();
  });

  it("stores an artifact's label, reads one it cannot parse as untrusted, and reads an unlabelled row by its flags", () => {
    const directory = tempDirectory();
    const store = new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
    const columns = (table: string) =>
      (store.handle.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
    // Six nullable label columns: absent means today's behaviour.
    expect(columns("tavi_artifacts")).toContain("label_json");
    expect(columns("tavi_memory_revisions")).toContain("provenance_json");
    expect(columns("tavi_agent_mailbox")).toContain("label_json");
    expect(columns("tavi_task_folders")).toContain("tainted_at");
    expect(columns("tavi_reminders")).toContain("label_json");
    expect(columns("tavi_routine_revisions")).toContain("provenance_json");
    const web = untrustedLabel("web", {
      confidentiality: "personal",
      principal: "host:example.com",
      ref: { ref: "c1", host: "example.com", at: "2026-10-13T00:00:00.000Z" },
    });
    const labelled = store.putArtifact({ workspaceId: "ws", contentType: "image/png", body: "png", extension: "png", label: web });
    expect(
      artifactLabel(store.putArtifact({ workspaceId: "ws", contentType: "text/plain", body: "clean", label: TRUSTED_PUBLIC })),
    ).toEqual(TRUSTED_PUBLIC);
    expect(labelled.label).toEqual(web);
    expect(store.getArtifact(labelled.artifactId)?.label).toEqual(web);
    expect(artifactLabel(store.getArtifact(labelled.artifactId) ?? labelled)).toEqual(web);
    const plain = store.putArtifact({ workspaceId: "ws", contentType: "text/plain", body: "a" });
    expect(store.getArtifact(plain.artifactId)).not.toHaveProperty("label");
    expect(store.handle.prepare("SELECT label_json FROM tavi_artifacts WHERE artifact_id = ?").get(plain.artifactId)).toEqual({
      label_json: null,
    });
    // No label: untrusted, from an unknown source (old rows fail safe), or an attachment when taken from outside.
    expect(artifactLabel(store.getArtifact(plain.artifactId) ?? plain)).toMatchObject({
      integrity: "untrusted",
      sources: ["unknown-source"],
    });
    const attachment = store.putArtifact({ workspaceId: "ws", contentType: "image/png", body: "b", untrusted: true });
    expect(artifactLabel(store.getArtifact(attachment.artifactId) ?? attachment)).toMatchObject({
      integrity: "untrusted",
      sources: ["attachment"],
    });
    const archive = store.putArtifact({ workspaceId: "ws", runId: "t1", contentType: "application/json", body: "[]", fold: "epoch" });
    expect(artifactLabel(store.getArtifact(archive.artifactId) ?? archive)).toMatchObject({
      integrity: "untrusted",
      sources: ["unknown-source"],
    });
    store.handle.prepare('UPDATE tavi_artifacts SET label_json = \'{"integrity":"trusted"}\' WHERE artifact_id = ?').run(plain.artifactId);
    expect(store.getArtifact(plain.artifactId)?.label).toMatchObject({ integrity: "untrusted", sources: ["unknown-source"] });
    store.close();
  });

  it("refuses a path that escapes the artifacts directory", () => {
    const directory = tempDirectory();
    const store = new SqliteStore({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    expect(() => store.resolveArtifactPath("../../etc/passwd")).toThrowError(TaviError);
    expect(() => store.resolveArtifactPath("../sibling/file")).toThrowError(/escapes/);
    store.close();
  });

  it("refuses artifacts when no directory is configured", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    expect(() => store.putArtifact({ workspaceId: "ws", contentType: "text/plain", body: "x" })).toThrowError(/No artifacts directory/);
    store.close();
  });

  it("defaults reviewState to approved, and honors an explicit pending", () => {
    const directory = tempDirectory();
    const store = new SqliteStore({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    const approved = store.putArtifact({ workspaceId: "ws-1", contentType: "text/plain", body: "a" });
    expect(approved.reviewState).toBe("approved");
    expect(approved.reviewedBy).toBeNull();
    expect(approved.reviewedAt).toBeNull();

    const pending = store.putArtifact({ workspaceId: "ws-1", contentType: "text/plain", body: "b", reviewState: "pending" });
    expect(pending.reviewState).toBe("pending");
    store.close();
  });

  it("setReviewState approves a pending artifact, then refuses a second decision with CONFLICT", () => {
    const directory = tempDirectory();
    const store = new SqliteStore({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    const artifact = store.putArtifact({ workspaceId: "ws-1", contentType: "text/plain", body: "a", reviewState: "pending" });
    store.setReviewState({
      artifactId: artifact.artifactId,
      reviewState: "approved",
      reviewedBy: "operator",
      reviewedAt: "2026-01-01T00:00:00.000Z",
    });
    const reviewed = store.getArtifact(artifact.artifactId);
    expect(reviewed?.reviewState).toBe("approved");
    expect(reviewed?.reviewedBy).toBe("operator");
    expect(reviewed?.reviewedAt).toBe("2026-01-01T00:00:00.000Z");

    expect(() =>
      store.setReviewState({
        artifactId: artifact.artifactId,
        reviewState: "rejected",
        reviewedBy: "operator-2",
        reviewedAt: "2026-01-01T00:00:01.000Z",
      }),
    ).toThrowError(/already has a terminal review state/);
    // The refused second call left the first decision untouched.
    expect(store.getArtifact(artifact.artifactId)?.reviewState).toBe("approved");
    store.close();
  });

  it("records a reviewer's note with the decision, and none when none was given", () => {
    // A rejection's note is what the model reads.
    const directory = tempDirectory();
    const store = new SqliteStore({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    const noted = store.putArtifact({ workspaceId: "ws-1", contentType: "text/plain", body: "a", reviewState: "pending" });
    const plain = store.putArtifact({ workspaceId: "ws-1", contentType: "text/plain", body: "b", reviewState: "pending" });
    store.setReviewState({
      artifactId: noted.artifactId,
      reviewState: "rejected",
      reviewedBy: "alice",
      reviewedAt: "2026-01-01T00:00:00.000Z",
      note: "it prints a token",
    });
    store.setReviewState({
      artifactId: plain.artifactId,
      reviewState: "approved",
      reviewedBy: "alice",
      reviewedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(store.getArtifact(noted.artifactId)?.reviewNote).toBe("it prints a token");
    expect(store.getArtifact(plain.artifactId)).not.toHaveProperty("reviewNote");
    store.close();
  });

  it("setReviewState throws NOT_FOUND for an unknown artifact", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    expect(() =>
      store.setReviewState({
        artifactId: "art-missing",
        reviewState: "approved",
        reviewedBy: "operator",
        reviewedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrowError(/No artifact art-missing/);
    store.close();
  });

  it("listPendingReview scopes by workspace, orders oldest first, and respects limit", () => {
    const directory = tempDirectory();
    const store = new SqliteStore({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    const wsA1 = store.putArtifact({ workspaceId: "ws-a", contentType: "text/plain", body: "1", reviewState: "pending" });
    const wsA2 = store.putArtifact({ workspaceId: "ws-a", contentType: "text/plain", body: "2", reviewState: "pending" });
    store.putArtifact({ workspaceId: "ws-b", contentType: "text/plain", body: "3", reviewState: "pending" });
    const approved = store.putArtifact({ workspaceId: "ws-a", contentType: "text/plain", body: "4" });
    store.setReviewState({
      artifactId: wsA1.artifactId,
      reviewState: "approved",
      reviewedBy: "operator",
      reviewedAt: "2026-01-01T00:00:00.000Z",
    });

    const pending = store.listPendingReview("ws-a", 10);
    // wsA1 was approved above, so only wsA2 remains pending for ws-a;
    // approved's own default and ws-b's artifact are both correctly excluded.
    expect(pending.map((record) => record.artifactId)).toEqual([wsA2.artifactId]);
    expect(pending.some((record) => record.artifactId === approved.artifactId)).toBe(false);

    // A third ws-a artifact, still pending, to exercise a genuine
    // oldest-first truncation (not just a single-row result).
    const wsA3 = store.putArtifact({ workspaceId: "ws-a", contentType: "text/plain", body: "5", reviewState: "pending" });
    const limited = store.listPendingReview("ws-a", 1);
    expect(limited.map((record) => record.artifactId)).toEqual([wsA2.artifactId]);
    expect(limited.some((record) => record.artifactId === wsA3.artifactId)).toBe(false);
    store.close();
  });

  it("listPendingReview rejects a negative limit rather than silently returning everything", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    expect(() => store.listPendingReview("ws-1", -1)).toThrowError();
    store.close();
  });
});

describe("store lifecycle", () => {
  it("persists data across close and reopen", () => {
    const directory = tempDirectory();
    const path = join(directory, "tavi.sqlite");
    const first = new SqliteStore({ databasePath: path, artifactsDirectory: join(directory, "artifacts") });
    const admitted = first.asPort().repositories.tasks.admit({
      workspaceId: "ws-1",
      principalId: "operator",
      operationKey: "op-persisted",
      kind: "start",
      intent: { prompt: "hello" },
      checkpointNamespace: "",
      newTaskId: () => "task-persisted",
      newAdmissionId: () => "adm-persisted",
      newThreadId: () => "thread-persisted",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    first.asPort().repositories.tasks.updateStatus(admitted.task.taskId, "completed", "ok");
    first.close();

    const second = new SqliteStore({ databasePath: path, artifactsDirectory: join(directory, "artifacts") });
    expect(second.getTask("task-persisted")?.finalText).toBe("ok");
    expect(second.getAdmission("task-persisted", "op-persisted")?.state).toBe("pending");
    second.close();
  });
});

describe("query bounds", () => {
  it("rejects a non-positive or non-integer list limit", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    // SQLite reads a negative LIMIT as "no limit", so it must never reach SQL.
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => store.listTasks(limit)).toThrowError(/positive integer/);
    }
    expect(store.listTasks(1)).toEqual([]);
    store.close();
  });
});

describe("admission identity", () => {
  let sequence = 0;
  const request = (overrides: Partial<AdmitRequest>): AdmitRequest => ({
    workspaceId: "ws-1",
    principalId: "operator",
    operationKey: "op",
    kind: "start",
    intent: { prompt: "hello" },
    checkpointNamespace: "",
    newTaskId: () => `task-${(sequence += 1)}`,
    newAdmissionId: () => `adm-${(sequence += 1)}`,
    newThreadId: () => `thread-${(sequence += 1)}`,
    now: () => "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  it("binds the admission kind, so a cancel cannot resolve a start's outcome", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    // An empty prompt and a cancel hash the same if the kind is not part of the
    // identity; resolving one to the other would let a cancellation inherit a
    // start's result.
    const started = tasks.admit(request({ operationKey: "op-kind", kind: "start", intent: { prompt: "" } }));
    tasks.commitAdmission({
      admissionId: started.admission.admissionId,
      taskId: started.task.taskId,
      state: "committed",
      result: { status: "completed", finalText: "started" },
    });

    expect(() => tasks.admit(request({ taskId: started.task.taskId, operationKey: "op-kind", kind: "cancel", intent: {} }))).toThrowError(
      /was admitted as "start", not "cancel"/,
    );
    store.close();
  });

  it("scopes a creation key to the principal that supplied it", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    const first = tasks.admit(request({ operationKey: "shared-key", principalId: "operator" }));
    tasks.commitAdmission({
      admissionId: first.admission.admissionId,
      taskId: first.task.taskId,
      state: "committed",
      result: { status: "completed", finalText: "operator's answer" },
    });

    // A different principal reusing the key gets its own task and thread, never
    // the other principal's record or outcome.
    const second = tasks.admit(request({ operationKey: "shared-key", principalId: "bob" }));
    expect(second.created).toBe(true);
    expect(second.task.taskId).not.toBe(first.task.taskId);
    expect(second.task.threadId).not.toBe(first.task.threadId);
    expect(second.task.principalId).toBe("bob");
    expect(second.admission.result).toBeNull();

    // The lookup is principal-scoped too.
    expect(tasks.getByOperationKey("ws-1", "bob", "shared-key")?.taskId).toBe(second.task.taskId);
    expect(tasks.getByOperationKey("ws-1", "carol", "shared-key")).toBeUndefined();
    store.close();
  });

  it("refuses a follow-up admission that targets another principal's task", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    const owned = tasks.admit(request({ operationKey: "op-owned", principalId: "operator" }));

    // A different principal supplying the same task id must not reach it.
    expect(() =>
      tasks.admit(
        request({
          taskId: owned.task.taskId,
          operationKey: "op-intruder",
          principalId: "bob",
          kind: "approval",
        }),
      ),
    ).toThrowError(/does not exist/);

    // The same principal may add a follow-up transition.
    const followUp = tasks.admit(
      request({
        taskId: owned.task.taskId,
        operationKey: "op-followup",
        principalId: "operator",
        kind: "approval",
      }),
    );
    expect(followUp.task.taskId).toBe(owned.task.taskId);
    expect(tasks.listAdmissions(owned.task.taskId)).toHaveLength(2);
    store.close();
  });

  it("persists the checkpoint namespace the graph writes under", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    const { task } = tasks.admit(request({ operationKey: "op-ns", checkpointNamespace: "subgraph/a" }));
    expect(task.checkpointNamespace).toBe("subgraph/a");
    expect(tasks.get(task.taskId)?.checkpointNamespace).toBe("subgraph/a");
    store.close();
  });

  it("records the outcome, the state and the task projection atomically", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    const { task, admission } = tasks.admit(request({ operationKey: "op-atomic" }));
    tasks.commitAdmission({
      admissionId: admission.admissionId,
      taskId: task.taskId,
      state: "committed",
      result: { status: "completed", finalText: "done" },
    });
    expect(tasks.getAdmission(task.taskId, "op-atomic")).toMatchObject({
      state: "committed",
      result: { status: "completed", finalText: "done" },
    });
    expect(tasks.get(task.taskId)).toMatchObject({ status: "completed", finalText: "done" });
    store.close();
  });

  it("rejects an unbounded admission intent", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    expect(() => tasks.admit(request({ operationKey: "op-huge", intent: { prompt: "x".repeat(300 * 1024) } }))).toThrowError(/exceeded/);
    // The task and admission were not created.
    expect(tasks.getByOperationKey("ws-1", "operator", "op-huge")).toBeUndefined();
    store.close();
  });
});

describe("task prompt snapshots", () => {
  const NOW = "2026-01-01T00:00:00.000Z";
  const request = (operationKey: string, overrides: Partial<AdmitRequest> = {}): AdmitRequest => {
    let counter = 0;
    return {
      workspaceId: "ws-1",
      principalId: "operator",
      operationKey,
      kind: "start",
      intent: { prompt: "hello" },
      checkpointNamespace: "",
      newTaskId: () => `task-${operationKey}-${(counter += 1)}`,
      newAdmissionId: () => `adm-${operationKey}-${counter}`,
      newThreadId: () => `thread-${operationKey}`,
      now: () => NOW,
      ...overrides,
    };
  };
  const bound = (taskId: string, text = "selected base") => ({
    taskId,
    workspaceId: "ws-1",
    source: "builtin" as const,
    text,
    hash: sha256Hex(text),
    revision: null,
    templateVersion: "v1",
    boundAt: NOW,
  });

  it("resolves the initializer in the task-creating branch and nowhere else", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    const created: string[] = [];
    const first = tasks.admit(
      request("op-snap", {
        initializeSnapshot: (task) => {
          created.push(task.taskId);
          return bound(task.taskId);
        },
      }),
    );
    expect(created).toEqual([first.task.taskId]);
    expect(tasks.getPromptSnapshot(first.task.taskId)).toEqual(bound(first.task.taskId));

    // A follow-up admission never replaces the task's own base: `AdmitResult.created`
    // is true for a new admission against an existing task too, so keying the
    // snapshot write off it would replace the base on every turn. A follow-up
    // prompt does re-resolve — into a pin of its own turn.
    const followUp = tasks.admit(
      request("op-snap-2", {
        taskId: first.task.taskId,
        kind: "reply",
        initializeSnapshot: (task) => {
          created.push(task.taskId);
          return bound(task.taskId, "replacement");
        },
      }),
    );
    expect(followUp.task.taskId).toBe(first.task.taskId);
    expect(created).toHaveLength(2);
    expect(tasks.getPromptSnapshot(first.task.taskId)).toEqual(bound(first.task.taskId));
    expect(tasks.getPromptSnapshot(first.task.taskId, followUp.admission.admissionId)).toEqual(bound(first.task.taskId, "replacement"));

    // A retry of the creation key resolves the same task and does not re-resolve.
    tasks.admit(
      request("op-snap", {
        initializeSnapshot: (task) => {
          created.push(task.taskId);
          return bound(task.taskId, "retry");
        },
      }),
    );
    expect(created).toHaveLength(2);
    store.close();
  });

  it("keeps a chat on its shipped template when a newer one ships, and still moves it to a workspace base", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    const first = tasks.admit(request("op-ship", { initializeSnapshot: (task) => bound(task.taskId, "first template") }));
    const newer = tasks.admit(
      request("op-ship-2", {
        taskId: first.task.taskId,
        kind: "reply",
        initializeSnapshot: (task) => ({ ...bound(task.taskId, "second template"), templateVersion: "v2" }),
      }),
    );
    expect(tasks.getPromptSnapshot(first.task.taskId, newer.admission.admissionId)).toEqual(bound(first.task.taskId, "first template"));
    const workspace = tasks.admit(
      request("op-ship-3", {
        taskId: first.task.taskId,
        kind: "reply",
        initializeSnapshot: (task) => ({
          ...bound(task.taskId, "our base"),
          source: "workspace" as const,
          revision: 1,
          templateVersion: null,
        }),
      }),
    );
    expect(tasks.getPromptSnapshot(first.task.taskId, workspace.admission.admissionId)).toMatchObject({
      source: "workspace",
      text: "our base",
    });
    // The override cleared: the chat goes back to a shipped template, the newest.
    const cleared = tasks.admit(
      request("op-ship-4", {
        taskId: first.task.taskId,
        kind: "reply",
        initializeSnapshot: (task) => ({ ...bound(task.taskId, "second template"), templateVersion: "v2" }),
      }),
    );
    expect(tasks.getPromptSnapshot(first.task.taskId, cleared.admission.admissionId)).toMatchObject({
      source: "builtin",
      text: "second template",
      templateVersion: "v2",
    });
    store.close();
  });

  it("rolls the task, the admission and the snapshot back together when the initializer throws", () => {
    // The initializer runs inside the repository's write transaction, so a
    // failure must leave nothing behind: a task with no snapshot is the
    // corruption state the model node refuses.
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    expect(() =>
      tasks.admit(
        request("op-fail", {
          initializeSnapshot: () => {
            throw new TaviError("INVALID_INPUT", "the workspace setting is unreadable");
          },
        }),
      ),
    ).toThrow(/unreadable/);
    expect(tasks.getByOperationKey("ws-1", "operator", "op-fail")).toBeUndefined();
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_admissions").get()).toEqual({ n: 0 });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_task_prompt_snapshots").get()).toEqual({ n: 0 });

    // A raw (untyped) throw is not swallowed either: it still aborts the whole
    // creation rather than leaving a half-written task.
    expect(() =>
      tasks.admit(
        request("op-raw", {
          initializeSnapshot: () => {
            throw new Error("boom");
          },
        }),
      ),
    ).toThrow(/boom/);
    expect(tasks.getByOperationKey("ws-1", "operator", "op-raw")).toBeUndefined();
    store.close();
  });

  it("refuses an initializer that returns a snapshot for another task, workspace, or hashes wrongly", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    expect(() =>
      tasks.admit(request("op-wrong", { initializeSnapshot: () => ({ ...bound("some-other-task"), taskId: "some-other-task" }) })),
    ).toThrow(TaviError);
    // The workspace mismatch is caught by the admission's own binding check, before
    // `putTaskSnapshot` looks at the record — the refusal names both ids so a caller
    // can see which one was wrong.
    expect(() =>
      tasks.admit(request("op-wrong-ws", { initializeSnapshot: (task) => ({ ...bound(task.taskId), workspaceId: "ws-2" }) })),
    ).toThrow(/bound to another task or workspace/);
    expect(() =>
      tasks.admit(request("op-wrong-hash", { initializeSnapshot: (task) => ({ ...bound(task.taskId), hash: sha256Hex("different") }) })),
    ).toThrow(/hash does not match/);
    expect(tasks.getByOperationKey("ws-1", "operator", "op-wrong")).toBeUndefined();
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_tasks").get()).toEqual({ n: 0 });
    store.close();
  });

  it("stores the creating admission's execution policy and never replaces it on a follow-up", () => {
    // The policy is durable task state, not a per-admission parameter: a reply,
    // wake or approval inherits what the task was created with, which is what
    // stops a scheduled run from becoming interactive by being answered.
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    const attended = { mode: "attended", humanQuestionsAllowed: true, workerWaitsAllowed: true } as const;
    const first = tasks.admit(request("op-policy", { executionPolicy: attended }));
    expect(tasks.get(first.task.taskId)?.executionPolicy).toEqual(attended);

    // A follow-up that tries to change the policy is ignored, not obeyed.
    tasks.admit(
      request("op-policy-2", {
        taskId: first.task.taskId,
        kind: "reply",
        executionPolicy: { mode: "unattended", humanQuestionsAllowed: false, workerWaitsAllowed: true },
      }),
    );
    expect(tasks.get(first.task.taskId)?.executionPolicy).toEqual(attended);

    // A creating admission that supplies none gets the conservative default.
    const bare = tasks.admit(request("op-policy-3"));
    expect(tasks.get(bare.task.taskId)?.executionPolicy).toEqual({
      mode: "unattended",
      humanQuestionsAllowed: false,
      workerWaitsAllowed: true,
    });
    store.close();
  });

  it("refuses a malformed execution policy before writing, and reads a hand-edited one fail-closed", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const { repositories } = store.asPort();
    // A caller's own value is refused before the INSERT.
    expect(() =>
      repositories.tasks.admit(
        request("op-bad-policy", { executionPolicy: { mode: "unattended", humanQuestionsAllowed: true, workerWaitsAllowed: true } }),
      ),
    ).toThrow(TaviError);
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_tasks").get()).toEqual({ n: 0 });

    // A hand-edited row resolves to the conservative policy rather than making
    // every task listing fail: `listTasks` feeds startup reconciliation.
    const { task } = repositories.tasks.admit(request("op-good-policy"));
    store.handle.prepare("UPDATE tavi_tasks SET execution_policy_json = ? WHERE task_id = ?").run("{oops", task.taskId);
    expect(repositories.tasks.get(task.taskId)?.executionPolicy).toEqual({
      mode: "unattended",
      humanQuestionsAllowed: false,
      workerWaitsAllowed: true,
    });
    expect(store.listTasks(10).map((row) => row.taskId)).toContain(task.taskId);
    store.close();
  });

  it("reads a row with no policy column as the conservative unattended policy", () => {
    // A hand-edited or restored row can arrive without a policy, and "unknown" has to resolve to something: the
    // resolution that cannot send a message nobody expects.
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    const { task } = tasks.admit(request("op-policy-null"));
    store.handle.prepare("UPDATE tavi_tasks SET execution_policy_json = NULL WHERE task_id = ?").run(task.taskId);
    expect(tasks.get(task.taskId)?.executionPolicy).toEqual({
      mode: "unattended",
      humanQuestionsAllowed: false,
      workerWaitsAllowed: true,
    });
    // A self-contradictory policy is refused on write (above) and read
    // fail-closed here, so no read path can deliver a question to nobody.
    store.handle
      .prepare("UPDATE tavi_tasks SET execution_policy_json = ? WHERE task_id = ?")
      .run('{"mode":"unattended","humanQuestionsAllowed":true,"workerWaitsAllowed":true}', task.taskId);
    expect(tasks.get(task.taskId)?.executionPolicy).toEqual({
      mode: "unattended",
      humanQuestionsAllowed: false,
      workerWaitsAllowed: true,
    });
    store.close();
  });

  it("admits inside an outer transaction, matching the savepoint degradation", () => {
    // `admit` now opens an immediate transaction. Nested inside an outer one,
    // better-sqlite3 runs it as a savepoint, and the snapshot must still commit
    // with the task rather than being lost to the nesting. This test does NOT
    // claim the immediate-lock guarantee survives nesting — it explicitly does
    // not, which is the caller obligation `admit`'s comment states.
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const tasks = store.asPort().repositories.tasks;
    const created = store.transaction(() => tasks.admit(request("op-nested-snap", { initializeSnapshot: (task) => bound(task.taskId) })));
    expect(tasks.getPromptSnapshot(created.task.taskId)).toEqual(bound(created.task.taskId));
    store.close();
  });

  it("rolls task creation back when the initializer's own settings read fails", () => {
    // The production initializer performs a durable read while the write lock is
    // held, so an unreadable settings row is a real failure mode of *task
    // creation*, not just of the settings editor. Fail-closed: no task with a
    // missing base is committed.
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const { repositories } = store.asPort();
    repositories.systemPrompts.set({
      workspaceId: "ws-1",
      text: "base",
      expectedRevision: 0,
      actor: "operator",
      now: NOW,
    });
    store.handle.prepare("UPDATE tavi_workspace_system_prompts SET hash = ? WHERE workspace_id = 'ws-1'").run(sha256Hex("some other text"));

    expect(() =>
      repositories.tasks.admit(
        request("op-corrupt-settings", {
          initializeSnapshot: (task) => {
            // Exactly what `selectWorkspacePromptSnapshot` does: read the
            // workspace record, which validates its own hash on the way out.
            const settings = repositories.systemPrompts.get(task.workspaceId);
            return bound(task.taskId, settings.text ?? "unreachable");
          },
        }),
      ),
    ).toThrow(TaviError);
    expect(repositories.tasks.getByOperationKey("ws-1", "operator", "op-corrupt-settings")).toBeUndefined();
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_tasks").get()).toEqual({ n: 0 });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_admissions").get()).toEqual({ n: 0 });
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_task_prompt_snapshots").get()).toEqual({ n: 0 });
    store.close();
  });
});

describe("execution ownership", () => {
  const request = (overrides: Partial<AdmitRequest> = {}): AdmitRequest => ({
    workspaceId: "ws-1",
    principalId: "operator",
    operationKey: "op-exec",
    kind: "start",
    intent: { prompt: "hello" },
    checkpointNamespace: "",
    newTaskId: () => "task-exec",
    newAdmissionId: () => "adm-exec",
    newThreadId: () => "thread-exec",
    now: () => "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  function storeWithTask(): { store: SqliteStore; taskId: string } {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const { task } = store.asPort().repositories.tasks.admit(request());
    return { store, taskId: task.taskId };
  }

  const acquire = (store: SqliteStore, taskId: string, ownerSession: string, now: string, leaseMs = 60_000) =>
    store.asPort().repositories.executions.acquire({
      taskId,
      ownerSession,
      admissionId: "adm-exec",
      leaseMs,
      now: () => now,
    });

  it("takes a generation and releases it cleanly", () => {
    const { store, taskId } = storeWithTask();
    const lease = acquire(store, taskId, "session-a", "2026-01-01T00:00:00.000Z");
    expect(lease.generation).toBe(1);

    store.asPort().repositories.executions.release({
      taskId,
      generation: 1,
      ownerSession: "session-a",
      now: () => "2026-01-01T00:00:01.000Z",
    });
    expect(store.asPort().repositories.executions.current(taskId)?.state).toBe("released");

    // The next admission takes a new generation.
    const next = acquire(store, taskId, "session-b", "2026-01-01T00:00:02.000Z");
    expect(next.generation).toBe(2);
    expect(
      store
        .asPort()
        .repositories.executions.list(taskId)
        .map((row) => row.state),
    ).toEqual(["released", "active"]);
    store.close();
  });

  it("refuses a competing owner while the lease is live", () => {
    const { store, taskId } = storeWithTask();
    acquire(store, taskId, "session-a", "2026-01-01T00:00:00.000Z");
    expect(() => acquire(store, taskId, "session-b", "2026-01-01T00:00:01.000Z")).toThrowError(/already executing under session-a/);
    store.close();
  });

  it("refuses a competitor after expiry and requires explicit termination", () => {
    const { store, taskId } = storeWithTask();
    acquire(store, taskId, "session-a", "2026-01-01T00:00:00.000Z", 1_000);

    // The plan is explicit: an expired lease signals investigation, not consent.
    expect(() => acquire(store, taskId, "session-b", "2026-01-01T02:00:00.000Z", 1_000)).toThrowError(/expired execution lease/);

    store.asPort().repositories.executions.terminate({
      taskId,
      generation: 1,
      confirmedTerminated: true,
      reason: "process killed, verified gone",
      terminatedBy: "test-operator",
      now: () => "2026-01-01T02:00:01.000Z",
    });
    const replacement = acquire(store, taskId, "session-b", "2026-01-01T02:00:02.000Z", 1_000);
    expect(replacement.generation).toBe(2);
    store.close();
  });

  it("refuses a stale generation and a foreign owner at the boundary", () => {
    const { store, taskId } = storeWithTask();
    const executions = store.asPort().repositories.executions;
    acquire(store, taskId, "session-a", "2026-01-01T00:00:00.000Z");
    executions.terminate({
      taskId,
      generation: 1,
      confirmedTerminated: true,
      reason: "test termination",
      terminatedBy: "test-operator",
      now: () => "2026-01-01T00:00:01.000Z",
    });
    acquire(store, taskId, "session-b", "2026-01-01T00:00:02.000Z");

    expect(() => executions.assertCurrentGeneration(taskId, 1, "session-a")).toThrowError();
    expect(() => executions.assertCurrentGeneration(taskId, 2, "session-a")).toThrowError(/owned by session-b/);
    // Marked, so a front end can tell "superseded while it ran" from "refused
    // before it ran anything".
    for (const [generation, owner] of [
      [1, "session-a"],
      [2, "session-a"],
      [9, "session-b"],
    ] as const) {
      try {
        executions.assertCurrentGeneration(taskId, generation, owner);
        expect.unreachable();
      } catch (error) {
        expect((error as TaviError).details).toEqual({ reason: EXECUTION_SUPERSEDED });
      }
    }
    expect(() => executions.assertCurrentGeneration(taskId, 2, "session-b")).not.toThrow();
    store.close();
  });

  it("re-enters for the same owner instead of starting a generation", () => {
    const { store, taskId } = storeWithTask();
    const first = acquire(store, taskId, "session-a", "2026-01-01T00:00:00.000Z");
    const second = acquire(store, taskId, "session-a", "2026-01-01T00:00:01.000Z");
    expect(second.generation).toBe(first.generation);
    expect(store.asPort().repositories.executions.list(taskId)).toHaveLength(1);
    store.close();
  });

  it("refuses to terminate an unknown generation", () => {
    const { store, taskId } = storeWithTask();
    expect(() =>
      store.asPort().repositories.executions.terminate({
        taskId,
        generation: 7,
        confirmedTerminated: true,
        reason: "test",
        terminatedBy: "test-operator",
        now: () => "2026-01-01T00:00:00.000Z",
      }),
    ).toThrowError(/No execution 7/);
    store.close();
  });
});

describe("approval rounds", () => {
  function storeWithTask(): { store: SqliteStore; taskId: string } {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const { task } = store.asPort().repositories.tasks.admit({
      workspaceId: "ws-1",
      principalId: "operator",
      operationKey: "op-approval",
      kind: "start",
      intent: { prompt: "hello" },
      checkpointNamespace: "",
      newTaskId: () => "task-approval",
      newAdmissionId: () => "adm-approval",
      newThreadId: () => "thread-approval",
      origin: "schedule",
      originScheduleId: "sched-1",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    return { store, taskId: task.taskId };
  }

  const request = (store: SqliteStore, taskId: string, callId: string, steps: number) =>
    store.asPort().repositories.approvals.request({
      approvalId: `approval:${taskId}:${steps}:${callId}`,
      taskId,
      admissionId: "adm-approval",
      toolId: "fixture.write",
      callId,
      steps,
      inputs: { value: "x" },
      now: () => "2026-01-01T00:00:00.000Z",
    });

  it("records the origin an admission was created with", () => {
    const { store, taskId } = storeWithTask();
    const task = store.asPort().repositories.tasks.get(taskId);
    // This decides whether an approval round belongs to a schedule fire in
    // flight or to an operator.
    expect(task?.origin).toBe("schedule");
    expect(task?.originScheduleId).toBe("sched-1");
  });

  it("keeps two rounds that reuse one callId as separate rows", () => {
    const { store, taskId } = storeWithTask();
    request(store, taskId, "call-1", 1);
    request(store, taskId, "call-1", 2);

    const rows = store.asPort().repositories.approvals.listForTask(taskId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.steps).sort()).toEqual([1, 2]);
  });

  it("lists a task's admissions in creation order even when two share a millisecond", () => {
    // `pendingRoundOf` reads "the latest admission with an outcome"; a tie on
    // `created_at` must not reorder them. The keys are inserted in reverse
    // alphabetical order: ordering by `created_at` alone returns tied rows in the
    // `(task_id, operation_key)` index order, which would pass with sorted keys.
    const { store, taskId } = storeWithTask();
    for (const key of ["op-z", "op-y", "op-x"]) {
      store.asPort().repositories.tasks.admit({
        workspaceId: "ws-1",
        principalId: "operator",
        taskId,
        operationKey: key,
        kind: "reply",
        intent: { prompt: key },
        checkpointNamespace: "",
        newTaskId: () => taskId,
        newAdmissionId: () => `adm-${key}`,
        newThreadId: () => "thread-approval",
        now: () => "2026-01-01T00:00:00.000Z",
      });
    }
    expect(
      store
        .asPort()
        .repositories.tasks.listAdmissions(taskId)
        .map((admission) => admission.operationKey),
    ).toEqual(["op-approval", "op-z", "op-y", "op-x"]);
    store.close();
  });

  it("answers the latest settled admission in one read: creation order, skipping refused and unsettled rows", () => {
    const { store, taskId } = storeWithTask();
    const tasks = store.asPort().repositories.tasks;
    const admit = (key: string) =>
      tasks.admit({
        workspaceId: "ws-1",
        principalId: "operator",
        taskId,
        operationKey: key,
        kind: "approval",
        intent: { resume: { approved: true, key } },
        checkpointNamespace: "",
        newTaskId: () => taskId,
        newAdmissionId: () => `adm-${key}`,
        newThreadId: () => "thread-approval",
        now: () => "2026-01-01T00:00:00.000Z",
      }).admission;
    const waiting = { status: "waiting" as const, finalText: "" };
    for (const key of ["op-z", "op-y"]) {
      tasks.commitAdmission({ admissionId: admit(key).admissionId, taskId, state: "committed", result: waiting });
    }
    // A refusal after them, and one still running: neither is the task's state.
    tasks.commitAdmission({
      admissionId: admit("op-refused").admissionId,
      taskId,
      state: "refused",
      result: { status: "failed", finalText: "stale", error: { code: "CONFLICT", message: "stale" } },
    });
    const running = admit("op-running");

    expect(tasks.latestSettledAdmission(taskId)?.operationKey).toBe("op-y");
    expect(tasks.latestSettledAdmission("task-none")).toBeUndefined();
    // The latest admission, whatever its state: what `listAdmissions(…).at(-1)` answers.
    expect(tasks.latestAdmission(taskId)).toEqual(tasks.listAdmissions(taskId).at(-1));
    expect(tasks.latestAdmission(taskId)?.operationKey).toBe("op-running");
    expect(tasks.latestAdmission("task-none")).toBeUndefined();
    // A turn runs once an admission is claimed and until its result is written.
    expect(tasks.hasRunningAdmission(taskId)).toBe(false);
    tasks.setAdmissionState(running.admissionId, "claimed");
    expect(tasks.hasRunningAdmission(taskId)).toBe(true);
    tasks.commitAdmission({
      admissionId: running.admissionId,
      taskId,
      state: "committed",
      result: { status: "completed", finalText: "done" },
    });
    expect(tasks.hasRunningAdmission(taskId)).toBe(false);
    expect(tasks.hasRunningAdmission("task-none")).toBe(false);
    store.close();
  });

  it("does not overwrite a cancelled task's status with a later admission's outcome", () => {
    // Cancellation is authoritative: the admission refused on a cancelled task
    // commits `failed`/`CANCELLED`, and projecting it turned the task `failed`.
    const { store, taskId } = storeWithTask();
    const tasks = store.asPort().repositories.tasks;
    tasks.updateStatus(taskId, "cancelled", "stopped by operator");
    tasks.commitAdmission({
      admissionId: "adm-approval",
      taskId,
      state: "failed",
      result: { status: "failed", finalText: "cancelled", error: { code: "CANCELLED", message: "stopped" } },
    });
    expect(tasks.get(taskId)?.status).toBe("cancelled");
    expect(tasks.getAdmission(taskId, "op-approval")?.result?.error?.code).toBe("CANCELLED");
    store.close();
  });
});

describe("the anthropic-messages connection kind migration", () => {
  it("keeps every saved connection and its fields, and takes the new kind after", () => {
    const directory = directories.create("tavi-kind-");
    const databasePath = join(directory, "tavi.sqlite");
    // A directory an older build made: the baseline alone.
    const older = new (loadBetterSqlite3())(databasePath);
    runMigrations(older, MIGRATIONS.slice(0, 1));
    older
      .prepare(
        "INSERT INTO tavi_model_connections (connection_id, label, kind, base_url, credential_ref, default_model, local_only, created_at, updated_at, wire_api) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "saved",
        "Saved",
        "openai-compatible",
        "https://api.anthropic.com/v1",
        "anthropic.key",
        "claude-opus-5-5",
        0,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "chat",
      );
    expect(() =>
      older.prepare("UPDATE tavi_model_connections SET kind = 'anthropic-messages' WHERE connection_id = 'saved'").run(),
    ).toThrowError(/CHECK constraint/);
    older.close();
    const store = new SqliteStore({ databasePath });
    try {
      expect(
        store.handle.prepare("SELECT connection_id, kind, base_url, default_model, wire_api FROM tavi_model_connections").all(),
      ).toEqual([
        {
          connection_id: "saved",
          kind: "openai-compatible",
          base_url: "https://api.anthropic.com/v1",
          default_model: "claude-opus-5-5",
          wire_api: "chat",
        },
      ]);
      store.handle.prepare("UPDATE tavi_model_connections SET kind = 'anthropic-messages' WHERE connection_id = 'saved'").run();
      expect(() =>
        store.handle.prepare("UPDATE tavi_model_connections SET kind = 'other' WHERE connection_id = 'saved'").run(),
      ).toThrowError(/CHECK constraint/);
    } finally {
      store.close();
    }
  });
});

describe("an older build's migration list", () => {
  it("is refused by an older build once applied, so rollback is a restore", () => {
    // A directory this build migrated, opened by a build whose migration list
    // stops just before this build's last migration.
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const last = MIGRATIONS.at(-1)!;
    const olderBuild = MIGRATIONS.slice(0, -1);
    const recorded = () => store.handle.prepare("SELECT * FROM tavi_schema_migrations ORDER BY migration_id").all();
    try {
      const before = recorded();
      expect(() => runMigrations(store.handle, olderBuild)).toThrowError(
        expect.objectContaining({ code: "UNAVAILABLE", message: expect.stringContaining(last.id) }),
      );
      // The refused open wrote nothing: the recorded migrations are unchanged.
      expect(recorded()).toEqual(before);
    } finally {
      store.close();
    }
  });

  it("refuses a known-migrations list that is not a prefix of this build's", () => {
    // The parameter exists only to play an older build; applying or skipping
    // migrations out of order is never a legitimate call.
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    try {
      expect(() => runMigrations(store.handle, [{ id: "0001_elsewhere", up: () => undefined }])).toThrowError(/prefix of MIGRATIONS/);
    } finally {
      store.close();
    }
  });
});

describe("effect ledger", () => {
  function storeWithTask(): { store: SqliteStore; taskId: string } {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const { task } = store.asPort().repositories.tasks.admit({
      workspaceId: "ws-1",
      principalId: "operator",
      operationKey: "op-effect",
      kind: "start",
      intent: { prompt: "hello" },
      checkpointNamespace: "",
      newTaskId: () => "task-effect",
      newAdmissionId: () => "adm-effect",
      newThreadId: () => "thread-effect",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    return { store, taskId: task.taskId };
  }

  const begin = (store: SqliteStore, taskId: string, effectKey: string, inputs: unknown) =>
    store.asPort().repositories.effects.begin({
      effectKey,
      taskId,
      admissionId: "adm-effect",
      toolId: "fixture.write",
      inputs,
      now: () => "2026-01-01T00:00:00.000Z",
    });

  it("begins an effect as pending and resolves it with a receipt", () => {
    const { store, taskId } = storeWithTask();
    const effects = store.asPort().repositories.effects;
    const started = begin(store, taskId, "k1", { value: "x" });
    expect(started.created).toBe(true);
    expect(started.effect.state).toBe("pending");

    effects.resolve({
      effectKey: "k1",
      state: "accepted",
      receipt: { providerId: "p-1" },
      now: () => "2026-01-01T00:00:01.000Z",
    });
    expect(effects.get("k1")).toMatchObject({
      state: "accepted",
      receipt: { providerId: "p-1" },
    });
    store.close();
  });

  it("resolves a repeated key to the existing effect, never a second one", () => {
    const { store, taskId } = storeWithTask();
    begin(store, taskId, "k1", { value: "x" });
    const again = begin(store, taskId, "k1", { value: "x" });
    expect(again.created).toBe(false);
    expect(store.asPort().repositories.effects.listForTask(taskId)).toHaveLength(1);
    store.close();
  });

  it("refuses the same key with different normalized inputs", () => {
    const { store, taskId } = storeWithTask();
    begin(store, taskId, "k1", { value: "x" });
    expect(() => begin(store, taskId, "k1", { value: "other" })).toThrowError(/different normalized inputs/);
    store.close();
  });

  it("treats key ordering as irrelevant when comparing inputs", () => {
    const { store, taskId } = storeWithTask();
    begin(store, taskId, "k-order", { a: 1, b: 2 });
    expect(() => begin(store, taskId, "k-order", { b: 2, a: 1 })).not.toThrow();
    store.close();
  });

  it("keeps a result's label with its receipt, and reads a stored label it cannot parse as untrusted", () => {
    const { store, taskId } = storeWithTask();
    const effects = store.asPort().repositories.effects;
    begin(store, taskId, "k-label", {});
    const label = {
      integrity: "untrusted" as const,
      sources: ["web" as const],
      principals: [],
      confidentiality: "personal" as const,
      refs: [{ source: "web" as const, ref: "c1", at: "2026-01-01T00:00:00.000Z" }],
    };
    effects.resolve({ effectKey: "k-label", state: "accepted", receipt: { ok: true }, label, now: () => "t" });
    expect(effects.get("k-label")).toMatchObject({ receipt: { ok: true }, label });
    begin(store, taskId, "k-none", {});
    effects.resolve({ effectKey: "k-none", state: "accepted", receipt: {}, now: () => "t" });
    expect(effects.get("k-none")).not.toHaveProperty("label");
    store.handle.prepare("UPDATE tavi_effects SET label_json = '{\"integrity\":\"trusted\"}' WHERE effect_key = 'k-none'").run();
    expect(effects.get("k-none")?.label).toMatchObject({ integrity: "untrusted", sources: ["unknown-source"] });
    store.close();
  });

  it("refuses to re-resolve a settled effect", () => {
    const { store, taskId } = storeWithTask();
    const effects = store.asPort().repositories.effects;
    begin(store, taskId, "k1", { value: "x" });
    effects.resolve({ effectKey: "k1", state: "accepted", receipt: {}, now: () => "t" });
    // A known-completed effect must not be re-recorded.
    expect(() => effects.resolve({ effectKey: "k1", state: "rejected", now: () => "t" })).toThrowError(/already accepted/);
    store.close();
  });

  it("surfaces unresolved effects for reconciliation", () => {
    const { store, taskId } = storeWithTask();
    const effects = store.asPort().repositories.effects;
    begin(store, taskId, "k-pending", {});
    begin(store, taskId, "k-uncertain", {});
    effects.resolve({ effectKey: "k-uncertain", state: "uncertain", error: "timeout", now: () => "t" });
    begin(store, taskId, "k-done", {});
    effects.resolve({ effectKey: "k-done", state: "accepted", receipt: {}, now: () => "t" });

    expect(
      effects
        .listUnresolved(10)
        .map((row) => row.effectKey)
        .sort(),
    ).toEqual(["k-pending", "k-uncertain"]);
    store.close();
  });

  it("forgets an effect begun but never resolved, so its call runs again; never one with an outcome", () => {
    const { store, taskId } = storeWithTask();
    const effects = store.asPort().repositories.effects;
    begin(store, taskId, "k-asked", {});
    expect(effects.abandon("k-asked")).toBe(true);
    expect(effects.get("k-asked")).toBeUndefined();
    expect(begin(store, taskId, "k-asked", {}).created).toBe(true);
    for (const state of ["accepted", "uncertain"] as const) {
      begin(store, taskId, `k-${state}`, {});
      effects.resolve({ effectKey: `k-${state}`, state, receipt: {}, now: () => "t" });
      expect(effects.abandon(`k-${state}`)).toBe(false);
      expect(effects.get(`k-${state}`)?.state).toBe(state);
    }
    expect(effects.abandon("never")).toBe(false);
    store.close();
  });

  it("refuses to resolve an effect that was never begun", () => {
    const { store } = storeWithTask();
    expect(() => store.asPort().repositories.effects.resolve({ effectKey: "nope", state: "accepted", now: () => "t" })).toThrowError(
      /never begun/,
    );
    store.close();
  });
});

describe("checkpoint receipts", () => {
  function storeWithTask(): { store: SqliteStore; taskId: string } {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const { task } = store.asPort().repositories.tasks.admit({
      workspaceId: "ws-1",
      principalId: "operator",
      operationKey: "op-receipt",
      kind: "start",
      intent: { prompt: "hi" },
      checkpointNamespace: "",
      newTaskId: () => "task-receipt",
      newAdmissionId: () => "adm-receipt",
      newThreadId: () => "thread-receipt",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    return { store, taskId: task.taskId };
  }

  it("records a receipt once per checkpoint", () => {
    const { store, taskId } = storeWithTask();
    const receipts = store.asPort().repositories.receipts;
    const input = {
      taskId,
      threadId: "thread-receipt",
      checkpointNamespace: "",
      checkpointId: "cp-1",
      admissionId: "adm-receipt",
      source: "admission" as const,
      now: () => "2026-01-01T00:00:00.000Z",
    };
    expect(receipts.record(input).source).toBe("admission");
    // The unique key makes recording idempotent.
    expect(receipts.record({ ...input, source: "reconcile" }).source).toBe("admission");
    expect(receipts.listForTask(taskId)).toHaveLength(1);
    store.close();
  });

  it("keeps two checkpoints of the same thread as separate receipts", () => {
    const { store, taskId } = storeWithTask();
    const receipts = store.asPort().repositories.receipts;
    for (const checkpointId of ["cp-1", "cp-2"]) {
      receipts.record({
        taskId,
        threadId: "thread-receipt",
        checkpointNamespace: "",
        checkpointId,
        admissionId: null,
        source: "reconcile",
        now: () => "2026-01-01T00:00:00.000Z",
      });
    }
    expect(receipts.listForTask(taskId)).toHaveLength(2);
    // Ordering is by recorded time, and the newest is reported.
    expect(receipts.latestForTask(taskId)?.checkpointId).toBe("cp-2");
    store.close();
  });

  it("allows the same checkpoint id under a different namespace", () => {
    const { store, taskId } = storeWithTask();
    const receipts = store.asPort().repositories.receipts;
    const base = {
      taskId,
      threadId: "thread-receipt",
      checkpointId: "cp-1",
      admissionId: null,
      source: "reconcile" as const,
      now: () => "2026-01-01T00:00:00.000Z",
    };
    receipts.record({ ...base, checkpointNamespace: "" });
    receipts.record({ ...base, checkpointNamespace: "subgraph/a" });
    // The unique key includes the namespace, so these are distinct checkpoints.
    expect(receipts.listForTask(taskId)).toHaveLength(2);
    store.close();
  });
});

describe("report history", () => {
  it("refuses an invalid summary before writing it, so a bad payload cannot commit", () => {
    const directory = directories.create("tavi-reports-store-");
    chmodSync(directory, 0o700);
    const store = new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
    try {
      const reports = store.asPort().repositories.reports;
      // A 201-character project name is outside `ReportProjectSummarySchema`.
      // The first version inserted it and only the read-back rejected it, so the
      // row committed and then made its period invisible.
      expect(() =>
        reports.record({
          report: {
            reportId: "run-1:2026-04-05",
            workspaceId: "default",
            runId: "run-1",
            artifactId: "art-1",
            periodStart: "2026-03-30",
            periodEnd: "2026-04-05",
            generatedAt: "2026-04-06T00:00:00.000Z",
            bytes: 10,
            projects: [{ id: "acme", name: "x".repeat(201), metrics: [], newsCount: 0, notes: [] }],
          },
        }),
      ).toThrow(/not valid and was not recorded/);
      // Nothing was written, so the workspace's history is intact.
      expect(reports.list({ workspaceId: "default", limit: 10 })).toEqual({ reports: [], unreadable: [] });

      // A valid summary records and reads back.
      const recorded = reports.record({
        report: {
          reportId: "run-2:2026-04-05",
          workspaceId: "default",
          runId: "run-2",
          artifactId: "art-2",
          periodStart: "2026-03-30",
          periodEnd: "2026-04-05",
          generatedAt: "2026-04-06T00:00:00.000Z",
          bytes: 10,
          projects: [
            {
              id: "acme",
              name: "Acme",
              metrics: [{ source: "ga4", key: "sessions", label: "Sessions", value: 4, unit: "count" }],
              newsCount: 0,
              notes: [],
            },
          ],
        },
      });
      expect(recorded.projects[0]?.metrics[0]?.value).toBe(4);
    } finally {
      store.close();
    }
  });
});

/**
 * Store-level round-trips for the project and agent registries.
 *
 * Each repository here gets a row inserted and read back: that is the shape
 * that catches an unvalidated
 * read path — a restored backup or an older release can put anything in a column,
 * and `create` validating on the way in says nothing about the way out.
 */
describe("project registry round-trip", () => {
  function withStore(body: (store: SqliteStore) => void): void {
    const directory = directories.create("tavi-projects-store-");
    chmodSync(directory, 0o700);
    const store = new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
    try {
      body(store);
    } finally {
      store.close();
    }
  }

  /** Write a row the way a restored backup or an older release could. */
  function poison(store: SqliteStore, projectId: string, column: "keywords_json" | "language" | "enabled", value: string | number): void {
    store.handle
      .prepare(
        `INSERT INTO tavi_projects (workspace_id, project_id, name, keywords_json, language, enabled, created_at, updated_at)
         VALUES ('default', @projectId, 'Poisoned', NULL, NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run({ projectId });
    store.handle
      .prepare(`UPDATE tavi_projects SET ${column} = @value WHERE workspace_id = 'default' AND project_id = @projectId`)
      .run({ projectId, value });
  }

  it("round-trips a valid project through create, get and list", () => {
    withStore((store) => {
      const projects = store.asPort().repositories.projects;
      projects.create({
        workspaceId: "default",
        project: { id: "acme", name: "Acme", ga4PropertyId: "properties/1", keywords: ["ai", "crucible"] },
        enabled: true,
        now: "2026-01-01T00:00:00.000Z",
      });
      expect(projects.get("default", "acme")?.keywords).toEqual(["ai", "crucible"]);
      const { projects: listed, unreadable } = projects.list("default");
      expect(unreadable).toEqual([]);
      expect(listed.map((record) => record.id)).toEqual(["acme"]);
    });
  });

  it("isolates a malformed row instead of failing the whole query, and reports it", () => {
    withStore((store) => {
      const projects = store.asPort().repositories.projects;
      projects.create({
        workspaceId: "default",
        project: { id: "good", name: "Good" },
        enabled: true,
        now: "2026-01-01T00:00:00.000Z",
      });
      // `'"acme"'` used to reach the caller as `["a","c","m","e"]`; `'{oops'` threw
      // a raw SyntaxError out of `list()`, taking every collector in the workspace
      // down with it.
      poison(store, "wrong-shape", "keywords_json", '"acme"');
      poison(store, "bad-json", "keywords_json", "{oops");

      const { projects: listed, unreadable } = projects.list("default");
      expect(listed.map((record) => record.id)).toEqual(["good"]);
      expect([...unreadable].sort()).toEqual(["bad-json", "wrong-shape"]);
    });
  });

  it("rejects a valid-JSON non-array, an out-of-bounds value, a non-boolean enabled and a half GCP pair", () => {
    // The values a hand-edit or an older release actually produces. Each must
    // land in `unreadable`, never in a caller as a confidently wrong project:
    // `enabled = 2` previously read as `false` and the project silently vanished
    // from every brief.
    withStore((store) => {
      const projects = store.asPort().repositories.projects;
      poison(store, "number-keywords", "keywords_json", "42");
      poison(store, "short-language", "language", "e");
      poison(store, "not-boolean", "enabled", 2);
      store.handle
        .prepare(
          `INSERT INTO tavi_projects (workspace_id, project_id, name, gcp_billing_project_id, gcp_billing_table, enabled, created_at, updated_at)
           VALUES ('default', 'half-gcp', 'Half', 'billing-proj', NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      const { projects: listed, unreadable } = projects.list("default");
      expect(listed).toEqual([]);
      expect([...unreadable].sort()).toEqual(["half-gcp", "not-boolean", "number-keywords", "short-language"]);
    });
  });

  it("refuses an out-of-bounds write instead of committing a row it cannot read back", () => {
    withStore((store) => {
      const projects = store.asPort().repositories.projects;
      projects.create({
        workspaceId: "default",
        project: { id: "ok", name: "Ok" },
        enabled: true,
        now: "2026-01-01T00:00:00.000Z",
      });
      // `Project`'s bounds live in the schema, so a type-legal call could carry a
      // 201-character name. It used to commit and *then* throw, leaving a row
      // that `list` hid in `unreadable`.
      expect(() =>
        projects.create({
          workspaceId: "default",
          project: { id: "bad", name: "x".repeat(201) } as { id: string; name: string },
          enabled: true,
          now: "2026-01-01T00:00:00.000Z",
        }),
      ).toThrowError(/INVALID_INPUT|not valid/);
      expect(projects.list("default").unreadable).toEqual([]);

      // `update` returned `true` while making its own row unreadable.
      expect(() =>
        projects.update({
          workspaceId: "default",
          projectId: "ok",
          project: { id: "ok", name: "x".repeat(201) } as { id: string; name: string },
          now: "2026-01-01T00:00:00.000Z",
        }),
      ).toThrowError(/INVALID_INPUT|not valid/);
      expect(projects.list("default").unreadable).toEqual([]);
      expect(projects.get("default", "ok")?.name).toBe("Ok");
    });
  });

  it("throws a typed error naming the row on a direct read, never a raw parse error", () => {
    withStore((store) => {
      const projects = store.asPort().repositories.projects;
      poison(store, "bad-json", "keywords_json", "{oops");
      try {
        projects.get("default", "bad-json");
        expect.unreachable("an unreadable row must not read as a project");
      } catch (error) {
        expect(error).toBeInstanceOf(TaviError);
        expect((error as TaviError).code).toBe("INTERNAL");
        expect((error as TaviError).message).toContain("project bad-json");
      }
    });
  });
});

describe("agent definition registry round-trip", () => {
  it("applies an update as a compare-and-set on updatedAt, which every write moves strictly forward", () => {
    const directory = directories.create("tavi-agents-cas-");
    chmodSync(directory, 0o700);
    const store = new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
    try {
      const agents = store.asPort().repositories.agents;
      const at = "2026-01-01T00:00:00.000Z";
      agents.create({ workspaceId: "default", agentId: "sdaddy", name: "Chief", systemPrompt: "One.", enabled: true, now: at });
      // Same instant as the create: the version still moves.
      expect(agents.update({ workspaceId: "default", agentId: "sdaddy", systemPrompt: "Two.", expectedUpdatedAt: at, now: at })).toBe(true);
      const second = agents.get("default", "sdaddy");
      expect(second?.updatedAt).toBe("2026-01-01T00:00:00.001Z");
      try {
        agents.update({
          workspaceId: "default",
          agentId: "sdaddy",
          systemPrompt: "Lost.",
          expectedUpdatedAt: at,
          now: "2026-01-02T00:00:00.000Z",
        });
        expect.unreachable("a stale version must not write");
      } catch (error) {
        expect((error as TaviError).code).toBe("CONFLICT");
        expect((error as TaviError).details).toMatchObject({ agentId: "sdaddy", updatedAt: "2026-01-01T00:00:00.001Z" });
      }
      expect(agents.get("default", "sdaddy")?.systemPrompt).toBe("Two.");
      // The version is an instant: another spelling of the stored time matches.
      expect(
        agents.update({
          workspaceId: "default",
          agentId: "sdaddy",
          systemPrompt: "Three.",
          expectedUpdatedAt: "2026-01-01T00:00:00.001+00:00",
          now: at,
        }),
      ).toBe(true);
      // Unknown id: `false`, as before, whatever version is asserted.
      expect(agents.update({ workspaceId: "default", agentId: "nobody", enabled: false, expectedUpdatedAt: at, now: at })).toBe(false);
      // No version: unconditional, and a later clock is kept as given.
      expect(agents.update({ workspaceId: "default", agentId: "sdaddy", enabled: false, now: "2026-01-03T00:00:00.000Z" })).toBe(true);
      expect(agents.get("default", "sdaddy")).toMatchObject({ enabled: false, updatedAt: "2026-01-03T00:00:00.000Z" });
    } finally {
      store.close();
    }
  });

  it("validates on the way out, naming the row instead of loading an invalid persona", () => {
    const directory = directories.create("tavi-agents-store-");
    chmodSync(directory, 0o700);
    const store = new SqliteStore({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
    try {
      const agents = store.asPort().repositories.agents;
      agents.create({
        agentId: "sdaddy",
        workspaceId: "default",
        name: "sdaddy",
        systemPrompt: "You are the chief of staff.",
        enabled: true,
        now: "2026-01-01T00:00:00.000Z",
      });
      // An id violating the documented pattern, and a prompt outside the
      // schema's bound: both used to be prepended to every model call of every
      // turn of every task naming the agent.
      store.handle
        .prepare(
          `INSERT INTO tavi_agent_definitions (agent_id, workspace_id, name, system_prompt, enabled, created_at, updated_at)
           VALUES ('bad id/with/slashes', 'default', 'Bad', '', 1, 'now', 'now')`,
        )
        .run();

      const { agents: listed, unreadable } = agents.list("default");
      expect(listed.map((entry) => entry.agentId)).toEqual(["sdaddy"]);
      expect(unreadable).toEqual(["default/bad id/with/slashes"]);

      expect(() => agents.get("default", "bad id/with/slashes")).toThrow(/agent definition/);

      // A write cannot produce one of these rows: the bound is in the schema, so
      // an over-long prompt is refused before the UPDATE, not after it.
      expect(() =>
        agents.update({
          workspaceId: "default",
          agentId: "sdaddy",
          systemPrompt: "x".repeat(20_001),
          now: "2026-01-01T00:00:00.000Z",
        }),
      ).toThrowError(/INVALID_INPUT|not valid/);
      expect(agents.get("default", "sdaddy")?.systemPrompt).toBe("You are the chief of staff.");
    } finally {
      store.close();
    }
  });
});

describe("opening a damaged database", () => {
  it("still opens when the open-time statistics pass cannot read a page, so the integrity check can report it", () => {
    const databasePath = join(tempDirectory(), "tavi.sqlite");
    const setup = new SqliteStore({ databasePath });
    const pageSize = setup.handle.pragma("page_size", { simple: true }) as number;
    const { rootpage } = setup.handle.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'tavi_memory_revisions'").get() as {
      rootpage: number;
    };
    setup.close();
    // Overwrite one table's root page, leaving the header and the schema readable.
    const descriptor = openSync(databasePath, "r+");
    try {
      const scribble = Buffer.alloc(pageSize, 0x5a);
      writeSync(descriptor, scribble, 0, scribble.length, (rootpage - 1) * pageSize);
    } finally {
      closeSync(descriptor);
    }
    // The statistics pass the store runs on open fails on this file.
    const raw = new (loadBetterSqlite3())(databasePath);
    try {
      expect(() => raw.pragma("optimize = 0x10002")).toThrow();
    } finally {
      raw.close();
    }

    const store = new SqliteStore({ databasePath });
    try {
      // Open: the schema reads, and the check finds the damage (on a page this broken it throws SQLITE_CORRUPT).
      expect(store.handle.prepare("SELECT count(*) AS n FROM sqlite_master").get()).toEqual({ n: expect.any(Number) });
      let verdict: string[];
      try {
        verdict = (store.handle.pragma("integrity_check") as { integrity_check: string }[]).map((row) => row.integrity_check);
      } catch (error) {
        verdict = [String(error)];
      }
      expect(verdict).not.toEqual(["ok"]);
    } finally {
      store.close();
    }
  });
});
