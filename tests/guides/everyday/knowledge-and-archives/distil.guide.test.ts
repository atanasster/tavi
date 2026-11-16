import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { newChat } from "../../support/browser-site.js";
import { recipePrompt, sendThroughCards, shotAlone, wholeAnswer } from "../../support/recipes.js";
import { chats, dismissChecklist, lastAnswer, send } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

/** A made-up article about a made-up town: its figures are nobody's, and the walk checks the answer keeps to them. */
const ARTICLE: readonly string[] = [
  "#Fix it, don't bin it: a year of the Little Marrow repair cafe",
  "On the first Saturday of every month, the back room of the Little Marrow village hall fills with broken toasters, torn coats and bicycles with flat tyres. The repair cafe opened in March last year with six volunteers and a borrowed soldering iron. Twelve months later it has 23 volunteers, and a waiting list on most mornings.",
  "The idea is simple. You bring what is broken, you sit beside the volunteer who fixes it, and you learn how it is done. Nothing is charged for, though a jar by the door for donations took 1,140 pounds over the year, which paid for the hall and for spare parts.",
  "#What the numbers say",
  "Over the twelve sessions, volunteers looked at 612 items and mended 437 of them, a success rate of a little over 71 per cent. Small electrical goods were the largest group, at 248 items. Clothing came next with 171, then bicycles with 96. The rest was a mixed bag of clocks, toys and garden tools.",
  "Treasurer Nell Hathersage weighed each item before and after a mend. By her count the sessions kept 1.9 tonnes of goods out of the county tip, about the weight of a large car. She is careful about the claim: an item that is fixed today may still be thrown away next year, and the figure says nothing about what people bought instead.",
  "#What did not work",
  "Not everything went well. Flat-screen televisions turned out to be almost impossible to mend without parts that cost more than a new set, and the cafe stopped taking them in September. Some visitors left items and never came back, so a rule now says that anything not collected within a week goes to the charity shop.",
  "The biggest problem was the queue. In the first summer, some people waited more than two hours. Since October a booking sheet has kept the wait under 40 minutes, although Mrs Hathersage admits that the sheet has put off older visitors who do not use the internet, and a paper copy now hangs in the post office.",
  "#What comes next",
  "The parish council has offered the hall free of charge next year, and the volunteers plan a tool library alongside the cafe, lending out drills and sewing machines by the week. The aim, says Mrs Hathersage, was never only to mend things. It was to get neighbours talking to one another, and to leave each visitor a little less afraid of a screwdriver.",
];

/** The article as a two-column-free PDF: headings and paragraphs, broken into lines by hand as pdf-lib draws no text flow. */
async function article(): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const plain = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  let page = document.addPage([595, 842]);
  let y = 780;
  for (const block of ARTICLE) {
    const heading = block.startsWith("#");
    const font = heading ? bold : plain;
    const size = heading ? 14 : 11;
    const lines: string[] = [];
    for (const word of block.replace(/^#/, "").split(" ")) {
      const line = lines.at(-1);
      if (line !== undefined && font.widthOfTextAtSize(`${line} ${word}`, size) <= 483) lines[lines.length - 1] = `${line} ${word}`;
      else lines.push(word);
    }
    if (y - lines.length * (size + 5) < 56) {
      page = document.addPage([595, 842]);
      y = 780;
    }
    for (const line of lines) {
      page.drawText(line, { x: 56, y, size, font });
      y -= size + 5;
    }
    y -= 10;
  }
  return document.save();
}

/** The reader's file, made for the walk in a folder of its own. */
const directories = temporaryDirectories();
const files = directories.create("tavi-recipe-distil-");
// Deleted however the walk ends.
afterAll(() => directories.cleanup());
writeFileSync(join(files, "repair-cafe.pdf"), await article());

/** The page the last step distils: a public article, on a site the walk's owner lists. */
const LINK = "https://en.wikipedia.org/wiki/Repair_caf%C3%A9";

/** Every figure in `text` that the article does not have. */
const figuresNotInTheArticle = (text: string): string[] =>
  (text.match(/\d[\d,.]*\d|\d/g) ?? []).filter((figure) => !ARTICLE.some((block) => block.includes(figure)));

let page: Page;

walkGuide("everyday/knowledge-and-archives/distil", {
  configured: true,
  model: true,
  search: true,
  serve: ["--http-allow-host", "en.wikipedia.org"],
  steps: {
    "attach-the-article": async (walk) => {
      page = await walk.open("/");
      await dismissChecklist(page);
      await newChat(page);
      await page.locator("input[type=file]").setInputFiles(join(files, "repair-cafe.pdf"));
      await page.getByRole("list", { name: "Attached files" }).getByText("repair-cafe.pdf").waitFor();
      const prompt = recipePrompt("productivity.distil", { "link or file": "repair-cafe.pdf" });
      await page.locator(".composer-box textarea").fill(prompt);
      await shotAlone(walk, page.locator("form").last());
      await send(page, prompt);
    },
    "read-the-layers": async (walk) => {
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("pdf.read");
      const answer = (await lastAnswer(page)).locator(".markdown").last();
      const text = (await answer.textContent()) ?? "";
      expect(text).toMatch(/repair/i);
      expect(figuresNotInTheArticle(text)).toEqual([]);
      await wholeAnswer(walk, page);
    },
    "distil-a-page-from-the-web": async (walk) => {
      await sendThroughCards(page, recipePrompt("productivity.distil", { "link or file": LINK }));
      const chat = chats(walk.tavi).find((entry) => entry.chatKind !== "home");
      const history = walk.tavi("tasks", "history", chat?.taskId ?? "");
      expect(history).toContain("web_fetch");
      const answer = await (await lastAnswer(page)).locator(".markdown").last().textContent();
      expect(answer).toMatch(/Amsterdam/);
      await wholeAnswer(walk, page);
    },
  },
});
