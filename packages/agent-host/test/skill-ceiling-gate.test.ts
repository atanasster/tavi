import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  DeclaredToolDefinition,
  InvocationContext,
  ModelOutcome,
  ModelPort,
  ModelRequest,
  ToolRegistryPort,
  ToolRule,
  WorkflowMessage,
} from "@tavi/contracts";
import {
  createInMemoryApprovalRepository,
  createInMemoryCancellationRepository,
  createInMemoryEffectRepository,
  createInMemoryExecutionRepository,
  createInMemoryReceiptRepository,
  createInMemorySaver,
  createInMemoryTaskRepository,
} from "@tavi/test-support/fakes";
import { createWorkflowAdapter } from "@tavi/agent-host/workflow";
import { skillsInScope, turnSkillCeiling } from "../src/workflow/skill-scope.js";

/**
 * A skill's `allowed-tools` as a ceiling, end to end through the workflow
 * graph (E10): a skill loaded this turn that declares `[Read]` makes an
 * `fs.write` call ask in an attended chat and be refused in a run nobody
 * attends, naming the skill; `fs.read` under it is decided as before; a skill
 * that declares nothing lifts it; the scope ends at the next person message;
 * and with no declaring skill in scope no card appears.
 */

const context: InvocationContext = { workspaceId: "ws1", principalId: "p1", runId: "root", caller: "test" };
const schema = z.strictObject({ skillId: z.string().optional(), value: z.string().optional() });

const definitions: readonly DeclaredToolDefinition[] = [
  { id: "skills.read", sink: "none", version: "1", description: "Load a skill", effect: "read-only", requiredPermissions: [] },
  { id: "fs.read", sink: "none", version: "1", description: "Read a file", effect: "read-only", requiredPermissions: [] },
  { id: "fs.write", sink: "none", version: "1", description: "Write a file", effect: "mutating", requiredPermissions: [] },
];

/** The skills `skills.read` answers for: one declaring `[Read]`, one declaring nothing. */
const SKILLS: Readonly<Record<string, readonly string[] | undefined>> = { "read-only": ["Read", "Frobnicate"], open: undefined };

function registry(ran: string[]): ToolRegistryPort {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const modelName = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return {
    register: () => {
      throw new Error("not used");
    },
    get: (id) => {
      const definition = byId.get(id);
      if (definition === undefined) return undefined;
      return {
        ...definition,
        inputSchema: schema,
        inputJsonSchema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
        modelName: modelName(id),
        handler: async (call: { readonly input?: unknown }) => {
          ran.push(id);
          if (id !== "skills.read") return { ok: true };
          const skillId = (call.input as { skillId?: string }).skillId ?? "";
          const allowedTools = SKILLS[skillId];
          return { skillId, version: "1.0.0", text: "do the thing", ...(allowedTools === undefined ? {} : { allowedTools }) };
        },
      };
    },
    list: () => definitions,
    listOffered: async () => definitions,
    inputSchemaOf: (id) => (byId.has(id) ? schema : undefined),
    inputJsonSchemaOf: (id) => (byId.has(id) ? (z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>) : undefined),
    modelNameOf: (id) => (byId.has(id) ? modelName(id) : undefined),
    resolveModelName: (name) => [...byId.keys()].find((id) => modelName(id) === name),
  };
}

type ScriptedCall = { readonly name: string; readonly input?: unknown } | "text";

/** One step per entry: a tool call, or `"text"` to end the turn; then text. Records what each request carried. */
function scriptedModel(script: readonly ScriptedCall[]): { readonly model: ModelPort; readonly requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let step = 0;
  const model: ModelPort = {
    async stream(request: ModelRequest): Promise<ModelOutcome> {
      requests.push(request);
      const call = script[step];
      step += 1;
      if (call !== undefined && call !== "text")
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [{ id: `t${step}`, name: call.name, input: call.input ?? {} }],
          usage: {},
        };
      return { status: "completed", attemptId: request.attemptId, text: "done", toolCalls: [], usage: {} };
    },
  };
  return { model, requests };
}

