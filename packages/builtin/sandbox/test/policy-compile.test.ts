import type { SandboxPolicy } from "@tavi/contracts";
import { TaviError } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import {
  MOUNT_BUDGET,
  anyCase,
  compile,
  credentialsOf,
  hooksPathsOf,
  runtimeSharedWritePaths,
  type CompileFs,
} from "../src/policy-compile.js";
import { fakeFs, type Node } from "./fake-fs.js";

/**
 * The policy compiler: golden configs over a fake
 * filesystem, so Linux's literal expansion is checked on any host.
 */

const NAMES = [".git/hooks", ".git/config", ".bashrc", ".vscode", ".envrc", ".claude/settings.json"];

/** A policy writing `/w` (a nonexistent path canonicalizes to itself), with its protected names. */
function writing(roots: readonly string[], extra: Partial<SandboxPolicy["filesystem"]> = {}): SandboxPolicy {
  return {
    filesystem: {
      allowRead: [...roots],
      allowWrite: [...roots],
      denyRead: ["/nonexistent-home"],
      protectedNames: roots.map((root) => ({ root, names: NAMES, rootNames: ["HEAD"] })),
      ...extra,
    },
    network: { allow: false },
    resources: { timeoutMs: 1_000, maxOutputBytes: 1_024 },
  };
}

/** A config entry's path: Linux marks every write deny literal. */
const pathOf = (entry: string | { readonly path: string }): string => (typeof entry === "string" ? entry : entry.path);

const writeDenies = (policy: SandboxPolicy, fs: CompileFs): readonly string[] => {
  const denies = compile(policy, {}, "linux", fs, { home: "/nonexistent-home" }).config.filesystem.denyWrite;
  // Never a pattern on Linux, whatever the name holds.
  expect(denies.every((entry) => typeof entry !== "string" && entry.literal)).toBe(true);
  return denies.map(pathOf);
};

describe("a run's local capabilities", () => {
  const local = (extra: NonNullable<SandboxPolicy["local"]>): SandboxPolicy => ({ ...writing(["/nonexistent-w"]), local: extra });
  const options = { home: "/nonexistent-home" };

  it("gives a macOS run sockets in its own scratch, and a pty or localhost only when the policy says so", () => {
    const plain = compile(local({ unixSocketsIn: ["/nonexistent-w/.tmp"] }), {}, "darwin", fakeFs({}), options).config;
    expect(plain.network.allowUnixSockets).toEqual(["/nonexistent-w/.tmp"]);
    expect(plain.network.allowLocalBinding).toBeUndefined();
    expect(plain.allowPty).toBeUndefined();
    const opted = compile(local({ unixSocketsIn: [], pty: true, localBinding: true }), {}, "darwin", fakeFs({}), options).config;
    expect(opted.allowPty).toBe(true);
    expect(opted.network.allowLocalBinding).toBe(true);
    expect(opted.network.allowUnixSockets).toBeUndefined();
  });

  it("says nothing of them on Linux, where the run's namespace and seccomp filter decide", () => {
    const { config } = compile(
      local({ unixSocketsIn: ["/nonexistent-w/.tmp"], pty: true, localBinding: true }),
      {},
      "linux",
      fakeFs({}),
      options,
    );
    expect(config.allowPty).toBeUndefined();
    expect(config.network.allowUnixSockets).toBeUndefined();
    expect(config.network.allowLocalBinding).toBeUndefined();
  });

  it("never gives a run a container engine's socket, whatever the policy asks", () => {
    const writable = (socket: string): SandboxPolicy => ({
      ...writing(["/nonexistent-w", "/var", "/run", "/Users"]),
      local: { unixSocketsIn: [socket] },
    });
    for (const socket of [
      "/var/run/docker.sock",
      "/var/run",
      "/run/podman/podman.sock",
      "/Users/me/.colima/default",
      "/Users/me/.docker/run",
      "/Users/me/x/Docker.raw.sock",
      "/Users/me/x/podman-machine-default-api.sock",
      "/run/containerd",
    ])
      expect(() => compile(writable(socket), {}, "darwin", fakeFs({}), options), socket).toThrow(/never given the Unix sockets/);
    // A word inside a name is not an engine's.
    expect(() => compile(writable("/nonexistent-w/climate-data"), {}, "darwin", fakeFs({}), options)).not.toThrow();
    // Only in a folder the run may write.
    expect(() => compile(local({ unixSocketsIn: ["/nonexistent-elsewhere"] }), {}, "darwin", fakeFs({}), options)).toThrow(
      /only in a folder it may write/,
    );
  });
});

