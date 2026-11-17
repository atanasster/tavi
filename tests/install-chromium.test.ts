import { describe, expect, it } from "vitest";

// @ts-expect-error -- a plain .mjs script with no declaration file.
import { INSTALL_LATER, playwrightCli, skipReason } from "../scripts/install-chromium.mjs";

/**
 * `pnpm install` installs the browser's Chromium (the root `postinstall`), so a
 * Playwright update brings the Chromium it wants (Mac mini tests: one had left
 * the browser without, and no chat was offered it).
 */
describe("install-chromium", () => {
  it("installs by default, and is skipped in CI or when asked", () => {
    expect(skipReason({})).toBeUndefined();
    expect(skipReason({ CI: "false", TAVI_SKIP_CHROMIUM: "0" })).toBeUndefined();
    expect(skipReason({ CI: "true" })).toContain("CI");
    expect(skipReason({ TAVI_SKIP_CHROMIUM: "1" })).toContain("TAVI_SKIP_CHROMIUM");
    expect(skipReason({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" })).toContain("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD");
  });

  it("finds the browser plugin's Playwright in the checkout", () => {
    expect(playwrightCli(process.cwd())).toMatch(/playwright[\\/]cli\.js$/);
    expect(INSTALL_LATER).toContain("playwright install chromium");
  });

  it("is what pnpm install runs", async () => {
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["postinstall"]).toBe("node ./scripts/install-chromium.mjs");
  });
});
