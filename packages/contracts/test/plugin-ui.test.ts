import { describe, expect, it } from "vitest";

import {
  channelDisclosure,
  HostToPluginMessageSchema,
  PluginManifestSchema,
  PluginUiAnswerSchema,
  PluginUiSchema,
  UiPlacementsSettingSchema,
  UiRolesSettingSchema,
  WorkspaceSettingsSchema,
  describePluginUiContribution,
  pluginUiFiles,
  resolveContributions,
} from "../src/index.js";

/** The manifest's `ui` block. */
const contribution = {
  id: "live",
  role: "browser-view",
  title: "Browser",
  icon: "ui/icon.svg",
  document: "ui/live.html",
  channels: ["browser.live"],
  placements: [{ slot: "chat.panel.top", show: "while-active", height: { min: 140, default: 220, max: 480 } }, { slot: "chat.panel.tab" }],
  disclosure: "Receives live images of the pages the agent browses.",
};
const ui = { abi: "tavi.ui/1", contributions: [contribution] };
const base = {
  schemaVersion: 2,
  abi: "tavi.providers/1",
  provenance: { format: "bundled-esm", packages: [] },
  id: "acme.browserview",
  version: "1.0.0",
  name: "Acme view",
};

describe("UI plugin manifests", () => {
  it("accepts a UI-only manifest without an entry, and lists the files it names", () => {
    const parsed = PluginManifestSchema.parse({ ...base, ui });
    expect(parsed.entry).toBeUndefined();
    expect(pluginUiFiles(parsed.ui ?? PluginUiSchema.parse(ui))).toEqual(["ui/live.html", "ui/icon.svg"]);
    expect(describePluginUiContribution(PluginUiSchema.parse(ui).contributions[0] ?? (undefined as never))).toBe(
      "live (role browser-view) → chat.panel.top, chat.panel.tab; receives browser.live — Receives live images of the pages the agent browses.",
    );
  });

  it("needs an entry for owner code, and one of entry or ui", () => {
    expect(PluginManifestSchema.safeParse(base).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, ui, tools: [{ name: "x", effect: "read-only", description: "x" }] }).success).toBe(
      false,
    );
    expect(
      PluginManifestSchema.safeParse({ ...base, ui, entry: "index.mjs", tools: [{ name: "x", effect: "read-only", description: "x" }] })
        .success,
    ).toBe(true);
  });

  it("holds a contribution to the host's slots, roles and channels, paths inside the snapshot, and a disclosure for any channel", () => {
    const refused = (change: Record<string, unknown>) =>
      PluginUiSchema.safeParse({ abi: "tavi.ui/1", contributions: [{ ...contribution, ...change }] }).success;
    expect(refused({})).toBe(true);
    expect(refused({ disclosure: undefined })).toBe(false);
    expect(refused({ disclosure: undefined, channels: [] })).toBe(true);
    expect(refused({ channels: ["browser.cookies"] })).toBe(false);
    expect(refused({ channels: ["browser.control"] })).toBe(false);
    expect(refused({ role: "chat-view" })).toBe(false);
    expect(refused({ placements: [{ slot: "page.header" }] })).toBe(false);
    expect(refused({ placements: [{ slot: "chat.panel.tab" }, { slot: "chat.panel.tab" }] })).toBe(false);
    expect(refused({ placements: [{ slot: "chat.panel.top", height: { min: 300, default: 200, max: 400 } }] })).toBe(false);
    for (const document of ["../live.html", "/abs/live.html", "ui/live.js", "ui/../../x.html"]) expect(refused({ document })).toBe(false);
    expect(refused({ icon: "ui/icon.gif" })).toBe(false);
    expect(PluginUiSchema.safeParse({ abi: "tavi.ui/2", contributions: [contribution] }).success).toBe(false);
    expect(PluginUiSchema.safeParse({ abi: "tavi.ui/1", contributions: [contribution, contribution] }).success).toBe(false);
    expect(
      PluginUiSchema.safeParse({
        abi: "tavi.ui/1",
        contributions: Array.from({ length: 9 }, (_, index) => ({ ...contribution, id: `c${index}` })),
      }).success,
    ).toBe(false);
  });

  it("stores a workspace's UI roles and placements in its settings document", () => {
    expect(UiRolesSettingSchema.safeParse({ "browser-view": "acme.browserview" }).success).toBe(true);
    expect(UiRolesSettingSchema.safeParse({ "browser-view": "off" }).success).toBe(true);
    expect(UiRolesSettingSchema.safeParse({ "chat-view": "acme.x" }).success).toBe(false);
    expect(UiRolesSettingSchema.safeParse({ "browser-view": "Off" }).success).toBe(false);
    expect(UiRolesSettingSchema.safeParse({ "browser-view": "ACME.View" }).success).toBe(false);
    expect(UiRolesSettingSchema.safeParse({ "browser-view": "tavi.browserview" }).success).toBe(true);
    expect(
      UiPlacementsSettingSchema.safeParse({
        "acme.browserview/live": "hidden",
        "tavi.browserview/live": { slots: [{ slot: "chat.panel.tab" }] },
      }).success,
    ).toBe(true);
    expect(UiPlacementsSettingSchema.safeParse({ "acme.browserview": "hidden" }).success).toBe(false);
    expect(
      WorkspaceSettingsSchema.safeParse({ uiRoles: { "browser-view": "off" }, uiPlacements: { "acme.browserview/live": "hidden" } })
        .success,
    ).toBe(true);
  });

  it("words a channel's disclosure, saying what browser.control asks for and that it is not given", () => {
    expect(channelDisclosure(["browser.live"], "Sees the pages.")).toBe("Sees the pages.");
    expect(channelDisclosure(["browser.live"], undefined)).toBe("It receives browser.live.");
    expect(channelDisclosure(["browser.live", "browser.control"], "Sees the pages.")).toBe(
      "Sees the pages. It also asks to see and type into pages you take over, sign-in pages included; Tavi draws its own takeover surface, so it is not given them.",
    );
  });
});

