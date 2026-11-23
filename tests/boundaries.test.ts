import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  NOT_HEADLESS as NOT_HEADLESS_DIRECTORIES,
  EXTERNAL_PLUGIN_SOURCES,
  NOT_YET_WIRED,
  SECTIONS,
  TEST_SUPPORT,
  TEST_SUPPORT_NAMES,
  WORKSPACE_GLOBS,
  readManifest,
  violations,
  workspaceGlobs,
  workspacePackageDirectories,
  type DependencyManifest,
} from "./support/dependency-rules.js";
import { importedBy } from "./support/imports.js";

/**
 * Package boundary checks.
 *
 * A workspace layout alone does not prevent an architectural cycle; these assert
 * the declared dependency direction, reading the manifests that actually
 * ship rather than the source imports of one build.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function manifest(relativePath: string): {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly exports?: Record<string, unknown>;
} {
  return JSON.parse(readFileSync(join(repositoryRoot, relativePath), "utf8")) as never;
}

/** Every workspace package, read from the tree (`pnpm-workspace.yaml`'s globs). */
const WORKSPACE = workspacePackageDirectories(repositoryRoot);

/** Workspace packages outside the headless closure, from the rules' own list. */
const NOT_HEADLESS = new Set<string>(NOT_HEADLESS_DIRECTORIES);

/** The published packages the headless closure is made of, and those not yet wired, held to the same rules. */
const PUBLISHED = WORKSPACE.filter(
  (directory) => !NOT_HEADLESS.has(directory) && !EXTERNAL_PLUGIN_SOURCES.includes(directory) && !TEST_SUPPORT.includes(directory),
).map((directory) => `${directory}/package.json`);

/** Every manifest whose dependencies a `tavi` install resolves, and the workspace root. */
const CLOSURE = ["package.json", ...PUBLISHED];

const workspaceNames = WORKSPACE.map((directory) => String(readManifest(repositoryRoot, directory).name));

