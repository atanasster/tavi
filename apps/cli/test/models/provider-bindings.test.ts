import { describe, expect, it } from "vitest";
import { fakeFetch } from "@tavi/test-support";
import type { ModelConnection, ModelMessage, ModelPort } from "@tavi/contracts";
import { createAiSdkModelAdapter } from "@tavi/agent-host/models";
import { builtinModelResolver, liveProviderConnection } from "../../src/features/models/provider-bindings.js";

const connection = {
  connectionId: "main",
  kind: "openai-compatible" as const,
  baseUrl: "https://models.example/v1",
  credentialRef: "account-one",
};
const context = { workspaceId: "a", principalId: "owner-a", runId: "run", caller: "test" };
const models: ModelPort = {
  stream: async (request) => ({ attemptId: request.attemptId, status: "completed", text: "", toolCalls: [], usage: {} }),
};

describe("builtin model binding", () => {
  it("checks account scope and binds a changed configuration anew, without a restart", async () => {
    let current: typeof connection | undefined = connection;
    const resolve = builtinModelResolver({
      models,
      implementationHash: "a".repeat(64),
      signal: new AbortController().signal,
      actsIn: (workspaceId: string, principalId: string) => principalId === (workspaceId === "a" ? "owner-a" : "owner-b"),
      current: async () => current,
      credentialRevision: async (reference) => `${reference}:1`,
    });
    const target = { connectionId: "main", model: "model" };
    const before = await resolve(target, context);
    await expect(resolve(target, { ...context, workspaceId: "b" })).rejects.toThrow(/another workspace or principal/);
    const other = await resolve(target, { ...context, workspaceId: "b", principalId: "owner-b" });
    expect(before.bindingHash).not.toBe(other.bindingHash);
    expect(before.binding.accountId).toBe("account-one");
    current = { ...connection, baseUrl: "https://changed.example" };
    await expect(before.validate?.()).rejects.toThrow(/changed/);
    const changed = await resolve(target, context);
    expect(changed.binding.endpoint).toBe("https://changed.example");
    expect(changed.bindingHash).not.toBe(before.bindingHash);
    expect(before.binding.endpoint).toBe("https://models.example/v1");
    current = undefined;
    await expect(resolve(target, context)).rejects.toThrow(/not active/);
  });
  it("changes the binding when the secret behind an unchanged reference is replaced", async () => {
    let secret = "first-key";
    const resolve = builtinModelResolver({
      models,
      implementationHash: "a".repeat(64),
      signal: new AbortController().signal,
      actsIn: (_workspaceId: string, principalId: string) => principalId === "owner-a",
      current: async () => connection,
      credentialRevision: async (reference) => `${reference}:${secret}`,
    });
    const target = { connectionId: "main", model: "model" };
    const before = await resolve(target, context);
    expect((await resolve(target, context)).bindingHash).toBe(before.bindingHash);
    secret = "rotated-key";
    await expect(before.validate?.()).rejects.toThrow(/changed/);
    const after = await resolve(target, context);
    expect(after.binding.accountId).toBe(before.binding.accountId);
    expect(after.bindingHash).not.toBe(before.bindingHash);
  });
  it("dispatches on the connection the binding was resolved from", async () => {
    let current = connection;
    const pinned: string[] = [];
    const resolve = builtinModelResolver({
      models,
      pin: (bound) => {
        pinned.push(bound.baseUrl);
        return models;
      },
      implementationHash: "a".repeat(64),
      signal: new AbortController().signal,
      actsIn: (_workspaceId: string, principalId: string) => principalId === "owner-a",
      current: async () => current,
      credentialRevision: async (reference) => `${reference}:1`,
    });
    const resolved = await resolve({ connectionId: "main", model: "model" }, context);
    current = { ...connection, baseUrl: "https://changed.example" };
    resolved.get();
    expect(pinned).toEqual(["https://models.example/v1"]);
  });
});

