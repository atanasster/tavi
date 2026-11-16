import { expect } from "vitest";

import type { Locator, Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE } from "../../support/automation.js";
import { newestTask, toolCalls } from "../../support/browser-site.js";
import { addTheApp, promptAnswered, recipePrompt, sendThroughCards, shotCard, wholeAnswer } from "../../support/recipes.js";
import { lastAnswer, turnEnded } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

const TOPIC = "WebAssembly";

const PROMPT = recipePrompt("work.trend-radar", { topic: TOPIC });

const SUMMARY =
  "Sum that up in three sentences, naming no person, account, headline or link: which sources you read, and what each one's count shows for this week. Use only counts the trend tools gave you.";

const WATCH = `Watch ${TOPIC} with the Trends app and tell me when it takes off.`;

/** The Trends reads a count can come from. */
const READS = ["trends.radar.search", "trends.radar.sweep", "trends.radar.velocity", "trends.radar.compare"];

let page: Page;

const completed = (walk: { tavi(...args: string[]): string }) =>
  toolCalls(walk.tavi, newestTask(walk.tavi)).filter((call) => call.status === "completed");

const textOf = async (answer: Locator): Promise<string> => (await answer.locator(".markdown").allTextContents()).join("\n");

/** Whether `round` is a card waiting to be answered. */
const waiting = async (round: Locator): Promise<boolean> => (await round.getByRole("button", { name: "Deny…" }).count()) > 0;

walkGuide("everyday/work-and-career/trend-radar", {
  configured: true,
  model: true,
  seed: [SEED_ZONE],
  timeoutMs: 600_000,
  steps: {
    "add-the-trends-app": (walk) => addTheApp(walk, "trends", "trends.radar", 12, 140),
    "ask-for-it": async (walk) => {
      // A card here (a watch, before it was asked for) is refused: step 4 is where a topic is saved.
      page = await promptAnswered(walk, PROMPT, { timeoutMs: 360_000, quotesTheChat: true });
    },
    "read-the-result": async (walk) => {
      const tools = completed(walk);
      const reads = tools.filter((call) => READS.includes(call.toolName));
      expect(reads.length, "a Trends read ran").toBeGreaterThan(0);
      // The page says it searches the past week and the past month.
      const windows = tools.filter((call) => call.toolName === "trends.radar.search").map((call) => String(call.input?.["window"]));
      expect(windows, `the searches' windows: ${JSON.stringify(tools.map((call) => [call.toolName, call.input]))}`).toEqual(
        expect.arrayContaining(["7d", "30d"]),
      );
      const answer = await textOf(await lastAnswer(page));
      expect(answer).toMatch(/Hacker News|GDELT|Bluesky|Mastodon|arXiv/i);
      // The answer quotes headlines and posts: the picture is the sum of it, which names none.
      await sendThroughCards(page, SUMMARY);
      const summary = await textOf(await lastAnswer(page));
      const outputs = JSON.stringify(reads.map((call) => call.output));
      expect(summary).toMatch(/Hacker News|GDELT|Bluesky|Mastodon|arXiv/i);
      expect(summary).toMatch(/\bweek\b/i);
      expect(summary, "no link").not.toMatch(/https?:\/\/|www\./i);
      expect(summary, "no handle").not.toMatch(/(^|\s)@\w/);
      const titles = [...outputs.matchAll(/"title\\*":\\*"([^"\\]{24,})/g)].map(([, title]) => (title ?? "").toLowerCase());
      expect(titles.length, "the sources' items were read").toBeGreaterThan(0);
      expect(
        titles.filter((title) => summary.toLowerCase().includes(title)),
        "no headline",
      ).toEqual([]);
      // Every count it gives is one a tool returned, not one the model made up.
      const counts = [...summary.matchAll(/\b\d{1,3}(?:,\d{3})+\b|\b\d{3,}\b/g)]
        .map(([count]) => count.replace(/,/g, ""))
        .filter((count) => !/^20\d\d$/.test(count));
      expect(
        counts.filter((count) => !new RegExp(`[^\\d.]${count}[^\\d.]`).test(outputs)),
        "counts the tools gave",
      ).toEqual([]);
      // One search has no baseline: the summary says what this week shows, and calls nothing steady, flat or rising.
      expect(summary, "no trend from one search").not.toMatch(
        /\b(steady|flat|holding (?:steady|level)|speeding up|accelerat\w*|slowing|rising|declining)\b/i,
      );
      expect(summary, "no count set beside itself").not.toMatch(
        /\b(\d+)\b[^.]{0,60}\b(beside|vs\.?|versus|compared (?:with|to)|against|to)\b[^.\d]{0,30}\b\1\b/i,
      );
      await wholeAnswer(walk, page);
    },
    "make-it-recurring": async (walk) => {
      const box = page.locator(".composer-box textarea");
      await box.fill(WATCH);
      await box.press("Enter");
      await page.getByText("Needs your approval").last().waitFor({ timeout: 180_000 });
      const card = page.locator("section.round").last();
      await card.getByRole("button", { name: "Allow once" }).waitFor();
      const shown = (await card.textContent()) ?? "";
      expect(shown).toContain("trends.radar.watch");
      expect(shown).toMatch(new RegExp(TOPIC, "i"));
      await shotCard(walk, card);
      await card.getByRole("button", { name: "Allow once" }).click();
      // Until the turn ends: a further watch allowed, anything else refused.
      for (let waited = 0; waited < 180_000; waited += 1_000) {
        if (
          await page
            .locator("main .task-header")
            .getByText(/^(ready|completed)$/)
            .first()
            .isVisible()
        )
          break;
        const round = page.locator("section.round").last();
        if (await waiting(round)) {
          const name = /trends\.radar\.watch/.test((await round.textContent()) ?? "") ? "Allow once" : "Deny…";
          await round
            .getByRole("button", { name })
            .click({ timeout: 3_000 })
            .catch(() => undefined);
          if (name === "Deny…")
            await round
              .getByRole("button", { name: "Deny", exact: true })
              .click({ timeout: 3_000 })
              .catch(() => undefined);
        }
        await page.waitForTimeout(1_000);
      }
      await turnEnded(page);
      const watched = completed(walk).filter((call) => call.toolName === "trends.radar.watch");
      expect(watched.length, "trends.radar.watch ran").toBeGreaterThan(0);
      expect(JSON.stringify(watched.map((call) => call.input))).toMatch(new RegExp(TOPIC, "i"));
      const decided = walk.taviJson<{ items: readonly Record<string, unknown>[] }>("approvals", "history").items;
      expect(decided.some((item) => item["toolId"] === "trends.radar.watch" && item["state"] === "granted")).toBe(true);
    },
  },
});
