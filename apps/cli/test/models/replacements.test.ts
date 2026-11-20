import { describe, expect, it } from "vitest";

import {
  askReplacements,
  ReplacementCache,
  knownReplacements,
  replacementKinds,
  replacementQuery,
  replacementsInWords,
  replacementsOf,
} from "../../src/features/models/replacements.js";

const AT = { catalogVersion: "v1", checkedAt: "2026-11-20T08:00:00.000Z" };

describe("model replacements", () => {
  it("asks for each kind of use once: tools for the main work, a cheap budget for background, embeddings and video by their own", () => {
    expect(
      replacementKinds([
        { kind: "routine", detail: "digest/draft" },
        { kind: "role", detail: "main" },
        { kind: "role-fallback", detail: "compaction" },
        { kind: "heartbeat" },
        { kind: "role", detail: "embedding" },
        { kind: "video" },
      ]),
    ).toEqual(["agent", "cheap", "embedding", "video"]);
    expect(replacementQuery("cheap", "gemini")).toEqual({
      providers: "gemini",
      purpose: "agent-with-tools",
      budget: "cheap",
    });
    expect(replacementQuery("embedding", "openai")).toEqual({
      providers: "openai",
      task: "embedding",
    });
    expect(replacementQuery("video", "openrouter")).toMatchObject({ needs: "input.video" });
  });

  it("knows the provider's redirect without asking, and only the picks of the row's catalog version", () => {
    const cache = new ReplacementCache();
    cache.set("v0", "openai", "gpt-5", "agent", { for: "agent", model: "old-pick" });
    cache.set("v1", "openai", "gpt-5", "agent", { for: "agent", model: "gpt-6.2-sol" });
    cache.set("v2", "openai", "o3", "agent", null);
    // Rows of two versions (a listing that stopped early): both kept, the rest dropped.
    cache.keepVersions(new Set(["v1", "v2"]));
    expect(cache.get("v0", "openai", "gpt-5", "agent")).toBeUndefined();
    expect(cache.get("v2", "openai", "o3", "agent")).toBeNull();
    const lifecycle = { status: "ga" as const, redirect: { to: "gpt-6-luna", via: "alias" }, ...AT };
    const known = knownReplacements(cache, { provider: "openai", model: "gpt-5", lifecycle, kinds: ["agent", "cheap"] });
    expect(known).toEqual({ provider: { model: "gpt-6-luna", via: "alias" }, rhumb: [{ for: "agent", model: "gpt-6.2-sol" }] });
    expect(replacementsInWords(known)).toBe(
      "the provider moves it to gpt-6-luna; Rhumb suggests gpt-6.2-sol (with tools) (tavi models replace moves every use)",
    );
    expect(replacementsInWords({ rhumb: [] })).toBeUndefined();
    // A custom endpoint: no provider, so no pick, but a redirect still says itself.
    expect(knownReplacements(cache, { provider: undefined, model: "gpt-5", lifecycle, kinds: ["agent"] }).rhumb).toEqual([]);
  });

  it("reads an owner's replacements, leaving out what has another shape", () => {
    expect(replacementsOf({ provider: { model: 3 }, rhumb: [{ for: "agent", model: "a" }, { for: "other", model: "b" }, "c"] })).toEqual({
      rhumb: [{ for: "agent", model: "a" }],
    });
    expect(replacementsOf(undefined)).toBeUndefined();
  });

  it("asks once per provider and kind for every model that needs it, caches no candidate, and asks again after a failure", async () => {
    const asked: Record<string, string>[] = [];
    let fail = true;
    const cache = new ReplacementCache();
    const requests = [
      { catalogVersion: "v1", provider: "openai", model: "gpt-5", kinds: ["agent", "embedding"] as const },
      { catalogVersion: "v1", provider: "openai", model: "o3", kinds: ["agent", "video"] as const },
    ];
    await askReplacements(
      async (_path, query) => {
        asked.push(query);
        if (query["task"] === "embedding") throw new Error("the resolver answered 404 no_candidate");
        if (query["needs"] === "input.video" && fail) throw new Error("the resolver answered 503");
        return {
          model: { provider: "openai", provider_model_id: "o3" },
          alternatives: [{ provider: "openai", provider_model_id: "gpt-6.2-sol" }],
        };
      },
      cache,
      requests,
    );
    expect(asked).toHaveLength(3);
    // One answer serves both models: each skips itself.
    expect(cache.get("v1", "openai", "gpt-5", "agent")?.model).toBe("o3");
    expect(cache.get("v1", "openai", "o3", "agent")?.model).toBe("gpt-6.2-sol");
    expect(cache.get("v1", "openai", "gpt-5", "embedding")).toBeNull();
    expect(cache.get("v1", "openai", "o3", "video")).toBeUndefined();
    fail = false;
    asked.length = 0;
    await askReplacements(
      async (_path, query) => (asked.push(query), { model: { provider: "openai", provider_model_id: "v" } }),
      cache,
      requests,
    );
    expect(asked).toEqual([{ providers: "openai", purpose: "agent-with-tools", needs: "input.video" }]);
  });
});
