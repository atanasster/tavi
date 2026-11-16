import type {
  AgentActor,
  InboundEvent,
  InvocationContext,
  MemoryActor,
  ModelEvent,
  ModelOutcome,
  ModelPort,
  ModelRequest,
  ToolResult,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { createAgentCommunicationService } from "@tavi/agent-host/agent-communication";
import { createFixtureMessagingConnectorDefinition } from "@tavi/test-support/messaging";
import { createFixtureModel, instructionsAndContextOf, type ScriptedTurn } from "@tavi/test-support/fakes";
import { MemoryService } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";

/**
 * Worker memory scoping acceptance: the full,
 * production-wired regression test proving a spawned worker's memory
 * access is genuinely narrower than its orchestrator's, not merely that
 * the underlying `MemoryService`/contract plumbing exists in isolation
 * (already covered directly against `MemoryService` in
 * `packages/runtime/test/memory-service.test.ts`, and at the tool-schema
 * level in `agent-delegation-fault.test.ts`).
 *
 * Every test here drives a real worker turn through `composeTaviRuntime`'s
 * full graph — `agents.spawn` admits the worker, and the worker's own
 * scripted model calls the real `memory.search`/`memory.get` tools exactly
 * as a live model would, so the assertions below exercise the identical
 * code path a production worker's model uses. This matters because
 * `apps/cli/src/features/memory/tools.ts` is a second `MemoryActor` construction site:
 * if it ever bypassed the restriction, a test that only called
 * `MemoryService` directly, or only checked automatic context injection,
 * would not catch it.
 */

const workspaces = [
  { workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] },
] as const;

const directories = temporaryDirectories({ prefix: "tavi-memory-scoping-" });

afterEach(() => directories.cleanup());

const operatorActor: MemoryActor = { principalId: "operator", workspaceId: "default", caller: "test", authority: "operator" };

/** Compose a runtime scripted with the given turns for every model call in this data directory (orchestrator and worker turns alike). */
async function harness(
  directory: string,
  turns: readonly ScriptedTurn[],
): Promise<{ readonly runtime: TaviRuntime; readonly model: ReturnType<typeof createFixtureModel> }> {
  const model = createFixtureModel({ turns });
  const runtime = await composeTaviRuntime(
    {
      dataDirectory: directory,
      workspaces: [...workspaces],
      providers: [],
      credentials: {},
      defaultConnectionId: "fixture",
      defaultModel: "fixture-model",
      logger: { level: "error", sink: () => {} },
      approvalRequiredFor: [],
    },
    { modelOverride: model },
  );
  // `agents.spawn`'s `agentDefinitionId` is a validated reference: a worker
  // whose persona does not resolve is refused rather
  // than silently run under the base instructions. These tests exercise memory
  // scoping, not personas, so they register the id they spawn with.
  const agents = runtime.store.asPort().repositories.agents;
  // Idempotent: some tests re-harness the same data directory, and the registry
  // deliberately refuses a duplicate id rather than upserting a persona.
  if ((await agents.get("default", "reporting-agent")) === undefined) {
    await agents.create({
      agentId: "reporting-agent",
      workspaceId: "default",
      name: "Reporting agent",
      systemPrompt: "Report on what you find.",
      enabled: true,
      now: nowTimestamp(),
    });
  }
  return { runtime, model };
}

/** Invoke a registered governed tool's handler directly, the same path a model tool call dispatches through. */
async function callTool(runtime: TaviRuntime, id: string, input: unknown, context: InvocationContext): Promise<unknown> {
  const tool = runtime.tools.get(id);
  if (tool === undefined) throw new Error(`tool ${id} is not registered`);
  return tool.handler({ input, context, signal: new AbortController().signal });
}

/**
 * The result for a specific tool call id, as observed in the LAST scripted
 * model request (the conversation accumulates every prior message, so with
 * more than one sequential tool call, `.find` for "a message with
 * toolResults" alone would return the FIRST one in history rather than the
 * one belonging to `toolCallId` — this looks it up by id instead).
 */
