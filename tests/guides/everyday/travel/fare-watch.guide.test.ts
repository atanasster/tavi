import { expect } from "vitest";

import type { Locator, Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE, spanning } from "../../support/automation.js";
import { allowUntilAnswered, newestTask, toolCalls } from "../../support/browser-site.js";
import { footOf, promptInTheBox, readFromTheTop, recipePrompt, shotAlone } from "../../support/recipes.js";
import { lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

const PROMPT = recipePrompt("travel.fare-watch", {
  origin: "London",
  destination: "Lisbon",
  dates: "12 to 19 January 2027",
});

let page: Page;

interface Schedule {
  readonly name: string;
  readonly enabled: boolean;
  readonly spec: { readonly at?: string };
  readonly autoApproveTools: readonly string[];
}

/**
 * The lines of the answer whose flight time isn't the gap between their two clock times. London and Lisbon share a
 * clock, so the sum is plain. A line with more or fewer than two times, a flight with a stop say, isn't checked.
 */
async function wrongDurations(answer: Locator): Promise<string[]> {
  const lines = await answer
    .locator(".markdown li, .markdown tr")
    .evaluateAll((rows) => rows.filter((row) => row.querySelector("li") === null).map((row) => row.textContent ?? ""));
  return lines.filter((line) => {
    const times = [...line.matchAll(/\b(\d{1,2}):(\d{2})\b/g)].map((time) => Number(time[1]) * 60 + Number(time[2]));
    const exact = /\b(\d+)h(?:\s*(\d+)m)?\b/.exec(line);
    const rounded = /\b(\d+(?:\.\d+)?)\s*hours?\b/.exec(line);
    if (times.length !== 2 || (exact === null && rounded === null)) return false;
    const gap = ((times[1] as number) - (times[0] as number) + 24 * 60) % (24 * 60);
    if (exact !== null) return gap !== Number(exact[1]) * 60 + Number(exact[2] ?? 0);
    // "2.8 hours" is a rounded 2h 50m: it may be out by half of its last place.
    return Math.abs(gap - Number(rounded?.[1]) * 60) > 3.1;
  });
}

const schedules = (walk: { taviJson<T>(...args: string[]): T }) => walk.taviJson<readonly Schedule[]>("schedules", "list");

walkGuide("everyday/travel/fare-watch", {
  configured: true,
  model: true,
  seed: [SEED_ZONE],
  steps: {
    "ask-for-it": async (walk) => {
      page = await promptInTheBox(walk, PROMPT);
    },
    "allow-the-search": async (walk) => {
      const before = await page.getByRole("button", { name: "Copy response" }).count();
      await page.locator(".composer-box textarea").press("Enter");
      let pictured = false;
      await allowUntilAnswered(page, before, {
        onCard: async (card) => {
          if (pictured) return;
          await expect(card.textContent()).resolves.toContain("This chat wants to use the travel search");
          await shotAlone(walk, card);
          pictured = true;
        },
      });
      expect(pictured, "the search was asked about first").toBe(true);
    },
    "read-the-result": async (walk) => {
      const searches = toolCalls(walk.tavi, newestTask(walk.tavi)).filter(
        (call) => call.toolName === "travel.flights_search" && call.status === "completed",
      );
      expect(searches.length, "the flight search ran").toBeGreaterThan(0);
      expect(JSON.stringify(searches.at(-1)?.input)).toContain("2027-01");
      const answer = await lastAnswer(page);
      expect(await wrongDurations(answer), "flight times that don't match their clock times").toEqual([]);
      // Ends after a whole flight: each one's link is what the step promises.
      const foot = await footOf(answer, ".markdown > ol > li, .markdown > ul, .markdown > ul > li, .markdown table", 880);
      expect(foot, "a whole flight fits a picture").toBeGreaterThan(200);
      await readFromTheTop(walk, page, foot);
    },
    "make-it-recurring": async (walk) => {
      const message = page.locator("article").filter({ hasText: PROMPT }).first();
      await message.hover();
      await message.getByRole("button", { name: "Repeat this…" }).click();
      const dialog = page.getByRole("dialog", { name: /^Create (routine|schedule)$/ });
      await dialog.getByText("Filled in from this chat").waitFor({ timeout: 15_000 });
      await dialog.locator(".cadence-preview ol li").nth(2).waitFor();
      // The answer came from outside, so the tool is offered, not filled in: the reader adds it.
      await dialog.getByRole("button", { name: "Add tool travel.flights_search" }).click();
      await dialog.getByRole("button", { name: "Remove tool travel.flights_search" }).waitFor();
      // The form is taller than the window: a tall one shows it from the top down to the tool just added.
      await page.setViewportSize({ width: 1280, height: 2000 });
      // Adding the tool scrolled the form: back to its top, or the picture starts above the dialog.
      await dialog.getByText("Filled in from this chat").evaluate((notice) => notice.scrollIntoView({ block: "center" }));
      const span = await spanning(
        page,
        dialog.getByText("Filled in from this chat"),
        dialog.getByRole("button", { name: "Remove tool travel.flights_search" }),
      );
      await walk.shot(span.box);
      await span.remove();
      await page.setViewportSize({ width: 1280, height: 800 });
      await dialog.getByRole("button", { name: /^Save (routine|schedule)$/ }).click();
      await dialog.waitFor({ state: "detached", timeout: 120_000 });
      await expect.poll(() => schedules(walk).length, { timeout: 30_000 }).toBeGreaterThan(0);
      const [schedule] = schedules(walk);
      expect(schedule?.enabled).toBe(true);
      expect(schedule?.autoApproveTools).toContain("travel.flights_search");
      // A run nobody attends gets through the search with what was saved.
      expect(walk.tavi("schedules", "run-now", schedule?.name ?? "")).toMatch(/£\s?\d|\bfares?\b/i);
    },
  },
});
