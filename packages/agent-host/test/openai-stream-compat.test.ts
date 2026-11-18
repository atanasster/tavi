import { describe, expect, it, vi } from "vitest";
import { fakeFetch } from "@tavi/test-support";

import {
  createOpenAiCompatibleTransport,
  observedFetch,
  promptTextChars,
  truncatedPromptReason,
  type WireObservation,
} from "../src/models/openai-stream-compat.js";

/**
 * The OpenAI-compatible transport shim.
 *
 * Both halves have the same contract — add only what is missing, change nothing
 * else — so the tests are as much about what it *does not* do: a conformant
 * provider, a non-stream response, an unknown tool-call id and a malformed line
 * must all pass through untouched. The second half additionally has to avoid
 * attaching a signature to the *wrong* call, which is why the scoping and age
 * tests below exist.
 */

function sseResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function bodyText(response: Response): Promise<string> {
  return await response.text();
}

function fetchReturning(response: Response): typeof globalThis.fetch {
  return vi.fn(fakeFetch(async () => response));
}

const GEMINI_DELTA = JSON.stringify({
  choices: [
    {
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [
          {
            extra_content: { google: { thought_signature: "sig" } },
            function: { arguments: '{"lookbackDays":7}', name: "reports_generate" },
            id: "call_142633",
            type: "function",
          },
        ],
      },
    },
  ],
});