function toolResultFor(model: ReturnType<typeof createFixtureModel>, toolCallId: string): ToolResult | undefined {
  const lastRequest = model.calls.at(-1);
  for (const message of lastRequest?.messages ?? []) {
    const match = message.toolResults?.find((result) => result.toolCallId === toolCallId);
    if (match !== undefined) return match;
  }
  return undefined;
}

describe("worker memory scoping acceptance", () => {
  it("a) excludes the orchestrator's personal-scope record from a worker's memory.search by default, and b) includes an explicitly-shared one", async () => {
    const directory = directories.create();
    const setup = await harness(directory, [{ text: "setup" }]);
    const memory = new MemoryService(setup.runtime.store.asPort(), {
      now: () => setup.runtime.clock.now(),
      newId: (prefix) => setup.runtime.clock.newId(prefix),
    });
    const personal = await memory.approve({
      actor: operatorActor,
      recordId: (
        await memory.propose({
          actor: operatorActor,
          scope: { kind: "personal", principalId: "operator" },
          kind: "fact",
          body: "wombat launch codes — never share",
        })
      ).recordId,
    });
    const shared = await memory.approve({
      actor: operatorActor,
      recordId: (
        await memory.propose({
          actor: operatorActor,
          scope: { kind: "personal", principalId: "operator" },
          kind: "fact",
          body: "wombat onboarding checklist — fine to share",
        })
      ).recordId,
    });
    await setup.runtime.close();

    // A fresh runtime/model per spawn (createFixtureModel's turn index is
    // per-request attemptNumber, which restarts at 1 for a new task, so a
    // shared model instance across two independent spawns can't script them
    // distinctly).
    const { runtime, model } = await harness(directory, [
      { toolCall: { id: "c1", name: "memory.search", input: { query: "wombat" } } },
      { text: "done" },
    ]);
    const orchestratorContext: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "root", caller: "test" };
    await callTool(
      runtime,
      "agents.spawn",
      {
        agentDefinitionId: "reporting-agent",
        input: "search my memory",
        operationKey: "op-search-scoped",
        sharedMemoryRecordIds: [shared.recordId],
      },
      orchestratorContext,
    );

    const searchResult = toolResultFor(model, "c1")?.output as { hits: readonly { recordId: string }[] } | undefined;
    const foundIds = searchResult?.hits.map((hit) => hit.recordId) ?? [];
    // Same query term ("wombat") matches both records' bodies — a search
    // that returned everything the orchestrator could read would surface
    // both. A restricted worker must see only the explicitly-shared one.
    expect(foundIds).toContain(shared.recordId);
    expect(foundIds).not.toContain(personal.recordId);
    await runtime.close();
  });

  it("the exact same restriction applies to memory.get directly, not only search (the tool path builds its own actor)", async () => {
    const directory = directories.create();
    const setup = await harness(directory, [{ text: "setup" }]);
    const memory = new MemoryService(setup.runtime.store.asPort(), {
      now: () => setup.runtime.clock.now(),
      newId: (prefix) => setup.runtime.clock.newId(prefix),
    });
    const personal = await memory.approve({
      actor: operatorActor,
      recordId: (
        await memory.propose({
          actor: operatorActor,
          scope: { kind: "personal", principalId: "operator" },
          kind: "fact",
          body: "not for the worker",
        })
      ).recordId,
    });
    const shared = await memory.approve({
      actor: operatorActor,
      recordId: (
        await memory.propose({
          actor: operatorActor,
          scope: { kind: "personal", principalId: "operator" },
          kind: "fact",
          body: "fine for the worker",
        })
      ).recordId,
    });
    await setup.runtime.close();

    const { runtime, model } = await harness(directory, [
      { toolCall: { id: "c1", name: "memory.get", input: { recordId: personal.recordId } } },
      { toolCall: { id: "c2", name: "memory.get", input: { recordId: shared.recordId } } },
      { text: "done" },
    ]);
    const orchestratorContext: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "root", caller: "test" };
    await callTool(
      runtime,
      "agents.spawn",
      {
        agentDefinitionId: "reporting-agent",
        input: "fetch records",
        operationKey: "op-get-scoped",
        sharedMemoryRecordIds: [shared.recordId],
      },
      orchestratorContext,
    );

    const getPersonalResult = toolResultFor(model, "c1");
    expect(getPersonalResult?.isError).toBe(true);
    const getSharedResult = toolResultFor(model, "c2");
    expect(getSharedResult?.isError).toBe(false);
    expect((getSharedResult?.output as { recordId: string } | undefined)?.recordId).toBe(shared.recordId);
    await runtime.close();
  });

  it("d) a forgotten shared record disappears for the worker too, even though its id remains in the grant", async () => {
    const directory = directories.create();
    const memory0 = await harness(directory, [{ text: "setup" }]);
    const memory = new MemoryService(memory0.runtime.store.asPort(), {
      now: () => memory0.runtime.clock.now(),
      newId: (prefix) => memory0.runtime.clock.newId(prefix),
    });
    const shared = await memory.approve({
      actor: operatorActor,
      recordId: (
        await memory.propose({
          actor: operatorActor,
          scope: { kind: "personal", principalId: "operator" },
          kind: "fact",
          body: "will be forgotten after the grant",
        })
      ).recordId,
    });
    // Never granted, never forgotten — stays alive for the whole test. Its
    // sole purpose: `get()`'s tombstone check
    // (`status === "deleted"`) rejects a forgotten record for ANY actor,
    // restricted or not, so testing only the forgotten record proves
    // nothing about whether `contextFrom` actually re-derives the worker's
    // restriction on its second turn — a regression that silently returned
    // an UNRESTRICTED actor on turn 2 would still pass a forgotten-record-
    // only test, since the tombstone check would reject it either way. This
    // record's continued invisibility on the worker's second turn is what
    // actually falsifies that failure mode.
    const neverGranted = await memory.approve({
      actor: operatorActor,
      recordId: (
        await memory.propose({
          actor: operatorActor,
          scope: { kind: "personal", principalId: "operator" },
          kind: "fact",
          body: "never granted to any worker",
        })
      ).recordId,
    });
    await memory0.runtime.close();

    // The worker's first turn is a plain-text turn (no tool call yet) so
    // the record is still readable at grant-validation time; the record is
    // then forgotten from the orchestrator side; a second turn (`wake`,
    // triggering a fresh "reply" admission — `contextFrom` re-derives the
    // SAME restriction/grant on this turn too) is where the
    // worker's model actually tries to read the now-forgotten record AND
    // (separately) search for the never-granted one.
    const { runtime, model } = await harness(directory, [
      { text: "spawned, waiting to be woken" },
      { toolCall: { id: "c1", name: "memory.get", input: { recordId: shared.recordId } } },
      { toolCall: { id: "c2", name: "memory.search", input: { query: "never granted" } } },
      { text: "done" },
    ]);
    const orchestratorContext: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "root", caller: "test" };
    const spawned = (await callTool(
      runtime,
      "agents.spawn",
      {
        agentDefinitionId: "reporting-agent",
        input: "wait for instructions",
        operationKey: "op-forgotten",
        sharedMemoryRecordIds: [shared.recordId],
      },
      orchestratorContext,
    )) as { workerTaskId: string };

    const memoryAfterSpawn = new MemoryService(runtime.store.asPort(), {
      now: () => runtime.clock.now(),
      newId: (prefix) => runtime.clock.newId(prefix),
    });
    await memoryAfterSpawn.forget({ actor: operatorActor, recordId: shared.recordId, reason: "no longer needed" });

    if (runtime.workflow === undefined) throw new Error("workflow unavailable");
    const repositories = runtime.store.asPort().repositories;
    const agents = createAgentCommunicationService({
      mailbox: repositories.agentMailbox,
      waits: repositories.agentWaits,
      delegations: repositories.agentDelegations,
      tasks: repositories.tasks,
      workflow: runtime.workflow,
      access: runtime.access,
      cancelTask: () => {
        throw new Error("cancel is not exercised by this test");
      },
      now: () => runtime.clock.now(),
      newId: (prefix) => runtime.clock.newId(prefix),
    });
    const wakingActor: AgentActor = { principalId: "operator", workspaceId: "default", caller: "test" };
    await agents.wake({ actor: wakingActor, taskId: spawned.workerTaskId });

    expect(toolResultFor(model, "c1")?.isError).toBe(true);
    // The real proof of per-turn re-derivation: a record that was never
    // forgotten and never granted stays invisible on this SECOND turn too.
    // If `contextFrom` failed to re-derive the restriction on `wake`'s
    // admission (reverting to an unrestricted actor), this search would
    // wrongly return a hit.
    const neverGrantedResult = toolResultFor(model, "c2")?.output as { hits: readonly { recordId: string }[] } | undefined;
    expect(neverGrantedResult?.hits.map((hit) => hit.recordId)).not.toContain(neverGranted.recordId);
    await runtime.close();
  });

  it("e) the orchestrator's own memory.search/memory.get are completely unaffected by a worker's restriction elsewhere", async () => {
    const directory = directories.create();
    const { runtime, model } = await harness(directory, [
      { text: "n/a — orchestrator calls tools directly, never through a scripted model turn" },
    ]);
    const memory = new MemoryService(runtime.store.asPort(), {
      now: () => runtime.clock.now(),
      newId: (prefix) => runtime.clock.newId(prefix),
    });
    const personal = await memory.approve({
      actor: operatorActor,
      recordId: (
        await memory.propose({
          actor: operatorActor,
          scope: { kind: "personal", principalId: "operator" },
          kind: "fact",
          body: "orchestrator's own private note",
        })
      ).recordId,
    });

    // Spawn one restricted worker granted nothing, to prove its existence
    // in the same data directory doesn't leak backward into the
    // orchestrator's own (unrestricted) tool calls.
    const orchestratorContext: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "root", caller: "test" };
    await callTool(
      runtime,
      "agents.spawn",
      { agentDefinitionId: "reporting-agent", input: "do nothing memory-related", operationKey: "op-unrelated-worker" },
      orchestratorContext,
    );

    const searchResult = (await callTool(runtime, "memory.search", { query: "private note" }, orchestratorContext)) as {
      hits: readonly { recordId: string }[];
    };
    expect(searchResult.hits.map((hit) => hit.recordId)).toEqual([personal.recordId]);
    const getResult = (await callTool(runtime, "memory.get", { recordId: personal.recordId }, orchestratorContext)) as { recordId: string };
    expect(getResult.recordId).toBe(personal.recordId);
    expect(model.calls).toHaveLength(1); // only the unrelated worker's own turn ran a model call
    await runtime.close();
  });

  it("a joined worker's first turn takes its spawner's memory reach: one from an ordinary chat proposes for everywhere, a group's is chat-only", async () => {
    const proposeTurns: readonly ScriptedTurn[] = [
      { toolCall: { id: "p1", name: "memory.propose", input: { kind: "fact", body: "the person likes wombats" } } },
      { text: "done" },
    ];
    const ordinary = await harness(directories.create(), proposeTurns);
    const chatContext: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "root", caller: "test" };
    await callTool(
      ordinary.runtime,
      "agents.spawn",
      { agentDefinitionId: "reporting-agent", input: "remember it", operationKey: "op-propose-ordinary" },
      chatContext,
    );
    expect(toolResultFor(ordinary.model, "p1")?.isError).toBe(false);
    const memory = new MemoryService(ordinary.runtime.store.asPort(), {
      now: () => ordinary.runtime.clock.now(),
      newId: (prefix) => ordinary.runtime.clock.newId(prefix),
    });
    expect((await memory.list({ actor: operatorActor, statuses: ["proposed"] })).length).toBe(1);
    await ordinary.runtime.close();

    const group = await harness(directories.create(), proposeTurns);
    await callTool(
      group.runtime,
      "agents.spawn",
      { agentDefinitionId: "reporting-agent", input: "remember it", operationKey: "op-propose-group" },
      { ...chatContext, memoryReach: "chat-only" },
    );
    expect(toolResultFor(group.model, "p1")?.isError).toBe(true);
    expect(JSON.stringify(toolResultFor(group.model, "p1")?.output ?? null)).toContain("A worker in a group chat cannot propose memory");
    await group.runtime.close();
  });

  it("a joined worker's first turn takes its spawner's chat memory mode: an off or private chat's worker has no memory.* tool, an on chat's keeps them", async () => {
    const proposeTurns: readonly ScriptedTurn[] = [
      { toolCall: { id: "p1", name: "memory.propose", input: { kind: "fact", body: "the person likes wombats" } } },
      { text: "done" },
    ];
    const memoryTools = (model: ReturnType<typeof createFixtureModel>): readonly string[] =>
      (model.calls[0]?.tools ?? []).map((tool) => tool.id).filter((id) => id.startsWith("memory."));
    const chatContext: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "root", caller: "test" };

    const on = await harness(directories.create(), proposeTurns);
    await callTool(
      on.runtime,
      "agents.spawn",
      { agentDefinitionId: "reporting-agent", input: "remember it", operationKey: "op-memory-on" },
      chatContext,
    );
    expect(memoryTools(on.model)).toContain("memory.propose");
    expect(toolResultFor(on.model, "p1")?.isError).toBe(false);
    await on.runtime.close();

    for (const mode of ["off", "private"] as const) {
      const off = await harness(directories.create(), proposeTurns);
      await callTool(
        off.runtime,
        "agents.spawn",
        { agentDefinitionId: "reporting-agent", input: "remember it", operationKey: `op-memory-${mode}` },
        { ...chatContext, chatMemoryMode: mode },
      );
      expect(memoryTools(off.model)).toEqual([]);
      expect(toolResultFor(off.model, "p1")?.isError).toBe(true);
      const memory = new MemoryService(off.runtime.store.asPort(), {
        now: () => off.runtime.clock.now(),
        newId: (prefix) => off.runtime.clock.newId(prefix),
      });
      expect(await memory.list({ actor: operatorActor, statuses: ["proposed"] })).toEqual([]);
      await off.runtime.close();
    }
  });

  it("a worker an off chat's turn spawns is off from its first turn, and an on chat's keeps its memory tools", async () => {
    /** The chat spawns a worker, then ends; the worker answers at once. Records every request. */
    const spawningModel = (): ModelPort & { readonly calls: ModelRequest[] } => {
      const calls: ModelRequest[] = [];
      return {
        calls,
        async stream(request: ModelRequest): Promise<ModelOutcome> {
          calls.push(request);
          const worker = request.messages.some((message) => message.role === "user" && message.text.includes("remember it"));
          const spawned = request.messages.some((message) => (message.toolResults?.length ?? 0) > 0);
          const toolCalls =
            worker || spawned
              ? []
              : [
                  {
                    id: "s1",
                    name: "agents.spawn",
                    input: { agentDefinitionId: "reporting-agent", input: "remember it", operationKey: "op-chat-worker" },
                  },
                ];
          return { status: "completed", attemptId: request.attemptId, text: toolCalls.length === 0 ? "done" : "", toolCalls, usage: {} };
        },
      };
    };
    const workerMemoryTools = async (memoryMode: "off" | undefined): Promise<readonly string[] | undefined> => {
      const model = spawningModel();
      const directory = directories.create();
      const runtime = await composeTaviRuntime(
        {
          dataDirectory: directory,
          workspaces: [...workspaces],
          providers: [],
          credentials: {},
          defaultConnectionId: "fixture",
          defaultModel: "fixture-model",
          logger: { level: "error", sink: () => {} },
          approvalRequiredFor: [],
        },
        { modelOverride: model },
      );
      try {
        await runtime.store.asPort().repositories.agents.create({
          agentId: "reporting-agent",
          workspaceId: "default",
          name: "Reporting agent",
          systemPrompt: "Report on what you find.",
          enabled: true,
          now: nowTimestamp(),
        });
        await runtime.workflow?.admit({
          context: { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "cli" },
          operationKey: "op-chat",
          kind: "start",
          ...(memoryMode === undefined ? {} : { memoryMode }),
          prompt: "delegate it",
        });
        const workerCall = model.calls.find((call) =>
          call.messages.some((message) => message.role === "user" && message.text.includes("remember it")),
        );
        return workerCall?.tools.map((tool) => tool.id).filter((id) => id.startsWith("memory."));
      } finally {
        await runtime.close();
      }
    };
    expect(await workerMemoryTools(undefined)).toContain("memory.propose");
    expect(await workerMemoryTools("off")).toEqual([]);
  });
});

