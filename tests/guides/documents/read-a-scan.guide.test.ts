import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument } from "@cantoo/pdf-lib";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import { root } from "../../../scripts/docs/browser.mjs";
import { homeId, send, lastAnswer, scrollResultTo } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

/**
 * A scanned letter: one page that is only a picture, with no text layer. The picture is the PDF eval's printed page
 * (a made-up school letter set in Helvetica and rendered at OCR resolution), so the walk adds no image of its own.
 */
async function scan(): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const image = await document.embedPng(readFileSync(join(root, "evals/pdf/assets/printed-scan.png")));
  document.addPage([595, 420]).drawImage(image, { x: 0, y: 0, width: 595, height: 420 });
  return document.save();
}

/** The reader's file, made for the walk in a folder of its own. */
const directories = temporaryDirectories();
const files = directories.create("tavi-docs-scan-");
// Deleted however the walk ends.
afterAll(() => directories.cleanup());
writeFileSync(join(files, "letter-scan.pdf"), await scan());

walkGuide("documents/read-a-scan", {
  configured: true,
  model: true,
  steps: {
    "attach-the-scan": async (walk) => {
      const page = await walk.open("/");
      await page.locator("input[type=file]").setInputFiles(join(files, "letter-scan.pdf"));
      await page.getByRole("list", { name: "Attached files" }).getByText("letter-scan.pdf").waitFor();
      await walk.shot(page.locator("form").last());
    },
    "ask-what-it-says": async (walk) => {
      const page = await walk.page();
      await send(page, "This is a scanned letter. What is it about? Two sentences.");
      expect(walk.tavi("tasks", "history", homeId(walk.tavi))).toContain("pdf.read");
      await page.getByText("pdf.read").first().waitFor();
      await walk.shot(undefined, { mask: [page.locator("article .text")] });
    },
    "pull-out-the-dates-and-amounts": async (walk) => {
      const page = await walk.page();
      await send(page, "List the dates, times and amounts the letter gives, as a short list.");
      const answer = await lastAnswer(page);
      // Only OCR could have found these: the page has no text layer.
      await expect(answer.textContent()).resolves.toMatch(/4 March 2026/);
      await expect(answer.textContent()).resolves.toMatch(/8:45/);
      await walk.shot(answer, { mask: [answer.locator(".text")] });
    },
    "see-what-was-read": async (walk) => {
      const page = await walk.page();
      const call = page.getByText("pdf.read", { exact: true }).first();
      await call.scrollIntoViewIfNeeded();
      await call.click();
      const opened = page.locator("details[open]").filter({ hasText: "pdf.read" }).first();
      // The call's input comes first, then its result: the page's text, and the pages OCR read.
      const result = opened.locator("pre").filter({ hasText: '"imageOnlyPages"' }).first();
      await result.getByText(/"read": \[/).waitFor();
      await result.scrollIntoViewIfNeeded();
      // The result scrolls in its box: the pages that are only a picture, and what OCR read, at its top.
      await scrollResultTo(result, '"imageOnlyPages"');
      await walk.shot(result);
    },
  },
});
