import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ATTENDED_TASK_POLICY,
  UNATTENDED_TASK_POLICY,
  type DeclaredToolDefinition,
  type InvocationContext,
  type MemoryRecord,
  type MemorySearchResult,
  type ReachableChannel,
  type MemoryServicePort,
  RouterSettingsSchema,
  TRUSTED_PUBLIC,
  type RouterDecisionInput,
  type RouterPort,
  type RouterReceipt,
  type RouterRepositoryPort,
  type ToolRegistryPort,
} from "@tavi/contracts";
import { partialFake } from "@tavi/test-support";
import {
  createInMemoryApprovalRepository,
  createInMemoryCancellationRepository,
  createInMemoryEffectRepository,
  createInMemoryExecutionRepository,
  createInMemoryReceiptRepository,
  createInMemorySaver,
  createInMemoryTaskRepository,
} from "@tavi/test-support/fakes";
import { sse, textChunk, toolCallChunk } from "@tavi/test-support/openai-stub";
import { prefixContinuity, recordingFetch } from "@tavi/test-support/prefix";
import { createWorkflowAdapter } from "@tavi/agent-host/workflow";

import type { ModelMessage } from "@tavi/contracts";
import { createAiSdkModelAdapter } from "../src/models/models.js";

/**
 * Prefix continuity, end to end: real turns through the workflow and the
 * AI SDK adapter, for an Anthropic model on OpenRouter (the provider that
 * caches only what a breakpoint marks), with every request body captured as
 * sent. Each scenario says whether the next call reuses the previous one's
 * cacheable prefix. Where today's layout misses, the test pins the miss and
 * its reason, and the change that fixes it flips the expectation.
 *
 * Scenarios not driven here yet, each with the reason it is a miss today:
 *  - an epoch summary under v1: it rides in the context block at the newest
 *    person message, so it is re-sent after every turn (v2 shows it once);
 *  - a heartbeat tick to the next: ticks are farther apart than the 5-minute
 *    cache lifetime, so every mark is a write no tick reads.
 */

const context: InvocationContext = { workspaceId: "ws1", principalId: "p1", runId: "root", caller: "test" };
const schema = z.strictObject({});
const definition: DeclaredToolDefinition = {
  id: "notes.read",
  sink: "none",
  version: "1",
  description: "Read the notes",
  effect: "read-only",
  requiredPermissions: [],
};
/** A deferred tool, offered only once `tools.search` finds it. */
const archive: DeclaredToolDefinition = { ...definition, id: "notes.archive", description: "Archive the notes", deferred: true };

/** A registry of `definitions`, each named by its id with `_` for `.`. */
function registryWith(definitions: readonly DeclaredToolDefinition[], outputs: Readonly<Record<string, unknown>> = {}): ToolRegistryPort {
  const byId = new Map(definitions.map((entry) => [entry.id, entry]));
  const nameOf = (id: string) => id.replace(".", "_");
  return {
    register: () => {
      throw new Error("not used");
    },
    get: (id) => {
      const entry = byId.get(id);
      return entry === undefined
        ? undefined
        : {
            ...entry,
            inputSchema: schema,
            inputJsonSchema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
            modelName: nameOf(id),
            handler: async () => outputs[id] ?? { notes: "the notes" },
          };
    },
    list: () => [...definitions],
    listOffered: async () => [...definitions],
    inputSchemaOf: (id) => (byId.has(id) ? schema : undefined),
    inputJsonSchemaOf: (id) => (byId.has(id) ? (z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>) : undefined),
    modelNameOf: (id) => (byId.has(id) ? nameOf(id) : undefined),
    resolveModelName: (name) => definitions.find((entry) => nameOf(entry.id) === name)?.id,
  };
}
const registry = registryWith([definition]);

