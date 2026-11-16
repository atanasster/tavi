import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import type { Page } from "../../../scripts/docs/browser.mjs";
import { homeId } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

/** A made-up club's fillable form: four text boxes, a drop-down and a signature box. */
async function membershipForm(): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const font = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const page = document.addPage([595, 842]);
  const form = document.getForm();
  page.drawText("Riverside Swim Club: membership form", { x: 56, y: 780, size: 16, font: bold });
  let y = 730;
  const label = (text: string) => page.drawText(text, { x: 56, y: y + 6, size: 11, font });
  for (const [name, text] of [
    ["full_name", "Full name"],
    ["email", "Email"],
    ["phone", "Phone"],
    ["start_date", "Start date"],
  ] as const) {
    label(text);
    form.createTextField(name).addToPage(page, { x: 180, y, width: 300, height: 20 });
    y -= 40;
  }
  label("Membership");
  const membership = form.createDropdown("membership");
  membership.addOptions(["Adult", "Family", "Junior"]);
  membership.addToPage(page, { x: 180, y, width: 150, height: 20 });
  y -= 40;
  label("Signature");
  form.createTextField("signature").addToPage(page, { x: 180, y, width: 300, height: 20 });
  return document.save();
}

/** The reader's notes: made-up details (a reserved example.com address, an Ofcom drama number). */
const NOTES = `# Swim club sign-up

- Name: Sam Rivera
- Email: sam.rivera@example.com
- Phone: 01632 960 123
- Membership: Adult
- Start: 1 December 2026
`;

/** The reader's files, made for the walk in a folder of their own. */
const directories = temporaryDirectories();
const files = directories.create("tavi-docs-form-");
// Deleted however the walk ends.
afterAll(() => directories.cleanup());
writeFileSync(join(files, "membership-form.pdf"), await membershipForm());
writeFileSync(join(files, "notes.md"), NOTES);

/** The approval card the fill waits on. */
const card = (page: Page) => page.locator("section.round").last();

walkGuide("documents/fill-a-pdf-form", {
  configured: true,
  model: true,
  steps: {
    "attach-the-form-and-your-notes": async (walk) => {
      const page = await walk.open("/");
      await page.locator("input[type=file]").setInputFiles([join(files, "membership-form.pdf"), join(files, "notes.md")]);
      const chips = page.getByRole("list", { name: "Attached files" });
      await chips.getByText("membership-form.pdf").waitFor();
      await chips.getByText("notes.md").waitFor();
      await walk.shot(page.locator("form").last());
    },
    "ask-tavi-to-fill-it-in": async (walk) => {
      const page = await walk.page();
      const box = page.locator(".composer-box textarea");
      // The guide's words, with the source kind spelled out: the tool's schema as this model is sent it does not
      // name the kinds a source may have, so without it the model guesses one the fill refuses.
      await box.fill(
        'Fill in this form from my notes; each value is in my own words (source {"kind": "person", "quote": …}). Leave the signature for me.',
      );
      await box.press("Enter");
      await page.getByText("Needs your approval").last().waitFor({ timeout: 180_000 });
      await card(page).getByRole("button", { name: "Allow once" }).waitFor();
      const pending = walk.taviJson<{ rows: { record: { toolId: string } }[] }>("approvals", "list").rows;
      expect(pending.map((row) => row.record.toolId)).toEqual(["pdf.fill"]);
      // Nothing is written while the card waits.
      expect(existsSync(join(walk.dataDir, "chats/default", homeId(walk.tavi), "forms"))).toBe(false);
      // The card is taller than the space above the message box: a taller window shows all of it.
      await page.setViewportSize({ width: 1280, height: 1400 });
      await card(page).scrollIntoViewIfNeeded();
      await walk.shot(card(page));
    },
    "check-every-value": async (walk) => {
      const page = await walk.page();
      const table = card(page).locator(".form-fill");
      for (const field of ["Full name", "Email", "Phone", "Start date", "Membership"]) {
        await expect(table.getByRole("row").filter({ hasText: field }).getByText("verified").count()).resolves.toBe(1);
      }
      await table.getByText(/You sign or complete these yourself: Signature/).waitFor();
      await walk.shot(table);
      await page.setViewportSize({ width: 1280, height: 800 });
    },
    "allow-it-and-get-the-copy": async (walk) => {
      const page = await walk.page();
      await card(page).getByRole("button", { name: "Allow once" }).click();
      await page
        .getByRole("button", { name: /^Copy response/ })
        .first()
        .waitFor({ timeout: 180_000 });
      // A new copy in the chat's forms folder, with the values read back, and the signature still blank.
      const forms = join(walk.dataDir, "chats/default", homeId(walk.tavi), "forms");
      const copies = readdirSync(forms).filter((name) => name.endsWith("-filled.pdf"));
      expect(copies).toHaveLength(1);
      const filled = (await PDFDocument.load(readFileSync(join(forms, copies[0] as string)))).getForm();
      expect(filled.getTextField("full_name").getText()).toBe("Sam Rivera");
      expect(filled.getTextField("email").getText()).toBe("sam.rivera@example.com");
      expect(filled.getDropdown("membership").getSelected()).toEqual(["Adult"]);
      expect(filled.getTextField("signature").getText() ?? "").toBe("");
      const answer = page
        .locator("article")
        .filter({ has: page.getByRole("button", { name: /^Copy response/ }) })
        .last();
      await answer.scrollIntoViewIfNeeded();
      // The whole window: the run, with its approval card above, is taller than the window, and a crop of it cuts the header.
      await walk.shot(undefined, { mask: [answer.locator(".text")] });
    },
  },
});
