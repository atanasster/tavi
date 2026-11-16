import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ATTENDED_TASK_POLICY,
  HEARTBEAT_TASK_POLICY,
  effectiveMemorySettings,
  type InvocationContext,
  type MemorySearchResult,
  type MemoryServicePort,
  type ModelOutcome,
  type ModelPort,
  type ModelRequest,
  type DeclaredToolDefinition,
  type ToolRegistryPort,
} from "@tavi/contracts";
import {
  createInMemoryApprovalRepository,
  createInMemoryCancellationRepository,
  createInMemoryEffectRepository,
  createInMemoryExecutionRepository,
  createInMemoryReceiptRepository,
  createInMemorySaver,
  createInMemoryTaskRepository,
  contextBlockOf,
} from "@tavi/test-support/fakes";
import { MEMORY_NOT_AUTHORITATIVE_GUIDANCE, MEMORY_PROPOSE_GUIDANCE, SYSTEM_PROMPT_FACTS_HEADING } from "@tavi/agent-host/system-prompt";
import { createWorkflowAdapter } from "@tavi/agent-host/workflow";

/**
 * The memory guidance in the runtime facts, as the workflow states it: the
 * propose part exactly when the call offers `memory.propose` — never in a
 * memory-off chat, under `capture: "off"`, or on a heartbeat tick — and "memory
 * can be out of date" wherever memory is enabled, the heartbeat's tick
 * included. Both depend only on what is fixed for a chat between turns, so the
 * facts are byte-identical across a turn that retrieved a record and one that
 * did not.
 */

const context: InvocationContext = { workspaceId: "ws1", principalId: "p1", runId: "root", caller: "test" };
const schema = z.strictObject({});

const tool = (id: string): DeclaredToolDefinition => ({
  id,
  version: "1",
  description: id,
  effect: id === "memory.propose" ? "mutating" : "read-only",
  requiredPermissions: [],
  sink: id === "memory.propose" ? "persist" : "none",
});

function registryOf(ids: readonly string[]): ToolRegistryPort {
  const definitions = ids.map(tool);
  const byId = (id: string) => definitions.find((definition) => definition.id === id);
  return {
    register: () => {
      throw new Error("not used");
    },
    get: (id) => {
      const definition = byId(id);
      return definition === undefined
        ? undefined
        : {
            ...definition,
            inputSchema: schema,
            inputJsonSchema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
            modelName: id.replace(".", "_"),
            handler: async () => ({}),
          };
    },
    list: () => definitions,
    listOffered: async () => definitions,
    inputSchemaOf: (id) => (byId(id) === undefined ? undefined : schema),
    inputJsonSchemaOf: (id) => (byId(id) === undefined ? undefined : (z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>)),
    modelNameOf: (id) => byId(id)?.id.replace(".", "_"),
    resolveModelName: (name) => definitions.find((definition) => definition.id.replace(".", "_") === name)?.id,
  };
}

/** A memory service whose search finds one record the first turn it is asked, and nothing after. */
function memoryFinding(): MemoryServicePort {
  let asked = 0;
  const notUsed = async (): Promise<never> => {
    throw new Error("not used");
  };
  const hit = (): MemorySearchResult => ({
    hits:
      (asked += 1) === 1
        ? [
            {
              recordId: "mem-1",
              revisionId: "memrev-1",
              scope: { kind: "personal", principalId: "p1" },
              kind: "fact",
              snippet: "Travelling to Lisbon until Friday",
              recordedAt: "2026-01-01T00:00:00.000Z",
              superseded: false,
              conflict: false,
            },
          ]
        : [],
    coverage: "complete",
  });
  return {
    propose: notUsed,
    approve: notUsed,
    reject: notUsed,
    correct: notUsed,
    revoke: notUsed,
    forget: notUsed,
    remember: notUsed,
    get: notUsed,
    eligible: notUsed,
    list: async () => [],
    search: async () => hit(),
    resolvePreferences: async () => ({ preferences: [], truncated: false }),
    export: async () => ({ records: [], revisions: [], evidence: [], reviews: [], truncated: false }),
    usage: async () => ({ records: 0, bytes: 0 }),
    sweepExpired: async () => [],
    resolveFactConflicts: async () => [],
    operatorView: notUsed,
    history: notUsed,
    related: notUsed,
    counts: notUsed,
    principals: notUsed,
  } as MemoryServicePort;
}

