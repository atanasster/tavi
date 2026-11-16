import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument, rgb, StandardFonts } from "@cantoo/pdf-lib";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import { homeId, send, lastAnswer } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

/** A made-up one-page lease with a ruled fees table: nobody's real tenancy. */
async function lease(): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const font = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const page = document.addPage([595, 842]);
  let y = 780;
  const line = (text: string, size = 11, face = font) => {
    page.drawText(text, { x: 56, y, size, font: face });
    y -= size + 8;
  };
  line("Tenancy agreement: 14 Willow Lane, Flat 2", 16, bold);
  y -= 6;
  line("Landlord: Harbour Homes Ltd. Tenant: Sam Rivera.");
  line("Term: 12 months from 1 December 2026. Rent: 1,150.00 a month, due on the 1st.");
  line("Deposit: 1,327.00, held in a government-backed deposit scheme.");
  line("Notice: either party may end the tenancy with two months' notice after month six.");
  line("Pets are allowed with written consent. No smoking inside the flat.");
  y -= 10;
  line("Fees and charges", 13, bold);
  const rows = [
    ["Item", "When", "Amount"],
    ["Holding deposit", "On signing", "265.00"],
    ["Late rent", "After 14 days", "3% a year over base"],
    ["Lost key", "Per key", "45.00"],
    ["Change of tenant", "On request", "50.00"],
  ];
  const columns = [56, 236, 386, 540];
  const top = y + 4;
  rows.forEach((row, index) => {
    row.forEach((cell, column) =>
      page.drawText(cell, { x: (columns[column] as number) + 6, y: y - 12, size: 10, font: index === 0 ? bold : font }),
    );
    y -= 22;
  });
  const black = rgb(0, 0, 0);
  for (let rule = 0; rule <= rows.length; rule++) {
    page.drawLine({ start: { x: 56, y: top - rule * 22 }, end: { x: 540, y: top - rule * 22 }, thickness: 0.7, color: black });
  }
  for (const x of columns) page.drawLine({ start: { x, y: top }, end: { x, y: top - rows.length * 22 }, thickness: 0.7, color: black });
  return document.save();
}

/** The reader's file, made for the walk in a folder of its own. */
const directories = temporaryDirectories();
const files = directories.create("tavi-docs-lease-");
// Deleted however the walk ends.
afterAll(() => directories.cleanup());
writeFileSync(join(files, "lease.pdf"), await lease());

walkGuide("documents/read-a-pdf", {
  configured: true,
  model: true,
  steps: {
    "attach-the-pdf": async (walk) => {
      const page = await walk.open("/");
      await page.locator("input[type=file]").setInputFiles(join(files, "lease.pdf"));
      await page.getByRole("list", { name: "Attached files" }).getByText("lease.pdf").waitFor();
      await walk.shot(page.locator("form").last());
    },
    "ask-for-a-summary": async (walk) => {
      const page = await walk.page();
      await send(page, "Summarise this lease in three short bullets. Keep every amount exactly as the lease writes it.");
      expect(walk.tavi("tasks", "history", homeId(walk.tavi))).toContain("pdf.read");
      await page.getByText("pdf.read").first().waitFor();
      await walk.shot(undefined, { mask: [page.locator("article .text")] });
    },
    "pull-out-a-table": async (walk) => {
      const page = await walk.page();
      await send(page, "Give me the fees and charges table from the lease, as a table, and nothing else.");
      // The answer is a table, with the rows the PDF's ruled table has.
      const answer = await lastAnswer(page);
      const table = answer.locator("table");
      await table.first().waitFor();
      await expect.poll(() => table.first().locator("tr").count()).toBeGreaterThanOrEqual(5);
      // The table alone: the chat's header stays over the top of the transcript as it scrolls.
      await walk.shot(table.first());
    },
    "ask-about-one-clause": async (walk) => {
      const page = await walk.page();
      await send(page, "What does the lease say about giving notice? Quote it in one line.");
      const answer = await lastAnswer(page);
      await expect(answer.textContent()).resolves.toMatch(/notice/i);
      await walk.shot(answer, { mask: [answer.locator(".text")] });
    },
  },
});
