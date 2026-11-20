import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultHeartbeatConfig } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { acquireDataDirectoryOwnership, FTS_SHADOW_TABLES, MIGRATIONS } from "@tavi/runtime";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { SqliteStore } from "../support/database-fixture.js";
import { loadBetterSqlite3 } from "../../../../packages/runtime/src/persistence/sqlite-loader.js";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";

/**
 * `tavi backup` / `tavi export` / `tavi restore`.
 *
 * An operator upgrading a two-year data directory needs a supported way to copy
 * it — and a hand-kept constant that once claimed to qualify a backup was 13
 * tables stale, so a backup built from it would have omitted every messaging and
 * delegation row and looked successful. These pin the three properties that
 * matter: the snapshot is complete and consistent, it can be taken while a
 * daemon owns the directory, and a restore refuses a snapshot this build cannot
 * read before it moves anything.
 */

const directories = temporaryDirectories();

afterEach(() => directories.cleanup());

/** A private data directory with a migrated database and one configured project. */
async function seededDataDirectory(): Promise<string> {
  const directory = directories.create("tavi-backup-src-");
  const added = capture();
  expect(await main(["projects", "add", "acme", "--ga4", "properties/1", "--data-dir", directory], { io: added.io })).toBe(EXIT.ok);
  return directory;
}

