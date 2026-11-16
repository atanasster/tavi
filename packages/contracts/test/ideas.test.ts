import { describe, expect, it } from "vitest";

import { PluginToolDeclarationSchema } from "../src/plugin-registry.js";

import {
  IDEA_CATEGORIES,
  IDEA_CATEGORY_LABELS,
  IDEA_ICONS,
  IDEA_PROMPT_MAX,
  IDEA_SIGNALS,
  IdeaDraftSchema,
  IdeaKeySchema,
  IdeaSchema,
  IDEA_PERSON_SIGNALS,
  IdeasPayloadSchema,
} from "../src/index.js";

/** Ideas' contracts. */

const draft = {
  key: "travel.fare-watch:sofia-lisbon",
  templateId: "6.1",
  category: "travel",
  icon: "✈️",
  title: "I can watch Sofia–Lisbon fares for your May trip",
  pitch: "You mentioned Lisbon in May. I can compare carriers now and tell you when the fare drops.",
  label: "Watch Lisbon fares",
  prompt: "Find flights from Sofia to Lisbon in May and keep watching for a drop.",
  basis: [{ kind: "memory", ref: "mem-1", excerpt: "Trip to Lisbon in May" }],
  uses: [{ capability: "travel", approval: false }],
  recurring: { cadence: "daily" },
} as const;

describe("idea contracts", () => {
  it("takes a well-formed draft and refuses one past its limits", () => {
    expect(IdeaDraftSchema.parse(draft)).toEqual(draft);
    expect(IdeaDraftSchema.safeParse({ ...draft, prompt: "x".repeat(IDEA_PROMPT_MAX + 1) }).success).toBe(false);
    expect(IdeaDraftSchema.safeParse({ ...draft, basis: [] }).success).toBe(false);
    expect(IdeaDraftSchema.safeParse({ ...draft, uses: [] }).success).toBe(false);
    expect(IdeaDraftSchema.safeParse({ ...draft, uses: [{ capability: "teleport", approval: false }] }).success).toBe(false);
    expect(IdeaDraftSchema.safeParse({ ...draft, icon: "click here" }).success).toBe(false);
    expect(IdeaDraftSchema.safeParse({ ...draft, extra: 1 }).success).toBe(false);
  });

  it("a key starts with its section, and text a person reads has no control or bidi characters", () => {
    expect(IdeaDraftSchema.safeParse({ ...draft, category: "shopping" }).success).toBe(false);
    expect(IdeaDraftSchema.safeParse({ ...draft, title: "I can \u202ewatch fares" }).success).toBe(false);
    expect(IdeaDraftSchema.safeParse({ ...draft, label: "Watch\nfares" }).success).toBe(false);
    expect(IdeaDraftSchema.safeParse({ ...draft, prompt: "Find flights.\nKeep watching." }).success).toBe(true);
    expect(IdeaDraftSchema.safeParse({ ...draft, basis: [{ kind: "general", ref: "6.1" }] }).success).toBe(true);
    expect(IdeaDraftSchema.safeParse({ ...draft, basis: [{ kind: "general", ref: "general" }] }).success).toBe(true);
    // A general basis names the template, never text a provider chose to show as provenance.
    expect(IdeaDraftSchema.safeParse({ ...draft, basis: [{ kind: "general", ref: "your affair with Sam" }] }).success).toBe(false);
    expect(IdeaDraftSchema.safeParse({ ...draft, basis: [{ kind: "catalogue", ref: "6.1" }] }).success).toBe(false);
    // Line and paragraph separators and bidi marks break a "one line" as surely as a newline.
    for (const mark of ["\u2028", "\u2029", "\u200e", "\u200f", "\u061c"])
      expect(IdeaDraftSchema.safeParse({ ...draft, title: `I can${mark} watch fares` }).success).toBe(false);
    // A provider's own ref and excerpt are held to the same rules.
    expect(IdeaDraftSchema.safeParse({ ...draft, basis: [{ kind: "general", ref: "x\u001b[31m" }] }).success).toBe(false);
    expect(IdeaDraftSchema.safeParse({ ...draft, basis: [{ kind: "memory", ref: "mem-1", excerpt: "line\nbreak" }] }).success).toBe(false);
  });

  it("an icon written without its variation selector is the same icon", () => {
    expect(IdeaDraftSchema.parse({ ...draft, icon: "\u2708" }).icon).toBe("✈️");
  });

  it("keys are lower-case words with an optional subject", () => {
    for (const key of ["travel.fare-watch", "travel.fare-watch:sofia-lisbon", "brief_1"])
      expect(IdeaKeySchema.safeParse(key).success).toBe(true);
    for (const key of ["Travel", "a:b:c", ":x", "a b"]) expect(IdeaKeySchema.safeParse(key).success).toBe(false);
  });

  it("a stored idea carries its run, score, status and times", () => {
    const now = "2026-10-19T10:00:00.000Z";
    const idea = {
      ...draft,
      id: "idea-1",
      workspaceId: "default",
      runId: "run-1",
      providerId: "tavi.ideasagent",
      score: 0.8,
      status: "active",
      pinned: false,
      shownRuns: 1,
      createdAt: now,
      updatedAt: now,
      expiresAt: now,
    };
    expect(IdeaSchema.parse(idea).status).toBe("active");
    expect(IdeaSchema.safeParse({ ...idea, score: 2 }).success).toBe(false);
  });

  it("every section has a heading, and icons are unique", () => {
    expect(Object.keys(IDEA_CATEGORY_LABELS).sort()).toEqual([...IDEA_CATEGORIES].sort());
    expect(new Set(IDEA_ICONS).size).toBe(IDEA_ICONS.length);
  });

  it("a person's signals are a subset of the ledger's", () => {
    for (const signal of IDEA_PERSON_SIGNALS) expect(IDEA_SIGNALS).toContain(signal);
  });
});

