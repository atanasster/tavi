import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { BrowserType } from "playwright";
import { describe, expect, it } from "vitest";

import {
  CHROMIUM_MISSING_MESSAGE,
  PLAYWRIGHT_MISSING_MESSAGE,
  launchChromium,
  loadChromium,
  playwrightInstalled,
} from "../src/chromium.js";
import { createPlaywrightRenderer } from "../src/render.js";

/**
 * Playwright is an optional peer: nothing may
 * import it statically, and its absence is a typed `CAPABILITY_MISSING` at the
 * first use rather than a CLI that cannot load.
 */

const notFound = (specifier: string): Error =>
  Object.assign(new Error(`Cannot find package '${specifier}' imported from /srv/node_modules/@tavi/plugin-browser/dist/chromium.mjs`), {
    code: "ERR_MODULE_NOT_FOUND",
  });

/** A Chromium whose launch fails with `error`. */
const failingChromium = (error: Error): BrowserType => ({ launch: () => Promise.reject(error) }) as unknown as BrowserType;

describe("loading Playwright on first use", () => {
  it("names the remedy when Playwright is not installed", async () => {
    await expect(loadChromium(() => Promise.reject(notFound("playwright")))).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
      message: PLAYWRIGHT_MISSING_MESSAGE,
      details: { capability: "playwright" },
    });
    // CommonJS resolution reports the same absence with its own code.
    await expect(
      loadChromium(() => Promise.reject(Object.assign(new Error("Cannot find module 'playwright'"), { code: "MODULE_NOT_FOUND" }))),
    ).rejects.toMatchObject({ code: "CAPABILITY_MISSING" });
  });

  it("recognises the absence through a loader's wrapping", async () => {
    const wrapped = new Error("the loader could not import playwright", { cause: notFound("playwright") });
    await expect(loadChromium(() => Promise.reject(wrapped))).rejects.toMatchObject({ code: "CAPABILITY_MISSING" });
  });

  it("does not call an installed but broken Playwright absent, and passes any other failure through", async () => {
    const transitive = notFound("playwright-core");
    await expect(loadChromium(() => Promise.reject(transitive))).rejects.toBe(transitive);
    const broken = new Error("playwright's own initialisation failed");
    await expect(loadChromium(() => Promise.reject(broken))).rejects.toBe(broken);
  });

  it("names the one command left when Playwright is installed without its Chromium", async () => {
    const noBinary = new Error("browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1234/chrome");
    await expect(launchChromium({ headless: true }, () => Promise.resolve(failingChromium(noBinary)))).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
      message: CHROMIUM_MISSING_MESSAGE,
      details: { capability: "chromium" },
    });
    const other = new Error("browserType.launch: Target page, context or browser has been closed");
    await expect(launchChromium({ headless: true }, () => Promise.resolve(failingChromium(other)))).rejects.toBe(other);
  });

  it("finds Chromium when Playwright is installed, as it is in this workspace", async () => {
    const chromium = await loadChromium();
    expect(typeof chromium.launch).toBe("function");
    expect(playwrightInstalled()).toBe(true);
    expect(
      playwrightInstalled(() => {
        throw notFound("playwright");
      }),
    ).toBe(false);
  });

  it("says the renderer is available here, and makes no claim for an injected launch", () => {
    expect(createPlaywrightRenderer().capabilities().available).toBe(true);
    expect(createPlaywrightRenderer({ launch: () => Promise.reject(new Error("unused")) }).capabilities().available).toBe(true);
  });

  it("is imported by no module at load time: only types come from it statically", () => {
    const source = join(import.meta.dirname, "..", "src");
    let typeImports = 0;
    for (const file of readdirSync(source).filter((name) => name.endsWith(".ts"))) {
      const text = readFileSync(join(source, file), "utf8");
      // Every statement naming the package — import or re-export, either
      // quote, with or without a semicolon, or bare for its effects.
      for (const [statement] of text.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*["']playwright["'];?|^import\s*["']playwright["'];?/gm)) {
        expect(statement, `${file}: ${statement}`).toMatch(/^import\s+type\s/);
        typeImports += 1;
      }
    }
    // chromium.ts, playwright.ts and render.ts each import Playwright's types.
    expect(typeImports).toBeGreaterThanOrEqual(3);
  });
});
