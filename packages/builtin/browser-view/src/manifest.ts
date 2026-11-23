import { BUILTIN_BROWSER_VIEW_PLUGIN, PluginUiSchema, type PluginUi } from "@tavi/contracts";
import { SUPPORTED_LOCALES, type Locale } from "@tavi/contracts/i18n";

import manifest from "../tavi-plugin.json" with { type: "json" };

/**
 * The built-in browser view's manifest: UI
 * only, under the reserved `tavi.` id, described by the same `ui` schema as
 * any external plugin's — parsed here, so a mistake in it fails the build's
 * tests rather than the canvas. Its files are in the canvas build
 * (`plugins/tavi.browserview/`), hashed by the owner when it starts.
 */
export const BROWSER_VIEW_MANIFEST: {
  readonly schemaVersion: 3;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly ui: PluginUi;
  /** Its language packs (schemaVersion 3), shipped beside its page as `locales/<lang>.json`: where the owner reads a built-in's. */
  readonly locales: { readonly [L in Locale]?: string };
} = {
  schemaVersion: 3,
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  ui: PluginUiSchema.parse(manifest.ui),
  locales: manifest.locales,
};

if (manifest.schemaVersion !== 3) throw new Error("the built-in browser view's manifest is schemaVersion 3: it carries language packs");
for (const [locale, path] of Object.entries(BROWSER_VIEW_MANIFEST.locales)) {
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(locale) || path !== `locales/${locale}.json`)
    throw new Error(`the built-in browser view's ${locale} pack is locales/${locale}.json, not ${String(path)}`);
}

if (BROWSER_VIEW_MANIFEST.id !== BUILTIN_BROWSER_VIEW_PLUGIN)
  throw new Error(`the built-in browser view is ${BUILTIN_BROWSER_VIEW_PLUGIN}, not ${BROWSER_VIEW_MANIFEST.id}`);
