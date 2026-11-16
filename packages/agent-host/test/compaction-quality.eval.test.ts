import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  TaviError,
  type AccessPolicyPort,
  type InvocationContext,
  type ModelEvent,
  type ModelOutcome,
  type ModelPort,
  type ModelRequest,
  type DeclaredToolDefinition,
  type ToolRegistryPort,
} from "@tavi/contracts";
import {
  createInMemoryApprovalRepository,
  createInMemoryArtifactRepository,
  createInMemoryCancellationRepository,
  createInMemoryEffectRepository,
  createInMemoryExecutionRepository,
  createInMemoryReceiptRepository,
  createInMemorySaver,
  createInMemoryTaskRepository,
  EPOCH_LINE_PATTERN,
  isContextBlock,
} from "@tavi/test-support/fakes";
import { EPOCH_MARKER_PATTERN, createWorkflowAdapter } from "@tavi/agent-host/workflow";

/**
 * Compaction quality eval: the anchors
 * in `evals/compaction/anchors.json` — links, paths, a commit hash, a task id —
 * and a request the person stated once are planted in a chat's first turns;
 * the chat then runs until it has rolled over at least `minRollovers` times
 * (lowered triggers, so it is quick and deterministic). The epoch summary the
 * latest request carries must still name every anchor exactly and quote the
 * request. A regression in what an epoch summary keeps fails this test.
 */

const FixtureSchema = z.object({
  schemaVersion: z.literal(1),
  minRollovers: z.number().int().min(1),
  anchors: z
    .array(z.object({ id: z.string(), kind: z.string(), value: z.string().min(1), plantedIn: z.enum(["person", "assistant", "tool"]) }))
    .min(1),
  keyRequest: z.object({ id: z.string(), text: z.string().min(1), plantedIn: z.literal("person") }),
  turns: z.array(z.object({ prompt: z.string().min(1), toolInput: z.string().optional(), answer: z.string().optional() })).min(1),
  filler: z.object({ prompt: z.string().includes("{n}"), answer: z.string() }),
});
type Fixture = z.infer<typeof FixtureSchema>;

const fixture: Fixture = FixtureSchema.parse(
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../evals/compaction/anchors.json"), "utf8")),
);

const context: InvocationContext = { workspaceId: "ws-1", principalId: "operator", runId: "run-1", caller: "eval" };

const echoDefinition: DeclaredToolDefinition = {
  id: "fixture.echo",
  sink: "none",
  version: "1.0.0",
  description: "Echo a message",
  effect: "read-only",
  requiredPermissions: ["tools.invoke"],
};
const echoSchema = z.object({ message: z.string() });
const echoRegistry: ToolRegistryPort = {
  register: () => {
    throw new TaviError("UNSUPPORTED", "not used in this eval");
  },
  get: (id: string) =>
    id !== echoDefinition.id
      ? undefined
      : {
          ...echoDefinition,
          inputSchema: echoSchema,
          inputJsonSchema: z.toJSONSchema(echoSchema, { io: "input" }) as Record<string, unknown>,
          modelName: "fixture_echo",
          handler: async ({ input }: { input: unknown }) => input,
        },
  list: () => [echoDefinition],
  listOffered: async () => [echoDefinition],
  inputSchemaOf: (id: string) => (id === echoDefinition.id ? echoSchema : undefined),
  inputJsonSchemaOf: (id: string) =>
    id === echoDefinition.id ? (z.toJSONSchema(echoSchema, { io: "input" }) as Record<string, unknown>) : undefined,
  modelNameOf: (id: string) => (id === echoDefinition.id ? "fixture_echo" : undefined),
  resolveModelName: (name: string) => (name === "fixture_echo" ? echoDefinition.id : undefined),
};
const access: AccessPolicyPort = { resolveWorkspace: () => ({ principalId: context.principalId }), missingPermissions: () => [] };

/**
 * A model scripted by the fixture: a turn whose prompt names a `toolInput`
 * makes one echo round trip with it before answering; every turn answers with
 * the fixture's words. Call ids are provider-shaped (`toolu_…`), which name no
 * anchor, so only what the fixture planted competes for the summary's list.
 * Every request is checked for provider pairing.
 */
