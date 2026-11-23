import { routineFixture, executionFixture } from "./routine-fixture.js";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  RoutineCreateSchema,
  TRUSTED_PUBLIC,
  labelSummary,
  routineDefaults,
  untrustedLabel,
  type RoutineDetail,
  type RoutineTemplate,
} from "@tavi/contracts";
import { trendsRoutineTemplate } from "@tavi/test-support/routine-templates";
import {
  RoutineTemplateRegistry,
  routineCoverageWindow,
  routineReportedNote,
  routineTemplateTools,
  routineTemplateValues,
} from "../../src/features/routines/templates.js";
import {
  RoutineControlService,
  RoutineDeliveryService,
  RoutineNewsService,
  RoutinePublicationService,
  type RoutineService,
} from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { SqliteStore } from "../support/database-fixture.js";
import { type CliIo, EXIT, main } from "../../src/main.js";
import { routineAction, routineFromChat, routineScheduleAction } from "../../src/features/routines/actions.js";

const stores: SqliteStore[] = [];
const directories = temporaryDirectories();
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  directories.cleanup();
});
it("routes legacy schedule edits through a pending immutable routine revision", async () => {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  const service = await routineFixture(store, {});
  const scope = { workspaceId: "default", principalId: "operator" };
  const input = RoutineCreateSchema.parse({
    ...routineDefaults("Europe/Sofia"),
    operationKey: "create",
    name: "News",
    objective: "Find news",
    agent: { agentId: "news", name: "News", instructions: "Find evidence" },
    triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
    skills: [],
    models: {
      research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
      synthesis: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
    },
    permissions: { revision: 1, researchTools: ["web_search"], allowedHosts: ["example.com"], networkMode: "allowlist" },
  });
  const first = await service.create(scope, input);
  const schedule = (await store.asPort().repositories.schedules.list(scope.workspaceId))[0]!;
  await routineScheduleAction(service, schedule, { action: "update", scheduleId: schedule.scheduleId, at: "10:00", name: "Renamed" });
  const current = await service.get(scope, (await first).routine.routineId);
  expect((await current).revision.snapshot.triggers[0]).toMatchObject({ at: "10:00" });
  expect((await current).routine.name).toBe("Renamed");
  expect((await current).evaluation.status).toBe("pending");
  expect((await service.get(scope, (await first).routine.routineId, 1)).revision.snapshot.triggers[0]).toMatchObject({ at: "09:00" });
  expect((await store.asPort().repositories.schedules.get(schedule.scheduleId))?.enabled).toBe(false);
  await expect(
    (async () => await routineScheduleAction(service, schedule, { action: "run", scheduleId: schedule.scheduleId }))(),
  ).rejects.toThrow(/routine run/);
  await routineScheduleAction(service, schedule, { action: "remove", scheduleId: schedule.scheduleId });
  expect((await service.get(scope, (await first).routine.routineId)).routine.status).toBe("archived");
  expect(await store.asPort().repositories.schedules.get(schedule.scheduleId)).toBeDefined();
});

it("keeps a routine's provenance through an owned schedule's time change, and clears it when the person rewrites the objective", async () => {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  const service = await routineFixture(store, {});
  const scope = { workspaceId: "default", principalId: "operator" };
  const input = RoutineCreateSchema.parse({
    ...routineDefaults("Europe/Sofia"),
    operationKey: "create",
    name: "Deals",
    objective: "Find deals",
    agent: { agentId: "deals", name: "Deals", instructions: "Find evidence" },
    triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
    skills: [],
    models: {
      research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
      synthesis: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
    },
    permissions: { revision: 1, researchTools: ["web_search"], allowedHosts: ["example.com"], networkMode: "allowlist" },
  });
  const provenance = {
    integrity: "untrusted" as const,
    sources: ["web" as const],
    refs: [{ source: "web" as const, ref: "call-1", host: "deals.example", at: "2026-10-13T09:00:00.000Z" }],
  };
  const created = await service.create(scope, input, provenance);
  const schedule = (await store.asPort().repositories.schedules.list(scope.workspaceId))[0]!;
  await routineScheduleAction(service, schedule, { action: "update", scheduleId: schedule.scheduleId, at: "10:00" });
  const moved = await service.get(scope, created.routine.routineId);
  expect(moved.revision.snapshot.triggers[0]).toMatchObject({ at: "10:00" });
  expect(moved.revision.provenance).toEqual(provenance);
  await routineScheduleAction(service, schedule, { action: "update", scheduleId: schedule.scheduleId, prompt: "Find LLM releases" });
  expect((await service.get(scope, created.routine.routineId)).revision.provenance).toBeUndefined();
});

