import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { PluginManifestSchema, SiteProfileSchema } from "@tavi/contracts";
import { domainSourceProblems } from "@tavi/domain-kit";
import { TR1_ADAPTERS, TR1_RECORDS, TR2_ADAPTERS, TR2_RECORDS, TR3_RECORDS } from "@tavi/trends-kit";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { register } from "../src/index.js";

const root = join(import.meta.dirname, "..");
const manifest = PluginManifestSchema.parse(JSON.parse(readFileSync(join(root, "tavi-plugin.json"), "utf8")));
const excluded = (JSON.parse(readFileSync(join(root, "excluded.json"), "utf8")) as { excluded: { id: string; reason: string }[] }).excluded;

describe("the trends.radar manifest", () => {
  it("is a valid manifest for a confined worker with a shared app", () => {
    expect(manifest).toMatchObject({ id: "trends.radar", isolation: "process", apps: { apps: [{ id: "trends", category: "search" }] } });
    // Trends are public data: no dataClass, so a public search passes an [A]-only taint step.
    expect(manifest.apps?.apps[0]).not.toHaveProperty("dataClass");
    expect(manifest.network?.domains.length).toBeLessThanOrEqual(64);
  });

  it("declares each tool with its effect and sink", () => {
    expect(manifest.tools.map((tool) => [tool.name, tool.effect, tool.sink, tool.untrustedOutput])).toEqual([
      // Its output is static record facts, numbers and enum health only: trusted.
      ["sources", "read-only", "none", false],
      ["topics", "read-only", "none", undefined],
      ["watch", "mutating", "persist", undefined],
      ["sweep", "read-only", "search", undefined],
      ["velocity", "read-only", "none", undefined],
      ["compare", "read-only", "none", undefined],
      ["snapshot", "read-only", "search", undefined],
      ["search", "read-only", "search", undefined],
      ["brief", "read-only", "none", undefined],
      ["cluster", "read-only", "none", undefined],
      ["profile", "read-only", "none", undefined],
      ["ingest", "mutating", "persist", undefined],
    ]);
  });

  it("asks the person for every watch, showing the topic, and adds the heartbeat's spikes source", () => {
    expect(manifest.tools.find((tool) => tool.name === "watch")).toMatchObject({
      minRisk: "medium",
      attendedOnly: true,
      card: { fields: ["/op", "/topicId", "/topic/label", "/topic/terms", "/topic/countries", "/topic/sources", "/topic/alert"] },
    });
    expect(manifest.tools.filter((tool) => tool.attendedOnly === true).map((tool) => tool.name)).toEqual(["watch", "ingest"]);
    expect(manifest.provides).toEqual(["heartbeat-signals"]);
    expect(manifest.heartbeatSignals).toEqual({ abi: "tavi.heartbeat/1", sources: ["spikes"] });
  });

  it("ships its trending site profiles, each valid, read-only, never unattended, at a human pace, and offers the browser worker profile and ingest", () => {
    const profiles = (manifest.sites ?? []).map((path) => SiteProfileSchema.parse(JSON.parse(readFileSync(join(root, path), "utf8"))));
    expect(profiles.map((profile) => profile.id).sort()).toEqual(
      readdirSync(join(root, "sites"))
        .map((file) => file.replace(/\.json$/, ""))
        .sort(),
    );
    expect(profiles.map((profile) => profile.id)).toEqual([
      "weibo-hot",
      "douyin-hot",
      "bilibili-popular",
      "dcard-popular",
      "yahoojp-realtime",
      "baidu-index",
      "daum-realtime",
    ]);
    for (const profile of profiles) {
      expect(profile, profile.id).toMatchObject({ kind: "trending", access: { watchable: false, robots: "respect" } });
      expect(profile.budget.pagesPerTask, profile.id).toBeLessThanOrEqual(3);
      expect(profile.budget.pagesPerDay, profile.id).toBeLessThanOrEqual(10);
      expect(profile.budget.minIntervalMs, profile.id).toBeGreaterThanOrEqual(10_000);
    }
    // Sites whose terms bar reading them by program are never browsed.
    expect(
      profiles.filter((profile) => profile.access.mode === "assist-only" && !profile.access.navigate).map((profile) => profile.id),
    ).toEqual(["weibo-hot", "douyin-hot", "bilibili-popular", "dcard-popular", "yahoojp-realtime"]);
    expect(profiles.filter((profile) => profile.access.mode === "read" && profile.access.navigate).map((profile) => profile.id)).toEqual([
      "baidu-index",
      "daum-realtime",
    ]);
    expect(profiles.find((profile) => profile.id === "baidu-index")?.signIn).toMatchObject({ required: true });
    expect(manifest.tools.filter((tool) => tool.browserWorker === true).map((tool) => tool.name)).toEqual(["profile", "ingest"]);
    expect(manifest.tools.find((tool) => tool.name === "ingest")).toMatchObject({ card: { fields: ["/profileId", "/itemSet", "/items"] } });
  });

  it("covers every source's hosts, with terms reviewed within 180 days (the release check)", () => {
    const credentials = Object.entries(manifest.config)
      .filter(([, field]) => field.type === "credential")
      .map(([key]) => key);
    expect(
      domainSourceProblems(
        [...TR1_RECORDS, ...TR2_RECORDS, ...TR3_RECORDS],
        { networkDomains: manifest.network?.domains ?? [], credentials, rawSecrets: manifest.rawSecrets ?? [] },
        new Date().toISOString().slice(0, 10),
      ),
    ).toEqual([]);
    // No host beyond what a record names: the egress list is the records'.
    expect([...(manifest.network?.domains ?? [])].sort()).toEqual(
      [...new Set([...TR1_RECORDS, ...TR2_RECORDS, ...TR3_RECORDS].flatMap((record) => record.hosts))].sort(),
    );
    // A query or OAuth client key is held raw; a header key never is.
    expect(manifest.rawSecrets).toEqual(["youtubeKey", "googleTrendsKey", "redditClientId", "redditSecret"]);
    // No paid service: no key, cap or host for X, Yandex Wordstat or Tavily, each excluded with its reason.
    for (const key of [
      "xBearer",
      "xSamples",
      "xDailyUsdCap",
      "xMonthlyUsdCap",
      "paidDailyUsdCap",
      "yandexKey",
      "yandexFolderId",
      "tavilyKey",
    ])
      expect(manifest.config, key).not.toHaveProperty(key);
    for (const host of ["api.x.com", "searchapi.api.cloud.yandex.net", "api.tavily.com"])
      expect(manifest.network?.domains).not.toContain(host);
    expect(excluded.filter((entry) => ["x", "yandex-wordstat", "tavily-news"].includes(entry.id)).map((entry) => entry.reason)).toEqual(
      Array(3).fill(expect.stringMatching(/no paid service/)),
    );
    // Nothing is required at install: the keyless sources work at once.
    expect(Object.values(manifest.config).every((field) => field.required !== true)).toBe(true);
  });

  it("has no record or host for a source it excludes, and says why for each", () => {
    const ids = [...TR1_RECORDS, ...TR2_RECORDS, ...TR3_RECORDS].map((record) => record.id);
    for (const entry of excluded) {
      expect(ids, entry.id).not.toContain(entry.id);
      expect(entry.reason.length).toBeGreaterThan(10);
    }
    // Naver's DataLab API is in; its news ranking and search API are not.
    for (const host of manifest.network?.domains ?? [])
      expect(host, host).not.toMatch(/zhihu|xiaohongshu|telegram|line\.me|news\.naver|tiktok|linkedin/);
  });

  it("routes each country only to sources that exist", () => {
    const ids = new Set(
      [...TR1_ADAPTERS, ...TR2_ADAPTERS].map((adapter) => adapter.record.id).concat(TR3_RECORDS.map((record) => record.id)),
    );
    for (const file of readdirSync(join(root, "routing"))) {
      const route = JSON.parse(readFileSync(join(root, "routing", file), "utf8")) as { country: string; order: string[] };
      expect(`${route.country}.json`).toBe(file);
      for (const id of route.order) expect(ids.has(id), `${file}: ${id}`).toBe(true);
    }
  });

  it("registers exactly the tools it declares, and the spikes source", () => {
    const names: string[] = [];
    const sources: string[] = [];
    register({
      z,
      config: {},
      secret: async () => null,
      registerTool: (tool: { name: string }) => void names.push(tool.name),
      provideSignals: (source: { id: string }) => void sources.push(source.id),
    } as never);
    expect(names).toEqual(manifest.tools.map((tool) => tool.name));
    expect(sources).toEqual(["spikes"]);
  });

  it("takes one watch object per op, refusing what that op does not take", () => {
    const schemas = new Map<string, { safeParse: (input: unknown) => { success: boolean; data?: unknown } }>();
    register({
      z,
      config: {},
      secret: async () => null,
      registerTool: (tool: { name: string; inputSchema: never }) => void schemas.set(tool.name, tool.inputSchema),
      provideSignals: () => undefined,
    } as never);
    const watch = schemas.get("watch");
    expect(watch?.safeParse({ op: "update", topicId: "t1", topic: { label: "Batteries" } }).success).toBe(true);
    expect(watch?.safeParse({ op: "pause" }).success).toBe(false);
    expect(watch?.safeParse({ op: "remove", topicId: "t1", topic: { label: "Batteries" } }).success).toBe(false);
    // The worker reports one form per op, which the owner sends a model as one object.
    const schema = z.toJSONSchema(watch as never, { io: "input", target: "draft-7", unrepresentable: "any" }) as { oneOf?: unknown[] };
    expect(schema.oneOf).toHaveLength(5);
  });

  it("refuses to open its stores outside a confined worker", async () => {
    const tools = new Map<string, (input: unknown, options: { signal: AbortSignal }, context?: unknown) => Promise<unknown>>();
    register({
      z,
      config: {},
      secret: async () => null,
      registerTool: (tool: { name: string; handler: never }) => void tools.set(tool.name, tool.handler),
    } as never);
    await expect(Promise.resolve().then(() => tools.get("sources")?.({}, { signal: new AbortController().signal }))).rejects.toThrow(
      /only as a confined worker/,
    );
  });
});
