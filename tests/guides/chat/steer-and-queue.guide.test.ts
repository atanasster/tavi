import { expect } from "vitest";

import { walkGuide } from "../support/walk.js";

const STEERED = "Search the web for the opening hours of Belem Tower, then answer in one line.";
const QUEUED_FIRST = "Search the web for the opening hours of the Oceanario in Lisbon, then answer in one line.";
const QUEUED_NEXT = "Now the same for the Gulbenkian Museum, in one line.";
const CANVAS_TURN =
  "One search at a time, waiting for each result before the next: search the web for the opening hours of Belem Tower, then of the Oceanario, then of the Gulbenkian Museum. Then list them in three lines.";
const CANVAS_QUEUED = "Add Sao Jorge Castle too.";

walkGuide("chat/steer-and-queue", {
  search: true,
  configured: true,
  model: true,
  steps: {
    "steer-a-running-turn": async (walk) => {
      expect(walk.tavi("search", "list"), "web search is on").toMatch(/enabled/);
      // The steer goes in two seconds after the question, while the turn's first step (the search) is still under way.
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        input: [
          { wait: 5 },
          { text: STEERED, wait: 1 },
          { text: "\r" },
          { wait: 2 },
          { text: "/steer Also include Jeronimos Monastery.", wait: 1 },
          { text: "\r" },
          { until: "Done\\.", wait: 150 },
        ],
      });
      const text = screen.join("\n");
      expect(text, text).toContain("Also include Jeronimos Monastery. (sent into the turn)");
      expect(text).toContain("web_search");
    },
    "queue-your-next-message": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        input: [
          { wait: 5 },
          { text: QUEUED_FIRST, wait: 1 },
          { text: "\r" },
          { wait: 2 },
          { text: QUEUED_NEXT, wait: 1 },
          { text: "\r" },
          { until: "❯ Now the same for the Gulbenkian[\\s\\S]*Done\\.", wait: 180 },
        ],
      });
      const text = screen.join("\n");
      expect(text, text).toContain("queued: sends after this turn");
      expect(screen.at(-1)).toMatch(/^❯/);
    },
    "queue-from-the-canvas": async (walk) => {
      const page = await walk.open("/");
      const box = page.locator(".composer-box textarea");
      await box.fill(CANVAS_TURN);
      await box.press("Enter");
      await expect.poll(() => box.getAttribute("placeholder"), { timeout: 30_000 }).toBe("Queue a message for after this turn…");
      await box.fill(CANVAS_QUEUED);
      await box.press("Enter");
      const queued = page.getByText("Queued: sends after this turn.");
      await queued.waitFor();
      await expect(page.getByRole("button", { name: "Send now" }).count()).resolves.toBe(1);
      await expect(page.getByRole("button", { name: "Cancel", exact: true }).count()).resolves.toBe(1);
      await queued.scrollIntoViewIfNeeded();
      await walk.shot(undefined, { mask: [page.locator(".run .markdown")] });
    },
    "send-it-into-the-turn-now": async (walk) => {
      const page = await walk.page();
      // Home already shows the terminal's steer from the first step: this one is the next.
      const steers = page.getByText("You, during this turn", { exact: true });
      const before = await steers.count();
      await page.getByRole("button", { name: "Send now" }).click();
      // Read by the turn, the message shows in it as the reader's, during the turn.
      await expect.poll(() => steers.count(), { timeout: 120_000, interval: 1_000 }).toBeGreaterThan(before);
      const during = steers.last();
      const answers = page.getByRole("button", { name: "Copy response" });
      await expect
        .poll(async () => (await page.locator(".composer-box textarea").getAttribute("placeholder")) ?? "", { timeout: 150_000 })
        .not.toMatch(/^Queue/);
      await answers.last().waitFor();
      await during.scrollIntoViewIfNeeded();
      await walk.shot(undefined, { mask: [page.locator(".run .markdown")] });
    },
  },
});
