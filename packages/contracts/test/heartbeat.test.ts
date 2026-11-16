import { describe, expect, it } from "vitest";

import {
  HEARTBEAT_ABI,
  HEARTBEAT_LIMITS,
  HEARTBEAT_PRODUCTION_OPTIONS,
  HeartbeatConfigSchema,
  HeartbeatItemSchema,
  HeartbeatProviderError,
  HeartbeatSignalSchema,
  PluginHeartbeatDeclarationSchema,
  PluginHeartbeatSignalsDeclarationSchema,
  defaultHeartbeatConfig,
  describeHeartbeatDeclaration,
  describeHeartbeatSignalsDeclaration,
  describePluginHeartbeat,
  formatHeartbeatInterval,
  heartbeatIntervalProblem,
  heartbeatKeyMuted,
  heartbeatHostAllowed,
  heartbeatProviderFailure,
  heartbeatWatchedPages,
  pluginSignalSourceLabel,
  withWatchedHosts,
} from "../src/heartbeat.js";
import { PluginManifestSchema } from "../src/plugin-registry.js";

/** The heartbeat contract. */
const base = {
  schemaVersion: 2,
  abi: "tavi.providers/1",
  provenance: { format: "bundled-esm", packages: [] },
  id: "acme.heartbeat",
  version: "1.0.0",
  name: "ACME heartbeat",
  entry: "index.mjs",
};
const heartbeat = { abi: HEARTBEAT_ABI, receives: ["signals", "ledger"] };
const router = { features: ["model"], pricing: { connectionId: "plugin:acme.router", model: "acme-1" } };

describe("the heartbeat config", () => {
  it("defaults to off, every 30 min from 08:00 to 22:00, with every egress switch off", () => {
    const config = HeartbeatConfigSchema.parse(defaultHeartbeatConfig());
    expect(config.enabled).toBe(false);
    expect(formatHeartbeatInterval(config.everyMs)).toBe("30m");
    expect(config.activeHours).toEqual({ start: "08:00", end: "22:00" });
    expect(Object.values(config.providerEgress).every((on) => !on)).toBe(true);
    expect(heartbeatIntervalProblem(config, HEARTBEAT_PRODUCTION_OPTIONS)).toBeUndefined();
  });

  it("refuses equal start and end, a deep look shorter than the check, and oversized instructions", () => {
    const config = defaultHeartbeatConfig();
    expect(HeartbeatConfigSchema.safeParse({ ...config, activeHours: { start: "09:00", end: "09:00" } }).success).toBe(false);
    expect(HeartbeatConfigSchema.safeParse({ ...config, deepCheckEveryMs: config.everyMs - 1 }).success).toBe(false);
    expect(HeartbeatConfigSchema.safeParse({ ...config, instructions: "x".repeat(HEARTBEAT_LIMITS.instructionsBytes + 1) }).success).toBe(
      false,
    );
    expect(HeartbeatConfigSchema.safeParse({ ...config, activeHours: { start: "22:00", end: "02:00" } }).success).toBe(true);
  });

  it("validates intervals against the host's options, so a test floor admits seconds", () => {
    const config = { ...defaultHeartbeatConfig(), everyMs: 2_000, deepCheckEveryMs: 4_000 };
    expect(heartbeatIntervalProblem(config, HEARTBEAT_PRODUCTION_OPTIONS)).toMatch(/check interval/);
    expect(heartbeatIntervalProblem(config, { every: [2_000, 4_000], deepCheckEvery: [4_000], floorMs: 1_000 })).toBeUndefined();
    expect(formatHeartbeatInterval(2_000)).toBe("2s");
  });

  it("mutes a key exactly, or every key under a prefix", () => {
    expect(heartbeatKeyMuted("stripe:invoice:in_1", ["stripe:invoice:*"])).toBe(true);
    expect(heartbeatKeyMuted("stripe:invoice:in_1", ["stripe:invoice:in_2"])).toBe(false);
    expect(HeartbeatConfigSchema.safeParse({ ...defaultHeartbeatConfig(), mutes: ["*"] }).success).toBe(false);
  });
});

