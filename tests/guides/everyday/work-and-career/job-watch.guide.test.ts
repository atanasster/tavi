import { delay } from "@tavi/test-support";
import { expect } from "vitest";

import type { Locator, Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE } from "../../support/automation.js";
import { newestTask, type ToolCall, toolCalls } from "../../support/browser-site.js";
import {
  addTheApp,
  promptAnswered,
  recipePrompt,
  refuseTheBrowser,
  sendThroughCards,
  shotAlone,
  wholeAnswer,
} from "../../support/recipes.js";
import { lastAnswer, turnEnded } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

/** A short résumé of nobody, as a reader pastes theirs under the prompt. */
const RESUME =
  "My résumé: Robin Vale, data analyst, 5 years. SQL, Python (pandas), Tableau dashboards, A/B testing and forecasting for a regional retailer. BSc Statistics.";

const PROMPT = `${recipePrompt("work.job-watch", {
  role: "data analyst",
  "location or remote": "Chicago or remote",
  salary: "$90,000 a year",
})} ${RESUME}`;

const SUMMARY =
  "Sum that up in three sentences, naming no employer or link: how many openings you found, how many state pay and clear my floor, and the best match's score with a skill it asks for that I don't list. Quote no posting's title.";

const WATCH = "Keep watching for new roles like these every day, matched against my résumé and floor.";

let page: Page;

/** The completed calls of one of the Jobs app's tools in the newest task. */
const completed = (walk: { tavi(...args: string[]): string }, tool: string): readonly ToolCall[] =>
  toolCalls(walk.tavi, newestTask(walk.tavi)).filter((call) => call.toolName === `jobs.finder.${tool}` && call.status === "completed");

/** Whether `round` is a card that asks to make a job watch. */
const asksForAWatch = async (round: Locator): Promise<boolean> =>
  /jobs\.finder\.watch|Watch for jobs/i.test((await round.textContent()) ?? "");

/** Refuses the newest card: a click that finds its buttons already gone is no failure. */
async function deny(round: Locator): Promise<void> {
  await round
    .getByRole("button", { name: "Deny…" })
    .click({ timeout: 3_000 })
    .catch(() => undefined);
  await round
    .getByRole("button", { name: "Deny", exact: true })
    .click({ timeout: 3_000 })
    .catch(() => undefined);
}

