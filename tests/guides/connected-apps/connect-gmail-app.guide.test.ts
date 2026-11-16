import { expect } from "vitest";

import { askInNewChat, completedCalls, dialogOf, firstAccount, googleAccountSignedIn, signedIn, signInAddress } from "../support/apps.js";
import { newestTask, nextCard } from "../support/browser-site.js";
import { denyCard } from "../support/recipes.js";
import { turnEnded } from "../support/steps.js";
import { account, askUser, hidePersonal } from "../support/user.js";
import { walkGuide } from "../support/walk.js";

const GUIDE = "connected-apps/connect-gmail-app";

/** The account's mailbox access, as Connected apps has it. */
const mailbox = (walk: Parameters<typeof firstAccount>[0]) => firstAccount(walk, "gmail").mailbox;

walkGuide(GUIDE, {
  configured: true,
  model: true,
  timeoutMs: 1_800_000,
  steps: {
    "let-the-agent-read-your-mailbox": async (walk) => {
      // Before you start: a Google account added and signed in, as Connect Google Calendar leaves it.
      walk.needsUser("google");
      await googleAccountSignedIn(walk, GUIDE, `${account("googleEmail")}, ticking every box`);
      expect(signedIn(walk, "gmail")).toBe(true);
      const page = await walk.open("/settings/apps/gmail");
      await page.locator(".apps-account").getByLabel("Let the agent read and draft in this mailbox").click();
      await expect.poll(() => mailbox(walk), { timeout: 30_000 }).toBe("read");
      // Signed in for the calendar alone, the account now asks for Gmail's access.
      await expect.poll(() => firstAccount(walk, "gmail").health, { timeout: 30_000 }).toBe("needs-access");
      await walk.shot(page.locator(".apps-account").first());
    },
    "sign-in-again-for-gmail": async (walk) => {
      const page = await walk.open("/settings/apps/gmail");
      // Reconnect opens the connect sheet at its sign-in; its button opens Google's page.
      await page
        .locator(".apps-account")
        .getByRole("button", { name: /^(Reconnect|Sign in)$/ })
        .first()
        .click();
      const sheet = dialogOf(page);
      const address = await signInAddress(page, sheet.getByRole("button", { name: "Sign in to Google" }));
      await askUser(
        GUIDE,
        `open this address in your own browser on this Mac and sign in as ${account("googleEmail")}, ticking every box, Gmail's included: ${address}`,
        () => firstAccount(walk, "gmail").health === "ready",
      );
      await sheet.getByText(/^Connected Google/).waitFor({ timeout: 60_000 });
      await page.keyboard.press("Escape");
      await walk.open("/settings/apps/gmail");
      await walk.shot(page.locator(".apps-account").first());
    },
    "ask-about-a-message": async (walk) => {
      const page = await walk.open("/");
      // The person sent themselves this message beforehand: the search names it, and nothing else of theirs is asked for.
      await askInNewChat(walk, page, 'Find my email with the subject "Tavi guide test" and tell me what it says.', [
        /^gmail\..+\.search$/,
        /^gmail\..+\.read$/,
      ]);
    },
    "send-a-reply-you-approve": async (walk) => {
      const chat = newestTask(walk.tavi);
      const settings = await walk.open("/settings/apps/gmail");
      await settings.locator(".apps-account").getByLabel("Send drafts I approve (each one asks, showing it whole)").click();
      await expect.poll(() => mailbox(walk), { timeout: 30_000 }).toBe("send");
      const page = await walk.open(`/tasks/${chat}`);
      const box = page.locator(".composer-box textarea");
      // Its sender may be another of the person's addresses: the reply names the account's own, the only one it goes to.
      await box.fill(`Reply to that email, to ${account("googleEmail")} only, saying "Got it."`);
      await box.press("Enter");
      // A draft may be asked about first; the send's card is the step's picture.
      for (let cards = 0; cards < 4; cards++) {
        const card = await nextCard(page);
        const sends = /send_draft/.test((await card.textContent()) ?? "");
        if (sends) {
          // Nothing goes to anyone but the person: every address the card names is their own, or it is never allowed.
          const addresses = (text: string): Set<string> =>
            new Set((text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).map((each) => each.toLowerCase()));
          // The draft whole is on the card: its recipients are its To and Cc lines.
          // biome-ignore lint/performance/useDomNodeTextContent: Playwright's innerText keeps the card's line breaks, which part its lines and addresses.
          const draft = await card.locator(".call-readback").innerText();
          const recipients = addresses(
            draft
              .split("\n")
              .filter((line) => /^(To|Cc):/.test(line))
              .join("\n"),
          );
          if (recipients.size !== 1 || !recipients.has(account("googleEmail").toLowerCase()) || !draft.includes("Got it.")) {
            // Never left waiting: denied before the walk fails.
            await denyCard(card);
            throw new Error(`the send's card goes to ${String(recipients.size)} addresses, not only the account's own, or lacks the reply`);
          }
          // Its In reply to line names the message's sender, another of the person's addresses: kept out of the picture.
          // biome-ignore lint/performance/useDomNodeTextContent: Playwright's innerText keeps the card's line breaks, which part its lines and addresses.
          for (const other of addresses(await card.innerText()))
            if (other !== account("googleEmail").toLowerCase()) hidePersonal(other, "sam@example.com");
          await walk.shot(card);
          // The walks send no email from the person's account: pictured, then denied. A reader's Allow once sends it.
          await denyCard(card);
          break;
        }
        await card.getByRole("button", { name: "Allow once" }).click();
      }
      await turnEnded(page);
      expect(completedCalls(walk, /^gmail\..+\.send_draft$/), "no email sent").toBe(0);
    },
  },
});
