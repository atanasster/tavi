import { TaviError, type ModelConnection } from "@tavi/contracts";
import { MAX_DISCOVERY_BYTES, discoverModels, hashDraft, testConnection } from "@tavi/runtime";

import { describe, expect, it } from "vitest";

/**
 * Model discovery and connection testing.
 *
 * Discovery observes what a connection reports and must not invent a model list;
 * the test reports only what it observed, and both are bounded so a diagnostic
 * cannot become the most expensive call in a workspace.
 */

const connection: ModelConnection = {
  connectionId: "local",
  label: "Local",
  kind: "openai-compatible",
  baseUrl: "http://127.0.0.1:11434/v1",
  credentialRef: "local.token",
  localOnly: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const readSecret = async (): Promise<string | null> => "sk-test";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("model discovery", () => {
  it("reads Sign in with ChatGPT's account catalogue: each listed model by its slug and name", async () => {
    const models = await discoverModels({
      connection: { ...connection, connectionId: "chatgpt", wireApi: "responses" },
      readSecret,
      fetch: async () =>
        jsonResponse({
          models: [
            { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
            { slug: "internal-x", display_name: "Hidden", visibility: "hide" },
            { display_name: "No slug" },
          ],
        }),
      now: () => "2026-02-01T00:00:00.000Z",
    });
    expect(models.map((model) => [model.modelId, model.displayName])).toEqual([["gpt-6.1-sol", "GPT-6.1 Sol"]]);
  });

  it("lists a native Anthropic connection's models with its own key and version headers", async () => {
    const headers: Headers[] = [];
    const urls: string[] = [];
    const models = await discoverModels({
      connection: {
        ...connection,
        connectionId: "claude",
        kind: "anthropic-messages",
        baseUrl: "https://api.anthropic.com/v1",
        localOnly: false,
      },
      readSecret,
      fetch: async (url, init) => {
        urls.push(String(url));
        headers.push(new Headers(init?.headers));
        return jsonResponse({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5", type: "model" }] });
      },
      now: () => "2026-02-01T00:00:00.000Z",
    });
    expect(headers[0]?.get("x-api-key")).toBe("sk-test");
    expect(headers[0]?.get("anthropic-version")).toBe("2023-06-01");
    expect(urls[0]).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(headers[0]?.get("authorization")).toBeNull();
    expect(models.map((model) => [model.modelId, model.displayName])).toEqual([["claude-opus-5-5", "Claude Opus 5.5"]]);
  });

  it("lists models with live provenance and an explicit endpoint", async () => {
    const seen: string[] = [];
    const models = await discoverModels({
      connection,
      readSecret,
      fetch: async (url) => {
        seen.push(String(url));
        return jsonResponse({ data: [{ id: "llama3", owned_by: "local" }, { id: "small" }] });
      },
      now: () => "2026-02-01T00:00:00.000Z",
    });
    expect(seen).toEqual(["http://127.0.0.1:11434/v1/models"]);
    expect(models.map((entry) => entry.modelId)).toEqual(["llama3", "small"]);
    expect(models[0]?.provenance).toBe("live");
    // Discovery observes availability; capability is only claimed by a test.
    expect(models[0]?.state).toBe("available");
    expect(models[0]?.discoveredAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("marks a model whose listing says it takes video in, and only that", async () => {
    const models = await discoverModels({
      connection,
      readSecret,
      fetch: async () =>
        jsonResponse({
          data: [
            { id: "qwen/qwen3-vl", architecture: { input_modalities: ["text", "image", "Video"] } },
            { id: "gpt-x", architecture: { input_modalities: ["text", "image"] } },
            { id: "odd", architecture: { input_modalities: "video" } },
            { id: "plain" },
          ],
        }),
    });
    expect(models.map((entry) => [entry.modelId, entry.capabilities])).toEqual([
      ["qwen/qwen3-vl", ["video"]],
      ["gpt-x", []],
      ["odd", []],
      ["plain", []],
    ]);
  });

  it("requires a credential before discovery instead of reporting a misleading denial", async () => {
    await expect(discoverModels({ connection, readSecret: async () => null, fetch: async () => jsonResponse({}) })).rejects.toThrowError(
      /no credential bound/,
    );
  });

  it("reports an authorization failure as a typed refusal", async () => {
    const failure = await discoverModels({
      connection,
      readSecret,
      fetch: async () => jsonResponse({ error: "nope" }, 401),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TaviError);
    expect((failure as TaviError).code).toBe("NOT_AUTHORIZED");
  });

  it("refuses a response that is not a model list, and one that is too large", async () => {
    await expect(discoverModels({ connection, readSecret, fetch: async () => jsonResponse({ models: [] }) })).rejects.toThrowError(
      /did not return a model list/,
    );

    await expect(
      discoverModels({
        connection,
        readSecret,
        fetch: async () => new Response("x".repeat(MAX_DISCOVERY_BYTES + 1)),
      }),
    ).rejects.toThrowError(/exceeded/);
  });

  it("reads a gateway's name and capacities, and a `models` map, the way pi-ai's discovery does", async () => {
    // OpenRouter's shape: `name`, `context_length`, and the output cap under `top_provider`.
    const openrouter = await discoverModels({
      connection,
      readSecret,
      fetch: async () =>
        jsonResponse({
          data: [
            {
              id: "openai/gpt-4.1-mini",
              name: "OpenAI: GPT-4.1 Mini",
              owned_by: "openai",
              context_length: 1_047_576,
              top_provider: { max_completion_tokens: 32_768 },
            },
          ],
        }),
    });
    expect(openrouter[0]).toMatchObject({
      modelId: "openai/gpt-4.1-mini",
      displayName: "OpenAI: GPT-4.1 Mini",
      contextWindow: 1_047_576,
      maxTokens: 32_768,
    });
    // `owned_by` alone is who serves the model, not its name.
    const plain = await discoverModels({
      connection,
      readSecret,
      fetch: async () => jsonResponse({ data: [{ id: "llama3", owned_by: "local" }] }),
    });
    expect(plain[0]?.displayName).toBeUndefined();
    // A `models` map keyed by the id the endpoint accepts; a primitive property is metadata, not a model.
    const mapped = await discoverModels({
      connection,
      readSecret,
      fetch: async () =>
        jsonResponse({ models: { "gw/alias": { id: "vendor/canonical", limit: { context: 128_000, output: 4096 } }, version: "3" } }),
    });
    expect(mapped.map((entry) => [entry.modelId, entry.contextWindow, entry.maxTokens])).toEqual([["gw/alias", 128_000, 4096]]);
    // A capacity that is not a positive integer is not one.
    const odd = await discoverModels({
      connection,
      readSecret,
      fetch: async () => jsonResponse({ data: [{ id: "x", context_length: "big", max_tokens: 0 }] }),
    });
    expect(odd[0]?.contextWindow).toBeUndefined();
    expect(odd[0]?.maxTokens).toBeUndefined();
  });

  it("skips malformed entries rather than inventing a model id", async () => {
    const models = await discoverModels({
      connection,
      readSecret,
      fetch: async () => jsonResponse({ data: [{ id: "good" }, { id: "" }, { owned_by: "x" }, { id: 42 }] }),
    });
    expect(models.map((entry) => entry.modelId)).toEqual(["good"]);
  });

  it("skips a gateway's batch-only variants, which chat/completions refuses", async () => {
    const models = await discoverModels({
      connection,
      readSecret,
      fetch: async () =>
        jsonResponse({
          data: [{ id: "google/gemini-3.5-flash-lite" }, { id: "google/gemini-3.5-flash-lite:batch" }, { id: "meta/llama:free" }],
        }),
    });
    expect(models.map((entry) => entry.modelId)).toEqual(["google/gemini-3.5-flash-lite", "meta/llama:free"]);
  });
});

describe("connection testing", () => {
  it("reports only the capabilities it observed", async () => {
    const result = await testConnection({
      connection,
      modelId: "llama3",
      generate: async () => ({ text: "ok", toolCallNames: [], streamed: true }),
      now: () => "2026-02-01T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    expect(result.capabilities).toEqual(["chat", "streaming"]);
    expect(result.testedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(result.message).toBeUndefined();
  });

  it("returns a typed failure result instead of throwing, and observes nothing", async () => {
    const result = await testConnection({
      connection,
      modelId: "llama3",
      generate: async () => {
        throw new TaviError("MODEL_FAILED", "provider rejected the request");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.capabilities).toEqual([]);
    expect(result.message).toContain("MODEL_FAILED");
  });

  it("bounds the test in time and aborts the generation", async () => {
    let aborted = false;
    const result = await testConnection({
      connection,
      modelId: "llama3",
      timeoutMs: 20,
      generate: (input) =>
        new Promise((_resolve, reject) => {
          input.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new TaviError("MODEL_FAILED", "aborted"));
          });
        }),
    });
    expect(result.ok).toBe(false);
    expect(aborted).toBe(true);
    expect(result.message).toContain("exceeded 20ms");
  });

  it("scrubs and bounds a failure message a provider could have echoed", async () => {
    const result = await testConnection({
      connection,
      modelId: "llama3",
      generate: async () => {
        throw new TaviError("MODEL_FAILED", `upstream said: Authorization: Bearer sk-live-abcdef123456 ${"x".repeat(500)}`);
      },
    });
    expect(result.message).not.toContain("sk-live-abcdef123456");
    expect(result.message).toContain("[redacted]");
    expect((result.message ?? "").length).toBeLessThanOrEqual(300);
  });

  it("offers a probe tool so `tools` is observed rather than assumed", async () => {
    const seen: string[] = [];
    const result = await testConnection({
      connection,
      modelId: "llama3",
      generate: async (input) => {
        seen.push(...input.tools.map((tool) => tool.name));
        return { text: "", toolCallNames: ["probe_noop"], streamed: true };
      },
    });
    expect(seen).toEqual(["probe_noop"]);
    expect(result.capabilities).toEqual(["chat", "streaming", "tools"]);
  });

  it("invalidates a stored result when the draft changes", () => {
    const before = hashDraft(connection, "llama3");
    expect(hashDraft({ ...connection, baseUrl: "https://api.example.test/v1" }, "llama3")).not.toBe(before);
    expect(hashDraft(connection, "small")).not.toBe(before);
    expect(hashDraft({ ...connection, credentialRef: "other.token" }, "llama3")).not.toBe(before);
    expect(hashDraft({ ...connection, headers: { "x-tenant": "a" } }, "llama3")).not.toBe(before);
    // The same draft hashes the same, so a stored result stays valid.
    expect(hashDraft({ ...connection }, "llama3")).toBe(before);
  });
});
