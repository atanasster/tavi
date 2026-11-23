import { describe, expect, it } from "vitest";

import {
  overlayPluginManifest,
  PluginManifestSchema,
  pluginLocaleProblems,
  pluginManifestVersionProblem,
  pluginOverlayTargets,
  pluginTranslate,
  type PluginManifest,
} from "../src/index.js";

/** A plugin's language packs: manifest schemaVersion 3, its ID-keyed overlay and its own messages. */

const base = {
  schemaVersion: 2,
  abi: "tavi.providers/1",
  provenance: { format: "bundled-esm", packages: [] },
  id: "acme.weather",
  version: "1.0.0",
  name: "Weather",
  description: "Forecasts for your town.",
  entry: "index.mjs",
  tools: [{ name: "forecast", effect: "read-only", description: "The forecast for a town", sink: "search" }],
  config: { apiKey: { type: "credential", label: "API key", description: "Your key from the weather service." } },
  apps: {
    abi: "tavi.apps/1",
    apps: [
      {
        id: "weather",
        name: "Weather",
        summary: "Forecasts",
        scopes: [{ scope: "https://api.example.com/forecast.read", says: "Read forecasts", access: "read" }],
        tools: { forecast: { title: "Forecast", says: "Looks up a forecast" } },
      },
    ],
  },
  ui: {
    abi: "tavi.ui/1",
    contributions: [{ id: "panel", title: "Weather", document: "ui/panel.html", placements: [{ slot: "chat.panel.tab" }] }],
  },
};

const v3 = { ...base, schemaVersion: 3, locales: { bg: "locales/bg.json" } };
const manifest: PluginManifest = PluginManifestSchema.parse(v3);

describe("the manifest's schemaVersion", () => {
  it("reads 2 as before, and 3 with language packs", () => {
    expect(PluginManifestSchema.parse(base).locales).toBeUndefined();
    expect(manifest.locales).toEqual({ bg: "locales/bg.json" });
  });

  it("refuses 1, locales under 2, 3 without locales, and a language Tavi does not speak", () => {
    expect(PluginManifestSchema.safeParse({ ...base, schemaVersion: 1 }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, locales: { bg: "locales/bg.json" } }).error?.message).toContain(
      "language packs (locales) need schemaVersion 3",
    );
    expect(PluginManifestSchema.safeParse({ ...base, schemaVersion: 3 }).error?.message).toContain("without them it stays 2");
    expect(PluginManifestSchema.safeParse({ ...v3, locales: { de: "locales/de.json" } }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...v3, locales: { bg: "../bg.json" } }).success).toBe(false);
  });

  it("says plainly that a newer manifest needs a newer Tavi", () => {
    expect(pluginManifestVersionProblem({ schemaVersion: 4 })).toBe(
      "tavi-plugin.json uses schemaVersion 4, which needs a newer Tavi: this one reads up to 3",
    );
    for (const raw of [{ schemaVersion: 3 }, { schemaVersion: 2 }, { schemaVersion: "9" }, null, "x"])
      expect(pluginManifestVersionProblem(raw)).toBeUndefined();
  });
});

