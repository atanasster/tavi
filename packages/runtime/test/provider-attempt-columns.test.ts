import { afterEach, describe, expect, it } from "vitest";
import { ModelAccounting as AsyncModelAccounting } from "@tavi/runtime";
import type { ModelPriceSheet } from "@tavi/contracts";
import { ModelAccounting } from "../src/persistence/model-accounting.js";
import { SqliteStore } from "../src/persistence/store.js";
import { DatabaseClient } from "../src/persistence/client.js";

/**
 * Provider attempts' `purpose` and `input_tokens` columns,
 * written by `begin` and `finish`, and the `(run_id, state, started_at)` index for the per-call check
 * of a run's started or uncertain attempts. Plus the projection reads
 * (`summaries`, `costTotals`) that read no stored request.
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

const stores: SqliteStore[] = [];
const clients: DatabaseClient[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const client of clients.splice(0)) await client.close();
});
function ledger() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  return { db: store.handle, accounting: new ModelAccounting(store.handle) };
}
// The query `list` runs with `states` (persistence/model-accounting.ts).
const STATES_QUERY =
  "SELECT a.data, r.request FROM tavi_provider_attempts a LEFT JOIN tavi_provider_attempt_requests r ON r.call_id = a.call_id WHERE a.run_id=? AND a.state IN (?, ?) ORDER BY +a.started_at, a.call_id";

describe("the run-and-state index", () => {
  it("serves the per-call states query from the run-and-state index", () => {
    const { db } = ledger();
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${STATES_QUERY}`).all("run", "started", "uncertain") as { detail: string }[])
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("USING INDEX tavi_provider_attempts_run_state (run_id=? AND state=?)");
  });
});

describe("provider attempt columns", () => {
  it("writes purpose at begin and input tokens at finish", () => {
    const { db, accounting } = ledger();
    accounting.begin({
      callId: "c1",
      runId: "run",
      attemptId: "a1",
      ownerSession: "s",
      connectionId: "main",
      model: "m",
      purpose: "summary",
      startedAt: AT,
    });
    const row = () => db.prepare("SELECT purpose, input_tokens, state FROM tavi_provider_attempts WHERE call_id = 'c1'").get();
    expect(row()).toEqual({ purpose: "summary", input_tokens: null, state: "started" });
    accounting.finish("c1", "completed", { inputTokens: 345, outputTokens: 6 }, later(1));
    expect(row()).toEqual({ purpose: "summary", input_tokens: 345, state: "completed" });

    accounting.begin({
      callId: "c2",
      runId: "run",
      attemptId: "a2",
      ownerSession: "s",
      connectionId: "main",
      model: "m",
      purpose: "generation",
      startedAt: later(2),
    });
    accounting.finish("c2", "uncertain", {}, later(3));
    expect(db.prepare("SELECT purpose, input_tokens FROM tavi_provider_attempts WHERE call_id = 'c2'").get()).toEqual({
      purpose: "generation",
      input_tokens: null,
    });
  });
});

describe("attempt projections", () => {
  function seeded() {
    const fixture = ledger();
    const { accounting } = fixture;
    accounting.putPrice(price);
    const call = (index: number, state: "completed" | "uncertain", priced: boolean, connectionId = "main") => {
      accounting.begin({
        callId: `c${index}`,
        runId: "run",
        attemptId: `a${index}`,
        ownerSession: "s",
        connectionId,
        model: "m",
        purpose: "generation",
        startedAt: later(index),
        ...(priced ? { priceRevision: price.revision } : {}),
      });
      accounting.finish(`c${index}`, state, state === "completed" ? { inputTokens: 1000, outputTokens: 100 } : {}, later(index));
    };
    call(1, "completed", true);
    call(2, "uncertain", true);
    call(3, "completed", false, "other");
    call(4, "completed", true);
    accounting.begin({
      callId: "elsewhere",
      runId: "other-run",
      attemptId: "x",
      ownerSession: "s",
      connectionId: "main",
      model: "m",
      purpose: "generation",
      startedAt: AT,
      priceRevision: price.revision,
    });
    accounting.finish("elsewhere", "completed", { inputTokens: 1000, outputTokens: 100 }, AT);
    return fixture;
  }

  it("lists a run's attempts oldest first without their requests, and keeps only the newest when asked", () => {
    const { accounting } = seeded();
    const usd = 0.003; // (1000 × 2 + 100 × 10) / 1e6
    expect(accounting.summaries("run")).toEqual([
      {
        callId: "c1",
        attemptId: "a1",
        connectionId: "main",
        model: "m",
        state: "completed",
        purpose: "generation",
        usage: { inputTokens: 1000, outputTokens: 100 },
        estimatedUsd: usd,
        startedAt: later(1),
      },
      {
        callId: "c2",
        attemptId: "a2",
        connectionId: "main",
        model: "m",
        state: "uncertain",
        purpose: "generation",
        usage: {},
        startedAt: later(2),
      },
      {
        callId: "c3",
        attemptId: "a3",
        connectionId: "other",
        model: "m",
        state: "completed",
        purpose: "generation",
        usage: { inputTokens: 1000, outputTokens: 100 },
        startedAt: later(3),
      },
      {
        callId: "c4",
        attemptId: "a4",
        connectionId: "main",
        model: "m",
        state: "completed",
        purpose: "generation",
        usage: { inputTokens: 1000, outputTokens: 100 },
        estimatedUsd: usd,
        startedAt: later(4),
      },
    ]);
    expect(accounting.summaries("run", { last: 2 }).map((row) => row.callId)).toEqual(["c3", "c4"]);
    expect(accounting.summaries("run", { last: 20 })).toHaveLength(4);
    expect(accounting.summaries("run", { last: 0 })).toEqual([]);
    expect(accounting.summaries("missing")).toEqual([]);
    expect(() => accounting.summaries("run", { last: -1 })).toThrow("non-negative");
  });

  it("totals a run's attempts and dollar estimates in the database, matching the full list", () => {
    const { accounting } = seeded();
    const full = accounting.list("run");
    const known = full.filter((attempt) => attempt.estimatedUsd !== undefined);
    expect(accounting.costTotals("run")).toEqual({
      attempts: full.length,
      priced: known.length,
      usd: known.reduce((sum, attempt) => sum + (attempt.estimatedUsd ?? 0), 0),
    });
    expect(accounting.costTotals("run")).toMatchObject({ attempts: 4, priced: 2 });
    expect(accounting.costTotals("missing")).toEqual({ attempts: 0, priced: 0, usd: 0 });
  });

  it("names the connections a run's generation calls went to, each once, and no other purpose's", () => {
    const { accounting } = seeded();
    accounting.begin({
      callId: "routed",
      runId: "run",
      attemptId: "r",
      ownerSession: "s",
      connectionId: "router-only",
      model: "m",
      purpose: "router",
      startedAt: later(5),
    });
    expect([...accounting.usedConnections("run")].sort()).toEqual(["main", "other"]);
    expect(accounting.usedConnections("missing")).toEqual([]);
    // Many runs in one read: each run asked once, in the order asked, with what `usedConnections` says of it.
    const many = accounting.usedConnectionsOf(["missing", "run", "missing"]);
    expect(many.map((entry) => ({ ...entry, connections: [...entry.connections].sort() }))).toEqual([
      { runId: "missing", connections: [] },
      { runId: "run", connections: ["main", "other"] },
    ]);
    expect(accounting.usedConnectionsOf([])).toEqual([]);
  });

  it("answers both reads through the database worker", async () => {
    const client = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
    clients.push(client);
    const accounting = new AsyncModelAccounting(client.asPort());
    await accounting.begin({
      callId: "c1",
      runId: "run",
      attemptId: "a1",
      ownerSession: "s",
      connectionId: "main",
      model: "m",
      purpose: "router",
      startedAt: AT,
    });
    await accounting.finish("c1", "failed", {}, later(1));
    expect(await accounting.summaries("run", { last: 5 })).toEqual([
      { callId: "c1", attemptId: "a1", connectionId: "main", model: "m", state: "failed", purpose: "router", usage: {}, startedAt: AT },
    ]);
    expect(await accounting.costTotals("run")).toEqual({ attempts: 1, priced: 0, usd: 0 });
    expect(await accounting.usedConnections("run")).toEqual([]);
    expect(await accounting.usedConnectionsOf(["run"])).toEqual([{ runId: "run", connections: [] }]);
  });
});
