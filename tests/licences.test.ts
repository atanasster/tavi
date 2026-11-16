import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TAVI_REPOSITORY_URL } from "../packages/contracts/src/url-text.js";
import {
  ADD_ONS,
  EXTERNAL_PLUGIN_SOURCES,
  NOT_YET_WIRED,
  headlessPackageDirectories,
  installedClosure,
  licenceAllowed,
  requiredFrameworkPeers,
  workspacePackageDirectories,
} from "./support/dependency-rules.js";

/**
 * The licence and framework-peer gates over what a `tavi` install holds,
 * read from the workspace's own
 * install at every depth. The release gate repeats both over the packed
 * artifacts installed outside the repository.
 */
const repositoryRoot = join(import.meta.dirname, "..");

/** Every file under `directory`, at any depth. */
function* walkFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path);
    else yield path;
  }
}
// The external plugins' bundles carry their dependencies, so their licences are held to the same rules, as are
// the packages a later change wires in.
const closure = installedClosure(repositoryRoot, [
  ...headlessPackageDirectories(repositoryRoot),
  ...EXTERNAL_PLUGIN_SOURCES,
  ...NOT_YET_WIRED,
]);
const thirdParty = closure.filter((entry) => !(entry.manifest.name ?? "").startsWith("@tavi/"));

describe("the headless graph's licences and peers", () => {
  it("walks third-party packages at every depth, the PDF libraries bundled into the parser child among them", () => {
    const names = thirdParty.map((entry) => entry.manifest.name);
    for (const name of ["@embedpdf/pdfium", "@cantoo/pdf-lib", "@cantoo/fontkit", "html-entities"]) expect(names).toContain(name);
  });

  it("licenses the repository and every workspace package under MIT", () => {
    expect(readFileSync(join(repositoryRoot, "LICENSE"), "utf8")).toMatch(/^MIT License\n/);
    const manifests = [
      repositoryRoot,
      ...workspacePackageDirectories(repositoryRoot).map((directory) => join(repositoryRoot, directory)),
    ].map((directory) => JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name: string; license?: unknown });
    expect(manifests.filter((manifest) => manifest.license !== "MIT").map((manifest) => manifest.name)).toEqual([]);
  });

  it("points every workspace manifest at the repository, its own directory in it, and keeps it private", () => {
    // Copied by hand into each manifest, so a new package, a moved directory or a renamed repository drifts here.
    for (const directory of ["", ...workspacePackageDirectories(repositoryRoot)]) {
      const manifest = JSON.parse(readFileSync(join(repositoryRoot, directory, "package.json"), "utf8")) as Record<string, unknown>;
      const expected: Record<string, unknown> = {
        private: true,
        author: "atanasster",
        repository: {
          type: "git",
          url: `git+${TAVI_REPOSITORY_URL}.git`,
          ...(directory === "" ? {} : { directory }),
        },
        homepage: `${TAVI_REPOSITORY_URL}#readme`,
        bugs: { url: `${TAVI_REPOSITORY_URL}/issues` },
      };
      const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, manifest[key]]));
      expect(actual, `${directory || "."}/package.json`).toEqual(expected);
    }
  });

  it("lists every package the web canvas imports as bundled, and only those", () => {
    const sources = [...walkFiles(join(repositoryRoot, "apps", "ui", "src"))].filter((file) => /\.(tsx?|css)$/.test(file));
    const imported = new Set<string>();
    for (const file of sources) {
      // Import and export statements, dynamic imports and CSS @imports: the module specifiers a bundle resolves.
      const statements =
        /^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"'.][^"']*)["']|^\s*import\s+["']([^"'.][^"']*)["']|\bimport\(\s*["']([^"'.][^"']*)["']\s*\)|^\s*@import\s+["']([^"'.][^"']*)["']/gm;
      for (const match of readFileSync(file, "utf8").matchAll(statements)) {
        const specifier = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
        const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? "");
        if (!name.startsWith("@tavi/") && !name.startsWith("node:")) imported.add(name);
      }
    }
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, "apps", "ui", "package.json"), "utf8")) as { taviBundled: string[] };
    expect([...imported].sort()).toEqual([...manifest.taviBundled].sort());
  });

  it("holds the web canvas bundle to the same licences", () => {
    // apps/ui's packages are bundled into the canvas the CLI serves (its `taviBundled`), not installed.
    const canvas = installedClosure(repositoryRoot, ["apps/ui"]).filter((entry) => !(entry.manifest.name ?? "").startsWith("@tavi/"));
    expect(canvas.map((entry) => entry.manifest.name)).toEqual(
      expect.arrayContaining(["katex", "react-dom", "@fontsource-variable/inter"]),
    );
    const refused = canvas
      .filter((entry) => !licenceAllowed(entry.manifest.name ?? "", entry.manifest.license))
      .map((entry) => `${entry.manifest.name}@${entry.manifest.version}: ${JSON.stringify(entry.manifest.license)}`);
    expect(refused).toEqual([]);
  });

  it("ships only permissive licences", () => {
    const refused = thirdParty
      .filter((entry) => !licenceAllowed(entry.manifest.name ?? "", entry.manifest.license))
      .map((entry) => `${entry.manifest.name}@${entry.manifest.version}: ${JSON.stringify(entry.manifest.license)}`);
    expect(refused).toEqual([]);
  });

  it("requires no UI framework as a peer anywhere", () => {
    const requiring = closure
      .filter((entry) => requiredFrameworkPeers(entry.manifest).length > 0)
      .map((entry) => `${entry.manifest.name}: ${requiredFrameworkPeers(entry.manifest).join(", ")}`);
    expect(requiring).toEqual([]);
  });
});

