import { afterEach, describe, expect, it } from "vitest";

import {
  clearRhumbCache,
  lifecycleOfOffering,
  listOfferings,
  offeringKey,
  redirectOnProvider,
  rhumbCall,
  rhumbModelId,
  rhumbProviderOf,
  rhumbUrlOf,
} from "../../src/features/models/rhumb-client.js";

const VERSION = "2026-11-20.1";
const CHECKED = "2026-11-20T08:00:00.000Z";

afterEach(() => clearRhumbCache());

describe("the Rhumb client", () => {
  it("names providers by preset, and Gemini's ids without their models/ prefix", () => {
    expect(rhumbProviderOf("https://generativelanguage.googleapis.com/v1beta/openai")).toBe("gemini");
    expect(rhumbProviderOf("http://localhost:11434/v1")).toBe("ollama");
    expect(rhumbProviderOf("https://gateway.example/v1")).toBeUndefined();
    expect(rhumbModelId("gemini", "models/gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(rhumbModelId("openrouter", "models/x")).toBe("models/x");
    expect(rhumbUrlOf({})).toBe("https://rhumbdata.com");
    expect(rhumbUrlOf({ RESOLVER_URL: " https://rhumb.test " })).toBe("https://rhumb.test");
  });

  it("reads every page, and asks for retired and hidden offerings only when told to", async () => {
    const urls: URL[] = [];
    const page = (offset: number) =>
      offset === 0
        ? {
            catalog_version: VERSION,
            total: 501,
            models: Array.from({ length: 500 }, (_, index) => ({ offerings: [{ provider: "openai", provider_model_id: `m${index}` }] })),
          }
        : {
            catalog_version: VERSION,
            total: 501,
            models: [{ offerings: [{ provider: "openai", provider_model_id: "gpt-5", status: "deprecated" }] }],
          };
    const fetch = (async (input: string) => {
      const url = new URL(input);
      urls.push(url);
      return new Response(JSON.stringify(page(Number(url.searchParams.get("offset")))), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const call = rhumbCall("key", "https://rhumb.test/", fetch, 1_000);
    const catalog = await listOfferings(call, ["openai"], { includeRetired: true });
    expect(catalog.catalogVersion).toBe(VERSION);
    expect(catalog.offerings.size).toBe(501);
    expect(catalog.complete).toBe(true);
    expect(catalog.offerings.get(offeringKey("openai", "gpt-5"))?.status).toBe("deprecated");
    expect(urls.map((url) => url.searchParams.get("offset"))).toEqual(["0", "500"]);
    expect(urls[0]?.searchParams.get("include_retired")).toBe("true");
    expect(urls[0]?.searchParams.get("include_hidden")).toBe("true");
    await listOfferings(rhumbCall("key", "https://rhumb.test/", fetch, 1_000), ["anthropic"]);
    expect(urls.at(-1)?.searchParams.has("include_retired")).toBe(false);
  });

  it("says the listing is incomplete when it stops before the last page", async () => {
    const full = {
      catalog_version: VERSION,
      models: Array.from({ length: 500 }, (_, index) => ({ offerings: [{ provider: "openai", provider_model_id: `m${index}` }] })),
    };
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify(full), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const catalog = await listOfferings(rhumbCall("key", "https://rhumb.test", fetch, 1_000), ["openai"]);
    expect(catalog.complete).toBe(false);
    expect(calls).toBe(5);
  });

  it("keeps an offering's lifecycle, without the floor Rhumb calls retires_not_before", () => {
    const offering = {
      provider: "gemini",
      provider_model_id: "gemini-2.5-pro",
      status: "deprecated",
      end_claimed_on: "2026-12-01",
      closed_to_new_on: "2026-09-18",
      redirect: { on: "2026-12-01", to: "gemini-3.8-flash" },
      next_price: { effective_from: "2026-12-15", per_1m: { input: "1" } },
      retires_not_before: "2027-01-01",
    };
    expect(lifecycleOfOffering(offering, VERSION, CHECKED)).toEqual({
      status: "deprecated",
      catalogVersion: VERSION,
      checkedAt: CHECKED,
      endClaimedOn: "2026-12-01",
      closedToNewOn: "2026-09-18",
      redirect: { to: "gemini-3.8-flash", on: "2026-12-01" },
      nextPrice: { effectiveFrom: "2026-12-15", per1m: { input: "1" } },
    });
  });

  it("calls a model Rhumb does not list unknown, and drops only a field it cannot read", () => {
    expect(lifecycleOfOffering(undefined, VERSION, CHECKED)).toEqual({ status: "unknown", catalogVersion: VERSION, checkedAt: CHECKED });
    expect(lifecycleOfOffering({ status: "sunset", retires_on: "2026-12-11", end_claimed_on: "soon" }, VERSION, CHECKED)).toEqual({
      status: "unknown",
      catalogVersion: VERSION,
      checkedAt: CHECKED,
      retiresOn: "2026-12-11",
    });
  });

  it("names a redirect target as a router lists it, under its namespace, only when one model matches", () => {
    const listing = (ids: readonly [string, string][]) => ({
      complete: true,
      offerings: new Map(ids.map(([provider, id]) => [offeringKey(provider, id), { provider, provider_model_id: id }])),
    });
    const openrouter = listing([
      ["openrouter", "google/gemini-2.5-flash"],
      ["openrouter", "google/gemini-3.5-flash-lite"],
      ["gemini", "gemini-3.5-flash-lite"],
    ]);
    expect(redirectOnProvider(openrouter, "openrouter", "gemini-3.5-flash-lite")).toBe("google/gemini-3.5-flash-lite");
    // The provider's own name is kept: on Gemini itself, and for a target the router does not list.
    expect(redirectOnProvider(openrouter, "gemini", "gemini-3.5-flash-lite")).toBe("gemini-3.5-flash-lite");
    expect(redirectOnProvider(openrouter, "openrouter", "gemini-9")).toBe("gemini-9");
    // Two namespaces with the same model: neither is guessed.
    const both = listing([
      ["openrouter", "google/m"],
      ["openrouter", "other/m"],
    ]);
    expect(redirectOnProvider(both, "openrouter", "m")).toBe("m");
  });
});
