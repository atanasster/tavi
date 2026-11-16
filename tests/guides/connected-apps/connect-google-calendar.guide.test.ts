import { expect } from "vitest";

import {
  askInNewChat,
  completedCalls,
  dialogOf,
  discoverCard,
  firstAccount,
  googleClient,
  personSignsIn,
  waitingTools,
} from "../support/apps.js";
import { newChat } from "../support/browser-site.js";
import { allowOnce, askForApproval } from "../support/steps.js";
import { account } from "../support/user.js";
import { walkGuide } from "../support/walk.js";

const GUIDE = "connected-apps/connect-google-calendar";

walkGuide(GUIDE, {
  configured: true,
  model: true,
  timeoutMs: 1_800_000,
  steps: {
    "encrypt-your-credentials": async (walk) => {
      const screen = await walk.terminal({ title: "tavi credentials encrypt", args: ["credentials", "encrypt"] });
      expect(screen.join("\n")).toMatch(/created the key/);
    },
    "add-google-from-discover": async (walk) => {
      const page = await walk.open("/settings/apps/discover");
      const card = await discoverCard(page, "Google");
      await walk.shot(card);
      await card.getByRole("button", { name: "Add", exact: true }).click();
      await dialogOf(page).getByText("What it can do").first().waitFor();
      expect(firstAccount(walk, "gmail").receives).toBe(true);
    },
    "turn-on-its-calendar": async (walk) => {
      const page = await walk.page();
      const sheet = dialogOf(page);
      await sheet.getByLabel("Let the agent use your calendar").check();
      await sheet.getByLabel("Reach Tavi through this account").uncheck();
      await expect(sheet.getByRole("radio", { name: /^Personal/ }).isChecked()).resolves.toBe(true);
      await walk.shot(sheet);
      await sheet.getByRole("button", { name: "Next" }).click();
      await expect.poll(() => firstAccount(walk, "gmail").calendar, { timeout: 30_000 }).toBe(true);
      expect(firstAccount(walk, "gmail").receives).toBe(false);
    },
    "set-up-google": async (walk) => {
      const page = await walk.page();
      const sheet = dialogOf(page);
      // Tall enough for every console step and the box to drop the file on.
      await page.setViewportSize({ width: 1280, height: 1100 });
      await sheet.getByText("Drop the client's JSON file here").waitFor();
      await walk.shot(sheet);
      walk.needsUser("google");
      // The file holds the client's secret: the walk gives it as `tavi apps client --file` does, never through the page.
      walk.unwalked("dropping the client's file: the walk gives it with tavi apps client --file, read from the person's secrets folder");
      expect(googleClient(walk, "gmail")).toMatch(/OAuth client is saved/);
      // The sheet opened before the client was set: opened again from the account, it goes straight to the sign-in.
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });
      await page
        .locator(".apps-account")
        .getByRole("button", { name: /^(Sign in|Reconnect)$/ })
        .first()
        .click();
    },
    "sign-in-to-google": async (walk) => {
      const page = await walk.page();
      await personSignsIn(walk, page, "gmail", "Sign in to Google", GUIDE, `${account("googleEmail")}, ticking every box`);
      const sheet = dialogOf(page);
      await sheet.getByText(/^Connected Google/).waitFor({ timeout: 60_000 });
      await walk.shot(sheet);
      await page.keyboard.press("Escape");
    },
    "ask-about-your-week": async (walk) => {
      const page = await walk.open("/");
      await askInNewChat(walk, page, "What's on my calendar this week?", [/^gmail\..+\.list_events$/]);
    },
    "approve-an-event-it-adds": async (walk) => {
      const page = await walk.page();
      await newChat(page);
      // An event with nobody on it: nothing reaches anyone but the person's own calendar.
      await askForApproval(page, 'Add "Tavi test" to my calendar tomorrow at 9:00 for 15 minutes, with no guests.');
      expect(waitingTools(walk).filter((tool) => /^gmail\..+\.create_event$/.test(tool))).toHaveLength(1);
      const card = page.locator("section.round").last();
      await expect(card.textContent()).resolves.toContain("Nobody is emailed.");
      await walk.shot(card);
      await allowOnce(page);
      expect(completedCalls(walk, /^gmail\..+\.create_event$/)).toBe(1);
    },
  },
});
