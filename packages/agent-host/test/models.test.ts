import { describe, expect, it, vi } from "vitest";
import { fakeFetch } from "@tavi/test-support";
import { z } from "zod";

import { sse, textChunk } from "@tavi/test-support/openai-stub";

import type { ModelEvent, ModelMessage, ModelRequest } from "@tavi/contracts";
import { APICallError } from "@ai-sdk/provider";
import { StreamProviderError } from "ai";

import {
  assertModelSpecification,
  buildSdkTools,
  anthropicComputerToolKind,
  anthropicTakesEffort,
  createAiSdkModelAdapter,
  firstShownImage,
  modelReadsImages,
  openaiReasoningModel,
  readRetryAfterMs,
  streamDeadlinesOf,
  systemInstructions,
  toModelError,
  toSdkMessages,
  toUsage,
} from "@tavi/agent-host/models";
import { VideoSentinelError, withVideoParts } from "../src/models/openai-stream-compat.js";
import { withPromptCacheBreakpoints } from "../src/models/prompt-cache.js";

it("retains cache and reasoning subsets without inventing missing usage", () => {
  expect(toUsage({})).toEqual({});
  expect(
    toUsage({
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      inputTokenDetails: { noCacheTokens: 5, cacheReadTokens: 12, cacheWriteTokens: 3 },
      outputTokenDetails: { reasoningTokens: 7 },
    }),
  ).toEqual({
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
    inputNoCacheTokens: 5,
    inputCacheReadTokens: 12,
    inputCacheWriteTokens: 3,
    outputReasoningTokens: 7,
  });
});

it("leaves out a count the provider could not have meant, instead of failing the turn", () => {
  // Gemini through OpenRouter can report more cache reads than input tokens; the SDK's no-cache count goes negative.
  expect(toUsage({ inputTokens: 900, inputTokenDetails: { noCacheTokens: -1200, cacheReadTokens: 2100 } })).toEqual({
    inputTokens: 900,
    inputCacheReadTokens: 2100,
  });
  expect(toUsage({ inputTokens: 1.5, outputTokens: Number.NaN })).toEqual({});
});

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  connectionId: "fixture",
  model: "fixture-model",
  runId: "run-1",
  attemptId: "attempt-1",
  attemptNumber: 1,
  messages: [{ id: "m1", role: "user", text: "hi", createdAt: "2026-01-01T00:00:00.000Z" }],
  tools: [],
  ...overrides,
});

describe("a user message's parts and breakpoints (models.promptLayout v2)", () => {
  const at = "2026-01-01T00:00:00.000Z";

  it("sends a context block, the words and the step facts as three parts, the words' part marked", async () => {
    const [mapped] = await toSdkMessages([
      { id: "u", role: "user", text: "read my notes", contextText: "[context] …", trailer: "FACTS", cacheBreakpoint: true, createdAt: at },
    ]);
    expect(mapped).toEqual({
      role: "user",
      content: [
        { type: "text", text: "[context] …" },
        { type: "text", text: "read my notes", providerOptions: { openai: { promptCacheBreakpoint: {} } } },
        { type: "text", text: "FACTS" },
      ],
    });
  });

  it("marks an assistant's text and a tool message's last result, and nothing on the Responses wire", async () => {
    const messages: ModelMessage[] = [
      {
        id: "a",
        role: "assistant",
        text: "Looking.",
        toolCalls: [{ id: "c1", name: "notes.read", input: {} }],
        cacheBreakpoint: true,
        createdAt: at,
      },
      {
        id: "t",
        role: "tool",
        text: "",
        toolCallId: "c1",
        toolName: "notes.read",
        toolResults: [{ toolCallId: "c1", toolName: "notes.read", output: { notes: "x" }, isError: false }],
        cacheBreakpoint: true,
        createdAt: at,
      },
    ];
    const [assistant, tool] = await toSdkMessages(messages);
    expect(JSON.stringify(assistant)).toContain('"promptCacheBreakpoint":{}');
    expect(JSON.stringify(tool)).toContain('"promptCacheBreakpoint":{}');
    const unmarked = await toSdkMessages(messages, new Map(), undefined, undefined, undefined, false);
    expect(JSON.stringify(unmarked)).not.toContain("promptCacheBreakpoint");
  });

  it("sends a message without a block or facts as one part, as before", async () => {
    const [mapped] = await toSdkMessages([{ id: "u", role: "user", text: "hello", contextText: "", createdAt: at }]);
    expect(mapped).toEqual({ role: "user", content: [{ type: "text", text: "hello" }] });
  });
});

describe("a native Anthropic connection", () => {
  const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const reply = () =>
    new Response(
      event("message_start", {
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 },
        },
      }) +
        event("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }) +
        event("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Let me think." } }) +
        event("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig-abc" } }) +
        event("content_block_stop", { index: 0 }) +
        event("content_block_start", { index: 1, content_block: { type: "text", text: "" } }) +
        event("content_block_delta", { index: 1, delta: { type: "text_delta", text: "hello" } }) +
        event("content_block_stop", { index: 1 }) +
        event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) +
        event("message_stop", {}),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

  it("speaks the Messages API, marks a breakpoint, keeps the thinking with its signature and reports the cache", async () => {
    const sent: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [{ connectionId: "fixture", kind: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1", credentialRef: "k" }],
      readSecret: async () => "sk-test",
      fetch: fakeFetch(async (url, init) => {
        sent.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
        return reply();
      }),
    });
    const at = "2026-01-01T00:00:00.000Z";
    const outcome = await adapter.stream(
      request({
        model: "claude-opus-5-5",
        messages: [
          { id: "s", role: "system", text: "You are Tavi.", createdAt: at },
          { id: "u1", role: "user", text: "hi", createdAt: at },
          { id: "a1", role: "assistant", text: "Hello.", createdAt: at },
          { id: "u2", role: "user", text: "and again\n\nRuntime facts", createdAt: at },
        ],
      }),
      { signal: new AbortController().signal, onEvent: () => {} },
    );
    expect(sent[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent[0]?.headers.get("x-api-key")).toBe("sk-test");
    // The newest message the next call carries — the one before the trailing step note — holds the breakpoint.
    expect(JSON.stringify((sent[0]?.body["messages"] as unknown[])[1])).toContain('"cache_control":{"type":"ephemeral"}');
    expect(outcome.text).toBe("hello");
    expect(outcome.reasoning).toEqual([
      { text: "Let me think.", model: "claude-opus-5-5", providerMetadata: { anthropic: { signature: "sig-abc" } } },
    ]);
    expect(outcome.usage).toMatchObject({ inputCacheReadTokens: 800, inputCacheWriteTokens: 100, cacheUsageReported: true });

    // The step's thinking goes back with it on the next call, signature and all.
    await adapter.stream(
      request({
        model: "claude-opus-5-5",
        messages: [
          { id: "u1", role: "user", text: "hi", createdAt: at },
          { id: "a1", role: "assistant", text: "hello", reasoning: outcome.reasoning, createdAt: at },
          { id: "u2", role: "user", text: "more", createdAt: at },
        ],
      }),
      { signal: new AbortController().signal, onEvent: () => {}, site: "summarizer" },
    );
    const assistant = (sent[1]?.body["messages"] as { role: string; content: unknown[] }[]).find((message) => message.role === "assistant");
    expect(assistant?.content[0]).toEqual({ type: "thinking", thinking: "Let me think.", signature: "sig-abc" });
    // A summary's prompt no later call reads: no breakpoint is written.
    expect(JSON.stringify(sent[1]?.body)).not.toContain("cache_control");

    // Another model is not sent thinking it cannot check the signature of.
    await adapter.stream(
      request({
        model: "claude-sonnet-5-5",
        messages: [
          { id: "u1", role: "user", text: "hi", createdAt: at },
          { id: "a1", role: "assistant", text: "hello", reasoning: outcome.reasoning, createdAt: at },
          { id: "u2", role: "user", text: "more", createdAt: at },
        ],
      }),
      { signal: new AbortController().signal, onEvent: () => {} },
    );
    expect(JSON.stringify(sent[2]?.body)).not.toContain("thinking");
  });

  it("keeps an hour-long prefix on the tools and system text when the call asks for one", async () => {
    const sent: Record<string, unknown>[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [{ connectionId: "fixture", kind: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1", credentialRef: "k" }],
      readSecret: async () => "sk-test",
      fetch: fakeFetch(async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return reply();
      }),
    });
    const at = "2026-01-01T00:00:00.000Z";
    await adapter.stream(
      request({
        model: "claude-opus-5-5",
        messages: [
          { id: "s", role: "system", text: "You are Tavi.", createdAt: at },
          { id: "u1", role: "user", text: "check", createdAt: at },
        ],
        tools: [{ id: "fs.read", name: "fs_read", description: "Read a file.", inputJsonSchema: { type: "object", properties: {} } }],
      }),
      { signal: new AbortController().signal, onEvent: () => {}, cacheTtl: "1h" },
    );
    const body = sent[0] as { system: { cache_control?: unknown }[]; tools: { cache_control?: unknown }[] };
    expect(body.system.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body.tools.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("keeps no thinking on an OpenAI-compatible connection", async () => {
    const adapter = createAiSdkModelAdapter({
      connections: [{ connectionId: "fixture", kind: "openai-compatible", baseUrl: "https://example.test/v1", credentialRef: "k" }],
      readSecret: async () => "k",
      fetch: fakeFetch(
        async () =>
          new Response(sse([textChunk("hi", null), textChunk("", "stop")]), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    });
    const outcome = await adapter.stream(request(), { signal: new AbortController().signal, onEvent: () => {} });
    expect(outcome.reasoning).toBeUndefined();
  });
});

describe("reasoning effort by preset", () => {
  const streamed = () =>
    new Response(sse([textChunk("hi", null), textChunk("", "stop")]), { status: 200, headers: { "content-type": "text/event-stream" } });
  const bodyOf = async (baseUrl: string, model: string, extra: Record<string, unknown> = {}) => {
    const bodies: Record<string, unknown>[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [{ connectionId: "fixture", kind: "openai-compatible", baseUrl, credentialRef: "fixture.apiKey", ...extra }],
      readSecret: async () => "k",
      fetch: fakeFetch(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return streamed();
      }),
    });
    await adapter
      .stream(request({ model, reasoningEffort: "low" }), { signal: new AbortController().signal, onEvent: () => {} })
      .catch(() => undefined);
    return bodies[0] ?? {};
  };

  it("sends OpenAI's reasoning_effort to a reasoning model only, OpenRouter's reasoning.effort to an OpenAI reasoning model there only, and nothing elsewhere", async () => {
    expect((await bodyOf("https://api.openai.com/v1", "gpt-5.5"))["reasoning_effort"]).toBe("low");
    expect(await bodyOf("https://api.openai.com/v1", "gpt-4o")).not.toHaveProperty("reasoning_effort");
    expect((await bodyOf("https://openrouter.ai/api/v1", "openai/gpt-5.5"))["reasoning"]).toEqual({ effort: "low" });
    // Claude through OpenRouter: a reasoning object would turn its extended thinking on.
    expect(await bodyOf("https://openrouter.ai/api/v1", "anthropic/claude-sonnet-5-5")).not.toHaveProperty("reasoning");
    // Sign in with ChatGPT's Responses wire shares OpenAI's base URL and takes no effort.
    expect(JSON.stringify(await bodyOf("https://api.openai.com/v1", "gpt-5.5", { wireApi: "responses" }))).not.toContain('"effort"');
    const local = await bodyOf("http://127.0.0.1:11434/v1", "llama3");
    expect(local).not.toHaveProperty("reasoning_effort");
    expect(local).not.toHaveProperty("reasoning");
  });

  it("passes toolChoice with offered tools, and never without them", async () => {
    const bodies: Record<string, unknown>[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [{ connectionId: "fixture", kind: "openai-compatible", baseUrl: "https://example.test/v1", credentialRef: "k" }],
      readSecret: async () => "k",
      fetch: fakeFetch(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return streamed();
      }),
    });
    const tool = { id: "fs.read", name: "fs_read", description: "Read a file.", inputJsonSchema: { type: "object", properties: {} } };
    await adapter.stream(request({ tools: [tool], toolChoice: "none" }), { signal: new AbortController().signal, onEvent: () => {} });
    await adapter.stream(request({ toolChoice: "none" }), { signal: new AbortController().signal, onEvent: () => {} });
    expect(bodies[0]?.["tool_choice"]).toBe("none");
    expect(bodies[1]).not.toHaveProperty("tool_choice");
  });

  it("asks native Anthropic for the effort through output_config, only of a model that takes it", async () => {
    const sent: Record<string, unknown>[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [{ connectionId: "fixture", kind: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1", credentialRef: "k" }],
      readSecret: async () => "sk-test",
      fetch: fakeFetch(async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response("{}", { status: 400 });
      }),
    });
    await adapter
      .stream(request({ model: "claude-opus-5-5", reasoningEffort: "low" }), { signal: new AbortController().signal, onEvent: () => {} })
      .catch(() => undefined);
    await adapter
      .stream(request({ model: "claude-haiku-4-5", reasoningEffort: "low" }), { signal: new AbortController().signal, onEvent: () => {} })
      .catch(() => undefined);
    expect(sent[0]?.["output_config"]).toMatchObject({ effort: "low" });
    expect(JSON.stringify(sent.at(-1))).not.toContain('"effort"');
    expect(
      ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-4-8", "claude-sonnet-4-6"].map(anthropicTakesEffort),
    ).toEqual([true, true, true, true, true]);
    expect(["claude-haiku-4-5", "claude-sonnet-4-5", "gpt-5.5"].map(anthropicTakesEffort)).toEqual([false, false, false]);
    // A date after the version is no minor.
    expect(["claude-opus-4-8-20260115", "claude-opus-4-20250514"].map(anthropicTakesEffort)).toEqual([true, false]);
    // The computer tool each Claude takes: 5.5 and later the toolset; Opus 4.5–4.8, Sonnet 4.6, Opus and Sonnet 5 the
    // 2025-11 tool; Sonnet and Haiku 4.5 and older the 2025-01 one.
    for (const [model, kind] of [
      ["claude-opus-5-5", "toolset_20260801"],
      ["claude-sonnet-5-5-20261001", "toolset_20260801"],
      ["claude-opus-5", "computer_20251124"],
      ["claude-opus-5-20260301", "computer_20251124"],
      ["claude-sonnet-5", "computer_20251124"],
      ["claude-opus-4-8", "computer_20251124"],
      ["claude-opus-4-5-20251101", "computer_20251124"],
      ["claude-sonnet-4-6", "computer_20251124"],
      ["claude-sonnet-4-5", "computer_20250124"],
      ["claude-sonnet-4-5-20250929", "computer_20250124"],
      ["claude-haiku-4-5", "computer_20250124"],
      ["claude-sonnet-4-20250514", "computer_20250124"],
    ] as const) {
      expect(anthropicComputerToolKind(model), model).toBe(kind);
    }
  });

  it("judges a reasoning model as the SDK does", () => {
    expect(["o3", "o4-mini", "gpt-5", "gpt-5.5", "gpt-5.1-chat", "gpt-6-mini"].map(openaiReasoningModel)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(["gpt-4o", "gpt-5-chat-latest", "gpt-4.1", "llama3"].map(openaiReasoningModel)).toEqual([false, false, false, false]);
  });
});

describe("prompt-cache routing by preset", () => {
  const streamed = () =>
    new Response(sse([textChunk("hi", null), textChunk("", "stop")]), { status: 200, headers: { "content-type": "text/event-stream" } });
  const adapterOn = (baseUrl: string, bodies: Record<string, unknown>[]) =>
    createAiSdkModelAdapter({
      connections: [{ connectionId: "fixture", kind: "openai-compatible", baseUrl, credentialRef: "fixture.apiKey" }],
      readSecret: async () => "k",
      fetch: fakeFetch(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return streamed();
      }),
    });

  it("asks OpenAI to keep an hour-long caller's prefix 30 minutes, on GPT-5.6 and later only", async () => {
    const bodies: Record<string, unknown>[] = [];
    const adapter = adapterOn("https://api.openai.com/v1", bodies);
    await adapter.stream(request({ model: "gpt-5.6" }), { signal: new AbortController().signal, onEvent: () => {}, cacheTtl: "1h" });
    await adapter.stream(request({ model: "gpt-5.5" }), { signal: new AbortController().signal, onEvent: () => {}, cacheTtl: "1h" });
    await adapter.stream(request({ model: "gpt-5.6" }), { signal: new AbortController().signal, onEvent: () => {} });
    expect(bodies[0]?.["prompt_cache_options"]).toEqual({ ttl: "30m" });
    expect(bodies[1]).not.toHaveProperty("prompt_cache_options");
    expect(bodies[2]).not.toHaveProperty("prompt_cache_options");
  });

  it("marks a routine evaluation's system prompt, which its calls send again and again, and not a summary's", async () => {
    const at = "2026-01-01T00:00:00.000Z";
    const sentFor = async (site: "evaluation" | "summarizer") => {
      const bodies: Record<string, unknown>[] = [];
      await adapterOn("https://openrouter.ai/api/v1", bodies).stream(
        request({
          model: "anthropic/claude-sonnet-5-5",
          messages: [
            { id: "s", role: "system", text: "Evaluate the role.", createdAt: at },
            { id: "u", role: "user", text: "fixture 1", createdAt: at },
          ],
        }),
        { signal: new AbortController().signal, onEvent: () => {}, site },
      );
      return JSON.stringify(bodies[0]);
    };
    expect(await sentFor("evaluation")).toContain("cache_control");
    expect(await sentFor("summarizer")).not.toContain("cache_control");
  });

  it("sends OpenAI a prompt_cache_key from the run, sharded past 15 calls a minute, and none for an uncached site", async () => {
    const bodies: Record<string, unknown>[] = [];
    const adapter = adapterOn("https://api.openai.com/v1", bodies);
    for (let call = 0; call < 16; call += 1)
      await adapter.stream(request({ attemptId: `a-${call}` }), { signal: new AbortController().signal, onEvent: () => {} });
    expect(bodies[0]?.["prompt_cache_key"]).toMatch(/^tavi-[0-9a-f]{24}$/);
    expect(bodies[14]?.["prompt_cache_key"]).toBe(bodies[0]?.["prompt_cache_key"]);
    expect(bodies[15]?.["prompt_cache_key"]).toBe(`${String(bodies[0]?.["prompt_cache_key"])}-1`);
    await adapter.stream(request(), { signal: new AbortController().signal, onEvent: () => {}, site: "summarizer" });
    expect(bodies.at(-1)).not.toHaveProperty("prompt_cache_key");
  });

  it("sends the caller's cache key instead of the run when it gives one, and merges the key into the Responses wire's options", async () => {
    const keyed: Record<string, unknown>[] = [];
    const adapter = adapterOn("https://api.openai.com/v1", keyed);
    await adapter.stream(request({ runId: "tick-1" }), {
      signal: new AbortController().signal,
      onEvent: () => {},
      cacheKey: "heartbeat:p",
    });
    await adapter.stream(request({ runId: "tick-2" }), {
      signal: new AbortController().signal,
      onEvent: () => {},
      cacheKey: "heartbeat:p",
    });
    expect(keyed[1]?.["prompt_cache_key"]).toBe(keyed[0]?.["prompt_cache_key"]);
    const responses: Record<string, unknown>[] = [];
    await createAiSdkModelAdapter({
      connections: [
        {
          connectionId: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://api.openai.com/v1",
          credentialRef: "k",
          wireApi: "responses",
        },
      ],
      readSecret: async () => "k",
      fetch: fakeFetch(async (_url, init) => {
        responses.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response("", { status: 500 });
      }),
    }).stream(request(), { signal: new AbortController().signal, onEvent: () => {} });
    expect(responses[0]).toMatchObject({ store: false, prompt_cache_key: expect.stringMatching(/^tavi-[0-9a-f]{24}$/) });
  });

  it("sends OpenRouter the run as its session id, and an unknown endpoint neither field", async () => {
    const routed: Record<string, unknown>[] = [];
    await adapterOn("https://openrouter.ai/api/v1", routed).stream(request(), { signal: new AbortController().signal, onEvent: () => {} });
    // A digest of the run: it ties the chat's calls together and says nothing else.
    expect(routed[0]?.["session_id"]).toMatch(/^tavi-[0-9a-f]{24}$/);
    expect(routed[0]).not.toHaveProperty("prompt_cache_key");
    const local: Record<string, unknown>[] = [];
    await adapterOn("http://localhost:11434/v1", local).stream(request(), { signal: new AbortController().signal, onEvent: () => {} });
    expect(local[0]).not.toHaveProperty("session_id");
    expect(local[0]).not.toHaveProperty("prompt_cache_key");
  });
});

