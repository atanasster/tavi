import { existsSync } from "node:fs";
import { join } from "node:path";

import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { RESOLVER_KEY_HINT, suggestModels, type SuggestConnection } from "../../src/features/models/resolver-suggest.js";
import { clearRhumbCache, rhumbKeyOf } from "../../src/features/models/rhumb-client.js";
import { createLocalCredentialStore } from "../../src/features/credentials/store.js";

/**
 * `tavi models suggest`: the model resolver's suggestions, printed and never
 * applied. Every resolver answer here is a mocked `fetch`: nothing reaches
 * the network.
 */

const directories = temporaryDirectories({ prefix: "tavi-suggest-" });

afterEach(() => {
  directories.cleanup();
  clearRhumbCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const KEY = "nnm_test_key";
const machine = { memoryGb: 12, vramGb: 12, diskGb: 200 };
const ollama: SuggestConnection = { connectionId: "local", baseUrl: "http://localhost:11434/v1", models: ["llama3.2:3b"] };
const openai: SuggestConnection = { connectionId: "openai", baseUrl: "https://api.openai.com/v1", models: ["gpt-5-mini", "unlisted"] };
const custom: SuggestConnection = { connectionId: "lab", baseUrl: "http://10.0.0.5:8000/v1", models: ["x"] };

const resolveAnswer = {
  shape: "single",
  catalog_version: "2026-11-01.1",
  reason: "best quality that fits",
  model: {
    id: "qwen/qwen3-14b",
    provider: "ollama",
    provider_model_id: "qwen3:14b",
    quantization: "Q4_K_M",
    requirements: { memory_gb: 10.4, vram_gb: 10.4, disk_gb: 9.3, context_for_memory: 32768 },
  },
};

const modelsAnswer = {
  catalog_version: "2026-11-01.1",
  total: 1,
  models: [
    {
      id: "openai/gpt-5-mini",
      display_name: "GPT-5 mini",
      offerings: [
        {
          provider: "openai",
          provider_model_id: "gpt-5-mini",
          price: { currency: "USD", per_1m: { input: "0.25", output: "2", cache_read: "0.025" }, effective_from: "2026-08-07" },
        },
      ],
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake resolver answering by path, recording each request. */
function fakeResolver(answers: { resolve?: Response; models?: Response } = {}) {
  const calls: { url: URL; authorization: string | null }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.pathname === "/v1/resolve") return answers.resolve ?? json(resolveAnswer);
    if (url.pathname === "/v1/models") return answers.models ?? json(modelsAnswer);
    return json({ error: { code: "not_found" } }, 404);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe("suggestModels", () => {
  it("asks nothing and answers undefined with no RESOLVER_KEY", async () => {
    const resolver = fakeResolver();
    expect(await suggestModels([ollama, openai], machine, { env: {}, fetch: resolver.fetch })).toBeUndefined();
    expect(await suggestModels([ollama, openai], machine, { env: { RESOLVER_KEY: "  " }, fetch: resolver.fetch })).toBeUndefined();
    expect(await suggestModels([ollama, openai], machine, { env: { RHUMB_KEY: "  " }, fetch: resolver.fetch })).toBeUndefined();
    expect(resolver.calls).toHaveLength(0);
  });

  it("reads RHUMB_KEY, and RESOLVER_KEY, its old name, only when RHUMB_KEY is unset", () => {
    expect(rhumbKeyOf({ RHUMB_KEY: " rhumb ", RESOLVER_KEY: "old" })).toBe("rhumb");
    expect(rhumbKeyOf({ RHUMB_KEY: "", RESOLVER_KEY: " old " })).toBe("old");
    expect(rhumbKeyOf({ RESOLVER_KEY: "old" })).toBe("old");
  });

  it("resolves a local model on the local runtimes with the machine's limits", async () => {
    const resolver = fakeResolver();
    const suggestions = await suggestModels([ollama, openai], machine, {
      env: { RESOLVER_KEY: KEY, RESOLVER_URL: "https://resolver.test/" },
      fetch: resolver.fetch,
    });
    const resolve = resolver.calls.find((call) => call.url.pathname === "/v1/resolve");
    expect(resolve?.url.origin).toBe("https://resolver.test");
    expect(resolve?.authorization).toBe(`Bearer ${KEY}`);
    expect(Object.fromEntries(resolve?.url.searchParams ?? [])).toEqual({
      task: "text.chat",
      providers: "ollama",
      needs: "tools",
      optimize: "quality",
      min_context: "32768",
      max_memory_gb: "12",
      max_vram_gb: "12",
      max_disk_gb: "200",
    });
    expect(suggestions?.localModel).toEqual({
      connectionId: "local",
      provider: "ollama",
      model: "qwen/qwen3-14b",
      providerModelId: "qwen3:14b",
      quantization: "Q4_K_M",
      requirements: { memoryGb: 10.4, vramGb: 10.4, diskGb: 9.3 },
      reason: "best quality that fits",
    });
    expect(suggestions?.catalogVersion).toBe("2026-11-01.1");
  });

  it("always sends max_memory_gb, and leaves out limits it could not read", async () => {
    const resolver = fakeResolver();
    await suggestModels([ollama], { memoryGb: 6 }, { env: { RESOLVER_KEY: KEY }, fetch: resolver.fetch });
    const params = resolver.calls[0]?.url.searchParams;
    expect(resolver.calls[0]?.url.origin).toBe("https://rhumbdata.com");
    expect(params?.get("max_memory_gb")).toBe("6");
    expect(params?.has("max_vram_gb")).toBe(false);
    expect(params?.has("max_disk_gb")).toBe(false);
  });

  it("finds a Gemini model's price by its id without the models/ prefix", async () => {
    const gemini: SuggestConnection = {
      connectionId: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      models: ["models/gemini-3.8-flash"],
    };
    const priced = {
      catalog_version: "2026-11-01.1",
      total: 1,
      models: [
        {
          offerings: [
            {
              provider: "gemini",
              provider_model_id: "gemini-3.8-flash",
              price: { currency: "USD", per_1m: { input: "0.75", output: "3.75" }, effective_from: "2026-09-02" },
            },
          ],
        },
      ],
    };
    const resolver = fakeResolver({ models: json(priced) });
    const suggestions = await suggestModels([gemini], machine, { env: { RHUMB_KEY: KEY }, fetch: resolver.fetch });
    expect(suggestions?.priceSheets).toMatchObject([
      { connectionId: "gemini", model: "models/gemini-3.8-flash", input: 0.75, output: 3.75 },
    ]);
  });

  it("suggests price sheets for the cloud connections' known models only", async () => {
    const resolver = fakeResolver();
    const suggestions = await suggestModels([openai, custom], machine, { env: { RESOLVER_KEY: KEY }, fetch: resolver.fetch });
    const models = resolver.calls.find((call) => call.url.pathname === "/v1/models");
    expect(models?.url.searchParams.get("providers")).toBe("openai");
    expect(suggestions?.priceSheets).toEqual([
      {
        revision: "resolver-2026-11-01.1",
        connectionId: "openai",
        model: "gpt-5-mini",
        effectiveAt: "2026-08-07T00:00:00.000Z",
        currency: "USD",
        input: 0.25,
        cacheRead: 0.025,
        // No cache-write price: charged as input, never as free.
        cacheWrite: 0.25,
        output: 2,
      },
    ]);
    expect(suggestions?.localModel).toBeNull();
    expect(suggestions?.notes.join("\n")).toMatch(/lab/);
    expect(suggestions?.notes.join("\n")).toMatch(/openai\/unlisted/);
    expect(suggestions?.notes.join("\n")).toMatch(/no local runtime/);
  });

  it("falls back to no suggestion, with a note, on 422 no_candidate, a 5xx or a network failure", async () => {
    const noCandidate = await suggestModels([ollama, openai], machine, {
      env: { RESOLVER_KEY: KEY },
      fetch: fakeResolver({
        resolve: json({ error: { code: "no_candidate", message: "nothing fits" } }, 422),
        models: json({ error: { code: "internal" } }, 503),
      }).fetch,
    });
    expect(noCandidate?.localModel).toBeNull();
    expect(noCandidate?.priceSheets).toEqual([]);
    expect(noCandidate?.notes.join("\n")).toMatch(/422 no_candidate/);
    expect(noCandidate?.notes.join("\n")).toMatch(/503/);

    clearRhumbCache();
    const offline = await suggestModels([ollama, openai], machine, {
      env: { RESOLVER_KEY: KEY },
      fetch: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof globalThis.fetch,
    });
    expect(offline?.localModel).toBeNull();
    expect(offline?.priceSheets).toEqual([]);
    expect(JSON.stringify(offline)).not.toContain(KEY);
  });

  it("reuses an answer within a day without asking again", async () => {
    const first = fakeResolver();
    await suggestModels([ollama], machine, { env: { RESOLVER_KEY: KEY }, fetch: first.fetch });
    const failing = vi.fn(async () => json({}, 500)) as unknown as typeof globalThis.fetch;
    const again = await suggestModels([ollama], machine, { env: { RESOLVER_KEY: KEY }, fetch: failing });
    expect(failing).not.toHaveBeenCalled();
    expect(again?.localModel?.providerModelId).toBe("qwen3:14b");
  });

  it("asks again after a day, and serves the older answer when the resolver then fails", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await suggestModels([ollama], machine, { env: { RESOLVER_KEY: KEY }, fetch: fakeResolver().fetch });
      clock.mockReturnValue(now + 25 * 60 * 60 * 1000);
      const failing = vi.fn(async () => json({ error: { code: "internal" } }, 503)) as unknown as typeof globalThis.fetch;
      const stale = await suggestModels([ollama], machine, { env: { RESOLVER_KEY: KEY }, fetch: failing });
      expect(failing).toHaveBeenCalledTimes(1);
      expect(stale?.localModel?.providerModelId).toBe("qwen3:14b");
    } finally {
      clock.mockRestore();
    }
  });

  it("pages through /v1/models until the total is read", async () => {
    const offering = (id: string) => ({
      offerings: [
        {
          provider: "openai",
          provider_model_id: id,
          price: { currency: "USD", per_1m: { input: "1", output: "2" }, effective_from: "2026-01-01" },
        },
      ],
    });
    const pages = new Map([
      [
        "0",
        {
          catalog_version: "v",
          total: 501,
          models: [...Array.from({ length: 499 }, (_, i) => offering(`filler-${i}`)), offering("gpt-a")],
        },
      ],
      ["500", { catalog_version: "v", total: 501, models: [offering("gpt-b")] }],
    ]);
    const offsets: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const offset = new URL(String(input)).searchParams.get("offset") ?? "";
      offsets.push(offset);
      return json(pages.get(offset));
    }) as unknown as typeof globalThis.fetch;
    const suggestions = await suggestModels([{ ...openai, models: ["gpt-a", "gpt-b"] }], machine, { env: { RESOLVER_KEY: KEY }, fetch });
    expect(offsets).toEqual(["0", "500"]);
    expect(suggestions?.priceSheets.map((sheet) => sheet.model)).toEqual(["gpt-a", "gpt-b"]);
  });
});

describe("tavi models suggest", () => {
  it("prints the RHUMB_KEY hint and does not open the data directory with no key", async () => {
    vi.stubEnv("RHUMB_KEY", "");
    vi.stubEnv("RESOLVER_KEY", "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const directory = join(directories.create(), "never-created");
    const captured = capture();
    const code = await main(["models", "suggest", "--data-dir", directory], { io: captured.io });
    expect(code).toBe(EXIT.ok);
    expect(captured.stderr()).toContain(RESOLVER_KEY_HINT);
    expect(captured.stdout()).toBe("");
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(directory)).toBe(false);
  });

  it("prints the suggestions for the stored connections and changes nothing", async () => {
    const directory = directories.create();
    for (const [id, baseUrl, model] of [
      ["local", "http://localhost:11434/v1", "llama3.2:3b"],
      ["openai", "https://api.openai.com/v1", "gpt-5-mini"],
    ] as const) {
      const added = capture();
      const code = await main(
        ["models", "add", id, "--base-url", baseUrl, "--credential", `${id}.key`, "--model", model, "--data-dir", directory],
        { io: added.io },
      );
      expect(code, added.stderr()).toBe(EXIT.ok);
    }
    const listBefore = capture();
    await main(["models", "list", "--data-dir", directory], { io: listBefore.io });

    vi.stubEnv("RESOLVER_KEY", KEY);
    vi.stubEnv("RESOLVER_URL", "https://resolver.test");
    const resolver = fakeResolver();
    vi.stubGlobal("fetch", resolver.fetch);
    const captured = capture();
    const code = await main(["models", "suggest", "--data-dir", directory], { io: captured.io });
    expect(code, captured.stderr()).toBe(EXIT.ok);
    const printed = JSON.parse(captured.stdout()) as { localModel: { connectionId: string }; priceSheets: { model: string }[] };
    expect(printed.localModel.connectionId).toBe("local");
    expect(printed.priceSheets.map((sheet) => sheet.model)).toEqual(["gpt-5-mini"]);
    expect(resolver.calls.every((call) => call.url.origin === "https://resolver.test")).toBe(true);
    expect(resolver.calls.find((call) => call.url.pathname === "/v1/resolve")?.url.searchParams.has("max_memory_gb")).toBe(true);

    vi.unstubAllGlobals();
    const listAfter = capture();
    await main(["models", "list", "--data-dir", directory], { io: listAfter.io });
    expect(listAfter.stdout()).toBe(listBefore.stdout());
  });

  it("uses a key stored as the credential rhumb when RHUMB_KEY is unset", async () => {
    const directory = directories.create();
    const added = capture();
    expect(
      await main(["models", "add", "local", "--base-url", "http://localhost:11434/v1", "--model", "llama3.2:3b", "--data-dir", directory], {
        io: added.io,
      }),
      added.stderr(),
    ).toBe(EXIT.ok);
    await createLocalCredentialStore(directory).setSecret("rhumb", KEY);
    vi.stubEnv("RHUMB_KEY", "");
    vi.stubEnv("RESOLVER_KEY", "");
    vi.stubEnv("RESOLVER_URL", "https://resolver.test");
    const resolver = fakeResolver();
    vi.stubGlobal("fetch", resolver.fetch);
    const captured = capture();
    const code = await main(["models", "suggest", "--data-dir", directory], { io: captured.io });
    expect(code, captured.stderr()).toBe(EXIT.ok);
    expect((JSON.parse(captured.stdout()) as { localModel: { connectionId: string } }).localModel.connectionId).toBe("local");
    expect(resolver.calls.every((call) => call.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(captured.stderr()).not.toContain(RESOLVER_KEY_HINT);
  });

  it("takes no connection argument", async () => {
    const captured = capture();
    const code = await main(["models", "suggest", "local"], { io: captured.io });
    expect(code).toBe(EXIT.usage);
  });
});
