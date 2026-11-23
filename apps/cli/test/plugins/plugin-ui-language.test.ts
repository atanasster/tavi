import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILTIN_BROWSER_VIEW_PLUGIN,
  PluginUiAnswerSchema,
  PluginUiEntrySchema,
  type PluginUiEntry,
  type PluginView,
} from "@tavi/contracts";
import { BROWSER_VIEW_MANIFEST } from "@tavi/plugin-browser-view/manifest";
import { hashPluginDirectory } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { builtinUiViewIn, localizedUiEntries } from "../../src/features/plugins/localized.js";

/**
 * What a UI plugin's frames are told of the language: each canvas entry
 * carries the workspace's language and the plugin's own words in it, read
 * only from files under the hash the entry is served by — an installed
 * version's snapshot, or a built-in's files in the canvas build.
 */

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

const ui: PluginUiEntry["ui"] = {
  abi: "tavi.ui/1",
  contributions: [{ id: "panel", title: "Forecast", document: "panel.html", channels: [], placements: [{ slot: "chat.panel.tab" }] }],
};

/** An installed version's snapshot with English and Bulgarian packs, and its entry. */
function installed(): { readonly directory: string; readonly entry: PluginUiEntry } {
  const directory = directories.create("tavi-ui-language-");
  writeFileSync(
    join(directory, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 3,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.weather",
      version: "1.0.0",
      name: "Weather",
      ui,
      locales: { en: "locales/en.json", bg: "locales/bg.json" },
    }),
  );
  writeFileSync(join(directory, "panel.html"), "<!doctype html><p>weather</p>");
  mkdirSync(join(directory, "locales"));
  writeFileSync(join(directory, "locales", "en.json"), JSON.stringify({ messages: { sunny: "Sunny", rain: "Rain" } }));
  writeFileSync(
    join(directory, "locales", "bg.json"),
    JSON.stringify({ manifest: { "ui.contributions.panel.title": "Прогноза" }, messages: { sunny: "Слънчево" } }),
  );
  const entry: PluginUiEntry = {
    pluginId: "acme.weather",
    kind: "external",
    version: "1.0.0",
    contentHash: hashPluginDirectory(directory).hash,
    ui,
  };
  return { directory, entry };
}

/** A canvas build carrying the built-in browser view as `pnpm run build` ships it. */
function canvasWithBrowserView(): { readonly canvas: string; readonly entry: PluginUiEntry } {
  const canvas = directories.create("tavi-ui-language-canvas-");
  const built = join(dirname(fileURLToPath(import.meta.resolve("@tavi/plugin-browser-view/package.json"))), "dist", "ui");
  const target = join(canvas, "plugins", BUILTIN_BROWSER_VIEW_PLUGIN);
  cpSync(built, target, { recursive: true });
  return {
    canvas,
    entry: {
      pluginId: BUILTIN_BROWSER_VIEW_PLUGIN,
      kind: "builtin",
      contentHash: hashPluginDirectory(target).hash,
      ui: BROWSER_VIEW_MANIFEST.ui,
    },
  };
}

