import { asyncRoutineEffects } from "./async-routine-effects.js";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { RoutineCreateSchema, routineDefaults } from "@tavi/contracts";
import { ToolRegistry, routinePluginReads, routineResearchTools } from "@tavi/runtime";
import { RoutineExecutionService } from "../src/routines/runs.js";
import { RoutineService } from "../src/routines/service.js";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * Routine-grantable plugin reads: a plugin tool that is read-only with a declared sink of `search` or
 * `none` may be granted to a routine's research step when its revision names
 * it. Nothing else grows the routine's tools.
 */
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const scope = { workspaceId: "default", principalId: "operator" };

function registry(effects: { reads: number; writes: number }) {
  const tools = new ToolRegistry();
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
    id: "memory.get",
    sink: "none",
    version: "1.0.0",
    description: "A built-in read",
    effect: "read-only",
    requiredPermissions: [],
    inputSchema: z.looseObject({}),
    handler: async () => ({}),
  });
  // A built-in that says its output is a plugin's is still a built-in.
  tools.register({
    id: "builtin.lookup",
    sink: "none",
    outputSource: "plugin",
    version: "1.0.0",
    description: "A built-in read claiming a plugin's output",
    effect: "read-only",
    requiredPermissions: [],
    inputSchema: z.looseObject({}),
    handler: async () => ({}),
  });
  tools.registerExternal({
    id: "jobs.finder.search",
    sink: "search",
    version: "0.1.0",
    description: "Jobs search",
    effect: "read-only",
    requiredPermissions: [],
    inputSchema: z.looseObject({ keywords: z.array(z.string()) }),
    handler: async () => {
      effects.reads++;
      return { postings: [] };
    },
  });
  tools.registerExternal({
    id: "jobs.finder.digest",
    sink: "none",
    version: "0.1.0",
    description: "Jobs digest",
    effect: "read-only",
    requiredPermissions: [],
    inputSchema: z.looseObject({}),
    handler: async () => {
      effects.reads++;
      return { hits: [] };
    },
  });
  tools.registerExternal({
    id: "jobs.finder.track",
    sink: "persist",
    version: "0.1.0",
    description: "Jobs track",
    effect: "mutating",
    requiredPermissions: [],
    inputSchema: z.looseObject({}),
    handler: async () => {
      effects.writes++;
      return {};
    },
  });
  tools.registerExternal({
    id: "acme.fetch",
    version: "1.0.0",
    description: "A plugin read on the default network sink",
    effect: "read-only",
    requiredPermissions: [],
    inputSchema: z.looseObject({}),
    handler: async () => {
      effects.reads++;
      return {};
    },
  });
  tools.registerExternal({
    id: "mcp.docs.lookup",
    sink: "search",
    outputSource: "mcp",
    version: "1.0.0",
    description: "An MCP server's read",
    effect: "read-only",
    requiredPermissions: [],
    inputSchema: z.looseObject({}),
    handler: async () => {
      effects.reads++;
      return {};
    },
  });
  return tools;
}

function fixture(pluginReads: readonly string[] | undefined) {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  const now = "2026-10-16T06:00:00.000Z";
  const routines = new RoutineService(store, {
    executionAvailable: true,
    now: () => now,
    nextOccurrence: () => "2026-10-17T06:00:00.000Z",
  });
  const created = routines.create(
    scope,
    RoutineCreateSchema.parse({
      ...routineDefaults("UTC"),
      operationKey: "create",
      name: "Jobs",
      objective: "New backend jobs",
      agent: { agentId: "jobs", name: "Jobs", instructions: "Find jobs" },
      triggers: [{ id: "morning", kind: "daily", at: "09:00", timezone: "UTC" }],
      skills: [],
      models: {
        research: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
        synthesis: { primary: { connectionId: "fixture", model: "v1" }, fallbacks: [] },
      },
      permissions: {
        revision: 1,
        researchTools: ["web_search", "jobs.finder.search", "jobs.finder.track", "memory.get", "acme.fetch", "mcp.docs.lookup"],
        allowedHosts: ["example.com"],
        networkMode: "allowlist",
      },
    }),
  );
  routines.finishEvaluation(scope, created.routine.routineId, 1, true, "pass");
  const runs = new RoutineExecutionService(routines, {
    ownerEpoch: "one",
    now: () => now,
    authorized: () => true,
    researchReady: () => ({ ready: true as const }),
    ...(pluginReads === undefined ? {} : { pluginReads: () => pluginReads }),
  });
  const started = runs.request(scope, created.routine.routineId, "manual");
  const fence = runs.start(scope, started.runId);
  if (fence === undefined || fence === null) throw new Error("the run did not start");
  return { runs, fence, run: runs.get(scope, started.runId) };
}

const call = (tools: ReturnType<typeof routineResearchTools>, id: string, input: unknown) =>
  tools.get(id)?.handler({ input, context: { ...scope, runId: "worker-task", caller: "routine" }, signal: new AbortController().signal });

describe("plugin reads in a routine", () => {
  it("are a plugin's read-only tools on a declared search or none sink, and nothing else", () => {
    expect(routinePluginReads(registry({ reads: 0, writes: 0 }))).toEqual(["jobs.finder.digest", "jobs.finder.search"]);
  });

  it("are offered to, run by and ledgered for a research step that names them; a write, a built-in and other reads stay out", async () => {
    const effects = { reads: 0, writes: 0 };
    const tools = registry(effects);
    const f = fixture(routinePluginReads(tools));
    const research = routineResearchTools(tools, asyncRoutineEffects(f.runs), f.run, f.fence);
    expect(
      research
        .list()
        .map((tool) => tool.id)
        .sort(),
    ).toEqual(["jobs.finder.search", "web_search"]);
    await expect(call(research, "jobs.finder.search", { keywords: ["backend"] })).resolves.toEqual({ postings: [] });
    expect(effects.reads).toBe(1);
    for (const id of ["jobs.finder.track", "memory.get", "acme.fetch", "mcp.docs.lookup"]) {
      expect(research.get(id)).toBeUndefined();
      expect(f.runs.resolveGrant(f.fence, "research", { tool: id })).toMatchObject({ allowed: false, code: "tool-outside-grant" });
    }
    // A plugin read the revision does not name is not granted either.
    expect(research.get("jobs.finder.digest")).toBeUndefined();
    expect(f.runs.resolveGrant(f.fence, "research", { tool: "jobs.finder.search" })).toMatchObject({ allowed: true });
    expect(effects.writes).toBe(0);
  });

  it("tell the capture which results are a plugin read's, by the registry, never by a name", async () => {
    const tools = registry({ reads: 0, writes: 0 });
    const f = fixture(routinePluginReads(tools));
    const captured: [string, unknown][] = [];
    const research = routineResearchTools(
      tools,
      asyncRoutineEffects(f.runs),
      f.run,
      f.fence,
      (tool, _input, output, origin) => (captured.push([tool, origin]), output),
    );
    await call(research, "jobs.finder.search", { keywords: ["backend"] });
    await call(research, "web_search", { query: "backend" });
    expect(captured).toEqual([
      ["jobs.finder.search", "plugin"],
      ["web_search", undefined],
    ]);
  });

  it("are refused by a grant check that was given none, as an older owner's", () => {
    const f = fixture(undefined);
    expect(f.runs.resolveGrant(f.fence, "research", { tool: "jobs.finder.search" })).toMatchObject({
      allowed: false,
      code: "tool-outside-grant",
    });
  });
});
