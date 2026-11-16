import { expect } from "vitest";

import {
  addTodoistTask,
  approveAndTurnOn,
  chooseSuggestedForFlagged,
  dialogOf,
  discoverCard,
  hideIdentity,
  personSignsIn,
  reviewFromSheet,
  shownApp,
  showToolRow,
  todoistTaskHome,
} from "../support/apps.js";
import { walkGuide } from "../support/walk.js";

const GUIDE = "connected-apps/connect-your-task-app";

walkGuide(GUIDE, {
  configured: true,
  model: true,
  timeoutMs: 1_800_000,
  steps: {
    "add-todoist-from-discover": async (walk) => {
      // Before you start: credentials encrypted, as a sign-in's token is kept only there.
      walk.tavi("credentials", "encrypt");
      const page = await walk.open("/settings/apps/discover");
      const card = await discoverCard(page, "Todoist");
      await walk.shot(page.locator(".apps-catalog-section").first());
      await card.getByRole("button", { name: "Add", exact: true }).click();
      await dialogOf(page).getByText("What it can do").first().waitFor();
      expect(shownApp(walk, "todoist").accounts.map((each) => each.accountId)).toEqual(["mcp.todoist"]);
    },
    "sign-in-to-todoist": async (walk) => {
      walk.needsUser("todoist");
      const page = await walk.page();
      const sheet = dialogOf(page);
      await expect(sheet.getByRole("radio", { name: /^Personal/ }).isChecked()).resolves.toBe(true);
      await sheet.getByRole("button", { name: "Next" }).click();
      await personSignsIn(walk, page, "todoist", "Sign in to Todoist", GUIDE, "your own Todoist account");
      await sheet.getByText(/^Connected Todoist/).waitFor({ timeout: 60_000 });
      // The account's name is the person's: the sheet keeps only "Connected Todoist."
      await hideIdentity(sheet);
      await walk.shot(sheet);
    },
    "review-and-turn-on-its-tools": async (walk) => {
      const page = await walk.page();
      await page.setViewportSize({ width: 1280, height: 1000 });
      const dialog = await reviewFromSheet(page);
      const listed = walk.taviJson<{ tools: readonly { name: string }[] }>("mcp", "review", "mcp.todoist").tools.map((tool) => tool.name);
      expect(listed).toEqual(expect.arrayContaining(["add-tasks", "find-tasks", "delete-object"]));
      await chooseSuggestedForFlagged(page, dialog);
      await showToolRow(dialog, "mcp.todoist.delete_object");
      await walk.shot(dialog);
      await approveAndTurnOn(page, "Todoist");
      await page.setViewportSize({ width: 1280, height: 800 });
      expect(shownApp(walk, "todoist").accounts[0]?.on).toBe(true);
    },
    "make-it-your-task-home": async (walk) => {
      await todoistTaskHome(walk);
    },
    "add-a-task-you-approve": async (walk) => {
      await addTodoistTask(walk);
    },
  },
});
