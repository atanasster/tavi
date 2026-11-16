import { describe, expect, it } from "vitest";

import type { ModelEmbedRequest } from "@tavi/contracts";
import { createAiSdkModelAdapter, type ProviderConnection } from "@tavi/agent-host/models";

/** The embedding call of the `openai-compatible` adapter. */

const connection: ProviderConnection = {
  connectionId: "embedder",
  kind: "openai-compatible",
  baseUrl: "https://embed.example/v1",
  credentialRef: "embed-key",
};
const request = (overrides: Partial<ModelEmbedRequest> = {}): ModelEmbedRequest => ({
  connectionId: "embedder",
  model: "text-embedding-3-small",
  runId: "run-1",
  attemptId: "embed-1",
  texts: ["I live in Lisbon", "I'm vegetarian"],
  ...overrides,
});
const signal = () => new AbortController().signal;

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly authorization: string | null;
}

/** A fake `/embeddings` endpoint that answers `vectors` (one per input when absent) and records what it was sent. */
function endpoint(answer: (body: Record<string, unknown>) => Response) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ url: String(input), body, authorization: new Headers(init?.headers).get("authorization") });
    return answer(body);
  };
  return { sent, fetch };
}
const ok = (vectors: readonly (readonly number[])[], tokens = 7) =>
  new Response(
    JSON.stringify({
      object: "list",
      data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
      model: "text-embedding-3-small",
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    }),
    { status: 200, headers: { "content-type": "application/json", "x-request-id": "req-42" } },
  );

function adapter(fetch: typeof globalThis.fetch, credential: string | null = "sk-embed") {
  return createAiSdkModelAdapter({ connections: [connection], readSecret: async () => credential, fetch });
}

describe("the model port's embedding call", () => {
  it("round-trips through the connection's /embeddings: one request, vectors in order, usage priced as input", async () => {
    const { sent, fetch } = endpoint((body) => ok((body["input"] as string[]).map((_text, index) => [index + 0.5, -1, 2])));
    const outcome = await adapter(fetch).embed!(request(), { signal: signal() });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://embed.example/v1/embeddings");
    expect(sent[0]?.body).toMatchObject({ model: "text-embedding-3-small", input: ["I live in Lisbon", "I'm vegetarian"] });
    expect(sent[0]?.authorization).toBe("Bearer sk-embed");
    expect(outcome.status).toBe("completed");
    expect(outcome.vectors.map((vector) => [...vector])).toEqual([
      [0.5, -1, 2],
      [1.5, -1, 2],
    ]);
    expect(outcome.vectors[0]).toBeInstanceOf(Float32Array);
    expect(outcome.usage).toEqual({
      inputTokens: 7,
      inputNoCacheTokens: 7,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTokens: 0,
      totalTokens: 7,
    });
    expect(outcome.providerRequestId).toBe("req-42");
  });

  it("sends on exactly the pinned connection", async () => {
    const { sent, fetch } = endpoint((body) => ok((body["input"] as string[]).map(() => [1, 0])));
    const pinned = adapter(fetch).pinned({ ...connection, baseUrl: "http://127.0.0.1:11434/v1" });
    expect((await pinned.embed!(request(), { signal: signal() })).status).toBe("completed");
    expect(sent[0]?.url).toBe("http://127.0.0.1:11434/v1/embeddings");
    expect((await pinned.embed!(request({ connectionId: "other" }), { signal: signal() })).error?.code).toBe("model_unavailable");
  });

  it("answers a provider refusal as a typed failure, never as empty vectors that look complete", async () => {
    const { fetch } = endpoint(
      () =>
        new Response(JSON.stringify({ error: { message: "Incorrect API key provided: Authorization: Bearer sk-live-abcdef123456" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const outcome = await adapter(fetch).embed!(request(), { signal: signal() });
    expect(outcome).toMatchObject({ status: "failed", vectors: [], error: { code: "auth", retryable: false } });
    expect(outcome.error?.message).not.toContain("sk-live-abcdef123456");
  });

  it("refuses an answer with the wrong count, ragged dimensions or a value that is not finite", async () => {
    for (const vectors of [
      [[1, 2]],
      [
        [1, 2],
        [1, 2, 3],
      ],
      [
        [1, 2],
        [Number.NaN, 2],
      ],
    ] as const) {
      const { fetch } = endpoint(() =>
        ok(vectors.map((vector) => vector.map((value) => (Number.isNaN(value) ? "x" : value))) as unknown as number[][]),
      );
      const outcome = await adapter(fetch).embed!(request(), { signal: signal() });
      expect(outcome.status).toBe("failed");
      expect(outcome.vectors).toEqual([]);
    }
  });

  it("sends nothing without a credential, for an unknown connection, or once cancelled", async () => {
    const { sent, fetch } = endpoint(() => ok([[1], [2]]));
    expect((await adapter(fetch, null).embed!(request(), { signal: signal() })).error?.code).toBe("invalid_request");
    expect((await adapter(fetch).embed!(request({ connectionId: "missing" }), { signal: signal() })).error?.code).toBe("model_unavailable");
    expect((await adapter(fetch).embed!(request(), { signal: AbortSignal.abort() })).status).toBe("aborted");
    expect(sent).toHaveLength(0);
  });

  it("reports a call cancelled in flight as aborted", async () => {
    const controller = new AbortController();
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      return ok([[1], [2]]);
    };
    expect((await adapter(fetch).embed!(request(), { signal: controller.signal })).status).toBe("aborted");
  });
});