describe("ideas IPC", () => {
  const ok = (payload: unknown) => IdeasPayloadSchema.safeParse(payload).success;

  it("knows its actions", () => {
    expect(ok({ action: "list" })).toBe(true);
    expect(ok({ action: "launch" })).toBe(false);
  });

  it("feedback names what each signal is about", () => {
    expect(ok({ action: "feedback", signal: "not-now", id: "idea-1" })).toBe(true);
    expect(ok({ action: "feedback", signal: "not-now" })).toBe(false);
    expect(ok({ action: "feedback", signal: "mute-category", category: "travel" })).toBe(true);
    expect(ok({ action: "feedback", signal: "mute-category", id: "idea-1" })).toBe(true);
    expect(ok({ action: "feedback", signal: "mute-category" })).toBe(false);
    expect(ok({ action: "feedback", signal: "exclude-basis", id: "idea-1", basisRef: "mem-1" })).toBe(true);
    expect(ok({ action: "feedback", signal: "exclude-basis", id: "idea-1" })).toBe(false);
    expect(ok({ action: "feedback", signal: "include-basis", basisRef: "mem-1" })).toBe(true);
    // An edit is the owner's to record, from what a chat an idea started was sent: a client never claims one.
    expect(ok({ action: "feedback", signal: "edited", id: "idea-1", editedPrompt: "Watch Lisbon fares in June" })).toBe(false);
    expect(ok({ action: "feedback", signal: "done", id: "idea-1" })).toBe(false);
  });

  it("the owner's own signals cannot be sent", () => {
    for (const signal of ["tried", "done", "ignored"]) expect(ok({ action: "feedback", signal, id: "idea-1" })).toBe(false);
  });

  it("limits chips, the brief and the settings", () => {
    expect(ok({ action: "chips", limit: 3 })).toBe(true);
    expect(ok({ action: "chips", limit: 4 })).toBe(false);
    expect(ok({ action: "set-brief", text: "More about the garden, nothing about money." })).toBe(true);
    expect(ok({ action: "set-brief", text: "x".repeat(2_001) })).toBe(false);
    expect(ok({ action: "set-settings", changes: { sources: { memory: false } } })).toBe(true);
    expect(ok({ action: "set-settings", changes: { digest: null } })).toBe(true);
    expect(ok({ action: "set-settings", changes: { digest: { channel: "telegram", weekday: 1 } } })).toBe(true);
    expect(ok({ action: "set-settings", changes: { digest: { channel: "telegram", weekday: 7 } } })).toBe(false);
    expect(ok({ action: "set-settings", changes: { colour: "red" } })).toBe(false);
    expect(ok({ action: "remind", id: "idea-1", at: "2026-10-20T09:00:00.000Z" })).toBe(true);
    expect(ok({ action: "reset", what: "ledger" })).toBe(true);
  });
});