describe("a UI plugin's words for its frames", () => {
  it("gives an installed version's frames its Bulgarian words, each one it lacks in its English", () => {
    const { directory, entry } = installed();
    const [served] = localizedUiEntries([entry], "bg", { snapshotDirectory: () => directory, canvasDirectory: undefined });
    expect(served?.locale).toBe("bg");
    expect(served?.messages).toEqual({ sunny: "Слънчево", rain: "Rain" });
    expect(PluginUiEntrySchema.safeParse(served).success).toBe(true);
  });

  it("keeps a language's words first and fills from English only up to the bound, so the answer stays readable", () => {
    const { directory } = installed();
    const keys = (prefix: string, text: string, length = 1000) =>
      Object.fromEntries(Array.from({ length }, (_, index) => [`${prefix}${String(index)}`, text]));
    writeFileSync(join(directory, "locales", "en.json"), JSON.stringify({ messages: keys("en", "English") }));
    writeFileSync(
      join(directory, "locales", "bg.json"),
      JSON.stringify({ messages: { ...keys("bg", "Български", 999), en0: "Преведено" } }),
    );
    const entry: PluginUiEntry = {
      pluginId: "acme.weather",
      kind: "external",
      version: "1.0.0",
      contentHash: hashPluginDirectory(directory).hash,
      ui,
    };
    const [served] = localizedUiEntries([entry], "bg", { snapshotDirectory: () => directory, canvasDirectory: undefined });
    expect(PluginUiEntrySchema.safeParse(served).success).toBe(true);
    expect(PluginUiAnswerSchema.safeParse({ entries: [served] }).success).toBe(true);
    const messages = served?.messages ?? {};
    expect(Object.keys(messages)).toHaveLength(1000);
    // Two full packs, a thousand keys each: the language's thousand, and no English beyond them.
    expect(messages["bg998"]).toBe("Български");
    expect(messages["en0"]).toBe("Преведено");
    expect(messages).not.toHaveProperty("en1");
  });

  it("gives nothing from a pack changed on disk after approval, and leaves English and no language as they were", () => {
    const { directory, entry } = installed();
    writeFileSync(join(directory, "locales", "bg.json"), JSON.stringify({ messages: { sunny: "Подменено" } }));
    const [served] = localizedUiEntries([entry], "bg", { snapshotDirectory: () => directory, canvasDirectory: undefined });
    expect(served).toEqual({ ...entry, locale: "bg" });
    for (const locale of [undefined, "en"] as const)
      expect(localizedUiEntries([entry], locale, { snapshotDirectory: () => directory, canvasDirectory: undefined })).toEqual([entry]);
  });

  it("reads the built-in browser view's Bulgarian pack from the canvas build: its title, disclosure and words", () => {
    const { canvas, entry } = canvasWithBrowserView();
    const [served] = localizedUiEntries([entry], "bg", { snapshotDirectory: () => "", canvasDirectory: canvas });
    expect(served?.ui.contributions[0]?.title).toBe("Браузър");
    expect(served?.ui.contributions[0]?.disclosure).toMatch(/^Получава изображения на живо/);
    expect(served?.messages).toMatchObject({ "chip.live": "На живо", "chip.operator": "Ти управляваш", "chip.requested": "Чака теб" });
    expect(PluginUiEntrySchema.safeParse(served).success).toBe(true);
    // Its files under another hash (rebuilt since the owner started): English, no words.
    const [stale] = localizedUiEntries([{ ...entry, contentHash: "0".repeat(64) }], "bg", {
      snapshotDirectory: () => "",
      canvasDirectory: canvas,
    });
    expect(stale?.ui).toEqual(BROWSER_VIEW_MANIFEST.ui);
    expect(stale).not.toHaveProperty("messages");
  });

  it("lists the built-in browser view in Settings → Plugins in its Bulgarian pack's words", () => {
    const { canvas, entry } = canvasWithBrowserView();
    const view = {
      id: BUILTIN_BROWSER_VIEW_PLUGIN,
      kind: "builtin",
      description: BROWSER_VIEW_MANIFEST.description,
      ui: BROWSER_VIEW_MANIFEST.ui,
      uiContentHash: entry.contentHash,
    } as unknown as PluginView;
    const shown = builtinUiViewIn(view, "bg", canvas);
    expect(shown.description).toMatch(/^Браузърът на агента на живо/);
    expect(shown.ui?.contributions[0]?.disclosure).toMatch(/^Получава изображения на живо/);
    // Another hash than the build's, or English: as listed.
    const stale = { ...view, uiContentHash: "0".repeat(64) } as PluginView;
    expect(builtinUiViewIn(stale, "bg", canvas)).toEqual(stale);
    expect(builtinUiViewIn(view, "en", canvas)).toEqual(view);
  });
});
