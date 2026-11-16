import { expect } from "vitest";

import { MODEL } from "../../../scripts/docs/session.mjs";
import { allowUntilAnswered, fixtureSite, newChat, newestTask, nextCard, sendPrompt, toolCalls } from "../support/browser-site.js";
import { walkGuide } from "../support/walk.js";

// Acting by sight needs a model that reads screenshots and places clicks well: Claude Sonnet, for this one guide.
const site = fixtureSite(MODEL.sight);
/** How many answers the chat had before the request: its own answer is the next. */
let before = 0;

walkGuide("web-and-browser/act-by-sight", {
  configured: true,
  model: true,
  main: MODEL.sight,
  steps: {
    "ask-for-something-on-a-drawn-control": async (walk) => {
      const { origin } = await site.open(walk.dataDir);
      const page = await walk.open("/");
      await newChat(page);
      // The seat plan is a canvas with no element per seat: only acting by sight can pick one, and the walk says so.
      before = await sendPrompt(
        page,
        `On ${origin}/seats, choose seat 4B on the seat plan. The plan is drawn on a canvas, so act on it by sight with browser.vision_act. Then tell me what the page says under the plan.`,
      );
      const card = await nextCard(page);
      await expect(card.getByText(/This chat wants to use the browser on/).isVisible()).resolves.toBe(true);
      await walk.shot(card);
      await card.getByRole("button", { name: "Allow for this chat" }).click();
    },
    "allow-acting-by-sight-once": async (walk) => {
      const page = await walk.page();
      // The vision card, once any other browser card before it (the first one just decided, a read of the page) is past.
      const card = page.locator("section.round").filter({ hasText: "Act in the browser by sight" }).last();
      const deadline = Date.now() + 240_000;
      while (!(await card.getByRole("button", { name: "Allow once" }).isVisible())) {
        if (Date.now() > deadline) throw new Error("no card to act in the browser by sight");
        const other = await nextCard(page, Math.max(1_000, deadline - Date.now()));
        if ((await other.textContent())?.includes("Act in the browser by sight") === true) continue;
        const allow = other
          .getByRole("button", { name: "Allow for this chat" })
          .or(other.getByRole("button", { name: "Allow once" }))
          .first();
        if (await allow.isVisible()) {
          await allow.click();
          await allow.waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
        }
      }
      // Asked on its own every time: no scope wider than this call is offered.
      await expect(card.getByRole("button", { name: "Allow for this chat" }).count()).resolves.toBe(0);
      await walk.shot(card);
      await card.getByRole("button", { name: "Allow once" }).click();
    },
    "read-what-it-did": async (walk) => {
      const page = await walk.page();
      await allowUntilAnswered(page, before, { timeoutMs: 480_000 });
      const { chosen } = await site.open(walk.dataDir);
      expect(chosen, "the seat the page recorded").toContain("4B");
      expect(
        toolCalls(walk.tavi, newestTask(walk.tavi)).some((call) => call.toolName === "browser.vision_act" && call.status === "completed"),
      ).toBe(true);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "choose-what-drives-it": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi config get browser.visionEngine",
        args: ["config", "get", "browser.visionEngine"],
      });
      expect(screen.join("\n")).toContain("browser.visionEngine = generic");
    },
  },
});