describe("ideas providers", () => {
  it("a plugin declares what its provider receives, and settings default to the built-in one", async () => {
    const {
      PluginIdeasDeclarationSchema,
      IdeaSettingsSchema,
      IDEA_DEFAULT_SETTINGS,
      BUILTIN_IDEAS_PROVIDER_ID,
      IDEAS_ABI,
      ideasProviderFailure,
      IdeasProviderError,
    } = await import("../src/index.js");
    expect(PluginIdeasDeclarationSchema.parse({ abi: IDEAS_ABI, receives: ["memory", "ledger"] })).toEqual({
      abi: IDEAS_ABI,
      receives: ["memory", "ledger"],
      usesTurns: false,
      maxRunSeconds: 30,
    });
    expect(PluginIdeasDeclarationSchema.safeParse({ abi: IDEAS_ABI, receives: ["memory", "memory"] }).success).toBe(false);
    expect(PluginIdeasDeclarationSchema.safeParse({ abi: IDEAS_ABI, receives: ["contacts"] }).success).toBe(false);
    expect(PluginIdeasDeclarationSchema.safeParse({ abi: "tavi.ideas/0", receives: [] }).success).toBe(false);
    expect(IdeaSettingsSchema.parse({ enabled: true, chips: true, sources: { memory: true, tasks: true, brief: true } }).provider).toBe(
      BUILTIN_IDEAS_PROVIDER_ID,
    );
    const settings = IdeaSettingsSchema.parse({ enabled: true, chips: true, sources: { memory: true, tasks: true, brief: true } });
    expect([settings.dailyTokens, settings.hours]).toEqual([IDEA_DEFAULT_SETTINGS.dailyTokens, { start: "08:00", end: "22:00" }]);
    expect(IdeaSettingsSchema.safeParse({ ...settings, hours: { start: "8:00", end: "22:00" } }).success).toBe(false);
    expect(IdeaSettingsSchema.safeParse({ ...settings, dailyTokens: -1 }).success).toBe(false);
    expect(ideasProviderFailure(new IdeasProviderError("budget"))).toBe("budget");
    expect(ideasProviderFailure(new Error("boom"))).toBe("transport");
    const { describeIdeasDeclaration } = await import("../src/index.js");
    expect(
      describeIdeasDeclaration({
        abi: "tavi.ideas/1",
        receives: ["memory", "ledger"],
        maxRunSeconds: 30,
        disclosure: "Runs on your machine.",
      }),
    ).toBe(
      "Ideas provider: it may receive your approved, non-sensitive preferences and facts (while its switch is on); which ideas you dismissed, snoozed, muted or asked more of. It proposes ideas only; Tavi checks each one and never lets it send or run anything. It says: Runs on your machine.",
    );
  });

  it("a manifest names an ideas provider with both provides and its declaration", async () => {
    const { PluginManifestSchema, IDEAS_ABI, workerRefusal } = await import("../src/index.js");
    const base = {
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.ideas",
      version: "1.0.0",
      name: "Acme ideas",
      entry: "index.mjs",
    };
    const parse = (manifest: Record<string, unknown>) => PluginManifestSchema.safeParse({ ...base, ...manifest });
    const ideas = { abi: IDEAS_ABI, receives: ["ledger"] };
    const parsed = parse({ provides: ["ideas"], ideas });
    expect(parsed.success).toBe(true);
    expect(parse({ provides: ["ideas"] }).success).toBe(false);
    expect(parse({ ideas }).success).toBe(false);
    // A provider is a live object: it runs in the owner, never as a confined worker.
    if (parsed.success) expect(workerRefusal(parsed.data)).toContain("an ideas provider");
    // Its hooks name their sources and leave out prepared ideas: it never reads the steps of the ideas it wrote.
    const hook = (sources?: readonly string[]) => ({
      mods: {
        abi: "tavi.mods/1",
        hooks: [{ event: "turn.complete", disclosure: "Counts turns.", ...(sources === undefined ? {} : { match: { sources } }) }],
      },
    });
    expect(parse({ provides: ["ideas"], ideas, ...hook() }).success).toBe(false);
    expect(parse({ provides: ["ideas"], ideas, ...hook(["web", "ideas"]) }).success).toBe(false);
    expect(parse({ provides: ["ideas"], ideas, ...hook(["web"]) }).success).toBe(true);
  });

  it("an idea is tried in a new chat only: never Home or a standalone run", async () => {
    const { RunPayloadSchema } = await import("../src/index.js");
    const base = {
      prompt: "Find flights",
      workspaceId: "default",
      principal: "operator",
      operationKey: "op-1",
      approval: "client",
      fromIdeaId: "idea-1",
    };
    expect(RunPayloadSchema.safeParse(base).success).toBe(true);
    expect(RunPayloadSchema.safeParse({ ...base, target: "home" }).success).toBe(false);
    expect(RunPayloadSchema.safeParse({ ...base, target: "run" }).success).toBe(false);
  });
});

describe("what a plugin declares it proves", () => {
  it("is one of the categories plugins bring, never one of Tavi's own capabilities", () => {
    const tool = { name: "search", effect: "read-only", description: "Search" };
    expect(PluginToolDeclarationSchema.safeParse({ ...tool, proves: ["trends"] }).success).toBe(true);
    for (const own of ["web", "browser", "files", "memory"])
      expect(PluginToolDeclarationSchema.safeParse({ ...tool, proves: [own] }).success).toBe(false);
  });
});