describe("declared dependency direction", () => {
  const contracts = manifest("packages/contracts/package.json");

  it("keeps contracts free of every workspace dependency", () => {
    for (const section of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      const declared = Object.keys(contracts[section] ?? {});
      for (const name of workspaceNames) expect(declared).not.toContain(name);
    }
  });

  it("keeps contracts free of Node, React, Electron and provider dependencies", () => {
    const declared = Object.keys(contracts.dependencies ?? {});
    for (const forbidden of ["@types/node", "react", "electron", "ai", "@langchain/langgraph", "better-sqlite3"]) {
      expect(declared).not.toContain(forbidden);
    }
    // Zod is the single permitted dependency: it is platform-neutral and is the
    // declared source of truth for schemas.
    expect(declared).toEqual(["zod"]);
  });

  it("keeps runtime independent of concrete plugins", () => {
    const runtime = manifest("packages/runtime/package.json");
    expect(Object.keys(runtime.dependencies ?? {})).not.toContain("@tavi/agent-host");
    expect(Object.keys(runtime.dependencies ?? {})).not.toContain("@tavi/cli");
  });

  it("keeps the agent host independent of the runtime implementation and of applications", () => {
    const agentHost = manifest("packages/agent-host/package.json");
    expect(Object.keys(agentHost.dependencies ?? {})).not.toContain("@tavi/runtime");
    expect(Object.keys(agentHost.dependencies ?? {})).not.toContain("@tavi/cli");
    expect(Object.keys(agentHost.dependencies ?? {})).toContain("@tavi/contracts");
  });

  it("keeps the client on contracts alone: no runtime, no React", () => {
    const client = manifest("packages/client/package.json");
    // A browser bundle carries the client, so it may not reach the runtime's
    // SQLite and sockets, nor bring React: its reducers are plain functions.
    expect(Object.keys(client.dependencies ?? {})).toEqual(["@tavi/contracts"]);
    // Installed by default, so an optional dependency is a dependency all the same.
    expect(client.optionalDependencies ?? {}).toEqual({});
    for (const section of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      const declared = Object.keys(client[section] ?? {});
      for (const forbidden of ["@tavi/runtime", "@tavi/agent-host", "@tavi/cli", "react", "react-dom", "ink"]) {
        expect(declared).not.toContain(forbidden);
      }
    }
  });

  it("keeps every internal dependency versionless-workspace resolved", () => {
    for (const path of PUBLISHED) {
      const pkg = manifest(path);
      for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
        if (name.startsWith("@tavi/")) expect(version).toBe("workspace:*");
      }
    }
  });

  it("keeps the headless closure free of desktop and browser dependencies, per package", () => {
    expect(PUBLISHED.length, "the workspace was read").toBeGreaterThanOrEqual(9);
    for (const path of CLOSURE) {
      const pkg = manifest(path) as DependencyManifest;
      expect(violations(String(pkg.name), pkg), path).toEqual([]);
    }
  });

  it("keeps the web canvas out of every install: private, built from devDependencies, depended on by nothing", () => {
    expect([...NOT_HEADLESS]).toEqual(["apps/ui"]);
    const ui = manifest("apps/ui/package.json") as ReturnType<typeof manifest> & { readonly private?: boolean };
    expect(ui.private).toBe(true);
    // Bundled, so nothing is a dependency an install would resolve — an
    // optional one is installed all the same.
    expect(ui.dependencies ?? {}).toEqual({});
    expect(ui.peerDependencies ?? {}).toEqual({});
    expect(ui.optionalDependencies ?? {}).toEqual({});
    for (const path of CLOSURE) {
      const pkg = manifest(path);
      for (const section of SECTIONS) {
        expect(Object.keys(pkg[section] ?? {}), `${path} ${section}`).not.toContain("@tavi/ui");
      }
    }
    // The CLI ships its build, as files beside `dist/`.
    expect((manifest("apps/cli/package.json") as { readonly files?: readonly string[] }).files).toEqual(["dist", "ui-dist"]);
  });

  it("keeps a package not yet wired out of every install: private and depended on by nothing", () => {
    expect([...NOT_YET_WIRED]).toEqual([]);
    for (const directory of NOT_YET_WIRED) {
      expect(WORKSPACE, directory).toContain(directory);
      const name = String(readManifest(repositoryRoot, directory).name);
      expect((manifest(`${directory}/package.json`) as { readonly private?: boolean }).private, directory).toBe(true);
      // A dependency on it is the wiring, which takes it off the list.
      for (const path of ["package.json", ...WORKSPACE.map((candidate) => `${candidate}/package.json`)]) {
        const pkg = manifest(path);
        for (const section of SECTIONS) expect(Object.keys(pkg[section] ?? {}), `${path} ${section}`).not.toContain(name);
      }
    }
  });

  it("ships the native router with only contracts, and zod for its own settings' schema, as runtime dependencies", () => {
    expect(WORKSPACE).toContain("packages/builtin/router");
    expect(Object.keys(manifest("packages/builtin/router/package.json").dependencies ?? {})).toEqual(["@tavi/contracts", "zod"]);
    expect(manifest("apps/cli/package.json").dependencies).toHaveProperty("@tavi/plugin-router", "workspace:*");
  });

  it("keeps plug-in packages on no workspace package but contracts, the node kit and their own kits (a channel's, the channel kit)", () => {
    // The channel kit is what every channel connector shares,
    // and itself depends on nothing but contracts, so a channel on it is still on contracts alone.
    expect(
      Object.keys(manifest("packages/channel-kit/package.json").dependencies ?? {}).filter((name) => name.startsWith("@tavi/")),
    ).toEqual(["@tavi/contracts"]);
    // The plugin kit is the same for heartbeat, ideas, memory and onboarding providers (docs/*-PLUGINS.md):
    // one subpath per kind, each on contracts alone and never on another kind's.
    expect(
      Object.keys(manifest("packages/plugin-kit/package.json").dependencies ?? {}).filter((name) => name.startsWith("@tavi/")),
    ).toEqual(["@tavi/contracts"]);
    // Each kind's files, however deep they nest, stay on contracts and their own kind: `plugin-boundaries.test.ts`.
    // The child kit is the engines' one watchdog and kill ladder: it needs nothing of Tavi's at all.
    expect(Object.keys(manifest("packages/child-kit/package.json").dependencies ?? {}).filter((name) => name.startsWith("@tavi/"))).toEqual(
      [],
    );
    const channels = ["packages/builtin/telegram", "packages/builtin/mailgun", "packages/builtin/gmail"];
    // The built-in default providers, one module each, each written with its own kind's part of the plugin kit:
    // the heartbeat prompt, the ideas catalogue, the memory capture prompt, the onboarding flow helpers.
    const defaults: Readonly<Record<string, string>> = {
      heartbeat: "@tavi/plugin-kit/heartbeat",
      ideas: "@tavi/plugin-kit/ideas",
      memory: "@tavi/plugin-kit/memory",
      onboarding: "@tavi/plugin-kit/onboarding",
    };
    const kitsOf = (path: string): string[] => {
      if (channels.some((channel) => path.startsWith(channel))) return ["@tavi/channel-kit"];
      if (path.startsWith("packages/builtin/defaults/")) return ["@tavi/plugin-kit"];
      // The engines that confine a child bound it with the child kit, and the worker and sandbox end theirs with it.
      if (["pdf", "video", "worker", "sandbox"].some((name) => path.startsWith(`packages/builtin/${name}/`))) return ["@tavi/child-kit"];
      return [];
    };
    // The plugin types inline the contracts' types, so they depend on no workspace package at all.
    expect(Object.keys(manifest("packages/plugin-types/package.json").dependencies ?? {})).toEqual([]);
    for (const path of PUBLISHED.filter((candidate) => candidate.startsWith("packages/builtin/"))) {
      // The node kit is a leaf of Node helpers, open to any of them.
      const internal = Object.keys(manifest(path).dependencies ?? {}).filter(
        (name) => name.startsWith("@tavi/") && name !== "@tavi/node-kit",
      );
      expect(internal, path).toEqual([...kitsOf(path), "@tavi/contracts"].sort());
    }
    // Sharing a package, each default provider still imports its own kind's subpath alone.
    for (const [provider, kit] of Object.entries(defaults)) {
      const file = `packages/builtin/defaults/src/${provider}.ts`;
      const imported = importedBy(readFileSync(join(repositoryRoot, file), "utf8")).filter(
        (specifier) => specifier.startsWith("@tavi/") && !specifier.startsWith("@tavi/contracts"),
      );
      expect([...new Set(imported)], file).toEqual([kit]);
    }
  });

  it("keeps the node kit a leaf: no dependency but koffi, and its sources import Node's built-ins and one another alone", () => {
    const nodeKit = manifest("packages/node-kit/package.json");
    // One exception: koffi, for the Win32 calls `win32.ts` makes, loaded there on Windows only.
    expect(Object.keys(nodeKit.dependencies ?? {})).toEqual(["koffi"]);
    for (const section of ["peerDependencies", "optionalDependencies"] as const) expect(nodeKit[section] ?? {}, section).toEqual({});
    const files = (readdirSync(join(repositoryRoot, "packages/node-kit/src"), { recursive: true }) as string[]).filter((name) =>
      /\.(ts|mts)$/.test(name),
    );
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const imported = importedBy(readFileSync(join(repositoryRoot, "packages/node-kit/src", file), "utf8"));
      expect(
        imported.filter(
          (specifier) => !specifier.startsWith("node:") && !specifier.startsWith("./") && !(file === "win32.ts" && specifier === "koffi"),
        ),
        file,
      ).toEqual([]);
    }
  });

  it("keeps an external plugin's sources on contracts, the domain kit and its own kit (a channel's, the channel kit), and nothing else of Tavi's", () => {
    // jobs.finder (docs/JOBS.md) bundles the domain kit and the jobs kit into its one module.
    for (const directory of EXTERNAL_PLUGIN_SOURCES) expect(WORKSPACE, directory).toContain(directory);
    const internal = (directory: string): string[] =>
      Object.keys(manifest(`${directory}/package.json`).dependencies ?? {})
        .filter((name) => name.startsWith("@tavi/"))
        .sort();
    expect(internal("packages/domain-kit")).toEqual(["@tavi/contracts"]);
    expect(internal("packages/jobs-kit")).toEqual(["@tavi/contracts", "@tavi/domain-kit"]);
    expect(internal("packages/external/jobs")).toEqual(["@tavi/domain-kit", "@tavi/jobs-kit", "@tavi/plugin-types"]);
    // trends.radar (docs/TRENDS.md) is built the same way.
    expect(internal("packages/trends-kit")).toEqual(["@tavi/contracts", "@tavi/domain-kit"]);
    expect(internal("packages/external/trends")).toEqual(["@tavi/domain-kit", "@tavi/plugin-types", "@tavi/trends-kit"]);
    // discord.channel bundles the channel kit, a published package that is
    // every channel's kit, and takes contracts' types only: the host's own TaviError is handed to it.
    expect(internal("packages/external/discord")).toEqual(["@tavi/channel-kit", "@tavi/plugin-types"]);
    // places.open and places.care (docs/PLACES.md) bundle the domain kit and the places kit, as jobs and trends do.
    expect(internal("packages/places-kit")).toEqual(["@tavi/contracts", "@tavi/domain-kit"]);
    for (const plugin of ["packages/external/places-open", "packages/external/places-care"])
      expect(internal(plugin), plugin).toEqual(["@tavi/domain-kit", "@tavi/places-kit", "@tavi/plugin-types"]);
    // Nothing a `tavi` install is made of reaches them.
    for (const path of PUBLISHED)
      expect(
        Object.keys(manifest(path).dependencies ?? {}).filter((name) =>
          [
            "@tavi/domain-kit",
            "@tavi/jobs-kit",
            "@tavi/plugin-jobs",
            "@tavi/trends-kit",
            "@tavi/plugin-trends",
            "@tavi/plugin-discord",
            "@tavi/places-kit",
            "@tavi/plugin-places-open",
            "@tavi/plugin-places-care",
          ].includes(name),
        ),
        path,
      ).toEqual([]);
  });

  it("keeps the PDF modules replaceable: engine, OCR add-on and tools meet only at contracts, put together in one place", () => {
    const sources = (directory: string): string[] =>
      (readdirSync(join(repositoryRoot, directory), { recursive: true }) as string[])
        .filter((name) => /\.(ts|tsx|mts)$/.test(name))
        .map((name) => join(directory, name));
    const internal = (file: string): string[] =>
      importedBy(readFileSync(join(repositoryRoot, file), "utf8")).filter((specifier) => specifier.startsWith("@tavi/"));
    expect(sources("packages/builtin/pdf/src").length).toBeGreaterThan(5);
    // The owner's PDF wiring does import both: the check below is not vacuous.
    expect(internal("apps/cli/src/features/pdf/host.ts")).toEqual(expect.arrayContaining(["@tavi/plugin-pdf/host", "@tavi/pdf-ocr"]));
    // The engine implements `PdfEnginePort` on contracts and the child kit alone: it never imports the OCR add-on or the sandbox.
    for (const file of sources("packages/builtin/pdf/src"))
      expect(
        internal(file).filter(
          (specifier) =>
            specifier !== "@tavi/contracts" &&
            specifier !== "@tavi/contracts/util" &&
            specifier !== "@tavi/node-kit" &&
            specifier !== "@tavi/child-kit",
        ),
        file,
      ).toEqual([]);
    for (const file of sources("packages/child-kit/src")) expect(internal(file), file).toEqual([]);
    // The OCR add-on is files: it imports no workspace package, and none but the owner's composition finds it.
    for (const file of sources("packages/pdf-ocr/src")) expect(internal(file), file).toEqual([]);
    // In the owner, only `features/pdf/host.ts` names the engine or the add-on; the tools see the port.
    const pdfPackages = (specifier: string): boolean => specifier.startsWith("@tavi/plugin-pdf") || specifier.startsWith("@tavi/pdf-ocr");
    for (const file of sources("apps/cli/src")) {
      if (file.endsWith(`${sep}features${sep}pdf${sep}host.ts`)) continue;
      expect(internal(file).filter(pdfPackages), file).toEqual([]);
    }
    expect(
      internal("apps/cli/src/features/pdf/tools.ts").filter(
        (specifier) => specifier !== "@tavi/contracts/util" && specifier !== "@tavi/node-kit",
      ),
    ).toEqual(["@tavi/contracts"]);
  });

  it("keeps the video modules replaceable: the decoder and analysers meet the tools only at contracts", () => {
    const sources = (directory: string): string[] =>
      (readdirSync(join(repositoryRoot, directory), { recursive: true }) as string[])
        .filter((name) => /\.(ts|tsx|mts)$/.test(name))
        .map((name) => join(directory, name));
    const internal = (file: string): string[] =>
      importedBy(readFileSync(join(repositoryRoot, file), "utf8")).filter((specifier) => specifier.startsWith("@tavi/"));
    expect(sources("packages/builtin/video/src").length).toBeGreaterThan(3);
    // The built-in decoder implements its port on contracts and the child kit alone: never the sandbox, never the PDF engine.
    // So are the add-ons: the pose and transcription packages import contracts and the child kit alone.
    for (const directory of ["packages/builtin/video/src", "packages/video-pose/src", "packages/video-transcribe/src"]) {
      expect(sources(directory).length, directory).toBeGreaterThan(1);
      // The decoder may use the node kit too; the add-ons are bundled without it.
      const nodeKit = directory === "packages/builtin/video/src";
      for (const file of sources(directory))
        expect(
          internal(file).filter(
            (specifier) =>
              specifier !== "@tavi/contracts" &&
              specifier !== "@tavi/contracts/util" &&
              !(nodeKit && specifier === "@tavi/node-kit") &&
              specifier !== "@tavi/child-kit",
          ),
          file,
        ).toEqual([]);
    }
    // The owner's video wiring does import it: the check below is not vacuous.
    expect(internal("apps/cli/src/features/video/host.ts")).toEqual(expect.arrayContaining(["@tavi/plugin-video"]));
    // In the owner, only `features/video/host.ts` names an implementation; the tools see the ports.
    for (const file of sources("apps/cli/src")) {
      if (file.endsWith(`${sep}features${sep}video${sep}host.ts`)) continue;
      expect(
        internal(file).filter((specifier) => specifier.startsWith("@tavi/plugin-video") || specifier.startsWith("@tavi/video-")),
        file,
      ).toEqual([]);
    }
    // The tools see contracts alone (its catalogue subpaths included), never an implementation.
    const toolImports = internal("apps/cli/src/features/video/tools.ts");
    expect(toolImports).toContain("@tavi/contracts");
    expect(toolImports.filter((specifier) => specifier !== "@tavi/contracts" && !specifier.startsWith("@tavi/contracts/"))).toEqual([]);
  });

  it("keeps the sandbox modules replaceable: one owner module names them, everything else sees the ports", () => {
    const sources = (directory: string): string[] =>
      (readdirSync(join(repositoryRoot, directory), { recursive: true }) as string[])
        .filter((name) => /\.(ts|tsx|mts)$/.test(name))
        .map((name) => join(directory, name));
    const internal = (file: string): string[] =>
      importedBy(readFileSync(join(repositoryRoot, file), "utf8")).filter((specifier) => specifier.startsWith("@tavi/"));
    const sandboxPackages = (specifier: string): boolean =>
      specifier.startsWith("@tavi/plugin-sandbox") ||
      specifier.startsWith("@tavi/plugin-limits") ||
      specifier.startsWith("@tavi/plugin-worker");
    // The owner's sandbox wiring does import them: the check below is not vacuous.
    expect(internal("apps/cli/src/features/sandbox/host.ts")).toEqual(
      expect.arrayContaining([
        "@tavi/plugin-sandbox/runtime",
        "@tavi/plugin-sandbox/srt-cli",
        "@tavi/plugin-limits",
        "@tavi/plugin-worker",
      ]),
    );
    for (const file of sources("apps/cli/src")) {
      if (file.endsWith(`${sep}features${sep}sandbox${sep}host.ts`)) continue;
      expect(internal(file).filter(sandboxPackages), file).toEqual([]);
    }
    // Packages that confine children take a port in their options; they never import a sandbox implementation.
    for (const directory of ["packages/builtin/pdf/src", "packages/builtin/video/src", "packages/builtin/browser/src"]) {
      for (const file of sources(directory)) expect(internal(file).filter(sandboxPackages), file).toEqual([]);
    }
    // The sandbox, limits and worker packages implement the ports on contracts alone; the sandbox and the
    // worker's host (not the confined worker itself) may use the node kit too, a leaf on Node's built-ins,
    // as their launches build children's environments, and the child kit, which ends the children they start.
    const nodeKitHost = (file: string): boolean =>
      /^packages\/builtin\/(sandbox\/|worker\/src\/index\.ts$)/.test(file.split(sep).join("/"));
    for (const file of [
      ...sources("packages/builtin/sandbox/src"),
      ...sources("packages/builtin/limits/src"),
      ...sources("packages/builtin/worker/src"),
    ])
      expect(
        internal(file).filter(
          (specifier) =>
            specifier !== "@tavi/contracts" &&
            specifier !== "@tavi/contracts/util" &&
            !(nodeKitHost(file) && (specifier === "@tavi/node-kit" || specifier === "@tavi/child-kit")),
        ),
        file,
      ).toEqual([]);
  });

  it("keeps Playwright an optional peer that no install resolves", () => {
    const browser = manifest("packages/builtin/browser/package.json") as ReturnType<typeof manifest> & {
      readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
    };
    expect(browser.peerDependenciesMeta?.["playwright"]?.optional).toBe(true);
    expect(Object.keys(browser.dependencies ?? {})).not.toContain("playwright");
  });

  it("reads every workspace glob pnpm does, so no package is outside the gates", () => {
    expect(workspaceGlobs(repositoryRoot)).toEqual([...WORKSPACE_GLOBS]);
  });

  it("pins Ink exactly: the chat's live-region bound depends on 7.1.1's rule for clearing the terminal", () => {
    // Moving the pin is a decision, not an update: re-check that `tavi chat`'s live region stays under the
    // viewport against Ink's `shouldClearTerminalForFrame` first, then change this line with it.
    const cli = manifest("apps/cli/package.json") as { readonly dependencies?: Record<string, string> };
    expect(cli.dependencies?.["ink"]).toBe("7.1.1");
  });

  it("pins the AI SDK exactly, with one copy of each of its packages in the lockfile", () => {
    // `ai`, its provider and the provider's specification move together: a
    // second `@ai-sdk/provider` would give the adapter two model interfaces,
    // and a range would let one drift from the others on an install. Every
    // workspace package that names one pins it exactly; `@tavi/agent-host` names
    // the four the adapter uses: `ai`, the provider specification, and the
    // OpenAI-compatible and Anthropic Messages providers.
    const isSdk = (name: string): boolean => name === "ai" || name.startsWith("@ai-sdk/");
    for (const directory of WORKSPACE) {
      const declared = manifest(`${directory}/package.json`);
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
        for (const [name, version] of Object.entries(declared[field] ?? {})) {
          if (isSdk(name)) expect(version, `${directory} pins ${name} exactly in ${field}`).toMatch(/^\d+\.\d+\.\d+$/);
        }
      }
    }
    const agentHost = manifest("packages/agent-host/package.json") as { readonly dependencies?: Record<string, string> };
    expect(
      Object.keys(agentHost.dependencies ?? {})
        .filter(isSdk)
        .sort(),
    ).toEqual(["@ai-sdk/anthropic", "@ai-sdk/openai", "@ai-sdk/provider", "ai"]);
    // One version of each SDK package the lockfile resolves, `provider-utils` included.
    const lockfile = readFileSync(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
    const versions = new Map<string, Set<string>>();
    for (const match of lockfile.matchAll(/^ {2}'?((?:@ai-sdk\/[a-z-]+)|ai)@([^':(]+)/gm)) {
      const [, name, version] = match as unknown as [string, string, string];
      versions.set(name, (versions.get(name) ?? new Set()).add(version));
    }
    expect([...versions.keys()].sort()).toEqual(
      expect.arrayContaining(["@ai-sdk/openai", "@ai-sdk/provider", "@ai-sdk/provider-utils", "ai"]),
    );
    for (const [name, found] of versions) expect([...found], `${name} resolves to one version`).toHaveLength(1);
    expect([...(versions.get("@ai-sdk/provider") ?? [])]).toEqual([agentHost.dependencies?.["@ai-sdk/provider"]]);
  });

  it("declares the Node the CLI needs, the workspace's own", () => {
    const root = manifest("package.json") as { readonly engines?: Record<string, string> };
    const cli = manifest("apps/cli/package.json") as { readonly engines?: Record<string, string> };
    expect(cli.engines?.["node"]).toBeDefined();
    expect(cli.engines?.["node"]).toBe(root.engines?.["node"]);
  });
});

