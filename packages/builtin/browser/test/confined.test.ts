import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ConfinedLaunch, ConfinementPort } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import type { Browser, BrowserContext, BrowserType, LaunchOptions } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import { browsersRoot, chromiumInstalled, createConfinedChromium, headlessShellOf } from "../src/confined.js";

/** Chromium confined, against a fake Playwright and confinement: what a launch is given, and how a mode is chosen. */

const temp = temporaryDirectories();
afterEach(() => temp.cleanup());

const CHROME = "/cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome";

describe("finding Playwright's browsers", () => {
  it("finds the browsers folder and the headless shell beside a Chromium", () => {
    expect(browsersRoot(CHROME)).toBe("/cache/ms-playwright");
    const tree: Record<string, readonly string[]> = {
      "/cache/ms-playwright/chromium_headless_shell-1243": ["INSTALLATION_COMPLETE", "chrome-headless-shell-linux-arm64"],
      "/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux-arm64": ["chrome-headless-shell", "ABOUT"],
    };
    const list = (directory: string): readonly string[] => {
      const entries = tree[directory];
      if (entries === undefined) throw new Error("ENOTDIR");
      return entries;
    };
    expect(headlessShellOf(CHROME, list)).toBe(
      "/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux-arm64/chrome-headless-shell",
    );
    expect(headlessShellOf("/elsewhere/chrome", list)).toBeUndefined();
  });
});

describe("whether a Chromium is installed", () => {
  const CHROMIUM = "/cache/ms-playwright/chromium-1243/chrome-linux/chrome";
  const at = (executable: string) => () => Promise.resolve({ executablePath: () => executable });
  const nothing = (): readonly string[] => {
    throw new Error("ENOENT");
  };

  it("is yes when Playwright's Chromium is on disk, and no when it was never downloaded", async () => {
    expect(await chromiumInstalled(at(CHROMIUM), (path) => path === CHROMIUM, nothing)).toBe(true);
    expect(await chromiumInstalled(at(CHROMIUM), () => false, nothing)).toBe(false);
  });

  it("is yes when only the headless shell beside it was downloaded", async () => {
    const list = (directory: string): readonly string[] => {
      if (directory === "/cache/ms-playwright") return ["chromium_headless_shell-1243"];
      if (directory === "/cache/ms-playwright/chromium_headless_shell-1243") return ["chrome-headless-shell-linux64"];
      if (directory === "/cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64") return ["chrome-headless-shell"];
      throw new Error("ENOENT");
    };
    expect(await chromiumInstalled(at(CHROMIUM), () => false, list)).toBe(true);
  });

  it("is no when Playwright itself is not installed", async () => {
    expect(await chromiumInstalled(() => Promise.reject(new Error("Cannot find package 'playwright'")))).toBe(false);
  });
});

