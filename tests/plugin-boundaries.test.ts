import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { importedBy } from "./support/imports.js";
import {
  PLUGIN_KITS,
  compositionViolations,
  entryPointViolations,
  exportedSources,
  tsdownEntries,
  type CompositionOwner,
  escapingPaths,
  escapingScripts,
  escapingSpecifiers,
  DEPENDENCY_FIELDS,
  importViolations,
  kindImportViolations,
  manifestViolations,
  packageOf,
  pluginPackageDirectories,
  readPackage,
  sourceFiles,
  valueImportsOf,
} from "./support/plugin-boundaries.js";

/**
 * Plugin boundaries: every plugin package, kit and add-on stays replaceable on its own. Each gate is checked
 * against the tree, and against a planted violation it must catch.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS = pluginPackageDirectories(root);
const PLUGIN_NAMES = new Set(PLUGINS.map((directory) => readPackage(root, directory).name));

describe("a plugin's manifest", () => {
  it("names no plugin package in any dependency field, the plugin kit and the plugin types aside", () => {
    expect(PLUGINS.length).toBeGreaterThan(20);
    for (const directory of [...PLUGINS, ...PLUGIN_KITS])
      expect(manifestViolations(readPackage(root, directory), PLUGIN_NAMES), directory).toEqual([]);
  });

  it("is caught naming one, in a dev or peer field too", () => {
    const planted = {
      name: "@tavi/plugin-acme",
      // A kit is no plugin: naming it is fine.
      dependencies: { "@tavi/plugin-kit": "workspace:*", "@tavi/channel-kit": "workspace:*" },
      devDependencies: { "@tavi/plugin-pdf": "workspace:*" },
      peerDependencies: { "@tavi/plugin-browser": "workspace:*" },
    };
    expect(manifestViolations(planted, PLUGIN_NAMES)).toEqual([
      "devDependencies: @tavi/plugin-pdf",
      "peerDependencies: @tavi/plugin-browser",
    ]);
  });
});

describe("a plugin's sources", () => {
  it("import no other plugin package, nor the host or an application, and the test support only in their tests", () => {
    let scanned = 0;
    for (const directory of [...PLUGINS, ...PLUGIN_KITS]) {
      const own = readPackage(root, directory).name;
      for (const file of sourceFiles(root, directory)) {
        scanned += 1;
        const imports = importedBy(readFileSync(join(root, directory, file.path), "utf8"));
        expect(importViolations(imports, own, file.area, PLUGIN_NAMES), `${directory}/${file.path}`).toEqual([]);
      }
    }
    expect(scanned).toBeGreaterThan(400);
  });

  it("are caught importing another plugin in any of the forms the scan reads, source text and all", () => {
    const planted = [
      'import { a } from "@tavi/plugin-pdf/host";',
      'export * from "@tavi/plugin-browser";',
      'import type { B } from "@tavi/runtime";',
      'const c = require("@tavi/plugin-video");',
      'const d = createRequire(import.meta.url).resolve("@tavi/plugin-sandbox/host");',
      'const e = await import("@tavi/plugin-worker", { with: {} });',
      "const f = await import(`@tavi/agent-host/workflow`);",
      'import "@tavi/contracts";',
    ].join("\n");
    expect(importViolations(importedBy(planted), "@tavi/plugin-acme", "src", PLUGIN_NAMES)).toEqual([
      "@tavi/plugin-pdf/host",
      "@tavi/plugin-browser",
      "@tavi/runtime",
      "@tavi/plugin-video",
      "@tavi/plugin-sandbox/host",
      "@tavi/plugin-worker",
      "@tavi/agent-host/workflow",
    ]);
  });

  it("are caught importing another plugin, the runtime, or the test support from src", () => {
    const imports = [
      "@tavi/contracts",
      "@tavi/plugin-pdf/host",
      "@tavi/runtime",
      "@tavi/plugin-kit/memory",
      "@tavi/test-support",
      "./own.js",
    ];
    expect(importViolations(imports, "@tavi/plugin-acme", "src", PLUGIN_NAMES)).toEqual([
      "@tavi/plugin-pdf/host",
      "@tavi/runtime",
      "@tavi/test-support",
    ]);
    expect(importViolations(imports, "@tavi/plugin-acme", "test", PLUGIN_NAMES)).toEqual(["@tavi/plugin-pdf/host", "@tavi/runtime"]);
  });

  it("catch a nested plugin-kit file reaching into another kind, or a kind into another of Tavi's packages", () => {
    expect(
      kindImportViolations("src/memory/conformance/deep.ts", ["../../ideas/catalogue.js", "../recall.js", "./../../memory/capture.js"]),
    ).toEqual(["../../ideas/catalogue.js"]);
    expect(kindImportViolations("src/heartbeat/index.ts", ["../conformance/shared.js", "@tavi/runtime", "./../ideas/x.js"])).toEqual([
      "@tavi/runtime",
      "./../ideas/x.js",
    ]);
    // The shared conformance stays in itself.
    expect(kindImportViolations("src/conformance/shared.ts", ["../memory/index.js", "./util.js"])).toEqual(["../memory/index.js"]);
  });

  it("keep each kind of the plugin kit on contracts and its own files, however deep they nest", () => {
    // Every kind the kit has, read from its directories: a new one is covered as it is added.
    const kinds = readdirSync(join(root, "packages/plugin-kit/src"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(kinds).toEqual(expect.arrayContaining(["heartbeat", "ideas", "memory", "onboarding"]));
    for (const kind of kinds) {
      const files = sourceFiles(root, "packages/plugin-kit").filter((file) => file.path.startsWith(`src/${kind}/`));
      expect(files.length, kind).toBeGreaterThan(0);
      for (const file of files) {
        const out = kindImportViolations(file.path, importedBy(readFileSync(join(root, "packages/plugin-kit", file.path), "utf8")));
        expect(out, file.path).toEqual([]);
      }
    }
  });
});

describe("a plugin's files", () => {
  // The configs that build and test a package (vitest.config.ts, tsconfig*.json, tsdown.config.ts) sit at its root,
  // outside src/, test/ and scripts/, and may name the workspace's shared settings.
  it("stay inside their package: no relative import, path from their own directory or script climbs out", () => {
    // The test support too: it serves every package's tests, and reaches into none.
    for (const directory of [...PLUGINS, ...PLUGIN_KITS, "packages/test-support"]) {
      expect(escapingScripts(readPackage(root, directory)), `${directory}/package.json`).toEqual([]);
      for (const file of sourceFiles(root, directory)) {
        const text = readFileSync(join(root, directory, file.path), "utf8");
        expect(escapingSpecifiers(file.path, importedBy(text)), `${directory}/${file.path}`).toEqual([]);
        expect(escapingPaths(file.path, text), `${directory}/${file.path}`).toEqual([]);
      }
    }
  });

  it("are caught climbing out by an import, a path or a script", () => {
    expect(escapingSpecifiers("src/a/b.ts", ["../c.js", "../../index.js", "../../../other/src/x.js", "./d.js"])).toEqual([
      "../../../other/src/x.js",
    ]);
    expect(
      escapingPaths(
        "src/host.ts",
        [
          'join(import.meta.dirname, "..", "dist", "child.mjs");',
          'join(import.meta.dirname, "..", "..", "pdf", "dist");',
          'join(here, "../..", "pdf");',
          'resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");',
          'new URL("../assets/a.json", import.meta.url); new URL("../../../x.json", import.meta.url);',
          'join(directory, "..", "..");',
        ].join("\n"),
      ),
    ).toEqual([
      'join(import.meta.dirname, "..", "..", "pdf", "dist"',
      'join(here, "../..", "pdf"',
      'resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."',
      'new URL("../../../x.json", import.meta.url)',
    ]);
    expect(
      escapingScripts({
        name: "@tavi/plugin-acme",
        scripts: { build: "tsdown", notices: "node ../../scripts/notices.mjs", win: "node ..\\x.mjs", up: "cd .. && pnpm build" },
      }),
    ).toEqual(["notices", "win", "up"]);
  });
});

/** The owner of each plugin package in `apps/cli/src`. */
const COMPOSITION: readonly CompositionOwner[] = [
  { packages: ["@tavi/plugin-pdf", "@tavi/pdf-ocr"], owners: { "features/pdf/host.ts": "any" } },
  { packages: ["@tavi/plugin-video", "@tavi/video-pose", "@tavi/video-transcribe"], owners: { "features/video/host.ts": "any" } },
  { packages: ["@tavi/plugin-sandbox", "@tavi/plugin-limits", "@tavi/plugin-worker"], owners: { "features/sandbox/host.ts": "any" } },
  { packages: ["@tavi/plugin-browser"], owners: { "features/browser/host.ts": "any" } },
  { packages: ["@tavi/plugin-desktop"], owners: { "features/desktop/host.ts": "any" } },
  { packages: ["@tavi/plugin-flights"], owners: { "features/flights/host.ts": "any" } },
  { packages: ["@tavi/plugin-collectors"], owners: { "features/collectors/host.ts": "any" } },
  { packages: ["@tavi/plugin-site-skills"], owners: { "features/browser/site-skills-host.ts": "any" } },
  { packages: ["@tavi/plugin-local"], owners: { "runtime/channels.ts": "any" } },
  // The channels and the browser view are what the catalog ships; composition takes them from its BUILTIN_CHANNELS.
  {
    packages: ["@tavi/plugin-telegram", "@tavi/plugin-mailgun", "@tavi/plugin-gmail", "@tavi/plugin-browser-view"],
    owners: { "features/plugins/catalog.ts": "any" },
  },
  // The default providers and the router are started by the built-in plugins; the catalog names the router and
  // hands the offline setup the built-in flow.
  {
    packages: ["@tavi/plugin-defaults"],
    owners: { "runtime/builtin-plugins.ts": "any", "features/plugins/catalog.ts": ["./onboarding"] },
  },
  { packages: ["@tavi/plugin-router"], owners: { "runtime/builtin-plugins.ts": "any", "features/plugins/catalog.ts": ["."] } },
  { packages: ["@tavi/plugin-guard"], owners: { "runtime/builtin-plugins.ts": ["."], "features/plugins/catalog.ts": ["./manifest"] } },
  { packages: ["@tavi/plugin-types"], owners: { "features/plugins/external.ts": ["."] } },
];