function scriptedModel(): ModelPort & { readonly calls: ModelRequest[]; readonly violations: string[] } {
  const calls: ModelRequest[] = [];
  const violations: string[] = [];
  let callCount = 0;
  const scriptFor = (prompt: string) => fixture.turns.find((turn) => prompt.startsWith(turn.prompt));
  return {
    calls,
    violations,
    async stream(request, options: { readonly onEvent: (event: ModelEvent) => void }): Promise<ModelOutcome> {
      calls.push(request);
      const open = new Set<string>();
      for (const message of request.messages) {
        if (message.role === "tool") {
          for (const toolResult of message.toolResults ?? [])
            if (!open.delete(toolResult.toolCallId)) violations.push(`result ${toolResult.toolCallId} answers no open call`);
          continue;
        }
        if (message.role === "system") continue;
        if (open.size > 0) violations.push(`calls ${[...open].join(",")} unanswered before ${message.id}`);
        for (const toolCall of message.toolCalls ?? []) open.add(toolCall.id);
      }
      const people = request.messages.filter((message) => message.role === "user" && !message.text.startsWith("Runtime facts"));
      const script = scriptFor(people.at(-1)?.text ?? "");
      const last = request.messages.filter((message) => message.role !== "system" && !message.text.startsWith("Runtime facts")).at(-1);
      if (last?.role === "user" && script?.toolInput !== undefined) {
        callCount += 1;
        const callId = `toolu_${String(callCount).padStart(6, "0")}`;
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [{ id: callId, name: "fixture.echo", input: { message: script.toolInput } }],
          usage: {},
        };
      }
      const text = script?.answer ?? fixture.filler.answer;
      options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: `block-${request.attemptId}`, text });
      return { status: "completed", attemptId: request.attemptId, text, toolCalls: [], usage: {} };
    },
  };
}

/** An ordinary chat's epoch summary rides in the call's context block: its text from the marker on. */
const summaryTextOf = (message: ModelRequest["messages"][number] | undefined): string => {
  const text = message?.text ?? "";
  const at = text.search(EPOCH_LINE_PATTERN);
  return at === -1 ? "" : text.slice(at);
};
const epochOf = (message: ModelRequest["messages"][number] | undefined): number =>
  Number(EPOCH_MARKER_PATTERN.exec(summaryTextOf(message))?.[1] ?? 0);
const summaryOf = (request: ModelRequest): ModelRequest["messages"][number] | undefined =>
  request.messages.find((message) => isContextBlock(message) && EPOCH_LINE_PATTERN.test(message.text));

describe("compaction quality eval: what an epoch summary keeps", () => {
  it(`names every planted anchor and quotes the once-stated request after ${fixture.minRollovers} rollovers`, async () => {
    const model = scriptedModel();
    let ids = 0;
    const adapter = createWorkflowAdapter({
      checkpointSaver: createInMemorySaver().saver,
      models: model,
      tools: echoRegistry,
      tasks: createInMemoryTaskRepository(),
      executions: createInMemoryExecutionRepository(),
      effects: createInMemoryEffectRepository(),
      receipts: createInMemoryReceiptRepository(),
      approvals: createInMemoryApprovalRepository(),
      cancellations: createInMemoryCancellationRepository(),
      artifacts: createInMemoryArtifactRepository(),
      ownerSession: "session-eval",
      access,
      connectionId: "fixture",
      model: "fixture-model",
      approvalRequiredFor: [],
      maxSteps: 8,
      maxToolCalls: 16,
      // Lowered so three rollovers take a few dozen turns; the summary's content rules are the defaults'.
      epochRolloverMessages: 24,
      compactionKeepRecentMessages: 8,
      newId: (prefix) => `${prefix}-${crypto.randomUUID()}`,
      now: () => `2026-10-05T00:00:${String((ids += 1) % 60).padStart(2, "0")}.000Z`,
    });

    const prompts = [...fixture.turns.map((turn) => turn.prompt)];
    let taskId: string | undefined;
    let turn = 0;
    // Plant, then fill until the latest request carries the summary of the `minRollovers`-th epoch.
    while (turn < 200 && epochOf(model.calls.length === 0 ? undefined : summaryOf(model.calls.at(-1)!)) < fixture.minRollovers) {
      const prompt = prompts[turn] ?? fixture.filler.prompt.replace("{n}", String(turn));
      const admitted = await adapter.admit(
        {
          context,
          ...(taskId === undefined ? { kind: "start" as const } : { taskId, kind: "reply" as const }),
          operationKey: `q-${turn}`,
          prompt,
        },
        {},
      );
      expect(admitted.outcome.status, `turn ${turn}`).toBe("completed");
      taskId = admitted.taskId;
      turn += 1;
    }
    expect(model.violations).toEqual([]);

    const latest = model.calls.at(-1)!;
    const summary = summaryOf(latest);
    expect(epochOf(summary)).toBeGreaterThanOrEqual(fixture.minRollovers);
    // Every planted turn was folded away: what the request still names, it names through the summary.
    const verbatim = JSON.stringify(latest.messages.filter((message) => message !== summary));
    for (const planted of fixture.turns) expect(verbatim).not.toContain(planted.prompt);

    const text = summaryTextOf(summary);
    const missing = fixture.anchors
      .filter((anchor) => !text.includes(anchor.value))
      .map((anchor) => `${anchor.id} (${anchor.kind}, planted in ${anchor.plantedIn}): ${anchor.value}`);
    expect(missing, `anchors lost by epoch ${epochOf(summary)}`).toEqual([]);
    expect(text, "the once-stated request").toContain(fixture.keyRequest.text);
  }, 60_000);
});