describe("a confined launch", () => {
  /** A Playwright browsers folder: a Chromium and, unless `shell` is false, its headless shell (empty files; nothing runs them). */
  function installed(shell = true): string {
    const root = temp.create("tavi-browsers-");
    const chrome = join(root, "chromium-1243", "chrome-linux-arm64", "chrome");
    const paths = [
      chrome,
      ...(shell ? [join(root, "chromium_headless_shell-1243", "chrome-headless-shell-linux-arm64", "chrome-headless-shell")] : []),
    ];
    for (const path of paths) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "");
    }
    return chrome;
  }

  function fakes(works: (options: LaunchOptions) => boolean, chrome = installed()) {
    const wrapped: ConfinedLaunch[] = [];
    const launched: LaunchOptions[] = [];
    const confinement: ConfinementPort = {
      wrap: (launch) => (
        wrapped.push(launch),
        { command: "/usr/bin/node", args: ["host-process.mjs", "--request", launch.policyFile], env: { HOME: launch.env["HOME"] ?? "" } }
      ),
    };
    const browser = (): Browser => {
      const handlers: (() => void)[] = [];
      return {
        on: (event: string, handler: () => void) => void (event === "disconnected" && handlers.push(handler)),
        close: async () => handlers.forEach((handler) => handler()),
        newPage: async () => ({ setContent: async () => undefined, textContent: async () => "ok" }),
      } as unknown as Browser;
    };
    const chromium = {
      executablePath: () => chrome,
      launch: async (options: LaunchOptions) => {
        launched.push(options);
        if (!works(options)) throw new Error("No usable sandbox!");
        return browser();
      },
      launchPersistentContext: async (_directory: string, options: LaunchOptions) => {
        launched.push(options);
        return { on: () => undefined } as unknown as BrowserContext;
      },
    } as unknown as BrowserType;
    return { wrapped, launched, confinement, load: async () => chromium };
  }

  it("runs the wrapper with the confinement's command, denying the owner's folders, and picks the strongest mode that works", async () => {
    const scratch = temp.create("tavi-confined-");
    const { wrapped, launched, confinement, load } = fakes(
      (options) =>
        !(options.args ?? []).includes("--disable-setuid-sandbox") || (options.args ?? []).includes("--disable-namespace-sandbox"),
    );
    const chosen: string[] = [];
    const confined = createConfinedChromium({
      confinement,
      denyRead: ["/home/person", "/srv/data"],
      scratchDirectory: scratch,
      modes: ["full", "seccomp", "none"],
      load,
      onMode: (mode, failures) => chosen.push(`${mode} after ${failures.map((failure) => failure.mode).join(",")}`),
    });
    const browser = await confined.launch({ headless: true, channel: "chromium", args: ["--x"] });
    expect(chosen).toEqual(["seccomp after full"]);
    expect(confined.mode()).toBe("seccomp");
    const last = launched.at(-1);
    expect(last).toMatchObject({
      headless: true,
      chromiumSandbox: true,
      args: ["--x", "--disable-setuid-sandbox", "--disable-namespace-sandbox", "--disable-dev-shm-usage"],
    });
    expect(last).not.toHaveProperty("channel");
    expect(last?.executablePath).toMatch(/bin\/confined-chromium\.mjs$/);
    expect(last?.downloadsPath?.startsWith(scratch)).toBe(true);
    const descriptor = JSON.parse(readFileSync(last?.env?.["TAVI_CONFINED_LAUNCH"] ?? "", "utf8")) as {
      command: string;
      args: string[];
      scratch: string;
    };
    expect(descriptor).toMatchObject({
      command: "/usr/bin/node",
      args: ["host-process.mjs", "--request", expect.stringMatching(/\.srt\.json$/)],
    });
    expect(wrapped.at(-1)?.policy).toMatchObject({
      denyRead: ["/home/person", "/srv/data"],
      domains: ["*"],
      allowWrite: [descriptor.scratch],
      unixSockets: [descriptor.scratch],
    });
    // What a launch made goes when its browser does.
    await browser.close();
    expect(existsSync(descriptor.scratch)).toBe(false);
    // The probe's launches and this one: nothing left of any.
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("prefers full Chromium when the nested sandbox works, falls back to the headless shell otherwise, and refuses when Playwright has none", async () => {
    const scratch = temp.create("tavi-confined-");
    const fullWorks = fakes(() => true);
    await createConfinedChromium({
      confinement: fullWorks.confinement,
      denyRead: [],
      scratchDirectory: scratch,
      modes: ["full", "none"],
      load: fullWorks.load,
    }).launch({ headless: true });
    expect(fullWorks.wrapped.at(-1)?.argv.at(-1)).toMatch(/chromium-1243\/chrome-linux-arm64\/chrome$/);
    // The operator's choice of the headless shell is kept, whatever full Chromium could do.
    const shellChosen = fakes(() => true);
    await createConfinedChromium({
      confinement: shellChosen.confinement,
      denyRead: [],
      scratchDirectory: scratch,
      modes: ["full", "none"],
      load: shellChosen.load,
      chromium: "headless-shell",
    }).launch({ headless: true });
    expect(shellChosen.wrapped.at(-1)?.argv.at(-1)).toMatch(/chrome-headless-shell$/);
    // With the shell asked for and missing, the failure says so: the shell, not the operator's choice.
    const noShell = fakes(() => true, installed(false));
    await expect(
      createConfinedChromium({
        confinement: noShell.confinement,
        denyRead: [],
        scratchDirectory: scratch,
        modes: ["full"],
        load: noShell.load,
        chromium: "headless-shell",
      }).launch({ headless: true }),
    ).rejects.toThrow(/no headless shell is installed/);

    const { wrapped, confinement, load } = fakes(() => true);
    await createConfinedChromium({ confinement, denyRead: [], scratchDirectory: scratch, modes: ["none"], load }).launch({
      headless: true,
    });
    expect(wrapped.at(-1)?.argv.at(-1)).toMatch(/chromium_headless_shell-1243\/chrome-headless-shell-linux-arm64\/chrome-headless-shell$/);

    const bare = fakes((options) => (options.args ?? []).includes("--no-sandbox"), installed(false));
    await expect(
      createConfinedChromium({
        confinement: bare.confinement,
        denyRead: [],
        scratchDirectory: scratch,
        modes: ["full", "none"],
        load: bare.load,
      }).launch({ headless: true }),
    ).rejects.toMatchObject({ code: "CAPABILITY_MISSING", message: expect.stringContaining("npx playwright install chromium") });
  });

  it("tries a mode that timed out once more before a weaker one", async () => {
    const scratch = temp.create("tavi-confined-");
    let slow = 1;
    const { confinement, load } = fakes((options) => {
      if ((options.args ?? []).includes("--no-sandbox")) return true;
      if (slow > 0) {
        slow -= 1;
        throw Object.assign(new Error("Timeout 15000ms exceeded."), { name: "TimeoutError" });
      }
      return true;
    });
    const confined = createConfinedChromium({ confinement, denyRead: [], scratchDirectory: scratch, modes: ["full", "none"], load });
    await confined.launch({ headless: true });
    expect(confined.mode()).toBe("full");
  });

  it("says why none worked when no mode starts", async () => {
    const scratch = temp.create("tavi-confined-");
    const { confinement, load } = fakes(() => false);
    await expect(
      createConfinedChromium({ confinement, denyRead: [], scratchDirectory: scratch, modes: ["full", "none"], load }).launch({
        headless: true,
      }),
    ).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("full: No usable sandbox!; none: No usable sandbox!"),
    });
  });

  it("keeps a workspace's own profile, puts the owner's Node first on the wrapper's PATH, and sweeps what a crashed run left", async () => {
    const scratch = temp.create("tavi-confined-");
    mkdirSync(join(scratch, "launch-9-stale"));
    const { wrapped, launched, confinement, load } = fakes(() => true);
    await createConfinedChromium({ confinement, denyRead: [], scratchDirectory: scratch, modes: ["none"], load }).launchPersistent(
      "/srv/data/browser-profiles/default",
      { headless: true },
    );
    expect(existsSync(join(scratch, "launch-9-stale"))).toBe(false);
    const last = launched.at(-1);
    expect(last?.env?.["PATH"]?.split(":")[0]).toBe(dirname(process.execPath));
    const descriptor = JSON.parse(readFileSync(last?.env?.["TAVI_CONFINED_LAUNCH"] ?? "", "utf8")) as { profile?: string };
    expect(descriptor.profile).toBe("/srv/data/browser-profiles/default");
    expect(wrapped.at(-1)?.policy.allowWrite).toContain("/srv/data/browser-profiles/default");
  });

  it("leaves nothing behind when a launch cannot be prepared", async () => {
    const scratch = temp.create("tavi-confined-");
    const { load } = fakes(() => true);
    const refusing: ConfinementPort = {
      wrap: () => {
        throw new Error("no sandbox here");
      },
    };
    await expect(
      createConfinedChromium({ confinement: refusing, denyRead: [], scratchDirectory: scratch, modes: ["none"], load }).launch({
        headless: true,
      }),
    ).rejects.toThrow(/no sandbox here/);
    expect(readdirSync(scratch)).toEqual([]);
  });
});
