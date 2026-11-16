import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "@tavi/runtime";
import { DEFAULT_KEPT_MODEL_REQUESTS, type ModelPriceSheet, type ModelRequest } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { ModelAccounting } from "../src/persistence/model-accounting.js";
import { RECLAIM_MIN_FREE_BYTES, SqliteStore } from "../src/persistence/store.js";
import { loadBetterSqlite3 } from "../src/persistence/sqlite-loader.js";

/**
 * Request retention: a run's newest attempts keep their whole request,
 * older settled ones keep usage, cost, ids, the operation and the request's
 * hash; requests live in `tavi_provider_attempt_requests`; `reclaimSpace`
 * returns the freed pages to the operating system.
 */

const AT = "2026-10-05T00:00:00.000Z";
const later = (seconds: number) => new Date(Date.parse(AT) + seconds * 1000).toISOString();
const price: ModelPriceSheet = {
  revision: "price-1",
  connectionId: "main",
  model: "m",
  effectiveAt: AT,
  currency: "USD",
  input: 2,
  cacheRead: 2,
  cacheWrite: 2,
  output: 10,
};
const requestOf = (runId: string, attemptId: string): ModelRequest => ({
  connectionId: "main",
  model: "m",
  runId,
  attemptId,
  attemptNumber: 1,
  messages: [{ id: `m-${attemptId}`, role: "user", text: `hello ${attemptId}`, createdAt: AT }],
  tools: [{ id: "t", name: "t", description: "a tool", inputJsonSchema: { type: "object" } }],
});

const stores: SqliteStore[] = [];
const directories = temporaryDirectories();
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  directories.cleanup();
});
function ledger() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  const accounting = new ModelAccounting(store.handle);
  accounting.putPrice(price);
  return { db: store.handle, accounting };
}
type Ledger = ReturnType<typeof ledger>;
const call = (
  { accounting }: Ledger,
  runId: string,
  index: number,
  finish?: { readonly state?: "completed" | "failed" | "uncertain"; readonly kept?: number },
) => {
  accounting.begin({
    callId: `${runId}-c${index}`,
    runId,
    attemptId: `a${index}`,
    ownerSession: "s",
    connectionId: "main",
    model: "m",
    purpose: "generation",
    startedAt: later(index),
    priceRevision: price.revision,
    request: requestOf(runId, `a${index}`),
  });
  if (finish !== undefined) {
    accounting.finish(
      `${runId}-c${index}`,
      finish.state ?? "completed",
      finish.state === "uncertain" ? {} : { inputTokens: 1000, outputTokens: 100 },
      later(index),
      ...(finish.kept === undefined ? [] : ([{ keptRequests: finish.kept }] as const)),
    );
  }
};
const carrying = ({ db }: Ledger, runId: string) =>
  (
    db
      .prepare(
        "SELECT a.attempt_id FROM tavi_provider_attempts a JOIN tavi_provider_attempt_requests r ON r.call_id = a.call_id WHERE a.run_id=? ORDER BY a.started_at",
      )
      .all(runId) as { attempt_id: string }[]
  ).map((row) => row.attempt_id);
// The statement `stripRequests` runs (persistence/model-accounting.ts).
const STRIP_QUERY = `DELETE FROM tavi_provider_attempt_requests
      WHERE call_id IN (SELECT call_id FROM tavi_provider_attempt_requests WHERE run_id=? ORDER BY started_at DESC, call_id DESC LIMIT -1 OFFSET ?)
        AND call_id NOT IN (SELECT call_id FROM tavi_provider_attempts WHERE run_id=? AND state='started')`;