/**
 * What an add-on ships besides npm packages — weights, binaries — listed in
 * its `dist/assets.json`: each one's
 * licence permissive, each one's file in `dist/`. An add-on that ships none
 * (the pose add-on: the person brings their own model) lists none.
 */
describe("the add-ons' bundled assets", () => {
  const assetLists = ADD_ONS.map((name) => join(repositoryRoot, "packages", name.replace("@tavi/", ""), "dist", "assets.json")).filter(
    (path) => existsSync(path),
  );

  it("lists each asset with a permissive licence and a sha256 its file has, beside the list", () => {
    for (const path of assetLists) {
      const { assets } = JSON.parse(readFileSync(path, "utf8")) as {
        readonly assets: readonly { readonly file: string; readonly sha256: string; readonly source: string; readonly licence: string }[];
      };
      for (const asset of assets) {
        expect(licenceAllowed(asset.file, asset.licence), `${path}: ${asset.file} (${asset.licence})`).toBe(true);
        expect(asset.sha256, asset.file).toMatch(/^[0-9a-f]{64}$/);
        const file = join(path, "..", asset.file);
        expect(existsSync(file), asset.file).toBe(true);
        // The bytes are the ones listed, not merely a file of that name.
        expect(createHash("sha256").update(readFileSync(file)).digest("hex"), asset.file).toBe(asset.sha256);
      }
    }
  });

  it("has an asset list in every built video add-on: a build that dropped it is caught, not skipped", () => {
    for (const addOn of ["video-pose", "video-transcribe"]) {
      const dist = join(repositoryRoot, "packages", addOn, "dist");
      if (existsSync(dist)) expect(existsSync(join(dist, "assets.json")), `${addOn}/dist/assets.json`).toBe(true);
    }
  });

  it("ships no pose weights, and no whisper.cpp binary or model", () => {
    for (const addOn of ["video-pose", "video-transcribe"]) {
      const list = join(repositoryRoot, "packages", addOn, "dist", "assets.json");
      if (existsSync(list)) expect(JSON.parse(readFileSync(list, "utf8")), addOn).toEqual({ assets: [] });
    }
  });
});
