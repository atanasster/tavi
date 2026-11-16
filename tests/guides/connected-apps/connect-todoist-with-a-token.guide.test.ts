import { expect } from "vitest";

import {
  addTodoistTask,
  approveAndTurnOn,
  chooseSuggestedForFlagged,
  dialogOf,
  discoverCard,
  pasteKeyAndTest,
  reviewFromSheet,
  shownApp,
  showToolRow,
  todoistTaskHome,
} from "../support/apps.js";
import { walkGuide } from "../support/walk.js";

walkGuide("connected-apps/connect-todoist-with-a-token", {
  configured: true,
  model: true,
  steps: {
    "add-todoist-api-token": async (walk) => {
      const page = await walk.open("/settings/apps/discover");
      const card = await discoverCard(page, "Todoist (API token)");
      await card.getByRole("button", { name: "Add", exact: true }).click();
      const sheet = dialogOf(page);
      await sheet.getByText("What it can do").first().waitFor();
      await walk.shot(sheet);
      await sheet.getByRole("button", { name: "Next" }).click();
    },
    "paste-your-token": async (walk) => {
      await pasteKeyAndTest(walk, { gate: "todoist", file: "todoist.token", pluginId: "mcp.todoist" });
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
      await approveAndTurnOn(page, "Todoist (API token)");
      await page.setViewportSize({ width: 1280, height: 800 });
      expect(shownApp(walk, "todoist-token").accounts[0]?.on).toBe(true);
    },
    "make-it-your-task-home": async (walk) => {
      await todoistTaskHome(walk);
    },
    "add-a-task-you-approve": async (walk) => {
      await addTodoistTask(walk);
    },
  },
});