describe("createOpenAiCompatibleTransport", () => {
  it("adds the missing index a provider omits, preserving everything else in the delta", async () => {
    const shimmed = createOpenAiCompatibleTransport(fetchReturning(sseResponse(`data: ${GEMINI_DELTA}\n\ndata: [DONE]\n\n`)));
    const text = await bodyText(await shimmed("https://example.test/chat/completions", { method: "POST" }));

    expect(text).toContain("data: [DONE]");
    const payload = JSON.parse(text.split("\n")[0]?.slice("data: ".length) ?? "") as {
      choices: { delta: { tool_calls: Record<string, unknown>[] } }[];
    };
    expect(payload.choices[0]?.delta.tool_calls[0]?.["index"]).toBe(0);
    // The Gemini-specific passthrough must survive: dropping it would lose the
    // thought signature the provider requires on the follow-up turn.
    expect(payload.choices[0]?.delta.tool_calls[0]?.["extra_content"]).toEqual({ google: { thought_signature: "sig" } });
    expect(payload.choices[0]?.delta.tool_calls[0]?.["id"]).toBe("call_142633");
  });

  it("numbers several tool calls in one delta by their position", async () => {
    const delta = JSON.stringify({
      choices: [{ index: 0, delta: { tool_calls: [{ function: { name: "a" } }, { function: { name: "b" } }] } }],
    });
    const shimmed = createOpenAiCompatibleTransport(fetchReturning(sseResponse(`data: ${delta}\n`)));
    const payload = JSON.parse((await bodyText(await shimmed("https://example.test", {}))).slice("data: ".length)) as {
      choices: { delta: { tool_calls: { index: number }[] } }[];
    };
    expect(payload.choices[0]?.delta.tool_calls.map((call) => call.index)).toEqual([0, 1]);
  });

  it("leaves an index the provider did send exactly as it was", async () => {
    const delta = JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 3, function: { name: "a" } }] } }] });
    const shimmed = createOpenAiCompatibleTransport(fetchReturning(sseResponse(`data: ${delta}\n`)));
    const text = await bodyText(await shimmed("https://example.test", {}));
    // Byte-identical: a re-serialized line would be a needless difference to
    // discover later.
    expect(text).toBe(`data: ${delta}\n`);
  });

  it("passes a non-streaming response through untouched", async () => {
    const json = JSON.stringify({ choices: [{ message: { content: "hi" } }] });
    const response = new Response(json, { status: 200, headers: { "content-type": "application/json" } });
    const shimmed = createOpenAiCompatibleTransport(fetchReturning(response));
    const out = await shimmed("https://example.test", {});
    expect(out).toBe(response);
    expect(await out.text()).toBe(json);
  });

  it("preserves status and headers on a stream it does rewrite", async () => {
    const response = new Response(`data: ${GEMINI_DELTA}\n`, {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/event-stream", "x-request-id": "abc" },
    });
    const shimmed = createOpenAiCompatibleTransport(fetchReturning(response));
    const out = await shimmed("https://example.test", {});
    expect(out.status).toBe(200);
    expect(out.headers.get("x-request-id")).toBe("abc");
    expect(out.headers.get("content-type")).toBe("text/event-stream");
  });

  it("drops a stale content-length, which would otherwise truncate the lengthened body", async () => {
    const body = `data: ${GEMINI_DELTA}\n`;
    const response = new Response(body, {
      headers: { "content-type": "text/event-stream", "content-length": String(new TextEncoder().encode(body).length) },
    });
    const shimmed = createOpenAiCompatibleTransport(fetchReturning(response));
    const out = await shimmed("https://example.test", {});
    // Patching adds characters, so the provider's length is now wrong; the body
    // is a stream and its length belongs to the runtime's chunked encoding.
    expect(out.headers.get("content-length")).toBeNull();
    const text = await out.text();
    expect(text.length).toBeGreaterThan(body.length);
    expect(JSON.parse(text.split("\n")[0]?.slice("data: ".length) ?? "")).toHaveProperty("choices");
  });

  it("repairs a data line split across two network chunks", async () => {
    // The realistic shape: an SSE line arrives in pieces, and patching half a
    // JSON object would corrupt the stream this exists to fix.
    const first = `data: ${GEMINI_DELTA.slice(0, 40)}`;
    const second = `${GEMINI_DELTA.slice(40)}\n\ndata: [DONE]\n\n`;
    const response = new Response(streamOf(first, second), { headers: { "content-type": "text/event-stream" } });
    const shimmed = createOpenAiCompatibleTransport(fetchReturning(response));
    const text = await bodyText(await shimmed("https://example.test", {}));
    const payload = JSON.parse(text.split("\n")[0]?.slice("data: ".length) ?? "") as {
      choices: { delta: { tool_calls: { index: number }[] } }[];
    };
    expect(payload.choices[0]?.delta.tool_calls[0]?.index).toBe(0);
    expect(text).toContain("data: [DONE]");
  });

  it("forwards non-JSON, comment and keepalive lines without interpreting them", async () => {
    const body = ": keepalive\n\ndata: [DONE]\n\ndata: not-json\n\n";
    const shimmed = createOpenAiCompatibleTransport(fetchReturning(sseResponse(body)));
    expect(await bodyText(await shimmed("https://example.test", {}))).toBe(body);
  });

  it("leaves a delta with no tool calls alone and does not invent one", async () => {
    const delta = JSON.stringify({ choices: [{ index: 0, delta: { content: "hello" } }] });
    const shimmed = createOpenAiCompatibleTransport(fetchReturning(sseResponse(`data: ${delta}\n`)));
    const text = await bodyText(await shimmed("https://example.test", {}));
    expect(text).toBe(`data: ${delta}\n`);
    expect(text).not.toContain("tool_calls");
  });

  it("handles a CRLF-delimited stream without leaving stray carriage returns", async () => {
    const shimmed = createOpenAiCompatibleTransport(fetchReturning(sseResponse(`data: ${GEMINI_DELTA}\r\n\r\ndata: [DONE]\r\n\r\n`)));
    const text = await bodyText(await shimmed("https://example.test", {}));
    expect(text).toContain("data: [DONE]\r\n");
    // The patched line keeps its own CRLF, and the patch still lands.
    const firstLine = text.split("\r\n")[0] ?? "";
    expect(firstLine).not.toContain("\n");
    const payload = JSON.parse(firstLine.slice("data: ".length)) as { choices: { delta: { tool_calls: { index: number }[] } }[] };
    expect(payload.choices[0]?.delta.tool_calls[0]?.index).toBe(0);
  });

  it("echoes a captured thought_signature back on the assistant tool-call message", async () => {
    // The blocker this exists for: Gemini rejects the follow-up
    // request unless the assistant message repeats the signature it sent, and
    // the AI SDK drops the non-standard `extra_content` field.
    const requests: string[] = [];
    const inner = fakeFetch(async (_input, init) => {
      requests.push(String(init?.body ?? ""));
      // First call streams the tool call (carrying the signature); every later
      // call is the follow-up request.
      if (requests.length === 1) return sseResponse(`data: ${GEMINI_DELTA}\n`);
      return sseResponse("data: [DONE]\n");
    });
    const transport = createOpenAiCompatibleTransport(inner);

    // The stream must be *consumed* for the signature to be captured: capture
    // happens in the body transform, which the AI SDK drives to completion
    // before it issues the follow-up request.
    await (
      await transport("https://example.test/chat/completions", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "go" }] }),
      })
    ).text();
    // Exactly the body shape the AI SDK sends for the second turn (captured live).
    await transport("https://example.test/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_142633", type: "function", function: { name: "reports_generate", arguments: '{"lookbackDays":7}' } }],
          },
          { role: "tool", tool_call_id: "call_142633", content: "{}" },
        ],
      }),
    });

    const followUp = JSON.parse(requests[1] ?? "{}") as {
      messages: { role: string; tool_calls?: { id: string; extra_content?: unknown; function: unknown }[] }[];
    };
    const assistant = followUp.messages.find((message) => message.role === "assistant");
    expect(assistant?.tool_calls?.[0]?.extra_content).toEqual({ google: { thought_signature: "sig" } });
    // Everything the SDK produced is still there, byte for byte.
    expect(assistant?.tool_calls?.[0]?.function).toEqual({ name: "reports_generate", arguments: '{"lookbackDays":7}' });
    expect(followUp.messages.find((message) => message.role === "tool")).toEqual({
      role: "tool",
      tool_call_id: "call_142633",
      content: "{}",
    });
  });

  it("leaves a request alone when no signature was captured, and when the id is unknown", async () => {
    // Assert on what the transport actually sent, never on the local string the
    // caller built: the shim returns a new body and never mutates the original,
    // so checking the original would pass no matter what happened.
    const sent: string[] = [];
    const inner = fakeFetch(async (_input, init) => {
      const body = String(init?.body ?? "");
      sent.push(body);
      return body.includes("please-stream")
        ? sseResponse(`data: ${GEMINI_DELTA}\n`)
        : new Response(JSON.stringify({ choices: [] }), { headers: { "content-type": "application/json" } });
    });
    const transport = createOpenAiCompatibleTransport(inner);

    // No stream has run yet, so nothing was captured.
    const noCapture = JSON.stringify({ messages: [{ role: "assistant", tool_calls: [{ id: "call_x" }] }] });
    await transport("https://example.test", { method: "POST", body: noCapture });
    expect(sent[0]).toBe(noCapture);

    // Capture one signature (for `call_142633`), then send a request naming a
    // different call: the signature must not be sprayed onto it.
    await (await transport("https://example.test", { method: "POST", body: JSON.stringify({ note: "please-stream" }) })).text();
    const unrelated = JSON.stringify({ messages: [{ role: "assistant", tool_calls: [{ id: "call_other" }] }] });
    await transport("https://example.test", { method: "POST", body: unrelated });
    expect(sent.at(-1)).toBe(unrelated);
    expect(sent.at(-1)).not.toContain("extra_content");
  });

  it("never overwrites an extra_content the provider's own client already sent", async () => {
    const bodies: string[] = [];
    const inner = fakeFetch(async (_input, init) => {
      bodies.push(String(init?.body ?? ""));
      return bodies.length === 1
        ? sseResponse(`data: ${GEMINI_DELTA}\n`)
        : new Response("", { headers: { "content-type": "text/event-stream" } });
    });
    const transport = createOpenAiCompatibleTransport(inner);
    await (await transport("https://example.test", { method: "POST", body: JSON.stringify({ messages: [] }) })).text();
    const body = JSON.stringify({
      messages: [{ role: "assistant", tool_calls: [{ id: "call_142633", extra_content: { google: { thought_signature: "theirs" } } }] }],
    });
    await transport("https://example.test", { method: "POST", body });
    expect(bodies[1]).toBe(body);
  });

  it("refuses a signature older than its usable age, so a finished conversation cannot leak into a later one", async () => {
    // Provider tool-call ids are counter-like, so a later conversation can be
    // assigned the same id; without an age bound the old signature would be
    // re-attached and the provider would reject it as invalid.
    let clock = 1_000_000;
    const requested: string[] = [];
    const inner = fakeFetch(async (_input, init) => {
      const body = String(init?.body ?? "");
      requested.push(body);
      return body.includes("please-stream")
        ? sseResponse(`data: ${GEMINI_DELTA}\n`)
        : new Response("", { headers: { "content-type": "text/event-stream" } });
    });
    const transport = createOpenAiCompatibleTransport(inner, { toolCallExtraMaxAgeMs: 60_000, now: () => clock });

    await (await transport("https://example.test", { method: "POST", body: JSON.stringify({ note: "please-stream" }) })).text();
    clock += 60_001;
    await transport("https://example.test", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "assistant", tool_calls: [{ id: "call_142633", function: { name: "reports_generate" } }] }],
      }),
    });
    const sent = JSON.parse(requested.at(-1) ?? "{}") as { messages: { tool_calls: { extra_content?: unknown }[] }[] };
    expect(sent.messages[0]?.tool_calls[0]?.extra_content).toBeUndefined();
  });

  it("keeps a signature alive while the conversation keeps re-sending the call", async () => {
    let clock = 1_000_000;
    const requested: string[] = [];
    const transport = createOpenAiCompatibleTransport(
      fakeFetch(async (_input, init) => {
        const body = String(init?.body ?? "");
        requested.push(body);
        return body.includes("please-stream")
          ? sseResponse(`data: ${GEMINI_DELTA}\n`)
          : new Response("", { headers: { "content-type": "text/event-stream" } });
      }),
      { toolCallExtraMaxAgeMs: 60_000, now: () => clock },
    );
    await (await transport("https://example.test", { method: "POST", body: JSON.stringify({ note: "please-stream" }) })).text();

    // Re-sent repeatedly, each time just inside the age bound: refresh-on-use
    // must keep it alive rather than letting capture age evict a live call.
    for (let turn = 0; turn < 3; turn += 1) {
      clock += 50_000;
      await transport("https://example.test", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "assistant", tool_calls: [{ id: "call_142633", function: { name: "reports_generate" } }] }],
        }),
      });
      const sent = JSON.parse(requested.at(-1) ?? "{}") as { messages: { tool_calls: { extra_content?: unknown }[] }[] };
      expect(sent.messages[0]?.tool_calls[0]?.extra_content, `turn ${turn}`).toBeDefined();
    }
  });

  it("never attaches a signature to a different tool that reuses the id", async () => {
    const requested: string[] = [];
    const inner = fakeFetch(async (_input, init) => {
      const body = String(init?.body ?? "");
      requested.push(body);
      return body.includes("please-stream")
        ? sseResponse(`data: ${GEMINI_DELTA}\n`)
        : new Response("", { headers: { "content-type": "text/event-stream" } });
    });
    const transport = createOpenAiCompatibleTransport(inner);
    await (await transport("https://example.test", { method: "POST", body: JSON.stringify({ note: "please-stream" }) })).text();
    // Same id, different tool: a recycled id must not pick up the old signature.
    await transport("https://example.test", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "assistant", tool_calls: [{ id: "call_142633", function: { name: "stripe_subscriptions" } }] }],
      }),
    });
    const sent = JSON.parse(requested.at(-1) ?? "{}") as { messages: { tool_calls: { extra_content?: unknown }[] }[] };
    expect(sent.messages[0]?.tool_calls[0]?.extra_content).toBeUndefined();
  });

  it("binds a signature that arrives on a different fragment than its id", async () => {
    // The provider splits one tool call across deltas — the same behaviour that
    // makes the `index` fix necessary — so the two fields can arrive separately.
    const requested: string[] = [];
    const idFragment = JSON.stringify({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_split", function: { name: "reports_generate" } }] } }],
    });
    const extraFragment = JSON.stringify({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, extra_content: { google: { thought_signature: "split-sig" } } }] } }],
    });
    const inner = fakeFetch(async (_input, init) => {
      const body = String(init?.body ?? "");
      requested.push(body);
      return body.includes("please-stream")
        ? sseResponse(`data: ${idFragment}\n\ndata: ${extraFragment}\n\ndata: [DONE]\n\n`)
        : new Response("", { headers: { "content-type": "text/event-stream" } });
    });
    const transport = createOpenAiCompatibleTransport(inner);
    await (await transport("https://example.test", { method: "POST", body: JSON.stringify({ note: "please-stream" }) })).text();
    await transport("https://example.test", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "assistant", tool_calls: [{ id: "call_split", function: { name: "reports_generate" } }] }],
      }),
    });
    const sent = JSON.parse(requested.at(-1) ?? "{}") as { messages: { tool_calls: { extra_content?: unknown }[] }[] };
    expect(sent.messages[0]?.tool_calls[0]?.extra_content).toEqual({ google: { thought_signature: "split-sig" } });
  });

  it("falls back to the default cap rather than letting a bad option disable the fix", async () => {
    const inner = fakeFetch(async (_input, init) =>
      String(init?.body ?? "").includes("please-stream")
        ? sseResponse(`data: ${GEMINI_DELTA}\n`)
        : new Response("", { headers: { "content-type": "text/event-stream" } }),
    );
    const requested: string[] = [];
    const transport = createOpenAiCompatibleTransport(
      fakeFetch(async (input, init) => {
        requested.push(String(init?.body ?? ""));
        return inner(input as Parameters<typeof globalThis.fetch>[0], init);
      }),
      // `0` would mean "retain nothing", i.e. silently no longer fix anything.
      { maxRetainedToolCallExtras: 0 },
    );
    await (await transport("https://example.test", { method: "POST", body: JSON.stringify({ note: "please-stream" }) })).text();
    await transport("https://example.test", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "assistant", tool_calls: [{ id: "call_142633", function: { name: "reports_generate" } }] }],
      }),
    });
    const sent = JSON.parse(requested.at(-1) ?? "{}") as { messages: { tool_calls: { extra_content?: unknown }[] }[] };
    expect(sent.messages[0]?.tool_calls[0]?.extra_content).toBeDefined();
  });

  it("bounds how many signatures it retains, evicting oldest-first so a long-lived adapter cannot grow without bound", async () => {
    const signatureFor = (id: string): Response =>
      sseResponse(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ id, extra_content: { sig: id } }] } }] })}\n`);
    const requested: string[] = [];
    const inner = fakeFetch(async (_input, init) => {
      const body = String(init?.body ?? "");
      requested.push(body);
      const marker = /"capture-(\w+)"/.exec(body);
      if (marker?.[1] !== undefined) return signatureFor(marker[1]);
      return new Response("", { headers: { "content-type": "text/event-stream" } });
    });
    const transport = createOpenAiCompatibleTransport(inner, { maxRetainedToolCallExtras: 1 });

    await (await transport("https://example.test", { method: "POST", body: JSON.stringify({ note: "capture-first" }) })).text();
    await (await transport("https://example.test", { method: "POST", body: JSON.stringify({ note: "capture-second" }) })).text();

    // Both are re-sent in one request, as a transcript would: only the most
    // recent signature survives the cap, and the older one is simply not
    // re-attached rather than being attached wrongly.
    await transport("https://example.test", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "assistant", tool_calls: [{ id: "first" }, { id: "second" }] }],
      }),
    });
    const sent = JSON.parse(requested.at(-1) ?? "{}") as {
      messages: { tool_calls: { id: string; extra_content?: unknown }[] }[];
    };
    const calls = sent.messages[0]?.tool_calls ?? [];
    expect(calls.find((call) => call.id === "second")?.extra_content).toEqual({ sig: "second" });
    expect(calls.find((call) => call.id === "first")?.extra_content).toBeUndefined();
  });

  it("forwards the request untouched, so the caller's abort signal and body still arrive", async () => {
    const inner = vi.fn(async () => sseResponse(""));
    const shimmed = createOpenAiCompatibleTransport(inner as unknown as typeof globalThis.fetch);
    const controller = new AbortController();
    await shimmed("https://example.test/chat", { method: "POST", body: "{}", signal: controller.signal });
    expect(inner).toHaveBeenCalledWith("https://example.test/chat", expect.objectContaining({ method: "POST", body: "{}" }));
  });
});

describe("observedFetch", () => {
  const request = JSON.stringify({
    model: "openai/gpt-5.6",
    messages: [
      { role: "system", content: "You are Tavi." },
      { role: "user", content: "Hi." },
    ],
  });

  it("records the request's prefix hash and whether the streamed usage reported the cache, and strips its key from the request", async () => {
    const inner = vi.fn(
      fakeFetch(async () =>
        sseResponse(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, prompt_tokens_details: { cached_tokens: 8 } } })}\n\n` +
            "data: [DONE]\n\n",
        ),
      ),
    );
    const observation: WireObservation = {};
    const response = await observedFetch(createOpenAiCompatibleTransport(inner), observation)("https://example.test/chat", {
      method: "POST",
      body: request,
    });
    await bodyText(response);
    expect(observation.prefixHash).toMatch(/^[0-9a-f]{16}$/);
    expect(observation.cacheUsageReported).toBe(true);
    const sent = inner.mock.calls[0]?.[1] as Record<PropertyKey, unknown>;
    expect(Object.getOwnPropertySymbols(sent)).toEqual([]);
  });

  it("records a usage without cache counts as not reported", async () => {
    const inner = fetchReturning(
      sseResponse(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 1 } })}\n\n`),
    );
    const observation: WireObservation = {};
    await bodyText(
      await observedFetch(createOpenAiCompatibleTransport(inner), observation)("https://example.test/chat", { body: request }),
    );
    expect(observation.cacheUsageReported).toBe(false);
  });

  it("leaves the observation alone for a body that is not a chat request and a response that is not a stream", async () => {
    const inner = fetchReturning(new Response("{}", { headers: { "content-type": "application/json" } }));
    const observation: WireObservation = {};
    await observedFetch(createOpenAiCompatibleTransport(inner), observation)("https://example.test/embed", { body: "{}" });
    expect(observation).toEqual({});
  });
});

describe("a prompt the server cut", () => {
  it("counts a body's message text and tools, never an image's bytes", () => {
    const body = JSON.stringify({
      messages: [
        { role: "system", content: "abcd" },
        {
          role: "user",
          content: [
            { type: "text", text: "ef" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(5000)}` } },
          ],
        },
      ],
      tools: [{ type: "function" }],
    });
    expect(promptTextChars(body)).toBe(6 + JSON.stringify([{ type: "function" }]).length);
    expect(promptTextChars("not json")).toBeUndefined();
  });

  it("explains a count far under what was sent, and lets a plausible or short one be", () => {
    expect(truncatedPromptReason(2051, 110_000)).toContain("Raise the server's context length to 64K or more");
    expect(truncatedPromptReason(25_000, 110_000)).toBeUndefined();
    expect(truncatedPromptReason(10, 12_000)).toBeUndefined();
    expect(truncatedPromptReason(undefined, 110_000)).toBeUndefined();
  });
});
