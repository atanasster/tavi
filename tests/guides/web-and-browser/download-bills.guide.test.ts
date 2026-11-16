import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import type { Locator, Page } from "../../../scripts/docs/browser.mjs";
import { chats, restartOwner } from "../support/steps.js";
import { type TestSite, testSite } from "../support/test-site.js";
import { newChat, typeSignIn } from "../support/browser-site.js";
import { walkGuide } from "../support/walk.js";

/** A one-page PDF with a few lines of text: a made-up bill. */
function pdf(lines: readonly string[]): Buffer {
  const text = `BT /F1 18 Tf 72 740 Td 26 TL ${lines.map((line) => `(${line.replace(/[()\\]/g, "\\$&")}) Tj T*`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const BILLS = [
  { file: "bill-2026-10.pdf", month: "October 2026", amount: "84.20" },
  { file: "bill-2026-09.pdf", month: "September 2026", amount: "71.65" },
];

/** A made-up energy supplier's portal on this computer: a sign-in, then a page of bills to download. */
const PORTAL = {
  name: "Riverside Energy",
  colour: "#127a6a",
  signIn: { landing: "/bills" },
  pages: {
    "/bills": {
      title: "Your bills — Riverside Energy",
      html: `<h2>Your bills</h2><table>${BILLS.map(
        (bill) => `<tr><td>${bill.month}</td><td>£${bill.amount}</td><td><a href="/bills/${bill.file}" download>Download PDF</a></td></tr>`,
      ).join("")}</table>`,
    },
    ...Object.fromEntries(
      BILLS.map((bill) => [
        `/bills/${bill.file}`,
        {
          file: pdf([
            "Riverside Energy",
            `Bill for ${bill.month}`,
            "Account RE-448120",
            `Amount due: GBP ${bill.amount}`,
            "Paid by direct debit.",
          ]),
          type: "application/pdf",
          filename: bill.file,
        },
      ]),
    ),
  },
};

let site: TestSite;
let taskId = "";

/** A visible button on the newest card of its kind, or undefined. */
async function visible(button: Locator): Promise<Locator | undefined> {
  // A card being redrawn shows its buttons disabled for a moment: only one that can be pressed counts.
  return (await button.count()) > 0 && (await button.last().isVisible()) && (await button.last().isEnabled()) ? button.last() : undefined;
}

const downloadCard = (page: Page) =>
  page.locator("section.round", { hasText: "downloads through the browser" }).getByRole("button", { name: "Allow once" });
const reviewButton = (page: Page) => page.locator("section.review").getByRole("button", { name: "Approve artifact" });

/**
 * Until `done()`: the browser cards on the way are allowed for this chat, as the guide says; a download or a review
 * stops the wait unless `pass` says to approve it too.
 */
async function until(page: Page, done: () => Promise<boolean>, pass = false): Promise<void> {
  for (const started = Date.now(); Date.now() - started < 300_000; ) {
    if (await done()) return;
    const allow = await visible(page.locator("section.round").getByRole("button", { name: "Allow for this chat" }));
    if (allow !== undefined) await allow.click({ timeout: 5_000 }).catch(() => undefined);
    if (pass) {
      for (const button of [await visible(downloadCard(page)), await visible(reviewButton(page))])
        if (button !== undefined) await button.click({ timeout: 5_000 }).catch(() => undefined);
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`the wait ran out: ${((await page.locator("main").textContent()) ?? "").slice(-1_500)}`);
}

walkGuide("web-and-browser/download-bills", {
  configured: true,
  model: true,
  steps: {
    "ask-for-your-bills": async (walk) => {
      site = await testSite(PORTAL);
      // The portal is on this computer: the browser may open it only once the owner lists it.
      await restartOwner(walk.dataDir, ["--browser-allow-host", site.host]);
      const page = await walk.open("/");
      await newChat(page);
      const composer = page.locator(".composer-box textarea");
      await composer.fill(
        `Use the browser to download my last two bills (the PDFs) from my energy supplier's portal at ${site.origin}/bills. It needs a sign-in: hand the browser to me and I'll sign in myself.`,
      );
      await composer.press("Enter");
      const round = page.locator("section.round").last();
      await round.getByRole("button", { name: "Allow for this chat" }).waitFor({ timeout: 180_000 });
      await expect(round.textContent()).resolves.toContain(`This chat wants to use the browser on ${site.host}`);
      taskId = chats(walk.tavi).find((chat) => chat.chatKind !== "home")?.taskId ?? "";
      await walk.shot(round);
      await round.getByRole("button", { name: "Allow for this chat" }).click();
    },
    "sign-in-yourself": async (walk) => {
      const page = await walk.page();
      const take = page.locator(".handoff-card").getByRole("button", { name: "Take control" });
      await until(page, async () => (await visible(take)) !== undefined);
      await take.last().click();
      await page.getByText("You're in control — Tavi is paused").waitFor({ timeout: 60_000 });
      const picture = page.locator(".takeover-page img");
      await picture.waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1_500);
      // The portal is the walk's own, and so are its made-up test username and password: a click where the page has
      // nothing to click, then Tab to the username.
      const box = await picture.boundingBox();
      await picture.click({ position: { x: 12, y: (box?.height ?? 600) - 12 } });
      await page.locator(".takeover-page").focus();
      await page.keyboard.press("Tab");
      await typeSignIn(page, site.user, site.password, () => walk.shot());
      await expect.poll(() => site.requests.includes("POST /login"), { timeout: 20_000 }).toBe(true);
      await page.getByRole("button", { name: "Done — hand back" }).click();
      await page.getByRole("button", { name: "Hand back", exact: true }).click();
      await page.getByText("You're in control — Tavi is paused").waitFor({ state: "hidden" });
    },
    "approve-each-download": async (walk) => {
      const page = await walk.page();
      await until(page, async () => (await visible(downloadCard(page))) !== undefined);
      const round = page.locator("section.round", { hasText: "downloads through the browser" }).last();
      await walk.shot(round);
      await round.getByRole("button", { name: "Allow once" }).click();
    },
    "review-the-file-before-tavi-reads-it": async (walk) => {
      const page = await walk.page();
      await until(page, async () => (await visible(reviewButton(page))) !== undefined);
      const held = walk.taviJson<readonly { readonly contentType: string; readonly reviewState: string }[]>("artifacts", "list");
      expect(held.some((artifact) => artifact.contentType === "application/pdf" && artifact.reviewState === "pending")).toBe(true);
      const card = page.locator("section.review").last();
      await walk.shot(card);
      await reviewButton(page).last().click();
    },
    "find-the-bills-in-chat-files": async (walk) => {
      const page = await walk.page();
      const downloads = join(walk.dataDir, "chats/default", taskId, "downloads");
      const answers = page.getByRole("button", { name: "Copy response" });
      // The second bill asks the same two questions: the walk answers them as it did the first.
      await until(
        page,
        async () =>
          (await answers.count()) > 0 &&
          existsSync(downloads) &&
          readdirSync(downloads).filter((name) => name.endsWith(".pdf")).length >= 2,
        true,
      );
      expect(site.requests.filter((request) => /^GET \/bills\/bill-.*\.pdf$/.test(request)).length).toBeGreaterThanOrEqual(2);
      await page
        .locator("main")
        .getByRole("button", { name: /^Chat files/ })
        .first()
        .click();
      const panel = page.locator("section.folder-panel");
      await panel.getByRole("button", { name: "Open downloads" }).click();
      await expect.poll(() => panel.locator(".folder-entry").count()).toBeGreaterThanOrEqual(2);
      await walk.shot(panel);
    },
  },
});