/** An operator rule allowing `fs.write`: without a ceiling it runs with no card, so any card is the ceiling's. */
const ALLOW_WRITE: ToolRule = {
  ruleId: "allow-write",
  workspaceId: "ws1",
  toolPattern: "fs.write",
  decision: "allow",
  source: "operator",
  createdBy: "operator",
  createdVia: "cli",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function adapter(model: ModelPort, ran: string[], extra: Partial<Parameters<typeof createWorkflowAdapter>[0]> = {}) {
  let counter = 0;
  return createWorkflowAdapter({
    ...extra,
    checkpointSaver: createInMemorySaver().saver,
    models: model,
    tools: registry(ran),
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
    toolPolicy: { rules: async () => [ALLOW_WRITE], sessionGrants: async () => [] },
    newId: (prefix) => `${prefix}-${(counter += 1)}`,
    now: () => "2026-01-01T00:00:00.000Z",
  } as Parameters<typeof createWorkflowAdapter>[0]);
}

const load = (skillId: string): ScriptedCall => ({ name: "skills.read", input: { skillId } });

describe("a skill's allowed-tools ceiling at the gate", () => {
  it("asks an fs.write outside a [Read] skill's list in an attended chat, once, with a card naming the skill", async () => {
    const ran: string[] = [];
    const { model } = scriptedModel([load("read-only"), { name: "fs.write", input: { value: "x" } }]);
    const result = await adapter(model, ran).admit({ context, operationKey: "op-ceiling-ask", kind: "start", prompt: "use the skill" });
    expect(result.outcome.status).toBe("waiting");
    const [request] = result.outcome.interrupt?.requests ?? [];
    expect(request).toMatchObject({ toolName: "fs.write", allowedScopes: ["once"], gateReason: "outside-skill-ceiling", tainted: false });
    expect(request?.provenance?.skillCeiling).toEqual({
      skillIds: ["read-only"],
      declared: ["Read", "Frobnicate"],
      unenforceable: ["Frobnicate"],
    });
    expect(ran).toEqual(["skills.read"]);
  });

  it("refuses it in a run nobody attends, with an error naming the ceiling", async () => {
    const ran: string[] = [];
    const { model, requests } = scriptedModel([load("read-only"), { name: "fs.write", input: { value: "x" } }]);
    const result = await adapter(model, ran, { taintAsksDeny: true, approvalRequiredFor: [] }).admit({
      context,
      operationKey: "op-ceiling-unattended",
      kind: "start",
      prompt: "use the skill",
    });
    expect(result.outcome.status).toBe("completed");
    expect(ran).toEqual(["skills.read"]);
    const denial = requests
      .at(-1)
      ?.messages.flatMap((message) => message.toolResults ?? [])
      .find((entry) => entry.toolCallId === "t2");
    expect(JSON.stringify(denial?.output)).toContain("outside the allowed-tools ceiling of skill “read-only” (Read, Frobnicate)");
  });

  it("leaves fs.read under the [Read] skill as it was: it runs with no card", async () => {
    const ran: string[] = [];
    const { model } = scriptedModel([load("read-only"), { name: "fs.read", input: { value: "x" } }]);
    const result = await adapter(model, ran).admit({ context, operationKey: "op-ceiling-read", kind: "start", prompt: "use the skill" });
    expect(result.outcome.status).toBe("completed");
    expect(ran).toEqual(["skills.read", "fs.read"]);
  });

  it("lifts the ceiling when a skill in scope declares nothing", async () => {
    const ran: string[] = [];
    const { model } = scriptedModel([load("read-only"), load("open"), { name: "fs.write", input: { value: "x" } }]);
    const result = await adapter(model, ran).admit({ context, operationKey: "op-ceiling-open", kind: "start", prompt: "use both" });
    expect(result.outcome.status).toBe("completed");
    expect(ran).toEqual(["skills.read", "skills.read", "fs.write"]);
  });

  it("ends the scope at the next person message", async () => {
    const ran: string[] = [];
    const { model } = scriptedModel([load("read-only"), "text", { name: "fs.write", input: { value: "x" } }]);
    const workflow = adapter(model, ran);
    const first = await workflow.admit({ context, operationKey: "op-ceiling-turn-1", kind: "start", prompt: "load it" });
    expect(first.outcome.status).toBe("completed");
    const second = await workflow.admit({
      context,
      taskId: first.taskId,
      operationKey: "op-ceiling-turn-2",
      kind: "reply",
      prompt: "now write",
    });
    expect(second.outcome.status).toBe("completed");
    expect(ran).toEqual(["skills.read", "fs.write"]);
  });

  it("shows no card when no skill in scope declares the field", async () => {
    const ran: string[] = [];
    const { model } = scriptedModel([load("open"), { name: "fs.write", input: { value: "x" } }]);
    const result = await adapter(model, ran).admit({ context, operationKey: "op-ceiling-none", kind: "start", prompt: "use it" });
    expect(result.outcome.status).toBe("completed");
    expect(result.outcome.interrupt).toBeUndefined();
    expect(ran).toEqual(["skills.read", "fs.write"]);
  });
});

describe("the skills in scope", () => {
  const person = (id: string): WorkflowMessage => ({ id, role: "user", text: "hi" });
  const read = (id: string, output: unknown, isError = false): WorkflowMessage => ({
    id,
    role: "tool",
    text: "",
    toolName: "skills.read",
    toolCallId: id,
    output,
    ...(isError ? { isError: true } : {}),
  });

  it("reads each skills.read since the latest person message, and nothing before it", () => {
    const conversation = [
      person("u1"),
      read("r1", { skillId: "old", allowedTools: ["Write"] }),
      person("u2"),
      read("r2", { skillId: "a", allowedTools: ["Read"] }),
      read("r3", { skillId: "b" }),
    ];
    expect(skillsInScope(conversation)).toEqual([{ skillId: "a", allowedTools: ["Read"] }, { skillId: "b" }]);
    // `b` declares nothing: no ceiling.
    expect(turnSkillCeiling(conversation)).toBeUndefined();
    expect(turnSkillCeiling(conversation.slice(0, 4))?.skillIds).toEqual(["a"]);
  });

  it("counts no failed read, and no result that names no skill", () => {
    const conversation = [person("u1"), read("r1", { error: "NOT_FOUND" }, true), read("r2", { archived: "art-1" })];
    expect(skillsInScope(conversation)).toEqual([]);
    expect(turnSkillCeiling(conversation)).toBeUndefined();
  });
});
