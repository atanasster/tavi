import { expect } from "vitest";

import { askAndAllow, newChat, newestTask, toolCalls } from "../support/browser-site.js";
import { walkGuide } from "../support/walk.js";

interface Approvals {
  readonly items: readonly { readonly toolId: string; readonly state: string; readonly scope?: string }[];
}

/** A day three weeks out, as a reader would name it: far enough ahead to have fares, near enough to be listed. */
const day = (offset: number) => {
  const date = new Date(Date.now() + offset * 86_400_000);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
};

const searches = (walk: { tavi(...args: string[]): string }) =>
  toolCalls(walk.tavi, newestTask(walk.tavi)).filter((call) => call.toolName === "travel.flights_search" && call.status === "completed");

walkGuide("web-and-browser/search-flights", {
  configured: true,
  model: true,
  steps: {
    "ask-for-flights": async (walk) => {
      const page = await walk.open("/");
      await newChat(page);
      let pictured = false;
      await askAndAllow(page, `Find me flights from London to Lisbon, one way, on ${day(21)}, for one adult. Show me the three cheapest.`, {
        onCard: async (card) => {
          if (pictured) return;
          await expect(card.getByText("This chat wants to use the travel search").isVisible()).resolves.toBe(true);
          await walk.shot(card);
          pictured = true;
        },
      });
      expect(pictured, "the search was asked about first").toBe(true);
    },
    "allow-the-search": async (walk) => {
      const page = await walk.page();
      const { items } = walk.taviJson<Approvals>("approvals", "history");
      expect(items.some((item) => item.toolId === "travel.flights_search" && item.state === "granted" && item.scope === "session")).toBe(
        true,
      );
      expect(searches(walk).length).toBeGreaterThan(0);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")], frame: "answer" });
    },
    "narrow-it-down": async (walk) => {
      const page = await walk.page();
      const before = searches(walk).length;
      // Allowed for the chat: the follow-up's search asks nothing.
      const cards = await askAndAllow(page, `Only direct flights, and add a return on ${day(28)}.`);
      expect(cards).toBe(0);
      const after = searches(walk);
      expect(after.length).toBeGreaterThan(before);
      // The answer carries a search to check the fare elsewhere.
      expect(JSON.stringify(after.at(-1)?.output)).toMatch(/google\.com\/travel\/flights|kayak\./);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")], frame: "answer" });
    },
    "turn-flight-search-off-or-on": async (walk) => {
      const page = await walk.open("/settings/general");
      await page.getByRole("heading", { name: "Flight search" }).evaluate((heading) => heading.scrollIntoView({ block: "start" }));
      // The switch follows the owner: it turns off once the owner has stored the change.
      await page.getByRole("checkbox", { name: "Search flights with Kiwi.com" }).click();
      await expect.poll(() => walk.tavi("config", "get", "travel.flightSearch"), { timeout: 15_000 }).toMatch(/travel\.flightSearch = off/);
      await walk.shot();
    },
  },
});
