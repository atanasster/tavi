import { describe, expect, it } from "vitest";

import {
  BUILTIN_MEMORY_PROVIDER_ID,
  DEFAULT_MEMORY_MAX_BYTES,
  memoryPersonalDisclosure,
  memoryProviderEgressOf,
  withMemoryEgress,
  withMemoryProvider,
  MEMORY_CONFIG_KEYS,
  MEMORY_LIMIT_BOUNDS,
  MEMORY_PROPOSAL_TTL_DAYS,
  MemorySettingsSchema,
  WORKSPACE_SETTING_KEYS,
  WorkspaceSettingsSchema,
  absentWorkspaceSettings,
  effectiveMemorySettings,
  memoryConfigKeySet,
  memoryConfigValue,
  memoryProposalExpiresAt,
  memoryQuotasOf,
  memorySettingsDoctor,
  memoryEmbeddingDisclosure,
  memoryPersonalEmbeddingDisclosure,
  withMemoryConfig,
  workspaceSettingsAnswerOf,
} from "../src/index.js";

/** The workspace's `memory` section. */

describe("the memory settings section", () => {
  it("is a key of the workspace settings document", () => {
    expect(WORKSPACE_SETTING_KEYS).toContain("memory");
    expect(WorkspaceSettingsSchema.safeParse({ memory: { enabled: false, capture: "off", limits: { maxRecords: 10 } } }).success).toBe(
      true,
    );
  });

  it("has exactly today's behaviour when absent: on, suggest, and the shipped quotas, budget and proposal lifetime", () => {
    const effective = effectiveMemorySettings(undefined);
    expect(effective).toEqual({
      enabled: true,
      capture: "suggest",
      autoApprove: [],
      digest: "weekly",
      sensitive: "skip",
      retrieval: "lexical",
      consolidation: "off",
      limits: { contextTokens: 8_000, evidence: 10, proposalDays: MEMORY_PROPOSAL_TTL_DAYS, maxRecords: 5_000 },
      provider: BUILTIN_MEMORY_PROVIDER_ID,
      providerEgress: { records: false, conversation: false, includePersonal: false },
    });
    expect(memoryQuotasOf(effective)).toEqual({ maxRecords: 5_000, maxBytes: DEFAULT_MEMORY_MAX_BYTES });
    // An embedder's own budget stays the default of limits.contextTokens; a set one wins.
    expect(effectiveMemorySettings(undefined, { contextTokens: 12_000 }).limits.contextTokens).toBe(12_000);
    expect(effectiveMemorySettings({ limits: { contextTokens: 4_000 } }, { contextTokens: 12_000 }).limits.contextTokens).toBe(4_000);
    // The answer every client reads carries it.
    expect(workspaceSettingsAnswerOf(absentWorkspaceSettings("default"), "UTC").effective.memory).toEqual(effective);
  });

  it("refuses a key no step has added", () => {
    for (const later of [{ autoKeep: ["fact"] }, { autoApprove: ["summary"] }, { providerEgress: { ledger: true } }]) {
      expect(MemorySettingsSchema.safeParse(later).success, JSON.stringify(later)).toBe(false);
    }
    // The provider and its egress are set outside `tavi memory config`'s keys.
    expect(MemorySettingsSchema.safeParse({ provider: "acme.memory", providerEgress: { records: true } }).success).toBe(true);
    expect(MemorySettingsSchema.safeParse({ limits: { other: 1 } }).success).toBe(false);
    expect(MEMORY_CONFIG_KEYS).toEqual([
      "enabled",
      "capture",
      "auto-approve",
      "sensitive",
      "retrieval",
      "digest",
      "consolidation",
      "limits.contextTokens",
      "limits.evidence",
      "limits.proposalDays",
      "limits.maxRecords",
    ]);
  });

  it("selects a provider with its egress off, and holds personal memory to records", () => {
    const chosen = withMemoryEgress(withMemoryProvider({ capture: "off" }, "acme.memory"), "records", true);
    expect(chosen).toEqual({ capture: "off", provider: "acme.memory", providerEgress: { records: true } });
    expect(effectiveMemorySettings(withMemoryEgress(chosen, "personal", true)).providerEgress).toEqual({
      records: true,
      conversation: false,
      includePersonal: true,
    });
    // Another provider: every switch off again; the built-in is no key.
    expect(withMemoryProvider(withMemoryEgress(chosen, "conversation", true), "acme.other")).toEqual({
      capture: "off",
      provider: "acme.other",
    });
    expect(withMemoryProvider(chosen, BUILTIN_MEMORY_PROVIDER_ID)).toEqual({ capture: "off" });
    // Personal needs records; records off takes personal with it.
    expect(() => withMemoryEgress({ provider: "acme.memory" }, "personal", true)).toThrow(/turn records on first/);
    expect(
      withMemoryEgress({ provider: "acme.memory", providerEgress: { records: true, includePersonal: true } }, "records", false),
    ).toEqual({ provider: "acme.memory" });
    // A stored includePersonal without records means nothing.
    expect(memoryProviderEgressOf({ providerEgress: { includePersonal: true } })).toEqual({
      records: false,
      conversation: false,
      includePersonal: false,
    });
    expect(memoryPersonalDisclosure("acme.memory")).toMatch(/shared by all your workspaces.*acme\.memory/);
  });

  it("refuses each limit outside its bounds, and takes each bound itself", () => {
    for (const [name, bounds] of Object.entries(MEMORY_LIMIT_BOUNDS)) {
      expect(MemorySettingsSchema.safeParse({ limits: { [name]: bounds.min } }).success).toBe(true);
      expect(MemorySettingsSchema.safeParse({ limits: { [name]: bounds.max } }).success).toBe(true);
      expect(MemorySettingsSchema.safeParse({ limits: { [name]: bounds.min - 1 } }).success, `${name} below`).toBe(false);
      expect(MemorySettingsSchema.safeParse({ limits: { [name]: bounds.max + 1 } }).success, `${name} above`).toBe(false);
      expect(MemorySettingsSchema.safeParse({ limits: { [name]: bounds.min + 0.5 } }).success, `${name} fraction`).toBe(false);
    }
    expect(MemorySettingsSchema.safeParse({ capture: "always" }).success).toBe(false);
    expect(MemorySettingsSchema.safeParse({ digest: "daily" }).success).toBe(false);
  });

  it("takes auto-approve: none by default, a comma list of kinds when set, typed as the CLI types it, and always shown by doctor", () => {
    expect(MemorySettingsSchema.safeParse({ autoApprove: ["fact", "preference"] }).success).toBe(true);
    expect(MemorySettingsSchema.safeParse({ autoApprove: ["summary"] }).success).toBe(false);
    expect(effectiveMemorySettings(undefined).autoApprove).toEqual([]);
    // Canonical order, each kind once.
    expect(effectiveMemorySettings({ autoApprove: ["lesson", "fact", "fact"] }).autoApprove).toEqual(["fact", "lesson"]);
    const section = withMemoryConfig(undefined, "auto-approve", "Facts, preference");
    expect(section).toEqual({ autoApprove: ["preference", "fact"] });
    expect(memoryConfigValue(effectiveMemorySettings(section), "auto-approve")).toBe("preference,fact");
    expect(memoryConfigValue(effectiveMemorySettings(undefined), "auto-approve")).toBe("none");
    expect(memoryConfigKeySet(section, "auto-approve")).toBe(true);
    expect(memoryConfigKeySet(undefined, "auto-approve")).toBe(false);
    expect(withMemoryConfig(section, "auto-approve", "none")).toEqual({});
    expect(withMemoryConfig(section, "auto-approve", "default")).toEqual({});
    expect(() => withMemoryConfig(undefined, "auto-approve", "fact,summary")).toThrow(
      /expected a comma list of preference, fact and lesson, or none/,
    );
    // Doctor names every kind kept without asking, and says so when there is none: it relaxes the approval gate.
    expect(memorySettingsDoctor(section)).toEqual({ state: "on", capture: "suggest", autoApprove: ["preference", "fact"], changed: {} });
    expect(memorySettingsDoctor(undefined).autoApprove).toEqual([]);
  });

  it("takes the digest: weekly by default, off when set, typed as the CLI types it", () => {
    expect(MemorySettingsSchema.safeParse({ digest: "off" }).success).toBe(true);
    expect(effectiveMemorySettings({ digest: "off" }).digest).toBe("off");
    const section = withMemoryConfig(undefined, "digest", "off");
    expect(section).toEqual({ digest: "off" });
    expect(memoryConfigValue(effectiveMemorySettings(section), "digest")).toBe("off");
    expect(memoryConfigKeySet(section, "digest")).toBe(true);
    expect(withMemoryConfig(section, "digest", "default")).toEqual({});
    expect(() => withMemoryConfig(undefined, "digest", "daily")).toThrow(/expected weekly or off/);
    expect(memorySettingsDoctor({ digest: "off" }).changed).toEqual({ digest: "off" });
  });

  it("takes sensitive topics: skip by default, suggest when set, typed as the CLI types it, and shown by doctor when changed", () => {
    expect(MemorySettingsSchema.safeParse({ sensitive: "suggest" }).success).toBe(true);
    expect(MemorySettingsSchema.safeParse({ sensitive: "always" }).success).toBe(false);
    expect(effectiveMemorySettings(undefined).sensitive).toBe("skip");
    const section = withMemoryConfig(undefined, "sensitive", "Suggest");
    expect(section).toEqual({ sensitive: "suggest" });
    expect(memoryConfigValue(effectiveMemorySettings(section), "sensitive")).toBe("suggest");
    expect(memoryConfigKeySet(section, "sensitive")).toBe(true);
    expect(memoryConfigKeySet(undefined, "sensitive")).toBe(false);
    expect(withMemoryConfig(section, "sensitive", "default")).toEqual({});
    expect(() => withMemoryConfig(undefined, "sensitive", "save")).toThrow(/expected skip or suggest/);
    expect(memorySettingsDoctor(section).changed).toEqual({ sensitive: "suggest" });
    expect(memorySettingsDoctor({ sensitive: "skip" }).changed).toEqual({});
  });

  it("takes retrieval: lexical by default, hybrid when set, typed as the CLI types it, and shown by doctor when changed", () => {
    expect(MemorySettingsSchema.safeParse({ retrieval: "hybrid" }).success).toBe(true);
    expect(MemorySettingsSchema.safeParse({ retrieval: "vector" }).success).toBe(false);
    expect(effectiveMemorySettings(undefined).retrieval).toBe("lexical");
    const section = withMemoryConfig(undefined, "retrieval", "Hybrid");
    expect(section).toEqual({ retrieval: "hybrid" });
    expect(memoryConfigValue(effectiveMemorySettings(section), "retrieval")).toBe("hybrid");
    expect(memoryConfigKeySet(section, "retrieval")).toBe(true);
    expect(memoryConfigKeySet(undefined, "retrieval")).toBe(false);
    expect(withMemoryConfig(section, "retrieval", "default")).toEqual({});
    expect(() => withMemoryConfig(undefined, "retrieval", "semantic")).toThrow(/expected lexical or hybrid/);
    expect(memorySettingsDoctor(section).changed).toEqual({ retrieval: "hybrid" });
    expect(memorySettingsDoctor({ retrieval: "lexical" }).changed).toEqual({});
  });

  it("takes consolidation: off by default, weekly when set, typed as the CLI types it, and shown by doctor when changed", () => {
    expect(MemorySettingsSchema.safeParse({ consolidation: "weekly" }).success).toBe(true);
    expect(MemorySettingsSchema.safeParse({ consolidation: "daily" }).success).toBe(false);
    expect(effectiveMemorySettings(undefined).consolidation).toBe("off");
    const section = withMemoryConfig(undefined, "consolidation", "Weekly");
    expect(section).toEqual({ consolidation: "weekly" });
    expect(memoryConfigValue(effectiveMemorySettings(section), "consolidation")).toBe("weekly");
    expect(memoryConfigKeySet(section, "consolidation")).toBe(true);
    expect(memoryConfigKeySet(undefined, "consolidation")).toBe(false);
    expect(withMemoryConfig(section, "consolidation", "default")).toEqual({});
    expect(() => withMemoryConfig(undefined, "consolidation", "daily")).toThrow(/expected off or weekly/);
    expect(memorySettingsDoctor(section).changed).toEqual({ consolidation: "weekly" });
    expect(memorySettingsDoctor({ consolidation: "off" }).changed).toEqual({});
  });

  it("says what hybrid recall sends where, counting the workspace's records, and that personal memory is not sent without its own opt-in (invariant 14)", () => {
    const disclosure = memoryEmbeddingDisclosure({ connectionId: "cloud", records: 1_234 });
    expect(disclosure).toBe(
      "Memory text and each message's retrieval query will be sent to cloud to compute embeddings: 1,234 approved memories of this workspace now, and each new one as it is approved. Personal memory is not sent unless you turn on personal memory too, so it is matched by its words only.",
    );
    expect(memoryEmbeddingDisclosure({ connectionId: "cloud", records: 1 })).toMatch(/1 approved memory of this workspace now/);
  });

  it("says what embedding personal memory sends: the operator's own, shared by all their workspaces, and nobody else's", () => {
    expect(memoryPersonalEmbeddingDisclosure({ connectionId: "cloud", personal: 56 })).toBe(
      "Your personal memory is shared by all your workspaces: turning this on sends 56 of your approved personal memories (never sensitive ones) to cloud to compute embeddings now, and each new one as it is approved. Other people's personal memory is never sent there.",
    );
    expect(memoryPersonalEmbeddingDisclosure({ connectionId: "cloud", personal: 1 })).toMatch(
      /sends 1 of your approved personal memories \(/,
    );
  });

  it("shows doctor the accepted embedding connections beside the changed keys, personal memory's opt-in too", () => {
    expect(memorySettingsDoctor({ retrieval: "hybrid", retrievalConnection: "cloud" }).changed).toEqual({
      retrieval: "hybrid",
      retrievalConnection: "cloud",
    });
    expect(memorySettingsDoctor({ retrieval: "hybrid", retrievalConnection: "cloud", retrievalPersonal: "cloud" }).changed).toEqual({
      retrieval: "hybrid",
      retrievalConnection: "cloud",
      retrievalPersonal: "cloud",
    });
    expect(memorySettingsDoctor({ retrieval: "hybrid" }).changed).toEqual({ retrieval: "hybrid" });
  });

  it("keeps the accepted embedding connections in effect when stored, and none otherwise (invariant 14)", () => {
    expect(effectiveMemorySettings({ retrieval: "hybrid", retrievalConnection: "cloud" }).retrievalConnection).toBe("cloud");
    expect("retrievalConnection" in effectiveMemorySettings({ retrieval: "hybrid" })).toBe(false);
    expect(() => MemorySettingsSchema.parse({ retrievalConnection: "" })).toThrow();
    // Personal memory's opt-in: off (absent) by default, the connection it was accepted for when on.
    expect("retrievalPersonal" in effectiveMemorySettings({ retrieval: "hybrid", retrievalConnection: "cloud" })).toBe(false);
    expect(
      effectiveMemorySettings({ retrieval: "hybrid", retrievalConnection: "cloud", retrievalPersonal: "cloud" }).retrievalPersonal,
    ).toBe("cloud");
    expect(() => MemorySettingsSchema.parse({ retrievalPersonal: "" })).toThrow();
    expect(() => MemorySettingsSchema.parse({ retrievalPersonal: true })).toThrow();
  });

  it("changes one key as the CLI types it, clears it with default, and names a refused value", () => {
    let section = withMemoryConfig(undefined, "enabled", "off");
    expect(section).toEqual({ enabled: false });
    section = withMemoryConfig(section, "limits.maxRecords", "1,000");
    section = withMemoryConfig(section, "capture", "off");
    expect(section).toEqual({ enabled: false, capture: "off", limits: { maxRecords: 1_000 } });
    expect(memoryConfigValue(effectiveMemorySettings(section), "enabled")).toBe("off");
    expect(memoryConfigKeySet(section, "limits.maxRecords")).toBe(true);
    expect(memoryConfigKeySet(section, "limits.evidence")).toBe(false);
    section = withMemoryConfig(withMemoryConfig(section, "limits.maxRecords", "default"), "enabled", "default");
    expect(section).toEqual({ capture: "off" });
    expect(() => withMemoryConfig(undefined, "limits.evidence", "21")).toThrow(
      /"21" is not a value for memory limits.evidence; expected a whole number from 0 to 20/,
    );
    expect(() => withMemoryConfig(undefined, "capture", "always")).toThrow(/expected suggest or off/);
    expect(() => withMemoryConfig(undefined, "enabled", "maybe")).toThrow(/expected on or off/);
  });

  it("scales the byte quota with the record quota", () => {
    expect(memoryQuotasOf(effectiveMemorySettings({ limits: { maxRecords: 10 } }))).toEqual({
      maxRecords: 10,
      maxBytes: Math.round((10 * DEFAULT_MEMORY_MAX_BYTES) / 5_000),
    });
    expect(memoryQuotasOf(effectiveMemorySettings({ limits: { maxRecords: 20_000 } })).maxBytes).toBe(4 * DEFAULT_MEMORY_MAX_BYTES);
  });

  it("dates a proposal's expiry by the workspace's proposalDays", () => {
    expect(memoryProposalExpiresAt({ recordedAt: "2026-01-01T00:00:00.000Z" }, 7)).toBe("2026-01-08T00:00:00.000Z");
  });

  it("gives doctor on or paused, capture, and only the limits that differ from their defaults", () => {
    expect(memorySettingsDoctor(undefined)).toEqual({ state: "on", capture: "suggest", autoApprove: [], changed: {} });
    expect(memorySettingsDoctor({ enabled: false, capture: "off", limits: { evidence: 10, proposalDays: 7 } })).toEqual({
      state: "paused",
      capture: "off",
      autoApprove: [],
      changed: { "limits.proposalDays": "7" },
    });
  });
});
