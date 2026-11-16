import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import type { ChatFolder, SandboxHostPort, SandboxPolicy } from "@tavi/contracts";
import { createRuntimeSandbox, type SandboxRuntimeManager } from "@tavi/plugin-sandbox/runtime";
import { srtHelpersDirectory } from "@tavi/plugin-sandbox/srt-cli";
import { afterAll, describe, expect, it } from "vitest";

import { sandboxCallFor, type SandboxToolOptions } from "../../src/features/sandbox/tools.js";

/**
 * Golden configs of the shell's own policies: what `policyFor` builds for each chat shape, as
 * the engine compiles it for macOS and Linux, checked in under
 * `test/golden/sandbox-policy/`. Built over a real folder tree (`policyFor`
 * reads the disk), compiled over that tree alone (nothing outside it exists
 * to the compiler, so `/tmp` is never macOS's `/private/tmp`), its paths
 * stubbed (`<root>`, `<owner-home>`, `<srt-helpers>`), each list sorted: the
 * order of a deny list is not part of its meaning, and readdir's differs
 * between hosts. `TAVI_UPDATE_GOLDEN=1` writes them.
 */

const UPDATE = process.env["TAVI_UPDATE_GOLDEN"] === "1";
const PLATFORMS = ["darwin", "linux"] as const;

const directories = temporaryDirectories();
const root = realpathSync(directories.create("tavi-policy-golden-"));
afterAll(() => directories.cleanup());

const file = (path: string, text = ""): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

