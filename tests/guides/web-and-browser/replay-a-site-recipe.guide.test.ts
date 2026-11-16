import { expect } from "vitest";

import { askAndAllow, findBooks, fixtureSite, newestTask, toolCalls } from "../support/browser-site.js";
import { chats } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Recipes {
  readonly recipes: readonly { readonly host: string; readonly steps: readonly unknown[]; readonly replay?: boolean }[];
}

const site = fixtureSite();
const HOST = "127.0.0.1";
/** The chat that read the bookshop first. */
let firstChat = "";

const recipe = (walk: { taviJson<T>(...args: string[]): T }) =>
  walk.taviJson<Recipes>("browser", "recipes").recipes.find((entry) => entry.host === HOST);

walkGuide("web-and-browser/replay-a-site-recipe", {
  configured: true,
  model: true,
  steps: {
    "ask-tavi-to-find-something-on-a-site": async (walk) => {
      const { origin } = await site.open(walk.dataDir);
      await findBooks(walk, origin, () => recipe(walk) !== undefined);
      firstChat = newestTask(walk.tavi);
    },
    "check-the-recipe": async (walk) => {
      expect(recipe(walk)?.steps.length).toBeGreaterThan(0);
      const screen = await walk.terminal({ title: "tavi browser recipes", args: ["browser", "recipes"] });
      expect(screen.join("\n")).toContain(`${HOST} — `);
    },
    "mark-it-to-replay": async (walk) => {
      const screen = await walk.terminal({
        title: `tavi browser recipes --replay ${HOST}`,
        args: ["browser", "recipes", "--replay", HOST],
      });
      expect(screen.join("\n")).toMatch(/replays/);
      expect(recipe(walk)?.replay).toBe(true);
    },
    "ask-again-in-a-new-chat": async (walk) => {
      const { origin } = await site.open(walk.dataDir);
      // The first chat read the site, and a chat branched from it carries that: a fresh chat, from its chip, has no parent.
      const page = await walk.open(`/tasks/${firstChat}`);
      await page.locator(".taint-chip").click();
      await page.getByRole("button", { name: "Start a fresh chat" }).click();
      await askAndAllow(page, `Open ${origin}/ in the browser and list the in-stock fiction books, cheapest first.`);
      expect(chats(walk.tavi).find((chat) => chat.taskId === newestTask(walk.tavi))?.parentChatId, "a chat with no parent").toBeUndefined();
      // The page the browser opened carries the replay's account: every step of the recipe ran.
      const steps = recipe(walk)?.steps.length ?? 0;
      const opened = toolCalls(walk.tavi, newestTask(walk.tavi)).filter(
        (call) => call.toolName === "browser.create_session" || call.toolName === "browser.navigate",
      );
      expect(JSON.stringify(opened.map((call) => call.output))).toContain(`"replayedSteps":${steps}`);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "stop-replaying-it": async (walk) => {
      const screen = await walk.terminal({
        title: `tavi browser recipes --stop-replay ${HOST}`,
        args: ["browser", "recipes", "--stop-replay", HOST],
      });
      expect(screen.join("\n")).toContain("no longer replays");
      expect(recipe(walk)?.replay).not.toBe(true);
    },
  },
});