describe("items and signals", () => {
  const item = { key: "stripe:invoice:in_123", urgency: "now", title: "ACME payment failed", sources: [{ label: "stripe" }] };

  it("bounds an item's title, body, sources and key", () => {
    expect(HeartbeatItemSchema.parse(item).urgency).toBe("now");
    expect(HeartbeatItemSchema.safeParse({ ...item, title: "x".repeat(HEARTBEAT_LIMITS.titleChars + 1) }).success).toBe(false);
    expect(HeartbeatItemSchema.safeParse({ ...item, body: "x".repeat(HEARTBEAT_LIMITS.bodyChars + 1) }).success).toBe(false);
    expect(HeartbeatItemSchema.safeParse({ ...item, sources: [] }).success).toBe(false);
    expect(HeartbeatItemSchema.safeParse({ ...item, key: "has spaces" }).success).toBe(false);
    expect(HeartbeatItemSchema.safeParse({ ...item, destination: "chat:1" }).success).toBe(false);
    expect(HeartbeatItemSchema.safeParse({ ...item, signalKeys: ["not a key"] }).success).toBe(false);
  });

  it("bounds a proposed action's input to 4 KiB of JSON", () => {
    const action = { toolId: "messaging.send_to", summary: "Reply to ACME" };
    expect(HeartbeatItemSchema.safeParse({ ...item, proposedAction: { ...action, input: { text: "hi" } } }).success).toBe(true);
    expect(
      HeartbeatItemSchema.safeParse({
        ...item,
        proposedAction: { ...action, input: { text: "x".repeat(HEARTBEAT_LIMITS.actionInputBytes) } },
      }).success,
    ).toBe(false);
  });

  it("bounds a signal's data to 2 KiB of JSON", () => {
    const signal = { key: "need:1", hash: "a", title: "A question waits", at: "2026-10-10T08:00:00.000Z", source: "needs" };
    expect(HeartbeatSignalSchema.safeParse({ ...signal, data: { id: 1 } }).success).toBe(true);
    expect(HeartbeatSignalSchema.safeParse({ ...signal, data: "x".repeat(HEARTBEAT_LIMITS.signalDataBytes + 1) }).success).toBe(false);
  });

  it("reads a provider's failure without trusting the thrown value", () => {
    expect(heartbeatProviderFailure(new HeartbeatProviderError("budget"))).toBe("budget");
    expect(heartbeatProviderFailure(new Error("boom"))).toBe("transport");
    const hostile = new Proxy(
      {},
      {
        has: () => {
          throw new Error("trap");
        },
      },
    );
    expect(heartbeatProviderFailure(hostile)).toBe("transport");
  });
});

describe("a manifest's heartbeat declarations", () => {
  it("parses a provider with its declaration, and derives a stable disclosure", () => {
    const parsed = PluginManifestSchema.parse({ ...base, provides: ["heartbeat"], heartbeat });
    expect(parsed.heartbeat?.maxTickSeconds).toBe(HEARTBEAT_LIMITS.builtinMaxTickSeconds);
    expect(describeHeartbeatDeclaration(PluginHeartbeatDeclarationSchema.parse(heartbeat))).toBe(
      "Heartbeat provider: decides what the heartbeat tells you. It may receive new signals (titles and metadata of what is waiting), what the heartbeat told you lately and your feedback, each only when you switch it on. It never sends anything itself; Tavi delivers. Each check is limited to 60 s.",
    );
  });

  it("refuses a provider without its block, a block without the provider, and a wrong ABI", () => {
    expect(PluginManifestSchema.safeParse({ ...base, provides: ["heartbeat"] }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, heartbeat }).success).toBe(false);
    expect(
      PluginManifestSchema.safeParse({ ...base, provides: ["heartbeat"], heartbeat: { ...heartbeat, abi: "tavi.heartbeat/2" } }).success,
    ).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, provides: ["heartbeat-signals"] }).success).toBe(false);
  });

  it("lets one plugin provide a router and a heartbeat", () => {
    const parsed = PluginManifestSchema.parse({ ...base, provides: ["router", "heartbeat"], router, heartbeat });
    expect(parsed.provides).toEqual(["router", "heartbeat"]);
  });

  it("parses signal sources", () => {
    const parsed = PluginManifestSchema.parse({
      ...base,
      provides: ["heartbeat-signals"],
      heartbeatSignals: { abi: HEARTBEAT_ABI, sources: ["queue"] },
    });
    expect(parsed.heartbeatSignals?.sources).toEqual(["queue"]);
    expect(
      describeHeartbeatSignalsDeclaration(PluginHeartbeatSignalsDeclarationSchema.parse({ abi: HEARTBEAT_ABI, sources: ["queue"] })),
    ).toBe(
      "Heartbeat signal sources (queue): add things for the heartbeat to watch. They run without a model, and what they return is treated as untrusted text.",
    );
  });

  it("names a plugin's source in words: its offer line, else its id in sentence case, and the plugin", () => {
    const bare = PluginHeartbeatSignalsDeclarationSchema.parse({ abi: HEARTBEAT_ABI, sources: ["watches", "new_posts"] });
    expect(pluginSignalSourceLabel("Jobs", "watches", bare)).toBe("Watches from Jobs");
    expect(pluginSignalSourceLabel("Feeds", "new_posts", bare)).toBe("New posts from Feeds");
    const offered = PluginHeartbeatSignalsDeclarationSchema.parse({
      abi: HEARTBEAT_ABI,
      sources: ["queue"],
      offers: { queue: "Jobs stuck in the queue" },
    });
    expect(pluginSignalSourceLabel("Acme", "queue", offered)).toBe("Jobs stuck in the queue, from Acme");
  });

  it("takes a one-line offer for each declared source, and says it at approval", () => {
    const declared = PluginHeartbeatSignalsDeclarationSchema.parse({
      abi: HEARTBEAT_ABI,
      sources: ["queue"],
      offers: { queue: "Jobs stuck in the queue" },
    });
    expect(describeHeartbeatSignalsDeclaration(declared)).toContain(
      'The heartbeat\'s first-run offer may suggest: "Jobs stuck in the queue".',
    );
    for (const offers of [
      { other: "Not a declared source" },
      { queue: "two\nlines" },
      { queue: "two\rlines" },
      { queue: "two\u2028lines" },
      { queue: "two\u2029lines" },
      { queue: "two\u0085lines" },
      { queue: "a\u000btab" },
      { queue: "a\u000cfeed" },
      { queue: "\u001b[31mred" },
      { queue: "" },
      { queue: "x".repeat(121) },
    ])
      expect(
        PluginHeartbeatSignalsDeclarationSchema.safeParse({ abi: HEARTBEAT_ABI, sources: ["queue"], offers }).success,
        JSON.stringify(offers),
      ).toBe(false);
  });

  it("words a version's heartbeat declarations for its review, one line each", () => {
    expect(describePluginHeartbeat({})).toEqual([]);
    expect(
      describePluginHeartbeat({
        heartbeat: PluginHeartbeatDeclarationSchema.parse(heartbeat),
        heartbeatSignals: PluginHeartbeatSignalsDeclarationSchema.parse({ abi: HEARTBEAT_ABI, sources: ["queue"] }),
      }),
    ).toEqual([
      describeHeartbeatDeclaration(PluginHeartbeatDeclarationSchema.parse(heartbeat)),
      describeHeartbeatSignalsDeclaration(PluginHeartbeatSignalsDeclarationSchema.parse({ abi: HEARTBEAT_ABI, sources: ["queue"] })),
    ]);
  });

  it("refuses a service listed twice", () => {
    expect(PluginManifestSchema.safeParse({ ...base, provides: ["heartbeat", "heartbeat"], heartbeat }).success).toBe(false);
  });

  it("refuses a provider whose hooks could match heartbeat turns", () => {
    const hook = (match?: object) => ({
      mods: {
        abi: "tavi.mods/1",
        hooks: [{ event: "tool.check", ...(match === undefined ? {} : { match }), disclosure: "Watches shell commands." }],
      },
    });
    expect(PluginManifestSchema.safeParse({ ...base, provides: ["heartbeat"], heartbeat, ...hook() }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, provides: ["heartbeat"], heartbeat, ...hook({ sources: ["cli"] }) }).success).toBe(
      true,
    );
    // A plugin that is not a provider may hook every turn.
    expect(PluginManifestSchema.safeParse({ ...base, ...hook() }).success).toBe(true);
  });
});

