import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConfinedLaunch, SandboxPolicy } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { compile, type CompilePlatform } from "../src/policy-compile.js";
import { hostProcessPath } from "../src/paths.js";
import { createSrtConfinement, nodeReadRoot, srtCliPath, srtHelpersDirectory, srtSettingsOf } from "../src/srt-cli.js";
import { fakeFs } from "./fake-fs.js";

/**
 * Golden configs: every producer's srt
 * config, compiled over one fake filesystem for each platform, checked in
 * under `test/golden/`. An srt upgrade or a compiler change shows here as a
 * diff to review; `TAVI_UPDATE_GOLDEN=1` writes the new ones.
 */

const UPDATE = process.env["TAVI_UPDATE_GOLDEN"] === "1";
const PLATFORMS: readonly CompilePlatform[] = ["darwin", "linux"];
const HOME = "/home/person";
const DATA = "/srv/tavi-data";

/** A person's home, Tavi's data directory, a chat's host folder with a repository and a worktree, and a plugin. */
const fs = fakeFs({
  [`${HOME}/.ssh/id_ed25519`]: { kind: "file" },
  [`${DATA}/tavi.sqlite`]: { kind: "file" },
  [`${DATA}/chats/default/t1/.home/.keep`]: { kind: "file" },
  "/work/project/.git/HEAD": { kind: "file", text: "ref: refs/heads/main\n" },
  "/work/project/.git/hooks/pre-commit.sample": { kind: "file" },
  "/work/project/.bashrc": { kind: "file" },
  "/work/project/src/index.ts": { kind: "file" },
  "/work/project/wt/.git": { kind: "file", text: "gitdir: /work/project/.git/worktrees/wt\n" },
  "/work/project/.git/worktrees/wt/commondir": { kind: "file", text: "../..\n" },
  [`${DATA}/plugins/acme.echo/1.0.0/index.mjs`]: { kind: "file" },
});

const NAMES = [".git", ".git/hooks", ".git/config", ".bashrc", ".zshrc", ".profile", ".envrc", ".vscode", ".idea", ".claude/settings.json"];

/** The producers, each as its owner builds its policy. */
const PRODUCERS: Readonly<Record<string, (platform: CompilePlatform) => unknown>> = {
  // A chat's shell in a host folder (sandbox-browser-tools.ts policyFor).
  "sandbox-run": (platform) =>
    compile(
      {
        filesystem: {
          allowRead: ["/work/project", `${DATA}/chats/default/t1`],
          allowWrite: ["/work/project", `${DATA}/chats/default/t1`],
          denyRead: [HOME, DATA, "/tmp"],
          denyWrite: [`${HOME}/.ssh`],
          protectedNames: [{ root: "/work/project", names: NAMES, rootNames: ["HEAD"] }],
        },
        network: { allow: false },
        resources: { timeoutMs: 30_000, maxOutputBytes: 65_536 },
      } satisfies SandboxPolicy,
      { denyEnv: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] },
      platform,
      fs,
      { home: HOME },
    ).config,
  // The same, granted domains.
  "sandbox-run-network": (platform) =>
    compile(
      {
        filesystem: { allowRead: [`${DATA}/chats/default/t1`], allowWrite: [`${DATA}/chats/default/t1`], denyRead: [HOME, DATA] },
        network: { allow: true, allowedHosts: ["pypi.org", "*.pythonhosted.org", "api.example.com:443"] },
        resources: { timeoutMs: 30_000, maxOutputBytes: 65_536 },
      },
      {},
      platform,
      fs,
      { home: HOME },
    ).config,
  // An MCP stdio server (mcp/launcher.ts): its home writable, a domain granted.
  "mcp-server": (platform) =>
    srtSettingsOf(
      {
        allowedDomains: ["api.github.com"],
        denyRead: [HOME, DATA],
        allowRead: [`${DATA}/mcp/mcp.docs/home`],
        allowWrite: [`${DATA}/mcp/mcp.docs/home`],
        nested: false,
      },
      platform,
      fs,
      HOME,
    ),
  // The PDF parser child (pdf-host.ts): nothing writable, no network.
  "pdf-child": (platform) =>
    srtSettingsOf({ allowedDomains: [], denyRead: [HOME, DATA], allowRead: [], allowWrite: [], nested: false }, platform, fs, HOME),
  // The PDF OCR child (pdf-host.ts) as the owner's confinement wraps it: the engine's package and the add-on's folder
  // readable, nothing writable, no network, the owner's staging and the names it stages under denied whatever the policy says.
  "pdf-ocr-child": (platform) =>
    wrapped(
      platform,
      {
        argv: [
          "/usr/bin/node",
          "--max-old-space-size=512",
          "/opt/tavi/plugin-pdf/dist/ocr-child.mjs",
          "/opt/tavi/pdf-ocr/assets/tesseract-core.wasm.js",
          "/opt/tavi/pdf-ocr/assets/tesseract-core.wasm",
          "/opt/tavi/pdf-ocr/assets/eng.traineddata",
        ],
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        policy: {
          denyRead: [HOME, DATA],
          allowRead: ["/opt/tavi/plugin-pdf", "/opt/tavi/pdf-ocr/assets"],
          allowWrite: [],
          domains: [],
          nested: false,
        },
      },
      ["/tmp/tavi-1000", "/tmp/tavi-render-*"],
    ),
  // A child under srt's weaker nested mode with Tavi's own bubblewrap.
  "nested-bwrap": (platform) =>
    srtSettingsOf(
      {
        allowedDomains: [],
        denyRead: [HOME, DATA],
        allowRead: [],
        allowWrite: [`${DATA}/mcp/mcp.docs/home`],
        nested: true,
        bwrapPath: "/opt/tavi/libexec/bwrap",
      },
      platform,
      fs,
      HOME,
    ),
  // A plugin worker: its version folder readable, its home writable, its domains.
  "plugin-worker": (platform) =>
    srtSettingsOf(
      {
        allowedDomains: ["httpbin.org"],
        denyRead: [HOME, DATA],
        allowRead: [`${DATA}/plugins/acme.echo/1.0.0`, `${DATA}/plugins/acme.echo/home`],
        allowWrite: [`${DATA}/plugins/acme.echo/home`],
        nested: false,
      },
      platform,
      fs,
      HOME,
    ),
  // The confined browser (browser-scratch): every host, so the host process's `--request` file, with its Unix sockets.
  browser: (platform) =>
    wrapped(platform, {
      argv: ["/usr/bin/node", "/opt/tavi/chromium-shim.mjs", "/opt/ms-playwright/chromium_headless_shell/chrome-linux/headless_shell"],
      env: { HOME: `${DATA}/browser-scratch/s1`, TMPDIR: `${DATA}/browser-scratch/s1/.tmp`, PATH: "/usr/bin:/bin" },
      policy: {
        denyRead: [HOME, DATA],
        allowRead: ["/opt/ms-playwright", `${DATA}/browser-scratch/s1`],
        allowWrite: [`${DATA}/browser-scratch/s1`],
        domains: ["*"],
        nested: false,
        unixSockets: [`${DATA}/browser-scratch/s1`],
      },
    }),
  // A plugin worker with a credential: masked toward its exact host, whose TLS alone the owner's CA terminates.
  "credentials-worker": (platform) =>
    wrapped(platform, {
      argv: ["/usr/bin/node", "/opt/tavi/worker.mjs"],
      env: { HOME: `${DATA}/plugins/acme.echo/home`, TMPDIR: `${DATA}/plugins/acme.echo/home/.tmp`, GH_TOKEN: "ghp_not_in_the_golden" },
      policy: {
        denyRead: [HOME, DATA],
        allowRead: [`${DATA}/plugins/acme.echo/1.0.0`],
        allowWrite: [`${DATA}/plugins/acme.echo/home`],
        domains: ["api.github.com", "*.githubusercontent.com:443"],
        nested: false,
        credentials: [{ env: "GH_TOKEN", hosts: ["api.github.com"] }],
      },
    }),
};

