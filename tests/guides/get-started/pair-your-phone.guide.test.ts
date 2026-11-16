import { expect } from "vitest";

import { PLACEHOLDER_NAME, addBot, person, sendCodeFrom } from "../support/telegram.js";
import { walkGuide } from "../support/walk.js";

const SLUG = "get-started/pair-your-phone";

walkGuide(SLUG, {
  configured: true,
  // The name Welcome's About you step saved: pairing gives the binding this name, never the person's Telegram name.
  seed: [["config", "set", "operator.name", PLACEHOLDER_NAME]],
  timeoutMs: 30 * 60_000,
  steps: {
    "open-message-tavi-from-your-phone": async (walk) => {
      const page = await walk.open("/welcome/channels");
      await page.getByRole("button", { name: "Telegram", exact: true }).click();
      await page.getByText("Create a bot with @BotFather").waitFor();
      await walk.shot();
    },
    "add-your-bot": async (walk) => {
      // The person's token is never typed by the walk: it is added from its file, as `tavi channels add` does, and the
      // step then shows what the form leads to once Telegram answered.
      walk.unwalked("the token is pasted by the person; the walk adds the same bot from its file with tavi channels add");
      await addBot(walk);
      const page = await walk.open("/welcome/channels");
      const pairing = page.getByRole("region", { name: "Pairing" });
      await pairing.getByRole("button", { name: "Get a code" }).waitFor();
      await walk.shot(pairing);
    },
    "scan-the-code-with-your-phone": async (walk) => {
      const page = await walk.page();
      const pairing = page.getByRole("region", { name: "Pairing" });
      await pairing.getByRole("button", { name: "Get a code" }).click();
      await pairing.getByRole("img", { name: /QR code/ }).waitFor();
      // The picture is the code as it waits; the harness draws the QR code again with the placeholder bot.
      await walk.shot(pairing);
      await sendCodeFrom(pairing, pairing.getByRole("button", { name: "Yes, it's me" }), SLUG);
    },
    "confirm-it-was-you": async (walk) => {
      const page = await walk.page();
      // The question names the person's Telegram account: it is answered, never pictured.
      await page.getByRole("button", { name: "Yes, it's me" }).click();
      const paired = page.getByRole("status").filter({ hasText: "Paired on" });
      await paired.waitFor({ timeout: 15_000 });
      const you = person(walk, "operator");
      expect(you?.displayName).toBe(PLACEHOLDER_NAME);
      await walk.shot(page.locator(".welcome-connect"));
    },
  },
});
