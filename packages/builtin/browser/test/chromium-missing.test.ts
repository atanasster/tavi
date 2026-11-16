import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

/**
 * With Playwright absent (the default install: an optional peer is not
 * installed), the adapters load, say so, and their first use fails typed.
 */
vi.mock("playwright", () => {
  throw Object.assign(
    new Error("Cannot find package 'playwright' imported from /srv/node_modules/@tavi/plugin-browser/dist/chromium.mjs"),
    {
      code: "ERR_MODULE_NOT_FOUND",
    },
  );
});

const { PLAYWRIGHT_MISSING_MESSAGE } = await import("../src/chromium.js");
const { createPlaywrightBrowser } = await import("../src/playwright.js");
const { createPlaywrightRenderer } = await import("../src/render.js");

describe("the browser and render adapters without Playwright", () => {
  it("load, and fail their first use with CAPABILITY_MISSING naming the remedy", async () => {
    const missing = { code: "CAPABILITY_MISSING", message: PLAYWRIGHT_MISSING_MESSAGE, details: { capability: "playwright" } };
    await expect(createPlaywrightRenderer().renderPdf({ html: "<!doctype html><html><body>x</body></html>" })).rejects.toMatchObject(
      missing,
    );
    await expect(createPlaywrightBrowser({ stagingDirectory: tmpdir() }).createSession({ workspaceId: "default" })).rejects.toMatchObject(
      missing,
    );
  });

  it("report the renderer unavailable, naming the remedy", () => {
    // Resolution is not what the mock intercepts, so absence is given at the seam.
    expect(createPlaywrightRenderer({ playwrightInstalled: () => false }).capabilities()).toEqual({
      available: false,
      provider: "playwright",
      detail: PLAYWRIGHT_MISSING_MESSAGE,
    });
  });
});
