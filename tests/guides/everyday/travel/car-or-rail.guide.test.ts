import { expect } from "vitest";

import type { Locator, Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE } from "../../support/automation.js";
import { askAndAllow, newestTask, toolCalls } from "../../support/browser-site.js";
import { footOf, promptAnswered, readFromTheTop, recipePrompt, refuseTheBrowser, shotAlone } from "../../support/recipes.js";
import { lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

/** Well past any booking window, so that "not on sale yet" is true whichever week the walk runs in. */
const DATE = "11 March 2027";

/** Searching, models found 368 to 421 miles for the road and a straight line for the train: the reader says what they know. */
const DISTANCES = "The drive is about 370 miles: use that figure. For the train give the time, not the distance.";

const PROMPT = `${recipePrompt("travel.car-or-rail", { A: "Bristol", B: "Edinburgh", date: DATE })} ${DISTANCES}`;

/** Road, about 368 miles (Rome2rio); by the line through Birmingham, York and Newcastle, about 430, if a model gives it anyway. A straight line, 311, is neither. */
const ROAD_MILES = [340, 400] as const;
const RAIL_MILES = [395, 450] as const;

/** The longest "beyond the N weeks" the date can truly be: it is 18 weeks off, or more once the walk is run later. */
const WEEKS_AWAY = 18;

/** The first answer comes from search: the sites themselves are a follow-up, which the browser's card asks about. */
const FOLLOW_UP = "Open National Rail in the browser and check the journey time and the lowest fare for that train.";

let page: Page;

/** A further search allowed, while the browser is refused for now: the first of what its card offers. */
const allowTheSearch = (round: Locator): Promise<void> =>
  round
    .getByRole("button", { name: /^(Allow once|Allow for this chat|Allow selected; deny unchecked)$/ })
    .first()
    .click({ timeout: 3_000 })
    .catch(() => undefined);

/** Each figure of a hundred miles or more in a sentence or table cell of the answer that names `kind` and not `other`. */
async function miles(answer: Locator, kind: RegExp, other: RegExp): Promise<number[]> {
  const pieces = await answer
    .locator(".markdown")
    .last()
    .evaluate((body) =>
      [...body.querySelectorAll("p, li, td")].flatMap((block) => [...new Set((block.textContent ?? "").split(/(?<=[.;])\s+/))]),
    );
  return pieces
    .filter((piece) => kind.test(piece) && !other.test(piece))
    .flatMap((piece) => [...piece.matchAll(/(\d{3})(?:\s*[–-]\s*(\d{3}))?\+?[\s-]*(?:miles?|mi)\b/gi)])
    .flatMap((match) => [Number(match[1]), ...(match[2] === undefined ? [] : [Number(match[2])])]);
}

walkGuide("everyday/travel/car-or-rail", {
  configured: true,
  model: true,
  search: true,
  seed: [SEED_ZONE],
  timeoutMs: 20 * 60_000,
  steps: {
    "ask-for-it": async (walk) => {
      page = await promptAnswered(walk, PROMPT, {
        onCard: (round) => refuseTheBrowser(round, allowTheSearch),
        timeoutMs: 420_000,
        quotesTheChat: true,
      });
    },
    "read-the-result": async (walk) => {
      const tools = toolCalls(walk.tavi, newestTask(walk.tavi)).map((call) => call.toolName);
      expect(tools).toContain("web_search");
      await expect(page.locator("main .markdown").last().textContent()).resolves.toMatch(
        /train[\s\S]*(car|rental)|(car|rental)[\s\S]*train/i,
      );
      // A wrong distance is the page's cover for good: no retake passes on one.
      const answer = await lastAnswer(page);
      const road = await miles(answer, /\b(car|rental|drive|driving|road)\b/i, /\b(train|rail|lner|avanti)\b/i);
      const rail = await miles(answer, /\b(train|rail|lner|avanti)\b/i, /\b(car|rental|drive|driving|road)\b/i);
      expect(
        road.filter((figure) => figure < ROAD_MILES[0] || figure > ROAD_MILES[1]),
        "road miles out of range",
      ).toEqual([]);
      expect(
        rail.filter((figure) => figure < RAIL_MILES[0] || figure > RAIL_MILES[1]),
        "rail miles out of range",
      ).toEqual([]);
      // The picture ends on a whole block: what follows is the detail, and too long for one picture.
      const foot = await footOf(answer, ".markdown table, .markdown > ul", 900);
      expect(foot, "the table fits a picture").toBeGreaterThan(200);
      await readFromTheTop(walk, page, foot);
    },
    "check-a-fare-on-the-site": async (walk) => {
      let pictured = false;
      await askAndAllow(page, FOLLOW_UP, {
        timeoutMs: 480_000,
        onCard: async (card) => {
          if (pictured) return;
          await page.setViewportSize({ width: 1280, height: 1300 });
          await shotAlone(walk, card);
          await page.setViewportSize({ width: 1280, height: 800 });
          pictured = true;
        },
      });
      expect(pictured, "a site was asked about first").toBe(true);
    },
    "read-what-the-site-says": async (walk) => {
      const tools = toolCalls(walk.tavi, newestTask(walk.tavi)).map((call) => call.toolName);
      expect(
        tools.some((tool) => tool.startsWith("browser.")),
        "a site was opened",
      ).toBe(true);
      const answer = await lastAnswer(page);
      const text = (await answer.locator(".markdown").allTextContents()).join("\n");
      // A failed step here is allowed: the site's planner often refuses a date this far off, and the page says so.
      const beyond = [...text.matchAll(/beyond[^.]*?(\d+)(?:\s*[–-]\s*(\d+))?[\s-]*weeks?/gi)].flatMap((match) => [
        Number(match[1]),
        Number(match[2] ?? match[1]),
      ]);
      expect(
        beyond.every((weeks) => weeks < WEEKS_AWAY),
        `a booking window the date is beyond: ${text}`,
      ).toBe(true);
      const foot = await footOf(answer, ".markdown > ul, .markdown > ol > li, .markdown > p, .markdown table", 800);
      expect(foot, "a whole block fits a picture").toBeGreaterThan(200);
      await readFromTheTop(walk, page, foot);
    },
  },
});
