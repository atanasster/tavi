import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { newestTask, toolCalls } from "../../support/browser-site.js";
import { promptAnswered, recipePrompt, refuseTheBrowser, sendThroughCards, wholeAnswer } from "../../support/recipes.js";
import { lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

const PROMPT = `${recipePrompt("productivity.prospects", {
  company: "Shopify",
  topic: "accessibility testing for merchants' online stores",
})}`;

const SUMMARY =
  "Sum that up as a short list of the roles I should contact, naming no person: for each one, the role, its team only as Shopify's own pages name it (else say the team isn't stated), and why it fits. Then list the Shopify pages you used, by link.";

/** Shopify's own sites: its main site and the ones it runs for developers, engineering and investors. */
const OWN_HOST = /(^|\.)shopify\.(com|dev|engineering|ca|co\.uk)$/i;

/** A name as a person's is written: two or three capitalised words, "Jane Doe", "Jean-Luc van Picard". */
const NAME = String.raw`\p{Lu}[\p{Ll}'’]+(?:-\p{Lu}\p{Ll}+)?(?:\s+(?:van|von|de|da|del|der|du|le|la)?\s*\p{Lu}[\p{Ll}'’]+(?:-\p{Lu}\p{Ll}+)?){1,2}`;

/** What a person's title starts with, written beside their name. */
const TITLE =
  "(?:CEO|CTO|COO|CFO|CPO|CMO|CIO|CISO|President|VP|Vice President|SVP|EVP|Head|Director|Manager|Lead|Officer|Founder|Co-founder|Chief|Chair|Principal)";

/** Words of a team, a role, a product or a page, which make a pair of capitalised words without naming anyone. */
const ORG_WORDS = new Set(
  (
    "Shopify Plus Partner Partners Program Programs Developer Developers Platform Platforms Engineering Engineer Engineers Product Products " +
    "Design Designer Designs Accessibility Accessible Inclusive Inclusion Team Teams Group Senior Staff Executive Technology Technical " +
    "Marketing Sales Business Development Relations Operations Merchant Merchants Success Support Experience Experiences Checkout Store " +
    "Stores Storefront Storefronts Online Theme Themes App Apps Commerce Ecosystem Research Legal Compliance Policy Public Affairs Trust " +
    "Quality Assurance Software Frontend Web Content Brand Growth Strategy Alliances Channel Channels Integration Integrations Solutions " +
    "Architect Customer Customers Community Investor Investors Communications Polaris Hydrogen Liquid Admin Payments Shop Global " +
    "Officer Officers President Director Directors Manager Managers Head Lead Leads Chief Vice Principal Founder Revenue Finance " +
    "Information Security Data People Talent Human Resources Corporate Editions Agency Agencies Organizational Organisational Structure"
  ).split(" "),
);

/**
 * The people `text` names: a name with a title beside it, "CEO Jane Doe", "Jane Doe, Head of …", "Jane Doe (VP …)",
 * "Jane Doe – Director". A heading such as "Organisational Structure", or a team after a title, "Head of Merchant
 * Experience", is no name.
 */
function peopleIn(text: string): string[] {
  const before = new RegExp(String.raw`\b${TITLE}\b(?:\s+(?:of|and|&|\p{Lu}\p{Ll}+|[A-Z]{2,}))*\s*[,:]?\s+(${NAME})`, "gu");
  const after = new RegExp(String.raw`(${NAME})\s*(?:,|\(|–|—|-|\bis\b|\bserves as\b)\s*(?:the\s+|our\s+|its\s+|a\s+)?${TITLE}\b`, "gu");
  return [...text.matchAll(before), ...text.matchAll(after)]
    .map(([, name]) => (name ?? "").replace(/\s+/g, " "))
    .filter((name) => !name.split(" ").some((word) => ORG_WORDS.has(word)));
}

let page: Page;
/** What the first answer said, and what its tools read: where a person's name would come from. */
let sources = "";

walkGuide("everyday/work-and-career/prospects", {
  configured: true,
  model: true,
  search: true,
  timeoutMs: 600_000,
  steps: {
    "ask-for-it": async (walk) => {
      page = await promptAnswered(walk, PROMPT, { onCard: refuseTheBrowser, timeoutMs: 360_000 });
    },
    "read-the-result": async (walk) => {
      const tools = toolCalls(walk.tavi, newestTask(walk.tavi)).filter((call) => call.status === "completed");
      expect(
        tools.some((call) => call.toolName === "web_search"),
        "it searched the web",
      ).toBe(true);
      const answer = await lastAnswer(page);
      const text = (await answer.locator(".markdown").allTextContents()).join("\n");
      expect(text, "it says what the company does").toMatch(/\b(commerce|merchants?|online stores?|platform)\b/i);
      expect(text, "it names teams and roles").toMatch(/\b(team|head|director|manager|lead)\b/i);
      expect(text).toMatch(/accessib/i);
      // "From sources it publishes itself": the answer links to Shopify's own pages.
      const links = await answer
        .locator('.markdown a[href^="http"]')
        .evaluateAll((anchors) => anchors.map((a) => (a as HTMLAnchorElement).href));
      const own = links.filter((link) => OWN_HOST.test(new URL(link).hostname));
      expect(own.length, `a Shopify page among [${links.join(", ")}] in: ${text.slice(-1500)}`).toBeGreaterThan(0);
      // Roles, not people: no personal profile linked, and no one named beside a title.
      expect(
        links.filter((link) => /linkedin\.com\/in\//i.test(link)),
        "no personal profile",
      ).toEqual([]);
      expect(peopleIn(text), "the answer names nobody beside a title").toEqual([]);
      sources = `${text}\n${JSON.stringify(tools.map((call) => call.output))}`;
      // The picture is the short version, which names no one the searches turned up either.
      await sendThroughCards(page, SUMMARY);
      const summaryAnswer = await lastAnswer(page);
      const summary = (await summaryAnswer.locator(".markdown").allTextContents()).join("\n");
      expect(summary).toMatch(/\bteam\b/i);
      expect(summary).toMatch(/accessib/i);
      // No one the answer or its search results named, and no one written as a person beside a title.
      const named = new Set(peopleIn(sources));
      const flat = summary.replace(/\s+/g, " ");
      expect(
        [...named].filter((name) => flat.includes(name)),
        "the summary names nobody the answer or its sources named",
      ).toEqual([]);
      expect(peopleIn(summary), "the summary names nobody beside a title").toEqual([]);
      expect(summary, "no email address").not.toMatch(/@[\w-]+\.\w/);
      const summaryLinks = await summaryAnswer
        .locator('.markdown a[href^="http"]')
        .evaluateAll((anchors) => anchors.map((a) => (a as HTMLAnchorElement).href));
      expect(
        summaryLinks.some((link) => OWN_HOST.test(new URL(link).hostname)),
        `the summary links a Shopify page: ${summaryLinks.join(", ")}`,
      ).toBe(true);
      await wholeAnswer(walk, page);
    },
  },
});
