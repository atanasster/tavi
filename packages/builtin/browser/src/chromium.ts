import { refusedEarly } from "@tavi/contracts";
import type { Browser, BrowserContext, BrowserContextOptions, BrowserType, LaunchOptions } from "playwright";

/**
 * Playwright's Chromium, loaded on first use.
 *
 * Playwright is an **optional peer** of this package: the headless closure a
 * `tavi` install resolves must not carry a browser, and npm does
 * not install an optional peer. So nothing imports it statically — a static
 * import would fail the whole CLI at load when it is absent — and the browser
 * tools and the PDF renderer reach it here, when a session or a render first
 * needs it. Absent, or installed without its Chromium, that use fails with a
 * typed `CAPABILITY_MISSING` naming the remedy (typed like the model
 * resolver's, where the sandbox adapter reports `UNAVAILABLE`).
 */

/** The codes Node raises when an imported package is not installed. */
const NOT_INSTALLED = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

/** Node names the package it could not find only in the message. */
const MISSING_PLAYWRIGHT = /Cannot find (?:package|module) '(?:playwright)'(?![-\w/])/;

/** What Playwright says when its browser binary was never downloaded. */
const MISSING_BROWSER = /Executable doesn't exist/;

export const PLAYWRIGHT_MISSING_MESSAGE =
  "browser tools and PDF report rendering need Playwright, which is not installed: install it where tavi is " +
  "installed (`npm install playwright`, or `npm install -g playwright` for a global tavi), then " +
  "`npx playwright install chromium`";

export const CHROMIUM_MISSING_MESSAGE = "Playwright is installed but its Chromium is not: run `npx playwright install chromium`";

export const HEADLESS_SHELL_MISSING_MESSAGE =
  "a confined browser without a nested sandbox runs Playwright's headless shell, which is not installed: run `npx playwright install chromium` (without --no-shell)";

/**
 * Whether `error`, or an error it wraps, is Node's "not installed" for
 * Playwright itself. A loader or a test runner may wrap the resolution error,
 * so a few levels are followed; a package Playwright needs that is missing
 * (`playwright-core`) is a broken install, not an absent one, and passes
 * through.
 */
function playwrightNotInstalled(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    const { code, message } = current as { readonly code?: unknown; readonly message?: unknown };
    if (typeof code === "string" && NOT_INSTALLED.has(code)) {
      return typeof message === "string" && MISSING_PLAYWRIGHT.test(message);
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}

/** Chromium, from an installed Playwright; `CAPABILITY_MISSING` when there is none. */
export async function loadChromium(
  importPlaywright: () => Promise<{ readonly chromium: BrowserType }> = () => import("playwright"),
): Promise<BrowserType> {
  try {
    return (await importPlaywright()).chromium;
  } catch (error) {
    if (playwrightNotInstalled(error)) {
      // Tavi's own words, wrapping nothing: a call it ends read no page, so it leaves the chat untainted.
      throw refusedEarly("CAPABILITY_MISSING", PLAYWRIGHT_MISSING_MESSAGE, { capability: "playwright" });
    }
    throw error;
  }
}

/**
 * The adapters' default `launch`: Chromium, loaded on first use. A launch that
 * finds no browser binary — Playwright installed, `npx playwright install
 * chromium` never run — is `CAPABILITY_MISSING` too, naming the one command.
 */
export async function launchChromium(options: LaunchOptions, load: () => Promise<BrowserType> = () => loadChromium()): Promise<Browser> {
  const chromium = await load();
  try {
    return await chromium.launch(options);
  } catch (error) {
    throw missingBrowser(error);
  }
}

/**
 * Chromium with a profile kept in `userDataDir` (cookies, consent choices,
 * logins), loaded on first use; a missing binary is `CAPABILITY_MISSING`, as
 * for `launchChromium`.
 */
export async function launchPersistentChromium(
  userDataDir: string,
  options: LaunchOptions & BrowserContextOptions,
  load: () => Promise<BrowserType> = () => loadChromium(),
): Promise<BrowserContext> {
  const chromium = await load();
  try {
    return await chromium.launchPersistentContext(userDataDir, options);
  } catch (error) {
    throw missingBrowser(error);
  }
}

/** A launch error, typed `CAPABILITY_MISSING` when it says the browser binary was never downloaded. */
function missingBrowser(error: unknown): unknown {
  if (error instanceof Error && MISSING_BROWSER.test(error.message)) {
    // Tavi's own words, wrapping nothing: no browser started, so no page was read and the chat stays untainted.
    return refusedEarly("CAPABILITY_MISSING", CHROMIUM_MISSING_MESSAGE, { capability: "chromium" });
  }
  return error;
}

/**
 * Whether Playwright itself resolves from here, without loading it: what a
 * `capabilities()` report can say cheaply. A resolvable but broken install
 * reads as installed; its first use says what is wrong.
 */
export function playwrightInstalled(resolve: (specifier: string) => string = (specifier) => import.meta.resolve(specifier)): boolean {
  try {
    resolve("playwright");
    return true;
  } catch {
    return false;
  }
}