function setup(extra: Record<string, unknown> = {}, tools: readonly string[] = ["memory.search", "memory.get", "memory.propose"]) {
  const systems: string[] = [];
  const contexts: string[] = [];
  const model: ModelPort = {
    async stream(request: ModelRequest): Promise<ModelOutcome> {
      systems.push(
        request.messages
          .filter((message) => message.role === "system")
          .map((message) => message.text)
          .join("\n"),
      );
      contexts.push(contextBlockOf(request));
      return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
    },
  };
  let counter = 0;
  const adapter = createWorkflowAdapter({
    checkpointSaver: createInMemorySaver().saver,
    models: model,
    tools: registryOf(tools),
    tasks: createInMemoryTaskRepository(),
    executions: createInMemoryExecutionRepository(),
    effects: createInMemoryEffectRepository(),
    receipts: createInMemoryReceiptRepository(),
    approvals: createInMemoryApprovalRepository(),
    cancellations: createInMemoryCancellationRepository(),
    ownerSession: "test-session",
    connectionId: "fixture",
    model: "fixture-model",
    systemPrompt: "test system prompt",
    access: { resolveWorkspace: () => ({ principalId: context.principalId }), missingPermissions: () => [] },
    toolPolicy: { rules: async () => [], sessionGrants: async () => [] },
    memory: memoryFinding(),
    newId: (prefix: string) => `${prefix}-${(counter += 1)}`,
    now: () => "2026-01-01T00:00:00.000Z",
    ...extra,
  } as Parameters<typeof createWorkflowAdapter>[0]);
  return { adapter, systems, contexts };
}