describe("declared export surface", () => {
  it("gives the agent host explicit entry points with no catch-all barrel", () => {
    const agentHost = manifest("packages/agent-host/package.json");
    const keys = Object.keys(agentHost.exports ?? {});
    expect(keys).toContain("./models");
    expect(keys).toContain("./workflow");
    // A bare "." would let a consumer import everything at once.
    expect(keys).not.toContain(".");
  });

  it("keeps the shared fakes out of the shipped packages' entry points", () => {
    // They are `@tavi/test-support`'s, or a package's own `test/support`'s.
    const entries = (path: string): string[] => {
      const pkg = manifest(path) as ReturnType<typeof manifest> & {
        readonly publishConfig?: { readonly exports?: Record<string, unknown> };
      };
      return [...Object.keys(pkg.exports ?? {}), ...Object.keys(pkg.publishConfig?.exports ?? {})];
    };
    for (const key of ["./testing", "./messaging-testing"]) expect(entries("packages/agent-host/package.json")).not.toContain(key);
    for (const path of ["packages/builtin/sandbox/package.json", "packages/builtin/browser/package.json"])
      expect(entries(path), path).not.toContain("./fixture");
  });

  it("declares a dist target that matches the emitted file extension", () => {
    for (const path of PUBLISHED) {
      const pkg = manifest(path) as {
        readonly publishConfig?: { readonly exports?: Record<string, { import?: string }> };
      };
      for (const [key, entry] of Object.entries(pkg.publishConfig?.exports ?? {})) {
        if (key === "./package.json") {
          // Node's recommended escape hatch: tools read a package's manifest, and
          // the published map must not hide it. The packaging gate caught this
          // missing from the CLI's `publishConfig`.
          expect(entry).toBe("./package.json");
          continue;
        }
        expect((entry as { readonly import?: string }).import).toMatch(/\.mjs$/);
      }
    }
  });

  it("keeps the agent host's three entry-point lists in step", () => {
    // An entry point is declared in three places — `exports` (source condition),
    // `publishConfig.exports` (published map) and `tsdown.config.ts`'s `entry`
    // map — and a mismatch surfaces only at the import site or at pack time.
    // That is exactly how a new entry could ship half-declared, so the three
    // lists are compared here instead.
    const agentHost = manifest("packages/agent-host/package.json") as {
      readonly exports?: Record<string, { readonly development?: string }>;
      readonly publishConfig?: { readonly exports?: Record<string, unknown> };
    };
    const tsdown = readFileSync(join(repositoryRoot, "packages/agent-host/tsdown.config.ts"), "utf8");
    const entries = [...tsdown.matchAll(/"src\/([A-Za-z0-9_/-]+)\.ts"/g)].map((match) => match[1]);
    const developmentSources = Object.values(agentHost.exports ?? {})
      .map((entry) => entry.development)
      .filter((source): source is string => source !== undefined)
      .map((source) => source.replace(/^\.\/src\//, "").replace(/\.ts$/, ""));
    expect([...developmentSources].sort()).toEqual([...entries].sort());
    // `publishConfig` deliberately omits the test-only entries, so the published
    // map is a subset — but every published key must exist in `exports`.
    for (const key of Object.keys(agentHost.publishConfig?.exports ?? {})) {
      if (key === "./package.json") continue;
      expect(Object.keys(agentHost.exports ?? {})).toContain(key);
    }
  });
});

describe("test support", () => {
  /** Every source or script file below `directory`, relative to the repository; none when it does not exist. */
  const sources = (directory: string): string[] =>
    existsSync(join(repositoryRoot, directory))
      ? (readdirSync(join(repositoryRoot, directory), { recursive: true, encoding: "utf8" }) as string[])
          .filter((name) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name))
          .map((name) => `${directory}/${name.split(sep).join("/")}`)
      : [];
  const importsTestSupport = (file: string): boolean => {
    const text = readFileSync(join(repositoryRoot, file), "utf8");
    // The plain search backs up the import parser: a `require` or a `createRequire` call names it too.
    return (
      importedBy(text).some((specifier) => TEST_SUPPORT_NAMES.some((name) => specifier === name || specifier.startsWith(`${name}/`))) ||
      TEST_SUPPORT_NAMES.some((name) => text.includes(name))
    );
  };

  it("is private and unpacked, and a devDependency wherever it is declared", () => {
    expect(TEST_SUPPORT.every((directory) => WORKSPACE.includes(directory))).toBe(true);
    for (const directory of TEST_SUPPORT) {
      const pkg = manifest(`${directory}/package.json`) as ReturnType<typeof manifest> & {
        readonly private?: boolean;
        readonly publishConfig?: unknown;
      };
      expect(pkg.private, directory).toBe(true);
      expect(pkg.publishConfig, directory).toBeUndefined();
    }
    // Every manifest, the canvas, the external plugins' sources and test support's own among them; an npm alias is seen through.
    for (const path of ["package.json", ...WORKSPACE.map((directory) => `${directory}/package.json`)]) {
      const pkg = manifest(path) as DependencyManifest;
      expect(
        violations(String(pkg.name), pkg).filter((found) => TEST_SUPPORT_NAMES.some((name) => found.startsWith(`${name} `))),
        path,
      ).toEqual([]);
    }
    // The rule, on manifests that break it.
    expect(violations("@tavi/runtime", { dependencies: { "@tavi/test-support": "workspace:*" } })).toEqual([
      "@tavi/test-support in dependencies",
    ]);
    expect(violations("@tavi/ui", { optionalDependencies: { support: "npm:@tavi/test-support@0.1.0" } })).toEqual([
      "@tavi/test-support in optionalDependencies",
    ]);
  });

  it("is imported by test code alone", () => {
    const shipped = WORKSPACE.filter((directory) => !TEST_SUPPORT.includes(directory)).flatMap((directory) => [
      ...sources(`${directory}/src`),
      ...sources(`${directory}/bin`),
    ]);
    expect(shipped.length).toBeGreaterThan(100);
    for (const file of shipped) expect(importsTestSupport(file), file).toBe(false);
    // The check is not vacuous: tests do import it.
    expect(sources("packages/agent-host/test").some(importsTestSupport)).toBe(true);
  });

  it("depends on no workspace package but contracts, so every package's tests may use it", () => {
    // A workspace dependency here that depends back on it (as a devDependency) is a cycle turbo refuses.
    for (const directory of TEST_SUPPORT) {
      const pkg = manifest(`${directory}/package.json`);
      const internal = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ].filter((name) => name.startsWith("@tavi/"));
      expect(internal, directory).toEqual(["@tavi/contracts"]);
      for (const file of sources(`${directory}/src`)) {
        expect(
          // A contracts subpath (`@tavi/contracts/util`) is the same package: no cycle either.
          importedBy(readFileSync(join(repositoryRoot, file), "utf8")).filter(
            (specifier) => specifier.startsWith("@tavi/") && specifier !== "@tavi/contracts" && !specifier.startsWith("@tavi/contracts/"),
          ),
          file,
        ).toEqual([]);
      }
    }
  });
});

