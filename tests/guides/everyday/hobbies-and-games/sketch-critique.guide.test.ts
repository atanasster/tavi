import { join } from "node:path";

import { expect } from "vitest";

import { root } from "../../../../scripts/docs/browser.mjs";
import type { Page } from "../../../../scripts/docs/browser.mjs";
import { newChat } from "../../support/browser-site.js";
import { footOf, readFromTheTop, recipePrompt, shotAlone, wholeAnswer } from "../../support/recipes.js";
import { chats, dismissChecklist, lastAnswer, send } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

/** A learner's line drawing, generated: a figure and a crate on a tiled floor, saved as a GIF. Nobody's work. */
const drawing = join(root, "tests/guides/everyday/hobbies-and-games/fixtures/figure-and-crate.gif");

let page: Page;

walkGuide("everyday/hobbies-and-games/sketch-critique", {
  configured: true,
  model: true,
  steps: {
    "ask-for-it": async (walk) => {
      const prompt = recipePrompt("learning.sketch-critique", {});
      page = await walk.open("/");
      await dismissChecklist(page);
      await newChat(page);
      await page.locator("input[type=file]").setInputFiles(drawing);
      await page.getByRole("list", { name: "Attached files" }).getByText("figure-and-crate.gif").waitFor();
      await page.locator(".composer-box textarea").fill(prompt);
      await shotAlone(walk, page.locator("form").last());
      await send(page, prompt);
    },
    "say-what-you-were-aiming-for": async (walk) => {
      // It looked at the picture, and asks before it judges.
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("artifacts.view_image");
      const answer = await lastAnswer(page);
      const text = (await answer.locator(".markdown").last().textContent()) ?? "";
      expect(text).toContain("?");
      expect(text).toMatch(/aim|going for|goal|trying/i);
      // It may go straight on to a first critique: a long answer is pictured down to the end of a section.
      const foot = await footOf(answer, ".markdown > ul", 860);
      if (foot > 300) await readFromTheTop(walk, page, foot);
      else await wholeAnswer(walk, page);
    },
    "read-the-critique": async (walk) => {
      await send(
        page,
        "A figure standing beside a crate on a tiled floor. I'm practising proportion, and I want the crate to feel solid and sit on the floor.",
      );
      const text = (await (await lastAnswer(page)).textContent()) ?? "";
      expect(text).toMatch(/anatomy|proportion/i);
      expect(text).toMatch(/perspective/i);
      expect(text).toMatch(/value/i);
      // The notes are about this drawing.
      expect(text).toMatch(/crate/i);
      expect(text).toMatch(/\b(arms?|head|legs?)\b/i);
      await wholeAnswer(walk, page);
    },
  },
});