/** The literal write denies a macOS compile of a policy writing `/w` resolves: where a link or gitdir lands. */
function darwinLiterals(fs: CompileFs, options: Parameters<typeof compile>[4]): string[] {
  return compile(writing(["/w"]), {}, "darwin", fs, options)
    .config.filesystem.denyWrite.filter((entry) => typeof entry !== "string")
    .map(pathOf);
}

describe("the policy compiler on macOS", () => {
  it("compiles protected names to case-blind patterns, as before, and keeps every other entry", () => {
    const policy = writing(["/nonexistent-w"], { denyWrite: ["/nonexistent-w/downloads"] });
    const { config } = compile(policy, { denyEnv: ["OPENAI_API_KEY"] }, "darwin", fakeFs({}), { home: "/nonexistent-home" });
    expect(config.filesystem.denyWrite).toEqual([
      "/nonexistent-w/downloads",
      ...NAMES.map((name) => `/nonexistent-w/**/${anyCase(name)}`),
      "/nonexistent-w/[hH][eE][aA][dD]",
      ...runtimeSharedWritePaths("/nonexistent-home", "darwin"),
    ]);
    expect(config.credentials).toEqual({ envVars: [{ name: "OPENAI_API_KEY", mode: "deny" }] });
  });

  it("denies a gitdir reached through a symlinked .git or a gitfile, and a protected name through a link, where they land (E21)", () => {
    const fs = fakeFs({
      "/w/gitdirs/one/HEAD": { kind: "file" },
      "/w/linked/.git": { kind: "symlink", to: "/w/gitdirs/one" },
      "/w/gitdirs/two/commondir": { kind: "file", text: "../one\n" },
      "/w/filed/.git": { kind: "file", text: "gitdir: ../gitdirs/two\n" },
      "/w/elsewhere/x": { kind: "file" },
      "/w/sub/.vscode": { kind: "symlink", to: "/w/elsewhere" },
      "/w/real/.git/HEAD": { kind: "file" },
      "/outside/gitdir/HEAD": { kind: "file" },
      "/w/out/.git": { kind: "symlink", to: "/outside/gitdir" },
    });
    const literals = darwinLiterals(fs, { home: "/nonexistent-home" });
    const anchored = (directory: string) =>
      ["hooks", "config", "config.worktree", "commondir", "HEAD"].map((entry) => `${directory}/${entry}`);
    expect(literals.sort()).toEqual([...anchored("/w/gitdirs/one"), ...anchored("/w/gitdirs/two"), "/w/filed/.git", "/w/elsewhere"].sort());
  });

  it("finds a .git or protected name spelled in another case, which a case-blind volume opens as the same, and one in a folder it cannot list", () => {
    const base = fakeFs({
      "/w/gitdirs/one/HEAD": { kind: "file" },
      "/w/upper/.GIT": { kind: "symlink", to: "/w/gitdirs/one" },
      "/w/elsewhere/x": { kind: "file" },
      "/w/mixed/.Vscode": { kind: "symlink", to: "/w/elsewhere" },
      "/w/target2/y": { kind: "file" },
      "/w/locked/.vscode": { kind: "symlink", to: "/w/target2" },
    });
    // A filesystem that reports no type for an entry: asked for it by name.
    const fs: CompileFs = {
      ...base,
      list: (path) => (path === "/w/locked" ? undefined : base.list(path)),
      entries: (path) =>
        path === "/w/locked"
          ? undefined
          : base.list(path)?.map((name) => ({ name, kind: name === "upper" ? "other" : base.kind(`${path}/${name}`) })),
    };
    const literals = darwinLiterals(fs, { home: "/nonexistent-home" });
    expect(literals).toEqual(expect.arrayContaining(["/w/gitdirs/one/hooks", "/w/gitdirs/one/config", "/w/elsewhere", "/w/target2"]));
  });

  it("denies the folder core.hooksPath names, in a plain .git too, relative to the worktree, from ~, through a link, and from a worktree's config", () => {
    const fs = fakeFs({
      "/w/repo/.git/config": { kind: "file", text: "[core]\n\tbare = false\n\thooksPath = .githooks\n" },
      "/w/tilde/.git/config": { kind: "file", text: "[Core]\n  HooksPath = ~/hooks\n" },
      "/w/linked/.git/config": { kind: "file", text: "[core]\nhooksPath = hooks-link\n" },
      "/w/linked/hooks-link": { kind: "symlink", to: "/w/real-hooks" },
      "/w/real-hooks/pre-commit": { kind: "file" },
      "/w/main/.git/config": { kind: "file", text: "[core]\nhooksPath = /w/shared-hooks\n" },
      "/w/main/.git/worktrees/wt/commondir": { kind: "file", text: "../..\n" },
      "/w/main/.git/worktrees/wt/config.worktree": { kind: "file", text: "[core]\nhooksPath = wt-hooks\n" },
      "/w/wt/.git": { kind: "file", text: "gitdir: ../main/.git/worktrees/wt\n" },
      "/w/away/.git/config": { kind: "file", text: "[core]\nhooksPath = /outside/hooks\n" },
    });
    const literals = darwinLiterals(fs, { home: "/w/home" });
    for (const path of ["/w/repo/.githooks", "/w/home/hooks", "/w/linked/hooks-link", "/w/real-hooks", "/w/shared-hooks", "/w/wt/wt-hooks"])
      expect(literals, path).toContain(path);
    expect(literals.filter((path) => path.startsWith("/outside"))).toEqual([]);
  });
});

