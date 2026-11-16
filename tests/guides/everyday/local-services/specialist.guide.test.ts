import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE } from "../../support/automation.js";
import { newestTask, toolCalls } from "../../support/browser-site.js";
import { addThePlacesApp, promptAnswered, recipePrompt, refuseTheBrowser, sendThroughCards, wholeAnswer } from "../../support/recipes.js";
import { lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

const PROMPT = `${recipePrompt("travel.specialist", { "kind of specialist": "electrician" })} I'm in Austin, Texas. No phone numbers, please.`;

const SUMMARY =
  "Sum that up in three sentences, naming no business, address or licence number: how many of them the Texas register lists, what the register doesn't show, such as whether a licence is current, and that I should check the licence on the regulator's own site before I hire. Say listed, nothing stronger.";

/** How a count is said. */
const COUNT = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** A sentence that claims what the register doesn't say; one that says it can't tell is true. */
const claimsMore = (sentence: string): boolean =>
  /\b(active|verified|top[- ]rated|history)\b/i.test(sentence) && !/\b(not|no|cannot|never|whether|without)\b|n't\b/i.test(sentence);

let page: Page;

walkGuide("everyday/local-services/specialist", {
  configured: true,
  model: true,
  search: true,
  seed: [SEED_ZONE],
  timeoutMs: 600_000,
  steps: {
    "add-the-places-app": addThePlacesApp,
    "ask-for-it": async (walk) => {
      page = await promptAnswered(walk, PROMPT, { onCard: refuseTheBrowser, timeoutMs: 360_000 });
    },
    "read-the-result": async (walk) => {
      const tools = toolCalls(walk.tavi, newestTask(walk.tavi)).filter((call) => call.status === "completed");
      for (const tool of ["places.open.search", "places.open.verify_license"]) {
        expect(
          tools.some((call) => call.toolName === tool),
          `${tool} ran`,
        ).toBe(true);
      }
      const text = (await (await lastAnswer(page)).locator(".markdown").allTextContents()).join("\n");
      expect(text).toMatch(/licen[cs]e/i);
      // A licence number a reader may act on is one the register gave, not one the model wrote.
      const register = JSON.stringify(tools.filter((call) => call.toolName === "places.open.verify_license"));
      for (const [, number] of text.matchAll(/#\s*(\d{4,6})\b/g)) expect(register, `licence ${number}`).toContain(number);
      // The list names real businesses: the picture is the sum of it, which names none and claims no more than the register.
      await sendThroughCards(page, SUMMARY);
      const summary = (await (await lastAnswer(page)).locator(".markdown").allTextContents()).join("\n");
      const named = [...register.matchAll(/name\\*":\\*"([^"\\(]+)/g)]
        .map(([, name]) =>
          (name ?? "")
            .replace(/\s*\b(LLC|L\.L\.C|INC|LTD|CO|CORP)\b\.?\s*$/i, "")
            .trim()
            .toLowerCase(),
        )
        .filter((name) => name.includes(" "));
      expect(named.length, "the register's names were read").toBeGreaterThan(0);
      expect(named.filter((name) => summary.toLowerCase().includes(name))).toEqual([]);
      expect(summary, "no address or number").not.toMatch(/\b\d{4,6}\b|\b(St|Street|Ave|Avenue|Blvd|Rd|Road|Suite|Unit)\b/);
      expect(summary, "no firm's name").not.toMatch(/\b(LLC|Inc)\b/);
      expect(summary.split(/(?<=[.!?])\s+/).filter(claimsMore), "nothing the register doesn't say").toEqual([]);
      expect(summary).toMatch(/\blist(s|ed)\b/i);
      expect(summary, "the regulator has the last word").toMatch(
        /(check|verify|confirm|look up)[^.]*licen[cs]e[^.]*(regulator|TDLR|Licensing and Regulation)/i,
      );
      // How many it says the register lists is no more than the licences the register gave.
      const licences = new Set([...register.matchAll(/number\\*":\\*"?(\w+)/g)].map(([, number]) => number)).size;
      const said = new RegExp(`\\b(${COUNT.join("|")}|\\d+)\\b`, "i").exec(summary)?.[1]?.toLowerCase() ?? "";
      expect(said, "a count").not.toBe("");
      expect(COUNT.includes(said) ? COUNT.indexOf(said) : Number(said)).toBeLessThanOrEqual(licences);
      await wholeAnswer(walk, page);
    },
  },
});