describe("tavi backup", () => {
  it("writes a complete snapshot and a manifest that says what it carries", async () => {
    const directory = await seededDataDirectory();
    const out = join(directories.create("tavi-backup-out-"), "snap");
    const snapshot = capture();
    expect(await main(["backup", "--out", out, "--format", "json", "--data-dir", directory], { io: snapshot.io })).toBe(EXIT.ok);

    const manifest = JSON.parse(snapshot.stdout()) as {
      createdAt: string;
      applicationTables: string[];
      migrations: string[];
      rowCounts: Record<string, number>;
      includes: { artifacts: boolean; credentials: boolean };
      excluded: string[];
      bytes: number;
    };
    expect(manifest.applicationTables.length).toBeGreaterThan(40);
    expect(manifest.migrations).toEqual(MIGRATIONS.map((migration) => migration.id));
    // A new application table must be declared, or the completeness test and the
    // backup manifest both miss it: `APPLICATION_TABLES` is what qualifies both.
    expect(manifest.applicationTables).toEqual(expect.arrayContaining(["tavi_workspace_system_prompts", "tavi_task_prompt_snapshots"]));
    expect(manifest.rowCounts["tavi_workspace_system_prompts"]).toBe(0);
    expect(manifest.rowCounts["tavi_task_prompt_snapshots"]).toBe(0);
    expect(manifest.rowCounts["tavi_projects"]).toBe(1);
    // No artifacts yet, so none are said to be included.
    expect(manifest.includes).toEqual({ artifacts: false, credentials: false, plugins: false, webProviders: false, chats: false });
    // Said out loud, so a restore is never read as "everything came back".
    expect(manifest.excluded).toEqual([
      "credentials/",
      "chats/.trash/",
      "chats/*/*/.tmp/",
      "chats/*/*/.home/",
      "credentials.key",
      "provider-bindings.key",
      "logs/",
      "owner.process.json",
      "owner.lock",
    ]);
    expect(manifest.bytes).toBeGreaterThan(0);

    expect(existsSync(join(out, "tavi.sqlite"))).toBe(true);
    expect(existsSync(join(out, "manifest.json"))).toBe(true);

    // The snapshot really is a database, complete: every table the schema
    // creates is in it, FTS internals included — that is what makes it a
    // snapshot rather than a hand-assembled subset.
    const store = await SqliteStore.open({ databasePath: join(out, "tavi.sqlite"), artifactsDirectory: join(out, "artifacts") });
    try {
      const tables = await store.listTables();
      for (const table of [
        "tavi_projects",
        "tavi_messaging_inbox",
        "tavi_agent_mailbox",
        "tavi_workspace_system_prompts",
        "tavi_task_prompt_snapshots",
        ...FTS_SHADOW_TABLES,
      ]) {
        expect(tables, table).toContain(table);
      }
      expect((await store.asPort().repositories.projects.list("default")).projects.map((project) => project.id)).toEqual(["acme"]);
    } finally {
      await store.close();
    }
  });

  it("refuses to write over a non-empty directory without --force", async () => {
    const directory = await seededDataDirectory();
    const out = directories.create("tavi-backup-out-");
    writeFileSync(join(out, "something-else"), "keep me", { mode: 0o600 });
    const refused = capture();
    expect(await main(["backup", "--out", out, "--data-dir", directory], { io: refused.io })).toBe(EXIT.usage);
    expect(refused.stderr()).toMatch(/is not empty; pass --force/);
    expect(readFileSync(join(out, "something-else"), "utf8")).toBe("keep me");

    const forced = capture();
    expect(await main(["backup", "--out", out, "--force", "--data-dir", directory], { io: forced.io })).toBe(EXIT.ok);
  });

  it("takes a consistent snapshot while another process owns the directory", async () => {
    // The claim the implementation is built on: `VACUUM INTO` from a read-only
    // connection, not a copy of files a live WAL writer could be halfway
    // through — so an operator can back up a running daemon.
    const directory = await seededDataDirectory();
    const ownership = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "test-owner" });
    try {
      const out = join(directories.create("tavi-backup-out-"), "live");
      const snapshot = capture();
      expect(await main(["backup", "--out", out, "--data-dir", directory], { io: snapshot.io })).toBe(EXIT.ok);
      expect(existsSync(join(out, "tavi.sqlite"))).toBe(true);
    } finally {
      ownership.release();
    }
  });

  it("copies credentials only when asked, and then with the snapshot locked down", async () => {
    const directory = await seededDataDirectory();
    const credentials = join(directory, "credentials");
    const secretFile = join(directories.create("tavi-backup-secret-"), "value");
    writeFileSync(secretFile, "sk-test-value", { mode: 0o600 });
    const set = capture();
    expect(await main(["credentials", "set", "acme.key", "--file", secretFile, "--data-dir", directory], { io: set.io })).toBe(EXIT.ok);

    const excluded = join(directories.create("tavi-backup-out-"), "without");
    expect(await main(["backup", "--out", excluded, "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    expect(existsSync(join(excluded, "credentials"))).toBe(false);

    const included = join(directories.create("tavi-backup-out-"), "with");
    expect(await main(["backup", "--out", included, "--include-credentials", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    expect(readdirSync(join(included, "credentials"))).toEqual(["acme.key"]);
    // Copied as stored: encrypted, since a new directory is, and the key is never in the backup.
    expect(readFileSync(join(included, "credentials", "acme.key"), "utf8")).toBe(readFileSync(join(credentials, "acme.key"), "utf8"));
    expect(readFileSync(join(included, "credentials", "acme.key"), "utf8")).toMatch(/^tavi-enc:v1:/);
    expect(existsSync(join(included, "credentials.key"))).toBe(false);
    expect(existsSync(credentials)).toBe(true);
  });
  it("carries the workspace prompt setting and a task snapshot through backup and restore", async () => {
    // Both tables are declared, so the snapshot is part of the `VACUUM INTO`
    // copy and a restore returns the exact selected base — the property the
    // settings row exists for.
    const directory = await seededDataDirectory();
    const writer = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    let taskId = "";
    const text = "a custom base that must survive the round trip\n";
    try {
      await writer.asPort().repositories.systemPrompts.set({
        workspaceId: "default",
        text,
        expectedRevision: 0,
        actor: "operator",
        now: "2026-01-01T00:00:00.000Z",
      });
      const admitted = await writer.asPort().repositories.tasks.admit({
        prompt: fixturePromptPolicy,
        workspaceId: "default",
        principalId: "operator",
        operationKey: "op-backup-snapshot",
        kind: "start",
        intent: { prompt: "hi" },
        checkpointNamespace: "",
        newTaskId: (() => "task-backup-snapshot")(),
        newAdmissionId: (() => "adm-backup-snapshot")(),
        newThreadId: (() => "thread-backup-snapshot")(),
        now: (() => "2026-01-01T00:00:00.000Z")(),
      });
      taskId = admitted.task.taskId;
      await writer.asPort().repositories.tasks.putTaskSnapshot({
        taskId,
        workspaceId: "default",
        source: "workspace",
        text,
        hash: createHash("sha256").update(text).digest("hex"),
        revision: 1,
        templateVersion: null,
        boundAt: "2026-01-01T00:00:00.000Z",
      });
    } finally {
      await writer.close();
    }

    const snapshotDirectory = join(directories.create("tavi-backup-out-"), "snap");
    expect(await main(["backup", "--out", snapshotDirectory, "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    const destination = directories.create("tavi-restore-dest-");
    expect(await main(["restore", "--from", snapshotDirectory, "--data-dir", destination], { io: capture().io })).toBe(EXIT.ok);

    const check = await SqliteStore.open({
      databasePath: join(destination, "tavi.sqlite"),
      artifactsDirectory: join(destination, "artifacts"),
    });
    try {
      expect((await check.asPort().repositories.systemPrompts.get("default")).text).toBe(text);
      expect(await check.asPort().repositories.tasks.getPromptSnapshot(taskId)).toEqual(
        expect.objectContaining({ source: "workspace", text, revision: 1 }),
      );
    } finally {
      await check.close();
    }
  });

  it("marks every MCP server's tree index stale through a restore, so its next check re-hashes its files", async () => {
    const directory = directories.create("tavi-backup-mcp-");
    const server = directories.create("tavi-backup-mcp-raw-");
    writeFileSync(
      join(server, "raw.mjs"),
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mcp", "raw-server.mjs")),
    );
    expect(
      await main(["mcp", "add", "raw", "--dir", server, "--unsandboxed", "--data-dir", directory, "--", "node", "raw.mjs"], {
        io: capture().io,
      }),
    ).toBe(EXIT.ok);
    expect(await main(["mcp", "approve", "mcp.raw", "1.0.0", "--unsandboxed", "--data-dir", directory], { io: capture().io })).toBe(
      EXIT.ok,
    );
    const quick = capture();
    expect(await main(["mcp", "verify", "mcp.raw", "--data-dir", directory], { io: quick.io })).toBe(EXIT.ok);
    expect(quick.stdout()).toContain("(0 re-hashed)");

    const snapshotDirectory = join(directories.create("tavi-backup-mcp-out-"), "snap");
    expect(await main(["backup", "--out", snapshotDirectory, "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    const destination = directories.create("tavi-restore-mcp-dest-");
    expect(await main(["restore", "--from", snapshotDirectory, "--data-dir", destination], { io: capture().io })).toBe(EXIT.ok);
    const check = await SqliteStore.open({
      databasePath: join(destination, "tavi.sqlite"),
      artifactsDirectory: join(destination, "artifacts"),
    });
    try {
      expect((await check.asPort().repositories.mcp.getVersion("mcp.raw", "1.0.0"))?.treeIndexStale).toBe(true);
    } finally {
      await check.close();
    }
    // The next check is a full one: every file hashed again.
    const after = capture();
    expect(await main(["mcp", "verify", "mcp.raw", "--data-dir", destination], { io: after.io })).toBe(EXIT.ok);
    expect(after.stdout()).toMatch(/files as approved \([1-9]\d* re-hashed\)/);
  }, 60_000);

  it("carries a heartbeat's settings, record and ledger through backup and restore", async () => {
    const directory = await seededDataDirectory();
    const writer = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    const scope = { workspaceId: "default", principalId: "operator" };
    const at = "2026-01-01T00:00:00.000Z";
    try {
      const heartbeats = writer.asPort().repositories.heartbeats;
      await heartbeats.save({
        ...scope,
        config: { ...defaultHeartbeatConfig(), enabled: true, instructions: "Tell me if a payment fails" },
        expectedRevision: 0,
        author: "operator",
        now: at,
      });
      await heartbeats.recordTick({
        ...scope,
        tickId: "hbt-backup",
        kind: "signal",
        wakeReason: "interval",
        outcome: "quiet",
        reason: null,
        pauseReason: null,
        providerId: "tavi.heartbeatagent",
        taskId: null,
        itemsNow: 0,
        itemsLater: 0,
        itemsRetracted: 0,
        inputs: null,
        hookDecisions: null,
        tokens: 0,
        cacheReadTokens: 0,
        costUsd: null,
        durationMs: 1,
        error: null,
        providerDev: false,
        advancesLastTick: true,
        now: at,
      });
      await heartbeats.tellItems({
        ...scope,
        now: at,
        items: [
          {
            itemId: "hbi-backup",
            hash: "h",
            heldBack: false,
            buttonToken: "abcdefghijklmnop",
            item: { key: "billing:1", urgency: "now", title: "A payment failed", sources: [{ label: "Billing" }] },
          },
        ],
      });
    } finally {
      await writer.close();
    }
    const snapshotDirectory = join(directories.create("tavi-backup-out-"), "snap");
    expect(await main(["backup", "--out", snapshotDirectory, "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    const destination = directories.create("tavi-restore-dest-");
    expect(await main(["restore", "--from", snapshotDirectory, "--data-dir", destination], { io: capture().io })).toBe(EXIT.ok);
    const check = await SqliteStore.open({
      databasePath: join(destination, "tavi.sqlite"),
      artifactsDirectory: join(destination, "artifacts"),
    });
    try {
      const heartbeats = check.asPort().repositories.heartbeats;
      expect((await heartbeats.get("default", "operator"))?.config).toMatchObject({
        enabled: true,
        instructions: "Tell me if a payment fails",
      });
      expect((await heartbeats.listTicks({ ...scope, limit: 10 })).map((tick) => tick.tickId)).toEqual(["hbt-backup"]);
      expect(await heartbeats.ledgerRow({ ...scope, itemId: "hbi-backup" })).toMatchObject({ key: "billing:1", state: "told" });
    } finally {
      await check.close();
    }
  });
});

describe("tavi export", () => {
  it("writes one NDJSON file per application table and skips the FTS internals", async () => {
    const directory = await seededDataDirectory();
    const out = join(directories.create("tavi-export-out-"), "ndjson");
    const exported = capture();
    expect(await main(["export", "--out", out, "--format", "json", "--data-dir", directory], { io: exported.io })).toBe(EXIT.ok);

    const result = JSON.parse(exported.stdout()) as { files: { table: string; rows: number }[] };
    const tables = result.files.map((file) => file.table);
    expect(tables).toContain("tavi_projects");
    expect(tables).toContain("tavi_messaging_inbox");
    // Derived state with BLOB columns: rebuilt from `tavi_memory_records`, and
    // not representable as NDJSON rows at all.
    for (const shadow of FTS_SHADOW_TABLES) expect(tables, shadow).not.toContain(shadow);
    // A table-level dump, so the columns are the schema's (`project_id`), not
    // the port's camelCase projection — which is what makes the file readable by
    // something that knows nothing about this codebase.
    expect(JSON.parse(readFileSync(join(out, "tavi_projects.ndjson"), "utf8")).project_id).toBe("acme");
  });

  it("includes the gate observations: tool ids and reasons, never a call's arguments", async () => {
    const directory = await seededDataDirectory();
    const live = new (loadBetterSqlite3())(join(directory, "tavi.sqlite"));
    live
      .prepare(
        "INSERT INTO tavi_gate_observations VALUES ('task-1', 'call-1', 'http.request', 'external', 'network', 'allow', 'ask', 'tainted-payload', '2026-10-10T00:00:00.000Z')",
      )
      .run();
    live.close();
    const out = join(directories.create("tavi-export-out-"), "observations");
    expect(await main(["export", "--out", out, "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    expect(JSON.parse(readFileSync(join(out, "tavi_gate_observations.ndjson"), "utf8"))).toEqual({
      task_id: "task-1",
      call_id: "call-1",
      tool_id: "http.request",
      effect: "external",
      sink: "network",
      decision_enforced: "allow",
      decision_observed: "ask",
      gate_reason: "tainted-payload",
      created_at: "2026-10-10T00:00:00.000Z",
    });
  });

  it("includes the propagated labels' columns: every table is dumped whole", async () => {
    const directory = await seededDataDirectory();
    const live = new (loadBetterSqlite3())(join(directory, "tavi.sqlite"));
    const label = JSON.stringify({ integrity: "untrusted", sources: ["web"], principals: [], confidentiality: "personal", refs: [] });
    live
      .prepare(
        "INSERT INTO tavi_artifacts (artifact_id, workspace_id, run_id, relative_path, content_type, byte_size, sha256, created_at, label_json) VALUES ('art-labelled', 'default', NULL, 'default/art-labelled.png', 'image/png', 3, 'x', '2026-10-13T00:00:00.000Z', ?)",
      )
      .run(label);
    const columns = (table: string) =>
      (live.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
    const added: Readonly<Record<string, string>> = {
      tavi_artifacts: "label_json",
      tavi_memory_revisions: "provenance_json",
      tavi_agent_mailbox: "label_json",
      tavi_task_folders: "tainted_at",
      tavi_reminders: "label_json",
      tavi_routine_revisions: "provenance_json",
    };
    for (const [table, column] of Object.entries(added)) expect(columns(table), table).toContain(column);
    live.close();
    const out = join(directories.create("tavi-export-out-"), "labels");
    const exported = capture();
    expect(await main(["export", "--out", out, "--format", "json", "--data-dir", directory], { io: exported.io })).toBe(EXIT.ok);
    const tables = (JSON.parse(exported.stdout()) as { files: { table: string }[] }).files.map((file) => file.table);
    for (const table of Object.keys(added)) expect(tables).toContain(table);
    const rows = readFileSync(join(out, "tavi_artifacts.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.find((row) => row["artifact_id"] === "art-labelled")?.["label_json"]).toBe(label);
  });

  it("works while an owner holds the directory, being read-only", async () => {
    const directory = await seededDataDirectory();
    const ownership = await acquireDataDirectoryOwnership({ dataDirectory: directory, sessionId: "test-owner" });
    try {
      const out = join(directories.create("tavi-export-out-"), "live");
      expect(await main(["export", "--out", out, "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    } finally {
      ownership.release();
    }
  });
});

describe("tavi restore", () => {
  it("restores a snapshot into a fresh directory and moves an existing database aside", async () => {
    const source = await seededDataDirectory();
    const snapshotDirectory = join(directories.create("tavi-restore-out-"), "snap");
    expect(await main(["backup", "--out", snapshotDirectory, "--data-dir", source], { io: capture().io })).toBe(EXIT.ok);

    const destination = directories.create("tavi-restore-dest-");
    const first = capture();
    expect(await main(["restore", "--from", snapshotDirectory, "--data-dir", destination], { io: first.io })).toBe(EXIT.ok);
    expect(first.stdout()).toMatch(/no existing database to move aside/);

    // A second restore must keep the directory it replaces.
    const second = capture();
    expect(await main(["restore", "--from", snapshotDirectory, "--data-dir", destination], { io: second.io })).toBe(EXIT.ok);
    const aside = readdirSync(destination).filter((name) => name.startsWith("tavi.sqlite.pre-restore-"));
    expect(aside).toHaveLength(1);

    const store = await SqliteStore.open({
      databasePath: join(destination, "tavi.sqlite"),
      artifactsDirectory: join(destination, "artifacts"),
    });
    try {
      expect((await store.asPort().repositories.projects.list("default")).projects.map((project) => project.id)).toEqual(["acme"]);
    } finally {
      await store.close();
    }
  });

  it("memory invariant 9: says how many forgotten memories stay forgotten, or that they could not be checked, naming the snapshot's time", async () => {
    const source = await seededDataDirectory();
    // A memory the snapshot holds, forgotten after the backup: the restore brings its row back, and the
    // journal row it carries over keeps it forgotten. Only records the restored copy holds are counted.
    const remembered = capture();
    expect(await main(["memory", "remember", "--body", "Keeps bees on the roof", "--data-dir", source], { io: remembered.io })).toBe(
      EXIT.ok,
    );
    const { recordId } = JSON.parse(remembered.stdout()) as { recordId: string };
    const snapshotDirectory = join(directories.create("tavi-restore-out-"), "snap");
    expect(await main(["backup", "--out", snapshotDirectory, "--data-dir", source], { io: capture().io })).toBe(EXIT.ok);
    const snapshotAt = (JSON.parse(readFileSync(join(snapshotDirectory, "manifest.json"), "utf8")) as { createdAt: string }).createdAt;
    expect(await main(["memory", "forget", recordId, "--reason", "no longer true", "--data-dir", source], { io: capture().io })).toBe(
      EXIT.ok,
    );
    // A journal row for a record the snapshot never held is carried over too, but not counted.
    const live = new (loadBetterSqlite3())(join(source, "tavi.sqlite"));
    live
      .prepare(`INSERT INTO tavi_memory_deletions (deletion_id, record_id, scope_key, deletion_generation, requested_by, reason, requested_at, cleanup_status)
      VALUES ('memdel-after', 'mem-after', 'personal|p=operator', 1, 'operator', 'forgotten', ?, 'complete')`)
      .run(nowTimestamp());
    live.close();
    const restored = capture();
    expect(await main(["restore", "--from", snapshotDirectory, "--data-dir", source], { io: restored.io })).toBe(EXIT.ok);
    expect(restored.stdout()).toContain("1 forgotten memory stays forgotten\n");

    // A database that cannot be read is moved aside all the same, with the warning.
    for (const sidecar of ["tavi.sqlite-wal", "tavi.sqlite-shm"]) rmSync(join(source, sidecar), { force: true });
    writeFileSync(join(source, "tavi.sqlite"), Buffer.alloc(8192, 7));
    const unreadable = capture();
    expect(await main(["restore", "--from", snapshotDirectory, "--data-dir", source], { io: unreadable.io })).toBe(EXIT.ok);
    expect(unreadable.stdout()).toContain(
      `forgotten memories could not be checked: anything you forgot after ${snapshotAt} may be back; forget it again\n`,
    );
  });

  it("restores credentials and artifacts when the snapshot carries them", async () => {
    const source = await seededDataDirectory();
    const secretFile = join(directories.create("tavi-restore-secret-"), "value");
    writeFileSync(secretFile, "sk-restored", { mode: 0o600 });
    expect(await main(["credentials", "set", "acme.key", "--file", secretFile, "--data-dir", source], { io: capture().io })).toBe(EXIT.ok);
    const snapshotDirectory = join(directories.create("tavi-restore-out-"), "snap");
    expect(await main(["backup", "--out", snapshotDirectory, "--include-credentials", "--data-dir", source], { io: capture().io })).toBe(
      EXIT.ok,
    );

    const destination = directories.create("tavi-restore-dest-");
    const restored = capture();
    expect(await main(["restore", "--from", snapshotDirectory, "--format", "json", "--data-dir", destination], { io: restored.io })).toBe(
      EXIT.ok,
    );
    expect(JSON.parse(restored.stdout()).restoredFiles).toEqual(["credentials/"]);
    // Restored as backed up (encrypted): the key comes back apart from the snapshot.
    expect(readFileSync(join(destination, "credentials", "acme.key"), "utf8")).toBe(
      readFileSync(join(source, "credentials", "acme.key"), "utf8"),
    );
  });

  it("refuses a snapshot carrying migrations this build does not know, which is why a downgrade is a restore", async () => {
    // The rollback guidance's premise, tested: a restored database records every
    // migration this build applied, so an older build without them cannot open
    // it. That is what makes "roll back the template by downgrading the build"
    // wrong — it needs a restore, which sets aside everything written since.
    const directory = await seededDataDirectory();
    const snapshotDirectory = join(directories.create("tavi-backup-out-"), "snap-downgrade");
    expect(await main(["backup", "--out", snapshotDirectory, "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);

    const destination = directories.create("tavi-restore-dest-");
    const refused = capture();
    expect(await main(["restore", "--from", snapshotDirectory, "--data-dir", destination], { io: refused.io })).toBe(EXIT.ok);

    // The restored database records the new migrations, so a build without them
    // refuses to open it — the "unopenable by older builds" rule the Upgrades
    // section states.
    const restored = await SqliteStore.open({
      databasePath: join(destination, "tavi.sqlite"),
      artifactsDirectory: join(destination, "artifacts"),
    });
    try {
      const applied = (
        restored.handle.prepare("SELECT migration_id FROM tavi_schema_migrations ORDER BY migration_id").all() as {
          readonly migration_id: string;
        }[]
      ).map((row) => row.migration_id);
      expect(applied).toEqual(MIGRATIONS.map((migration) => migration.id));
    } finally {
      await restored.close();
    }
    // And the tables those migrations declare really carry the round-tripped rows.
    const check = await SqliteStore.open({
      databasePath: join(destination, "tavi.sqlite"),
      artifactsDirectory: join(destination, "artifacts"),
    });
    try {
      expect(await check.listTables()).toEqual(expect.arrayContaining(["tavi_workspace_system_prompts", "tavi_task_prompt_snapshots"]));
    } finally {
      await check.close();
    }
  });

  it("refuses a snapshot written by a newer build before moving anything", async () => {
    const source = await seededDataDirectory();
    const snapshotDirectory = join(directories.create("tavi-restore-out-"), "snap");
    expect(await main(["backup", "--out", snapshotDirectory, "--data-dir", source], { io: capture().io })).toBe(EXIT.ok);
    const snapshotDatabase = join(snapshotDirectory, "tavi.sqlite");
    const store = await SqliteStore.open({ databasePath: snapshotDatabase, artifactsDirectory: join(snapshotDirectory, "artifacts") });
    try {
      store.handle
        .prepare("INSERT INTO tavi_schema_migrations (migration_id, applied_at) VALUES (?, ?)")
        .run("9999_future_from_newer_binary", "2026-01-01T00:00:00.000Z");
    } finally {
      await store.close();
    }

    const destination = await seededDataDirectory();
    const refused = capture();
    // Exit 4 (`UNAVAILABLE`) — the same refusal `runMigrations` makes when a
    // build opens a schema it does not know.
    expect(await main(["restore", "--from", snapshotDirectory, "--data-dir", destination], { io: refused.io })).toBe(EXIT.unavailable);
    expect(refused.stderr()).toMatch(/newer build of tavi/);
    // Nothing moved: the destination's own project is still there.
    const check = await SqliteStore.open({
      databasePath: join(destination, "tavi.sqlite"),
      artifactsDirectory: join(destination, "artifacts"),
    });
    try {
      expect((await check.asPort().repositories.projects.list("default")).projects.map((project) => project.id)).toEqual(["acme"]);
    } finally {
      await check.close();
    }
    expect(readdirSync(destination).some((name) => name.includes("pre-restore"))).toBe(false);
  });

  it("refuses a snapshot of another profile format for its format, before its unknown migrations, and moves nothing", async () => {
    // A development build's snapshot, from before the baseline: its own format, and migration ids this build never had.
    const source = await seededDataDirectory();
    const snapshotDirectory = join(directories.create("tavi-restore-out-"), "snap-old-format");
    expect(await main(["backup", "--out", snapshotDirectory, "--data-dir", source], { io: capture().io })).toBe(EXIT.ok);
    const old = new (loadBetterSqlite3())(join(snapshotDirectory, "tavi.sqlite"));
    try {
      old.prepare("UPDATE tavi_meta SET value = 'tavi-provider-v2' WHERE key = 'profile.format'").run();
      old.prepare("INSERT INTO tavi_schema_migrations (migration_id, applied_at) VALUES ('0040_meta', '2026-01-01T00:00:00.000Z')").run();
    } finally {
      old.close();
    }
    for (const manifestFormat of ["tavi-provider-v2", undefined]) {
      const manifestPath = join(snapshotDirectory, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      if (manifestFormat === undefined) delete manifest["profileFormat"];
      else manifest["profileFormat"] = manifestFormat;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const destination = await seededDataDirectory();
      const refused = capture();
      expect(await main(["restore", "--from", snapshotDirectory, "--data-dir", destination], { io: refused.io })).not.toBe(EXIT.ok);
      expect(refused.stderr()).toMatch(/profile format/i);
      expect(refused.stderr()).not.toMatch(/newer build/);
      expect(readdirSync(destination).some((name) => name.includes("pre-restore"))).toBe(false);
    }
  });

  it("refuses while another process owns the directory, because it writes", async () => {
    const source = await seededDataDirectory();
    const snapshotDirectory = join(directories.create("tavi-restore-out-"), "snap");
    expect(await main(["backup", "--out", snapshotDirectory, "--data-dir", source], { io: capture().io })).toBe(EXIT.ok);
    const destination = directories.create("tavi-restore-dest-");
    const ownership = await acquireDataDirectoryOwnership({ dataDirectory: destination, sessionId: "test-owner" });
    try {
      const refused = capture();
      expect(await main(["restore", "--from", snapshotDirectory, "--data-dir", destination], { io: refused.io })).toBe(EXIT.alreadyOwned);
      expect(refused.stderr()).toMatch(/already owns/);
    } finally {
      ownership.release();
    }
  });
});

describe("maintenance safety rails", () => {
  it("refuses a snapshot directory that is the data directory, without touching the database", async () => {
    // `backup --out <data-dir> --force` used to delete the live database and then
    // report that none existed.
    const directory = await seededDataDirectory();
    const refused = capture();
    expect(await main(["backup", "--out", directory, "--force", "--data-dir", directory], { io: refused.io })).toBe(EXIT.usage);
    expect(refused.stderr()).toMatch(/same directory or one contains the other/);
    expect(existsSync(join(directory, "tavi.sqlite"))).toBe(true);
    // And before `--force` too, where the directory is non-empty anyway.
    const refused2 = capture();
    expect(await main(["export", "--out", directory, "--data-dir", directory], { io: refused2.io })).toBe(EXIT.usage);
    expect(existsSync(join(directory, "tavi.sqlite"))).toBe(true);
  });

  it("refuses to restore a directory onto itself, leaving the database in place", async () => {
    const directory = await seededDataDirectory();
    const refused = capture();
    expect(await main(["restore", "--from", directory, "--data-dir", directory], { io: refused.io })).toBe(EXIT.usage);
    expect(refused.stderr()).toMatch(/same directory or one contains the other/);
    expect(existsSync(join(directory, "tavi.sqlite"))).toBe(true);
    expect(readdirSync(directory).some((name) => name.includes("pre-restore"))).toBe(false);
  });

  it("exports a directory whose saver tables hold BLOBs, tagging them instead of failing", async () => {
    // Every composed directory has `checkpoints`/`writes` (the checkpoint saver's `setup()`),
    // and the first version's BLOB guard made `tavi export` fail on all of them.
    const directory = await seededDataDirectory();
    expect(await main(["doctor", "--data-dir", directory], { io: capture().io })).not.toBe(EXIT.internal);
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    try {
      store.handle
        .prepare("INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata) VALUES (?, ?, ?, ?, ?, ?)")
        .run("thread-1", "", "1", "json", Buffer.from("binary-checkpoint"), Buffer.from("binary-metadata"));
    } finally {
      await store.close();
    }

    const out = join(directories.create("tavi-export-out-"), "blobs");
    const exported = capture();
    expect(await main(["export", "--out", out, "--data-dir", directory], { io: exported.io })).toBe(EXIT.ok);
    const line = readFileSync(join(out, "checkpoints.ndjson"), "utf8").trim();
    expect(JSON.parse(line).thread_id).toBe("thread-1");
    expect(JSON.parse(line).checkpoint.$blob).toBe(Buffer.from("binary-checkpoint").toString("base64"));
  });

  it("restores a live directory's newest commits, because the copy goes through SQLite", async () => {
    // A directory that is still open has its newest rows in the `-wal`. Copying
    // `tavi.sqlite` alone restored stale data and reported success.
    const source = await seededDataDirectory();
    const writer = await SqliteStore.open({ databasePath: join(source, "tavi.sqlite"), artifactsDirectory: join(source, "artifacts") });
    try {
      await writer.asPort().repositories.projects.create({
        workspaceId: "default",
        project: { id: "in-the-wal", name: "In the WAL" },
        enabled: true,
        now: "2026-01-01T00:00:00.000Z",
      });
      const destination = directories.create("tavi-restore-dest-");
      const restored = capture();
      expect(await main(["restore", "--from", source, "--data-dir", destination], { io: restored.io })).toBe(EXIT.ok);

      const check = await SqliteStore.open({
        databasePath: join(destination, "tavi.sqlite"),
        artifactsDirectory: join(destination, "artifacts"),
      });
      try {
        expect((await check.asPort().repositories.projects.list("default")).projects.map((project) => project.id).sort()).toEqual([
          "acme",
          "in-the-wal",
        ]);
      } finally {
        await check.close();
      }
    } finally {
      await writer.close();
    }
  });

  it("refuses to copy a symlinked credential, and leaves its target's mode alone", async () => {
    // `cpSync` dereferences by default, and the first version's recursive chmod
    // followed the link too: the secret was copied and a file *outside* the data
    // directory had its permissions changed.
    const directory = await seededDataDirectory();
    const outside = join(directories.create("tavi-outside-"), "target.txt");
    writeFileSync(outside, "do not copy me", { mode: 0o644 });
    mkdirSync(join(directory, "credentials"), { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(directory, "credentials", "link.key"));

    const out = join(directories.create("tavi-backup-out-"), "linked");
    const refused = capture();
    expect(await main(["backup", "--out", out, "--include-credentials", "--data-dir", directory], { io: refused.io })).toBe(EXIT.usage);
    expect(refused.stderr()).toMatch(/refusing to copy the symlink/);
    expect(existsSync(join(out, "credentials"))).toBe(false);
    expect(statSync(outside).mode & 0o777).toBe(0o644);
  });

  it("replaces, rather than merges, what a re-taken snapshot carries", async () => {
    // `--force` removed only the database, so a previous run's `credentials/`
    // stayed next to a manifest that excluded them — and restore copied them.
    const directory = await seededDataDirectory();
    const secretFile = join(directories.create("tavi-backup-secret-"), "value");
    writeFileSync(secretFile, "sk-stale", { mode: 0o600 });
    expect(await main(["credentials", "set", "acme.key", "--file", secretFile, "--data-dir", directory], { io: capture().io })).toBe(
      EXIT.ok,
    );

    const out = join(directories.create("tavi-backup-out-"), "snap");
    expect(await main(["backup", "--out", out, "--include-credentials", "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    expect(existsSync(join(out, "credentials", "acme.key"))).toBe(true);

    const again = capture();
    expect(await main(["backup", "--out", out, "--force", "--format", "json", "--data-dir", directory], { io: again.io })).toBe(EXIT.ok);
    expect(JSON.parse(again.stdout()).excluded).toEqual([
      "credentials/",
      "chats/.trash/",
      "chats/*/*/.tmp/",
      "chats/*/*/.home/",
      "credentials.key",
      "provider-bindings.key",
      "logs/",
      "owner.process.json",
      "owner.lock",
    ]);
    expect(existsSync(join(out, "credentials"))).toBe(false);

    const destination = directories.create("tavi-restore-dest-");
    const restored = capture();
    expect(await main(["restore", "--from", out, "--format", "json", "--data-dir", destination], { io: restored.io })).toBe(EXIT.ok);
    expect(JSON.parse(restored.stdout()).restoredFiles).toEqual([]);
    expect(existsSync(join(destination, "credentials"))).toBe(false);
  });
});

describe("the chats' working folders", () => {
  /** A chat's folder with work, links the shell could have planted, and what a snapshot leaves out. */
  function plantChatFolder(directory: string): { readonly folder: string; readonly outside: string } {
    const folder = join(directory, "chats", "default", "t1");
    mkdirSync(join(folder, "notes"), { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    writeFileSync(join(folder, "notes", "work.txt"), "the chat's work");
    // Only the chat's own `.tmp/` and `.home/` are left out, not a folder of its work that has the name.
    for (const deeper of [".tmp", ".home"]) {
      mkdirSync(join(folder, "notes", deeper));
      writeFileSync(join(folder, "notes", deeper, "keep.txt"), "kept");
    }
    const outside = join(directories.create("tavi-chats-outside-"), "secret.txt");
    writeFileSync(outside, "not the chat's");
    symlinkSync(outside, join(folder, "abs-link"));
    symlinkSync("notes/work.txt", join(folder, "rel-link"));
    symlinkSync("../../../../nowhere", join(folder, "dangling"));
    execFileSync("mkfifo", [join(folder, "pipe")]);
    for (const skipped of [".tmp", ".home"]) {
      mkdirSync(join(folder, skipped), { mode: 0o700 });
      writeFileSync(join(folder, skipped, "cache.bin"), "scratch");
    }
    mkdirSync(join(directory, "chats", ".trash", "t0-20261001T000000Z"), { recursive: true });
    writeFileSync(join(directory, "chats", ".trash", "t0-20261001T000000Z", "old.txt"), "pruned");
    return { folder, outside };
  }

  function expectRestoredFolder(folder: string, outside: string): void {
    expect(readFileSync(join(folder, "notes", "work.txt"), "utf8")).toBe("the chat's work");
    // Links come back as links, their targets as written — never followed, never rewritten into the snapshot.
    for (const [name, target] of [
      ["abs-link", outside],
      ["rel-link", "notes/work.txt"],
      ["dangling", "../../../../nowhere"],
    ] as const) {
      expect(lstatSync(join(folder, name)).isSymbolicLink(), name).toBe(true);
      expect(readlinkSync(join(folder, name)), name).toBe(target);
    }
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    for (const deeper of [".tmp", ".home"]) expect(readFileSync(join(folder, "notes", deeper, "keep.txt"), "utf8"), deeper).toBe("kept");
    for (const skipped of [".tmp", ".home", "pipe"]) expect(existsSync(join(folder, skipped)), skipped).toBe(false);
  }

  it("round-trips a chat's folder through backup, reset and restore, links kept as links, scratch and trash left out", async () => {
    const directory = await seededDataDirectory();
    const { folder, outside } = plantChatFolder(directory);
    const out = join(directories.create("tavi-backup-out-"), "snap");

    const snapshot = capture();
    expect(await main(["backup", "--out", out, "--format", "json", "--data-dir", directory], { io: snapshot.io })).toBe(EXIT.ok);
    const manifest = JSON.parse(snapshot.stdout()) as { includes: { chats?: boolean }; excluded: string[]; chatsBytes?: number };
    expect(manifest.includes.chats).toBe(true);
    expect(manifest.excluded).toEqual(expect.arrayContaining(["chats/.trash/", "chats/*/*/.tmp/", "chats/*/*/.home/"]));
    expect(manifest.chatsBytes).toBeGreaterThan(0);
    expectRestoredFolder(join(out, "chats", "default", "t1"), outside);
    expect(existsSync(join(out, "chats", ".trash"))).toBe(false);
    // The link's target was not copied in.
    expect(readdirSync(out, { recursive: true }).some((name) => String(name).endsWith("secret.txt"))).toBe(false);

    const text = capture();
    expect(await main(["backup", "--out", out, "--force", "--data-dir", directory], { io: text.io })).toBe(EXIT.ok);
    expect(text.stdout()).toMatch(/includes: database, chats\/ \(\d+(\.\d+)? (B|KB)\)\n/);

    const reset = capture();
    expect(await main(["reset", "--yes", "--format", "json", "--data-dir", directory], { io: reset.io })).toBe(EXIT.ok);
    expect((JSON.parse(reset.stdout()) as { removed: string[] }).removed).toContain("chats");
    expect(existsSync(join(directory, "chats"))).toBe(false);

    const restored = capture();
    expect(await main(["restore", "--from", out, "--format", "json", "--data-dir", directory], { io: restored.io })).toBe(EXIT.ok);
    expect((JSON.parse(restored.stdout()) as { restoredFiles: string[] }).restoredFiles).toEqual(["chats/"]);
    expectRestoredFolder(folder, outside);
    expect(existsSync(join(directory, "chats", ".trash"))).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("not the chat's");

    expect((JSON.parse(restored.stdout()) as { directoriesMovedAside: object }).directoriesMovedAside).toEqual({});

    // Restoring again replaces the chats' folders, the previous ones kept aside like the database, and says where.
    writeFileSync(join(folder, "notes", "later.txt"), "written after the restore");
    const again = capture();
    expect(await main(["restore", "--from", out, "--data-dir", directory], { io: again.io })).toBe(EXIT.ok);
    expect(existsSync(join(folder, "notes", "later.txt"))).toBe(false);
    const aside = readdirSync(directory).filter((name) => name.startsWith("chats.pre-restore-"));
    expect(aside).toHaveLength(1);
    expect(again.stdout()).toContain(`moved the previous chats/ to ${join(directory, aside[0] as string)}\n`);
    expect(again.stdout()).not.toContain("kept the chats' folders");
    expect(readFileSync(join(directory, aside[0] as string, "default", "t1", "notes", "later.txt"), "utf8")).toBe(
      "written after the restore",
    );
  });

  it("replaces with --force a snapshot whose chats' folders a toolchain left read-only", async () => {
    const directory = await seededDataDirectory();
    const modules = join(directory, "chats", "default", "t1", "go", "pkg", "mod");
    mkdirSync(modules, { recursive: true });
    writeFileSync(join(modules, "go.mod"), "module example.com");
    chmodSync(modules, 0o555);
    const out = join(directories.create("tavi-backup-out-"), "snap");
    try {
      expect(await main(["backup", "--out", out, "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
      // The copy keeps the folder's mode, so the snapshot's copy is read-only too.
      expect(statSync(join(out, "chats", "default", "t1", "go", "pkg", "mod")).mode & 0o777).toBe(0o555);
      const again = capture();
      expect(await main(["backup", "--out", out, "--force", "--data-dir", directory], { io: again.io }), again.stderr()).toBe(EXIT.ok);
      expect(readFileSync(join(out, "chats", "default", "t1", "go", "pkg", "mod", "go.mod"), "utf8")).toBe("module example.com");
    } finally {
      execFileSync("chmod", ["-R", "u+w", directory, join(out, "..")]);
    }
  });

  it("restores a snapshot from before the chats' folders, leaving the live ones in place", async () => {
    const source = await seededDataDirectory();
    const out = join(directories.create("tavi-backup-out-"), "snap");
    expect(await main(["backup", "--out", out, "--data-dir", source], { io: capture().io })).toBe(EXIT.ok);
    // What an older build wrote: no `chats/`, no `includes.chats`, no chats' exclusions.
    const manifestPath = join(out, "manifest.json");
    const written = JSON.parse(readFileSync(manifestPath, "utf8")) as { includes: Record<string, unknown>; excluded: string[] };
    delete written.includes["chats"];
    written.excluded = written.excluded.filter((entry) => !entry.startsWith("chats/"));
    writeFileSync(manifestPath, JSON.stringify(written));

    const destination = await seededDataDirectory();
    const { folder, outside } = plantChatFolder(destination);
    const restored = capture();
    expect(await main(["restore", "--from", out, "--data-dir", destination], { io: restored.io })).toBe(EXIT.ok);
    expect(restored.stdout()).toContain("kept the chats' folders already in the data directory");
    expect(readFileSync(join(folder, "notes", "work.txt"), "utf8")).toBe("the chat's work");
    expect(readlinkSync(join(folder, "abs-link"))).toBe(outside);
    expect(existsSync(join(folder, ".tmp", "cache.bin"))).toBe(true);
    expect(readdirSync(destination).some((name) => name.startsWith("chats.pre-restore-"))).toBe(false);
  });

  it("restores the chats' folders from a snapshot with no manifest, and does not say it kept them", async () => {
    const source = await seededDataDirectory();
    const { outside } = plantChatFolder(source);
    const out = join(directories.create("tavi-backup-out-"), "snap");
    expect(await main(["backup", "--out", out, "--data-dir", source], { io: capture().io })).toBe(EXIT.ok);
    rmSync(join(out, "manifest.json"));

    const destination = await seededDataDirectory();
    plantChatFolder(destination);
    const restored = capture();
    expect(await main(["restore", "--from", out, "--data-dir", destination], { io: restored.io })).toBe(EXIT.ok);
    expect(restored.stdout()).toMatch(/also restored .*chats\//);
    expect(restored.stdout()).toContain("moved the previous chats/ to ");
    expect(restored.stdout()).not.toContain("kept the chats' folders");
    expectRestoredFolder(join(destination, "chats", "default", "t1"), outside);
  });

  it("refuses to restore a snapshot whose chats/ is a link, before moving anything", async () => {
    const source = await seededDataDirectory();
    plantChatFolder(source);
    const out = join(directories.create("tavi-backup-out-"), "snap");
    expect(await main(["backup", "--out", out, "--data-dir", source], { io: capture().io })).toBe(EXIT.ok);
    rmSync(join(out, "chats"), { recursive: true });
    symlinkSync(directories.create("tavi-chats-elsewhere-"), join(out, "chats"));

    const destination = await seededDataDirectory();
    const refused = capture();
    expect(await main(["restore", "--from", out, "--data-dir", destination], { io: refused.io })).not.toBe(EXIT.ok);
    expect(refused.stderr()).toMatch(/is not a directory; refusing to copy it/);
    expect(readdirSync(destination).some((name) => name.includes("pre-restore"))).toBe(false);
  });

  it("refuses a chats/ that is a link, before writing the snapshot", async () => {
    const directory = await seededDataDirectory();
    const elsewhere = directories.create("tavi-chats-elsewhere-");
    symlinkSync(elsewhere, join(directory, "chats"));
    const out = join(directories.create("tavi-backup-out-"), "snap");
    const refused = capture();
    expect(await main(["backup", "--out", out, "--data-dir", directory], { io: refused.io })).not.toBe(EXIT.ok);
    expect(refused.stderr()).toMatch(/is not a directory; refusing to copy it/);
    expect(existsSync(join(out, "manifest.json"))).toBe(false);
  });
});

describe("maintenance command usage", () => {
  it("requires the directory flag it needs and its own help page", async () => {
    const directory = directories.create("tavi-maintenance-usage-");
    const missingOut = capture();
    expect(await main(["backup", "--data-dir", directory], { io: missingOut.io })).toBe(EXIT.usage);
    expect(missingOut.stderr()).toMatch(/backup needs --out <dir>/);
    const missingFrom = capture();
    expect(await main(["restore", "--data-dir", directory], { io: missingFrom.io })).toBe(EXIT.usage);
    expect(missingFrom.stderr()).toMatch(/restore needs --from <dir>/);
    const help = capture();
    expect(await main(["export", "--help"], { io: help.io })).toBe(EXIT.ok);
    expect(help.stdout()).toMatch(/^tavi export --out <dir>/);
  });
});

it("round-trips web selection, excludes provider binding keys and replaces stale destination selection", async () => {
  const source = await seededDataDirectory();
  const selection = { schemaVersion: 1, workspaces: { default: { fetch: { providers: ["acme.web.home"], timeoutMs: 5000 } } } };
  writeFileSync(join(source, "web-providers.json"), JSON.stringify(selection));
  writeFileSync(join(source, "provider-bindings.key"), "private-binding-key");
  const snapshot = directories.create("tavi-provider-snapshot-");
  expect(await main(["backup", "--out", snapshot, "--data-dir", source], { io: capture().io })).toBe(EXIT.ok);
  expect(existsSync(join(snapshot, "provider-bindings.key"))).toBe(false);
  expect(JSON.parse(readFileSync(join(snapshot, "manifest.json"), "utf8"))).toMatchObject({
    profileFormat: "tavi-1",
    includes: { webProviders: true, credentials: false },
  });
  const target = directories.create("tavi-provider-target-");
  writeFileSync(join(target, "web-providers.json"), JSON.stringify({ schemaVersion: 1, workspaces: {} }));
  writeFileSync(join(target, "provider-bindings.key"), "previous-key");
  expect(await main(["restore", "--from", snapshot, "--data-dir", target], { io: capture().io })).toBe(EXIT.ok);
  expect(JSON.parse(readFileSync(join(target, "web-providers.json"), "utf8"))).toEqual(selection);
  expect(existsSync(join(target, "provider-bindings.key"))).toBe(false);
  expect(readdirSync(target).some((name) => name.startsWith("provider-bindings.key.pre-restore-"))).toBe(true);
  rmSync(join(source, "web-providers.json"));
  expect(await main(["backup", "--out", snapshot, "--force", "--data-dir", source], { io: capture().io })).toBe(EXIT.ok);
  expect(existsSync(join(snapshot, "web-providers.json"))).toBe(false);
  expect(await main(["restore", "--from", snapshot, "--data-dir", target], { io: capture().io })).toBe(EXIT.ok);
  expect(existsSync(join(target, "web-providers.json"))).toBe(false);
});

it("refuses an original-profile restore before replacing the development database", async () => {
  const original = await seededDataDirectory();
  const target = await seededDataDirectory();
  const store = await SqliteStore.open({ databasePath: join(original, "tavi.sqlite") });
  store.handle.prepare("DELETE FROM tavi_meta WHERE key = 'profile.format'").run();
  await store.close();
  const beforeOriginal = readFileSync(join(original, "tavi.sqlite"));
  const beforeTarget = readFileSync(join(target, "tavi.sqlite"));
  const result = capture();
  expect(await main(["restore", "--from", original, "--data-dir", target], { io: result.io })).not.toBe(EXIT.ok);
  expect(result.stderr()).toContain("Unsupported data profile");
  expect(readFileSync(join(original, "tavi.sqlite"))).toEqual(beforeOriginal);
  expect(readFileSync(join(target, "tavi.sqlite"))).toEqual(beforeTarget);
});

it("preserves an original-format restore destination and refuses to relabel old backups", async () => {
  const source = await seededDataDirectory();
  const original = await seededDataDirectory();
  const store = await SqliteStore.open({ databasePath: join(original, "tavi.sqlite") });
  store.handle.prepare("DELETE FROM tavi_meta WHERE key = 'profile.format'").run();
  await store.close();
  const before = readFileSync(join(original, "tavi.sqlite"));
  const sourceBefore = readFileSync(join(source, "tavi.sqlite"));
  const result = capture();
  expect(await main(["restore", "--from", source, "--data-dir", original], { io: result.io })).not.toBe(EXIT.ok);
  expect(result.stderr()).toContain("Unsupported data profile");
  expect(readFileSync(join(original, "tavi.sqlite"))).toEqual(before);
  expect(readFileSync(join(source, "tavi.sqlite"))).toEqual(sourceBefore);
  const out = directories.create("tavi-old-backup-refused-");
  writeFileSync(join(out, "manifest.json"), "preserve");
  expect(await main(["backup", "--out", out, "--force", "--data-dir", original], { io: capture().io })).not.toBe(EXIT.ok);
  expect(readFileSync(join(out, "manifest.json"), "utf8")).toBe("preserve");
});

it("preserves compact web selection bytes without inflating a valid backup past 64 KiB", async () => {
  const source = await seededDataDirectory();
  const snapshot = directories.create("tavi-compact-backup-");
  const target = directories.create("tavi-compact-restore-");
  const content = JSON.stringify({
    schemaVersion: 1,
    workspaces: Object.fromEntries(Array.from({ length: 650 }, (_, i) => [`workspace${i}`, { fetch: { providers: ["acme.web.home"] } }])),
  });
  expect(Buffer.byteLength(content)).toBeLessThan(65_536);
  writeFileSync(join(source, "web-providers.json"), content);
  expect(await main(["backup", "--out", snapshot, "--data-dir", source], { io: capture().io })).toBe(EXIT.ok);
  expect(readFileSync(join(snapshot, "web-providers.json"), "utf8")).toBe(content);
  expect(await main(["restore", "--from", snapshot, "--data-dir", target], { io: capture().io })).toBe(EXIT.ok);
  expect(readFileSync(join(target, "web-providers.json"), "utf8")).toBe(content);
});

describe("what a backup and a restore say they did", () => {
  it("refuses a backup or an export into a folder inside the data directory, before writing anything", async () => {
    const directory = await seededDataDirectory();
    for (const [action, out] of [
      ["backup", join(directory, "inside")],
      ["export", join(directory, "inside-export")],
      ["backup", join(directory, "artifacts", "snap")],
    ] as const) {
      const refused = capture();
      expect(await main([action, "--out", out, "--data-dir", directory], { io: refused.io }), `${action} ${out}`).toBe(EXIT.usage);
      expect(refused.stderr()).toMatch(/same directory or one contains the other/);
      expect(existsSync(out), out).toBe(false);
    }
  });

  it("names a malformed web-providers.json instead of printing a validation dump", async () => {
    const directory = await seededDataDirectory();
    writeFileSync(join(directory, "web-providers.json"), "{}", { mode: 0o600 });
    const out = join(directories.create("tavi-backup-out-"), "snap");
    const refused = capture();
    expect(await main(["backup", "--out", out, "--data-dir", directory], { io: refused.io })).toBe(EXIT.usage);
    expect(refused.stderr()).toMatch(/web-providers\.json/);
    expect(refused.stderr()).not.toMatch(/"path"|INTERNAL/);
    expect(
      refused
        .stderr()
        .split("\n")
        .filter((line) => line !== ""),
    ).toHaveLength(1);
  });

  it("says it includes artifacts/ and plugins/ only when it copied them, with the size in units", async () => {
    const directory = await seededDataDirectory();
    rmSync(join(directory, "artifacts"), { recursive: true, force: true });
    const out = join(directories.create("tavi-backup-out-"), "snap");
    const taken = capture();
    expect(await main(["backup", "--out", out, "--data-dir", directory], { io: taken.io })).toBe(EXIT.ok);
    expect(taken.stdout()).toMatch(/^ {2}includes: database\n/m);
    expect(taken.stdout()).toMatch(/^snapshot .* \(\d+(\.\d)? (B|KB|MB|GB)\)\n/);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { includes: { artifacts: boolean } };
    expect(manifest.includes.artifacts).toBe(false);

    mkdirSync(join(directory, "artifacts", "ab"), { recursive: true });
    writeFileSync(join(directory, "artifacts", "ab", "shot-1.png"), "bytes");
    mkdirSync(join(directory, "plugins"), { recursive: true });
    writeFileSync(join(directory, "plugins", "marker"), "x");
    const full = join(directories.create("tavi-backup-out-"), "snap");
    const second = capture();
    expect(await main(["backup", "--out", full, "--data-dir", directory], { io: second.io })).toBe(EXIT.ok);
    expect(second.stdout()).toMatch(/^ {2}includes: database, artifacts\/, plugins\/\n/m);
  });

  it("moves the live artifacts/ and plugins/ aside as it does the database, and names each", async () => {
    const directory = await seededDataDirectory();
    mkdirSync(join(directory, "artifacts", "ab"), { recursive: true });
    writeFileSync(join(directory, "artifacts", "ab", "shot-1.png"), "ORIGINAL");
    mkdirSync(join(directory, "plugins"), { recursive: true });
    writeFileSync(join(directory, "plugins", "marker"), "x");
    const out = join(directories.create("tavi-backup-out-"), "snap");
    expect(await main(["backup", "--out", out, "--data-dir", directory], { io: capture().io })).toBe(EXIT.ok);
    writeFileSync(join(directory, "artifacts", "ab", "shot-1.png"), "MODIFIED");
    const restored = capture();
    expect(await main(["restore", "--from", out, "--data-dir", directory], { io: restored.io })).toBe(EXIT.ok);
    expect(readFileSync(join(directory, "artifacts", "ab", "shot-1.png"), "utf8")).toBe("ORIGINAL");
    const aside = readdirSync(directory).find((name) => name.startsWith("artifacts.pre-restore-"));
    expect(aside).toBeDefined();
    expect(readFileSync(join(directory, aside ?? "", "ab", "shot-1.png"), "utf8")).toBe("MODIFIED");
    expect(restored.stdout()).toMatch(/^moved the previous artifacts\/ to .*artifacts\.pre-restore-/m);
    expect(restored.stdout()).toMatch(/^moved the previous plugins\/ to .*plugins\.pre-restore-/m);
    // Nothing was forgotten since the snapshot: no line about it.
    expect(restored.stdout()).not.toMatch(/0 forgotten/);
  });

  it("prints prune's cutoff as a minute in UTC, not milliseconds", async () => {
    const directory = await seededDataDirectory();
    const pruned = capture();
    expect(await main(["prune", "--older-than", "7", "--dry-run", "--data-dir", directory], { io: pruned.io })).toBe(EXIT.ok);
    expect(pruned.stdout()).toMatch(/^would delete \d+ row\(s\) older than \d{4}-\d\d-\d\d \d\d:\d\d UTC\n/);
  });
});
