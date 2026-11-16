import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import type { Locator, Page } from "../../../../scripts/docs/browser.mjs";
import { promptAnswered, recipePrompt, wholeAnswer } from "../../support/recipes.js";
import { chats, lastAnswer, projectsFolder, restartOwner, useRealTmpdir } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

useRealTmpdir();

/** One person of the made-up tree: `[id, name, sex, born, died, family they are a child of, family they married into]`. */
type Person = readonly [id: string, name: string, sex: "M" | "F", born: string, died: string, child: string, spouse: string];

/**
 * A small made-up family, the Thistlewicks: nobody's relations, and four mistakes put in on purpose. Alder is older than
 * his father, Maren died before she was born, Juniper was born after her mother died, and Tobin married at seven, to a girl of six.
 */
const PEOPLE: readonly Person[] = [
  ["I1", "Orrin /Thistlewick/", "M", "3 MAR 1890", "12 JAN 1951", "", "F1"],
  ["I2", "Hesper /Quillby/", "F", "9 JUN 1864", "2 FEB 1921", "", "F1"],
  ["I3", "Alder /Thistlewick/", "M", "14 APR 1885", "30 OCT 1960", "F1", "F2"],
  ["I4", "Juniper /Thistlewick/", "F", "22 AUG 1924", "5 MAY 1990", "F1", ""],
  ["I5", "Maren /Dunnock/", "F", "11 NOV 1902", "7 JUL 1897", "", "F2"],
  ["I6", "Tobin /Thistlewick/", "M", "6 SEP 1910", "19 DEC 1975", "F2", "F3"],
  ["I7", "Wynn /Larkspur/", "F", "1 MAY 1912", "23 MAR 1988", "", "F3"],
  ["I8", "Bryony /Thistlewick/", "F", "17 FEB 1938", "", "F3", ""],
];
/** The families: `[id, husband, wife, children, married]`. */
const FAMILIES = [
  ["F1", "I1", "I2", ["I3", "I4"], "1 JUN 1884"],
  ["F2", "I3", "I5", ["I6"], "20 APR 1909"],
  ["F3", "I6", "I7", ["I8"], "15 JUL 1918"],
] as const;

/** The tree as a GEDCOM file, as a family-tree program exports it. */
const gedcom = (): string =>
  [
    "0 HEAD",
    "1 SOUR Made-up tree",
    "1 GEDC",
    "2 VERS 5.5.1",
    "1 CHAR UTF-8",
    ...PEOPLE.flatMap(([id, name, sex, born, died, child, spouse]) => [
      `0 @${id}@ INDI`,
      `1 NAME ${name}`,
      `1 SEX ${sex}`,
      "1 BIRT",
      `2 DATE ${born}`,
      ...(died === "" ? [] : ["1 DEAT", `2 DATE ${died}`]),
      ...(child === "" ? [] : [`1 FAMC @${child}@`]),
      ...(spouse === "" ? [] : [`1 FAMS @${spouse}@`]),
    ]),
    ...FAMILIES.flatMap(([id, husband, wife, children, married]) => [
      `0 @${id}@ FAM`,
      `1 HUSB @${husband}@`,
      `1 WIFE @${wife}@`,
      ...children.map((child) => `1 CHIL @${child}@`),
      "1 MARR",
      `2 DATE ${married}`,
    ]),
    "0 TRLR",
    "",
  ].join("\n");

/** Allows the card the script stops on, as the page says, once. */
const allowIt = (round: Locator): Promise<void> =>
  round
    .getByRole("button", { name: "Allow once" })
    .click({ timeout: 3_000 })
    .catch(() => undefined);

let page: Page;
/** The reader's folder, and the file in it. */
let tree = "";

walkGuide("everyday/knowledge-and-archives/gedcom", {
  configured: true,
  model: true,
  steps: {
    "ask-for-it": async (walk) => {
      const family = join(projectsFolder("recipe-gedcom", { "family/thistlewick.ged": gedcom() }), "family");
      tree = join(family, "thistlewick.ged");
      await restartOwner(walk.dataDir, ["--fs-root", family]);
      page = await promptAnswered(walk, recipePrompt("learning.gedcom", {}), { onCard: allowIt });
    },
    "read-the-result": async (walk) => {
      // It read the file, and found each mistake put in it, by name.
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toMatch(/fs\.read|sandbox\.run/);
      const answer = (await (await lastAnswer(page)).locator(".markdown").last().textContent()) ?? "";
      for (const name of ["Alder", "Maren", "Juniper", "Tobin"]) expect(answer).toContain(name);
      // How old the young couple were comes from the dates, and Bryony, whose dates are fine, is not among the mistakes.
      expect(answer).toMatch(/\b(7|seven)\b/);
      expect(answer).not.toMatch(/Bryony[^\n]*(impossible|before|younger|after)/i);
      // The folder is read-only: the file is as it was.
      expect(readFileSync(tree, "utf8")).toBe(gedcom());
      await wholeAnswer(walk, page);
    },
  },
});