describe("core.hooksPath as git reads a config", () => {
  it("takes every value in [core], folding case, joining quotes and dropping comments, and none in a subsection", () => {
    expect(
      hooksPathsOf(
        [
          "[core]",
          "\thooksPath = first # a comment",
          '[CORE] HOOKSPATH = "with space" ; another',
          '[core "sub"]',
          "\thooksPath = not-core",
          "[remote.origin]",
          "\thooksPath = not-core-either",
          "[core]",
          '\thookspath = "a\\"b"',
          "\thooksPath =",
          "\thooksPath = /tmp/ev\\",
          "il",
        ].join("\n"),
      ),
    ).toEqual(["first", "with space", 'a"b', "/tmp/evil"]);
    expect(hooksPathsOf(undefined)).toEqual([]);
  });

  it("follows include and includeIf files, and takes the owner's global and system values for every repository", () => {
    const fs = fakeFs({
      "/w/repo/.git/config": { kind: "file", text: '[includeIf "gitdir:/w/"]\n\tpath = ../hooks.inc\n' },
      "/w/repo/hooks.inc": { kind: "file", text: "[include]\n\tpath = ~/deeper.inc\n" },
      "/w/home/deeper.inc": { kind: "file", text: "[core]\n\thooksPath = included\n" },
      "/w/other/.git/HEAD": { kind: "file" },
      "/w/home/.gitconfig": { kind: "file", text: "[core]\n\thooksPath = .githooks\n[include]\n\tpath = .config/abs.inc\n" },
      "/w/home/.config/abs.inc": { kind: "file", text: "[core]\n\thooksPath = /w/shared/hooks\n" },
    });
    const gitConfigs = ["/w/home/.gitconfig"];
    const darwin = darwinLiterals(fs, { home: "/w/home", gitConfigs });
    const linux = compile(writing(["/w"]), {}, "linux", fs, { home: "/w/home", gitConfigs }).config.filesystem.denyWrite.map(pathOf);
    for (const denies of [darwin, linux]) {
      for (const path of ["/w/repo/included", "/w/repo/.githooks", "/w/other/.githooks", "/w/shared/hooks"])
        expect(denies, path).toContain(path);
    }
  });

  it("write-denies the files a repository's or the owner's config includes, through ~, nested, absent, and across a cycle", () => {
    const fs = fakeFs({
      "/w/repo/.git/config": {
        kind: "file",
        text: '[include]\n\tpath = ../shared.inc\n[includeIf "onbranch:main"]\n\tpath = absent.inc\n',
      },
      "/w/repo/shared.inc": { kind: "file", text: "[include]\n\tpath = ~/nested.inc\n" },
      "/w/home/nested.inc": { kind: "file", text: "[include]\n\tpath = /w/repo/shared.inc\n" },
      "/w/home/.gitconfig": { kind: "file", text: "[include]\n\tpath = .config/global.inc\n[include]\n\tpath = /outside/global.inc\n" },
      "/w/home/.config/global.inc": { kind: "file", text: "[user]\n\tname = x\n" },
    });
    const gitConfigs = ["/w/home/.gitconfig"];
    const darwin = darwinLiterals(fs, { home: "/w/home", gitConfigs });
    const linux = compile(writing(["/w"]), {}, "linux", fs, { home: "/w/home", gitConfigs }).config.filesystem.denyWrite.map(pathOf);
    for (const denies of [darwin, linux]) {
      for (const path of ["/w/repo/shared.inc", "/w/home/nested.inc", "/w/repo/.git/absent.inc", "/w/home/.config/global.inc"])
        expect(denies, path).toContain(path);
      // Read-only already: nothing outside a writable root is listed.
      expect(denies.filter((path) => path.startsWith("/outside"))).toEqual([]);
    }
  });
});

