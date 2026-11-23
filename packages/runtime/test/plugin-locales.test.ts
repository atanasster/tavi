import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PLUGIN_BOUNDS, type ModEnvelope } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteStore } from "../src/persistence/store.js";
import { TurnHookRegistry } from "../src/plugin-host/turn-hooks.js";
import {
  PluginRegistry,
  hashPluginDirectory,
  localizedPluginManifest,
  readPluginManifest,
  readPluginMessages,
  readPluginSnapshot,
  validatePluginDirectory,
} from "../src/plugins/registry.js";

/**
 * A plugin's language packs as install reads them: `locales/<lang>.json` its
 * manifest declares, checked against the manifest and its limits, hashed with
 * the rest of the version, and laid over its English only for a listing asked
 * for in that language.
 */

const directories = temporaryDirectories();
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  directories.cleanup();
});

const BG = {
  manifest: {
    name: "Времето",
    description: "Прогнози за твоя град.",
    "config.city.label": "Град",
  },
  messages: { hello: "Здравей, {name}" },
};

function source(manifest: Record<string, unknown> = {}, packs: Record<string, unknown> = { "locales/bg.json": BG }): string {
  const directory = directories.create("tavi-plugin-locales-");
  writeFileSync(
    join(directory, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 3,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.weather",
      version: "1.0.0",
      name: "Weather",
      description: "Forecasts for your town.",
      entry: "index.mjs",
      tools: [{ name: "forecast", effect: "read-only", description: "Get a forecast", sink: "search" }],
      config: { city: { type: "string", label: "City" } },
      locales: { bg: "locales/bg.json", en: "locales/en.json" },
      ...manifest,
    }),
  );
  writeFileSync(join(directory, "index.mjs"), "export function register() {}\n");
  mkdirSync(join(directory, "locales"));
  const all: Record<string, unknown> = { "locales/en.json": { messages: { hello: "Hello, {name}", bye: "Bye" } }, ...packs };
  for (const [path, content] of Object.entries(all))
    if (content !== undefined) writeFileSync(join(directory, path), typeof content === "string" ? content : JSON.stringify(content));
  return directory;
}

function registry(): PluginRegistry {
  const dataDirectory = directories.create("tavi-plugin-locales-data-");
  const store = new SqliteStore({ databasePath: join(dataDirectory, "tavi.sqlite"), artifactsDirectory: join(dataDirectory, "artifacts") });
  stores.push(store);
  return new PluginRegistry({ repository: store.asPort().repositories.plugins, directory: join(dataDirectory, "plugins"), builtins: [] });
}