/**
 * What `createSrtConfinement().wrap` writes for `launch` on `platform`, with
 * the paths of this run stubbed: the owner's node, srt's helpers, the CA
 * minted for it and the request file.
 */
function wrapped(platform: CompilePlatform, launch: Omit<ConfinedLaunch, "policyFile">, alwaysDenyRead: readonly string[] = []): unknown {
  const directory = mkdtempSync(join(tmpdir(), "tavi-golden-"));
  try {
    const caDirectory = join(directory, "ca");
    const policyFile = join(directory, "policy.json");
    const command = createSrtConfinement({
      platform,
      fs,
      home: HOME,
      caDirectory,
      // The host's own bwrap, socat and rg stay out of the config, so a golden reads the same on every machine.
      bwrapPath: () => undefined,
      helperPath: () => undefined,
      alwaysDenyRead,
    }).wrap({
      ...launch,
      policyFile,
    });
    let text = readFileSync(policyFile, "utf8");
    const ca = existsSync(caDirectory) ? readdirSync(caDirectory)[0] : undefined;
    // Whole JSON strings only, so a stub never rewrites part of another path (the node root may be `/usr`).
    const stubs: readonly (readonly [string, string])[] = [
      ...(ca === undefined
        ? []
        : ([
            [join(caDirectory, ca, "ca.crt"), "<ca>/ca.crt"],
            [join(caDirectory, ca, "ca.key"), "<ca>/ca.key"],
          ] as const)),
      [nodeReadRoot(launch.policy.denyRead), "<node>"],
      [srtHelpersDirectory(), "<srt-helpers>"],
    ];
    for (const [path, stub] of stubs) text = text.split(JSON.stringify(path)).join(JSON.stringify(stub));
    return {
      args: command.args.map((arg) =>
        arg === policyFile
          ? "<policy-file>"
          : arg === hostProcessPath()
            ? "<host-process>"
            : arg === srtCliPath()
              ? "<srt-cli>"
              : arg === process.execPath
                ? "<node-binary>"
                : arg,
      ),
      written: JSON.parse(text) as unknown,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("golden srt configs", () => {
  for (const [name, produce] of Object.entries(PRODUCERS)) {
    for (const platform of PLATFORMS) {
      it(`${name} on ${platform}`, () => {
        const file = join(import.meta.dirname, "golden", `${name}.${platform}.json`);
        const actual = `${JSON.stringify(produce(platform), null, 2)}\n`;
        // Written only when asked: a missing golden fails, so one never passes by being made on the spot.
        if (UPDATE) writeFileSync(file, actual);
        expect(existsSync(file), `${file} is missing; TAVI_UPDATE_GOLDEN=1 writes it`).toBe(true);
        expect(actual).toBe(readFileSync(file, "utf8"));
      });
    }
  }
});
