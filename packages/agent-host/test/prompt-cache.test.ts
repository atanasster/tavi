import { CONTEXT_MESSAGE_HEAD } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { createOpenAiCompatibleTransport } from "../src/models/openai-stream-compat.js";
import {
  openaiExplicitCacheModel,
  usageReportsCache,
  wirePrefixHash,
  withPromptCacheBreakpoints,
  withSessionId,
} from "../src/models/prompt-cache.js";

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
const BREAKPOINT = { type: "ephemeral" };

function body(model: string, messages: readonly unknown[]): string {
  return JSON.stringify({ model, messages, tools: [{ type: "function", function: { name: "browser_read" } }] });
}

const loop = [
  { role: "system", content: "You are Tavi." },
  { role: "user", content: "Find the news." },
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "browser_read", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c1", content: '{"text":"article"}' },
  { role: "user", content: "Step 2 of 24." },
];

describe("prompt-cache breakpoints (withPromptCacheBreakpoints)", () => {
  it("marks the last tool schema, the system message and the newest message the next call carries — never the trailing step note — for an Anthropic model on OpenRouter", () => {
    const marked = JSON.parse(withPromptCacheBreakpoints(OPENROUTER, body("anthropic/claude-sonnet-5.5", loop)) ?? "null");
    expect(marked.messages).toEqual([
      { role: "system", content: [{ type: "text", text: "You are Tavi.", cache_control: BREAKPOINT }] },
      { role: "user", content: "Find the news." },
      loop[2],
      { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: '{"text":"article"}', cache_control: BREAKPOINT }] },
      // The per-call step note: the next call no longer carries it, so a breakpoint here would write a prefix nobody reads.
      { role: "user", content: "Step 2 of 24." },
    ]);
    // The tool schemas' own breakpoint: after the tool schemas, on the last one.
    expect(marked.tools).toEqual([{ type: "function", function: { name: "browser_read" }, cache_control: BREAKPOINT }]);
  });

  it("marks the end of the stable history, the message before the one the context block rides in, so a turn reads the history back rather than writing it again", () => {
    const history = [
      { role: "system", content: "You are Tavi." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ];
    const person = {
      role: "user",
      content: `${CONTEXT_MESSAGE_HEAD}\nRetrieved memory: lives in Lisbon\n[/context]\n\nFind the news.\n\nStep 1 of 24.`,
    };
    // A turn's first call: the end of the history is also the newest message the next call carries, so three in all.
    const first = JSON.parse(withPromptCacheBreakpoints(OPENROUTER, body("anthropic/claude-sonnet-5.5", [...history, person])) ?? "null");
    expect(first.messages[2]).toEqual({ role: "assistant", content: [{ type: "text", text: "Hello", cache_control: BREAKPOINT }] });
    expect(first.messages[3]).toEqual(person);
    expect(JSON.stringify(first).match(/"cache_control"/g)).toHaveLength(3);
    // A later call of the turn: the history's end, and the step's tool loop, with the tools and the system: four.
    const later = JSON.parse(
      withPromptCacheBreakpoints(
        OPENROUTER,
        body("anthropic/claude-sonnet-5.5", [
          ...history,
          { ...person, content: person.content.replace("\n\nStep 1 of 24.", "") },
          ...loop.slice(2),
        ]),
      ) ?? "null",
    );
    expect(later.messages[2].content[0].cache_control).toEqual(BREAKPOINT);
    expect(later.messages[5].content[0].cache_control).toEqual(BREAKPOINT);
    expect(later.messages[3].content).toEqual(expect.any(String));
    expect(later.messages[6]).toEqual(loop[4]);
    expect(JSON.stringify(later).match(/"cache_control"/g)).toHaveLength(4);
  });

  it("puts the tool breakpoint on the last of several tools, and never more than four in all", () => {
    const messages = [
      { role: "system", content: "S" },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: `${CONTEXT_MESSAGE_HEAD}\n[/context]\n\nGo.` },
      ...loop.slice(2),
    ];
    const request = JSON.stringify({
      model: "anthropic/claude-sonnet-5.5",
      messages,
      tools: [
        { type: "function", function: { name: "a" } },
        { type: "function", function: { name: "b" } },
      ],
    });
    const marked = JSON.parse(withPromptCacheBreakpoints(OPENROUTER, request) ?? "null");
    expect(marked.tools).toEqual([
      { type: "function", function: { name: "a" } },
      { type: "function", function: { name: "b" }, cache_control: BREAKPOINT },
    ]);
    expect(JSON.stringify(marked).match(/"cache_control"/g)).toHaveLength(4);
    // A request with no tools has the other three.
    const bare = JSON.parse(
      withPromptCacheBreakpoints(OPENROUTER, JSON.stringify({ model: "anthropic/claude-sonnet-5.5", messages })) ?? "null",
    );
    expect(bare.tools).toBeUndefined();
    expect(JSON.stringify(bare).match(/"cache_control"/g)).toHaveLength(3);
  });

  it("passes over a tool-call-only assistant turn and marks the last text part of an array", () => {
    const messages = [
      { role: "system", content: "S" },
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "image_url", image_url: { url: "data:x" } },
        ],
      },
      { role: "assistant", content: "", tool_calls: [] },
    ];
    const marked = JSON.parse(withPromptCacheBreakpoints(OPENROUTER, body("anthropic/claude-haiku-4.5", messages)) ?? "null");
    expect(marked.messages[1].content[0]).toEqual({ type: "text", text: "a", cache_control: BREAKPOINT });
    expect(marked.messages[2]).toEqual(messages[2]);
  });

  it("leaves every other request untouched", () => {
    expect(withPromptCacheBreakpoints(OPENROUTER, body("openai/gpt-4.1-mini", loop))).toBeUndefined();
    expect(
      withPromptCacheBreakpoints("https://gateway.example/v1/chat/completions", body("anthropic/claude-sonnet-5.5", loop)),
    ).toBeUndefined();
    expect(withPromptCacheBreakpoints(OPENROUTER, "not json anthropic/")).toBeUndefined();
    expect(withPromptCacheBreakpoints(OPENROUTER, undefined)).toBeUndefined();
  });

  it("is applied by the OpenAI-compatible transport", async () => {
    const sent: string[] = [];
    const transport = createOpenAiCompatibleTransport(async (_input, init) => {
      sent.push(String(init?.body));
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });
    await transport(OPENROUTER, { method: "POST", body: body("anthropic/claude-sonnet-5.5", loop) });
    await transport(new URL(OPENROUTER), { method: "POST", body: body("openai/gpt-4.1-mini", loop) });
    expect(JSON.parse(sent[0] ?? "{}").messages[0].content[0].cache_control).toEqual(BREAKPOINT);
    expect(sent[1]).toBe(body("openai/gpt-4.1-mini", loop));
  });
});

