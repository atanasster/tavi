import { channel } from "node:diagnostics_channel";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { RoutineCreateSchema, routineDefaults } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories } from "@tavi/test-support";
import { DatabaseClient } from "../src/persistence/client.js";
import { RoutineService, RoutineExecutionService } from "../src/persistence/routine-facades.js";

const cleanups: (() => void | Promise<void>)[] = [];
const directories = temporaryDirectories();
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  directories.cleanup();
});
const scope = { workspaceId: "default", principalId: "operator" };
async function fixture(dispatch?: ConstructorParameters<typeof RoutineExecutionService>[1]["dispatch"]) {
  const directory = directories.create("tavi-routine-worker-");
  const db = await DatabaseClient.open({ databasePath: join(directory, "db.sqlite") });
  cleanups.push(() => db.close());
  await db.call("routine.configure", {
    ownerEpoch: "owner",
    workspaces: [{ ...scope, permissions: [] }],
    toolPermissions: { web_search: [], "http.request": [] },
    destinations: [],
    providerConnectionIds: [],
    modelOverride: true,
    executionAvailable: true,
    allowedHosts: ["example.com"],
  });
  const routines = new RoutineService(db);
  const runs = new RoutineExecutionService(routines, { ownerEpoch: "owner", ...(dispatch === undefined ? {} : { dispatch }) });
  const created = await routines.create(
    scope,
    RoutineCreateSchema.parse({
      ...routineDefaults("UTC"),
      operationKey: "create",
      name: "News",
      objective: "Find news",
      agent: { agentId: "news", name: "News", instructions: "Find evidence" },
      triggers: [{ id: "daily", kind: "daily", at: "09:00", timezone: "UTC" }],
      skills: [],
      models: {
        research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
        synthesis: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
      },
      permissions: { revision: 1, researchTools: ["web_search", "http.request"], allowedHosts: ["example.com"], networkMode: "allowlist" },
    }),
  );
  await routines.finishEvaluation(scope, created.routine.routineId, 1, true, "fixture");
  const run = await runs.request(scope, created.routine.routineId, "run");
  return { db, runs, run };
}

it("joins an active routine dispatch and refuses new drains after stopping", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { runs } = await fixture(async () => {
    entered.resolve();
    await release.promise;
  });
  const first = runs.drain();
  await entered.promise;
  expect(runs.drain()).toBe(first);
  runs.stop();
  let finished = false;
  const idle = runs.idle().then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  release.resolve();
  await first;
  await idle;
  expect(runs.active).toBe(false);
  await expect(runs.drain()).rejects.toMatchObject({ code: "UNAVAILABLE" });
});

it("uses execution time when a routine start waits behind a locked write", async () => {
  const { db, runs, run } = await fixture();
  const lock = new Database(db.databasePath);
  cleanups.push(() => {
    lock.close();
  });
  lock.exec("BEGIN IMMEDIATE");
  const now = Date.now();
  const expiry = new Date(now + 100).toISOString();
  lock
    .prepare("UPDATE tavi_routine_runs SET data_json=json_set(data_json,'$.queueExpiresAt',?,'$.deadline',?) WHERE run_id=?")
    .run(expiry, expiry, run.runId);
  const events = channel("tavi.database.operation");
  const dispatched = Promise.withResolvers<void>();
  const listener = (event: unknown): void => {
    if (
      event !== null &&
      typeof event === "object" &&
      "operation" in event &&
      event.operation === "meta.set" &&
      "phase" in event &&
      event.phase === "started"
    )
      dispatched.resolve();
  };
  events.subscribe(listener);
  cleanups.push(() => events.unsubscribe(listener));
  const blocked = db.call("meta.set", { key: "block", value: "value", now: nowTimestamp() });
  await dispatched.promise;
  const pending = runs.start(scope, run.runId);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, now + 150 - Date.now())));
  lock.exec("COMMIT");
  await blocked;
  expect(await pending).toBeUndefined();
  expect((await runs.get(scope, run.runId)).status).toBe("skipped");
}, 10000);

it("rejects a facade carrying an obsolete owner session", async () => {
  const { runs, run } = await fixture();
  const stale = new RoutineExecutionService(runs.routines, { ownerEpoch: "previous-owner" });
  await expect(stale.start(scope, run.runId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect((await runs.get(scope, run.runId)).status).toBe("queued");
});