/** Every source file's imports under `directory`, by its path there. */
function importsUnder(directory: string): ReadonlyMap<string, readonly string[]> {
  const base = join(root, directory);
  return new Map(
    (readdirSync(base, { recursive: true }) as string[])
      .filter((name) => /\.(?:[cm]?[jt]s|tsx)$/.test(name) && !name.split(/[\\/]/).includes("node_modules"))
      .map((name) => [name.split("\\").join("/"), importedBy(readFileSync(join(base, name), "utf8"))] as const),
  );
}

const WITH_KITS = new Set([...PLUGIN_NAMES, "@tavi/plugin-types"]);

describe("composition", () => {
  it("imports each plugin package in apps/cli only from its owner module", () => {
    const cli = importsUnder("apps/cli/src");
    expect(cli.size).toBeGreaterThan(300);
    expect(compositionViolations(cli, COMPOSITION, WITH_KITS)).toEqual([]);
    // The plugin types are types: the owner takes nothing from them at run time.
    expect(valueImportsOf(readFileSync(join(root, "apps/cli/src/features/plugins/external.ts"), "utf8"), "@tavi/plugin-types")).toEqual([]);
  });

  it("is caught importing a plugin package outside its owner, or a subpath its owner may not take", () => {
    const planted = new Map([
      ["features/pdf/host.ts", ["@tavi/plugin-pdf/host"]],
      ["runtime/tools.ts", ["@tavi/plugin-pdf/host"]],
      ["features/plugins/catalog.ts", ["@tavi/plugin-guard", "@tavi/plugin-guard/manifest"]],
      ["features/acme.ts", ["@tavi/plugin-unknown"]],
    ]);
    expect(compositionViolations(planted, COMPOSITION, new Set([...WITH_KITS, "@tavi/plugin-unknown"]))).toEqual([
      "runtime/tools.ts: @tavi/plugin-pdf/host",
      "features/plugins/catalog.ts: @tavi/plugin-guard",
      "features/acme.ts: @tavi/plugin-unknown",
    ]);
  });

  it("is caught taking the plugin types at run time", () => {
    const planted = [
      'import type { A } from "@tavi/plugin-types";',
      'export type { B } from "@tavi/plugin-types";',
      'import { C } from "@tavi/plugin-types";',
      'export { D } from "@tavi/plugin-types";',
      'import * as E from "@tavi/plugin-types";',
    ].join("\n");
    expect(valueImportsOf(planted, "@tavi/plugin-types")).toEqual([
      'import { C } from "@tavi/plugin-types"',
      'export { D } from "@tavi/plugin-types"',
      'import * as E from "@tavi/plugin-types"',
    ]);
  });

  it("is caught letting a plugin package into the runtime or the canvas, where no entry owns one", () => {
    const planted = new Map([["routines/news.ts", ["@tavi/contracts", "@tavi/plugin-pdf/host"]]]);
    expect(compositionViolations(planted, [], WITH_KITS)).toEqual(["routines/news.ts: @tavi/plugin-pdf/host"]);
  });

  it("keeps every plugin package out of the runtime, the agent host, contracts, the client and the canvas", () => {
    for (const directory of [
      "packages/runtime/src",
      "packages/agent-host/src",
      "packages/contracts/src",
      "packages/client/src",
      "apps/ui/src",
    ])
      expect(compositionViolations(importsUnder(directory), [], WITH_KITS), directory).toEqual([]);
  });

  it("keeps the plugin kits out of the CLI's and the agent host's sources: dev dependencies, for tests", () => {
    for (const directory of ["apps/cli/src", "packages/agent-host/src"]) expect(kitImports(importsUnder(directory)), directory).toEqual([]);
    for (const directory of ["apps/cli", "packages/agent-host"]) expect(kitDependencies(directory), directory).toEqual([]);
  });

  it("is caught letting a kit into the CLI's sources, or declaring one as a run-time dependency", () => {
    expect(kitImports(new Map([["features/memory/x.ts", ["@tavi/plugin-kit/memory", "@tavi/contracts"]]]))).toEqual([
      "features/memory/x.ts: @tavi/plugin-kit/memory",
    ]);
    expect(
      kitFields({
        name: "@tavi/cli",
        dependencies: { "@tavi/channel-kit": "workspace:*" },
        devDependencies: { "@tavi/plugin-kit": "workspace:*" },
      }),
    ).toEqual(["dependencies: @tavi/channel-kit"]);
  });
});

