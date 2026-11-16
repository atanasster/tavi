import { afterEach, describe, expect, it } from "vitest";

import { sse, startOpenAiStub, textChunk, toolCallChunk, type OpenAiStub } from "../src/openai-stub.js";

const stubs: OpenAiStub[] = [];
afterEach(async () => {
  while (stubs.length > 0) await stubs.pop()?.close();
});

async function stub(options: Parameters<typeof startOpenAiStub>[0] = {}): Promise<OpenAiStub> {
  const started = await startOpenAiStub(options);
  stubs.push(started);
  return started;
}

/** The JSON chunks of a server-sent event stream, `[DONE]` aside. */
function chunksOf(body: string): unknown[] {
  return body
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)) as unknown);
}

const complete = (stubbed: OpenAiStub, body: unknown, key = "k"): Promise<Response> =>
  fetch(`${stubbed.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("startOpenAiStub", () => {
  it("lists its models and answers a completion with a streamed text by default", async () => {
    const stubbed = await stub({ models: ["llama3", { id: "small", owned_by: "local" }] });
    expect(stubbed.baseUrl).toBe(`http://127.0.0.1:${stubbed.port}/v1`);
    const models = (await (await fetch(`${stubbed.baseUrl}/models`)).json()) as { data: { id: string; owned_by?: string }[] };
    expect(models.data.map((model) => model.id)).toEqual(["llama3", "small"]);
    expect(models.data[1]?.owned_by).toBe("local");

    const response = await complete(stubbed, { model: "llama3", messages: [{ role: "user", content: "hi" }] });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const body = await response.text();
    expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(chunksOf(body)).toEqual([textChunk("ok", null), textChunk("", "stop")]);
    expect(stubbed.requests.map((request) => `${request.method} ${request.url}`)).toEqual(["GET /v1/models", "POST /v1/chat/completions"]);
    expect(stubbed.requests[1]?.body).toEqual({ model: "llama3", messages: [{ role: "user", content: "hi" }] });
    expect(stubbed.requests[1]?.key).toBe("k");
  });

  it("answers each completion as the reply says, counting turns", async () => {
    const stubbed = await stub({
      reply: (_request, turn) =>
        turn === 1
          ? { calls: [{ id: "call_1", name: "probe_noop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }
          : turn === 2
            ? { says: "done" }
            : { status: 404, body: { error: { code: "model_not_found" } } },
    });
    expect(chunksOf(await (await complete(stubbed, {})).text())).toEqual([
      toolCallChunk({ id: "call_1", name: "probe_noop" }),
      textChunk("", "tool_calls", { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }),
    ]);
    expect(chunksOf(await (await complete(stubbed, {})).text())).toEqual([textChunk("done", null), textChunk("", "stop")]);
    const refused = await complete(stubbed, {});
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: { code: "model_not_found" } });
  });

  it("streams raw chunks as given", async () => {
    const stubbed = await stub({ reply: () => ({ streams: sse([{ any: "thing" }]) }) });
    expect(await (await complete(stubbed, {})).text()).toBe('data: {"any":"thing"}\n\ndata: [DONE]\n\n');
  });

  it("refuses a key other than its own with 401, and an unknown path with 404", async () => {
    const stubbed = await stub({ key: "KEY" });
    const refused = await complete(stubbed, {}, "other");
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("invalid_api_key");
    expect((await complete(stubbed, {}, "KEY")).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${stubbed.port}/elsewhere`, { headers: { authorization: "Bearer KEY" } })).status).toBe(404);
    expect(stubbed.requests.map((request) => request.key)).toEqual(["other", "KEY", "KEY"]);
  });
});
