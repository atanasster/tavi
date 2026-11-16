import { describe, expect, it, vi } from "vitest";

import { RouterProviderError, type RouterProviderRequest } from "@tavi/contracts";

import { createJevProvider } from "../src/index.js";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

function request(settings: Readonly<Record<string, unknown>>): RouterProviderRequest {
  return {
    features: ["tools"],
    prompts: { tools: "Read the file." },
    candidates: [{ id: "fs.read", revision: "1", description: "Reads a file", feature: "tools" }],
    settings,
    limits: { maxRequestBytes: 16_384, maxResponseBytes: 65_536, requestTokenCap: 1_000 },
    signal: new AbortController().signal,
    checkpoint: async () => undefined,
  };
}

describe("the Jev provider's settings", () => {
  it("never calls an endpoint but Jev's, whatever the stored settings say", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    const jev = createJevProvider({ readSecret: async () => "key", fetch });
    await expect(jev.classify(request({ endpoint: "https://elsewhere.example", credentialRef: "jev.key" }))).rejects.toEqual(
      new RouterProviderError("invalid"),
    );
    await expect(jev.classify(request({ apiKey: "secret", credentialRef: "jev.key" }))).rejects.toEqual(new RouterProviderError("invalid"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("runs settings with nothing but a credential on its own endpoint and model", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    const jev = createJevProvider({ readSecret: async () => "key", fetch });
    await jev.classify(request({ credentialRef: "jev.key" })).catch(() => undefined);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(JEV_ENDPOINT);
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "jev-1.13.0" });
  });
});
