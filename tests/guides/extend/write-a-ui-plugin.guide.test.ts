import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import type { Page } from "../../../scripts/docs/browser.mjs";
import { spanning } from "../support/automation.js";
import { fixtureSite, newChat, nextCard, sendPrompt } from "../support/browser-site.js";
import { example, plugin, pluginFolder } from "../support/extend.js";
import { walkGuide } from "../support/walk.js";

const ID = "my.browserview";
const site = fixtureSite();

interface Roles {
  readonly roles: Readonly<Record<string, string>>;
}

/** The reader's copy of the example, its manifest given their own id, name and title, as the step says. */
function copyTheExample(): string {
  const { dir } = pluginFolder("write-a-ui-plugin", "my-browser-view");
  cpSync(example("ui-plugins/minimal-browser-view"), dir, { recursive: true });
  const file = join(dir, "tavi-plugin.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as {
    id: string;
    name: string;
    ui: { contributions: { title: string }[] };
  };
  manifest.id = ID;
  manifest.name = "My browser view";
  for (const contribution of manifest.ui.contributions) contribution.title = "My browser view";
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

/** The plugin's row under Settings → Plugins → Installed. */
const row = (page: Page) => page.locator(`[id="plugin-row-${ID}"]`);

walkGuide("extend/write-a-ui-plugin", {
  configured: true,
  model: true,
  steps: {
    "copy-the-example-and-install-it": async (walk) => {
      // The owner may open the walk's made-up shop: started now, so nothing after the plugin is enabled restarts it.
      await site.open(walk.dataDir);
      const dir = copyTheExample();
      const screen = await walk.terminal({ title: "tavi plugins install", args: ["plugins", "install", dir] });
      expect(screen.join("\n")).toContain(`installed ${ID}@1.0.0 (proposed)`);
    },
    "review-what-it-receives": async (walk) => {
      const page = await walk.open("/settings/plugins");
      await row(page).getByText("awaits review", { exact: true }).waitFor();
      await expect(row(page).textContent()).resolves.toContain("receives browser.live");
      await walk.shot(row(page));
    },
    "approve-and-enable-it": async (walk) => {
      const page = await walk.page();
      await row(page)
        .getByRole("button", { name: `Approve 1.0.0 of ${ID}`, exact: true })
        .click();
      await expect.poll(() => plugin(walk, ID)?.versions[0]?.reviewState, { timeout: 15_000 }).toBe("approved");
      await row(page)
        .getByRole("button", { name: `Enable ${ID}` })
        .click();
      await expect.poll(() => plugin(walk, ID)?.enabled, { timeout: 15_000 }).toBe(true);
      await row(page)
        .getByRole("button", { name: `Disable ${ID}` })
        .waitFor();
      // It only adds to the canvas: it applies at once, so no badge asks for a restart.
      await expect(row(page).textContent()).resolves.not.toContain("loads at next start");
      await walk.shot(row(page));
    },
    "choose-it-as-the-browser-view": async (walk) => {
      const page = await walk.page();
      const canvas = page.locator(".canvas-plugins");
      await canvas.scrollIntoViewIfNeeded();
      await canvas.getByRole("combobox", { name: "Browser view", exact: true }).click();
      await page.getByRole("option", { name: ID }).click();
      const confirm = canvas.getByRole("alertdialog");
      await confirm.getByRole("button", { name: `Use ${ID}` }).waitFor();
      const span = await spanning(page, canvas.locator(".settings-fields").first(), confirm);
      await walk.shot(span.box);
      await span.remove();
      await confirm.getByRole("button", { name: `Use ${ID}` }).click();
      await expect.poll(() => walk.taviJson<Roles>("plugins", "ui", "list").roles["browser-view"], { timeout: 15_000 }).toBe(ID);
    },
    "watch-a-page-in-it": async (walk) => {
      const { origin } = await site.open(walk.dataDir);
      const page = await walk.open("/");
      await newChat(page);
      await sendPrompt(page, `Use the browser to open ${origin}/ and tell me what the shop sells.`);
      const card = await nextCard(page);
      await page.getByRole("button", { name: "Show this chat's panel" }).click();
      await card.getByRole("button", { name: "Allow for this chat" }).click();
      const panel = page.locator('aside[aria-label="this chat"]');
      const view = panel.frameLocator('iframe[title="My browser view"]').first();
      // The plugin's own page: the frame it was sent, drawn, and the page's title and address above it.
      await view.locator("img[data-frame]:not([hidden])").waitFor({ timeout: 120_000 });
      await view
        .getByText(/Harbour Lane Books/)
        .first()
        .waitFor({ timeout: 60_000 });
      await page.waitForTimeout(1_500);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "go-back-to-the-built-in-view": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi plugins ui set-role",
        args: ["plugins", "ui", "set-role", "browser-view", "builtin"],
      });
      expect(screen.join("\n")).not.toBe("");
      expect(walk.taviJson<Roles>("plugins", "ui", "list").roles["browser-view"]).not.toBe(ID);
      expect(plugin(walk, ID)?.enabled).toBe(true);
    },
  },
});