const KITS = ["@tavi/plugin-kit", "@tavi/channel-kit"];

/** The imports of a kit in `imports`, by file. */
const kitImports = (imports: ReadonlyMap<string, readonly string[]>): readonly string[] =>
  [...imports].flatMap(([file, specifiers]) =>
    specifiers.filter((specifier) => KITS.includes(packageOf(specifier))).map((specifier) => `${file}: ${specifier}`),
  );

/** A kit named in any field but `devDependencies`: the kits are for tests here. */
const kitFields = (manifest: ReturnType<typeof readPackage>): readonly string[] =>
  DEPENDENCY_FIELDS.filter((field) => field !== "devDependencies").flatMap((field) =>
    Object.keys(manifest[field] ?? {})
      .filter((name) => KITS.includes(name))
      .map((name) => `${field}: ${name}`),
  );

const kitDependencies = (directory: string): readonly string[] => kitFields(readPackage(root, directory));

/** The files a package builds that are spawned, loaded or served by path, never imported: no export names them. */
const SPAWN_ONLY: Readonly<Record<string, readonly string[]>> = {
  // The live view's script, which the canvas serves as the plugin's UI.
  "packages/builtin/browser-view": ["src/live.ts"],
  // The host process srt runs, and the policy compiler `scripts/sandbox-footprint.mjs` loads by path.
  "packages/builtin/sandbox": ["src/host-process.ts", "src/policy-compile.ts"],
  "packages/builtin/pdf": ["src/child.ts", "src/ocr-child.ts"],
  "packages/builtin/worker": ["src/worker.ts"],
  "packages/video-pose": ["src/child.ts"],
  "packages/video-transcribe": ["src/child.ts"],
};