describe("a language pack's manifest overlay", () => {
  const pack = (overlay: Record<string, string>, messages: Record<string, unknown> = {}) => ({ manifest: overlay, messages });

  it("takes ID-keyed paths to the words a person reads", () => {
    const words = {
      name: "Времето",
      "config.apiKey.label": "API ключ",
      "apps.apps.weather.scopes.https://api.example.com/forecast.read.says": "Чете прогнози",
      "apps.apps.weather.tools.forecast.title": "Прогноза",
      "ui.contributions.panel.title": "Времето",
    };
    expect(pluginLocaleProblems(manifest, "bg", pack(words))).toEqual([]);
    const overlaid = overlayPluginManifest(manifest, words);
    expect(overlaid.name).toBe("Времето");
    expect(overlaid.config["apiKey"]?.label).toBe("API ключ");
    expect(overlaid.apps?.apps[0]?.scopes[0]?.says).toBe("Чете прогнози");
    expect(overlaid.apps?.apps[0]?.tools["forecast"]?.title).toBe("Прогноза");
    expect(overlaid.ui?.contributions[0]?.title).toBe("Времето");
    // What the model reads, and the manifest itself, are untouched.
    expect(overlaid.tools[0]?.description).toBe("The forecast for a town");
    expect(manifest.name).toBe("Weather");
  });

  it("answers the manifest itself when there is nothing to lay over it", () => {
    expect(overlayPluginManifest(manifest, undefined)).toBe(manifest);
    expect(overlayPluginManifest(manifest, {})).toBe(manifest);
  });

  it("refuses an unknown path, a field the model reads, and words longer than their field", () => {
    expect(pluginLocaleProblems(manifest, "bg", pack({ "config.missing.label": "x" }))).toEqual([
      "config.missing.label is not a field of this manifest a language pack can translate",
    ]);
    expect(pluginLocaleProblems(manifest, "bg", pack({ "tools.forecast.description": "Прогнозата" }))).toEqual([
      "tools.forecast.description is read by the model, which reads the manifest's English; it cannot be translated",
    ]);
    expect(pluginLocaleProblems(manifest, "bg", pack({ "ui.contributions.panel.title": "x".repeat(41) }))).toEqual([
      "ui.contributions.panel.title is longer than the 40 characters its field takes",
    ]);
    // Laid over anyway (a pack that changed after install), a refused path changes nothing.
    expect(overlayPluginManifest(manifest, { "tools.forecast.description": "Прогнозата" }).tools[0]?.description).toBe(
      "The forecast for a town",
    );
  });

  it("refuses a routine template's prompts, and lists none of them as a target", () => {
    const withTemplate = PluginManifestSchema.parse({
      ...v3,
      routineTemplates: [
        {
          id: "digest-v1",
          title: "Digest",
          filename: "digest",
          quiet: { report: "Nothing new.", text: "Nothing new." },
          sourcesWord: "sources",
          research: "Research it.",
          synthesis: "Sum it up.",
          tools: ["acme.weather.forecast"],
        },
      ],
    });
    const targets = [...pluginOverlayTargets(withTemplate).keys()];
    expect(targets).toContain("routineTemplates.digest-v1.title");
    expect(targets.some((path) => path.startsWith("tools.") || /research|synthesis|corroboration/.test(path))).toBe(false);
    expect(pluginLocaleProblems(withTemplate, "bg", pack({ "routineTemplates.digest-v1.research": "Проучи" }))[0]).toContain(
      "read by the model",
    );
  });

  it("takes a channel's setup help up to its own 4000 characters, beyond the 2000 a message takes", () => {
    const withChannel = PluginManifestSchema.parse({
      ...v3,
      provides: ["channel"],
      channelAbi: 2,
      channels: [
        {
          providerId: "parrot",
          label: "Parrot",
          kind: "chat",
          description: "Chats by parrot.",
          setupHelp: "Pair it.",
          settings: [],
          auth: { kind: "secrets", fields: [{ key: "token", label: "Token" }] },
          sender: { label: "User ID", placeholder: "1", pattern: "\\d+", normalize: "none", authentication: "provider" },
          target: { label: "Room ID", placeholder: "1", pattern: "\\d+", normalize: "none" },
        },
      ],
    });
    expect(pluginLocaleProblems(withChannel, "bg", pack({ "channels.parrot.setupHelp": "я".repeat(3000) }))).toEqual([]);
    expect(pluginLocaleProblems(withChannel, "bg", pack({ "channels.parrot.setupHelp": "я".repeat(4001) })).length).toBeGreaterThan(0);
    expect(pluginLocaleProblems(withChannel, "bg", pack({ "channels.parrot.label": "я".repeat(3000) })).length).toBeGreaterThan(0);
  });

  it("keeps English's pack to messages: the manifest is the English", () => {
    expect(pluginLocaleProblems(manifest, "en", pack({}, { hello: "Hello" }))).toEqual([]);
    expect(pluginLocaleProblems(manifest, "en", pack({ name: "Weather!" }))).toEqual([
      "the English pack carries messages only: the manifest itself is the English",
    ]);
  });

  it("bounds a pack's entries and its messages", () => {
    const many = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`key${String(index)}`, "x"]));
    expect(pluginLocaleProblems(manifest, "bg", pack({}, many)).join(" ")).toContain("too many messages");
    expect(pluginLocaleProblems(manifest, "bg", pack({}, { "bad key": "x" })).length).toBeGreaterThan(0);
    expect(pluginLocaleProblems(manifest, "bg", { manifest: {}, messages: {}, extra: true }).length).toBeGreaterThan(0);
  });
});

describe("a plugin's own messages (ctx.t)", () => {
  const messages = {
    en: { hello: "Hello, {name}", only: "English only", days: { one: "{count} day", other: "{count} days" } },
    bg: { hello: "Здравей, {name}", days: { one: "{count} ден", other: "{count} дни" } },
  };

  it("says a key in the language, then in English, then the key itself", () => {
    expect(pluginTranslate(messages, "bg", "hello", { name: "Ана" })).toBe("Здравей, Ана");
    expect(pluginTranslate(messages, "bg", "only")).toBe("English only");
    expect(pluginTranslate(messages, "bg", "missing")).toBe("missing");
    expect(pluginTranslate(messages, "en", "hello", { name: "Ana" })).toBe("Hello, Ana");
    expect(pluginTranslate({}, "bg", "hello")).toBe("hello");
    expect(pluginTranslate(messages, "bg", "toString")).toBe("toString");
  });

  it("picks a plural form by the count, numbers written for the language", () => {
    expect(pluginTranslate(messages, "bg", "days", { count: 1 })).toBe("1 ден");
    expect(pluginTranslate(messages, "bg", "days", { count: 20000 })).toBe("20\u00a0000 дни");
    expect(pluginTranslate(messages, "en", "days", { count: 2 })).toBe("2 days");
  });
});
