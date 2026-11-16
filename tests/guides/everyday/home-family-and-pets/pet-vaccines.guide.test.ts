import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import type { Page } from "../../../../scripts/docs/browser.mjs";
import { SEED_ZONE, inDays } from "../../support/automation.js";
import { newChat } from "../../support/browser-site.js";
import { recipePrompt, wholeAnswer, sendThroughCards, shotAlone } from "../../support/recipes.js";
import { chats, dismissChecklist, lastAnswer } from "../../support/steps.js";
import { walkGuide } from "../../support/walk.js";

interface Reminder {
  readonly text: string;
  readonly nextFireAt: string | null;
  readonly when: { readonly kind: string; readonly at?: string };
}

/** A one-page PDF of `lines`, the first a heading: made up, like everything on it. */
async function onePage(lines: readonly string[]): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const page = document.addPage([595, 842]);
  const plain = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  let y = 780;
  for (const [at, text] of lines.entries()) {
    page.drawText(text, { x: 56, y, size: at === 0 ? 16 : 11, font: at === 0 ? bold : plain });
    y -= at === 0 ? 28 : 19;
  }
  return document.save();
}

/** A vaccination's dates, each so many days from today: the record stays true to the day the walk runs. */
const LEPTOSPIROSIS = { given: inDays(-340), until: inDays(25) };
const KENNEL_COUGH = { given: inDays(-380), until: inDays(-15) };
const DISTEMPER = { given: inDays(-420), until: inDays(675) };

const RECORD = [
  "Larkfield Vets: vaccination record",
  "Patient: Biscuit, border terrier",
  "Owner: Sam Rivera",
  "",
  `DHP (distemper, hepatitis, parvovirus): given ${DISTEMPER.given}, valid until ${DISTEMPER.until}`,
  `Leptospirosis: given ${LEPTOSPIROSIS.given}, valid until ${LEPTOSPIROSIS.until}`,
  `Kennel cough: given ${KENNEL_COUGH.given}, valid until ${KENNEL_COUGH.until}`,
];

const RULES = [
  "Willow Farm Kennels: boarding rules",
  "Every dog must be vaccinated against DHP, leptospirosis and kennel cough.",
  "Each vaccination must be in date on the day the dog arrives and for its whole stay.",
  "Kennel cough must be given at least 14 days before arrival.",
  "Please bring the vet's record with you to check in.",
];

/** The reader's files, made for the walk in a folder of their own. */
const directories = temporaryDirectories();
const files = directories.create("tavi-recipe-pet-vaccines-");
// Deleted however the walk ends.
afterAll(() => directories.cleanup());
const RECORD_FILE = join(files, "biscuit-vaccine-record.pdf");
const RULES_FILE = join(files, "kennel-rules.pdf");
writeFileSync(RECORD_FILE, await onePage(RECORD));
writeFileSync(RULES_FILE, await onePage(RULES));

const PROMPT = recipePrompt("health-home.pet-vaccines", {
  file: "biscuit-vaccine-record.pdf",
  kennel: "Willow Farm Kennels in kennel-rules.pdf",
});

let page: Page;

walkGuide("everyday/home-family-and-pets/pet-vaccines", {
  configured: true,
  model: true,
  seed: [SEED_ZONE],
  steps: {
    "attach-the-record-and-the-rules": async (walk) => {
      page = await walk.open("/");
      await dismissChecklist(page);
      await newChat(page);
      await page.locator("input[type=file]").setInputFiles([RECORD_FILE, RULES_FILE]);
      const chips = page.getByRole("list", { name: "Attached files" });
      await chips.getByText("biscuit-vaccine-record.pdf").waitFor();
      await chips.getByText("kennel-rules.pdf").waitFor();
      await page.locator(".composer-box textarea").fill(PROMPT);
      await shotAlone(walk, page.locator(".composer-box").locator(".."));
    },
    "read-what-s-due": async (walk) => {
      await sendThroughCards(page, PROMPT);
      const chat = chats(walk.tavi).find((candidate) => candidate.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("pdf.read");
      const answer = await lastAnswer(page);
      const text = (await answer.locator(".markdown").allTextContents()).join("\n");
      expect(text).toMatch(/kennel cough/i);
      expect(text).toMatch(/leptospirosis/i);
      expect(text).toMatch(/expired|lapsed|out of date|overdue/i);
      await wholeAnswer(walk, page);
    },
    "check-the-reminder": async (walk) => {
      const { reminders } = walk.taviJson<{ reminders: Reminder[] }>("reminders", "list");
      const reminder = reminders.find((candidate) => /lepto/i.test(candidate.text));
      expect(reminder, "a reminder for what lapses next").toBeDefined();
      // Before it lapses, and not in the past.
      const fires = new Date(reminder?.nextFireAt ?? 0).toISOString().slice(0, 10);
      expect(fires >= inDays(0)).toBe(true);
      expect(fires <= LEPTOSPIROSIS.until).toBe(true);
      const screen = await walk.terminal({ title: "tavi reminders list", args: ["reminders", "list"] });
      expect(screen.join("\n")).toMatch(/lepto/i);
    },
  },
});