describe("wirePrefixHash", () => {
  it("hashes tools and the messages before the newest, and ignores how text parts are shaped", () => {
    const step1 = body("openai/gpt-5.6", loop);
    // The same prefix with the system text as a one-part array: a provider renders both alike.
    const reshaped = body("openai/gpt-5.6", [{ role: "system", content: [{ type: "text", text: "You are Tavi." }] }, ...loop.slice(1)]);
    expect(wirePrefixHash(step1)).toMatch(/^[0-9a-f]{16}$/);
    expect(wirePrefixHash(reshaped)).toBe(wirePrefixHash(step1));
    // The newest message is the call's own step note: a different one leaves the prefix alone.
    expect(wirePrefixHash(body("openai/gpt-5.6", [...loop.slice(0, -1), { role: "user", content: "Step 3 of 24." }]))).toBe(
      wirePrefixHash(step1),
    );
    // An earlier change does not.
    expect(wirePrefixHash(body("openai/gpt-5.6", [loop[0], { role: "user", content: "Find more news." }, ...loop.slice(2)]))).not.toBe(
      wirePrefixHash(step1),
    );
  });

  it("ends the prefix at the marked part of a message: the step facts after it are left out", () => {
    const withFacts = (facts: string) =>
      JSON.stringify({
        model: "anthropic/claude-sonnet-5-5",
        messages: [
          { role: "system", content: "You are Tavi." },
          {
            role: "user",
            content: [
              { type: "text", text: "find the news", cache_control: { type: "ephemeral" } },
              { type: "text", text: facts },
            ],
          },
        ],
      });
    expect(wirePrefixHash(withFacts("Step 1 of 24."))).toBe(wirePrefixHash(withFacts("Step 2 of 24.")));
  });

  it("ends the prefix at the last breakpoint when a message carries one, and leaves the breakpoint itself out", () => {
    const marked = withPromptCacheBreakpoints(OPENROUTER, body("anthropic/claude-sonnet-5-5", loop));
    expect(marked).toBeDefined();
    const hash = wirePrefixHash(marked);
    // Breakpoint 4 marks the tool result before the step note, so the prefix runs through it.
    expect(hash).toBe(wirePrefixHash(body("anthropic/claude-sonnet-5-5", loop)));
    const withTail = withPromptCacheBreakpoints(
      OPENROUTER,
      body("anthropic/claude-sonnet-5-5", [...loop, { role: "user", content: "More." }]),
    );
    expect(wirePrefixHash(withTail)).not.toBe(hash);
  });

  it("is undefined for a body that is not a JSON chat request", () => {
    expect(wirePrefixHash("not json")).toBeUndefined();
    expect(wirePrefixHash(JSON.stringify({ input: "embed me" }))).toBeUndefined();
    expect(wirePrefixHash(undefined)).toBeUndefined();
  });
});

