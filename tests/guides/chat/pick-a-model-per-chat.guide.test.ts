import { expect } from "vitest";

import { MODEL } from "../../../scripts/docs/session.mjs";
import { connectModel } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Roles {
  readonly workspaceDefault: { readonly target: { readonly model: string } } | null;
}

const PICKED = "anthropic/claude-haiku-5.5";

walkGuide("chat/pick-a-model-per-chat", {
  // Set up as a reader is, with `tavi setup`: an owner started with a model of its own would keep it for new chats.
  configured: false,
  model: true,
  steps: {
    "start-a-chat": async (walk) => {
      connectModel(walk.tavi);
      walk.tavi("models", "discover", "openrouter");
      const page = await walk.open("/");
      const prompt = page.locator(".composer-box textarea");
      await prompt.fill("Name one planet. One word.");
      await prompt.press("Enter");
      await page
        .getByRole("button", { name: /^Copy response/ })
        .first()
        .waitFor({ timeout: 120_000 });
      await page.getByLabel("Chat model").getByText("Gemini 3.8 Flash").waitFor();
      await page
        .getByText(/^Model: gemini-3\.8-flash/)
        .first()
        .waitFor();
      await walk.shot();
    },
    "open-the-model-picker": async (walk) => {
      const page = await walk.page();
      const open = async () => {
        await page.getByLabel("Chat model").click();
        await page.getByPlaceholder("Search models…").fill("haiku 5.5");
        await page.getByRole("option", { name: "Claude Haiku 5.5", exact: true }).waitFor();
      };
      await open();
      await walk.shot();
    },
    "pick-a-model": async (walk) => {
      const page = await walk.page();
      // The last step's picture took the focus away, which closes the list: it is opened again as it was.
      const option = page.getByRole("option", { name: "Claude Haiku 5.5", exact: true });
      if (!(await option.isVisible())) {
        await page.getByLabel("Chat model").click();
        await page.getByPlaceholder("Search models…").fill("haiku 5.5");
      }
      await option.click();
      await page.getByLabel("Chat model").getByText("Claude Haiku 5.5").waitFor();
      // The pick is also the workspace's default for new chats.
      await expect.poll(() => (JSON.parse(walk.tavi("models", "roles")) as Roles).workspaceDefault?.target.model).toBe(PICKED);
      await walk.shot(page.locator("form").last());
    },
    "send-your-next-message": async (walk) => {
      const page = await walk.page();
      const prompt = page.locator(".composer-box textarea");
      await prompt.fill("Name one more planet. One word.");
      await prompt.press("Enter");
      await expect.poll(() => page.getByRole("button", { name: /^Copy response/ }).count(), { timeout: 120_000 }).toBe(2);
      await page
        .getByText(/^Model: claude-haiku-5\.5/)
        .first()
        .waitFor({ timeout: 15_000 });
      await walk.shot(undefined, { mask: [page.locator("article .text")] });
    },
    "switch-from-the-terminal": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        input: [
          { wait: 5 },
          { text: "/model", wait: 1 },
          { text: "\r" },
          { until: "this chat runs", wait: 15 },
          { text: `/model ${MODEL.connection} ${MODEL.main}`, wait: 1 },
          { text: "\r" },
          // The second reply; what it says is checked below.
          { until: "this chat and new chats run", wait: 15 },
        ],
      });
      expect(screen.join("\n"), screen.join("\n")).toContain(`this chat runs ${MODEL.connection}/${PICKED}`);
      expect((JSON.parse(walk.tavi("models", "roles")) as Roles).workspaceDefault?.target.model).toBe(MODEL.main);
    },
  },
});
