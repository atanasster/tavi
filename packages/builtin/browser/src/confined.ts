import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { TaviError, refusedEarly, type ChromiumSandboxMode, type ConfinementPort, type ResourceLimitPort } from "@tavi/contracts";
import type { Browser, BrowserContext, BrowserContextOptions, BrowserType, LaunchOptions } from "playwright";

import { HEADLESS_SHELL_MISSING_MESSAGE, launchChromium, launchPersistentChromium, loadChromium } from "./chromium.js";
import { joinPath, pathEntries, systemChildEnv, systemPathEntries } from "@tavi/node-kit";

/**
 * Chromium confined: each launch
 * runs under the owner's `ConfinementPort` and in its limits, so a
 * compromised renderer or a page's download reads neither the person's files
 * nor Tavi's data. Playwright launches `bin/confined-chromium.mjs` as the
 * executable; it starts the confinement command written for that launch,
 * and `bin/chromium-shim.mjs` inside starts Chromium, carrying its CDP pipe
 * (fds 3 and 4) over stdio, which is all a sandbox passes on.
 *
 * - Reads: Playwright's browser folder, the shim, the launch's scratch and
 *   (persistent) the profile; the owner's home and data directory denied.
 * - Writes: the launch's scratch (its `HOME`, `TMPDIR`, downloads and a
 *   temporary profile) and the profile.
 * - Network: every host (`*`), through srt's proxy — the only way out of its
 *   namespace — which reaches no loopback, link-local or metadata address and,
 *   with `privateAddresses`, no private or CGNAT one either, by number or by a
 *   name resolving to one, dialing the address it checked: the owner's address
 *   rule at the network layer, for every request a page, a worker, a new tab or
 *   a prefetch makes.
 *
 * Chromium's own sandbox inside it is the strongest that works here,
 * found by the first launch: `full` (nested in srt), `seccomp` (Linux: its
 * seccomp layer, srt's namespaces), then `none` (`--no-sandbox`, srt alone).
 * When `full` (nested sandbox) works, full Chromium is preferred over the
 * headless shell; otherwise a headless launch falls back to Playwright's
 * headless shell and refuses without it.
 */
export type { ChromiumSandboxMode } from "@tavi/contracts";

export interface BrowserConfinementOptions {
  readonly confinement: ConfinementPort;
  readonly limits?: ResourceLimitPort;
  /** Read-denied for the browser: the owner's home and data directory. */
  readonly denyRead: readonly string[];
  /** An owner-private folder for each launch's scratch, descriptor and policy (in the data directory). */
  readonly scratchDirectory: string;
  readonly nested?: boolean;
  /** The private network held off but for these addresses (`ConfinementPolicy.privateAddresses`). */
  readonly privateAddresses?: { readonly except: readonly string[] };
  /** The modes tried, strongest first; default by platform. */
  readonly modes?: readonly ChromiumSandboxMode[];
  /**
   * Which Chromium a headless confined launch runs: the full browser when it starts inside the sandbox, else
   * the headless shell (`auto`, the default), or the headless shell only (`headless-shell`).
   */
  readonly chromium?: "auto" | "headless-shell";
  /** Told which mode the probe chose, and why each stronger one failed. */
  readonly onMode?: (
    mode: ChromiumSandboxMode,
    failures: readonly { readonly mode: ChromiumSandboxMode; readonly error: string }[],
  ) => void;
  readonly load?: () => Promise<BrowserType>;
}

export interface ConfinedChromium {
  launch(options: LaunchOptions): Promise<Browser>;
  launchPersistent(userDataDir: string, options: LaunchOptions & BrowserContextOptions): Promise<BrowserContext>;
  /** The mode the probe chose, once a launch has run. */
  mode(): ChromiumSandboxMode | undefined;
}

const bin = (name: string): string => join(import.meta.dirname, "..", "bin", name);

const MODE_FLAGS: Readonly<Record<ChromiumSandboxMode, readonly string[]>> = {
  // The setuid helper cannot work under no-new-privs, which srt always sets.
  full: ["--disable-setuid-sandbox"],
  seccomp: ["--disable-setuid-sandbox", "--disable-namespace-sandbox"],
  none: ["--no-sandbox"],
};

/** Playwright's folder of browsers, from one browser's executable (`…/ms-playwright/chromium-1243/…`). */
export function browsersRoot(executable: string): string {
  for (let directory = dirname(executable); directory !== dirname(directory); directory = dirname(directory)) {
    if (/^chromium(?:_headless_shell)?-\d+$/.test(basename(directory))) return dirname(directory);
  }
  return dirname(executable);
}

/**
 * Whether a browser is here to launch: Playwright resolves, and its Chromium
 * or the headless shell beside it was downloaded. What the owner reads before
 * offering the browser tools, so a model is not handed tools that can only
 * fail with `CAPABILITY_MISSING` (and a person asked to approve them). Read
 * afresh on each call (the owner rereads it at most every half minute):
 * `npx playwright install chromium` while the owner runs offers them soon after.
 */