describe("the client's host-neutral entries", () => {
  const source = join(repositoryRoot, "packages/client/src");
  /**
   * Every source file but the Node entry's: the root, and the browser entry
   * with its own modules. Neither may import `node:*`.
   */
  const checked = readdirSync(source, { recursive: true, encoding: "utf8" })
    .map((file) => file.split(sep).join("/"))
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => hostOf(file) !== "node");

  it("imports only contracts and neutral modules from the root, and the browser entry adds only its own", () => {
    expect(checked).toContain("index.ts");
    for (const file of checked) {
      const text = readFileSync(join(source, file), "utf8");
      for (const specifier of importedBy(text)) expect(importAllowed(file, specifier), `${file} imports ${specifier}`).toBe(true);
    }
  });

  it("holds the browser entry to the same rule", () => {
    expect(checked).toEqual(expect.arrayContaining(["browser.ts", "browser/websocket.ts"]));
    // The rule, on imports the browser entry could make.
    expect(importAllowed("browser.ts", "node:net")).toBe(false);
    expect(importAllowed("browser/websocket.ts", "../node/socket.js")).toBe(false);
    expect(importAllowed("browser/websocket.ts", "./frames.js")).toBe(true);
    expect(importAllowed("browser.ts", "./browser/websocket.js")).toBe(true);
    expect(importAllowed("browser.ts", "./transport.js")).toBe(true);
    expect(importAllowed("browser.ts", "@tavi/contracts")).toBe(true);
    expect(importAllowed("browser.ts", "@tavi/contracts/util")).toBe(true);
    // The root reaches no host entry, and nothing leaves the package's source.
    expect(importAllowed("transport.ts", "./browser.js")).toBe(false);
    expect(importAllowed("transport.ts", "./node.js")).toBe(false);
    expect(importAllowed("transport.ts", "../../runtime/src/index.js")).toBe(false);
  });
});

