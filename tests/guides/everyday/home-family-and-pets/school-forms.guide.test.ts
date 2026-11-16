import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { inDays } from "../../support/automation.js";
import { kept, newChat, rememberFact } from "../../support/memory.js";
import { recipePrompt, shotAlone, wholeAnswer } from "../../support/recipes.js";
import { allowOnce, lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

/** A made-up school's fillable trip form: its child, its school and its farm are nobody's. */
async function tripForm(): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const font = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const page = document.addPage([595, 842]);
  const form = document.getForm();
  page.drawText("Oakfield Primary School: trip permission form", { x: 56, y: 780, size: 16, font: bold });
  page.drawText(`Class trip to Hazel Hill Farm on ${inDays(21)}.`, { x: 56, y: 755, size: 11, font });
  let y = 710;
  for (const [name, text] of [
    ["child_name", "Child's name"],
    ["class_name", "Class"],
    ["emergency_phone", "Emergency phone"],
    ["allergies", "Allergies"],
    ["parent_signature", "Parent's signature"],
  ] as const) {
    page.drawText(text, { x: 56, y: y + 6, size: 11, font });
    form.createTextField(name).addToPage(page, { x: 180, y, width: 300, height: 20 });
    y -= 40;
  }
  return document.save();
}

/** The reader's file, made for the walk in a folder of its own. */
const directories = temporaryDirectories();
const files = directories.create("tavi-recipe-school-forms-");
// Deleted however the walk ends.
afterAll(() => directories.cleanup());
const FORM = join(files, "trip-permission.pdf");
writeFileSync(FORM, await tripForm());

/** Everything about the child is invented; the number is an Ofcom drama number. */
const FACT = rememberFact("My daughter Robin", "My daughter Robin Ashdown is in class 4B. Her emergency phone number is 01632 960184.");

/** For a model that answers rather than fills: the form takes a memory record as a value's source. */
const FILL_IT =
  "Please fill it in now from your memory of my daughter Robin, giving that memory as each value's source. Leave what you don't know empty.";

const PROMPT = recipePrompt("health-home.school-forms", { file: "trip-permission.pdf" });

const card = (page: Page) => page.locator("section.round").last();

let page: Page;

walkGuide("everyday/home-family-and-pets/school-forms", {
  configured: true,
  model: true,
  steps: {
    "tell-tavi-about-your-child": async (walk) => {
      await walk.terminal({ title: "tavi memory remember", args: [...FACT] });
      expect(kept(walk).length).toBe(1);
      page = await walk.open("/");
    },
    "attach-the-form": async (walk) => {
      await newChat(page);
      await page.locator("input[type=file]").setInputFiles(FORM);
      await page.getByRole("list", { name: "Attached files" }).getByText("trip-permission.pdf").waitFor();
      await page.locator(".composer-box textarea").fill(PROMPT);
      await shotAlone(walk, page.locator(".composer-box").locator(".."));
    },
    "check-every-value": async (walk) => {
      const box = page.locator(".composer-box textarea");
      const asked = page.getByText("Needs your approval").last();
      const answers = page.getByRole("button", { name: "Copy response" });
      await box.press("Enter");
      await expect
        .poll(async () => (await asked.isVisible()) || (await answers.count()) > 0, { timeout: 180_000, interval: 1_000 })
        .toBe(true);
      if (!(await asked.isVisible())) {
        await box.fill(FILL_IT);
        await box.press("Enter");
      }
      await asked.waitFor({ timeout: 180_000 });
      await card(page).getByRole("button", { name: "Allow once" }).waitFor();
      const pending = walk.taviJson<{ rows: { record: { toolId: string } }[] }>("approvals", "list").rows;
      expect(pending.map((row) => row.record.toolId)).toContain("pdf.fill");
      await page.setViewportSize({ width: 1280, height: 1400 });
      const table = card(page).locator(".form-fill");
      await table.scrollIntoViewIfNeeded();
      await table.getByRole("row").filter({ hasText: "Robin Ashdown" }).waitFor();
      // Alone: the crop's margin would show the foot of the line above.
      await shotAlone(walk, table);
      await page.setViewportSize({ width: 1280, height: 800 });
    },
    "allow-it-and-read-what-s-missing": async (walk) => {
      await allowOnce(page);
      const forms = readdirSync(join(walk.dataDir, "chats/default"), { recursive: true, encoding: "utf8" }).filter((name) =>
        name.endsWith("-filled.pdf"),
      );
      expect(forms).toHaveLength(1);
      const filled = (await PDFDocument.load(readFileSync(join(walk.dataDir, "chats/default", forms[0] as string)))).getForm();
      expect(filled.getTextField("child_name").getText()).toBe("Robin Ashdown");
      expect(filled.getTextField("class_name").getText()).toBe("4B");
      // What it was never told stays empty, and so does the signature.
      expect(filled.getTextField("allergies").getText() ?? "").toBe("");
      expect(filled.getTextField("parent_signature").getText() ?? "").toBe("");
      const answer = await lastAnswer(page);
      const text = (await answer.locator(".markdown").allTextContents()).join("\n");
      expect(text).toMatch(/allerg/i);
      await wholeAnswer(walk, page);
    },
  },
});
