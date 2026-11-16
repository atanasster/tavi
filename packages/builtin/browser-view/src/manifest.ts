import { BUILTIN_BROWSER_VIEW_PLUGIN, PluginUiSchema, type PluginUi } from "@tavi/contracts";

import manifest from "../tavi-plugin.json" with { type: "json" };

/**
 * The built-in browser view's manifest: UI
 * only, under the reserved `tavi.` id, described by the same `ui` schema as
 * any external plugin's — parsed here, so a mistake in it fails the build's
 * tests rather than the canvas. Its files are in the canvas build
 * (`plugins/tavi.browserview/`), hashed by the owner when it starts.
 */
export const BROWSER_VIEW_MANIFEST: { readonly id: string; readonly name: string; readonly description: string; readonly ui: PluginUi } = {
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  ui: PluginUiSchema.parse(manifest.ui),
};

if (BROWSER_VIEW_MANIFEST.id !== BUILTIN_BROWSER_VIEW_PLUGIN)
  throw new Error(`the built-in browser view is ${BUILTIN_BROWSER_VIEW_PLUGIN}, not ${BROWSER_VIEW_MANIFEST.id}`);
