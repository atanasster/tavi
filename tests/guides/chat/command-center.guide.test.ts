import { expect } from "vitest";

import type { Page } from "../../../scripts/docs/browser.mjs";
import { leaveWaiting } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Needs {
  readonly needs: readonly { readonly kind: string }[];
}

/** Opens a Command Center section from its list, as the reader does. */
async function section(page: Page, name: string, path: string): Promise<void> {
  await page.locator(".center-nav-item", { hasText: name }).click();
  await page.waitForURL(new RegExp(`/center/${path}$`));
  await page.waitForLoadState("networkidle");
}

/** A to-do due ten days from the walk, so the Schedule always shows it ahead. */
const DUE = new Date(Date.now() + 10 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);

walkGuide("chat/command-center", {
  configured: true,
  model: true,
  // A few days' worth of Tavi: reminders, a schedule, to-dos, a memory, the heartbeat and one finished chat.
  seed: [
    ["config", "set", "operator.name", "Alex"],
    ["reminders", "add", "Take the bins out", "--repeat", "19:30"],
    [
      "schedules",
      "add",
      "--name",
      "morning-news",
      "--at",
      "07:00",
      "--timezone",
      "Europe/London",
      "--prompt",
      "Summarise the three most important tech headlines for me.",
      "--deliver-to",
      "home",
    ],
    ["todos", "add", "Renew the car insurance", "--due", DUE],
    ["memory", "remember", "--body", "I am vegetarian and allergic to peanuts."],
    ["heartbeat", "on"],
    ["run", "In one sentence, what is a good way to start a Monday?"],
  ],
  steps: {
    "open-the-command-center": async (walk) => {
      // A chat that asks a question and waits, so something is waiting on you.
      leaveWaiting(
        walk.tavi,
        "Plan a dinner for Saturday. Before anything else, ask me with a question whether I want Italian, Thai or Mexican food.",
      );
      expect(walk.taviJson<Needs>("needs").needs.map((need) => need.kind)).toEqual(["question"]);
      const page = await walk.open("/");
      await page
        .getByRole("navigation", { name: "pages" })
        .getByRole("button", { name: /^Center/ })
        .click();
      await page.waitForURL(/\/center(\/activity)?$/);
      await page.getByRole("heading", { name: "Activity", exact: true }).waitFor();
      await page.getByText("Plan a dinner for Saturday", { exact: false }).first().waitFor();
      await walk.shot();
    },
    "see-what-is-waiting-on-you": async (walk) => {
      const page = await walk.page();
      await section(page, "Approvals", "approvals");
      await page.locator("li.center-card-question").first().waitFor();
      await walk.shot();
    },
    "check-what-is-coming-up": async (walk) => {
      const page = await walk.page();
      await section(page, "Schedule", "schedule");
      await page.getByText("morning-news").first().waitFor();
      await page.getByText("Take the bins out").first().waitFor();
      await walk.shot();
    },
    "look-at-the-heartbeat": async (walk) => {
      const page = await walk.page();
      await section(page, "Heartbeat", "heartbeat");
      await page.getByText("What should I keep an eye on?").waitFor();
      await walk.shot();
    },
    "read-tavi-s-soul-and-memory": async (walk) => {
      const page = await walk.page();
      await section(page, "Soul & memory", "identity");
      await page.getByText("I am vegetarian and allergic to peanuts.").waitFor();
      await walk.shot();
    },
    "see-what-the-browser-visited": async (walk) => {
      const page = await walk.page();
      await section(page, "Browser", "browser");
      await page.getByText("Nothing browsed in the last 30 days.").waitFor();
      await walk.shot();
    },
  },
});
