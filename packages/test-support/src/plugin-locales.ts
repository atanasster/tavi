import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { overlayPluginManifest, PluginManifestSchema, pluginLocaleProblems, type PluginManifest } from "@tavi/contracts";

/** A plugin package's Bulgarian language pack, read as its own tests check it. */
export interface BulgarianPack {
  readonly manifest: PluginManifest;
  /** The manifest as a person reads it in Bulgarian: the pack laid over it. */
  readonly shown: PluginManifest;
  /**
   * What is wrong with the pack, none when it is right: the manifest names it at
   * schemaVersion 3, it translates only fields a person reads, each within its
   * field's length, and it leaves what the model reads (the tools) as it is
   * while the description a person reads is in Bulgarian.
   */
  readonly problems: readonly string[];
}

/** The Bulgarian pack (`locales/bg.json`) of the plugin package at `root`, beside its `tavi-plugin.json`. */
export function bulgarianPackOf(root: string): BulgarianPack {
  const manifest = PluginManifestSchema.parse(JSON.parse(readFileSync(join(root, "tavi-plugin.json"), "utf8")));
  const pack = JSON.parse(readFileSync(join(root, "locales", "bg.json"), "utf8")) as { readonly manifest: Record<string, string> };
  const shown = overlayPluginManifest(manifest, pack.manifest);
  const problems = [
    ...(manifest.schemaVersion === 3 ? [] : [`the manifest is at schemaVersion ${String(manifest.schemaVersion)}, not 3`]),
    ...(isDeepStrictEqual(manifest.locales, { bg: "locales/bg.json" })
      ? []
      : ["the manifest does not name locales/bg.json as its bg pack"]),
    ...pluginLocaleProblems(manifest, "bg", pack),
    ...(isDeepStrictEqual(shown.tools, manifest.tools) ? [] : ["the pack changes the tools, which the model reads in English"]),
    ...(shown.description === manifest.description ? ["the pack leaves the description in English"] : []),
  ];
  return { manifest, shown, problems };
}