describe("a plugin's language packs at install", () => {
  it("are read, checked and hashed with the version", () => {
    const directory = source();
    const checked = validatePluginDirectory(directory);
    expect(checked.manifest.locales).toEqual({ bg: "locales/bg.json", en: "locales/en.json" });
    // A pack's bytes are the version's: changing one changes its hash.
    const before = hashPluginDirectory(directory).hash;
    expect(before).toBe(checked.hash);
    expect(readPluginSnapshot(directory).files.has("locales/bg.json")).toBe(true);
    const messages = readPluginMessages(directory, checked.manifest, before);
    expect(messages.bg?.["hello"]).toBe("Здравей, {name}");
    expect(messages.en?.["bye"]).toBe("Bye");
    writeFileSync(join(directory, "locales/bg.json"), JSON.stringify({ ...BG, messages: { hello: "Ей, {name}" } }));
    expect(hashPluginDirectory(directory).hash).not.toBe(before);
  });

  it("refuses a pack that is missing, not JSON, or over its limits", () => {
    expect(() => validatePluginDirectory(source({}, { "locales/bg.json": undefined }))).toThrow(
      "the manifest's language pack locales/bg.json does not exist",
    );
    expect(() => validatePluginDirectory(source({}, { "locales/bg.json": "{" }))).toThrow("the language pack locales/bg.json is not JSON");
    const big = { manifest: {}, messages: { long: "я".repeat(PLUGIN_BOUNDS.maxLocaleMessageChars) } };
    const padded = { ...big, messages: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${String(i)}`, big.messages.long])) };
    expect(() => validatePluginDirectory(source({}, { "locales/bg.json": padded }))).toThrow(
      `the language pack locales/bg.json is over ${String(PLUGIN_BOUNDS.maxLocaleBytes)} bytes`,
    );
  });

  it("refuses an unknown path and any field the model reads", () => {
    expect(() => validatePluginDirectory(source({}, { "locales/bg.json": { manifest: { "config.town.label": "Град" } } }))).toThrow(
      "config.town.label is not a field of this manifest a language pack can translate",
    );
    expect(() =>
      validatePluginDirectory(source({}, { "locales/bg.json": { manifest: { "tools.forecast.description": "Прогноза" } } })),
    ).toThrow("tools.forecast.description is read by the model");
  });

  it("says a newer manifest needs a newer Tavi, before its schema is checked", () => {
    const directory = source({ schemaVersion: 4 });
    const newer = "tavi-plugin.json uses schemaVersion 4, which needs a newer Tavi: this one reads up to 3";
    expect(() => readPluginManifest(directory)).toThrow(newer);
    expect(() => validatePluginDirectory(directory)).toThrow(newer);
  });
});

describe("a plugin's words in the workspace's language", () => {
  it("are laid over its English for a listing in that language, and English is unchanged", () => {
    const plugins = registry();
    const { record } = plugins.install(source(), "operator");
    const english = plugins.list();
    expect(JSON.stringify(plugins.list(undefined, "en"))).toBe(JSON.stringify(english));
    const view = plugins.list(undefined, "bg").find((plugin) => plugin.id === "acme.weather");
    expect(view?.name).toBe("Времето");
    expect(view?.description).toBe("Прогнози за твоя град.");
    expect(view?.configFields["city"]?.label).toBe("Град");
    expect(view?.versions[0]?.configFields["city"]?.label).toBe("Град");
    // The model's words, and what runs, stay English.
    expect(view?.tools[0]?.description).toBe("Get a forecast");
    expect(english.find((plugin) => plugin.id === "acme.weather")?.name).toBe("Weather");
    const directory = plugins.snapshotDirectory(record.pluginId, record.version);
    expect(localizedPluginManifest(directory, record.manifest, "bg", record.contentHash).name).toBe("Времето");
    expect(localizedPluginManifest(directory, record.manifest, "en", record.contentHash)).toBe(record.manifest);
    expect(localizedPluginManifest(directory, record.manifest, undefined, record.contentHash)).toBe(record.manifest);
  });

  it("are the version's own messages, by language", () => {
    const plugins = registry();
    const { record } = plugins.install(source(), "operator");
    const messages = readPluginMessages(plugins.snapshotDirectory(record.pluginId, record.version), record.manifest, record.contentHash);
    expect(messages.bg?.["hello"]).toBe("Здравей, {name}");
    expect(messages.en?.["bye"]).toBe("Bye");
  });

  it("fall back to English when a pack no longer checks out on disk", () => {
    const plugins = registry();
    const { record } = plugins.install(source(), "operator");
    const directory = plugins.snapshotDirectory(record.pluginId, record.version);
    writeFileSync(join(directory, "locales/bg.json"), JSON.stringify({ manifest: { "tools.forecast.description": "x" } }));
    expect(localizedPluginManifest(directory, record.manifest, "bg", record.contentHash)).toBe(record.manifest);
    expect(readPluginMessages(directory, record.manifest, record.contentHash).bg).toBeUndefined();
  });

  it("are never read from a snapshot changed after approval, however valid the change", () => {
    const plugins = registry();
    const { record } = plugins.install(source(), "operator");
    const directory = plugins.snapshotDirectory(record.pluginId, record.version);
    // A well-formed pack swapped in on disk: the snapshot no longer has its approved hash.
    writeFileSync(join(directory, "locales/bg.json"), JSON.stringify({ manifest: { name: "Подменено" }, messages: { hello: "Ей" } }));
    expect(localizedPluginManifest(directory, record.manifest, "bg", record.contentHash)).toBe(record.manifest);
    expect(readPluginMessages(directory, record.manifest, record.contentHash)).toEqual({});
    expect(plugins.list(undefined, "bg").find((plugin) => plugin.id === "acme.weather")?.name).toBe("Weather");
  });
});

describe("a plugin command's language", () => {
  it("is its envelope's, English when the envelope names none", async () => {
    const registry = new TurnHookRegistry({ budgetMs: 1_000 });
    registry.registerCommand("acme.x", [{ name: "lang", description: "Says its language." }], "lang", ({ locale, envelope }) => ({
      text: `${String(locale)} ${String(envelope.locale)}`,
    }));
    const envelope: ModEnvelope = { workspaceId: "ws", principalId: "p", taskId: "t", runId: "t", source: "cli", attended: true };
    expect(await registry.runCommand("lang", { envelope: { ...envelope, locale: "bg" }, args: "" })).toEqual({ text: "bg bg" });
    expect(await registry.runCommand("lang", { envelope, args: "" })).toEqual({ text: "en undefined" });
  });
});
