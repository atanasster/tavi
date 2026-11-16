import { expect } from "vitest";

import { dismissChecklist, homeId, send } from "../support/steps.js";
import { PLACEHOLDER_NAME, addBot, askToSend, lastSend, pairByCode, sentSince } from "../support/telegram.js";
import { walkGuide } from "../support/walk.js";

const SLUG = "channels/continue-on-your-phone";

/** The person's Telegram user id, once paired, and their bot's connection. */
let you = "";
let connection = "";

/** Home's history, as `tavi tasks history <home>` gives it: where a turn from the phone shows. */
const homeHistory = (walk: { tavi(...args: string[]): string }): string => walk.tavi("tasks", "history", homeId(walk.tavi));

walkGuide(SLUG, {
  configured: true,
  model: true,
  timeoutMs: 30 * 60_000,
  steps: {
    "link-your-chat-with-the-bot-to-home": async (walk) => {
      // Where the page starts: the person's bot, paired to them (Connect a Telegram bot), under the guides' name.
      connection = await addBot(walk);
      you = await pairByCode(walk, SLUG, { name: PLACEHOLDER_NAME });
      const screen = await walk.terminal({
        title: "tavi config set",
        args: ["config", "set", "chat.home-dm", `${connection}:${you}`],
        tty: true,
      });
      expect(screen.join("\n")).toContain("Privacy:");
      expect(walk.tavi("config", "get", "chat.home-dm")).toContain(`${connection}:${you}`);
    },
    "start-something-in-home": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await send(page, "Suggest a 30-minute walk for Saturday morning, in two lines.");
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "carry-on-from-your-phone": async (walk) => {
      const since = lastSend(walk);
      await askToSend(walk, SLUG, "Make it an hour later.");
      // The message is a turn of Home, and its answer went back to the phone.
      await expect.poll(() => homeHistory(walk), { timeout: 60_000, interval: 2_000 }).toContain("Make it an hour later.");
      await sentSince(walk, since);
      const page = await walk.open("/");
      await page.getByText("Make it an hour later.").last().waitFor({ timeout: 60_000 });
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "unlink-it": async (walk) => {
      const screen = await walk.terminal({ title: "tavi config set", args: ["config", "set", "chat.home-dm", "off"], tty: true });
      expect(screen.join("\n")).not.toContain("Privacy:");
      expect(walk.tavi("config", "get", "chat.home-dm")).toMatch(/off|unset/);
    },
  },
});
