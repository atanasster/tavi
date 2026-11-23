import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PluginManifestSchema, overlayPluginManifest, pluginLocaleProblems } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

/** Its Bulgarian language pack: the words a person reads in Bulgarian, what the model reads in English as reviewed. */

const root = join(import.meta.dirname, "..");
const manifest = PluginManifestSchema.parse(JSON.parse(readFileSync(join(root, "tavi-plugin.json"), "utf8")));
const pack = JSON.parse(readFileSync(join(root, "locales", "bg.json"), "utf8")) as { readonly manifest: Record<string, string> };

describe("the Bulgarian language pack", () => {
  it("is named by the manifest, which carries packs at schemaVersion 3", () => {
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.locales).toEqual({ bg: "locales/bg.json" });
  });

  it("translates only fields a person reads, each within its field's length", () => {
    expect(pluginLocaleProblems(manifest, "bg", pack)).toEqual([]);
  });

  it("lays Bulgarian over the manifest for a person's screens, leaving what the model reads as it is", () => {
    const shown = overlayPluginManifest(manifest, pack.manifest);
    expect(shown.apps?.apps[0]?.name).toBe("Места: здраве");
    expect(shown.tools).toEqual(manifest.tools);
    expect(shown.description).not.toBe(manifest.description);
  });
});