/** The production construction: one control service over a bare store, as `serve.ts` builds it. */
async function controlFixture(
  deliveryAuthorization?: "available",
  templateOf?: (id: string) => RoutineTemplate | undefined,
  languageOf?: (workspaceId: string) => Promise<"en" | "bg">,
) {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  const routines = await routineFixture(store, deliveryAuthorization === undefined ? {} : { deliveryAuthorization });
  const runs = await executionFixture(routines, { ownerEpoch: "fixture" });
  const control = new RoutineControlService({
    routines,
    runs,
    news: new RoutineNewsService(runs),
    publication: new RoutinePublicationService(runs),
    delivery: new RoutineDeliveryService(runs, {
      messaging: {
        buildDestination: (_connectionId, target) => ({ chatId: target.to }),
        send: async () => {
          throw new Error("no sends");
        },
      },
    }),
    defaultModels: () => ({
      research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
      synthesis: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
    }),
    allowedHosts: ["example.com"],
    wake: () => {},
    ...(templateOf === undefined ? {} : { templateOf }),
    ...(languageOf === undefined ? {} : { languageOf }),
  });
  return { store, routines, control };
}

it("routes owner actions through the one control service, refusing deferred policies before writing", async () => {
  const f = await controlFixture();
  const scope = { workspaceId: "default", principalId: "operator" };
  // The dispatcher has exactly one shape now: `RoutineControlService.execute`.
  for (const snapshot of [
    { triggers: [{ kind: "event" }] },
    { execution: { overlap: "queue" } },
    { execution: { overlap: "cancel_previous" } },
  ]) {
    try {
      await routineAction(f.control, { action: "update", update: { snapshot } } as unknown as Parameters<typeof routineAction>[1]);
      throw new Error("Expected refusal");
    } catch (error) {
      expect(error).toMatchObject({ code: "UNSUPPORTED" });
    }
  }
  expect(await f.routines.list(scope)).toEqual([]);
  const created = (await routineAction(f.control, {
    ...scope,
    action: "create",
    operationKey: "create",
    setup: { name: "News", objective: "Find news", timezone: "Europe/Sofia", at: "09:00" },
  })) as RoutineDetail;
  // A scope the caller does not own is refused before anything is read or written.
  await expect(
    (async () => await routineAction(f.control, { ...scope, principalId: "other", action: "get", routineId: created.routine.routineId }))(),
  ).rejects.toThrow(/scope/);
});

it("writes a routine set up here in the workspace's language, and in English where none is known", async () => {
  const scope = { workspaceId: "default", principalId: "operator" };
  const setup = { name: "News", objective: "Find news", timezone: "Europe/Sofia", at: "09:00" };
  const english = (await routineAction((await controlFixture()).control, {
    ...scope,
    action: "create",
    operationKey: "create",
    setup,
  })) as RoutineDetail;
  expect(english.revision.snapshot.report.language).toBe("en");
  const asked: string[] = [];
  const bulgarian = (await routineAction(
    (
      await controlFixture(undefined, undefined, async (workspaceId) => {
        asked.push(workspaceId);
        return "bg";
      })
    ).control,
    { ...scope, action: "create", operationKey: "create", setup },
  )) as RoutineDetail;
  expect(asked).toEqual(["default"]);
  expect(bulgarian.revision.snapshot.report.language).toBe("bg");
});

