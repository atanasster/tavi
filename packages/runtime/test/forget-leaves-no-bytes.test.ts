import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryActor, MemoryScope, TranscriptTurn } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";

import { MemoryService } from "../src/memory/service.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * Forgotten means gone from the file, not only from the tables: the database
 * runs `secure_delete`, so a deletion zeroes what it frees (a long text's
 * overflow pages included), and a forget truncates the write-ahead log, whose
 * older frames would otherwise keep the words until they were overwritten.
 * Each case writes a distinctive word through the real repositories, checks the
 * raw bytes hold it, forgets it, and checks neither the file nor its log does.
 */

const AT = "2026-10-12T08:00:00.000Z";
const alice: MemoryActor = { principalId: "alice", workspaceId: "w1", caller: "cli", authority: "operator" };
const personal: MemoryScope = { kind: "personal", principalId: "alice" };

const directories = temporaryDirectories();
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  directories.cleanup();
});

function open(): { store: SqliteStore; path: string } {
  const directory = directories.create("tavi-forget-bytes-");
  const path = join(directory, "tavi.sqlite");
  const store = new SqliteStore({ databasePath: path, artifactsDirectory: join(directory, "artifacts") });
  stores.push(store);
  return { store, path };
}

/** How many times `word` appears in the database file and in its write-ahead log. */
function occurrences(path: string, word: string): { file: number; log: number } {
  const count = (file: string): number => {
    if (!existsSync(file)) return 0;
    const bytes = readFileSync(file);
    const needle = Buffer.from(word);
    let found = 0;
    for (let at = bytes.indexOf(needle); at !== -1; at = bytes.indexOf(needle, at + 1)) found += 1;
    return found;
  };
  return { file: count(path), log: count(`${path}-wal`) };
}

/** The scrub a forget schedules has run: the log is empty. */
async function logTruncated(path: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0).toBe(0);
    },
    { timeout: 10_000, interval: 100 },
  );
}

/** Filler long enough that the row spills onto overflow pages, which `secure_delete = FAST` would leave as they were. */
const long = (word: string): string => `${word} ${"the quiet orchard keeps its own counsel ".repeat(150)}${word}`;

describe("forgetting leaves no bytes behind", () => {
  it("every connection the store opens zeroes what it deletes", () => {
    const { store } = open();
    expect(store.handle.pragma("secure_delete", { simple: true })).toBe(1);
  });

  it("a forgotten memory's words are gone from the file and its log", async () => {
    const { store, path } = open();
    let counter = 0;
    const service = new MemoryService(store.asPort(), { now: () => AT, newId: (prefix) => `${prefix}-${(counter += 1)}` });
    const record = service.remember({ actor: alice, scope: personal, kind: "fact", title: "Allergy", body: long("quokkalimnetic") });
    service.remember({ actor: alice, scope: personal, kind: "fact", body: "Owns a bicycle" });
    // In the file itself, as an old memory would be, before it is forgotten.
    store.handle.pragma("wal_checkpoint(TRUNCATE)");
    expect(occurrences(path, "quokkalimnetic").file).toBeGreaterThan(0);

    service.forget({ actor: alice, recordId: record.recordId, reason: "test" });
    await logTruncated(path);
    expect(occurrences(path, "quokkalimnetic")).toEqual({ file: 0, log: 0 });
    expect(service.search({ actor: alice, query: "bicycle" }).hits).toHaveLength(1);
  });

  it("a forgotten chat's turns are gone from the file and its log, written since the last checkpoint or before it", async () => {
    const { store, path } = open();
    const repositories = store.asPort().repositories;
    repositories.tasks.admit({
      workspaceId: "w1",
      principalId: "alice",
      operationKey: "op-1",
      kind: "start",
      intent: null,
      checkpointNamespace: "",
      newTaskId: () => "task-1",
      newAdmissionId: () => "adm-1",
      newThreadId: () => "thread-1",
      now: () => AT,
    });
    const turn = (prompt: string): TranscriptTurn => ({
      admissionKind: "reply",
      prompt,
      items: [{ kind: "text", text: `noted: ${prompt}` }],
      outcome: { status: "completed", finalText: `noted: ${prompt}` },
    });
    repositories.transcripts.append({ taskId: "task-1", admissionId: "adm-1", turn: turn(long("zebrinoctave")), createdAt: AT });
    store.handle.pragma("wal_checkpoint(TRUNCATE)");
    // A second turn only the log holds.
    repositories.transcripts.append({ taskId: "task-1", admissionId: "adm-2", turn: turn(long("yakutskenvoy")), createdAt: AT });
    expect(occurrences(path, "zebrinoctave").file).toBeGreaterThan(0);
    expect(occurrences(path, "yakutskenvoy").log).toBeGreaterThan(0);

    repositories.transcripts.forget("task-1", "2026-10-13T00:00:00.000Z");
    await logTruncated(path);
    for (const word of ["zebrinoctave", "yakutskenvoy"]) expect(occurrences(path, word)).toEqual({ file: 0, log: 0 });
  });

  it("truncating the log never waits for a reader, and succeeds once the reader lets go", () => {
    const { store, path } = open();
    store.handle.exec("CREATE TABLE scratch (body TEXT)");
    store.handle.prepare("INSERT INTO scratch VALUES (?)").run("x");
    const reader = new Database(path, { readonly: true });
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) FROM scratch").get();
      store.handle.prepare("INSERT INTO scratch VALUES (?)").run("y");
      const started = Date.now();
      expect(store.scrubErased()).toBe(false);
      expect(Date.now() - started).toBeLessThan(1000);
      reader.exec("COMMIT");
    } finally {
      reader.close();
    }
    expect(store.scrubErased()).toBe(true);
    expect(statSync(`${path}-wal`).size).toBe(0);
  });
});