describe("request retention", () => {
  it("keeps the request on a run's newest attempts only, and everything else on all of them", () => {
    const fixture = ledger();
    for (let index = 1; index <= DEFAULT_KEPT_MODEL_REQUESTS + 5; index += 1) call(fixture, "run", index, {});
    call(fixture, "other", 1, {});
    const attempts = fixture.accounting.list("run");
    expect(attempts).toHaveLength(DEFAULT_KEPT_MODEL_REQUESTS + 5);
    expect(attempts.filter((attempt) => attempt.request !== undefined).map((attempt) => attempt.attemptId)).toEqual(
      Array.from({ length: DEFAULT_KEPT_MODEL_REQUESTS }, (_, index) => `a${index + 6}`),
    );
    expect(carrying(fixture, "run")).toEqual(Array.from({ length: DEFAULT_KEPT_MODEL_REQUESTS }, (_, index) => `a${index + 6}`));
    // A stripped attempt keeps its usage, cost, ids and the request's hash.
    const stripped = attempts[0];
    expect(stripped).toMatchObject({
      attemptId: "a1",
      state: "completed",
      usage: { inputTokens: 1000, outputTokens: 100 },
      estimatedUsd: 0.003,
      priceRevision: "price-1",
    });
    expect(stripped?.request).toBeUndefined();
    expect(stripped?.requestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(attempts.map((attempt) => attempt.requestSha256)).size).toBe(attempts.length);
    // Reports read columns, so they see every attempt as before.
    expect(fixture.accounting.costTotals("run")).toEqual({
      attempts: DEFAULT_KEPT_MODEL_REQUESTS + 5,
      priced: DEFAULT_KEPT_MODEL_REQUESTS + 5,
      usd: expect.closeTo(0.003 * (DEFAULT_KEPT_MODEL_REQUESTS + 5), 9),
    });
    expect(fixture.accounting.summaries("run")).toHaveLength(DEFAULT_KEPT_MODEL_REQUESTS + 5);
    // Another run's requests are its own.
    expect(carrying(fixture, "other")).toEqual(["a1"]);
  });

  it("honours a run's retention, never strips a started attempt, and keeps an uncertain one's operation for the check before each call", () => {
    const fixture = ledger();
    call(fixture, "run", 1);
    for (let index = 2; index <= 4; index += 1) call(fixture, "run", index, { kept: 2 });
    expect(carrying(fixture, "run")).toEqual(["a1", "a3", "a4"]);
    call(fixture, "run", 5, { state: "uncertain", kept: 0 });
    // Kept 0: every settled attempt is stripped; the started one keeps its request.
    expect(carrying(fixture, "run")).toEqual(["a1"]);
    expect(fixture.accounting.get("run-c1")?.request).toEqual(requestOf("run", "a1"));
    const open = fixture.accounting.list("run", { states: ["started", "uncertain"] });
    expect(open.map((attempt) => [attempt.attemptId, attempt.state, attempt.request === undefined])).toEqual([
      ["a1", "started", false],
      ["a5", "uncertain", true],
    ]);
    // Recovery settles the started one as uncertain; the next settled call, with a retention, strips it.
    fixture.accounting.finish("run-c1", "uncertain", {}, later(9), { keptRequests: 0 });
    expect(carrying(fixture, "run")).toEqual([]);
    expect(() => fixture.accounting.finish("run-c1", "completed", {}, later(9), { keptRequests: -1 })).toThrow(/keptRequests/);
  });

  it("prunes only when the settling attempt stored a request: a router call keeps the chat's retention", () => {
    const fixture = ledger();
    for (let index = 1; index <= 3; index += 1) call(fixture, "run", index, { kept: 50 });
    fixture.accounting.begin({
      callId: "router",
      runId: "run",
      attemptId: "router",
      ownerSession: "s",
      connectionId: "main",
      model: "m",
      purpose: "router",
      startedAt: later(10),
    });
    fixture.accounting.finish("router", "completed", {}, later(10));
    expect(carrying(fixture, "run")).toEqual(["a1", "a2", "a3"]);
    expect(fixture.accounting.get("router")?.requestSha256).toBeUndefined();
  });

  it("finds the requests to drop through their run index and the started attempts through theirs, not the run's history", () => {
    const { db } = ledger();
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${STRIP_QUERY}`).all("run", 10, "run") as { detail: string }[])
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("USING INDEX tavi_provider_attempt_requests_run (run_id=?)");
    expect(plan).toContain("SEARCH tavi_provider_attempts USING INDEX tavi_provider_attempts_run_state (run_id=? AND state=?)");
  });

  it("keeps attempt rows small, and drops an attempt's request with the attempt", () => {
    const fixture = ledger();
    for (let index = 1; index <= 3; index += 1) call(fixture, "run", index, {});
    expect(
      fixture.db.prepare("SELECT count(*) AS n FROM tavi_provider_attempts WHERE json_type(data, '$.request') IS NOT NULL").get(),
    ).toEqual({ n: 0 });
    expect(fixture.accounting.deleteRun("run")).toBe(3);
    expect(fixture.db.prepare("SELECT count(*) AS n FROM tavi_provider_attempt_requests").get()).toEqual({ n: 0 });
  });
});

describe("reclaiming space", () => {
  const directory = () => {
    const path = directories.create("tavi-reclaim-");
    return join(path, "tavi.sqlite");
  };
  /** Rows of about `mib` MiB in a scratch table, then deleted: free pages in the file. */
  const churn = (db: SqliteStore["handle"], mib: number) => {
    db.exec("CREATE TABLE IF NOT EXISTS scratch (body BLOB)");
    const insert = db.prepare("INSERT INTO scratch VALUES (randomblob(?))");
    db.transaction(() => {
      for (let index = 0; index < mib * 16; index += 1) insert.run(64 * 1024);
    })();
    db.exec("DELETE FROM scratch");
    db.pragma("wal_checkpoint(TRUNCATE)");
  };
  /** The database and its write-ahead log: what the file costs on disk. */
  const fileBytes = (path: string) => statSync(path).size + (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0);

  it("creates new files incrementally vacuumed, leaves little free space alone, and truncates a lot", () => {
    const path = directory();
    const store = new SqliteStore({ databasePath: path });
    stores.push(store);
    expect(store.handle.pragma("auto_vacuum", { simple: true })).toBe(2);
    expect(store.reclaimSpace()).toMatchObject({ autoVacuum: "incremental", action: "none" });
    churn(store.handle, 48);
    const before = fileBytes(path);
    const reclaimed = store.reclaimSpace();
    expect(reclaimed).toMatchObject({ autoVacuum: "incremental", action: "incremental_vacuum" });
    expect(reclaimed.freeBytes).toBeGreaterThanOrEqual(RECLAIM_MIN_FREE_BYTES);
    expect(reclaimed.reclaimedBytes).toBeGreaterThanOrEqual(RECLAIM_MIN_FREE_BYTES);
    expect(fileBytes(path)).toBeLessThan(before - RECLAIM_MIN_FREE_BYTES);
    expect(store.reclaimSpace().action).toBe("none");
  });

  it("rebuilds an older build's file once, switching it to incremental, while a reader is open", () => {
    const path = directory();
    new SqliteStore({ databasePath: path }).close();
    // An older build's file: auto_vacuum NONE, with most of it free.
    const raw = new (loadBetterSqlite3())(path);
    raw.pragma("auto_vacuum = NONE");
    raw.exec("VACUUM");
    churn(raw, 48);
    raw.close();
    const store = new SqliteStore({ databasePath: path });
    stores.push(store);
    expect(store.handle.pragma("auto_vacuum", { simple: true })).toBe(0);
    const reader = new (loadBetterSqlite3())(path, { readonly: true });
    try {
      expect(reader.prepare("SELECT count(*) AS n FROM tavi_schema_migrations").get()).toMatchObject({ n: MIGRATIONS.length });
      const before = fileBytes(path);
      const reclaimed = store.reclaimSpace();
      expect(reclaimed).toMatchObject({ autoVacuum: "incremental", action: "vacuum" });
      expect(fileBytes(path)).toBeLessThan(before - RECLAIM_MIN_FREE_BYTES);
      expect(reader.prepare("SELECT count(*) AS n FROM tavi_schema_migrations").get()).toMatchObject({ n: MIGRATIONS.length });
    } finally {
      reader.close();
    }
    expect(store.reclaimSpace().action).toBe("none");
  });

  it("leaves an in-memory store alone", () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    stores.push(store);
    churn(store.handle, 40);
    expect(store.reclaimSpace().action).toBe("none");
  });
});