/** The runtime facts block of a system text: from its heading to the memory manifest, or the end. */
function factsOf(system: string): string {
  const start = system.indexOf(`${SYSTEM_PROMPT_FACTS_HEADING}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = system.slice(start);
  const end = rest.indexOf("\n\n");
  return end === -1 ? rest : rest.slice(0, end);
}

describe("the memory guidance in the runtime facts", () => {
  it("states both parts in a chat offered memory.propose, byte-identical across a turn that retrieved a record and one that did not", async () => {
    const { adapter, systems, contexts } = setup();
    const first = await adapter.admit(
      {
        context,
        operationKey: "t-1",
        kind: "start",
        prompt: "I am travelling to Lisbon until Friday",
        origin: "cli",
        executionPolicy: ATTENDED_TASK_POLICY,
      },
      {},
    );
    await adapter.admit({ context, taskId: first.taskId, operationKey: "t-2", kind: "reply", prompt: "what should I pack" }, {});
    expect(systems).toHaveLength(2);
    // One call carried a retrieved record and the other none: the context blocks differ, the system strings do not.
    expect(contexts[0]).toContain("Travelling to Lisbon until Friday");
    expect(contexts[1]).not.toContain("Travelling to Lisbon until Friday");
    expect(systems[1]).toBe(systems[0]);
    const [facts1, facts2] = systems.map(factsOf);
    expect(facts1).toContain(MEMORY_PROPOSE_GUIDANCE);
    expect(facts1).toContain(MEMORY_NOT_AUTHORITATIVE_GUIDANCE);
    expect(facts2).toBe(facts1);
  });

  it("keeps the system string byte-identical across every call of a turn, its final step included: the facts follow the turn's tools, the no-tools notice the step facts", async () => {
    const steps: { readonly system: string; readonly tools: number; readonly spent: boolean }[] = [];
    let call = 0;
    const model: ModelPort = {
      async stream(request: ModelRequest): Promise<ModelOutcome> {
        steps.push({
          system: request.messages
            .filter((message) => message.role === "system")
            .map((message) => message.text)
            .join("\n"),
          tools: request.tools.length,
          spent: JSON.stringify(request.messages).includes("This response's budget is spent"),
        });
        call += 1;
        if (request.tools.length > 0)
          return {
            status: "completed",
            attemptId: request.attemptId,
            text: "",
            toolCalls: [{ id: `c${call}`, name: "memory.search", input: {} }],
            usage: {},
          };
        return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
      },
    };
    const { adapter } = setup({ models: model, maxToolCalls: 2 });
    const result = await adapter.admit(
      {
        context,
        operationKey: "f-1",
        kind: "start",
        prompt: "I am travelling to Lisbon until Friday",
        origin: "cli",
        executionPolicy: ATTENDED_TASK_POLICY,
      },
      {},
    );
    expect(result.outcome).toMatchObject({ status: "completed" });
    expect(steps.map((step) => [step.tools > 0, step.spent])).toEqual([
      [true, false],
      [true, false],
      [false, true],
    ]);
    expect(new Set(steps.map((step) => step.system)).size).toBe(1);
    expect(factsOf(steps[2]!.system)).toContain(MEMORY_PROPOSE_GUIDANCE);
  });

  it("leaves the propose part out under capture off and in a memory-off chat, and says nothing of memory where it is off", async () => {
    const off = setup({ memorySettings: () => effectiveMemorySettings({ capture: "off" }) });
    await off.adapter.admit(
      { context, operationKey: "c-1", kind: "start", prompt: "hello", origin: "cli", executionPolicy: ATTENDED_TASK_POLICY },
      {},
    );
    expect(factsOf(off.systems[0] ?? "")).not.toContain(MEMORY_PROPOSE_GUIDANCE);
    expect(factsOf(off.systems[0] ?? "")).toContain(MEMORY_NOT_AUTHORITATIVE_GUIDANCE);

    const chatOff = setup({ chatMemory: () => ({ mode: "off" }) });
    await chatOff.adapter.admit(
      { context, operationKey: "o-1", kind: "start", prompt: "hello", origin: "cli", executionPolicy: ATTENDED_TASK_POLICY },
      {},
    );
    expect(factsOf(chatOff.systems[0] ?? "")).not.toContain(MEMORY_PROPOSE_GUIDANCE);
    expect(factsOf(chatOff.systems[0] ?? "")).not.toContain(MEMORY_NOT_AUTHORITATIVE_GUIDANCE);

    const paused = setup({ memorySettings: () => effectiveMemorySettings({ enabled: false }) });
    await paused.adapter.admit(
      { context, operationKey: "p-1", kind: "start", prompt: "hello", origin: "cli", executionPolicy: ATTENDED_TASK_POLICY },
      {},
    );
    expect(factsOf(paused.systems[0] ?? "")).not.toContain("Memory");
  });

  it("states only 'memory can be out of date' on a heartbeat tick, whose tools never include memory.propose", async () => {
    const { adapter, systems } = setup({ memoryWithheld: () => true, heartbeatMemoryShown: () => true });
    await adapter.admit(
      { context, operationKey: "h-1", kind: "start", prompt: "check", origin: "heartbeat", executionPolicy: HEARTBEAT_TASK_POLICY },
      {},
    );
    const facts = factsOf(systems[0] ?? "");
    expect(facts).not.toContain(MEMORY_PROPOSE_GUIDANCE);
    expect(facts).toContain(MEMORY_NOT_AUTHORITATIVE_GUIDANCE);
  });

  it("says nothing about memory on a heartbeat tick whose prompt carries no memory block (withheld, not switched on for the heartbeat provider, or none found)", async () => {
    for (const extra of [{ memoryWithheld: () => true, heartbeatMemoryShown: () => false }, { memoryWithheld: () => true }]) {
      const { adapter, systems } = setup(extra);
      await adapter.admit(
        { context, operationKey: "h-2", kind: "start", prompt: "check", origin: "heartbeat", executionPolicy: HEARTBEAT_TASK_POLICY },
        {},
      );
      expect(systems.length).toBeGreaterThan(0);
      for (const system of systems) expect(factsOf(system)).not.toContain(MEMORY_NOT_AUTHORITATIVE_GUIDANCE);
    }
  });

  it("leaves the propose part out where the tool is not in the chat's tool set", async () => {
    const { adapter, systems } = setup({}, ["memory.search", "memory.get"]);
    await adapter.admit(
      { context, operationKey: "n-1", kind: "start", prompt: "hello", origin: "cli", executionPolicy: ATTENDED_TASK_POLICY },
      {},
    );
    expect(factsOf(systems[0] ?? "")).not.toContain(MEMORY_PROPOSE_GUIDANCE);
    expect(factsOf(systems[0] ?? "")).toContain(MEMORY_NOT_AUTHORITATIVE_GUIDANCE);
  });
});
