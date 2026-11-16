import { describe, expect, it } from "vitest";
import { z } from "zod";

import { TaviError, type DeclaredToolDefinition, type InvocationContext, type ToolRegistryPort } from "@tavi/contracts";
import { createInMemoryEffectRepository } from "@tavi/test-support/fakes";
import { dispatchTool } from "@tavi/agent-host/workflow";

/** A call that meets an app needing its sign-in. */

const context: InvocationContext = { workspaceId: "ws1", principalId: "p1", runId: "root", caller: "test" };
const access = { resolveWorkspace: () => ({ principalId: context.principalId }), missingPermissions: () => [] };
const write: DeclaredToolDefinition = {
  id: "mcp.gcal.create_event",
  sink: "network",
  version: "1",
  description: "Create",
  effect: "external",
  requiredPermissions: [],
};

function registry(thrown: () => Error, tool: DeclaredToolDefinition = write): ToolRegistryPort {
  const schema = z.object({}).passthrough();
  return {
    register: () => {
      throw new Error("not used");
    },
    get: (id) =>
      id === tool.id
        ? {
            ...tool,
            inputSchema: schema,
            inputJsonSchema: {},
            modelName: "mcp_gcal_create_event",
            handler: async () => {
              throw thrown();
            },
          }
        : undefined,
    list: () => [tool],
    listOffered: async () => [tool],
    inputSchemaOf: (id) => (id === tool.id ? schema : undefined),
    inputJsonSchemaOf: () => ({}),
    modelNameOf: () => "mcp_gcal_create_event",
    resolveModelName: () => undefined,
  };
}

async function call(thrown: () => Error, tool: DeclaredToolDefinition = write) {
  const effects = createInMemoryEffectRepository();
  const message = await dispatchTool(
    registry(thrown, tool),
    access,
    effects,
    { id: "c1", name: tool.id, input: { title: "Lunch" } },
    context,
    { taskId: "task-1", admissionId: "admission-1", steps: 1, redact: false },
    undefined,
    undefined,
  );
  return { message, states: (await effects.listForTask("task-1")).map((effect) => effect.state) };
}

describe("a sign-in error in dispatch", () => {
  it("asks for the Connect card in an attended run, and rejects the effect: nothing ran", async () => {
    const { message, states } = await call(
      () =>
        new TaviError("NOT_AUTHORIZED", "Google Calendar needs the person to sign in again.", {
          details: { mcpFailure: "login", pluginId: "mcp.gcal", connectCard: true },
        }),
    );
    expect(message.output).toEqual({
      error: "SIGN_IN_REQUIRED",
      pluginId: "mcp.gcal",
      detail: "Google Calendar needs the person to sign in again.",
    });
    expect(message.isError).toBe(true);
    expect(states).toEqual(["rejected"]);
  });

  it("keeps today's text in a run nobody attends, still rejected", async () => {
    const { message, states } = await call(
      () =>
        new TaviError("NOT_AUTHORIZED", "mcp.gcal needs a login: it is not signed in", {
          details: { mcpFailure: "login", pluginId: "mcp.gcal" },
        }),
    );
    expect(message.output).toEqual({ error: "NOT_AUTHORIZED", detail: "mcp.gcal needs a login: it is not signed in", retryable: false });
    expect(states).toEqual(["rejected"]);
  });

  it("names a channel account's app and account for a Gmail mailbox tool's lapsed sign-in", async () => {
    const { message, states } = await call(
      () =>
        new TaviError("NOT_AUTHORIZED", "Gmail needs the person to sign in again.", {
          details: { signIn: true, appId: "gmail", accountId: "gmail-1", connectCard: true },
        }),
    );
    expect(message.output).toEqual({
      error: "SIGN_IN_REQUIRED",
      appId: "gmail",
      accountId: "gmail-1",
      detail: "Gmail needs the person to sign in again.",
    });
    expect(states).toEqual(["rejected"]);
  });

  it("asks for the Connect card for a read too, which has no effect to reject", async () => {
    const read: DeclaredToolDefinition = {
      id: "mcp.gcal.list_events",
      sink: "none",
      version: "1",
      description: "List",
      effect: "read-only",
      requiredPermissions: [],
    };
    const { message, states } = await call(
      () =>
        new TaviError("NOT_AUTHORIZED", "Google Calendar needs the person to sign in again.", {
          details: { mcpFailure: "login", pluginId: "mcp.gcal", connectCard: true },
        }),
      read,
    );
    expect(message.output).toEqual({
      error: "SIGN_IN_REQUIRED",
      pluginId: "mcp.gcal",
      detail: "Google Calendar needs the person to sign in again.",
    });
    expect(states).toEqual([]);
    // Unattended, it is the same failure as before.
    expect(
      (
        await call(
          () => new TaviError("NOT_AUTHORIZED", "mcp.gcal needs a login", { details: { mcpFailure: "login", pluginId: "mcp.gcal" } }),
          read,
        )
      ).message.output,
    ).toEqual({ error: "NOT_AUTHORIZED", detail: "mcp.gcal needs a login", retryable: false });
  });

  it("leaves another refusal as it was: failed, its outcome uncertain", async () => {
    const { message, states } = await call(() => new TaviError("NOT_AUTHORIZED", "mcp.gcal.create_event is not offered here"));
    expect(message.output).toEqual({ error: "NOT_AUTHORIZED", detail: "mcp.gcal.create_event is not offered here", retryable: false });
    expect(states).toEqual(["uncertain"]);
  });
});