it("stamps a routine repeated from a chat with what that chat read, as the owner reads it, and only from the caller's own chat", async () => {
  const f = await controlFixture();
  const scope = { workspaceId: "default", principalId: "operator" };
  const page = untrustedLabel("web", { ref: { ref: "call-1", host: "deals.example", at: "2026-10-13T10:00:00.000Z" } });
  const tasks: Record<string, { readonly workspaceId: string; readonly principalId: string; readonly read: typeof page }> = {
    tainted: { ...scope, read: page },
    clean: { ...scope, read: TRUSTED_PUBLIC },
    elsewhere: { workspaceId: "other", principalId: "operator", read: page },
    someoneElse: { workspaceId: "default", principalId: "friend", read: page },
  };
  const chat = {
    task: async (taskId: string) => tasks[taskId],
    label: async (task: (typeof tasks)[string]) => labelSummary(task.read),
  };
  const create = (operationKey: string, fromTaskId: string) => ({
    ...scope,
    action: "create" as const,
    operationKey,
    setup: { name: "Deals", objective: "Find deals", timezone: "Europe/Sofia", at: "09:00" },
    fromTaskId,
    // A label the caller sends is never the one used.
    modelLabel: TRUSTED_PUBLIC,
  });
  const tainted = (await routineAction(f.control, await routineFromChat(create("tainted", "tainted"), chat))) as RoutineDetail;
  expect(tainted.revision.provenance).toEqual({ integrity: "untrusted", sources: ["web"], refs: page.refs });
  const clean = (await routineAction(f.control, await routineFromChat(create("clean", "clean"), chat))) as RoutineDetail;
  expect(clean.revision.provenance).toBeUndefined();
  for (const taskId of ["elsewhere", "someoneElse", "missing"])
    await expect(routineFromChat(create(taskId, taskId), chat)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(routineFromChat(create("unread", "tainted"), { ...chat, label: async () => null })).rejects.toMatchObject({
    code: "UNAVAILABLE",
  });
  await expect(routineFromChat({ ...create("copy", "tainted"), copyOf: tainted.routine.routineId }, chat)).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  // Anything else passes as it came.
  const plain = { ...scope, action: "get" as const, routineId: tainted.routine.routineId };
  expect(await routineFromChat(plain, chat)).toBe(plain);
});

it("copies a plugin's routine template into the revision it saves, and refuses one no plugin provides", async () => {
  const registry = new RoutineTemplateRegistry();
  const f = await controlFixture(undefined, (id) => registry.get(id));
  const scope = { workspaceId: "default", principalId: "operator" };
  const defaults = routineDefaults("Europe/Sofia");
  const create = (operationKey: string) =>
    RoutineCreateSchema.parse({
      ...defaults,
      report: { ...defaults.report, templateVersion: "trends-v1" },
      operationKey,
      name: "Trends",
      objective: "Track my topics",
      agent: { agentId: "trends", name: "Trends", instructions: "Track" },
      triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
      skills: [],
      models: {
        research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
        synthesis: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
      },
      permissions: { revision: 1, researchTools: ["web_search", "trends.radar.sweep"], allowedHosts: [], networkMode: "open_web" },
    });
  await expect(routineAction(f.control, { ...scope, action: "create", operationKey: "none", create: create("none") })).rejects.toThrow(
    /No routine template trends-v1 is installed/,
  );
  const template = trendsRoutineTemplate();
  const withdraw = registry.install("trends.radar", [template]);
  // Another plugin cannot take its id, nor the host's own.
  expect(() => registry.install("acme.trends", [template])).toThrow(/already provided/);
  expect(() => registry.install("acme.news", [{ ...template, id: "news-v1" }])).toThrow(/already provided/);
  const created = (await routineAction(f.control, {
    ...scope,
    action: "create",
    operationKey: "made",
    create: create("made"),
  })) as RoutineDetail;
  expect(created.revision.snapshot.report.template).toEqual(template);
  // An edit names its template by id: the revision's copy stays, plugin or no plugin.
  withdraw();
  const { template: _copy, ...written } = created.revision.snapshot.report;
  const edited = (await routineAction(f.control, {
    ...scope,
    action: "edit",
    routineId: created.routine.routineId,
    expectedVersion: created.routine.version,
    operationKey: "edit",
    edit: { report: { ...written, maxItems: 3 } },
  })) as RoutineDetail;
  expect(edited.revision.snapshot.report).toMatchObject({ maxItems: 3, template });
  expect(registry.get("trends-v1")).toBeUndefined();
  expect(((await f.routines.get(scope, created.routine.routineId)) as RoutineDetail).revision.snapshot.report.template).toEqual(template);
});

it("narrows a template's research to the granted tools its patterns name, and fills its placeholders", () => {
  const template = trendsRoutineTemplate();
  expect(routineTemplateTools(template, ["web_search", "trends.radar.sweep", "trends.radar.cluster", "trends.other"])).toEqual([
    "trends.radar.sweep",
    "trends.radar.cluster",
  ]);
  const run = { snapshot: { report: { ...routineDefaults("Europe/Sofia").report, corroboration: "two_independent" as const } } };
  const values = routineTemplateValues(run, { from: "A", to: "B", hours: 24 }, template);
  expect(values).toMatchObject({ from: "A", to: "B", hours: "24", claims: "3", corroboration: template.corroborationRule });
  // A widening routine's placeholders name the widened bound its research gathers up front.
  const widening = { snapshot: { report: { ...run.snapshot.report, onEmpty: "widen_lookback" as const } } };
  const own = { from: "2026-09-19T06:00:00.000Z", to: "2026-09-20T06:00:00.000Z", hours: 24 };
  expect(routineTemplateValues(widening, own, template)).toMatchObject({ from: "2026-09-17T06:00:00.000Z", to: own.to, hours: "72" });
  expect(routineCoverageWindow(widening, own)).toEqual({ ...own, from: "2026-09-17T06:00:00.000Z", hours: 72, preferredFrom: own.from });
  expect(routineCoverageWindow(run, own)).toEqual(own);
  expect(routineReportedNote("run", undefined)).toBe("");
  expect(routineReportedNote("run", { reported: [] })).toBe("");
});

it("turns a routine's human checkpoints on by edit, only with a destination to ask in", async () => {
  const f = await controlFixture("available");
  const scope = { workspaceId: "default", principalId: "operator" };
  const created = (await routineAction(f.control, {
    ...scope,
    action: "create",
    operationKey: "create",
    setup: { name: "News", objective: "Find news", timezone: "Europe/Sofia", at: "09:00" },
  })) as RoutineDetail;
  const routineId = created.routine.routineId;
  // Nowhere to ask: refused, and nothing is written.
  await expect(
    (async () =>
      await routineAction(f.control, {
        ...scope,
        action: "edit",
        routineId,
        expectedVersion: created.routine.version,
        operationKey: "ask-nowhere",
        edit: { humanCheckpoints: "ask-with-default" },
      }))(),
  ).rejects.toThrow(/destination to ask in/);
  await f.routines.putTarget(scope, {
    ...scope,
    targetId: "chat",
    connectionId: "tg",
    chatId: "123",
    label: "Fixture chat",
    authorizationRef: "operator-destination-allowlist",
    enabled: true,
    createdAt: "2026-09-20T06:00:00.000Z",
  });
  const current = await f.routines.get(scope, routineId);
  const edited = (await routineAction(f.control, {
    ...scope,
    action: "edit",
    routineId,
    expectedVersion: current.routine.version,
    operationKey: "ask-chat",
    edit: {
      humanCheckpoints: "ask-with-default",
      report: { ...current.revision.snapshot.report, formats: ["in-app", "pdf"] },
      delivery: { ...current.revision.snapshot.delivery, targetIds: ["chat"] },
    },
  })) as RoutineDetail & { changes: readonly string[] };
  expect(edited.revision.snapshot.execution.humanCheckpoints).toBe("ask-with-default");
  // The rest of the execution policy is the revision's own.
  expect({ ...edited.revision.snapshot.execution, humanCheckpoints: undefined }).toEqual({
    ...current.revision.snapshot.execution,
    humanCheckpoints: undefined,
  });
  expect(edited.changes).toContain("execution");
});

it("resumes a paused delivery target through the owner's routines action, and refuses one it does not have", async () => {
  const f = await controlFixture("available");
  const scope = { workspaceId: "default", principalId: "operator" };
  const created = (await routineAction(f.control, {
    ...scope,
    action: "create",
    operationKey: "create",
    setup: { name: "News", objective: "Find news", timezone: "Europe/Sofia", at: "09:00" },
  })) as RoutineDetail;
  const routineId = created.routine.routineId;
  await f.routines.putTarget(scope, {
    ...scope,
    targetId: "chat",
    connectionId: "tg",
    chatId: "123",
    label: "Fixture chat",
    authorizationRef: "operator-destination-allowlist",
    enabled: true,
    createdAt: "2026-09-20T06:00:00.000Z",
  });
  f.store.handle
    .prepare("UPDATE tavi_routine_state SET state_json=json_set(state_json,'$.deliveryHealth',json(?)) WHERE routine_id=?")
    .run(JSON.stringify({ chat: { failures: 3, blockedSince: "2026-09-19T06:00:00.000Z", notified: true } }), routineId);
  expect(await routineAction(f.control, { ...scope, action: "resume_delivery", routineId, targetId: "chat" })).toEqual({ resumed: true });
  const state = JSON.parse(
    (f.store.handle.prepare("SELECT state_json FROM tavi_routine_state WHERE routine_id=?").get(routineId) as { state_json: string })
      .state_json,
  ) as { deliveryHealth: Record<string, unknown> };
  expect(state.deliveryHealth["chat"]).toEqual({ failures: 0, blockedSince: null, notified: false });
  await expect(routineAction(f.control, { ...scope, action: "resume_delivery", routineId, targetId: "missing" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(routineAction(f.control, { ...scope, action: "resume_delivery", routineId })).rejects.toThrow(/Target id/);
});

async function offlineFixture() {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  const scope = { workspaceId: "default", principalId: "operator" };
  const owner = await routineFixture(store, { deliveryAuthorization: "available" });
  const input = RoutineCreateSchema.parse({
    ...routineDefaults("Europe/Sofia"),
    operationKey: "create",
    name: "News",
    objective: "Find news",
    agent: { agentId: "news", name: "News", instructions: "Find evidence" },
    triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
    skills: [],
    models: {
      research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
      synthesis: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
    },
    permissions: { revision: 1, researchTools: ["web_search"], allowedHosts: ["example.com"], networkMode: "allowlist" },
  });
  const created = await owner.create(scope, input);
  await owner.putTarget(scope, {
    ...scope,
    targetId: "chat",
    connectionId: "tg",
    chatId: "123",
    label: "Fixture chat",
    authorizationRef: "operator-destination-allowlist",
    enabled: true,
    createdAt: "2026-09-20T06:00:00.000Z",
  });
  const before = await owner.get(scope, (await created).routine.routineId);
  await owner.update(scope, {
    routineId: (await created).routine.routineId,
    expectedVersion: (await before).routine.version,
    operationKey: "pin-chat",
    changeSummary: "Add destination",
    snapshot: {
      ...(await before).revision.snapshot,
      report: { ...(await before).revision.snapshot.report, formats: ["in-app", "pdf"] },
      delivery: { ...(await before).revision.snapshot.delivery, targetIds: ["chat"] },
    },
  });
  const schedule = (await store.asPort().repositories.schedules.list(scope.workspaceId))[0]!;
  return { store, scope, owner, routineId: (await created).routine.routineId, schedule };
}

it("edits an offline routine-owned schedule that pins a delivery target", async () => {
  const f = await offlineFixture();
  // The offline `tavi schedules` service is constructed without `authorizeTarget`
  // (main.ts), which is exactly the configuration that used to throw NOT_AUTHORIZED
  // on every edit.
  const offline = await offlineRoutine(f);
  const answer = (await routineScheduleAction(offline, f.schedule, {
    action: "update",
    scheduleId: f.schedule.scheduleId,
    at: "10:00",
    name: "Renamed",
  })) as {
    routine: { version: number; name: string };
    revision: { revision: number; snapshot: { triggers: { at: string }[]; delivery: { targetIds: string[] } } };
    changes: string[];
    deliveryReadiness: { targetId: string; problem: string | null }[];
  };
  expect(answer.revision.snapshot.triggers[0]).toMatchObject({ at: "10:00" });
  expect(answer.routine.name).toBe("Renamed");
  expect(answer.revision.revision).toBe(3);
  // The response reports which sections changed with the same expression the
  // control service uses, so both surfaces answer `changes` identically.
  expect(answer.changes).toEqual(["triggers"]);
  // Retained, not re-authorized: the reference survives and its health is reported.
  expect(answer.revision.snapshot.delivery.targetIds).toEqual(["chat"]);
  // No authorizer is configured offline, so the honest answer is "unverifiable",
  // not "unauthorized": the owner may well still allow this destination.
  expect(answer.deliveryReadiness).toEqual([{ targetId: "chat", revision: 3, enabled: true, authorized: false, problem: "unverifiable" }]);
});

it("reports a revoked pinned target without refusing the unrelated edit", async () => {
  const f = await offlineFixture();
  // The owner's authorizer now says no (a revoked chat), and the edit still lands.
  const revoked = await routineFixture(f.store, { executionAvailable: true, deliveryAuthorization: "denied" });
  const answer = (await routineScheduleAction(revoked, f.schedule, {
    action: "update",
    scheduleId: f.schedule.scheduleId,
    at: "11:00",
  })) as {
    revision: { snapshot: { triggers: { at: string }[]; delivery: { targetIds: string[] } } };
    deliveryReadiness: { targetId: string; problem: string | null }[];
  };
  expect(answer.revision.snapshot.triggers[0]).toMatchObject({ at: "11:00" });
  expect(answer.revision.snapshot.delivery.targetIds).toEqual(["chat"]);
  expect(answer.deliveryReadiness).toEqual([{ targetId: "chat", revision: 3, enabled: true, authorized: false, problem: "unauthorized" }]);
  // It is still a refusal at dispatch, which is where the effect happens.
  await expect((async () => await revoked.target(f.scope, "chat"))()).rejects.toThrow(/authorization is unavailable or revoked/);
});

it("still refuses to introduce a destination without a current authorizer", async () => {
  const f = await offlineFixture();
  const offline = await offlineRoutine(f);
  const before = await offline.get(f.scope, f.routineId);
  // A *different* destination is an introduction, and this service has no
  // authorizer: a missing authorizer is never allow-all.
  await f.owner.putTarget(f.scope, {
    ...f.scope,
    targetId: "other",
    connectionId: "tg",
    chatId: "456",
    label: "Other chat",
    authorizationRef: "operator-destination-allowlist",
    enabled: true,
    createdAt: "2026-09-20T06:00:00.000Z",
  });
  await expect(
    (async () =>
      await offline.update(f.scope, {
        routineId: f.routineId,
        expectedVersion: (await before).routine.version,
        operationKey: "swap-target",
        changeSummary: "Swap destination",
        snapshot: { ...(await before).revision.snapshot, delivery: { ...(await before).revision.snapshot.delivery, targetIds: ["other"] } },
      }))(),
  ).rejects.toThrow(/explicitly authorized/);
  // Removing is always available for repair.
  await (async () =>
    await offline.update(f.scope, {
      routineId: f.routineId,
      expectedVersion: (await before).routine.version,
      operationKey: "drop-target",
      changeSummary: "Drop destination",
      snapshot: { ...(await before).revision.snapshot, delivery: { ...(await before).revision.snapshot.delivery, targetIds: [] } },
    }))();
  expect((await offline.get(f.scope, f.routineId)).revision.snapshot.delivery.targetIds).toEqual([]);
});

it("enables a routine-owned schedule offline once its routine is evaluated", async () => {
  const f = await offlineFixture();
  const owner = await routineFixture(f.store, { executionAvailable: true, deliveryAuthorization: "available" });
  await owner.finishEvaluation(f.scope, f.routineId, 2, true, "pass");
  expect((await (await offlineRoutine(f)).get(f.scope, f.routineId)).routine.status).toBe("active");
  // Arming the schedule offline is not a claim that this construction can
  // execute; the owner re-checks readiness at dispatch.
  const paused = await offlineRoutine(f);
  await paused.setStatus(f.scope, f.routineId, (await paused.get(f.scope, f.routineId)).routine.version, "paused");
  const answer = (await routineScheduleAction(paused, f.schedule, { action: "enable", scheduleId: f.schedule.scheduleId })) as {
    routine: { status: string };
  };
  expect(answer.routine.status).toBe("active");
  const disabled = (await routineScheduleAction(paused, f.schedule, { action: "disable", scheduleId: f.schedule.scheduleId })) as {
    routine: { status: string };
  };
  expect(disabled.routine.status).toBe("paused");
});

/**
 * The offline construction, exactly as `main.ts` builds it: no delivery
 * authorizer (there is no telegram/messaging configuration to read), and
 * `executionAvailable: true` because arming a routine is not executing it — the
 * owner re-checks readiness at dispatch.
 */
async function offlineRoutine(f: Awaited<ReturnType<typeof offlineFixture>>): Promise<RoutineService> {
  return await routineFixture((await f).store, { executionAvailable: true });
}

it("refuses a revision whose pinned target no longer exists", async () => {
  const f = await offlineFixture();
  f.store.handle.prepare("DELETE FROM tavi_routine_delivery_targets WHERE target_id=?").run("chat");
  const offline = await offlineRoutine(f);
  try {
    await routineScheduleAction(offline, f.schedule, { action: "update", scheduleId: f.schedule.scheduleId, at: "10:00" });
    throw new Error("expected refusal");
  } catch (error) {
    expect(error).toMatchObject({ code: "NOT_FOUND" });
  }
  await (async () =>
    await offline.update(f.scope, {
      routineId: f.routineId,
      expectedVersion: (await offline.get(f.scope, f.routineId)).routine.version,
      operationKey: "repair",
      changeSummary: "Repair",
      snapshot: {
        ...(await offline.get(f.scope, f.routineId)).revision.snapshot,
        delivery: { ...(await offline.get(f.scope, f.routineId)).revision.snapshot.delivery, targetIds: [] },
      },
    }))();
});

it("edits a routine-owned schedule end to end through main.ts, offline", async () => {
  const directory = directories.create("tavi-routine-schedule-");
  const store = await SqliteStore.open({ databasePath: join(directory, "tavi.sqlite") });
  stores.push(store);
  const scope = { workspaceId: "default", principalId: "operator" };
  const owner = await routineFixture(store, { deliveryAuthorization: "available" });
  const created = await owner.create(
    scope,
    RoutineCreateSchema.parse({
      ...routineDefaults("Europe/Sofia"),
      operationKey: "create",
      name: "News",
      objective: "Find news",
      agent: { agentId: "news", name: "News", instructions: "Find evidence" },
      triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "Europe/Sofia" }],
      skills: [],
      models: {
        research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
        synthesis: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
      },
      permissions: { revision: 1, researchTools: ["web_search"], allowedHosts: ["example.com"], networkMode: "allowlist" },
    }),
  );
  await owner.putTarget(scope, {
    ...scope,
    targetId: "chat",
    connectionId: "tg",
    chatId: "123",
    label: "Fixture chat",
    authorizationRef: "operator-destination-allowlist",
    enabled: true,
    createdAt: "2026-09-20T06:00:00.000Z",
  });
  const before = await owner.get(scope, (await created).routine.routineId);
  await owner.update(scope, {
    routineId: (await created).routine.routineId,
    expectedVersion: (await before).routine.version,
    operationKey: "pin",
    changeSummary: "Add destination",
    snapshot: {
      ...(await before).revision.snapshot,
      report: { ...(await before).revision.snapshot.report, formats: ["in-app", "pdf"] },
      delivery: { ...(await before).revision.snapshot.delivery, targetIds: ["chat"] },
    },
  });
  const schedule = (await store.asPort().repositories.schedules.list(scope.workspaceId))[0]!;
  await store.close();
  stores.length = 0;

  const out: string[] = [];
  const io = { stdout: (line: string) => out.push(line), stderr: (line: string) => out.push(line) } as unknown as CliIo;
  const code = await main(["schedules", "update", schedule.scheduleId, "--at", "10:00", "--format", "json", "--data-dir", directory], {
    io,
  });
  expect(code, out.join("")).toBe(EXIT.ok);
  const answer = JSON.parse(out.join("")) as {
    revision: { revision: number; snapshot: { triggers: { at: string }[]; delivery: { targetIds: string[] } } };
    routine: { name: string };
    deliveryReadiness: { targetId: string; problem: string | null }[];
  };
  expect(answer.routine.name).toBe("News");
  expect(answer.revision.snapshot.triggers[0]).toMatchObject({ at: "10:00" });
  expect(answer.revision.snapshot.delivery.targetIds).toEqual(["chat"]);
  expect(answer.deliveryReadiness).toEqual([
    { targetId: "chat", revision: answer.revision.revision, enabled: true, authorized: false, problem: "unverifiable" },
  ]);
});
