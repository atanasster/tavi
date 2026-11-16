import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { askForIt, recipePrompt, wholeAnswer } from "../../support/recipes.js";
import { chats, lastAnswer, restartOwner, useRealTmpdir } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

useRealTmpdir();

/** A made-up novella with four planted slips: a surname, a year, a headland and a rule of its world. */
const CHAPTERS = {
  "chapter-1.md": [
    "# Chapter 1: The harbour fire",
    "",
    "Captain Ansel Reed had not slept since the harbour fire of the year 412, when half of Graywick burned.",
    "He climbed the path to the lighthouse on the north headland, where Mira Voss kept the salt lanterns.",
    '"A salt lantern lights only for someone born at sea," she told him, as she told every visitor. "No one else can wake it."',
    "Reed, born on a herring boat, touched the glass, and it woke blue under his hand.",
    "",
  ],
  "chapter-2.md": [
    "# Chapter 2: The ledger",
    "",
    "Mira walked down from the lighthouse on the south headland with the ledger under her arm.",
    "Tobin Hale, the baker's boy, met her at the quay. He had lived his whole life in Graywick and had never set foot on a boat.",
    '"The captain wants the names of everyone who drowned," she said. "He thinks the fire was set."',
    "They read until the tide turned, and Tobin found the page torn out.",
    "",
  ],
  "chapter-3.md": [
    "# Chapter 3: The dark quay",
    "",
    "Thirty years had not been enough to forget the fire of 409, Captain Ansel Rook thought, and yet the town had tried.",
    "The wind blew the lamps out along the quay. Tobin lifted a salt lantern from its hook, breathed on the glass, and it woke blue in his hands.",
    '"Who taught you that?" Mira said. Tobin only shrugged, and led them on into the dark.',
    "",
  ],
} as const;

/** The reader's manuscript, made for the walk in a folder of its own. */
const directories = temporaryDirectories();
// Deleted however the walk ends.
afterAll(() => directories.cleanup());
const manuscript = join(directories.create("tavi-recipe-canon-audit-"), "salt-lantern");
mkdirSync(manuscript);
for (const [name, lines] of Object.entries(CHAPTERS)) writeFileSync(join(manuscript, name), lines.join("\n"));

let page: Page;

walkGuide("everyday/hobbies-and-games/canon-audit", {
  configured: true,
  model: true,
  steps: {
    "ask-for-it": async (walk) => {
      await restartOwner(walk.dataDir, ["--fs-root", manuscript]);
      page = await askForIt(walk, recipePrompt("learning.canon-audit", {}));
    },
    "read-the-list": async (walk) => {
      // It read the chapters, and found each slip planted in them: the list names both sides.
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("fs.read");
      const text = (await (await lastAnswer(page)).textContent()) ?? "";
      expect(text).toMatch(/Rook/);
      expect(text).toMatch(/Reed/);
      expect(text).toMatch(/409/);
      expect(text).toMatch(/412/);
      expect(text).toMatch(/north/i);
      expect(text).toMatch(/south/i);
      expect(text).toMatch(/born at sea|sea-born|born on|never set foot/i);
      await wholeAnswer(walk, page);
    },
  },
});