/** The employers the searches named: the summary pictured must name none of them. */
function employers(searches: readonly ToolCall[]): string[] {
  const output = JSON.stringify(searches.map((call) => call.output));
  return [
    ...new Set(
      [...output.matchAll(/company\\*":\\*"([^"\\]+)/g)]
        .map(([, name]) =>
          (name ?? "")
            .replace(/[,.]?\s*\b(LLC|L\.L\.C|Inc|Ltd|Co|Corp|GmbH)\b\.?\s*$/i, "")
            .trim()
            .toLowerCase(),
        )
        .filter((name) => name.length > 3),
    ),
  ];
}

walkGuide("everyday/work-and-career/job-watch", {
  configured: true,
  model: true,
  seed: [SEED_ZONE],
  timeoutMs: 600_000,
  steps: {
    "add-the-jobs-app": (walk) => addTheApp(walk, "jobs", "jobs.finder", 10),
    "ask-for-it": async (walk) => {
      // The watch is the last step's: one proposed early is refused, as is the browser.
      page = await promptAnswered(walk, PROMPT, {
        onCard: async (round) => ((await asksForAWatch(round)) ? deny(round) : refuseTheBrowser(round)),
        timeoutMs: 360_000,
      });
    },
    "read-the-result": async (walk) => {
      const searches = completed(walk, "search");
      expect(searches.length, "jobs.finder.search ran").toBeGreaterThan(0);
      // The search sends job words, never the résumé.
      expect(JSON.stringify(searches.map((call) => call.input))).not.toMatch(/Robin|Vale|Statistics/i);
      const matches = completed(walk, "match");
      expect(matches.length, "jobs.finder.match ranked them").toBeGreaterThan(0);
      const profile = JSON.stringify(matches.map((call) => call.input?.["profile"]));
      expect(profile, "the floor went to the matcher").toMatch(/"amount":\s*90000/);
      expect(profile, "the résumé's skills went to the matcher").toMatch(/SQL/);
      const text = (await (await lastAnswer(page)).locator(".markdown").allTextContents()).join("\n");
      expect(text).toMatch(/analyst/i);
      // The list names real employers: the picture is the sum of it, which names none.
      await sendThroughCards(page, SUMMARY);
      const summary = (await (await lastAnswer(page)).locator(".markdown").allTextContents()).join("\n");
      const named = employers(searches);
      expect(named.length, "the searches' employers were read").toBeGreaterThan(0);
      expect(named.filter((name) => summary.toLowerCase().includes(name))).toEqual([]);
      // A posting's title can carry its employer's name: the summary quotes none of the longer ones.
      const titles = [...JSON.stringify(searches.map((call) => call.output)).matchAll(/title\\*":\\*"([^"\\]{20,})/g)].map(([, title]) =>
        (title ?? "").toLowerCase(),
      );
      expect(titles.length, "the searches' titles were read").toBeGreaterThan(0);
      expect(titles.filter((title) => summary.toLowerCase().includes(title))).toEqual([]);
      expect(summary, "no quoted title").not.toMatch(/"[^"]{12,}"|“[^”]{12,}”/);
      expect(summary, "no link").not.toMatch(/https?:\/\/|www\.|\.com\b/i);
      expect(summary, "no email or phone").not.toMatch(/@|\+?\d[\d\s().-]{8,}\d/);
      expect(summary, "a count").toMatch(/\b(\d+|zero|none|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i);
      expect(summary, "the floor").toMatch(/\$?90,?000|\$90k|floor/i);
      await wholeAnswer(walk, page);
    },
    "make-it-recurring": async (walk) => {
      const answers = page.getByRole("button", { name: "Copy response" });
      const before = await answers.count();
      const box = page.locator(".composer-box textarea");
      await box.fill(WATCH);
      await box.press("Enter");
      let card: Locator | undefined;
      for (let waited = 0; card === undefined; waited += 1_000) {
        if (waited > 300_000) throw new Error("no watch was proposed");
        const round = page.locator("section.round").last();
        if ((await round.getByRole("button", { name: "Deny…" }).count()) > 0) {
          if (await asksForAWatch(round)) card = round;
          else await refuseTheBrowser(round);
        }
        await delay(1_000);
      }
      const text = (await card.textContent()) ?? "";
      expect(text, "the card shows the search").toMatch(/analyst/i);
      // Tall enough for the whole card: its buttons are what the step names.
      await page.setViewportSize({ width: 1280, height: 1400 });
      await card.getByRole("button", { name: "Allow once" }).scrollIntoViewIfNeeded();
      await shotAlone(walk, card);
      await page.setViewportSize({ width: 1280, height: 800 });
      await card.getByRole("button", { name: "Allow once" }).click();
      // A further card, a digest's schedule say, is allowed; the browser is refused.
      const over = async (): Promise<boolean> =>
        (await answers.count()) > before &&
        (await page
          .locator("main .task-header")
          .getByText(/^(ready|completed)$/)
          .first()
          .isVisible());
      for (let waited = 0; !(await over()); waited += 1_000) {
        if (waited > 240_000) throw new Error("the turn did not end");
        const round = page.locator("section.round").last();
        if ((await round.getByRole("button", { name: "Deny…" }).count()) > 0) await refuseTheBrowser(round);
        await delay(1_000);
      }
      await turnEnded(page);
      const watches = completed(walk, "watch").filter((call) => call.input?.["action"] === "create");
      expect(watches.length, "the watch was made").toBeGreaterThan(0);
      const made = watches.at(-1);
      expect(JSON.stringify(made?.input?.["criteria"]), "it matches against the floor").toMatch(/"amount":\s*90000/);
      expect(made?.input?.["cadence"] ?? 24, "once a day").toBe(24);
      expect(JSON.stringify(made?.output), "it is on, with its next run").toMatch(/nextRunAt/);
    },
  },
});