export async function chromiumInstalled(
  load: () => Promise<Pick<BrowserType, "executablePath">> = () => loadChromium(),
  exists: (path: string) => boolean = existsSync,
  list?: (directory: string) => readonly string[],
): Promise<boolean> {
  let executable: string;
  try {
    executable = (await load()).executablePath();
  } catch {
    // Playwright not installed (or broken): nothing to launch.
    return false;
  }
  return exists(executable) || headlessShellOf(executable, ...(list === undefined ? [] : [list])) !== undefined;
}

/**
 * The headless shell beside a Chromium (`chromium_headless_shell-<rev>`), when
 * Playwright installed it: what a confined headless launch runs. The full
 * browser's process singleton needs `socket(AF_UNIX)`, which srt's Linux
 * filter refuses; the shell has none.
 */
export function headlessShellOf(
  executable: string,
  list: (directory: string) => readonly string[] = (directory) => readdirSync(directory),
): string | undefined {
  const root = browsersRoot(executable);
  const revision = /chromium-(\d+)/.exec(executable)?.[1];
  if (revision === undefined) return undefined;
  const folder = join(root, `chromium_headless_shell-${revision}`);
  const entries = (directory: string): readonly string[] => {
    try {
      return list(directory);
    } catch {
      // Not there, or a file (the install's own markers sit beside the platform folder).
      return [];
    }
  };
  const platform = entries(folder).find((entry) => entries(join(folder, entry)).includes("chrome-headless-shell"));
  return platform === undefined ? undefined : join(folder, platform, "chrome-headless-shell");
}

/** Every launch folder in `directory`, from a run before this one. */
function sweep(directory: string): void {
  for (const entry of readdirSync(directory))
    if (entry.startsWith("launch-")) rmSync(join(directory, entry), { recursive: true, force: true });
}