describe("watched pages", () => {
  it("reads each https watch line once, with its host and line, and nothing else", () => {
    const instructions = [
      "Tell me if a payment fails",
      "watch: https://example.com/pricing — tell me if the Pro price changes",
      "- Watch: https://News.Example.org/feed?x=1",
      "watch: http://insecure.test/page",
      "watch: https://user:pw@example.com/secret",
      "watch: https://example.com/pricing",
      "keep an eye on watch: https://not-a-line.test/",
      "watch: https://203.0.113.9/status",
      "watch: https://example.net:8443/admin",
      "watch: https://shop.example.com/sale.",
      "watch: https://example.com/pricing#pro",
      "watch: https://example.com/docs#intro",
    ].join("\n");
    expect(heartbeatWatchedPages(instructions)).toEqual([
      { url: "https://example.com/pricing", host: "example.com", line: 2 },
      { url: "https://news.example.org/feed?x=1", host: "news.example.org", line: 3 },
      { url: "https://shop.example.com/sale", host: "shop.example.com", line: 10 },
      // Without its fragment: the same page as line 2 is not read twice.
      { url: "https://example.com/docs", host: "example.com", line: 12 },
    ]);
  });

  it("reads at most 20 watched pages", () => {
    const lines = Array.from({ length: 25 }, (_, index) => `watch: https://example.com/page${index}`).join("\n");
    expect(heartbeatWatchedPages(lines)).toHaveLength(HEARTBEAT_LIMITS.watchedPages);
  });

  it("adds the host of a page newly watched to what it may read, once, unless already allowed or full", () => {
    const config = { ...defaultHeartbeatConfig(), fetchHosts: ["*.example.org"] };
    const watching = {
      ...config,
      instructions: "watch: https://example.com/a\nwatch: https://example.com/b\nwatch: https://news.example.org/feed",
    };
    expect(withWatchedHosts("", watching).fetchHosts).toEqual(["*.example.org", "example.com"]);
    // A page watched before adds nothing: a host the person removed stays removed.
    expect(
      withWatchedHosts("watch: https://example.com/a", { ...config, instructions: "watch: https://example.com/a" }).fetchHosts,
    ).toEqual(["*.example.org"]);
    const full = {
      ...config,
      fetchHosts: Array.from({ length: HEARTBEAT_LIMITS.fetchHosts }, (_, index) => `host${index}.test`),
      instructions: "watch: https://example.com/a",
    };
    expect(withWatchedHosts("", full).fetchHosts).toHaveLength(HEARTBEAT_LIMITS.fetchHosts);
    expect(heartbeatHostAllowed("news.example.org", ["*.example.org"])).toBe(true);
    expect(heartbeatHostAllowed("example.org.evil.test", ["*.example.org"])).toBe(false);
  });
});
