import { expect } from "vitest";

import type { Page } from "../../../scripts/docs/browser.mjs";
import { checklistState, connectModel } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Checklist {
  readonly dismissedAt?: string;
}

/** The Setup checklist card on Home. */
const card = (page: Page) => page.getByRole("region", { name: /^Setup checklist/ });

walkGuide("get-started/setup-checklist", {
  configured: false,
  model: true,
  steps: {
    "see-what-is-left": async (walk) => {
      // Before you start: a model, connected as its own guide does. The walk's owner (tavi serve) already runs.
      connectModel(walk.tavi);
      const screen = await walk.terminal({ title: "tavi onboard status", args: ["onboard", "status"] });
      expect(screen.join("\n")).toMatch(/✓ Choose the model/);
      expect(screen.join("\n")).toMatch(/○ About you/);
      expect(checklistState(walk.tavi, "model")).toBe("done");
      expect(checklistState(walk.tavi, "about")).toBe("todo");
    },
    "open-the-checklist-on-home": async (walk) => {
      const page = await walk.open("/");
      const setup = card(page);
      await setup.waitFor();
      for (const name of ["About you", "Continue setup", "Dismiss"])
        await expect(setup.getByRole("button", { name, exact: true }).count()).resolves.toBe(1);
      await walk.shot(setup);
    },
    "finish-a-step-from-the-card": async (walk) => {
      const page = await walk.page();
      await card(page).getByRole("button", { name: "About you", exact: true }).click();
      await page.waitForURL(/\/welcome\/about$/);
      await page.getByLabel("Your name").fill("Alex");
      await expect(page.getByLabel("Your time zone").inputValue()).resolves.toBe("Europe/London");
      // Saving moves Welcome on: the picture shows the form as the reader fills it.
      await walk.shot();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.waitForURL(/\/welcome\/tasks$/);
      await page.getByRole("button", { name: "Do this later", exact: true }).click();
      await page.waitForURL((url) => !url.pathname.startsWith("/welcome"));
      expect(checklistState(walk.tavi, "about")).toBe("done");
    },
    "or-finish-it-in-the-terminal": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi onboard",
        args: ["onboard"],
        tty: true,
        // Tavi's own list is the first answer; Ctrl-C then stops at the next question, keeping it.
        input: [{ wait: 6 }, { text: "\r" }, { wait: 4 }, { text: "\u0003", wait: 2 }],
      });
      expect(screen.join("\n")).toContain("Where do you keep tasks?");
      expect(screen.join("\n")).toMatch(/✓ To-dos/);
      expect(checklistState(walk.tavi, "tasks")).toBe("done");
    },
    "dismiss-the-card": async (walk) => {
      const page = await walk.open("/");
      const setup = card(page);
      await setup.waitFor();
      // Done steps leave the card: About you and the tasks step are gone.
      await expect(setup.getByRole("button", { name: "About you", exact: true }).count()).resolves.toBe(0);
      await walk.shot(setup);
      await setup.getByRole("button", { name: "Dismiss", exact: true }).click();
      await setup.waitFor({ state: "detached" });
      expect(walk.taviJson<Checklist>("onboard", "status").dismissedAt).toBeDefined();
      // Gone from Home, the steps still open stay in tavi onboard.
      expect(checklistState(walk.tavi, "channels")).toBe("todo");
    },
  },
});
