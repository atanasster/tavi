import { join } from "node:path";

import { expect } from "vitest";

import { root, type Locator, type Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE } from "../../support/automation.js";
import { newestTask, toolCalls } from "../../support/browser-site.js";
import { promptSent, recipePrompt, refuseTheBrowser, shotCard, wholeAnswer } from "../../support/recipes.js";
import { lastAnswer, restartOwner, send, turnEnded } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

const PROMPT = `${recipePrompt("health-home.in-network", { "kind of provider": "family doctors", "insurance plan": "Humana Gold Plus plan" })} My ZIP code is 78704.`;

const SUMMARY =
  "Sum that up in three sentences, naming nobody: how many were listed under a network with my plan's name, saying that this is only a match by name and doesn't confirm I'm covered, what you could not find out, and what I should check with Humana before I book.";

let page: Page;

/** Takes the providers' numbers off the card: each is a real person's, so the picture leaves those lines out and keeps the rest. */
async function withoutTheNumbers(card: Locator): Promise<void> {
  const left = await card.evaluate((element) => {
    const numbered = () =>
      [...element.querySelectorAll<HTMLElement>("*")].filter(
        (part) => part.children.length === 0 && part.checkVisibility() && /\b\d{10}\b/.test(part.textContent ?? ""),
      );
    for (const part of numbered()) (part.closest<HTMLElement>("p, pre, tr, .arg-origins li") ?? part).style.display = "none";
    return numbered().length;
  });
  expect(left, "no provider's number shows").toBe(0);
}

walkGuide("everyday/local-services/in-network", {
  configured: true,
  model: true,
  search: true,
  seed: [SEED_ZONE],
  timeoutMs: 840_000,
  steps: {
    "add-the-care-app": async (walk) => {
      walk.tavi("plugins", "install", join(root, "packages/external/places-care/dist-plugin"));
      walk.tavi("plugins", "approve", "places.care", "0.1.0");
      walk.tavi("plugins", "enable", "places.care");
      const screen = await walk.terminal({ title: "tavi plugins show places.care", args: ["plugins", "show", "places.care"], lines: 11 });
      expect(screen.join("\n")).toMatch(/state: enabled/);
      await restartOwner(walk.dataDir, []);
    },
    "ask-for-it": async (walk) => {
      page = await promptSent(walk, PROMPT);
    },
    "allow-the-network-check": async (walk) => {
      const answers = page.getByRole("button", { name: "Copy response" });
      let shown = false;
      await expect
        .poll(
          async () => {
            const round = page.locator("section.round").last();
            if ((await round.getByRole("button", { name: "Deny…" }).count()) > 0) {
              if (!shown && /Check a plan's network|in_network/.test((await round.textContent()) ?? "")) {
                await withoutTheNumbers(round);
                await shotCard(walk, round);
                shown = true;
              }
              await refuseTheBrowser(round);
            }
            return (await answers.count()) > 0;
          },
          { timeout: 420_000, interval: 1_000 },
        )
        .toBe(true);
      await turnEnded(page);
      expect(shown, "the network check asked first").toBe(true);
    },
    "read-the-result": async (walk) => {
      const tools = toolCalls(walk.tavi, newestTask(walk.tavi)).filter((call) => call.status === "completed");
      for (const tool of ["places.care.providers", "places.care.in_network"]) {
        expect(
          tools.some((call) => call.toolName === tool),
          `${tool} ran`,
        ).toBe(true);
      }
      // The list names real doctors: the picture is the sum of it, which names nobody.
      const inNetwork = tools.filter((call) => call.toolName === "places.care.in_network");
      const listed = JSON.stringify(inNetwork.map((call) => call.output)).match(/"status":"listed"/g)?.length ?? 0;
      await send(page, SUMMARY);
      const text = (await (await lastAnswer(page)).locator(".markdown").allTextContents()).join("\n");
      expect(text).toMatch(/Humana/);
      const said = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][listed] ?? String(listed);
      expect(text.toLowerCase(), "the count is the directory's").toMatch(new RegExp(`\\b(${said}|${listed})\\b`));
      // "Listed" is a match by name and no more, and the answer says so: only Humana confirms it.
      const byName = text.split(/(?<=[.!?])\s+/).filter((sentence) => /\bnames?\b/i.test(sentence));
      expect(
        byName.some((sentence) => /\b(only|just|merely|simply|alone)\b|(n't|not) (confirm|prove|mean)/i.test(sentence)),
        "the answer says a listing is only a match by name",
      ).toBe(true);
      expect(text, "no claim that the directory lists them for the plan").not.toMatch(/listed in the Humana directory for your/i);
      expect(text).toMatch(/(call|ask|check|confirm|contact)[^.]*(Humana|insurer)/i);
      expect(text, "no one's name or number").not.toMatch(/\bDr\b|\b\d{10}\b|\d{3}[ .-]\d{3}[ .-]\d{4}/);
      await wholeAnswer(walk, page);
    },
  },
});