describe("usageReportsCache", () => {
  it("is true for OpenAI-style, Responses-style and Anthropic cache counts, and false otherwise", () => {
    expect(usageReportsCache({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } })).toBe(true);
    expect(usageReportsCache({ input_tokens: 10, input_tokens_details: { cached_tokens: 4 } })).toBe(true);
    expect(usageReportsCache({ prompt_tokens: 10, prompt_tokens_details: { cache_write_tokens: 3 } })).toBe(true);
    expect(usageReportsCache({ input_tokens: 10, cache_read_input_tokens: 0 })).toBe(true);
    expect(usageReportsCache({ prompt_tokens: 10, completion_tokens: 2 })).toBe(false);
    expect(usageReportsCache({ prompt_tokens: 10, prompt_tokens_details: {} })).toBe(false);
    expect(usageReportsCache(null)).toBe(false);
  });
});

describe("part markers (models.promptLayout v2)", () => {
  const marked = (model: string) =>
    JSON.stringify({
      model,
      tools: [{ type: "function", function: { name: "browser_read" } }],
      messages: [
        { role: "system", content: "You are Tavi." },
        {
          role: "user",
          content: [
            { type: "text", text: "[context] …" },
            { type: "text", text: "Find the news.", prompt_cache_breakpoint: {} },
            { type: "text", text: "Step 1 of 24." },
          ],
        },
      ],
    });

  it("turns each into a cache_control breakpoint for an Anthropic model on OpenRouter, beside the tools' and the system's", () => {
    const sent = JSON.parse(withPromptCacheBreakpoints(OPENROUTER, marked("anthropic/claude-sonnet-5-5")) ?? "{}");
    expect(sent.tools.at(-1).cache_control).toEqual(BREAKPOINT);
    expect(sent.messages[0].content).toEqual([{ type: "text", text: "You are Tavi.", cache_control: BREAKPOINT }]);
    expect(sent.messages[1].content[1]).toEqual({ type: "text", text: "Find the news.", cache_control: BREAKPOINT });
    // The loop chose where the prefix ends: the step facts stay unmarked, and nothing else is.
    expect(sent.messages[1].content[2]).toEqual({ type: "text", text: "Step 1 of 24." });
    expect(JSON.stringify(sent)).not.toContain("prompt_cache_breakpoint");
  });

  it("leaves a v1 request that only mentions the marker's name to the v1 breakpoints", () => {
    const quoting = body("anthropic/claude-sonnet-5-5", [
      ...loop.slice(0, -1),
      { role: "user", content: "What does prompt_cache_breakpoint do?" },
    ]);
    const sent = JSON.parse(withPromptCacheBreakpoints(OPENROUTER, quoting) ?? "{}");
    // Breakpoint 4 on the tool result before the closing message, as v1 places it.
    expect(sent.messages[3].content).toEqual([{ type: "text", text: '{"text":"article"}', cache_control: BREAKPOINT }]);
  });

  it("sends a message without its marker in the shape an unmarked call sends it", () => {
    const sent = JSON.parse(
      withPromptCacheBreakpoints(
        "https://api.openai.com/v1/chat/completions",
        JSON.stringify({
          model: "gpt-5.5",
          messages: [
            { role: "assistant", content: [{ type: "text", text: "Looking.", prompt_cache_breakpoint: {} }], tool_calls: [] },
            { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "notes", prompt_cache_breakpoint: {} }] },
            { role: "user", content: [{ type: "text", text: "hi", prompt_cache_breakpoint: {} }] },
            {
              role: "user",
              content: [
                { type: "text", text: "[context]" },
                { type: "text", text: "hi", prompt_cache_breakpoint: {} },
              ],
            },
          ],
        }),
      ) ?? "{}",
    );
    expect(sent.messages.map((message: { content: unknown }) => message.content)).toEqual([
      "Looking.",
      "notes",
      "hi",
      [
        { type: "text", text: "[context]" },
        { type: "text", text: "hi" },
      ],
    ]);
  });

  it("drops them for any other provider, which may refuse a field it does not know", () => {
    for (const [url, model] of [
      [OPENROUTER, "openai/gpt-5.6"],
      // Before GPT-5.6, OpenAI's endpoint has no explicit breakpoints (from 5.6 on the markers are kept).
      ["https://api.openai.com/v1/chat/completions", "gpt-5.5"],
      ["http://localhost:11434/v1/chat/completions", "llama3"],
    ] as const) {
      const sent = withPromptCacheBreakpoints(url, marked(model)) ?? "";
      expect(sent, model).not.toContain("prompt_cache_breakpoint");
      expect(sent, model).not.toContain("cache_control");
      expect(JSON.parse(sent).messages[1].content[1]).toEqual({ type: "text", text: "Find the news." });
    }
  });
});