describe("what the transport saw, in a call's usage", () => {
  it("adds the prefix hash sent and whether the provider reported its cache to the completed call's usage", async () => {
    const adapter = createAiSdkModelAdapter({
      connections: [
        { connectionId: "fixture", kind: "openai-compatible", baseUrl: "https://example.invalid/v1", credentialRef: "fixture.apiKey" },
      ],
      readSecret: async () => "k",
      fetch: fakeFetch(
        async () =>
          new Response(
            sse([
              textChunk("hello", null),
              // The stub's usage type has no cache details, so the final chunk carries them itself.
              {
                ...(textChunk("", "stop") as Record<string, unknown>),
                usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13, prompt_tokens_details: { cached_tokens: 8 } },
              },
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      ),
    });
    const outcome = await adapter.stream(
      request({
        messages: [
          { id: "s", role: "system", text: "You are Tavi.", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "m1", role: "user", text: "hi", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      }),
      { signal: new AbortController().signal, onEvent: () => {} },
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.usage.wirePrefixHash).toMatch(/^[0-9a-f]{16}$/);
    expect(outcome.usage.cacheUsageReported).toBe(true);
    expect(outcome.usage.inputCacheReadTokens).toBe(8);
  });
});

describe("toModelError scrubbing", () => {
  it("redacts a credential the provider echoed back", async () => {
    // The fix pipes the provider message through `scrubCredentialText`, and no
    // test drove it: reverting `models.ts` to the raw message left the suite green.
    const { toModelError } = await import("../src/models/models.js");
    const error = toModelError(new Error("401 from provider: Authorization: Bearer sk-live-abcdef123456 rejected"));
    const text = error.message;
    expect(text).not.toContain("sk-live-abcdef123456");
    expect(text).toContain("[redacted]");
  });
});

describe("AI SDK message mapping", () => {
  it("lifts system messages out of the message list", async () => {
    // AI SDK 7 rejects a `system` role inside `messages`; the text must be
    // delivered through the `system` option, and the list must not contain it.
    const messages: ModelMessage[] = [
      { id: "s", role: "system", text: "be brief", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "u", role: "user", text: "hello", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(systemInstructions(messages)).toBe("be brief");
    const mapped = await toSdkMessages(messages);
    expect(mapped).toHaveLength(1);
    for (const message of mapped) expect(message.role).not.toBe("system");
  });

  it("joins several system messages in order", () => {
    expect(
      systemInstructions([
        { id: "s1", role: "system", text: "first", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "s2", role: "system", text: "  ", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "s3", role: "system", text: "second", createdAt: "2026-01-01T00:00:00.000Z" },
      ]),
    ).toBe("first\n\nsecond");
  });

  it("reports no instructions when there is no system message", () => {
    expect(systemInstructions(request().messages)).toBe("");
  });

  it("carries assistant tool-call identity into the SDK transcript", async () => {
    const [mapped] = await toSdkMessages([
      {
        id: "a",
        role: "assistant",
        text: "",
        toolCalls: [{ id: "call-1", name: "fixture.echo", input: { message: "hi" } }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(mapped).toMatchObject({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call-1", toolName: "fixture.echo", input: { message: "hi" } }],
    });
  });

  it("keeps text alongside a tool call when both are present", async () => {
    const [mapped] = await toSdkMessages([
      {
        id: "a",
        role: "assistant",
        text: "thinking",
        toolCalls: [{ id: "call-1", name: "fixture.echo", input: {} }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(mapped).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "thinking" },
        { type: "tool-call", toolCallId: "call-1" },
      ],
    });
  });

  it("maps a user message to a text content part", async () => {
    const [mapped] = await toSdkMessages([{ id: "u", role: "user", text: "hello", createdAt: "2026-01-01T00:00:00.000Z" }]);
    expect(mapped).toEqual({ role: "user", content: [{ type: "text", text: "hello" }] });
  });

  it("maps a tool result to a provider tool-result part", async () => {
    const [mapped] = await toSdkMessages([
      {
        id: "t",
        role: "tool",
        text: "",
        toolCallId: "call-1",
        toolName: "fixture.echo",
        toolResults: [{ toolCallId: "call-1", toolName: "fixture.echo", output: { echoed: "hi" }, isError: false }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(mapped).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "fixture.echo",
        },
      ],
    });
  });

  it("keeps an error result distinguishable from a successful one", async () => {
    const [ok] = await toSdkMessages([
      {
        id: "t1",
        role: "tool",
        text: "",
        toolCallId: "c1",
        toolName: "fixture.echo",
        toolResults: [{ toolCallId: "c1", toolName: "fixture.echo", output: { a: 1 }, isError: false }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const [failed] = await toSdkMessages([
      {
        id: "t2",
        role: "tool",
        text: "",
        toolCallId: "c2",
        toolName: "fixture.echo",
        toolResults: [{ toolCallId: "c2", toolName: "fixture.echo", output: { error: "x" }, isError: true }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(ok).not.toEqual(failed);
  });

  it("does not leak an SDK-only field into the mapped messages", async () => {
    const mapped = await toSdkMessages(request().messages);
    expect(JSON.stringify(mapped)).not.toContain("privateState");
  });
});

describe("AI SDK tool derivation", () => {
  it("adds a native computer tool only on a connection that speaks its vendor's wire", () => {
    const asking = request({ nativeComputer: { vendor: "anthropic", displayWidth: 1280, displayHeight: 720 } });
    expect(Object.keys(buildSdkTools(asking))).toEqual([]);
    expect(Object.keys(buildSdkTools(asking, undefined, { native: true }))).toEqual(["computer"]);
    const openai = request({ nativeComputer: { vendor: "openai", displayWidth: 1280, displayHeight: 720 } });
    expect(Object.keys(buildSdkTools(openai))).toEqual([]);
  });

  it("derives a model-facing tool from the canonical JSON Schema", () => {
    const tools = buildSdkTools(
      request({
        tools: [
          {
            id: "fixture.echo",
            name: "fixture_echo",
            description: "Echo",
            inputJsonSchema: z.toJSONSchema(z.object({ message: z.string() }), { io: "input" }),
          },
        ],
      }),
    );
    // The SDK tool is keyed by the provider-safe name, not the canonical id.
    expect(Object.keys(tools)).toEqual(["fixture_echo"]);
    expect(tools["fixture_echo"]).toMatchObject({ description: "Echo" });
  });

  it("returns an empty tool set for a request without tools", () => {
    expect(Object.keys(buildSdkTools(request()))).toEqual([]);
  });
});

describe("transport error mapping", () => {
  it("reads how many output tokens a key can afford, and drops the key's settings link from the message", () => {
    const error = toModelError(
      Object.assign(
        new Error(
          "This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 61510. To increase, visit https://openrouter.ai/workspaces/default/keys/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef and adjust the key's total limit",
        ),
        { statusCode: 402 },
      ),
    );
    expect(error).toMatchObject({ code: "quota_exceeded", affordableTokens: 61_510 });
    expect(error.message).not.toContain("0123456789abcdef");
    expect(error.message).toContain("[the key's settings page]");
  });

  it("marks a refusal for length as a context overflow, and nothing else", () => {
    expect(
      toModelError(Object.assign(new Error("This model's maximum context length is 128000 tokens"), { statusCode: 400 })),
    ).toMatchObject({ code: "invalid_request", contextOverflow: true });
    expect(toModelError(Object.assign(new Error("prompt is too long: 210000 tokens > 200000 maximum"), { statusCode: 413 }))).toMatchObject(
      { code: "invalid_request", contextOverflow: true },
    );
    expect(toModelError(Object.assign(new Error("bad request"), { statusCode: 400 })).contextOverflow).toBeUndefined();
  });

  it("classifies authentication, rate limit and server failures", () => {
    expect(toModelError(Object.assign(new Error("nope"), { statusCode: 401 }))).toMatchObject({
      code: "auth",
      retryable: false,
    });
    expect(toModelError(Object.assign(new Error("slow down"), { statusCode: 429 }))).toMatchObject({
      code: "rate_limit",
      retryable: true,
    });
    expect(toModelError(Object.assign(new Error("bad request"), { statusCode: 400 }))).toMatchObject({
      code: "invalid_request",
      retryable: false,
    });
    expect(toModelError(Object.assign(new Error("upstream"), { statusCode: 503 }))).toMatchObject({
      code: "provider",
      retryable: true,
    });
  });

  it("separates billing exhaustion from a retryable rate limit", () => {
    // A 429 is not one condition. Retrying an out-of-credit account burns the
    // shared attempt budget for a request that cannot succeed.
    const quota = Object.assign(new Error("You have no credits remaining."), {
      statusCode: 429,
      data: { type: "insufficient_quota", code: "credit_balance_exhausted" },
    });
    expect(toModelError(quota)).toMatchObject({ code: "quota_exceeded", retryable: false });

    const byCodeOnly = Object.assign(new Error("out of credit"), {
      statusCode: 429,
      code: "credit_balance_exhausted",
    });
    expect(toModelError(byCodeOnly)).toMatchObject({ code: "quota_exceeded", retryable: false });

    const byMessageOnly = Object.assign(new Error("You exceeded your current quota"), { statusCode: 429 });
    expect(toModelError(byMessageOnly)).toMatchObject({ code: "quota_exceeded", retryable: false });

    const rateLimited = Object.assign(new Error("Rate limit reached for gpt-4.1-mini"), { statusCode: 429 });
    expect(toModelError(rateLimited)).toMatchObject({ code: "rate_limit", retryable: true });
  });

  it("classifies OpenRouter's key and credit limits as billing, not auth", () => {
    const keyLimit = Object.assign(new Error("Key limit exceeded (total limit). Manage it using https://openrouter.ai/"), {
      statusCode: 403,
    });
    expect(toModelError(keyLimit)).toMatchObject({ code: "quota_exceeded", retryable: false });
    const noCredit = Object.assign(new Error("Insufficient credits"), { statusCode: 402 });
    expect(toModelError(noCredit)).toMatchObject({ code: "quota_exceeded", retryable: false });
    // The message alone marks billing on a 429, where a 402 needs no message.
    const creditsOn429 = Object.assign(new Error("Insufficient credits"), { statusCode: 429 });
    expect(toModelError(creditsOn429)).toMatchObject({ code: "quota_exceeded", retryable: false });
    const forbidden = Object.assign(new Error("Forbidden"), { statusCode: 403 });
    expect(toModelError(forbidden)).toMatchObject({ code: "auth", retryable: false });
  });

  it("does not classify a plain rate limit as a quota failure", () => {
    const throttled = Object.assign(new Error("Too many requests, please slow down"), { statusCode: 429 });
    expect(toModelError(throttled).code).toBe("rate_limit");
  });

  it("reads a nested 429 cause chain for the quota signal", () => {
    const nested = new Error("wrapped", {
      cause: Object.assign(new Error("no credits remaining"), { statusCode: 429 }),
    });
    expect(toModelError(nested)).toMatchObject({ code: "rate_limit", retryable: true });
    const nestedQuota = new Error("wrapped", {
      cause: Object.assign(new Error("billing issue"), {
        statusCode: 429,
        data: { type: "insufficient_quota" },
      }),
    });
    expect(toModelError(nestedQuota)).toMatchObject({ code: "quota_exceeded", retryable: false });
  });

  it("classifies an abort as non-retryable", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(toModelError(abort)).toMatchObject({ code: "aborted", retryable: false });
  });

  it("leaves an unrecognized failure as unknown rather than guessing retryability", () => {
    expect(toModelError(new Error("mystery"))).toMatchObject({ code: "unknown", retryable: false });
  });
});

describe("adapter preconditions", () => {
  const events = (): { readonly received: ModelEvent[]; readonly onEvent: (event: ModelEvent) => void } => {
    const received: ModelEvent[] = [];
    return { received, onEvent: (event) => received.push(event) };
  };

  it("reports a missing connection without calling it retirement", async () => {
    const adapter = createAiSdkModelAdapter({ connections: [], readSecret: async () => "k" });
    const sink = events();
    const outcome = await adapter.stream(request({ connectionId: "missing" }), {
      signal: new AbortController().signal,
      onEvent: sink.onEvent,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("model_unavailable");
    expect(sink.received).toEqual([]);
  });

  it("reads a connection at each call when given a lookup, sending to where it points now", async () => {
    const urls: string[] = [];
    let current: { connectionId: string; kind: "openai-compatible"; baseUrl: string; credentialRef: string } | undefined = {
      connectionId: "fixture",
      kind: "openai-compatible",
      baseUrl: "https://first.invalid/v1",
      credentialRef: "fixture.apiKey",
    };
    const adapter = createAiSdkModelAdapter({
      connections: [],
      connection: async () => current,
      readSecret: async () => "k",
      fetch: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response("", { status: 500 });
      }) as typeof fetch,
    });
    const call = () => adapter.stream(request(), { signal: new AbortController().signal, onEvent: () => {} });
    await call();
    current = { ...current, baseUrl: "https://second.invalid/v1" };
    await call();
    expect(urls.map((url) => new URL(url).host)).toEqual(expect.arrayContaining(["first.invalid", "second.invalid"]));
    current = undefined;
    expect((await call()).error?.code).toBe("model_unavailable");
    // Pinned, a call goes where its binding was resolved, whatever is configured now.
    current = { connectionId: "fixture", kind: "openai-compatible", baseUrl: "https://now.invalid/v1", credentialRef: "fixture.apiKey" };
    urls.length = 0;
    await adapter
      .pinned({ ...current, baseUrl: "https://bound.invalid/v1" })
      .stream(request(), { signal: new AbortController().signal, onEvent: () => {} });
    expect(urls.map((url) => new URL(url).host)).toContain("bound.invalid");
    expect(urls.map((url) => new URL(url).host)).not.toContain("now.invalid");
    expect(
      (
        await adapter
          .pinned({ ...current, connectionId: "other" })
          .stream(request(), { signal: new AbortController().signal, onEvent: () => {} })
      ).error?.code,
    ).toBe("model_unavailable");
  });

  it("fails with a typed missing-configuration error when the credential is absent", async () => {
    const adapter = createAiSdkModelAdapter({
      connections: [
        {
          connectionId: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://example.invalid/v1",
          credentialRef: "fixture.apiKey",
        },
      ],
      readSecret: async () => null,
    });
    const outcome = await adapter.stream(request(), {
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(outcome.status).toBe("failed");
    // Missing configuration is a local defect reported before any request, not a
    // provider authentication failure.
    expect(outcome.error?.code).toBe("invalid_request");
    expect(outcome.error?.message).toContain("fixture.apiKey");
    // The fix a person can make whatever ran the call: store it again.
    expect(outcome.error?.message).toContain("store it with `tavi credentials set fixture.apiKey --file <path>`");
  });

  it("treats an empty credential as unconfigured rather than trying it", async () => {
    let fetched = false;
    const adapter = createAiSdkModelAdapter({
      connections: [
        {
          connectionId: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
          credentialRef: "fixture.apiKey",
        },
      ],
      readSecret: async () => "   ",
      fetch: fakeFetch(async () => {
        fetched = true;
        return new Response("", { status: 200 });
      }),
    });
    const outcome = await adapter.stream(request(), {
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("invalid_request");
    expect(fetched).toBe(false);
  });

  it("never reports a failed generation as a successful empty completion", async () => {
    const adapter = createAiSdkModelAdapter({
      connections: [
        {
          connectionId: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://example.invalid/v1",
          credentialRef: "fixture.apiKey",
        },
      ],
      readSecret: async () => "key",
      // The transport failure a real DNS miss produces, without waiting on the
      // host's resolver (seconds on some machines) for `example.invalid`.
      fetch: async (): Promise<Response> => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo ENOTFOUND example.invalid"), { code: "ENOTFOUND" }),
        });
      },
    });
    const outcome = await adapter.stream(request(), {
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(outcome.status).not.toBe("completed");
    expect(outcome.text).toBe("");
    expect(outcome.error).toBeDefined();
  });
});

describe("streaming against a synthetic OpenAI-compatible endpoint", () => {
  const toolCallStream = (): string =>
    sse([
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture-model",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "fixture.echo", arguments: '{"message":"hi"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture-model",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      },
    ]);

  const textStream = (): string =>
    sse([
      {
        id: "chatcmpl-2",
        object: "chat.completion.chunk",
        created: 2,
        model: "fixture-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-2",
        object: "chat.completion.chunk",
        created: 2,
        model: "fixture-model",
        choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-2",
        object: "chat.completion.chunk",
        created: 2,
        model: "fixture-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      },
    ]);

  function adapterWith(body: () => string): ReturnType<typeof createAiSdkModelAdapter> {
    return createAiSdkModelAdapter({
      connections: [
        {
          connectionId: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
          credentialRef: "fixture.apiKey",
        },
      ],
      readSecret: async () => "test-key",
      fetch: fakeFetch(
        async () =>
          new Response(body(), {
            status: 200,
            headers: { "content-type": "text/event-stream", "x-request-id": "req-1" },
          }),
      ),
    });
  }

  it("streams text deltas and reports a terminal completed outcome", async () => {
    const received: ModelEvent[] = [];
    const outcome = await adapterWith(textStream).stream(request(), {
      signal: new AbortController().signal,
      onEvent: (event) => received.push(event),
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.text).toBe("Hello");
    expect(outcome.usage).toMatchObject({ inputTokens: 4, outputTokens: 2 });
    const deltas = received.filter((event) => event.type === "text.delta");
    expect(deltas.map((event) => (event.type === "text.delta" ? event.text : "")).join("")).toBe("Hello");
    for (const event of received) expect(event.attemptId).toBe("attempt-1");
  });

  it("reports a complete tool call without executing it", async () => {
    const received: ModelEvent[] = [];
    const outcome = await adapterWith(toolCallStream).stream(
      request({
        tools: [
          {
            id: "fixture.echo",
            name: "fixture_echo",
            description: "Echo",
            inputJsonSchema: z.toJSONSchema(z.object({ message: z.string() }), { io: "input" }),
          },
        ],
      }),
      { signal: new AbortController().signal, onEvent: (event) => received.push(event) },
    );

    expect(outcome.status).toBe("completed");
    expect(outcome.toolCalls).toEqual([{ id: "call-1", name: "fixture.echo", input: { message: "hi" } }]);
    expect(received.some((event) => event.type === "tool.completed")).toBe(true);
    // The transport never dispatches: that is Tavi's governed dispatcher's job.
    expect(outcome.toolCalls).toHaveLength(1);
  });

  it("reports a provider error response as a typed failure", async () => {
    const adapter = createAiSdkModelAdapter({
      connections: [
        {
          connectionId: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
          credentialRef: "fixture.apiKey",
        },
      ],
      readSecret: async () => "test-key",
      fetch: fakeFetch(
        async () =>
          new Response(JSON.stringify({ error: { message: "bad key" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ),
    });

    const outcome = await adapter.stream(request(), {
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("auth");
  });

  it("aborts an in-flight generation when the signal fires", async () => {
    const controller = new AbortController();
    const adapter = createAiSdkModelAdapter({
      connections: [
        {
          connectionId: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
          credentialRef: "fixture.apiKey",
        },
      ],
      readSecret: async () => "test-key",
      fetch: fakeFetch(async (_url, init) => {
        controller.abort();
        void init;
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }),
    });

    const outcome = await adapter.stream(request(), {
      signal: controller.signal,
      onEvent: () => {},
    });
    expect(outcome.status).toBe("aborted");
    expect(outcome.error?.code).toBe("aborted");
  });
});

describe("message DTO round trip", () => {
  it("keeps an ordinary user message intact", async () => {
    const messages: ModelMessage[] = [
      { id: "a", role: "user", text: "one", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", role: "assistant", text: "two", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    const mapped = await toSdkMessages(messages);
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({ role: "user" });
    expect(mapped[1]).toMatchObject({ role: "assistant" });
  });
});

describe("system instructions on the wire", () => {
  const stopStream = (): string =>
    sse([
      {
        id: "c",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
      },
      {
        id: "c",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]);

  /**
   * The regression guard for the fix's *plumbing*.
   *
   * The shim that echoes a provider's `thought_signature` back holds captured
   * signatures in memory, so it only works if the adapter builds the transport
   * where that memory can survive between turns. Every other test in this file
   * passes with the transport created per request — the tool-call round trip it
   * would break spans two `stream()` calls, which is exactly what this drives.
   */
  it("round-trips a provider tool-call signature across two turns, which only works if the transport outlives one request", async () => {
    const bodies: { messages?: { role: string; tool_calls?: { id: string; extra_content?: unknown }[] }[] }[] = [];
    const toolCallSignature = "sig-abc";
    const streamWithSignature = sse([
      {
        id: "c",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture-model",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "fixture_echo", arguments: '{"message":"hi"}' },
                  extra_content: { google: { thought_signature: toolCallSignature } },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "c",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture-model",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ]);
    const adapter = createAiSdkModelAdapter({
      connections: [
        { connectionId: "fixture", kind: "openai-compatible", baseUrl: "https://fixture.invalid/v1", credentialRef: "fixture.apiKey" },
      ],
      readSecret: async () => "test-key",
      fetch: fakeFetch(async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as (typeof bodies)[number];
        bodies.push(body);
        const isFirstTurn = !JSON.stringify(body.messages ?? []).includes("tool_calls");
        return new Response(isFirstTurn ? streamWithSignature : stopStream(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    });

    // Turn 1: the provider streams a tool call carrying its signature.
    await adapter.stream(request({ messages: [{ id: "u", role: "user", text: "hi", createdAt: "2026-01-01T00:00:00.000Z" }] }), {
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    // Turn 2: the transcript now contains the assistant's tool call, and the
    // signature must travel back with it or the provider rejects the request.
    await adapter.stream(
      request({
        messages: [
          { id: "u", role: "user", text: "hi", createdAt: "2026-01-01T00:00:00.000Z" },
          {
            id: "a",
            role: "assistant",
            text: "",
            createdAt: "2026-01-01T00:00:00.000Z",
            toolCalls: [{ id: "call_1", name: "fixture_echo", input: { message: "hi" } }],
          },
          // The provider rejects an assistant tool call with no matching result,
          // so the transcript carries one — the same shape a real second turn has.
          {
            id: "t",
            role: "tool",
            text: "",
            toolCallId: "call_1",
            toolName: "fixture.echo",
            toolResults: [{ toolCallId: "call_1", toolName: "fixture.echo", output: { echoed: "hi" }, isError: false }],
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      { signal: new AbortController().signal, onEvent: () => {} },
    );

    const followUp = bodies.at(-1);

    const assistant = (followUp?.messages ?? []).find((message) => message.role === "assistant");
    expect(assistant?.tool_calls?.[0]?.extra_content).toEqual({ google: { thought_signature: toolCallSignature } });
  });

  function adapterCapturing(): { adapter: ReturnType<typeof createAiSdkModelAdapter>; bodies: unknown[] } {
    const bodies: unknown[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [
        {
          connectionId: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
          credentialRef: "fixture.apiKey",
        },
      ],
      readSecret: async () => "test-key",
      fetch: fakeFetch(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(stopStream(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    });
    return { adapter, bodies };
  }

  it.each(["fixture.zebra", "tools.search"])("encodes omitted historical %s without offering it again", async (id) => {
    const { adapter, bodies } = adapterCapturing();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const outcome = await adapter.stream(
      request({
        tools: [],
        messages: [
          { id: "u", role: "user", text: "continue", createdAt },
          { id: "a", role: "assistant", text: "", toolCalls: [{ id: "call-1", name: id, input: {} }], createdAt },
          {
            id: "t",
            role: "tool",
            text: "",
            toolResults: [{ toolCallId: "call-1", toolName: id, output: "done", isError: false }],
            createdAt,
          },
        ],
      }),
      { signal: new AbortController().signal, onEvent: () => {} },
    );
    expect(outcome.status).toBe("completed");
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as {
      tools?: unknown[];
      messages: { role: string; tool_calls?: { function: { name: string } }[]; tool_call_id?: string }[];
    };
    expect(body.tools ?? []).toEqual([]);
    expect(body.messages.find((message) => message.role === "assistant")?.tool_calls?.[0]?.function.name).toBe(id.replaceAll(".", "_"));
    expect(body.messages.find((message) => message.role === "tool")?.tool_call_id).toBe("call-1");
    expect(JSON.stringify(body)).not.toContain(id);
  });

  it("sends the system prompt as instructions, never inside messages", async () => {
    const { adapter, bodies } = adapterCapturing();
    const outcome = await adapter.stream(
      request({
        messages: [
          { id: "s", role: "system", text: "be terse", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "u", role: "user", text: "hi", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      }),
      { signal: new AbortController().signal, onEvent: () => {} },
    );

    // Before this fix the SDK rejected the prompt and never issued a request.
    expect(outcome.status).toBe("completed");
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as { messages: { role: string; content: unknown }[] };
    // The SDK does project the `system` option into a leading system message on
    // the wire; the defect was the `role: "system"` entry inside `messages`,
    // which the SDK refuses to accept as input at all.
    const systems = body.messages.filter((message) => message.role === "system");
    expect(systems).toHaveLength(1);
    expect(JSON.stringify(systems[0])).toContain("be terse");
    expect(body.messages.at(-1)?.role).toBe("user");
  });

  it("introduces a tool result with the matching assistant tool call", async () => {
    const { adapter, bodies } = adapterCapturing();
    await adapter.stream(
      request({
        messages: [
          { id: "u", role: "user", text: "echo ping", createdAt: "2026-01-01T00:00:00.000Z" },
          {
            id: "a",
            role: "assistant",
            text: "",
            toolCalls: [{ id: "call-1", name: "fixture.echo", input: { message: "ping" } }],
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "t",
            role: "tool",
            text: "",
            toolCallId: "call-1",
            toolName: "fixture.echo",
            toolResults: [{ toolCallId: "call-1", toolName: "fixture.echo", output: { echoed: "ping" }, isError: false }],
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      { signal: new AbortController().signal, onEvent: () => {} },
    );

    const body = bodies[0] as {
      messages: { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
    };
    const assistant = body.messages.find((message) => message.role === "assistant");
    const tool = body.messages.find((message) => message.role === "tool");
    // A provider rejects a tool message whose id is not introduced first.
    expect(assistant?.tool_calls?.[0]?.id).toBe("call-1");
    expect(tool?.tool_call_id).toBe("call-1");
  });
});

// What tavi sends each vendor's compatibility endpoint — the path, the key,
// the model — not that the vendor accepts it: that needs the vendor.
describe("Anthropic and Gemini through the openai-compatible kind", () => {
  const answer = sse([
    {
      id: "c",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
    },
    { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);

  // The vendors' own OpenAI-compatible endpoints, as docs/CLI.md gives them.
  for (const [vendor, baseUrl, model] of [
    ["Anthropic", "https://api.anthropic.com/v1", "an-anthropic-model"],
    ["Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "a-gemini-model"],
  ] as const) {
    it(`reaches ${vendor}'s endpoint at its Chat Completions path, with the key as a bearer token`, async () => {
      const seen: { url: string; authorization: string | null; model: unknown }[] = [];
      const adapter = createAiSdkModelAdapter({
        connections: [{ connectionId: "vendor", kind: "openai-compatible", baseUrl, credentialRef: "vendor.apiKey" }],
        readSecret: async () => "vendor-key",
        fetch: fakeFetch(async (input, init) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { model?: unknown };
          seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), model: body.model });
          return new Response(answer, { status: 200, headers: { "content-type": "text/event-stream" } });
        }),
      });
      const outcome = await adapter.stream(request({ connectionId: "vendor", model }), {
        signal: new AbortController().signal,
        onEvent: () => undefined,
      });
      expect(outcome.status).toBe("completed");
      expect(seen).toEqual([{ url: `${baseUrl}/chat/completions`, authorization: "Bearer vendor-key", model }]);
    });
  }
});

describe("the model specification the adapter reads", () => {
  it("accepts the installed provider's, and refuses another before any call", () => {
    expect(() => assertModelSpecification()).not.toThrow();
    expect(() => assertModelSpecification({ specificationVersion: "v5" })).toThrowError(
      /speaks model specification v5; tavi's model adapter is written for v4/,
    );
    try {
      assertModelSpecification({ specificationVersion: "v5" });
    } catch (error) {
      expect(error).toMatchObject({ code: "UNAVAILABLE", details: { specificationVersion: "v5" } });
    }
  });

  it("is checked when an adapter is composed: a provider of another specification composes nothing", async () => {
    vi.resetModules();
    vi.doMock("@ai-sdk/openai", () => ({ createOpenAI: () => ({ chat: () => ({ specificationVersion: "v5" }) }) }));
    try {
      const drifted = await import("../src/models/models.js");
      expect(() => drifted.createAiSdkModelAdapter({ connections: [], readSecret: async () => null })).toThrowError(
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
    } finally {
      vi.doUnmock("@ai-sdk/openai");
      vi.resetModules();
    }
  });
});

describe("what fails over, as the SDK classifies it", () => {
  const call = (statusCode: number, extra: { responseBody?: string; responseHeaders?: Record<string, string>; message?: string } = {}) =>
    new APICallError({
      message: extra.message ?? `status ${statusCode}`,
      url: "https://h/v1/chat/completions",
      requestBodyValues: {},
      statusCode,
      ...extra,
    });

  it("fails over exactly the statuses the SDK calls retryable — a quota exhaustion excepted", () => {
    for (const status of [400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504]) {
      const error = call(status);
      const code = toModelError(error).code;
      expect(code === "rate_limit" || code === "provider", `status ${status}: ${code}`).toBe(error.isRetryable);
    }
    // A 429 the SDK would retry, which never succeeds until the operator pays: not failed over.
    const quota = call(429, { message: "You exceeded your current quota, please check your plan" });
    expect([quota.isRetryable, toModelError(quota).code]).toEqual([true, "quota_exceeded"]);
  });

  it("does not fail over a call that reached no status — a refused connection — and says it is unknown, not an invalid request", async () => {
    const refused = new APICallError({
      message: "Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11434",
      url: "http://127.0.0.1:11434/v1/chat/completions",
      requestBodyValues: {},
      isRetryable: true,
    });
    expect(refused.isRetryable).toBe(true);
    expect(toModelError(refused)).toEqual({ code: "unknown", message: refused.message, retryable: false });
    // Wrapped by the SDK's own retries, it is classified as what it wraps — and so is a 429.
    const { RetryError } = await import("ai");
    const wrapped = new RetryError({ message: "Failed after 3 attempts", reason: "maxRetriesExceeded", errors: [refused, refused] });
    expect(toModelError(wrapped).code).toBe("unknown");
    expect(toModelError(new RetryError({ message: "x", reason: "maxRetriesExceeded", errors: [call(429)] })).code).toBe("rate_limit");
  });

  it("reads Retry-After, in seconds or as a date, bounded", () => {
    expect(toModelError(call(429, { responseHeaders: { "retry-after": "7" } }))).toMatchObject({ code: "rate_limit", retryAfterMs: 7_000 });
    expect(toModelError(call(503, { responseHeaders: { "Retry-After": "0.5" } }))).toMatchObject({ code: "provider", retryAfterMs: 500 });
    const now = Date.parse("2026-09-19T12:00:00.000Z");
    expect(readRetryAfterMs(call(503, { responseHeaders: { "retry-after": "Sat, 19 Sep 2026 12:00:30 GMT" } }), () => now)).toBe(30_000);
    expect(readRetryAfterMs(call(503, { responseHeaders: { "retry-after": "999999999" } }))).toBe(86_400_000);
    expect(readRetryAfterMs(call(503, { responseHeaders: { "retry-after": "soon" } }))).toBeUndefined();
    expect(toModelError(call(503)).retryAfterMs).toBeUndefined();
    // Nested in the SDK's own retry wrapper, as the status is.
    expect(readRetryAfterMs({ cause: call(429, { responseHeaders: { "retry-after": "2" } }) })).toBe(2_000);
  });

  it("classifies a provider error inside the stream by the SDK's own flag when it has no status", () => {
    expect(toModelError(new StreamProviderError({ message: "overloaded", isRetryable: true }))).toMatchObject({
      code: "provider",
      retryable: true,
    });
    expect(toModelError(new StreamProviderError({ message: "content filtered", isRetryable: false }))).toMatchObject({
      code: "unknown",
      retryable: false,
    });
    expect(toModelError(new StreamProviderError({ message: "slow down", statusCode: 429, isRetryable: true }))).toMatchObject({
      code: "rate_limit",
    });
  });
});

it("classifies only explicit structured provider retirement, never transient failures or missing models", () => {
  const error = (statusCode: number, code: string) =>
    Object.assign(new Error("provider response"), { statusCode, responseBody: JSON.stringify({ error: { code } }) });
  expect(toModelError(error(410, "model_retired"))).toMatchObject({ code: "model_retired", retryable: false });
  expect(toModelError(error(400, "model_decommissioned"))).toMatchObject({ code: "model_retired", retryable: false });
  expect(toModelError(error(404, "model_not_found"))).toMatchObject({ code: "invalid_request" });
  expect(toModelError(error(503, "model_retired"))).toMatchObject({ code: "provider", retryable: true });
});

describe("an image only for a model that reads one", () => {
  it("knows the vision families, ignores a provider prefix, and treats an unknown model as text-only", () => {
    for (const model of [
      "claude-sonnet-4-5",
      "anthropic/claude-3-5-haiku",
      "gpt-4o-mini",
      "openai/gpt-4.1",
      "gpt-5-nano",
      "gemini-2.5-flash",
      "google/gemini-1.5-pro",
      "qwen2.5-vl-7b",
      "llama-3.2-11b-vision-instruct",
      "llava:13b",
      "pixtral-12b",
      "gpt-6",
      "openai/o3",
      "o4-mini",
      "o1",
      "google/gemma-3-27b-it",
      "gemma-4-12b",
      "meta-llama/llama-4-scout",
      "qwen3.5-72b",
      "qwen/qwen3.6-plus",
      "qwen/qwen3.8-flash",
      "amazon.nova-lite-v1:0",
      "amazon/nova-2-lite-v1",
      "nova-pro-v1",
      "moonshotai/kimi-k2.5",
      "moonshotai/kimi-k2.6",
      "moonshotai/kimi-k3",
      "glm-4.5v",
      "z-ai/glm-5v-turbo",
      "x-ai/grok-4.7",
      "mistral-small-3.1-24b-instruct",
      "mistralai/mistral-small-4-0",
      "mistral-medium-3",
      "mistralai/mistral-large-4-0",
      "phi-4-multimodal-instruct",
      "internvl3-8b",
      "minicpm-v-4",
    ]) {
      expect(modelReadsImages(model), model).toBe(true);
    }
    for (const model of [
      "claude-2.1",
      "claude-instant-1",
      "gpt-3.5-turbo",
      "gpt-4",
      "gemini-pro",
      "gemini-1.0-pro",
      "llama3.1:8b",
      "fixture-model",
      "o3-mini",
      "deepseek-chat",
      "o1-mini",
      "o1-preview",
      "gemma-3-1b-it",
      "gemma-3-270m",
      "gemma3:1b",
      "gemma3:270m",
      "nova-micro-v1",
      "mistral-small-3",
      "llama-4-behemoth",
    ]) {
      expect(modelReadsImages(model), model).toBe(false);
    }
  });

  const viewed: ModelMessage[] = [
    { id: "u", role: "user", text: "look", createdAt: "2026-01-01T00:00:00.000Z" },
    {
      id: "a",
      role: "assistant",
      text: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      toolCalls: [{ id: "c1", name: "artifacts.view_image", input: { artifactId: "a1" } }],
    },
    {
      id: "t",
      role: "tool",
      text: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      toolResults: [
        {
          toolCallId: "c1",
          toolName: "artifacts.view_image",
          isError: false,
          output: { artifactId: "a1", taviMedia: { artifactId: "a1", mediaType: "image/png" } },
        },
      ],
    },
  ];

  it("sends a text-only model the result's fields, without resolving the image or leaking its reference", async () => {
    const resolveMedia = vi.fn(() => ({ mediaType: "image/png", data: new Uint8Array([1, 2]) }));
    const bodies: string[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [
        { connectionId: "fixture", kind: "openai-compatible", baseUrl: "https://fixture.invalid/v1", credentialRef: "fixture.apiKey" },
      ],
      readSecret: async () => "key",
      resolveMedia,
      fetch: fakeFetch(async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response("{}", { status: 400 });
      }),
    });
    await adapter.stream(request({ model: "llama3.1:8b", messages: viewed }), { signal: new AbortController().signal, onEvent: () => {} });
    expect(resolveMedia).not.toHaveBeenCalled();
    expect(bodies.join("")).toContain("not shown: this model does not read images");
    expect(bodies.join("")).not.toContain("taviMedia");
  });

  it("resolves the image for a vision model, or for any model an owner says reads images", async () => {
    for (const [model, supportsImages] of [
      ["gpt-4o", undefined],
      ["my-local-model", () => true],
    ] as const) {
      const resolveMedia = vi.fn(() => ({ mediaType: "image/png", data: new Uint8Array([1, 2]) }));
      const adapter = createAiSdkModelAdapter({
        connections: [
          { connectionId: "fixture", kind: "openai-compatible", baseUrl: "https://fixture.invalid/v1", credentialRef: "fixture.apiKey" },
        ],
        readSecret: async () => "key",
        resolveMedia,
        ...(supportsImages === undefined ? {} : { supportsImages }),
        fetch: fakeFetch(async () => new Response("{}", { status: 400 })),
      });
      await adapter.stream(request({ model, messages: viewed }), { signal: new AbortController().signal, onEvent: () => {} });
      expect(resolveMedia, model).toHaveBeenCalledWith("a1");
    }
  });

  it("sends the image as an image the model sees, after the tool result, never as base64 text inside it", async () => {
    const bodies: string[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [
        { connectionId: "fixture", kind: "openai-compatible", baseUrl: "https://fixture.invalid/v1", credentialRef: "fixture.apiKey" },
      ],
      readSecret: async () => "key",
      resolveMedia: () => ({ mediaType: "image/png", data: new Uint8Array([1, 2]) }),
      fetch: fakeFetch(async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response("{}", { status: 400 });
      }),
    });
    await adapter.stream(request({ model: "gpt-4o", messages: viewed }), { signal: new AbortController().signal, onEvent: () => {} });
    const sent = JSON.parse(bodies[0] ?? "{}") as { messages: { role: string; content: unknown }[] };
    const roles = sent.messages.map((message) => message.role);
    const tool = sent.messages.find((message) => message.role === "tool");
    // Chat Completions reads a tool result as text: the result's fields go there, the picture does not.
    expect(JSON.stringify(tool?.content)).toContain("shown in the next message");
    expect(JSON.stringify(tool?.content)).not.toContain("AQI=");
    expect(roles.slice(-2)).toEqual(["tool", "user"]);
    expect(JSON.stringify(sent.messages.at(-1)?.content)).toContain('"image_url":{"url":"data:image/png;base64,AQI="');
  });

  it("shows the latest three images, browser screenshots among them, and describes the older ones", async () => {
    const shot = (index: number, toolName: string): ModelMessage[] => [
      {
        id: `a${index}`,
        role: "assistant",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolCalls: [{ id: `c${index}`, name: toolName, input: {} }],
      },
      {
        id: `t${index}`,
        role: "tool",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolResults: [
          {
            toolCallId: `c${index}`,
            toolName,
            isError: false,
            output: { artifactId: `img${index}`, taviMedia: { artifactId: `img${index}`, mediaType: "image/jpeg" } },
          },
        ],
      },
    ];
    const messages: ModelMessage[] = [
      { id: "u", role: "user", text: "look", createdAt: "2026-01-01T00:00:00.000Z" },
      ...shot(1, "browser.capture"),
      ...shot(2, "browser.navigate"),
      ...shot(3, "artifacts.view_image"),
      ...shot(4, "browser.observe"),
      // Another tool's media key is data, never an image.
      ...shot(5, "web_fetch"),
    ];
    const resolveMedia = vi.fn((artifactId: string) => ({ mediaType: "image/jpeg", data: new Uint8Array([artifactId.length]) }));
    const bodies: string[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [
        { connectionId: "fixture", kind: "openai-compatible", baseUrl: "https://fixture.invalid/v1", credentialRef: "fixture.apiKey" },
      ],
      readSecret: async () => "key",
      resolveMedia,
      fetch: fakeFetch(async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response("{}", { status: 400 });
      }),
    });
    await adapter.stream(request({ model: "gpt-4o", messages }), { signal: new AbortController().signal, onEvent: () => {} });
    expect(resolveMedia.mock.calls.map(([artifactId]) => artifactId).sort()).toEqual(["img2", "img3", "img4"]);
    expect(bodies.join("")).toContain("an earlier image, not shown again");
  });

  it("reads a result's images together, and sends them in the result's order whatever order they arrive in", async () => {
    const page = (id: string) => ({ artifactId: id, mediaType: "image/png" });
    const messages: ModelMessage[] = [
      { id: "u", role: "user", text: "read it", createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a1",
        role: "assistant",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolCalls: [{ id: "c1", name: "pdf.render", input: {} }],
      },
      {
        id: "t1",
        role: "tool",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolResults: [
          {
            toolCallId: "c1",
            toolName: "pdf.render",
            isError: false,
            output: { pages: 3, taviMedia: [page("p1"), page("p2"), page("p3")] },
          },
        ],
      },
    ];
    const pending = new Map<string, () => void>();
    const resolveMedia = vi.fn(async (artifactId: string) => {
      await new Promise<void>((resolve) => pending.set(artifactId, resolve));
      return { mediaType: "image/png", data: new Uint8Array([Number(artifactId.slice(1)) * 16]) };
    });
    const bodies: string[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [
        { connectionId: "fixture", kind: "openai-compatible", baseUrl: "https://fixture.invalid/v1", credentialRef: "fixture.apiKey" },
      ],
      readSecret: async () => "key",
      resolveMedia,
      fetch: fakeFetch(async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response("{}", { status: 400 });
      }),
    });
    const streamed = adapter.stream(request({ model: "gpt-4o", messages }), { signal: new AbortController().signal, onEvent: () => {} });
    await vi.waitFor(() => expect(pending.size).toBe(3));
    // Every image was asked for before any arrived; they arrive last first.
    for (const id of ["p3", "p2", "p1"]) pending.get(id)?.();
    await streamed;
    // 0x10, 0x20, 0x30 as base64 data URLs, in page order.
    const order = ["EA==", "IA==", "MA=="].map((data) => (bodies[0] ?? "").indexOf(data));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("counts images, not results: a render of three pages is shown whole, and a later image pushes out its first", async () => {
    const result = (index: number, toolName: string, taviMedia: unknown): ModelMessage[] => [
      {
        id: `a${index}`,
        role: "assistant",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolCalls: [{ id: `c${index}`, name: toolName, input: {} }],
      },
      {
        id: `t${index}`,
        role: "tool",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolResults: [{ toolCallId: `c${index}`, toolName, isError: false, output: { pages: 3, taviMedia } }],
      },
    ];
    const page = (id: string) => ({ artifactId: id, mediaType: "image/png" });
    const resolveMedia = vi.fn((artifactId: string) => ({ mediaType: "image/png", data: new Uint8Array([artifactId.length]) }));
    const bodies: string[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [
        { connectionId: "fixture", kind: "openai-compatible", baseUrl: "https://fixture.invalid/v1", credentialRef: "fixture.apiKey" },
      ],
      readSecret: async () => "key",
      resolveMedia,
      fetch: fakeFetch(async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response("{}", { status: 400 });
      }),
    });
    const user: ModelMessage = { id: "u", role: "user", text: "read it", createdAt: "2026-01-01T00:00:00.000Z" };
    const render = result(1, "pdf.render", [page("p1"), page("p2"), page("p3")]);
    await adapter.stream(request({ model: "gpt-4o", messages: [user, ...render] }), {
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(resolveMedia.mock.calls.map(([artifactId]) => artifactId)).toEqual(["p1", "p2", "p3"]);
    // Chat Completions sends a tool result as a JSON string: its quotes arrive escaped.
    const unescaped = (body: string | undefined): string => (body ?? "").replaceAll('\\"', '"');
    expect(unescaped(bodies[0])).toContain(
      '"images":["shown in the next message","shown in the next message","shown in the next message"]',
    );
    resolveMedia.mockClear();
    await adapter.stream(request({ model: "gpt-4o", messages: [user, ...render, ...result(2, "artifacts.view_image", page("later"))] }), {
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(resolveMedia.mock.calls.map(([artifactId]) => artifactId).sort()).toEqual(["later", "p2", "p3"]);
    expect(unescaped(bodies[1])).toContain(
      '"images":["an earlier image, not shown again: later ones show the page as it is now","shown in the next message","shown in the next message"]',
    );
    // A list over the cap carries no image, and its references never reach the model.
    resolveMedia.mockClear();
    await adapter.stream(
      request({ model: "gpt-4o", messages: [user, ...result(3, "pdf.render", [page("a"), page("b"), page("c"), page("d")])] }),
      { signal: new AbortController().signal, onEvent: () => {} },
    );
    expect(resolveMedia).not.toHaveBeenCalled();
    expect(bodies[2]).not.toContain("taviMedia");
    expect(bodies[2]).not.toContain("artifactId");
  });

  it("under promptLayout v2 shows images in strides and words each result the same, shown or not", async () => {
    // Up to six shown; past that the oldest three go at once.
    expect([1, 6, 7, 8, 9, 10, 13].map((count) => firstShownImage(count, true))).toEqual([0, 0, 3, 3, 3, 6, 9]);
    expect(firstShownImage(7, false)).toBe(4);
    const shot = (index: number): ModelMessage[] => [
      {
        id: `a${index}`,
        role: "assistant",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolCalls: [{ id: `c${index}`, name: "artifacts.view_image", input: {} }],
      },
      {
        id: `t${index}`,
        role: "tool",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
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
    const user: ModelMessage = { id: "u", role: "user", text: "look", createdAt: "2026-01-01T00:00:00.000Z" };
    const resolveMedia = vi.fn((artifactId: string) => ({ mediaType: "image/png", data: new Uint8Array([artifactId.length]) }));
    const sent = async (count: number) =>
      toSdkMessages(
        [user, ...Array.from({ length: count }, (_, index) => shot(index + 1)).flat()],
        new Map(),
        resolveMedia,
        undefined,
        undefined,
        true,
        undefined,
        true,
      );
    const six = await sent(6);
    expect(resolveMedia).toHaveBeenCalledTimes(6);
    resolveMedia.mockClear();
    const seven = await sent(7);
    expect(resolveMedia.mock.calls.map(([id]) => id)).toEqual(["img4", "img5", "img6", "img7"]);
    // The first image's result reads the same before and after it left the window.
    const firstResult = (messages: unknown[]) =>
      JSON.stringify(messages.find((message) => JSON.stringify(message).includes('"c1"') && (message as { role: string }).role === "tool"));
    expect(firstResult(seven)).toBe(firstResult(six));
    expect(firstResult(six)).toContain("an image: when shown, it follows these results");
    // The window never starts inside a result: a render of three pages stays whole or goes whole.
    const render: ModelMessage[] = [
      {
        id: "ar",
        role: "assistant",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolCalls: [{ id: "cr", name: "pdf.render", input: {} }],
      },
      {
        id: "tr",
        role: "tool",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolResults: [
          {
            toolCallId: "cr",
            toolName: "pdf.render",
            isError: false,
            output: { taviMedia: ["r1", "r2", "r3"].map((artifactId) => ({ artifactId, mediaType: "image/png" })) },
          },
        ],
      },
    ];
    resolveMedia.mockClear();
    await toSdkMessages(
      [user, ...shot(1), ...render, ...shot(2), ...shot(3), ...shot(4)],
      new Map(),
      resolveMedia,
      undefined,
      undefined,
      true,
      undefined,
      true,
    );
    expect(resolveMedia.mock.calls.map(([id]) => id).sort()).toEqual(["img2", "img3", "img4", "r1", "r2", "r3"]);
  });

  it("says which pages were not shown: to a model that reads no images, and for a page the store no longer has", async () => {
    const page = (id: string) => ({ artifactId: id, mediaType: "image/png" });
    const messages: ModelMessage[] = [
      { id: "u", role: "user", text: "read it", createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a",
        role: "assistant",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolCalls: [{ id: "c", name: "pdf.render", input: {} }],
      },
      {
        id: "t",
        role: "tool",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolResults: [{ toolCallId: "c", toolName: "pdf.render", isError: false, output: { taviMedia: [page("p1"), page("gone")] } }],
      },
    ];
    const bodies: string[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [
        { connectionId: "fixture", kind: "openai-compatible", baseUrl: "https://fixture.invalid/v1", credentialRef: "fixture.apiKey" },
      ],
      readSecret: async () => "key",
      resolveMedia: (artifactId: string) => (artifactId === "gone" ? undefined : { mediaType: "image/png", data: new Uint8Array([1]) }),
      fetch: fakeFetch(async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response("{}", { status: 400 });
      }),
    });
    const notShown = "not shown: this model does not read images, or the image is no longer available";
    await adapter.stream(request({ model: "gpt-4o", messages }), { signal: new AbortController().signal, onEvent: () => {} });
    expect((bodies[0] ?? "").replaceAll('\\"', '"')).toContain(`"images":["shown in the next message","${notShown}"]`);
    await adapter.stream(request({ model: "gpt-3.5-turbo", messages }), { signal: new AbortController().signal, onEvent: () => {} });
    expect((bodies[1] ?? "").replaceAll('\\"', '"')).toContain(`"images":["${notShown}","${notShown}"]`);
  });

  it("keeps a single image's result exactly as it was", async () => {
    const messages: ModelMessage[] = [
      { id: "u", role: "user", text: "look", createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a",
        role: "assistant",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolCalls: [{ id: "c", name: "artifacts.view_image", input: {} }],
      },
      {
        id: "t",
        role: "tool",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolResults: [
          {
            toolCallId: "c",
            toolName: "artifacts.view_image",
            isError: false,
            output: { artifactId: "img", contentType: "image/png", byteSize: 2, taviMedia: { artifactId: "img", mediaType: "image/png" } },
          },
        ],
      },
    ];
    const bodies: string[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [
        { connectionId: "fixture", kind: "openai-compatible", baseUrl: "https://fixture.invalid/v1", credentialRef: "fixture.apiKey" },
      ],
      readSecret: async () => "key",
      resolveMedia: () => ({ mediaType: "image/png", data: new Uint8Array([1, 2]) }),
      fetch: fakeFetch(async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response("{}", { status: 400 });
      }),
    });
    await adapter.stream(request({ model: "gpt-4o", messages }), { signal: new AbortController().signal, onEvent: () => {} });
    const sent = JSON.parse(bodies[0] ?? "{}") as { messages: { role: string; content: unknown }[] };
    const tool = sent.messages.find((message) => message.role === "tool");
    expect(JSON.parse(String(tool?.content))).toEqual({
      artifactId: "img",
      contentType: "image/png",
      byteSize: 2,
      image: "shown in the next message",
    });
  });

  it("shows an MCP tool's image to a model that reads images, and only its result's fields to one that does not", async () => {
    const messages: ModelMessage[] = [
      { id: "u", role: "user", text: "draw", createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a",
        role: "assistant",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolCalls: [{ id: "c", name: "mcp.fake.image", input: {} }],
      },
      {
        id: "t",
        role: "tool",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolResults: [
          {
            toolCallId: "c",
            toolName: "mcp.fake.image",
            isError: false,
            output: { content: "a picture", taviMedia: { artifactId: "img", mediaType: "image/png" } },
          },
        ],
      },
    ];
    const resolveMedia = vi.fn(() => ({ mediaType: "image/png", data: new Uint8Array([1, 2]) }));
    const bodies: string[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [
        { connectionId: "fixture", kind: "openai-compatible", baseUrl: "https://fixture.invalid/v1", credentialRef: "fixture.apiKey" },
      ],
      readSecret: async () => "key",
      resolveMedia,
      fetch: fakeFetch(async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response("{}", { status: 400 });
      }),
    });
    await adapter.stream(request({ model: "gpt-4o", messages }), { signal: new AbortController().signal, onEvent: () => {} });
    expect(bodies[0]).toContain('"image_url":{"url":"data:image/png;base64,AQI="');
    expect(bodies[0]).not.toContain("taviMedia");
    await adapter.stream(request({ model: "gpt-3.5-turbo", messages }), { signal: new AbortController().signal, onEvent: () => {} });
    expect(resolveMedia).toHaveBeenCalledTimes(1);
    expect(bodies[1]).toContain("not shown: this model does not read images");
    expect(bodies[1]).not.toContain("image_url");
    expect(bodies[1]).not.toContain("taviMedia");
  });
});

describe("a PDF only for a connection that takes one", () => {
  const viewed: ModelMessage[] = [
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
          output: {
            document: { pageCount: 1 },
            pages: [{ page: 1, text: "Invoice" }],
            taviMedia: [{ artifactId: "p1", mediaType: "image/png" }],
            taviDocument: { artifactId: "doc", mediaType: "application/pdf" },
          },
        },
      ],
    },
  ];

  it("under promptLayout v2 words a viewed PDF the same whether the file is sent or not, and never names its images", async () => {
    const resolveMedia = (artifactId: string) => ({ mediaType: "image/png", data: new Uint8Array([artifactId.length]) });
    const resolveDocument = () => ({ mediaType: "application/pdf", data: new Uint8Array([0x25, 0x50, 0x44, 0x46]) });
    const toolOf = (messages: unknown[]) => JSON.stringify(messages.find((message) => (message as { role: string }).role === "tool"));
    const withFile = await toSdkMessages(viewed, new Map(), resolveMedia, resolveDocument, undefined, true, undefined, true);
    const without = await toSdkMessages(viewed, new Map(), resolveMedia, undefined, undefined, true, undefined, true);
    expect(toolOf(withFile)).toBe(toolOf(without));
    expect(toolOf(withFile)).not.toContain("taviMedia");
    expect(toolOf(withFile)).not.toContain("taviDocument");
    // A model that reads no images is still told its images were not shown.
    const blind = await toSdkMessages(viewed, new Map(), undefined, undefined, undefined, true, undefined, true);
    expect(toolOf(blind)).toContain("not shown: this model does not read images");
  });

  const sent = async (
    connection: Record<string, unknown>,
    model = "gpt-4o",
  ): Promise<{ readonly body: string; readonly documents: string[]; readonly images: string[] }> => {
    const bodies: string[] = [];
    const documents: string[] = [];
    const images: string[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [
        {
          connectionId: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
          credentialRef: "fixture.apiKey",
          ...connection,
        },
      ],
      readSecret: async () => "key",
      resolveMedia: (artifactId) => (images.push(artifactId), { mediaType: "image/png", data: new Uint8Array([1, 2]) }),
      resolveDocument: (artifactId) => (
        documents.push(artifactId), { mediaType: "application/pdf", data: new Uint8Array([0x25, 0x50, 0x44, 0x46]) }
      ),
      fetch: fakeFetch(async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response("{}", { status: 400 });
      }),
    });
    await adapter.stream(request({ model, messages: viewed }), { signal: new AbortController().signal, onEvent: () => {} });
    return { body: bodies.join(""), documents, images };
  };

  it("sends the document as a file part after the results on a capable connection, and no page images", async () => {
    const { body, documents, images } = await sent({ pdfInput: "openai-file" });
    expect(documents).toEqual(["doc"]);
    expect(images).toEqual([]);
    expect(body).toContain('"file_data":"data:application/pdf;base64,JVBERg=="');
    expect(body).toContain("sent as a file in the next message");
    expect(body).not.toContain("taviDocument");
    // The result's own document facts are kept beside the note.
    expect(body).toContain("pageCount");
  });

  it("sends no PDF to a model that reads no images, but does through OpenRouter, which parses it for any model", async () => {
    expect((await sent({ pdfInput: "openai-file" }, "gpt-3.5-turbo")).documents).toEqual([]);
    expect((await sent({ baseUrl: "https://openrouter.ai/api/v1", pdfInput: "openai-file" }, "deepseek-chat")).documents).toEqual(["doc"]);
  });

  it("sends a document only in the turn it was viewed in", async () => {
    const later: ModelMessage[] = [
      ...viewed,
      { id: "a2", role: "assistant", text: "It is an invoice.", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "u2", role: "user", text: "thanks", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    const documents: string[] = [];
    await toSdkMessages(
      later,
      new Map(),
      undefined,
      (artifactId) => (documents.push(artifactId), { mediaType: "application/pdf", data: new Uint8Array([1]) }),
    );
    expect(documents).toEqual([]);
  });

  it("sends the page images instead anywhere else, saying the document was not sent", async () => {
    for (const connection of [{}, { pdfInput: "none" }, { baseUrl: "https://api.anthropic.com/v1" }]) {
      const { body, documents, images } = await sent(connection);
      expect(documents, JSON.stringify(connection)).toEqual([]);
      expect(images).toEqual(["p1"]);
      expect(body).not.toContain("application/pdf");
      expect(body).toContain("not sent as a file");
    }
  });

  it("sends the newest document only: an earlier one is said not sent again", async () => {
    const twice: ModelMessage[] = [
      ...viewed,
      {
        id: "a2",
        role: "assistant",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolCalls: [{ id: "c2", name: "pdf.view", input: { source: { artifactId: "doc2" } } }],
      },
      {
        id: "t2",
        role: "tool",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolResults: [
          {
            toolCallId: "c2",
            toolName: "pdf.view",
            isError: false,
            output: { pages: [], taviDocument: { artifactId: "doc2", mediaType: "application/pdf" } },
          },
        ],
      },
    ];
    const documents: string[] = [];
    const messages = await toSdkMessages(
      twice,
      new Map(),
      undefined,
      (artifactId) => (documents.push(artifactId), { mediaType: "application/pdf", data: new Uint8Array([1]) }),
    );
    expect(documents).toEqual(["doc2"]);
    expect(JSON.stringify(messages)).toContain("not sent as a file");
  });

  it("asks OpenRouter for its file parser, and no other endpoint", async () => {
    const router = await sent({ baseUrl: "https://openrouter.ai/api/v1", pdfInput: "openai-file", pdfEngine: "mistral-ocr" });
    expect(router.body).toContain('"plugins":[{"id":"file-parser","pdf":{"engine":"mistral-ocr"}}]');
    const other = await sent({ pdfInput: "openai-file", pdfEngine: "mistral-ocr" });
    expect(other.body).not.toContain("file-parser");
  });
});

describe("a video only for a model its connection has native video on for", () => {
  const viewed: ModelMessage[] = [
    { id: "u", role: "user", text: "how is my squat?", createdAt: "2026-01-01T00:00:00.000Z" },
    {
      id: "a",
      role: "assistant",
      text: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      toolCalls: [{ id: "c1", name: "video.view", input: { source: { artifactId: "clip" } } }],
    },
    {
      id: "t",
      role: "tool",
      text: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      toolResults: [
        {
          toolCallId: "c1",
          toolName: "video.view",
          isError: false,
          output: {
            video: { durationSec: 4 },
            taviMedia: [{ artifactId: "sheet", mediaType: "image/jpeg" }],
            taviVideo: { artifactId: "clip", mediaType: "video/mp4" },
          },
        },
      ],
    },
  ];

  const sent = async (
    connection: Record<string, unknown>,
    options: { readonly model?: string; readonly messages?: ModelMessage[]; readonly fail?: number; readonly maxRetries?: number } = {},
  ): Promise<{ readonly bodies: string[]; readonly videos: string[]; readonly images: string[]; readonly status: string }> => {
    const bodies: string[] = [];
    const videos: string[] = [];
    const images: string[] = [];
    let failures = options.fail ?? 0;
    const adapter = createAiSdkModelAdapter({
      connections: [
        {
          connectionId: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
          credentialRef: "fixture.apiKey",
          ...connection,
        },
      ],
      readSecret: async () => "key",
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      resolveMedia: (artifactId) => (images.push(artifactId), { mediaType: "image/jpeg", data: new Uint8Array([1, 2]) }),
      resolveDocument: () => ({ mediaType: "application/pdf", data: new Uint8Array([0x25, 0x50, 0x44, 0x46]) }),
      resolveVideo: (artifactId, runId) => (
        videos.push(`${artifactId}@${runId}`), { mediaType: "video/mp4", data: new Uint8Array([0, 0, 0, 0x18]) }
      ),
      fetch: fakeFetch(async (_url, init) => {
        bodies.push(String(init?.body));
        if (failures > 0) {
          failures -= 1;
          return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 });
        }
        return new Response("{}", { status: 400 });
      }),
    });
    const outcome = await adapter.stream(request({ model: options.model ?? "qwen/qwen3-vl", messages: options.messages ?? viewed }), {
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    return { bodies, videos, images, status: outcome.status };
  };

  it("sends the whole clip as a video_url part to an enabled model, and not its fallback images", async () => {
    const { bodies, videos, images } = await sent({ videoModels: ["qwen/qwen3-vl"] });
    expect(videos).toEqual(["clip@run-1"]);
    expect(images).toEqual([]);
    expect(bodies[0]).toContain('{"type":"video_url","video_url":{"url":"data:video/mp4;base64,AAAAGA=="}}');
    expect(bodies[0]).toContain("The video the tool result above names:");
    expect(bodies[0]).toContain("sent whole in the next message");
    expect(bodies[0]).not.toContain("taviVideo");
    expect(bodies[0]).not.toContain("⟦tavi-video:");
  });

  it("sends the fallback images when the owner's resolveVideo gives none (a run nobody attends)", async () => {
    const bodies: string[] = [];
    const images: string[] = [];
    const adapter = createAiSdkModelAdapter({
      connections: [
        {
          connectionId: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
          credentialRef: "fixture.apiKey",
          videoModels: ["qwen/qwen3-vl"],
        },
      ],
      readSecret: async () => "key",
      resolveMedia: (artifactId) => (images.push(artifactId), { mediaType: "image/jpeg", data: new Uint8Array([1, 2]) }),
      resolveVideo: () => undefined,
      fetch: fakeFetch(async (_url, init) => (bodies.push(String(init?.body)), new Response("{}", { status: 400 }))),
    });
    await adapter.stream(request({ model: "qwen/qwen3-vl", runId: "heartbeat-tick", messages: viewed }), {
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(images).toEqual(["sheet"]);
    expect(bodies[0]).not.toContain("video_url");
    expect(bodies[0]).toContain("its frames stand for it");
  });

  it("sends the fallback images instead to a model it is not on for, and to the presets that take none", async () => {
    for (const connection of [{}, { videoModels: ["another/model"] }]) {
      const { bodies, videos, images } = await sent(connection);
      expect(videos, JSON.stringify(connection)).toEqual([]);
      expect(images).toEqual(["sheet"]);
      expect(bodies[0]).not.toContain("video_url");
      expect(bodies[0]).toContain("its frames stand for it");
    }
  });

  it("sends a PDF and a video of one turn each their own way, and only the newest video", async () => {
    const both: ModelMessage[] = [
      ...viewed,
      {
        id: "a2",
        role: "assistant",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolCalls: [
          { id: "c2", name: "pdf.view", input: { source: { artifactId: "doc" } } },
          { id: "c3", name: "video.view", input: { source: { artifactId: "clip2" } } },
        ],
      },
      {
        id: "t2",
        role: "tool",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolResults: [
          {
            toolCallId: "c2",
            toolName: "pdf.view",
            isError: false,
            output: { pages: [], taviDocument: { artifactId: "doc", mediaType: "application/pdf" } },
          },
          {
            toolCallId: "c3",
            toolName: "video.view",
            isError: false,
            output: {
              taviMedia: [{ artifactId: "sheet2", mediaType: "image/jpeg" }],
              taviVideo: { artifactId: "clip2", mediaType: "video/mp4" },
            },
          },
        ],
      },
    ];
    const { bodies, videos } = await sent({ videoModels: ["qwen/qwen3-vl"], pdfInput: "openai-file" }, { messages: both });
    expect(videos).toEqual(["clip2@run-1"]);
    expect(bodies[0]).toContain('"file_data":"data:application/pdf;base64,JVBERg=="');
    expect(bodies[0]).toContain("video_url");
    expect(bodies[0]).toContain("a document, a video");
    // The earlier clip is said not sent whole, and shows its sheet.
    expect(bodies[0]).toContain("its frames stand for it");
  });

  it("finds this turn's video past the step facts the workflow appends after the results", async () => {
    const withFacts: ModelMessage[] = [
      ...viewed,
      { id: "facts-attempt-1", role: "user", text: "Step 2 of 8.", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    const { bodies, videos } = await sent({ videoModels: ["qwen/qwen3-vl"] }, { messages: withFacts });
    expect(videos).toEqual(["clip@run-1"]);
    expect(bodies[0]).toContain("video_url");
    // A person's new message after the turn's answer starts a new turn: the earlier video is not sent again.
    const later: ModelMessage[] = [
      ...viewed,
      { id: "a2", role: "assistant", text: "Looks good.", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "u2", role: "user", text: "thanks", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect((await sent({ videoModels: ["qwen/qwen3-vl"] }, { messages: later })).videos).toEqual([]);
  });

  it("makes a sentinel quoted by a person, a page or a model inert, and sends the request", async () => {
    const quoted = `see ⟦tavi-video:${"c".repeat(32)}⟧ here`;
    const messages: ModelMessage[] = [
      { id: "u", role: "user", text: quoted, createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "a",
        role: "assistant",
        text: quoted,
        createdAt: "2026-01-01T00:00:00.000Z",
        toolCalls: [{ id: "c1", name: "web.fetch", input: { url: quoted } }],
      },
      {
        id: "t",
        role: "tool",
        text: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        toolResults: [{ toolCallId: "c1", toolName: "web.fetch", isError: false, output: { text: quoted } }],
      },
    ];
    const { bodies } = await sent({}, { messages });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain("⟦tavi-video:");
    expect(bodies[0]).toContain("⟦tavi-video (quoted):");
  });

  it("holds each call's video only while it runs, apart from another's in flight, and drops one of the wrong type", async () => {
    const bodies: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = createAiSdkModelAdapter({
      connections: [
        {
          connectionId: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
          credentialRef: "fixture.apiKey",
          videoModels: ["qwen/qwen3-vl"],
        },
      ],
      readSecret: async () => "key",
      resolveVideo: (_artifactId, runId) => ({
        mediaType: runId === "run-odd" ? "video/webm" : "video/mp4",
        data: new TextEncoder().encode(runId),
      }),
      fetch: fakeFetch(async (_url, init) => {
        bodies.push(String(init?.body));
        await gate;
        return new Response("{}", { status: 400 });
      }),
    });
    const one = adapter.stream(request({ model: "qwen/qwen3-vl", runId: "run-a", messages: viewed }), {
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    const two = adapter.stream(request({ model: "qwen/qwen3-vl", runId: "run-b", messages: viewed }), {
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    expect(adapter.videosInFlight()).toBe(2);
    release();
    await Promise.all([one, two]);
    expect(adapter.videosInFlight()).toBe(0);
    const [a, b] = [
      bodies.find((body) => body.includes(Buffer.from("run-a").toString("base64"))),
      bodies.find((body) => body.includes(Buffer.from("run-b").toString("base64"))),
    ];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toContain(Buffer.from("run-b").toString("base64"));
    // An aborted call, and bytes not of the type the result named: nothing held, nothing sent.
    const stopped = new AbortController();
    stopped.abort();
    await adapter.stream(request({ model: "qwen/qwen3-vl", runId: "run-a", messages: viewed }), {
      signal: stopped.signal,
      onEvent: () => {},
    });
    await adapter.stream(request({ model: "qwen/qwen3-vl", runId: "run-odd", messages: viewed }), {
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(bodies.at(-1)).not.toContain("video_url");
    expect(adapter.videosInFlight()).toBe(0);
  });

  it("resolves the sentinel again on an SDK retry within the call, and never keeps the bytes in the request", async () => {
    const before = JSON.stringify(viewed);
    const { bodies } = await sent({ videoModels: ["qwen/qwen3-vl"] }, { fail: 1, maxRetries: 1 });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).toContain("data:video/mp4;base64,AAAAGA==");
    expect(JSON.stringify(viewed)).toBe(before);
  });
});

describe("the transport's video rewrite", () => {
  const sentinel = `⟦tavi-video:${"a".repeat(32)}⟧`;
  const video = { mediaType: "video/mp4", data: new Uint8Array([1, 2, 3]) };
  const lookup = (key: string) => (key === sentinel ? video : undefined);
  const body = (messages: unknown[]): string => JSON.stringify({ model: "m", messages });

  it("replaces a person's message's exact sentinel part, or its whole string content, and nothing else", () => {
    const parts = JSON.parse(
      withVideoParts(
        body([
          {
            role: "user",
            content: [
              { type: "text", text: "The video:" },
              { type: "text", text: sentinel, extra: 1 },
            ],
          },
        ]),
        lookup,
      ) ?? "{}",
    ) as { messages: { content: unknown[] }[] };
    expect(parts.messages[0]?.content[1]).toEqual({ type: "video_url", video_url: { url: "data:video/mp4;base64,AQID" } });
    const whole = JSON.parse(withVideoParts(body([{ role: "user", content: sentinel }]), lookup) ?? "{}") as {
      messages: { content: unknown[] }[];
    };
    expect(whole.messages[0]?.content).toEqual([{ type: "video_url", video_url: { url: "data:video/mp4;base64,AQID" } }]);
    expect(withVideoParts(body([{ role: "user", content: "no video here" }]), lookup)).toBeUndefined();
  });

  it("fails a request whose sentinel is inside other text, in a tool result or another turn, or has no video behind it", () => {
    for (const messages of [
      [{ role: "user", content: [{ type: "text", text: `look ${sentinel}` }] }],
      [{ role: "tool", tool_call_id: "c", content: sentinel }],
      [{ role: "assistant", content: sentinel }],
      [{ role: "user", content: [{ type: "text", text: `⟦tavi-video:${"b".repeat(32)}⟧` }] }],
    ])
      expect(() => withVideoParts(body(messages), lookup), JSON.stringify(messages)).toThrow(VideoSentinelError);
  });

  it("runs before the prompt-cache breakpoints, so none lands on a video part", () => {
    const rewritten = withVideoParts(
      body([
        { role: "system", content: "s" },
        {
          role: "user",
          content: [
            { type: "text", text: "The video:" },
            { type: "text", text: sentinel },
          ],
        },
      ]),
      lookup,
    );
    const cached =
      withPromptCacheBreakpoints(
        "https://openrouter.ai/api/v1/chat/completions",
        rewritten?.replace('"model":"m"', '"model":"anthropic/claude-x"'),
      ) ?? rewritten;
    const parsed = JSON.parse(cached ?? "{}") as { messages: { content: { type: string; cache_control?: unknown }[] }[] };
    const videoPart = parsed.messages[1]?.content.find((part) => part.type === "video_url");
    expect(videoPart).toBeDefined();
    expect(videoPart?.cache_control).toBeUndefined();
  });
});

describe("the Responses wire (Sign in with ChatGPT)", () => {
  it("sends only what the preview takes: store false, a stream, instructions in place of a system message, no temperature or output cap", async () => {
    const sent: { url: string; body: Record<string, unknown>; authorization: string | null }[] = [];
    const events = [
      { type: "response.created", response: { id: "resp_1", created_at: 0, model: "gpt-x" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Hello", annotations: [] }] },
      },
      {
        type: "response.completed",
        response: { id: "resp_1", created_at: 0, model: "gpt-x", incomplete_details: null, usage: { input_tokens: 3, output_tokens: 1 } },
      },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    const adapter = createAiSdkModelAdapter({
      connections: [
        {
          connectionId: "chatgpt",
          kind: "openai-compatible",
          baseUrl: "https://api.openai.example/v1",
          credentialRef: "chatgpt",
          wireApi: "responses",
        },
      ],
      readSecret: async () => "access-token",
      fetch: async (input, init) => {
        sent.push({
          url: String(input),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return new Response(events, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    await adapter.stream(
      request({
        connectionId: "chatgpt",
        model: "gpt-x",
        temperature: 0.2,
        maxOutputTokens: 64,
        messages: [
          { id: "s1", role: "system", text: "Be brief.", createdAt: "2026-01-01T00:00:00.000Z" },
          { id: "m1", role: "user", text: "hi", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      }),
      { signal: new AbortController().signal, onEvent: () => {} },
    );
    expect(sent).toHaveLength(1);
    const [call] = sent;
    expect(call?.url).toBe("https://api.openai.example/v1/responses");
    expect(call?.authorization).toBe("Bearer access-token");
    expect(call?.body).toMatchObject({ model: "gpt-x", store: false, stream: true, instructions: "Be brief." });
    for (const field of [
      "temperature",
      "max_output_tokens",
      "previous_response_id",
      "background",
      "metadata",
      "user",
      "truncation",
      "top_p",
    ])
      expect(call?.body, field).not.toHaveProperty(field);
    const input = call?.body["input"] as readonly { role?: string }[];
    expect(input.some((item) => item.role === "system")).toBe(false);
  });
});

describe("a ChatGPT plan's refusals", () => {
  it("reads OpenAI's plan codes by their meaning, not their status", async () => {
    const { toModelError } = await import("../src/models/models.js");
    const refused = (status: number, code: string) =>
      Object.assign(new Error(`${String(status)}`), { statusCode: status, responseBody: JSON.stringify({ error: { code } }) });
    expect(toModelError(refused(429, "subscription_sharing_usage_limit_exceeded"))).toMatchObject({
      code: "quota_exceeded",
      retryable: false,
    });
    expect(toModelError(refused(403, "subscription_sharing_user_not_eligible"))).toMatchObject({
      code: "invalid_request",
      retryable: false,
    });
    expect(toModelError(refused(403, "chatpass_v2_scope_not_authorized"))).toMatchObject({ code: "invalid_request", retryable: false });
    expect(toModelError(refused(503, "subscription_sharing_usage_unavailable"))).toMatchObject({ code: "provider", retryable: true });
    expect(toModelError(refused(401, "subscription_sharing_invalid_user"))).toMatchObject({ code: "auth" });
    expect(toModelError(refused(400, "subscription_sharing_unsupported_capability"))).toMatchObject({ code: "invalid_request" });
  });
});

describe("a provider stream that stalls", () => {
  const encoder = new TextEncoder();
  /** Headers, then `frames`, then nothing ever again: a body that never closes and ignores cancellation. */
  const stalling = (frames: readonly unknown[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  const adapterOn = (respond: () => Response, timeouts: { streamFirstByteSeconds?: number; streamIdleSeconds?: number } = {}) => {
    let calls = 0;
    const adapter = createAiSdkModelAdapter({
      connections: [
        { connectionId: "fixture", kind: "openai-compatible", baseUrl: "https://fixture.invalid/v1", credentialRef: "k", ...timeouts },
        { connectionId: "backup", kind: "openai-compatible", baseUrl: "https://backup.invalid/v1", credentialRef: "k" },
      ],
      readSecret: async () => "test-key",
      fetch: fakeFetch(async (url) => {
        calls += 1;
        return url.startsWith("https://backup.invalid")
          ? new Response(sse([textChunk("from the backup", null), textChunk("", "stop")]), {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            })
          : respond();
      }),
    });
    return { adapter, calls: () => calls };
  };
  /** Settles `promise` under fake timers, reporting whether it settled by `ms`. */
  const settledBy = async <T>(promise: Promise<T>, ms: number): Promise<boolean> => {
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(ms);
    return settled;
  };

  it("fails over after the first-byte deadline when the provider sends headers and nothing more", async () => {
    vi.useFakeTimers();
    try {
      const { adapter } = adapterOn(() => stalling([]));
      const pending = adapter.stream(request(), { signal: new AbortController().signal, onEvent: () => {} });
      expect(await settledBy(pending, 59_000)).toBe(false);
      expect(await settledBy(pending, 1_500)).toBe(true);
      const outcome = await pending;
      // `provider` and retryable: what a turn's fallback chain moves on from, unlike the abort it is carried by.
      expect(outcome).toMatchObject({ status: "failed", error: { code: "provider", retryable: true } });
      expect(outcome.error?.message).toContain("60 s");

      // The turn's next target answers as usual.
      const next = await adapter.stream(request({ connectionId: "backup" }), { signal: new AbortController().signal, onEvent: () => {} });
      expect(next).toMatchObject({ status: "completed", text: "from the backup" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails over after the idle deadline when a reply goes quiet mid-stream, keeping what it sent", async () => {
    vi.useFakeTimers();
    try {
      const { adapter } = adapterOn(() => stalling([textChunk("half an ans", null)]));
      const pending = adapter.stream(request(), { signal: new AbortController().signal, onEvent: () => {} });
      expect(await settledBy(pending, 89_000)).toBe(false);
      expect(await settledBy(pending, 1_500)).toBe(true);
      expect(await pending).toMatchObject({
        status: "failed",
        text: "half an ans",
        error: { code: "provider", retryable: true, message: expect.stringContaining("90 s") },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits longer for a reasoning call's first output, and as long as the connection says", async () => {
    vi.useFakeTimers();
    try {
      const reasoning = adapterOn(() => stalling([])).adapter.stream(request({ reasoningEffort: "high" }), {
        signal: new AbortController().signal,
        onEvent: () => {},
      });
      expect(await settledBy(reasoning, 179_000)).toBe(false);
      expect(await settledBy(reasoning, 1_500)).toBe(true);

      const configured = adapterOn(() => stalling([textChunk("a", null)]), { streamFirstByteSeconds: 5, streamIdleSeconds: 10 }).adapter;
      const quick = configured.stream(request(), { signal: new AbortController().signal, onEvent: () => {} });
      expect(await settledBy(quick, 9_000)).toBe(false);
      expect(await settledBy(quick, 1_500)).toBe(true);
      expect((await quick).error?.message).toContain("10 s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a slow reply run past the idle deadline while each chunk, a tool call's arguments among them, comes within it", async () => {
    vi.useFakeTimers();
    try {
      const toolDelta = (delta: Record<string, unknown>, finish: string | null) => ({
        id: "chatcmpl-slow",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      const frames = [
        toolDelta(
          {
            role: "assistant",
            tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "fixture.echo", arguments: "" } }],
          },
          null,
        ),
        toolDelta({ tool_calls: [{ index: 0, function: { arguments: '{"message":' } }] }, null),
        toolDelta({ tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] }, null),
        toolDelta({}, "tool_calls"),
      ];
      // One frame every 60 s: four minutes in all, each gap inside the 90 s idle deadline.
      const paced = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              for (const frame of frames) {
                await new Promise((resolve) => setTimeout(resolve, 60_000));
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      const pending = adapterOn(paced, { streamFirstByteSeconds: 90 }).adapter.stream(
        request({
          tools: [
            {
              id: "fixture.echo",
              name: "fixture_echo",
              description: "Echo",
              inputJsonSchema: z.toJSONSchema(z.object({ message: z.string() }), { io: "input" }),
            },
          ],
        }),
        { signal: new AbortController().signal, onEvent: () => {} },
      );
      expect(await settledBy(pending, 241_000)).toBe(true);
      expect(await pending).toMatchObject({ status: "completed", toolCalls: [{ id: "call-1", input: { message: "hi" } }] });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still reports the caller's abort of a stalled stream as an abort, at once", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = adapterOn(() => stalling([textChunk("a", null)])).adapter.stream(request(), {
        signal: controller.signal,
        onEvent: () => {},
      });
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      expect(await settledBy(pending, 10)).toBe(true);
      expect(await pending).toMatchObject({ status: "aborted", error: { code: "aborted" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("chooses the deadlines from the connection, else from whether the call reasons first", () => {
    expect(streamDeadlinesOf({}, { model: "fixture-model" })).toEqual({ firstByteMs: 60_000, idleMs: 90_000 });
    expect(streamDeadlinesOf({}, { model: "fixture-model", reasoningEffort: "low" })).toEqual({ firstByteMs: 180_000, idleMs: 90_000 });
    expect(streamDeadlinesOf({}, { model: "openai/gpt-5.5" }).firstByteMs).toBe(180_000);
    expect(streamDeadlinesOf({}, { model: "claude-opus-5-5" }).firstByteMs).toBe(180_000);
    expect(streamDeadlinesOf({}, { model: "anthropic/claude-opus-5-5" }).firstByteMs).toBe(180_000);
    expect(streamDeadlinesOf({ streamFirstByteSeconds: 30, streamIdleSeconds: 20 }, { model: "o3" })).toEqual({
      firstByteMs: 30_000,
      idleMs: 20_000,
    });
  });
});