describe("a plugin's entry points", () => {
  it("are what it exports, and the files it spawns or serves by path", () => {
    let checked = 0;
    for (const directory of [...PLUGINS, ...PLUGIN_KITS]) {
      const config = join(root, directory, "tsdown.config.ts");
      const manifest = readPackage(root, directory);
      // An external plugin builds one bundle for `tavi plugins install`, exporting nothing.
      if (!existsSync(config) || manifest.exports === undefined) continue;
      checked += 1;
      expect(
        entryPointViolations(tsdownEntries(readFileSync(config, "utf8")), exportedSources(manifest), SPAWN_ONLY[directory]),
        directory,
      ).toEqual([]);
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("are caught building what nothing exports, or exporting what nothing builds", () => {
    const manifest = {
      name: "@tavi/plugin-acme",
      exports: {
        ".": { development: "./src/index.ts", import: "./dist/index.mjs" },
        "./tools": { development: "./src/tools.ts", import: "./dist/tools.mjs" },
        "./conformance": { development: "./src/conformance.ts" },
      },
    };
    const config = 'defineConfig([{ entry: ["src/index.ts", "src/stray.ts"] }, { entry: { child: "src/child.ts" } }])';
    expect(entryPointViolations(tsdownEntries(config), exportedSources(manifest), ["src/child.ts", "src/gone.ts"])).toEqual([
      "built, not exported: src/stray.ts",
      "exported, not built: src/tools.ts",
      "spawned, not built: src/gone.ts",
    ]);
    // An export with no source to build it from is said, not skipped.
    expect(
      exportedSources({
        name: "@tavi/plugin-acme",
        exports: { "./x": "./dist/x.mjs", "./tool": "./scripts/tool.mjs", "./package.json": "./package.json" },
      }),
    ).toEqual(["unbuildable: ./x"]);
    expect(tsdownEntries('entry: ["./src/a.ts", "src/view.tsx"]')).toEqual(["src/a.ts", "src/view.tsx"]);
  });
});