describe("a connection as configured now", () => {
  const stored: ModelConnection = {
    ...connection,
    label: "main",
    localOnly: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  it("prefers the store, keeping the launcher's headers only while it points where it did", async () => {
    let row: ModelConnection | undefined = { ...stored, headers: { "X-Stored": "s" } };
    const live = liveProviderConnection({
      launched: [{ ...connection, headers: { "OpenAI-Organization": "org" } }],
      storedAtStartup: new Set(["main"]),
      stored: async () => row,
    });
    expect(await live("main")).toEqual({ ...connection, headers: { "OpenAI-Organization": "org", "X-Stored": "s" } });
    row = { ...stored, baseUrl: "https://elsewhere.example/v1" };
    expect(await live("main")).toEqual({ ...connection, baseUrl: "https://elsewhere.example/v1" });
    // Held at startup and removed since: gone, launched copy or not.
    row = undefined;
    expect(await live("main")).toBeUndefined();
  });

  it("carries the models native video is on for to the transport", async () => {
    const live = liveProviderConnection({
      launched: [connection],
      storedAtStartup: new Set(["main"]),
      stored: async () => ({ ...stored, videoModels: ["qwen/qwen3-vl"] }),
    });
    expect((await live("main"))?.videoModels).toEqual(["qwen/qwen3-vl"]);
  });
  it("serves a launched connection the store never held, and no provider-managed one", async () => {
    const launched = { ...connection, connectionId: "flag" };
    const live = liveProviderConnection({
      launched: [launched],
      storedAtStartup: new Set(),
      stored: async (id) =>
        id === "managed"
          ? {
              ...stored,
              connectionId: "managed",
              providerBinding: { instanceId: "i", workspaceId: "a", principalId: "p", bindingHash: "h" },
            }
          : undefined,
    });
    expect(await live("flag")).toEqual(launched);
    expect(await live("managed")).toBeUndefined();
    expect(await live("missing")).toBeUndefined();
  });
  it("carries the stored PDF input and engine, so serve sends a viewed PDF as a file part through OpenRouter's parser", async () => {
    const row: ModelConnection = { ...stored, baseUrl: "https://openrouter.ai/api/v1", pdfInput: "openai-file", pdfEngine: "pdf-text" };
    const live = liveProviderConnection({ launched: [], storedAtStartup: new Set(["main"]), stored: async () => row });
    expect(await live("main")).toEqual({
      ...connection,
      baseUrl: "https://openrouter.ai/api/v1",
      pdfInput: "openai-file",
      pdfEngine: "pdf-text",
    });
    // As serve composes it: the adapter knows no connection but the live one.
    const bodies: string[] = [];
    const documents: string[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [],
      connection: live,
      readSecret: async () => "key",
      resolveDocument: (artifactId) => (
        documents.push(artifactId), { mediaType: "application/pdf", data: new Uint8Array([0x25, 0x50, 0x44, 0x46]) }
      ),
      fetch: fakeFetch(async (_url, init) => (bodies.push(String(init?.body)), new Response("{}", { status: 400 }))),
    });
    const messages: ModelMessage[] = [
      { id: "u", role: "user", text: "what does it say", createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a",
        role: "assistant",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolCalls: [{ id: "c1", name: "pdf.view", input: { source: { artifactId: "doc" } } }],
      },
      {
        id: "t",
        role: "tool",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolResults: [
          {
            toolCallId: "c1",
            toolName: "pdf.view",
            isError: false,
            output: { pages: [{ page: 1, text: "Invoice" }], taviDocument: { artifactId: "doc", mediaType: "application/pdf" } },
          },
        ],
      },
    ];
    await adapter.stream(
      { connectionId: "main", model: "deepseek-chat", runId: "run", attemptId: "attempt", attemptNumber: 1, messages, tools: [] },
      { signal: new AbortController().signal, onEvent: () => {} },
    );
    expect(documents).toEqual(["doc"]);
    expect(bodies.join("")).toContain('"file_data":"data:application/pdf;base64,JVBERg=="');
    expect(bodies.join("")).toContain('"plugins":[{"id":"file-parser","pdf":{"engine":"pdf-text"}}]');
  });
});
