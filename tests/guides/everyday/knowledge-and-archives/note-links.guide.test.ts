import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { promptAnswered, recipePrompt, wholeAnswer } from "../../support/recipes.js";
import { chats, lastAnswer, projectsFolder, restartOwner, useRealTmpdir } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

useRealTmpdir();

/** A small notes folder, written for the guide: bread, compost and a bicycle. None of them links to another yet. */
const NOTES: Readonly<Record<string, string>> = {
  "sourdough-starter.md":
    "# Sourdough starter\n\nFeed it equal weights of flour and water every day. It's ready when it doubles in six hours.\nThe jar lives on the shelf over the radiator.\n",
  "bread-hydration.md":
    "# Bread hydration\n\nHydration is the weight of water over the weight of flour. At 70 per cent a dough is sticky but easy to shape; at 80 per cent it needs a stiff scraper.\nA wet starter counts towards both weights.\n",
  "compost-bin.md":
    "# Compost bin\n\nLayer kitchen scraps with torn cardboard, and keep it as damp as a wrung-out sponge. Turn it every month.\nCoffee grounds go in by the cupful, not the bucket.\n",
  "tomato-seedlings.md":
    "# Tomato seedlings\n\nSow indoors in March, and pot on when the second leaves show. Plant out after the last frost, into beds dug through with well-rotted compost.\n",
  "coffee-grinder.md":
    "# Coffee grinder\n\nGrind number 18 for the filter jug and 8 for the moka pot. Empty the spent grounds every morning before they go mouldy.\n",
  "bike-chain.md": "# Bike chain\n\nWipe the chain after wet rides and oil it every 200 km. Replace it when the wear gauge reads 0.75.\n",
};

let page: Page;
let notes = "";

walkGuide("everyday/knowledge-and-archives/note-links", {
  configured: true,
  model: true,
  steps: {
    "ask-for-it": async (walk) => {
      const files = Object.fromEntries(Object.entries(NOTES).map(([name, text]) => [`notes/${name}`, text]));
      notes = join(projectsFolder("recipe-note-links", files), "notes");
      await restartOwner(walk.dataDir, ["--fs-root", notes]);
      page = await promptAnswered(walk, recipePrompt("productivity.note-links", {}), {
        // The page says nothing stops on a card.
        onCard: () => Promise.reject(new Error("reading the notes stopped on a card")),
      });
    },
    "read-the-suggestions": async (walk) => {
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("fs.read");
      const answer = (await (await lastAnswer(page)).locator(".markdown").last().textContent()) ?? "";
      // The links the notes call for, and only notes that are there.
      for (const topic of [/sourdough/i, /hydration/i, /compost/i, /tomato/i, /coffee/i]) expect(answer).toMatch(topic);
      const named = [...answer.matchAll(/\[\[([^\]|]+)|([\w-]+)\.md/g)].map((match) => `${match[1] ?? match[2] ?? ""}.md`);
      expect(named.filter((name) => NOTES[name] === undefined)).toEqual([]);
      // The folder is read-only: every note is as it was.
      for (const [name, text] of Object.entries(NOTES)) expect(readFileSync(join(notes, name), "utf8")).toBe(text);
      await wholeAnswer(walk, page);
    },
  },
});
