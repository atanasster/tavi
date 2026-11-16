import { expect } from "vitest";

import { homeId } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

walkGuide("chat/compact-a-long-chat", {
  configured: true,
  model: true,
  // No memory suggestions: a proposal card after the last answer would push the epoch divider the step shows away.
  seed: [["memory", "config", "capture", "off"]],
  steps: {
    "talk-for-a-while": async (walk) => {
      const page = await walk.open("/");
      const prompt = page.locator(".composer-box textarea");
      const answers = page.getByRole("button", { name: /^Copy response/ });
      for (const [index, question] of [
        "Give one tip for growing basil indoors, in one sentence.",
        "And one tip for growing mint, in one sentence.",
      ].entries()) {
        await prompt.fill(question);
        await prompt.press("Enter");
        await expect.poll(() => answers.count(), { timeout: 120_000 }).toBe(index + 1);
      }
      await walk.shot(undefined, { mask: [page.locator("article .text")] });
    },
    "ask-for-fresh-context": async (walk) => {
      const page = await walk.page();
      await page.getByRole("button", { name: "Memory", exact: true }).click();
      const context = page.getByRole("region", { name: "this chat's context" });
      await context.getByRole("button", { name: "Fresh context" }).click();
      await context.getByText("Your next message starts a new epoch.").waitFor();
      await walk.shot();
    },
    "send-your-next-message": async (walk) => {
      const page = await walk.page();
      const prompt = page.locator(".composer-box textarea");
      await prompt.fill("Which herb did we talk about first? One word.");
      await prompt.press("Enter");
      await expect.poll(() => page.getByRole("button", { name: /^Copy response/ }).count(), { timeout: 120_000 }).toBe(3);
      const divider = page.getByRole("group", { name: "Epoch 1 began" });
      await divider.waitFor({ timeout: 30_000 });
      // The divider, the new question and its answer together: the transcript as it stands, at its foot.
      await page
        .getByRole("button", { name: /^Copy response/ })
        .last()
        .scrollIntoViewIfNeeded();
      expect(walk.tavi("tasks", "history", homeId(walk.tavi))).toContain("Epoch 1 began");
      await walk.shot(undefined, { mask: [page.locator("article .text")] });
    },
    "read-the-summary": async (walk) => {
      const page = await walk.page();
      const id = homeId(walk.tavi);
      await page.getByRole("tab", { name: "Details" }).click();
      await page.getByText(id, { exact: true }).first().waitFor();
      const screen = await walk.terminal({ title: "tavi tasks history", args: ["tasks", "history", id] });
      const text = screen.join("\n");
      expect(text).toContain("Earlier, in summary");
      expect(text).toContain("## Turn 3");
    },
    "compact-from-the-terminal": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        input: [
          { wait: 5 },
          { text: "/compact", wait: 1 },
          { text: "\r" },
          // The chat says the next message starts a new epoch before anything is typed after it.
          { until: "starts\\s+a\\s+new\\s+epoch", wait: 15 },
          { text: "Name one herb we did not mention. One word.", wait: 1 },
          { text: "\r" },
          { until: "Epoch\\s*2\\s*began[\\s\\S]*Done\\.", wait: 120 },
        ],
      });
      expect(screen.join("\n")).toContain("Epoch 2 began");
    },
  },
});