/**
 * A group conversation's turns read no personal memory,
 * driven through the real inbound pipeline: a group's Home is narrowed from
 * its first message (before its mapping is recorded) and on every later one,
 * across a real checkpoint round-trip, while a DM of the same person keeps
 * their memory.
 */
describe("group conversations read only their chat's notes", () => {
  /** Answers a message naming SEARCH with three tool calls, then text; any other message with text. */
  function groupModel(): ModelPort & { readonly calls: ModelRequest[] } {
    const calls: ModelRequest[] = [];
    return {
      calls,
      async stream(request: ModelRequest, options: { readonly onEvent: (event: ModelEvent) => void }): Promise<ModelOutcome> {
        calls.push(request);
        const last = request.messages.at(-1);
        const searching =
          last?.role === "user" && last.text.includes("SEARCH") && (last.toolResults === undefined || last.toolResults.length === 0);
        if (searching) {
          return {
            status: "completed",
            attemptId: request.attemptId,
            text: "",
            usage: {},
            toolCalls: [
              { id: "g-memory", name: "memory.search", input: { query: "wombat" } },
              { id: "g-sessions", name: "sessions.search", input: { query: "wombat" } },
              { id: "g-propose", name: "memory.propose", input: { kind: "fact", body: "a member says the person is in Porto" } },
            ],
          };
        }
        options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text: "ok" });
        return { status: "completed", attemptId: request.attemptId, text: "ok", toolCalls: [], usage: {} };
      },
    };
  }

  const event = (overrides: Partial<InboundEvent>): InboundEvent => ({
    connectionId: "conn-g",
    providerEventId: "evt",
    kind: "message",
    externalSenderId: "member-1",
    externalConversationId: "group-42",
    conversationKind: "group",
    occurredAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    content: "hello",
    ...overrides,
  });

  const resultOf = (request: ModelRequest | undefined, id: string): ToolResult | undefined => {
    for (const message of request?.messages ?? []) {
      const found = message.toolResults?.find((result) => result.toolCallId === id);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  it("memory invariant 5: a group turn's prompt has its chat's notes and no personal fact or preference; its searches stay in the group; a DM is unchanged", async () => {
    const directory = directories.create();
    const model = groupModel();
    const runtime = await composeTaviRuntime(
      {
        dataDirectory: directory,
        workspaces: [...workspaces],
        providers: [],
        credentials: {},
        defaultConnectionId: "fixture",
        defaultModel: "fixture-model",
        logger: { level: "error", sink: () => {} },
        approvalRequiredFor: [],
      },
      { modelOverride: model },
    );
    try {
      const repositories = runtime.store.asPort().repositories;
      runtime.messaging.registerConnector({
        ...createFixtureMessagingConnectorDefinition({ sendOutcome: () => ({ status: "accepted", retryable: false, parts: [] }) }),
        destinationFromInbound: (replyTo) => ({ fixtureChat: replyTo.externalConversationId }),
      });
      await runtime.messaging.openConnection({
        connection: {
          connectionId: "conn-g",
          providerId: "fixture",
          accountIdentity: "acct-g",
          workspaceId: "default",
          configRevision: 1,
          enabled: true,
        },
        config: {},
      });
      for (const sender of ["member-1", "operator-dm"]) {
        await repositories.messagingIdentityBindings.bind({
          connectionId: "conn-g",
          externalSenderId: sender,
          workspaceId: "default",
          principalId: "operator",
          approvedBy: "operator",
          createdAt: "2026-01-01T00:00:00.000Z",
        });
      }
      const memory = new MemoryService(runtime.store.asPort(), {
        now: () => runtime.clock.now(),
        newId: (prefix) => runtime.clock.newId(prefix),
      });
      const approve = async (input: Parameters<MemoryService["propose"]>[0]) =>
        memory.approve({ actor: input.actor, recordId: (await memory.propose(input)).recordId });
      await approve({
        actor: operatorActor,
        scope: { kind: "personal", principalId: "operator" },
        kind: "fact",
        body: "wombat: the person lives in Lisbon",
      });
      await approve({
        actor: operatorActor,
        scope: { kind: "personal", principalId: "operator" },
        kind: "preference",
        preferenceKey: "reply.tone",
        preference: { valueType: "string", value: "terse-wombat" },
        body: "terse-wombat",
      });
      // The person's own chat, outside the group: its words are theirs, never the group's to read.
      await runtime.workflow?.admit({
        context: { workspaceId: "default", principalId: "operator", runId: "pending-admission", caller: "cli" },
        operationKey: "op-own-chat",
        kind: "start",
        prompt: "wombat plans for my own eyes",
      });

      // The group's first message: narrowed before its conversation is even mapped.
      await runtime.messaging.ingest(event({ providerEventId: "g-1", content: "hello wombat" }));
      const first = instructionsAndContextOf(model.calls.at(-1));
      expect(first).not.toContain("Lisbon");
      expect(first).not.toContain("terse-wombat");
      const epoch0 = (await repositories.messagingConversations.get("conn-g", "group-42"))?.taskId ?? "";
      // The group starts over: its first epoch is an earlier chat of the same conversation.
      await runtime.messaging.ingest(event({ providerEventId: "g-new", content: "/new" }));
      await runtime.messaging.ingest(event({ providerEventId: "g-2", content: "hi again" }));
      const groupHome = (await repositories.messagingConversations.get("conn-g", "group-42"))?.taskId ?? "";
      expect(groupHome).not.toBe("");
      expect(groupHome).not.toBe(epoch0);
      await approve({
        actor: { ...operatorActor, runId: groupHome },
        scope: { kind: "run_local", principalId: "operator", workspaceId: "default", runId: groupHome },
        durable: true,
        kind: "fact",
        body: "wombat: the group meets on Fridays",
      });

      // A later message, read back from the checkpoint: notes yes, personal memory no.
      await runtime.messaging.ingest(event({ providerEventId: "g-3", content: "SEARCH wombat" }));
      const searchTurn = model.calls.findLast((request) => request.messages.at(-1)?.text.includes("SEARCH") === true);
      const second = instructionsAndContextOf(searchTurn);
      expect(second).toContain("the group meets on Fridays");
      expect(second).not.toContain("Lisbon");
      expect(second).not.toContain("terse-wombat");
      const after = model.calls.at(-1);
      const memoryHits = (resultOf(after, "g-memory")?.output as { hits: readonly { snippet: string }[] } | undefined)?.hits ?? [];
      expect(memoryHits.map((hit) => hit.snippet).join(" ")).toContain("Fridays");
      expect(memoryHits.map((hit) => hit.snippet).join(" ")).not.toContain("Lisbon");
      const sessions = JSON.stringify(resultOf(after, "g-sessions")?.output ?? null);
      expect(sessions).toContain("hello wombat");
      expect(sessions).not.toContain("for my own eyes");
      expect(resultOf(after, "g-propose")?.isError).toBe(true);
      expect((await memory.list({ actor: operatorActor, statuses: ["proposed"] })).length).toBe(0);
      expect((await repositories.tasks.get(groupHome))?.origin).toBe("messaging");

      // The same person's DM keeps their memory.
      await runtime.messaging.ingest(
        event({
          providerEventId: "dm-1",
          externalSenderId: "operator-dm",
          externalConversationId: "operator-dm",
          conversationKind: "direct",
          content: "hi wombat",
        }),
      );
      const dm = instructionsAndContextOf(model.calls.at(-1));
      expect(dm).toContain("Lisbon");
      expect(dm).toContain("terse-wombat");
    } finally {
      await runtime.close();
    }
  });
});