/** A person's home with keys, a data directory (in the home, or in the owner's temporary directory), a host project with repositories. */
function world(name: string, layout: { readonly dataInHome?: boolean; readonly dataInTemporary?: boolean } = {}) {
  const base = join(root, name);
  const home = join(base, "home");
  const temporary = join(base, "tmp");
  const staging = join(temporary, "tavi-501");
  const data =
    layout.dataInHome === true ? join(home, ".tavi") : layout.dataInTemporary === true ? join(temporary, "data") : join(base, "data");
  file(join(home, ".ssh", "id_ed25519"));
  file(join(home, ".zshrc"));
  file(join(data, "tavi.sqlite"));
  file(join(data, "credentials", "openai.json"));
  file(join(data, "chats", "default", "other", "notes.md"));
  const managed = join(data, "chats", "default", "t1");
  for (const entry of [".tmp", ".home"]) mkdirSync(join(managed, entry), { recursive: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const project = layout.dataInHome === true ? join(home, "project") : join(base, "work", "project");
  file(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  file(join(project, ".git", "hooks", "pre-commit.sample"));
  file(join(project, "sub", ".git", "HEAD"), "ref: refs/heads/main\n");
  file(join(project, "src", "index.ts"));
  const shared = join(base, "work", "shared");
  file(join(shared, "notes.md"));
  const options: SandboxToolOptions = {
    dataDirectory: data,
    fsRoots: [layout.dataInHome === true ? home : join(base, "work")],
    homeDirectory: home,
    ownerTemporaryDirectories: [temporary],
    ownerStaging: staging,
    ownerEnv: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    othersTemporary: () => [],
  };
  const folder = (primary: string, extra: Partial<ChatFolder> = {}): ChatFolder => ({
    primary,
    primaryKind: primary === managed ? "managed" : "host",
    managed,
    scratch: join(managed, ".tmp"),
    home: join(managed, ".home"),
    attachments: [],
    revision: 1,
    ...extra,
  });
  return { options, managed, project, shared, folder };
}

/** The chat shapes of the plan's corpus, each as `policyFor` builds it. */
const SHAPES: Readonly<Record<string, () => Promise<SandboxPolicy>>> = {
  // A host primary with nested repositories, clean: it writes the host folder and its own.
  "host-primary": async () => {
    const { options, project, folder } = world("host-primary");
    return (await sandboxCallFor(options, folder(project))).policy;
  },
  // Tainted: only its managed folder written, no network.
  tainted: async () => {
    const { options, project, folder } = world("tainted");
    return (await sandboxCallFor(options, folder(project), true)).policy;
  },
  // A read-write attachment: written, with its protected names, as a host folder.
  "rw-attachment": async () => {
    const { options, managed, shared, folder } = world("rw-attachment");
    return (await sandboxCallFor(options, folder(managed, { attachments: [{ path: shared, mode: "rw", label: "shared" }] }))).policy;
  },
  // `--fs-root ~` with the data directory inside: the data directory denied entry by entry.
  "fs-root-home": async () => {
    const { options, project, folder } = world("fs-root-home", { dataInHome: true });
    return (await sandboxCallFor(options, folder(project))).policy;
  },
  // The owner's temporary directory holds the data directory: it is denied by the names the owner stages under.
  "owner-temporary-parent": async () => {
    const { options, managed, folder } = world("owner-temporary-parent", { dataInTemporary: true });
    return (await sandboxCallFor(options, folder(managed))).policy;
  },
};

type CompileFs = NonNullable<NonNullable<Parameters<typeof createRuntimeSandbox>[0]>["fs"]>;

/** The real files under `root`, and nothing else: the same compile on every host. */
const treeFs: CompileFs = (() => {
  const inside = (path: string): boolean => path === root || path.startsWith(`${root}/`);
  const attempt = <T>(read: () => T): T | undefined => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  return {
    kind: (path) =>
      inside(path)
        ? attempt(() => {
            const stat = lstatSync(path);
            return stat.isSymbolicLink()
              ? ("symlink" as const)
              : stat.isDirectory()
                ? ("directory" as const)
                : stat.isFile()
                  ? ("file" as const)
                  : ("other" as const);
          })
        : undefined,
    list: (path) => (inside(path) ? attempt(() => readdirSync(path)) : undefined),
    link: (path) => (inside(path) ? attempt(() => readlinkSync(path)) : undefined),
    read: (path) => (inside(path) ? attempt(() => readFileSync(path, "utf8").slice(0, 4_096)) : undefined),
    real: (path) => (inside(path) ? attempt(() => realpathSync(path)) : undefined),
    foldsCase: () => false,
  };
})();

/** srt's macOS spelling of its shared path, which `policyFor` lists on a macOS host only and the compiler adds for macOS itself. */
const MACOS_SHARED = "/private/tmp/claude";
const hostNeutral = (policy: SandboxPolicy): SandboxPolicy => ({
  ...policy,
  filesystem: { ...policy.filesystem, denyWrite: (policy.filesystem.denyWrite ?? []).filter((path) => path !== MACOS_SHARED) },
});

/** What the engine hands srt for `policy` on `platform`: the per-run config of a wrap. */
async function compiled(policy: SandboxPolicy, platform: (typeof PLATFORMS)[number]): Promise<unknown> {
  let config: unknown;
  const manager: SandboxRuntimeManager = {
    isSupportedPlatform: () => true,
    initialize: async () => {},
    updateConfig: () => {},
    cleanupAfterCommand: () => {},
    wrapWithSandboxArgv: async (_line, _shell, custom) => ((config = custom), { argv: ["/usr/bin/true"], env: {} }),
  };
  const host: SandboxHostPort = {
    current: () => ({ tier: "full", checks: [] }),
    check: async () => ({ tier: "full", checks: [] }),
    facts: async () => ({ platform, inContainer: false, appArmorRestrictsUserNamespaces: false, userNamespacesDisabled: false }),
  };
  // A child that closes at once; cast whole, since another copy of Node's types may describe the package's `spawn`.
  const spawn = (() => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const child = {
      pid: undefined,
      stdout: { on: () => undefined },
      stderr: { on: () => undefined },
      once: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
    };
    queueMicrotask(() => listeners.get("close")?.(0));
    return child;
  }) as never;
  const sandbox = createRuntimeSandbox({ manager, spawn, platform, host, fs: treeFs, bwrapPath: () => undefined });
  await sandbox.run(policy, { command: "true", cwd: policy.filesystem.allowWrite[0] ?? root });
  await sandbox.close?.();
  return config;
}

/** Paths stubbed, then each list sorted by code unit (never the locale's collation): what is checked in. */
function normalized(value: unknown): string {
  let text = JSON.stringify(value);
  // Longest first, whole JSON strings or path prefixes only.
  for (const [path, stub] of [
    [srtHelpersDirectory(), "<srt-helpers>"],
    [root, "<root>"],
    [realpathSync(homedir()), "<owner-home>"],
  ] as const)
    text = text.split(`"${path}`).join(`"${stub}`);
  const key = (entry: unknown): string => (typeof entry === "string" ? entry : JSON.stringify(entry));
  const sort = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sort).sort((left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0));
    if (node !== null && typeof node === "object")
      return Object.fromEntries(Object.entries(node).map(([name, child]) => [name, sort(child)]));
    return node;
  };
  return `${JSON.stringify(sort(JSON.parse(text)), null, 2)}\n`;
}

describe("golden compiles of the shell's policies", () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    for (const platform of PLATFORMS) {
      it(`${name} on ${platform}`, async () => {
        const path = join(import.meta.dirname, "..", "golden", "sandbox-policy", `${name}.${platform}.json`);
        const policy = hostNeutral(await shape());
        const actual = normalized({ policy, compiled: await compiled(policy, platform) });
        if (UPDATE) {
          mkdirSync(join(path, ".."), { recursive: true });
          writeFileSync(path, actual);
        }
        // Written only when asked: a missing golden fails, so one never passes by being made on the spot.
        expect(existsSync(path), `${path} is missing; TAVI_UPDATE_GOLDEN=1 writes it`).toBe(true);
        expect(actual).toBe(readFileSync(path, "utf8"));
      });
    }
  }
});