/**
 * Whether a module of the client's source (`file`, relative to `src`) may
 * import `specifier`: an allowlist, not a denylist, so every Node builtin, the
 * runtime, React and the other host entries are refused without having to be
 * named. `@tavi/contracts`, or a module of this source tree the importer's
 * host may reach: a root module no host entry (they are its consumers), a
 * browser module its own entry's modules too, never Node's.
 */
function importAllowed(file: string, specifier: string): boolean {
  if (specifier === "@tavi/contracts" || specifier === "@tavi/contracts/util") return true;
  if (!specifier.startsWith(".")) return false;
  const target = posix.normalize(posix.join(posix.dirname(file), specifier)).replace(/\.js$/, ".ts");
  if (target.startsWith("..")) return false;
  const host = hostOf(target);
  return host === undefined || (host === "browser" && hostOf(file) === "browser");
}

/** The client host entry a source path belongs to (`node` or `browser`), if any. */
function hostOf(path: string): "node" | "browser" | undefined {
  const match = /^(node|browser)(\.(js|ts))?$|^(node|browser)\//.exec(path);
  return (match?.[1] ?? match?.[4]) as "node" | "browser" | undefined;
}

describe("provider consumer boundaries", () => {
  const sources = WORKSPACE.flatMap((directory) => {
    const source = join(repositoryRoot, directory, "src");
    return readdirSync(source, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => `${directory}/src/${file.split(sep).join("/")}`);
  });
  it("keeps raw provider registries inside application composition and the host", () => {
    const owners = new Set([
      "apps/cli/src/runtime/models.ts",
      "packages/runtime/src/plugin-host/provider-factories.ts",
      "packages/runtime/src/plugin-host/provider-bindings.ts",
    ]);
    for (const file of sources) {
      const source = readFileSync(join(repositoryRoot, file), "utf8");
      if (/new\s+(?:ProviderFactoryRegistry|ProviderBindings)\b/.test(source)) expect(owners.has(file), file).toBe(true);
    }
  });
  it("keeps background model consumers behind ModelPort", () => {
    // Explicit operator capability probes remain a separate configuration path.
    const owners = new Set(["apps/cli/src/runtime/models.ts", "apps/cli/src/features/models/actions.ts"]);
    for (const file of sources) {
      const source = readFileSync(join(repositoryRoot, file), "utf8");
      if (/\bcreateAiSdkModelAdapter\s*\(/.test(source) && file !== "packages/agent-host/src/models/models.ts")
        expect(owners.has(file), file).toBe(true);
    }
  });
});
