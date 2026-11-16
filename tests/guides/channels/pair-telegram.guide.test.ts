import { expect } from "vitest";

import {
  PLACEHOLDER_NAME,
  askToSend,
  lastSend,
  person,
  running,
  sendCodeFrom,
  sentSince,
  telegram,
  tokenFile,
  shotTelegramChat,
} from "../support/telegram.js";
import { walkGuide } from "../support/walk.js";

const SLUG = "channels/pair-telegram";

walkGuide(SLUG, {
  configured: true,
  model: true,
  timeoutMs: 30 * 60_000,
  steps: {
    "create-a-bot-and-add-it": async (walk) => {
      // Creating the bot is the person's, in BotFather, before the walk: the walk adds its token from their file.
      const screen = await walk.terminal({
        title: "tavi channels add",
        args: ["channels", "add", "telegram", "--secret-file", `token=${tokenFile(walk)}`],
      });
      expect(screen.join("\n")).toMatch(/^telegram-\S+$/m);
    },
    "check-that-it-s-running": async (walk) => {
      await running(walk);
      const screen = await walk.terminal({ title: "tavi channels list", args: ["channels", "list"], cols: 120 });
      expect(screen.join("\n")).toMatch(/telegram\s.*running/);
    },
    "pair-your-account": async (walk) => {
      const page = await walk.open("/settings/people");
      const form = page.locator("form", { has: page.getByRole("heading", { name: "Allow a person" }) });
      await form.getByRole("checkbox", { name: "This is me" }).check();
      await form.getByRole("textbox", { name: "Display name" }).fill(PLACEHOLDER_NAME);
      await form.getByRole("button", { name: "Pair with a code" }).click();
      const pairing = page.getByRole("region", { name: "Pairing" });
      await pairing.getByRole("img", { name: /QR code/ }).waitFor();
      await walk.shot(pairing);
      await sendCodeFrom(pairing, pairing.getByRole("button", { name: "Yes, it's me" }), SLUG);
    },
    "confirm-it-was-you": async (walk) => {
      const page = await walk.page();
      // The question names the person's Telegram account: it is answered, never pictured.
      await page.getByRole("button", { name: "Yes, it's me" }).click();
      await expect.poll(() => person(walk, "operator")?.displayName, { timeout: 15_000 }).toBe(PLACEHOLDER_NAME);
      const row = page.locator("li.row", { hasText: PLACEHOLDER_NAME }).first();
      await row.getByText("you", { exact: true }).waitFor();
      await walk.shot(row);
    },
    "say-hello": async (walk) => {
      const since = lastSend(walk);
      await askToSend(walk, SLUG, "Hi! In one sentence, what can you do?");
      // The answer went back through the bot.
      await sentSince(walk, since);
      expect(telegram(walk).status.lastError).toBeUndefined();
      await shotTelegramChat(walk);
    },
  },
});