describe("the onboarding.step slot", () => {
  const ui = (channels: readonly string[]) => ({
    abi: "tavi.ui/1",
    contributions: [
      {
        id: "intro",
        title: "Intro",
        document: "intro.html",
        channels,
        placements: [{ slot: "onboarding.step" }],
        ...(channels.length > 0 ? { disclosure: "It sees things." } : {}),
      },
    ],
  });

  it("takes a contribution that receives nothing, and refuses one with any channel", () => {
    expect(PluginUiSchema.safeParse(ui([])).success).toBe(true);
    const refused = PluginUiSchema.safeParse(ui(["mod.state"]));
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.message)).toContain("an onboarding.step contribution receives no channel");
  });

  it("drops a person's placement of a contribution that receives anything into it", () => {
    const entry = {
      pluginId: "acme.live",
      kind: "external" as const,
      contentHash: "b".repeat(64),
      ui: PluginUiSchema.parse({
        abi: "tavi.ui/1",
        contributions: [
          {
            id: "live",
            title: "Live",
            document: "live.html",
            channels: ["browser.live"],
            disclosure: "Pages.",
            placements: [{ slot: "chat.panel.tab" }],
          },
        ],
      }),
    };
    const { contributions } = resolveContributions([entry], {
      uiPlacements: { "acme.live/live": { slots: [{ slot: "onboarding.step" }, { slot: "chat.panel.top" }] } },
    });
    expect(contributions[0]?.placements.map((placement) => placement.slot)).toEqual(["chat.panel.top"]);
  });
});

describe("a plugin's language over tavi.ui/1", () => {
  const init = {
    abi: "tavi.ui/1",
    type: "init",
    pluginId: "acme.live",
    contributionId: "live",
    slot: "chat.panel.top",
    context: { workspaceId: "default" },
    channels: [],
    theme: { tokens: {}, colorScheme: "light" },
    size: { width: 10, height: 10 },
    reducedMotion: false,
    visible: true,
  };
  const messages = { "chip.live": "На живо", days: { one: "{count} ден", other: "{count} дни" } };

  it("takes init without a language, as an older host sends it, and with the language and the plugin's words", () => {
    expect(HostToPluginMessageSchema.safeParse(init).success).toBe(true);
    expect(HostToPluginMessageSchema.safeParse({ ...init, locale: "bg", messages }).success).toBe(true);
    expect(HostToPluginMessageSchema.safeParse({ ...init, locale: "en" }).success).toBe(true);
  });

  it("holds the language to one Tavi speaks, and the words to a pack's keys, shapes and bounds", () => {
    expect(HostToPluginMessageSchema.safeParse({ ...init, locale: "xx" }).success).toBe(false);
    expect(HostToPluginMessageSchema.safeParse({ ...init, locale: "bg", messages: { "bad key": "x" } }).success).toBe(false);
    expect(HostToPluginMessageSchema.safeParse({ ...init, locale: "bg", messages: { key: "" } }).success).toBe(false);
    expect(HostToPluginMessageSchema.safeParse({ ...init, locale: "bg", messages: { key: { one: "x" } } }).success).toBe(false);
    expect(HostToPluginMessageSchema.safeParse({ ...init, locale: "bg", messages: { key: "x".repeat(2001) } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`k${String(index)}`, "x"]));
    expect(HostToPluginMessageSchema.safeParse({ ...init, locale: "bg", messages: many }).success).toBe(false);
  });

  it("tells a change of language as a `locale` message, with or without words", () => {
    expect(HostToPluginMessageSchema.safeParse({ abi: "tavi.ui/1", type: "locale", locale: "bg", messages }).success).toBe(true);
    expect(HostToPluginMessageSchema.safeParse({ abi: "tavi.ui/1", type: "locale", locale: "en" }).success).toBe(true);
    expect(HostToPluginMessageSchema.safeParse({ abi: "tavi.ui/1", type: "locale" }).success).toBe(false);
    expect(HostToPluginMessageSchema.safeParse({ abi: "tavi.ui/1", type: "locale", locale: "bg", extra: 1 }).success).toBe(false);
  });

  it("serves an entry's language and words in `plugins ui`, and carries them to its resolved contributions", () => {
    const entry = { pluginId: "acme.live", kind: "external", version: "1.0.0", contentHash: "a".repeat(64), ui, locale: "bg", messages };
    const answer = PluginUiAnswerSchema.parse({ entries: [entry] });
    const chosen = { uiRoles: { "browser-view": "acme.live" } } as const;
    const [resolved] = resolveContributions(answer.entries, chosen).contributions;
    expect(resolved?.locale).toBe("bg");
    expect(resolved?.messages).toEqual(messages);
    // Without them (English, or an older owner) the contribution has neither.
    const english = resolveContributions(
      PluginUiAnswerSchema.parse({ entries: [{ ...entry, locale: undefined, messages: undefined }] }).entries,
      chosen,
    );
    expect(english.contributions).toHaveLength(1);
    expect(english.contributions[0]).not.toHaveProperty("locale");
    expect(english.contributions[0]).not.toHaveProperty("messages");
  });
});