export function createConfinedChromium(options: BrowserConfinementOptions): ConfinedChromium {
  const load = options.load ?? (() => loadChromium());
  const modes = options.modes ?? (process.platform === "linux" ? (["full", "seccomp", "none"] as const) : (["full", "none"] as const));
  let chosen: ChromiumSandboxMode | undefined;
  let chosenShell = false;
  let choosing: Promise<ChromiumSandboxMode> | undefined;
  let counter = 0;
  let swept = false;

  /** One launch's options: the wrapper as the executable, its descriptor written, its scratch made; `release` undoes them. */
  async function prepare(
    launchOptions: LaunchOptions,
    mode: ChromiumSandboxMode,
    profile?: string,
    useShell = chosenShell,
  ): Promise<{ readonly options: LaunchOptions; readonly release: () => void }> {
    const browser = (await load()).executablePath();
    const shell = launchOptions.headless === false || !useShell ? undefined : headlessShellOf(browser);
    if (launchOptions.headless !== false && useShell && shell === undefined) {
      throw refusedEarly("CAPABILITY_MISSING", HEADLESS_SHELL_MISSING_MESSAGE, { capability: "chromium-headless-shell" });
    }
    const executable = shell ?? browser;
    mkdirSync(options.scratchDirectory, { recursive: true, mode: 0o700 });
    // What a crashed run left (a temporary profile holds cookies) goes before this process's first launch.
    if (!swept) {
      sweep(options.scratchDirectory);
      swept = true;
    }
    counter += 1;
    const scratch = mkdtempSync(join(options.scratchDirectory, `launch-${String(counter)}-`));
    const descriptor = `${scratch}.launch.json`;
    let groupId: string | undefined;
    const release = (): void => {
      if (groupId !== undefined) options.limits?.release(groupId);
      for (const path of [scratch, descriptor, `${scratch}.srt.json`]) rmSync(path, { recursive: true, force: true });
    };
    try {
      for (const folder of [".tmp", "downloads"]) mkdirSync(join(scratch, folder), { mode: 0o700 });
      const writable = [scratch, ...(profile === undefined ? [] : [profile])];
      const command = options.confinement.wrap({
        argv: [process.execPath, bin("chromium-shim.mjs"), executable],
        env: {
          ...systemChildEnv([], true),
          HOME: scratch,
          TMPDIR: join(scratch, ".tmp"),
          ...(process.env["LANG"] === undefined ? {} : { LANG: process.env["LANG"] }),
        },
        policyFile: `${scratch}.srt.json`,
        policy: {
          denyRead: [...options.denyRead],
          allowRead: [browsersRoot(executable), join(import.meta.dirname, "..", "bin"), ...writable],
          allowWrite: writable,
          domains: ["*"],
          nested: options.nested === true,
          // Chromium's process singleton binds a socket in its TMPDIR.
          unixSockets: [scratch],
          ...(options.privateAddresses === undefined ? {} : { privateAddresses: { except: [...options.privateAddresses.except] } }),
        },
      });
      const placed = options.limits?.place([command.command, ...command.args], "browser") ?? { argv: [command.command, ...command.args] };
      groupId = placed.groupId;
      writeFileSync(
        descriptor,
        JSON.stringify({
          command: placed.argv[0],
          args: placed.argv.slice(1),
          env: command.env,
          scratch,
          ...(profile === undefined ? {} : { profile }),
        }),
        { mode: 0o600 },
      );
      const { channel: _channel, ...rest } = launchOptions;
      return {
        options: {
          ...rest,
          executablePath: bin("confined-chromium.mjs"),
          // The wrapper runs on `#!/usr/bin/env node`: the owner's own Node first, wherever it is installed (nvm, a unit's PATH).
          env: {
            TAVI_CONFINED_LAUNCH: descriptor,
            PATH: joinPath([dirname(process.execPath), ...pathEntries(process.env["PATH"]), ...systemPathEntries()]),
          },
          downloadsPath: join(scratch, "downloads"),
          chromiumSandbox: mode !== "none",
          args: [...(launchOptions.args ?? []), ...MODE_FLAGS[mode], "--disable-dev-shm-usage"],
        },
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** A launch in `mode`, released when what it opened closes. */
  async function launchIn(mode: ChromiumSandboxMode, launchOptions: LaunchOptions, useShell = chosenShell): Promise<Browser> {
    const prepared = await prepare(launchOptions, mode, undefined, useShell);
    try {
      const browser = await launchChromium(prepared.options, load);
      browser.on("disconnected", prepared.release);
      return browser;
    } catch (error) {
      prepared.release();
      throw error;
    }
  }

  /** Whether `mode` runs a page: the renderer starts under it and answers. */
  async function works(mode: ChromiumSandboxMode, launchOptions: LaunchOptions, useShell: boolean): Promise<void> {
    const browser = await launchIn(mode, launchOptions, useShell);
    try {
      const page = await browser.newPage();
      await page.setContent("<p id=probe>ok</p>", { timeout: 15_000 });
      if ((await page.textContent("#probe", { timeout: 15_000 })) !== "ok") throw new Error("the page did not render");
    } finally {
      // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
      await browser.close().catch(() => undefined);
    }
  }

  async function tryCandidate(mode: ChromiumSandboxMode, launchOptions: LaunchOptions, useShell: boolean): Promise<string | undefined> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await works(mode, launchOptions, useShell);
        return undefined;
      } catch (error) {
        if (error instanceof TaviError && error.code === "CAPABILITY_MISSING") throw error;
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        if (timedOut && attempt === 1) continue;
        return error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error);
      }
    }
    return "probe failed";
  }

  /** The strongest mode that works here, found once. */
  function modeFor(launchOptions: LaunchOptions): Promise<ChromiumSandboxMode> {
    if (chosen !== undefined) return Promise.resolve(chosen);
    choosing ??= (async () => {
      const failures: { readonly mode: ChromiumSandboxMode; readonly error: string }[] = [];
      for (const mode of modes) {
        if (mode === "full" && launchOptions.headless !== false) {
          // First check whether full Chromium runs inside bwrap with its own sandbox nested, and prefer it over the headless shell.
          const shellOnly = options.chromium === "headless-shell";
          const fullError = shellOnly ? undefined : await tryCandidate("full", launchOptions, false);
          if (!shellOnly && fullError === undefined) {
            chosen = "full";
            chosenShell = false;
            options.onMode?.("full", failures);
            return "full";
          }
          const browser = (await load()).executablePath();
          const shellError =
            headlessShellOf(browser) === undefined ? "no headless shell is installed" : await tryCandidate("full", launchOptions, true);
          if (shellError === undefined) {
            chosen = "full";
            chosenShell = true;
            options.onMode?.("full", failures);
            return "full";
          }
          // What failed: the shell, when it was the one asked for; else the full browser, the one preferred.
          failures.push({ mode: "full", error: shellOnly ? shellError : (fullError ?? shellError) });
          continue;
        }
        const useShell = launchOptions.headless !== false;
        const error = await tryCandidate(mode, launchOptions, useShell);
        if (error === undefined) {
          chosen = mode;
          chosenShell = useShell;
          options.onMode?.(mode, failures);
          return mode;
        }
        failures.push({ mode, error });
      }
      throw new TaviError(
        "UNAVAILABLE",
        `Chromium would not start confined: ${failures.map((failure) => `${failure.mode}: ${failure.error}`).join("; ")}`,
      );
    })().finally(() => (choosing = undefined));
    return choosing;
  }

  return {
    async launch(launchOptions) {
      return launchIn(await modeFor(launchOptions), launchOptions);
    },
    async launchPersistent(userDataDir, launchOptions) {
      const mode = await modeFor(launchOptions);
      const prepared = await prepare(launchOptions, mode, userDataDir);
      try {
        const context = await launchPersistentChromium(userDataDir, prepared.options, load);
        context.on("close", prepared.release);
        return context;
      } catch (error) {
        prepared.release();
        throw error;
      }
    },
    mode: () => chosen,
  };
}