describe("the policy compiler on Linux", () => {
  it("emits a literal per protected name at the root, even absent, and none of srt's macOS-only temp spelling", () => {
    const denies = writeDenies(writing(["/w"]), fakeFs({ "/w/readme.md": { kind: "file" } }));
    for (const name of NAMES) expect(denies).toContain(`/w/${name}`);
    expect(denies).toContain("/w/HEAD");
    expect(denies).not.toContain("/private/tmp/claude");
    expect(denies).toContain("/tmp/claude");
    expect(denies.some((path) => /[*?[]/.test(path))).toBe(false);
  });

  it("protects every existing match below the root, and a planted repository's .git anchors", () => {
    const fs = fakeFs({
      "/w/sub/.bashrc": { kind: "file" },
      "/w/sub/repo/.git/objects/ab": { kind: "file" },
      "/w/sub/repo/src/index.ts": { kind: "file" },
    });
    const denies = writeDenies(writing(["/w"]), fs);
    expect(denies).toContain("/w/sub/.bashrc");
    for (const entry of ["hooks", "config", "config.worktree", "commondir", "HEAD"]) expect(denies).toContain(`/w/sub/repo/.git/${entry}`);
    // Never into .git: its objects hold nothing the host runs.
    expect(fs.listed).not.toContain("/w/sub/repo/.git");
    expect(fs.listed).not.toContain("/w/sub/repo/.git/objects");
  });

  it("denies a worktree's .git file, its gitdir's and commondir's anchors, and nothing under the file", () => {
    const fs = fakeFs({
      "/w/main/.git/worktrees/wt/commondir": { kind: "file", text: "../..\n" },
      "/w/main/.git/worktrees/wt/HEAD": { kind: "file" },
      "/w/wt/.git": { kind: "file", text: "gitdir: ../main/.git/worktrees/wt\n" },
    });
    const denies = writeDenies(writing(["/w"]), fs);
    expect(denies).toContain("/w/wt/.git");
    for (const entry of ["hooks", "config", "config.worktree", "commondir", "HEAD"]) {
      expect(denies).toContain(`/w/main/.git/worktrees/wt/${entry}`);
      expect(denies).toContain(`/w/main/.git/${entry}`);
    }
    expect(denies.filter((path) => path.startsWith("/w/wt/.git/"))).toEqual([]);
  });

  it("denies the folder core.hooksPath names, wherever the gitdir naming it is, and refuses a link the sandbox could swap", () => {
    const fs = fakeFs({
      "/w/repo/.git/config": { kind: "file", text: "[core]\n\thooksPath = .githooks\n" },
      "/w/repo/.git/HEAD": { kind: "file" },
      "/elsewhere/repo/.git/modules/sub/config": { kind: "file", text: "[core]\nhooksPath = ../sub-hooks\n" },
      "/w/sub/.git": { kind: "file", text: "gitdir: /elsewhere/repo/.git/modules/sub" },
      "/w/tilde/.git/config": { kind: "file", text: "[core]\nhooksPath = ~/hooks\n" },
    });
    const denies = compile(writing(["/w"]), {}, "linux", fs, { home: "/w/home" }).config.filesystem.denyWrite.map(pathOf);
    expect(denies).toContain("/w/repo/.githooks");
    expect(denies).toContain("/w/sub-hooks");
    expect(denies).toContain("/w/home/hooks");
    const linked = fakeFs({
      "/w/repo/.git/config": { kind: "file", text: "[core]\nhooksPath = hooks\n" },
      "/w/repo/hooks": { kind: "symlink", to: "/w/real" },
      "/w/real/x": { kind: "file" },
    });
    expect(() => writeDenies(writing(["/w"]), linked)).toThrow(/symbolic link/);
  });

  it("leaves a gitdir outside every writable root to the read-only default", () => {
    const fs = fakeFs({
      "/elsewhere/repo/.git/modules/sub/HEAD": { kind: "file" },
      "/w/sub/.git": { kind: "file", text: "gitdir: /elsewhere/repo/.git/modules/sub" },
    });
    const denies = writeDenies(writing(["/w"]), fs);
    expect(denies).toContain("/w/sub/.git");
    expect(denies.filter((path) => path.startsWith("/elsewhere"))).toEqual([]);
  });

  it("never walks dependency or build trees", () => {
    const fs = fakeFs({
      "/w/node_modules/x/.bashrc": { kind: "file" },
      "/w/.venv/lib/.envrc": { kind: "file" },
      "/w/target/debug/.vscode/x": { kind: "file" },
      "/w/dist/assets/.envrc": { kind: "file" },
      "/w/build/out/.envrc": { kind: "file" },
      "/w/pkg/__pycache__/.envrc": { kind: "file" },
      "/w/ios/Pods/x/.envrc": { kind: "file" },
      "/w/src/.envrc": { kind: "file" },
    });
    const denies = writeDenies(writing(["/w"]), fs);
    expect(denies).toContain("/w/src/.envrc");
    for (const pruned of ["/w/node_modules", "/w/.venv", "/w/target", "/w/pkg/__pycache__", "/w/ios/Pods"])
      expect(fs.listed).not.toContain(pruned);
    // `dist` and `build` are often a project's own source: walked.
    expect(denies).toEqual(expect.arrayContaining(["/w/dist/assets/.envrc", "/w/build/out/.envrc"]));
  });

  it("reads each folder's entries with their types in one pass, and looks only for the names that are there", () => {
    const listedTyped: string[] = [];
    const looked: string[] = [];
    const base = fakeFs({ "/w/a/.envrc": { kind: "file" }, "/w/a/src/main.c": { kind: "file" } });
    const fs: CompileFs = {
      ...base,
      kind: (path) => (looked.push(path), base.kind(path)),
      entries: (path) => {
        listedTyped.push(path);
        return base.list(path)?.map((name) => ({ name, kind: base.kind(`${path}/${name}`) }));
      },
    };
    const denies = writeDenies(writing(["/w"]), fs);
    expect(denies).toContain("/w/a/.envrc");
    expect(listedTyped).toEqual(expect.arrayContaining(["/w", "/w/a", "/w/a/src"]));
    // In /w/a/src, where none of the names is, nothing is looked up by name.
    expect(looked.filter((path) => path.startsWith("/w/a/src/"))).toEqual([]);
  });

  it("names where the bulk of a folder too large to walk is", () => {
    const many = Array.from({ length: 50_001 }, (_, index) => `p${String(index)}`);
    const fs: CompileFs = {
      kind: (path) =>
        ["/big", "/big/deps", "/big/src", "/big/deps/vendored"].includes(path) || /^\/big\/deps\/vendored\/p\d+$/.test(path)
          ? "directory"
          : undefined,
      list: (path) => (path === "/big" ? ["deps", "src"] : path === "/big/deps" ? ["vendored"] : path === "/big/deps/vendored" ? many : []),
      link: () => undefined,
      read: () => undefined,
      real: (path) => path,
      foldsCase: () => false,
    };
    let error: unknown;
    try {
      writeDenies(writing(["/big"]), fs);
    } catch (caught) {
      error = caught;
    }
    expect((error as TaviError).message).toContain("most of them are in /big/deps/vendored");
    expect((error as TaviError).details).toMatchObject({ reason: "walk-cap", largest: "/big/deps/vendored" });
  });

  it("refuses a protected name, or a folder above it, that is a symbolic link the sandbox could replace (bwrap cannot mount over a link)", () => {
    const cases: readonly [Record<string, Node>, string][] = [
      [{ "/w/config/claude/settings.json": { kind: "file" }, "/w/.claude": { kind: "symlink", to: "/w/config/claude" } }, "/w/.claude"],
      [{ "/w/.vscode": { kind: "symlink", to: "/w/x" } }, "/w/.vscode"],
      [{ "/w/real/.bashrc": { kind: "file" }, "/w/sub/.bashrc": { kind: "symlink", to: "/w/real/.bashrc" } }, "/w/sub/.bashrc"],
      [{ "/outside/.envrc": { kind: "file" }, "/w/.envrc": { kind: "symlink", to: "/outside/.envrc" } }, "/w/.envrc"],
      [{ "/w/gitdirs/one/HEAD": { kind: "file" }, "/w/repo/.git": { kind: "symlink", to: "/w/gitdirs/one" } }, "/w/repo/.git"],
      [
        {
          "/w/shared-hooks/x": { kind: "file" },
          "/w/repo/.git/HEAD": { kind: "file" },
          "/w/repo/.git/hooks": { kind: "symlink", to: "/w/shared-hooks" },
        },
        "/w/repo/.git/hooks",
      ],
    ];
    for (const [entries, link] of cases) {
      let error: unknown;
      try {
        writeDenies(writing(["/w"]), fakeFs(entries));
      } catch (caught) {
        error = caught;
      }
      expect(error, link).toBeInstanceOf(TaviError);
      expect((error as TaviError).code).toBe("UNAVAILABLE");
      expect((error as TaviError).message).toContain(`${link} is a symbolic link`);
      expect((error as TaviError).details).toMatchObject({ reason: "protected-symlink", path: link });
    }
  });

  it("protects a link's writable destination when the link itself lies outside every writable root", () => {
    const fs = fakeFs({ "/w/real/.bashrc": { kind: "file" }, "/r/.bashrc": { kind: "symlink", to: "/w/real/.bashrc" } });
    const policy = writing(["/w"], { allowRead: ["/w", "/r"], protectedNames: [{ root: "/r", names: [".bashrc"] }] });
    expect(writeDenies(policy, fs)).toContain("/w/real/.bashrc");
  });

  it("denies every name in a folder it cannot list, which the sandbox could still open by name", () => {
    const denies = writeDenies(writing(["/w"]), fakeFs({ "/w/locked/inner": { kind: "file" } }, { unlistable: ["/w/locked"] }));
    expect(denies).toEqual(expect.arrayContaining(["/w/locked/.bashrc", "/w/locked/.envrc", "/w/locked/.git/hooks"]));
  });

  it("charges srt's pinned ancestors to the mount budget", () => {
    const entries: Record<string, Node> = {};
    // One match per deep folder: each costs itself and its three new ancestors, past the budget long before the matches alone.
    for (let index = 0; index < MOUNT_BUDGET / 3; index += 1) entries[`/deep/a${String(index)}/b/c/.bashrc`] = { kind: "file" };
    expect(() => writeDenies(writing(["/deep"]), fakeFs(entries))).toThrow(/too large to protect/);
  });

  it("never follows a directory link that holds no protected name", () => {
    const fs = fakeFs({ "/w/link": { kind: "symlink", to: "/outside" }, "/outside/.bashrc": { kind: "file" } });
    expect(writeDenies(writing(["/w"]), fs)).not.toContain("/outside/.bashrc");
    expect(fs.listed).not.toContain("/w/link");
  });

  it("drops a deny beneath another, which bubblewrap could not mount inside the read-only one", () => {
    const fs = fakeFs({ "/w/.git/config": { kind: "file" }, "/w/sub/repo/.git/HEAD": { kind: "file" } });
    const denies = writeDenies(
      writing(["/w"], { protectedNames: [{ root: "/w", names: [".git", ".git/hooks", ".bashrc"], rootNames: ["HEAD"] }] }),
      fs,
    );
    expect(denies).toContain("/w/.git");
    expect(denies).toContain("/w/sub/repo/.git");
    expect(denies.filter((path) => path.includes("/.git/"))).toEqual([]);
  });

  it("denies a file ancestor of a name instead of the name beneath it, which srt would drop silently", () => {
    const denies = writeDenies(
      writing(["/w"]),
      fakeFs({ "/w/.git": { kind: "file", text: "gitdir: /nowhere" }, "/w/.claude": { kind: "file" } }),
    );
    expect(denies).toContain("/w/.git");
    expect(denies).not.toContain("/w/.git/hooks");
    // Left writable, the file could be removed and a folder holding settings.json made in its place.
    expect(denies).toContain("/w/.claude");
    expect(denies).not.toContain("/w/.claude/settings.json");
  });

  it("refuses a folder past the mount budget, naming it, before srt sees it", () => {
    const entries: Record<string, Node> = {};
    for (let index = 0; index < MOUNT_BUDGET; index += 1) entries[`/big/d${String(index)}/.bashrc`] = { kind: "file" };
    let error: unknown;
    try {
      writeDenies(writing(["/big"]), fakeFs(entries));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TaviError);
    expect((error as TaviError).code).toBe("UNAVAILABLE");
    expect((error as TaviError).message).toContain("/big is too large to protect");
  });

  it("refuses a case-folding writable root", () => {
    expect(() => writeDenies(writing(["/fat"]), fakeFs({ "/fat/x": { kind: "file" } }, { folding: ["/fat"] }))).toThrow(
      /ignores letter case/,
    );
  });

  it("expands a last-segment write-deny glob to what matches now, drops any other, saying so, and leaves read globs to srt", () => {
    const fs = fakeFs({
      "/data/tavi.sqlite": { kind: "file" },
      "/data/tavi.sqlite-wal": { kind: "file" },
      "/data/notes.md": { kind: "file" },
    });
    const policy = writing(["/w"], { denyWrite: ["/data/*.sqlite*", "/data/*/x"] });
    const { config, dropped } = compile(policy, {}, "linux", fs, { home: "/nonexistent-home" });
    const denies = config.filesystem.denyWrite.map(pathOf);
    expect(denies).toEqual(expect.arrayContaining(["/data/tavi.sqlite", "/data/tavi.sqlite-wal"]));
    expect(denies).not.toContain("/data/notes.md");
    expect(dropped).toEqual([expect.stringContaining("/data/*/x")]);
    expect(compile(writing(["/w"], { denyRead: ["/data/*.key"] }), {}, "linux", fs).config.filesystem.denyRead).toContain("/data/*.key");
  });
});

describe("one credentials assembly", () => {
  it("merges denies and masks, the deny winning a collision", () => {
    expect(
      credentialsOf(
        ["A", "B"],
        [
          { name: "B", hosts: ["api.example"] },
          { name: "C", hosts: ["api.example"] },
        ],
      ),
    ).toEqual({
      envVars: [
        { name: "A", mode: "deny" },
        { name: "B", mode: "deny" },
        { name: "C", mode: "mask", injectHosts: ["api.example"] },
      ],
    });
    expect(credentialsOf([])).toBeUndefined();
  });

  it("refuses to deny the proxy's own variables, and a name that is not one", () => {
    expect(() => credentialsOf(["HTTPS_PROXY"])).toThrow(/proxy's own/);
    expect(() => credentialsOf(["1BAD"])).toThrow(/not an identifier/);
  });
});
