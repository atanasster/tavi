import { describe, expect, it } from "vitest";

import { prefixContinuity, recordingFetch } from "../src/prefix.js";

const tools = [{ type: "function", function: { name: "notes_read" } }];
const request = (messages: readonly unknown[], offered: readonly unknown[] = tools) =>
  JSON.stringify({ model: "m", tools: offered, messages });
const marked = (text: string) => [{ type: "text", text, cache_control: { type: "ephemeral" } }];

describe("prefixContinuity", () => {
  it("is a hit when the next request starts with the previous one's marked prefix", () => {
    const previous = request([
      { role: "system", content: marked("You are Tavi.") },
      { role: "user", content: marked("Find it.") },
      { role: "user", content: "Step 1 of 8." },
    ]);
    const next = request([
      { role: "system", content: "You are Tavi." },
      { role: "user", content: [{ type: "text", text: "Find it." }] },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "notes_read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "notes" },
      { role: "user", content: "Step 2 of 8." },
    ]);
    expect(prefixContinuity(previous, next)).toEqual({
      hit: true,
      toolsMatch: true,
      cacheableThrough: { message: 1, role: "user" },
      divergesAt: { message: 2, role: "user" },
    });
  });

  it("is a miss when a message inside the marked prefix changed, and says where", () => {
    const previous = request([
      { role: "system", content: "You are Tavi." },
      { role: "user", content: marked("[context] a\n\nFind it.") },
      { role: "user", content: "x" },
    ]);
    const next = request([
      { role: "system", content: "You are Tavi." },
      { role: "user", content: "Find it." },
      { role: "user", content: "y" },
    ]);
    expect(prefixContinuity(previous, next)).toMatchObject({ hit: false, divergesAt: { message: 1, role: "user" } });
  });

  it("is a miss when a marked tool result answers another call, though its text is the same", () => {
    const loop = (callId: string) =>
      request([
        { role: "system", content: "You are Tavi." },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: callId, type: "function", function: { name: "notes_read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: callId, content: marked("notes") },
        { role: "user", content: "Step 2." },
      ]);
    expect(prefixContinuity(loop("c1"), loop("c2"))).toMatchObject({ hit: false, divergesAt: { message: 1, role: "assistant" } });
  });

  it("is a miss when the tools differ, whatever the messages share", () => {
    const messages = [
      { role: "system", content: marked("You are Tavi.") },
      { role: "user", content: "x" },
    ];
    expect(prefixContinuity(request(messages), request(messages, []))).toMatchObject({ hit: false, toolsMatch: false });
  });

  it("takes every message but the newest as the prefix when nothing is marked", () => {
    const previous = request([
      { role: "system", content: "You are Tavi." },
      { role: "user", content: "Step 1." },
    ]);
    const next = request([
      { role: "system", content: "You are Tavi." },
      { role: "user", content: "Step 2." },
    ]);
    expect(prefixContinuity(previous, next)).toMatchObject({ hit: true, cacheableThrough: { message: 0, role: "system" } });
  });
});

describe("recordingFetch", () => {
  it("keeps each body it is sent and answers by index", async () => {
    const { fetch, bodies } = recordingFetch((index) => new Response(String(index)));
    expect(await (await fetch("https://example.test", { method: "POST", body: "a" })).text()).toBe("0");
    expect(await (await fetch("https://example.test", { method: "POST", body: "b" })).text()).toBe("1");
    expect(bodies).toEqual(["a", "b"]);
  });

  it("refuses a body that is not a string when it is sent, not later", async () => {
    const { fetch } = recordingFetch(() => new Response("x"));
    await expect(fetch("https://example.test", { method: "POST", body: new Uint8Array([1]) })).rejects.toThrow(/string request bodies/);
  });
});