/** A memory service whose every search finds one record: each turn's context block carries it. */
function memoryFinding(): MemoryServicePort {
  const notUsed = async (): Promise<never> => {
    throw new Error("not used");
  };
  const hit = (): MemorySearchResult => ({
    hits: [
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
    ],
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

/** The tool's name as the request offered it. */
function offeredToolName(body: string): string {
  const tools = (JSON.parse(body) as { readonly tools?: readonly { readonly function: { readonly name: string } }[] }).tools ?? [];
  return tools[0]?.function.name ?? "notes_read";
}

/**
 * A router in `modes` that selects `notes.read` for tools and every candidate for memory and skills, answering
 * one question at a time and, with `batch`, a batch; every question it was asked.
 */
function routerSelecting(modes: Readonly<Record<string, string>>, batch = false) {
  const asked: RouterDecisionInput[] = [];
  const settings = RouterSettingsSchema.parse({ enabled: true, modes });
  const receipt = (input: RouterDecisionInput): RouterReceipt => ({
    decisionId: `d-${asked.length}`,
    operationId: input.operationId,
    taskId: input.fence.taskId,
    turnId: input.turnId,
    feature: input.feature,
    mode: "active",
    providerId: "fixture",
    configRevision: 1,
    policyVersion: "1",
    candidateHash: "0".repeat(64),
    permissionRevision: input.permissionRevision,
    state: "finished",
    reason: "selected",
    selectedIds: input.feature === "tools" ? ["notes.read"] : input.candidates.map((candidate) => candidate.id),
    probabilities: {},
    cacheHit: false,
    elapsedMs: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  const decide = async (input: RouterDecisionInput) => {
    asked.push(input);
    return receipt(input);
  };
  const service = partialFake<RouterPort>({
    configuration: async () => ({ revision: 1, settings }),
    decide,
    ...(batch ? { decideBatch: async (inputs: readonly RouterDecisionInput[]) => await Promise.all(inputs.map(decide)) } : {}),
  });
  const disclosures = new Map<string, Parameters<RouterRepositoryPort["saveDisclosure"]>[2]>();
  const repository = partialFake<RouterRepositoryPort>({
    saveDisclosure: async (_scope, _fence, disclosure) => void disclosures.set(disclosure.attemptId, disclosure),
    disclosure: async (_scope, _taskId, attemptId) => disclosures.get(attemptId),
    saveContextProjection: async () => undefined,
  });
  return { routing: { service, repository }, asked };
}

/**
 * A workflow on the AI SDK adapter, its provider answering every odd call with
 * a tool call and every even one with an answer; the bodies it was sent.
 */
function harness(extra: Record<string, unknown> = {}) {
  return harnessWith((index, body) => {
    const chunks =
      index % 2 === 0
        ? [toolCallChunk({ id: `call-${index}`, name: offeredToolName(body), arguments: {} }), textChunk("", "tool_calls")]
        : [textChunk("done", null), textChunk("", "stop")];
    return new Response(sse(chunks), { status: 200, headers: { "content-type": "text/event-stream" } });
  }, extra);
}

/** `harness` with the provider's answers scripted by `answer`. */
function harnessWith(answer: (index: number, body: string) => Response, extra: Record<string, unknown> = {}) {
  const recorded = recordingFetch(answer);
  const models = createAiSdkModelAdapter({
    connections: [{ connectionId: "openrouter", kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", credentialRef: "k" }],
    readSecret: async () => "k",
    fetch: recorded.fetch,
  });
  let counter = 0;
  const adapter = createWorkflowAdapter({
    checkpointSaver: createInMemorySaver().saver,
    models,
    tools: registry,
    tasks: createInMemoryTaskRepository(),
    executions: createInMemoryExecutionRepository(),
    effects: createInMemoryEffectRepository(),
    receipts: createInMemoryReceiptRepository(),
    approvals: createInMemoryApprovalRepository(),
    cancellations: createInMemoryCancellationRepository(),
    ownerSession: "test-session",
    connectionId: "openrouter",
    model: "anthropic/claude-sonnet-5-5",
    systemPrompt: "test system prompt",
    access: { resolveWorkspace: () => ({ principalId: context.principalId }), missingPermissions: () => [] },
    toolPolicy: { rules: async () => [], sessionGrants: async () => [] },
    newId: (prefix: string) => `${prefix}-${(counter += 1)}`,
    now: () => "2026-01-01T00:00:00.000Z",
    ...extra,
  } as Parameters<typeof createWorkflowAdapter>[0]);
  /** Two turns of the same chat, each a tool call and an answer. */
  const twoTurns = async () => {
    const first = await adapter.admit({
      context,
      operationKey: "turn-1",
      kind: "start",
      prompt: "read my notes",
      origin: "cli",
      executionPolicy: ATTENDED_TASK_POLICY,
    });
    expect(first.outcome.status, first.outcome.finalText).toBe("completed");
    const second = await adapter.admit({ context, taskId: first.taskId, operationKey: "turn-2", kind: "reply", prompt: "and again" });
    expect(second.outcome.status).toBe("completed");
  };
  return { bodies: recorded.bodies, twoTurns, adapter };
}

describe("prefix continuity across a chat's model calls", () => {
  it("reuses the system prompt from a turn's first call to its second, but never marks the person's message on the first", async () => {
    const { bodies, twoTurns } = harness({ memory: memoryFinding() });
    await twoTurns();
    expect(bodies).toHaveLength(4);
    // A hit, but only through the system prompt: the step note is concatenated into the person's
    // message on step 1, so no breakpoint can end at that message and nothing past the system prompt is cacheable.
    expect(prefixContinuity(bodies[0]!, bodies[1]!)).toMatchObject({ hit: true, cacheableThrough: { message: 0, role: "system" } });
  });

  it("misses at the previous turn's person message when the next turn begins, with a context block", async () => {
    const { bodies, twoTurns } = harness({ memory: memoryFinding() });
    await twoTurns();
    // Turn 1's last call marks its tool result; turn 2 sends turn 1's person message without the
    // context block folded into it, so the request diverges there.
    expect(prefixContinuity(bodies[1]!, bodies[2]!)).toEqual({
      hit: false,
      toolsMatch: true,
      cacheableThrough: { message: 3, role: "tool" },
      divergesAt: { message: 1, role: "user" },
    });
  });

  it("reuses the previous turn's tool loop when the next turn begins, with no context block", async () => {
    const { bodies, twoTurns } = harness();
    await twoTurns();
    expect(prefixContinuity(bodies[1]!, bodies[2]!)).toMatchObject({ hit: true, cacheableThrough: { message: 3, role: "tool" } });
  });

  it("misses from the tools on a turn's final step, which is sent no tools", async () => {
    const { bodies, twoTurns } = harness({ maxSteps: 2 });
    await twoTurns();
    // Expected miss: the final step empties the tools array, which leads the cached prefix.
    expect(prefixContinuity(bodies[0]!, bodies[1]!)).toMatchObject({ hit: false, toolsMatch: false });
  });

  describe("under models.promptLayout v2", () => {
    const v2 = { promptLayout: async () => "v2" as const };

    it("marks the person's message on a turn's first call and reuses it, with the tool loop, on the second", async () => {
      const { bodies, twoTurns } = harness({ ...v2, memory: memoryFinding() });
      await twoTurns();
      expect(prefixContinuity(bodies[0]!, bodies[1]!)).toMatchObject({ hit: true, cacheableThrough: { message: 1, role: "user" } });
    });

    it("reuses the previous turn's person message and tool loop when the next turn begins, with a context block", async () => {
      const { bodies, twoTurns } = harness({ ...v2, memory: memoryFinding() });
      await twoTurns();
      expect(prefixContinuity(bodies[1]!, bodies[2]!)).toMatchObject({
        hit: true,
        toolsMatch: true,
        cacheableThrough: { message: 3, role: "tool" },
      });
    });

    it("writes the turn's block once, before the person's words, and leaves out of the next turn's what the first showed", async () => {
      const { bodies, twoTurns } = harness({ ...v2, memory: memoryFinding() });
      await twoTurns();
      const userParts = (body: string, index: number) =>
        (JSON.parse(body) as { messages: { role: string; content: string | { text: string }[] }[] }).messages.filter(
          (message) => message.role === "user",
        )[index]?.content;
      const first = userParts(bodies[0]!, 0) as { text: string }[];
      expect(first[0]?.text).toContain("Travelling to Lisbon until Friday");
      expect(first[1]?.text).toBe("read my notes");
      expect(first[2]?.text).toContain("Runtime facts for this model step");
      // Turn 2 found the same record again: nothing new, so its message carries no block.
      const second = userParts(bodies[2]!, 1);
      expect(JSON.stringify(second)).not.toContain("Travelling to Lisbon until Friday");
      expect(JSON.stringify(second)).toContain("and again");
    });

    it("records a record as used only on the turn whose block first showed it", async () => {
      const recorded: string[][] = [];
      const { twoTurns } = harness({
        ...v2,
        memory: memoryFinding(),
        memoryUse: { record: async (input: { readonly recordIds: readonly string[] }) => void recorded.push([...input.recordIds]) },
      });
      await twoTurns();
      expect(recorded).toEqual([["mem-1"]]);
    });

    describe("once a memory a kept block showed is forgotten", () => {
      /** A record as a search finds it. */
      const record = (id: string, snippet: string): MemorySearchResult["hits"][number] => ({
        recordId: `mem-${id}`,
        revisionId: `memrev-${id}`,
        scope: { kind: "personal", principalId: "p1" },
        kind: "fact",
        snippet,
        recordedAt: "2026-01-01T00:00:00.000Z",
        superseded: false,
        conflict: false,
      });
      const lisbon = record("a", "Travelling to Lisbon until Friday");
      const oat = record("b", "Takes oat milk in coffee");
      /** A memory service finding `hits()` on each search: turn 1 Lisbon, then Lisbon and oat milk, then (forgotten) oat milk alone. */
      const finding = (hits: () => MemorySearchResult["hits"]): MemoryServicePort => ({
        ...memoryFinding(),
        search: async () => ({ hits: [...hits()], coverage: "complete" }),
      });
      const userTexts = (body: string) =>
        JSON.stringify(
          (JSON.parse(body) as { messages: { role: string; content: unknown }[] }).messages.filter((message) => message.role === "user"),
        );
      const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

      /** Four turns of a chat: Lisbon shown in turn 1, oat milk in turn 2, Lisbon forgotten before turn 3. */
      const fourTurns = async (forgottenMemory?: (workspaceId: string, ids: readonly string[]) => Promise<ReadonlySet<string>>) => {
        let turn = 0;
        const { bodies, adapter } = harness({
          ...v2,
          memory: finding(() => (turn === 1 ? [lisbon] : turn === 2 ? [lisbon, oat] : [oat])),
          ...(forgottenMemory === undefined ? {} : { forgottenMemory }),
        });
        turn = 1;
        const first = await adapter.admit({
          context,
          operationKey: "turn-1",
          kind: "start",
          prompt: "read my notes",
          origin: "cli",
          executionPolicy: ATTENDED_TASK_POLICY,
        });
        expect(first.outcome.status, first.outcome.finalText).toBe("completed");
        for (const index of [2, 3, 4]) {
          turn = index;
          const next = await adapter.admit({
            context,
            taskId: first.taskId,
            operationKey: `turn-${index}`,
            kind: "reply",
            prompt: "and again",
          });
          expect(next.outcome.status, next.outcome.finalText).toBe("completed");
        }
        return bodies;
      };

      it("sends no later call a copy of it, keeps the other kept blocks, and clears it from the checkpoint", async () => {
        let forgotten = false;
        const asked: string[][] = [];
        let turn = 0;
        const { bodies, adapter } = harness({
          ...v2,
          memory: finding(() => (turn === 1 ? [lisbon] : turn === 2 ? [lisbon, oat] : [oat])),
          forgottenMemory: async (_workspaceId: string, ids: readonly string[]) => {
            asked.push([...ids]);
            return new Set(forgotten ? ids.filter((id) => id === "memrev-a") : []);
          },
        });
        turn = 1;
        const first = await adapter.admit({
          context,
          operationKey: "turn-1",
          kind: "start",
          prompt: "read my notes",
          origin: "cli",
          executionPolicy: ATTENDED_TASK_POLICY,
        });
        turn = 2;
        await adapter.admit({ context, taskId: first.taskId, operationKey: "turn-2", kind: "reply", prompt: "and again" });
        expect(userTexts(bodies[3]!)).toContain("Travelling to Lisbon until Friday");
        expect(occurrences(userTexts(bodies[3]!), "Takes oat milk in coffee")).toBe(1);
        // The person forgets Lisbon.
        forgotten = true;
        turn = 3;
        await adapter.admit({ context, taskId: first.taskId, operationKey: "turn-3", kind: "reply", prompt: "and once more" });
        for (const body of bodies.slice(4)) {
          expect(body).not.toContain("Lisbon");
          // Turn 2's kept block, which did not show it, still rides on turn 2's message, once.
          expect(occurrences(userTexts(body), "Takes oat milk in coffee")).toBe(1);
        }
        // The cleared block was written back: turn 4 asks only about what its kept blocks still show.
        turn = 4;
        asked.length = 0;
        await adapter.admit({ context, taskId: first.taskId, operationKey: "turn-4", kind: "reply", prompt: "last one" });
        expect(asked.flat()).not.toContain("memrev-a");
        expect(asked.flat()).toContain("memrev-b");
        for (const body of bodies.slice(6)) expect(body).not.toContain("Lisbon");
        // Turn 3's two calls share their prefix again, as before the forget.
        expect(prefixContinuity(bodies[4]!, bodies[5]!)).toMatchObject({ hit: true });
      });

      it("sends byte-identical requests when nothing is forgotten", async () => {
        const unchecked = await fourTurns();
        const checked = await fourTurns(async () => new Set<string>());
        expect(checked).toEqual(unchecked);
      });

      it("leaves out every kept block that showed memory when what is forgotten cannot be read", async () => {
        let failing = false;
        let turn = 0;
        const { bodies, adapter } = harness({
          ...v2,
          memory: finding(() => (turn === 1 ? [lisbon] : [])),
          forgottenMemory: async () => {
            if (failing) throw new Error("store unavailable");
            return new Set<string>();
          },
        });
        turn = 1;
        const first = await adapter.admit({
          context,
          operationKey: "turn-1",
          kind: "start",
          prompt: "read my notes",
          origin: "cli",
          executionPolicy: ATTENDED_TASK_POLICY,
        });
        failing = true;
        turn = 2;
        await adapter.admit({ context, taskId: first.taskId, operationKey: "turn-2", kind: "reply", prompt: "and again" });
        for (const body of bodies.slice(2)) expect(body).not.toContain("Lisbon");
      });

      it("keeps no block built while the check failed, so once it works again nothing is sent twice", async () => {
        let failing = false;
        let turn = 0;
        const telegram: ReachableChannel = {
          connectionId: "telegram-1",
          label: "Telegram",
          channel: "Telegram",
          kind: "chat",
          target: "Telegram chat id",
          buttons: true,
          files: true,
          maxTextLength: 4096,
          allowedTargets: ["*"],
        };
        const sendTo: DeclaredToolDefinition = { ...definition, id: "messaging.send_to", description: "Send to a channel" };
        const { bodies, adapter } = harness({
          ...v2,
          tools: registryWith([definition, sendTo]),
          reachableChannels: () => [telegram],
          // Every turn's search finds Lisbon again.
          memory: finding(() => [lisbon]),
          forgottenMemory: async () => {
            if (failing) throw new Error("store unavailable");
            return new Set<string>();
          },
        });
        turn = 1;
        const first = await adapter.admit({
          context,
          operationKey: "turn-1",
          kind: "start",
          prompt: "read my notes",
          origin: "cli",
          executionPolicy: ATTENDED_TASK_POLICY,
        });
        failing = true;
        turn = 2;
        await adapter.admit({ context, taskId: first.taskId, operationKey: "turn-2", kind: "reply", prompt: "and again" });
        // The check works again: turn 1's block is back, and turn 2's message keeps no block of its own.
        failing = false;
        turn = 3;
        const before = bodies.length;
        await adapter.admit({ context, taskId: first.taskId, operationKey: "turn-3", kind: "reply", prompt: "and once more" });
        expect(turn).toBe(3);
        expect(bodies.length).toBeGreaterThan(before);
        for (const body of bodies.slice(before)) {
          expect(occurrences(userTexts(body), "Travelling to Lisbon until Friday")).toBe(1);
          expect(occurrences(userTexts(body), "telegram-1")).toBe(1);
        }
      });

      describe("a preference", () => {
        /** A stored preference as `resolvePreferences` answers it, its winner at `revisionId`. */
        const preference = (key: string, value: string, revisionId: string) => ({
          key,
          value,
          winner: {
            recordId: `pref-${revisionId}`,
            currentRevisionId: revisionId,
            scope: { kind: "personal", principalId: "p1" },
            updatedAt: "2026-01-01T00:00:00.000Z",
          } as unknown as MemoryRecord,
          overridden: [],
          conflict: false,
          conflictRecordIds: [],
        });
        const tea = preference("drink", "green tea", "prefrev-tea");
        const metric = preference("units", "metric-units", "prefrev-units");
        const imperial = preference("units", "imperial-units", "prefrev-units-2");

        it("leaves every later request once forgotten, while a changed value still shows again", async () => {
          let forgotten = false;
          let turn = 0;
          const asked: string[][] = [];
          const { bodies, adapter } = harness({
            ...v2,
            memory: {
              ...memoryFinding(),
              search: async () => ({ hits: [], coverage: "complete" }),
              resolvePreferences: async () => ({
                preferences: turn === 1 ? [tea] : turn === 2 ? [tea, metric] : turn === 3 ? [metric] : [imperial],
                truncated: false,
              }),
            } satisfies MemoryServicePort,
            forgottenMemory: async (_workspaceId: string, ids: readonly string[]) => {
              asked.push([...ids]);
              return new Set(forgotten ? ids.filter((id) => id === "prefrev-tea") : []);
            },
          });
          turn = 1;
          const first = await adapter.admit({
            context,
            operationKey: "turn-1",
            kind: "start",
            prompt: "read my notes",
            origin: "cli",
            executionPolicy: ATTENDED_TASK_POLICY,
          });
          turn = 2;
          await adapter.admit({ context, taskId: first.taskId, operationKey: "turn-2", kind: "reply", prompt: "and again" });
          expect(asked.flat()).toContain("prefrev-tea");
          expect(occurrences(userTexts(bodies[3]!), "green tea")).toBe(1);
          expect(occurrences(userTexts(bodies[3]!), "metric-units")).toBe(1);
          // The person forgets the drink preference.
          forgotten = true;
          turn = 3;
          const forgetAt = bodies.length;
          await adapter.admit({ context, taskId: first.taskId, operationKey: "turn-3", kind: "reply", prompt: "and once more" });
          for (const body of bodies.slice(forgetAt)) {
            expect(body).not.toContain("green tea");
            // Turn 2's block, which showed the units, is kept and sent once.
            expect(occurrences(userTexts(body), "metric-units")).toBe(1);
          }
          // The units change: the new value is shown again, in turn 4's block.
          turn = 4;
          asked.length = 0;
          const changedAt = bodies.length;
          await adapter.admit({ context, taskId: first.taskId, operationKey: "turn-4", kind: "reply", prompt: "last one" });
          expect(asked.flat()).not.toContain("prefrev-tea");
          for (const body of bodies.slice(changedAt)) {
            expect(body).not.toContain("green tea");
            expect(occurrences(userTexts(body), "imperial-units")).toBe(1);
          }
        });
      });
    });

    it("keeps no block after a failed first call, so the next turn shows and records it", async () => {
      const recorded: string[][] = [];
      const { bodies, adapter } = harnessWith(
        (index, body) =>
          index === 0
            ? new Response(JSON.stringify({ error: { message: "bad request" } }), {
                status: 400,
                headers: { "content-type": "application/json" },
              })
            : new Response(
                sse(
                  index % 2 === 1
                    ? [toolCallChunk({ id: `call-${index}`, name: offeredToolName(body), arguments: {} }), textChunk("", "tool_calls")]
                    : [textChunk("done", null), textChunk("", "stop")],
                ),
                {
                  status: 200,
                  headers: { "content-type": "text/event-stream" },
                },
              ),
        {
          ...v2,
          memory: memoryFinding(),
          memoryUse: { record: async (input: { readonly recordIds: readonly string[] }) => void recorded.push([...input.recordIds]) },
        },
      );
      const first = await adapter.admit({
        context,
        operationKey: "turn-1",
        kind: "start",
        prompt: "read my notes",
        origin: "cli",
        executionPolicy: ATTENDED_TASK_POLICY,
      });
      expect(first.outcome.status).toBe("failed");
      await adapter.admit({ context, taskId: first.taskId, operationKey: "turn-2", kind: "reply", prompt: "and again" });
      // The failed turn's message went without a block; the next turn's shows the record and records it.
      const turnTwo = JSON.parse(bodies[1]!) as { messages: { role: string; content: unknown }[] };
      const users = turnTwo.messages.filter((message) => message.role === "user");
      expect(JSON.stringify(users[0]?.content)).not.toContain("Travelling to Lisbon");
      expect(JSON.stringify(users.at(-1)?.content)).toContain("Travelling to Lisbon");
      expect(recorded).toEqual([["mem-1"]]);
    });

    it("asks the router about tools once a turn, not once a step", async () => {
      for (const [layout, asked] of [
        ["v1", 4],
        ["v2", 2],
      ] as const) {
        const { routing, asked: questions } = routerSelecting({ tools: "active" });
        const { twoTurns } = harness({ promptLayout: async () => layout, routing });
        await twoTurns();
        const operations = new Set(questions.filter((question) => question.feature === "tools").map((question) => question.operationId));
        expect(operations.size, layout).toBe(asked);
      }
    });

    it("keeps the system text when a channel reconnects mid-turn, saying the channels in the turn's block", async () => {
      const sendTo: DeclaredToolDefinition = { ...definition, id: "messaging.send_to", description: "Send to a channel" };
      const telegram: ReachableChannel = {
        connectionId: "telegram-1",
        label: "Telegram",
        channel: "Telegram",
        kind: "chat",
        target: "Telegram chat id",
        buttons: true,
        files: true,
        maxTextLength: 4096,
        allowedTargets: ["*"],
      };
      for (const [layout, hit] of [
        ["v1", false],
        ["v2", true],
      ] as const) {
        let asked = 0;
        // Connected for the turn's first call, reconnecting (not listed) for its second.
        const reachableChannels = () => ((asked += 1) === 1 ? [telegram] : []);
        const { bodies, twoTurns } = harness({
          promptLayout: async () => layout,
          tools: registryWith([definition, sendTo]),
          reachableChannels,
        });
        await twoTurns();
        expect(prefixContinuity(bodies[0]!, bodies[1]!).hit, layout).toBe(hit);
        const system = (body: string) => (JSON.parse(body) as { messages: { role: string; content: unknown }[] }).messages[0]?.content;
        if (layout === "v2") {
          expect(JSON.stringify(system(bodies[0]!))).not.toContain("telegram-1");
          expect(bodies[0]).toContain("telegram-1");
        }
      }
    });

    it("keeps the tools on a turn's final step, so the whole prefix holds", async () => {
      const { bodies, twoTurns } = harness({ ...v2, maxSteps: 2 });
      await twoTurns();
      expect(prefixContinuity(bodies[0]!, bodies[1]!)).toMatchObject({ hit: true, toolsMatch: true });
    });

    it("keeps a tool tools.search found for the epoch, so the next turn's tools match the last call's", async () => {
      for (const [layout, toolsMatch] of [
        ["v1", false],
        ["v2", true],
      ] as const) {
        const { bodies, adapter } = harnessWith(
          (index) =>
            new Response(
              sse(
                index === 0
                  ? [toolCallChunk({ id: "search-1", name: "tools_search", arguments: { query: "archive" } }), textChunk("", "tool_calls")]
                  : [textChunk("done", null), textChunk("", "stop")],
              ),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            ),
          { promptLayout: async () => layout, tools: registryWith([definition, archive]) },
        );
        const first = await adapter.admit({
          context,
          operationKey: "t-1",
          kind: "start",
          prompt: "archive my notes",
          origin: "cli",
          executionPolicy: ATTENDED_TASK_POLICY,
        });
        await adapter.admit({ context, taskId: first.taskId, operationKey: "t-2", kind: "reply", prompt: "and again" });
        const offered = (body: string) =>
          (JSON.parse(body) as { tools: { function: { name: string } }[] }).tools.map((tool) => tool.function.name);
        expect(offered(bodies[1]!), layout).toContain("notes_archive");
        expect(prefixContinuity(bodies[1]!, bodies[2]!).toolsMatch, layout).toBe(toolsMatch);
        if (layout === "v2") expect(offered(bodies[1]!).at(-1)).toBe("notes_archive");
      }
    });

    it("defers an attended chat's rarely used built-in families behind tools.search, and only an attended chat's", async () => {
      const routines: DeclaredToolDefinition = { ...definition, id: "routines.create", description: "Create a routine" };
      const firstTools = async (layout: "v1" | "v2", origin: "cli" | "schedule", toolDeferral = true) => {
        const { bodies, adapter } = harnessWith(
          () =>
            new Response(sse([textChunk("done", null), textChunk("", "stop")]), {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          { promptLayout: async () => layout, toolDeferral: async () => toolDeferral, tools: registryWith([definition, routines]) },
        );
        await adapter.admit({
          context,
          operationKey: `t-${layout}-${origin}`,
          kind: "start",
          prompt: "read my notes",
          origin,
          ...(origin === "schedule" ? { originScheduleId: "sched-1" } : {}),
          executionPolicy: origin === "cli" ? ATTENDED_TASK_POLICY : UNATTENDED_TASK_POLICY,
        });
        return (JSON.parse(bodies[0]!) as { tools: { function: { name: string; description: string } }[] }).tools.map(
          (tool) => tool.function,
        );
      };
      const attended = await firstTools("v2", "cli");
      expect(attended.map((tool) => tool.name)).toEqual(["notes_read", "tools_search"]);
      expect(attended.at(-1)?.description).toContain("- routines.*: create, change, run, pause and inspect routines");
      expect((await firstTools("v1", "cli")).map((tool) => tool.name)).toEqual(["notes_read", "routines_create"]);
      expect((await firstTools("v2", "schedule")).map((tool) => tool.name)).toEqual(["notes_read", "routines_create"]);
      // `models.toolDeferral` off (or `auto` on a local model): the whole list, under v2 too.
      expect((await firstTools("v2", "cli", false)).map((tool) => tool.name)).toEqual(["notes_read", "routines_create"]);
    });

    it("defers the families all the same when the whole list would be past what one request may carry", async () => {
      const routines: DeclaredToolDefinition = { ...definition, id: "routines.create", description: "Create a routine" };
      const many = Array.from({ length: 130 }, (_, index): DeclaredToolDefinition => ({ ...definition, id: `routines.t${String(index)}` }));
      const { bodies, adapter } = harnessWith(
        () =>
          new Response(sse([textChunk("done", null), textChunk("", "stop")]), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        { promptLayout: async () => "v2", toolDeferral: async () => false, tools: registryWith([definition, routines, ...many]) },
      );
      await adapter.admit({
        context,
        operationKey: "t-many",
        kind: "start",
        prompt: "read my notes",
        origin: "cli",
        executionPolicy: ATTENDED_TASK_POLICY,
      });
      const names = (JSON.parse(bodies[0]!) as { tools: { function: { name: string } }[] }).tools.map((tool) => tool.function.name);
      expect(names).not.toContain("routines_create");
      expect(names).toContain("tools_search");
    });

    it("defers them past the limit on a surface that lists every family, as an unattended run does", async () => {
      const routines: DeclaredToolDefinition = { ...definition, id: "routines.create", description: "Create a routine" };
      const many = Array.from({ length: 130 }, (_, index): DeclaredToolDefinition => ({ ...definition, id: `routines.t${String(index)}` }));
      const { bodies, adapter } = harnessWith(
        () =>
          new Response(sse([textChunk("done", null), textChunk("", "stop")]), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        { promptLayout: async () => "v2", tools: registryWith([definition, routines, ...many]) },
      );
      await adapter.admit({
        context,
        operationKey: "t-many-schedule",
        kind: "start",
        prompt: "read my notes",
        origin: "schedule",
        originScheduleId: "sched-1",
        executionPolicy: UNATTENDED_TASK_POLICY,
      });
      const names = (JSON.parse(bodies[0]!) as { tools: { function: { name: string } }[] }).tools.map((tool) => tool.function.name);
      expect(names).not.toContain("routines_create");
      expect(names.length).toBeLessThanOrEqual(128);
    });

    it("offers the turn's routed tools on its final step, which asks the router nothing about them", async () => {
      const write: DeclaredToolDefinition = { ...definition, id: "notes.write", description: "Write the notes" };
      const { routing } = routerSelecting({ tools: "active" });
      const { bodies, twoTurns } = harness({ ...v2, maxSteps: 2, routing, tools: registryWith([definition, write]) });
      await twoTurns();
      const offered = (body: string) =>
        (JSON.parse(body) as { tools: { function: { name: string } }[] }).tools.map((tool) => tool.function.name);
      expect(offered(bodies[0]!)).not.toContain("notes_write");
      // Not a word-ranked shortlist, which would add notes.write and move the array that leads the cached prefix.
      expect(offered(bodies[1]!)).toEqual(offered(bodies[0]!));
      expect(prefixContinuity(bodies[0]!, bodies[1]!)).toMatchObject({ hit: true, toolsMatch: true });
    });

    it("asks the router about memory on a turn's first call only, once the turn's block is kept", async () => {
      for (const [layout, asked] of [
        ["v1", 2],
        ["v2", 1],
      ] as const) {
        const { routing, asked: questions } = routerSelecting({ tools: "active", memory: "active" }, true);
        const { adapter } = harness({ promptLayout: async () => layout, routing, memory: memoryFinding() });
        const first = await adapter.admit({
          context,
          operationKey: "turn-1",
          kind: "start",
          prompt: "read my notes",
          origin: "cli",
          executionPolicy: ATTENDED_TASK_POLICY,
        });
        expect(first.outcome.status).toBe("completed");
        expect(
          questions.filter((question) => question.feature === "memory"),
          layout,
        ).toHaveLength(asked);
      }
    });

    it("says the reachable channels in a wake turn's runtime facts, which has no person message to carry the block", async () => {
      const telegram: ReachableChannel = {
        connectionId: "telegram-1",
        label: "Telegram",
        channel: "Telegram",
        kind: "chat",
        target: "Telegram chat id",
        buttons: true,
        files: true,
        maxTextLength: 4096,
        allowedTargets: ["*"],
      };
      const sendTo: DeclaredToolDefinition = { ...definition, id: "messaging.send_to", description: "Send to a channel" };
      const { bodies, adapter } = harness({ ...v2, tools: registryWith([definition, sendTo]), reachableChannels: () => [telegram] });
      const first = await adapter.admit({
        context,
        operationKey: "turn-1",
        kind: "start",
        prompt: "read my notes",
        origin: "cli",
        executionPolicy: ATTENDED_TASK_POLICY,
      });
      // A worker's result wakes the chat: an inbound block and no prompt.
      const wake = await adapter.admit({
        context,
        taskId: first.taskId,
        operationKey: "wake-1",
        kind: "reply",
        inbound: [{ heading: "A worker's result", text: "the notes were read", label: TRUSTED_PUBLIC }],
      });
      expect(wake.outcome.status).toBe("completed");
      const system = (body: string) => JSON.stringify((JSON.parse(body) as { messages: { content: unknown }[] }).messages[0]?.content);
      // The person's turn says them in its block, out of the system text; the wake, with no block, in its runtime facts.
      expect(system(bodies[0]!)).not.toContain("telegram-1");
      expect(bodies[0]).toContain("telegram-1");
      expect(system(bodies[2]!)).toContain("telegram-1");
    });
  });

  it("drops images in strides under v2: one image-set change across seven images, where v1 makes four", async () => {
    const at = "2026-01-01T00:00:00.000Z";
    const shot = (index: number): ModelMessage[] => [
      {
        id: `a${index}`,
        role: "assistant",
        text: "",
        createdAt: at,
        toolCalls: [{ id: `c${index}`, name: "artifacts.view_image", input: {} }],
      },
      {
        id: `t${index}`,
        role: "tool",
        text: "",
        createdAt: at,
        toolResults: [
          {
            toolCallId: `c${index}`,
            toolName: "artifacts.view_image",
            isError: false,
            output: { taviMedia: { artifactId: `img${index}`, mediaType: "image/png" } },
          },
        ],
      },
    ];
    const changesAcross = async (layout: "v1" | "v2"): Promise<number> => {
      const recorded = recordingFetch(
        () =>
          new Response(sse([textChunk("ok", null), textChunk("", "stop")]), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      );
      const models = createAiSdkModelAdapter({
        connections: [
          { connectionId: "openrouter", kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", credentialRef: "k" },
        ],
        readSecret: async () => "k",
        resolveMedia: (artifactId) => ({ mediaType: "image/png", data: new Uint8Array([artifactId.length]) }),
        fetch: recorded.fetch,
      });
      const user: ModelMessage = { id: "u", role: "user", text: "look at these", createdAt: at };
      for (let count = 1; count <= 7; count += 1)
        await models.stream(
          {
            connectionId: "openrouter",
            model: "anthropic/claude-sonnet-5-5",
            runId: "root",
            attemptId: `attempt-${count}`,
            attemptNumber: count,
            messages: [user, ...Array.from({ length: count }, (_, index) => shot(index + 1)).flat()],
            tools: [],
            ...(layout === "v2" ? { promptLayout: "v2" as const } : {}),
          },
          { signal: new AbortController().signal, onEvent: () => {} },
        );
      // A change is a request that does not start with every message the one before it sent.
      let changes = 0;
      for (let index = 1; index < recorded.bodies.length; index += 1)
        if (prefixContinuity(recorded.bodies[index - 1]!, recorded.bodies[index]!).divergesAt !== undefined) changes += 1;
      return changes;
    };
    expect(await changesAcross("v1")).toBe(4);
    expect(await changesAcross("v2")).toBe(1);
  });

  it("shrinks long tool results in the model's view only when the stride settles, not on every call", async () => {
    const run: DeclaredToolDefinition = { ...definition, id: "sandbox.run", description: "Run a command" };
    // Each result is about 30,000 characters: the conversation crosses a 120,000-character stride every few turns.
    const { bodies, adapter } = harness({
      promptLayout: async () => "v2" as const,
      tools: registryWith([run], { "sandbox.run": { exitCode: 0, stdout: "x".repeat(30_000) } }),
    });
    let taskId: string | undefined;
    for (let turn = 0; turn < 8; turn += 1) {
      const admitted = await adapter.admit({
        context,
        operationKey: `s-${turn}`,
        ...(taskId === undefined
          ? { kind: "start" as const, prompt: "run it", origin: "cli" as const, executionPolicy: ATTENDED_TASK_POLICY }
          : { taskId, kind: "reply" as const, prompt: `again ${turn}` }),
      });
      expect(admitted.outcome.status).toBe("completed");
      taskId = admitted.taskId;
    }
    const sent = (body: string) => body.length;
    // A rewrite is a call that misses: it does not start with the previous call's cacheable prefix.
    let rewrites = 0;
    for (let index = 1; index < bodies.length; index += 1) if (!prefixContinuity(bodies[index - 1]!, bodies[index]!).hit) rewrites += 1;
    // 8 turns of 30,000 characters cross the stride once (240,000 / 120,000 = 2 boundaries, the first at about 120,000):
    // the earlier results are rewritten at the boundary, and every other call starts with the one before it.
    expect(rewrites).toBeGreaterThan(0);
    expect(rewrites).toBeLessThanOrEqual(2);
    // And the rewrite shrank them: the last request is far smaller than eight whole results.
    expect(sent(bodies.at(-1)!)).toBeLessThan(8 * 30_000);
  });
});