describe("a call's cache policy, Gemini on OpenRouter and the session id", () => {
  const HOUR = { type: "ephemeral", ttl: "1h" };

  it("marks nothing for a call whose prefix no later call reads, and only drops a loop's part markers", () => {
    expect(withPromptCacheBreakpoints(OPENROUTER, body("anthropic/claude-sonnet-5-5", loop), "none")).toBeUndefined();
    const partMarked = JSON.stringify({
      model: "anthropic/claude-sonnet-5-5",
      messages: [{ role: "user", content: [{ type: "text", text: "hi", prompt_cache_breakpoint: {} }] }],
    });
    expect(JSON.parse(withPromptCacheBreakpoints(OPENROUTER, partMarked, "none") ?? "{}").messages[0].content).toBe("hi");
  });

  it("keeps the tools and system text for an hour under the 1h policy, and the history for five minutes", () => {
    const sent = JSON.parse(withPromptCacheBreakpoints(OPENROUTER, body("anthropic/claude-sonnet-5-5", loop), "1h") ?? "{}");
    expect(sent.tools.at(-1).cache_control).toEqual(HOUR);
    expect(sent.messages[0].content[0].cache_control).toEqual(HOUR);
    expect(sent.messages[3].content[0].cache_control).toEqual(BREAKPOINT);
    // The loop's own marks too: tools and system for an hour, its part for five minutes, in that order.
    const partMarked = JSON.stringify({
      model: "anthropic/claude-sonnet-5-5",
      tools: [{ type: "function", function: { name: "notes_read" } }],
      messages: [
        { role: "system", content: "You are Tavi." },
        { role: "user", content: [{ type: "text", text: "hi", prompt_cache_breakpoint: {} }] },
      ],
    });
    const v2 = JSON.parse(withPromptCacheBreakpoints(OPENROUTER, partMarked, "1h") ?? "{}");
    expect(v2.tools[0].cache_control).toEqual(HOUR);
    expect(v2.messages[0].content[0].cache_control).toEqual(HOUR);
    expect(v2.messages[1].content[0].cache_control).toEqual(BREAKPOINT);
  });

  it("leaves a google/ model that is not Gemini, and any model when the preset takes no breakpoints, unmarked", () => {
    expect(withPromptCacheBreakpoints(OPENROUTER, body("google/gemma-3-27b", loop))).toBeUndefined();
    expect(withPromptCacheBreakpoints(OPENROUTER, body("anthropic/claude-sonnet-5-5", loop), undefined, false)).toBeUndefined();
  });

  it("gives a Gemini model on OpenRouter one breakpoint, at the newest message the next call carries", () => {
    const sent = JSON.parse(withPromptCacheBreakpoints(OPENROUTER, body("google/gemini-3-pro", loop)) ?? "{}");
    expect(sent.tools.at(-1).cache_control).toBeUndefined();
    expect(JSON.stringify(sent.messages.slice(0, 3))).not.toContain("cache_control");
    expect(sent.messages[3].content[0].cache_control).toEqual(BREAKPOINT);
    // Under v2 only the last of the loop's markers is kept.
    const twoMarks = JSON.stringify({
      model: "google/gemini-3-pro",
      messages: [
        { role: "user", content: [{ type: "text", text: "first", prompt_cache_breakpoint: {} }] },
        { role: "assistant", content: [{ type: "text", text: "answer", prompt_cache_breakpoint: {} }] },
      ],
    });
    const v2 = JSON.parse(withPromptCacheBreakpoints(OPENROUTER, twoMarks) ?? "{}");
    expect(v2.messages[0].content).toBe("first");
    expect(v2.messages[1].content).toEqual([{ type: "text", text: "answer", cache_control: BREAKPOINT }]);
  });

  it("adds a session id unless the body names one", () => {
    expect(JSON.parse(withSessionId(JSON.stringify({ model: "m" }), "task-1") ?? "{}").session_id).toBe("task-1");
    expect(withSessionId(JSON.stringify({ model: "m", session_id: "theirs" }), "task-1")).toBeUndefined();
    expect(withSessionId("not json", "task-1")).toBeUndefined();
  });
});

describe("OpenAI explicit prompt-cache breakpoints", () => {
  const marked = (model: string) =>
    JSON.stringify({
      model,
      messages: [{ role: "user", content: [{ type: "text", text: "hi", prompt_cache_breakpoint: {} }] }],
    });
  it("keeps the loop's markers for GPT-5.6 and later on OpenAI's endpoint, and strips them for an older model", () => {
    expect(withPromptCacheBreakpoints("https://api.openai.com/v1/chat/completions", marked("gpt-5.6"))).toBeUndefined();
    expect(withPromptCacheBreakpoints("https://api.openai.com/v1/chat/completions", marked("gpt-5.5"))).not.toContain(
      "prompt_cache_breakpoint",
    );
    expect(["gpt-5.6", "gpt-6", "gpt-6-mini", "gpt-5.10"].map(openaiExplicitCacheModel)).toEqual([true, true, true, true]);
    expect(["gpt-5.5", "gpt-5", "gpt-4o", "o3"].map(openaiExplicitCacheModel)).toEqual([false, false, false, false]);
  });
});
