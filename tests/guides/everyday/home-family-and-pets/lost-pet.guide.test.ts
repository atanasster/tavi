import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { footOf, promptAnswered, readFromTheTop, recipePrompt } from "../../support/recipes.js";
import { chats, lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

const PROMPT = recipePrompt("health-home.lost-pet", { pet: "ginger cat, Marmalade,", area: "Headingley in Leeds" });

let page: Page;

walkGuide("everyday/home-family-and-pets/lost-pet", {
  configured: true,
  model: true,
  search: true,
  steps: {
    "ask-for-it": async (walk) => {
      page = await promptAnswered(walk, PROMPT);
    },
    "read-the-post-and-the-shelters": async (walk) => {
      const chat = chats(walk.tavi).find((candidate) => candidate.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("web_search");
      const answer = await lastAnswer(page);
      const text = (await answer.locator(".markdown").allTextContents()).join("\n");
      expect(text).toMatch(/Marmalade/);
      expect(text).toMatch(/Headingley/);
      expect(text).toMatch(/shelter|rescue|cats protection|rspca/i);
      // A search of public pages isn't a check of a shelter's records, and the answer mustn't report one.
      expect(text).not.toMatch(
        /\bwere checked\b|\bshows? no\b[^.\n]*\bintake\b|\bno\b[^.\n]*\bintake\b[^.\n]*\b(?:found|recorded|reported|shown)\b/i,
      );
      // The picture stops before the first phone number or email, whatever order the answer takes: a contact in it comes
      // from the model reading search results and can be wrong, and a page keeps it for good.
      const contact = await answer.evaluate((element) => {
        const blocks = [...element.querySelectorAll(".markdown p, .markdown li, .markdown tr")];
        const first = blocks.find((block) => /\b0\d{3}|\b\d{3}[\s-]\d{3}|\S@\S/.test(block.textContent ?? ""));
        return first === undefined ? 880 : first.getBoundingClientRect().top - element.getBoundingClientRect().top - 8;
      });
      const height = await footOf(answer, ".markdown > p, .markdown > ul, .markdown > ol", Math.min(contact, 880));
      expect(height, "a whole block of the answer fits above any contact").toBeGreaterThan(200);
      await readFromTheTop(walk, page, height);
    },
  },
});
