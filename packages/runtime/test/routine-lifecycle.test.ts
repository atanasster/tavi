import { afterEach, expect, it } from "vitest";
import { RoutineCreateSchema, routineDefaults } from "@tavi/contracts";
import { RoutineService } from "../src/routines/service.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * The routine lifecycle's own guarantees, from the routines audit: a setup
 * problem is recorded in words and never overrides the operator's pause; a
 * failed evaluation can be run again without a new revision; a completed
 * routine is not resumed into a routine with nothing to fire.
 */
const scope = { workspaceId: "default", principalId: "operator" };
const handles: { close(): unknown }[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
});

const input = RoutineCreateSchema.parse({
  ...routineDefaults("Europe/Sofia"),
  operationKey: "audit",
  name: "News",
  objective: "Find news",
  agent: { agentId: "news", name: "News", instructions: "Find evidence" },
  triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
  skills: [],
  models: {
    research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
    synthesis: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
  },
  permissions: { revision: 1, researchTools: ["web_search", "web_fetch"], allowedHosts: [], networkMode: "open_web" },
});

function sync() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  handles.push(store);
  const routines = new RoutineService(store, { executionAvailable: true, nextOccurrence: () => "2026-09-30T06:00:00.000Z" });
  return { store, routines, routineId: routines.create(scope, input).routine.routineId };
}

async function asynchronous(ready: () => boolean | string) {
  const { DatabaseClient } = await import("../src/persistence/client.js");
  const { RoutineService: AsyncRoutines } = await import("../src/persistence/routine-facades.js");
  const { RoutineEvaluationService } = await import("../src/routines/async-evaluation.js");
  const store = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
  handles.push(store);
  const routines = new AsyncRoutines(store);
  const created = await routines.create(scope, input);
  const evaluation = new RoutineEvaluationService(routines, {
    ownerEpoch: "audit",
    ready,
    models: {
      stream: async () => {
        throw new Error("no model call is expected");
      },
    },
  });
  return { routines, evaluation, routineId: created.routine.routineId };
}

it("records why setup is needed, bumps the version once, and keeps the evaluation pending for a retry", async () => {
  const reason = "No web search provider is configured. Add one in Settings → Web search, then restart `tavi serve`.";
  const f = await asynchronous(() => reason);
  await f.evaluation.drain();
  const first = await f.routines.get(scope, f.routineId);
  expect(first.routine.status).toBe("setup-needed");
  expect(first.routine.version).toBe(2);
  expect(first.evaluation).toMatchObject({ status: "pending", detail: reason });
  // A second sweep with setup still missing changes nothing, not even the version.
  await f.evaluation.drain();
  expect((await f.routines.get(scope, f.routineId)).routine.version).toBe(2);
});

it("never turns the operator's pause into setup-needed", async () => {
  const f = await asynchronous(() => "Setup is missing.");
  const created = await f.routines.get(scope, f.routineId);
  await f.routines.setStatus(scope, f.routineId, created.routine.version, "paused");
  await f.evaluation.drain();
  const after = await f.routines.get(scope, f.routineId);
  expect(after.routine.status).toBe("paused");
  expect(after.evaluation.detail).toBe("Setup is missing.");
});

it("runs a failed evaluation again without a new revision, and only a failed one", () => {
  const f = sync();
  f.routines.finishEvaluation(scope, f.routineId, 1, false, "Model unavailable");
  const failed = f.routines.get(scope, f.routineId);
  expect(failed.routine.status).toBe("draft");
  const again = f.routines.reevaluate(scope, f.routineId, failed.routine.version);
  expect(again.evaluation).toMatchObject({ status: "pending", detail: "" });
  expect(again.routine.latestRevision).toBe(1);
  expect(again.routine.version).toBe(failed.routine.version + 1);
  expect(() => f.routines.reevaluate(scope, f.routineId, again.routine.version)).toThrow(/Only a failed evaluation/);
  expect(() => f.routines.reevaluate(scope, f.routineId, failed.routine.version)).toThrow(/Routine changed/);
});

it("refuses to resume a completed routine, and names an archive of an archived one for what it is", () => {
  const f = sync();
  f.routines.finishEvaluation(scope, f.routineId, 1, true, "pass");
  f.store.handle.prepare("UPDATE tavi_routines SET status='completed' WHERE routine_id=?").run(f.routineId);
  const completed = f.routines.get(scope, f.routineId);
  expect(() => f.routines.setStatus(scope, f.routineId, completed.routine.version, "active")).toThrow(/no trigger left/);
  const archived = f.routines.setStatus(scope, f.routineId, completed.routine.version, "archived");
  expect(() => f.routines.setStatus(scope, f.routineId, archived.routine.version, "archived")).toThrow(/already archived/);
});
