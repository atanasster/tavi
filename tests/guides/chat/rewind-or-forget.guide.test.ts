import { expect } from "vitest";

import { homeId, send } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const FIRST = "Suggest a name for a small bakery, in three words or fewer.";
const SECOND = "Now suggest a slogan for it, in one line.";
const EDITED = "Now suggest a short slogan about fresh bread, in one line.";

walkGuide("chat/rewind-or-forget", {
  configured: true,
  model: true,
  steps: {
    "have-a-short-conversation": async (walk) => {
      const page = await walk.open("/");
      await send(page, FIRST);
      await send(page, SECOND);
      await walk.shot(undefined, { mask: [page.locator("article .text")] });
    },
    "rewind-to-here": async (walk) => {
      const page = await walk.page();
      const message = page.locator(".user-message").filter({ hasText: SECOND });
      await message.hover();
      await message.getByRole("button", { name: "Rewind to here" }).click();
      const confirm = page.getByRole("group", { name: "Rewind to here" });
      await confirm.getByRole("button", { name: "Rewind", exact: true }).waitFor();
      await walk.shot(page.locator("article").filter({ has: confirm }), { mask: [page.locator("article .text")] });
      await confirm.getByRole("button", { name: "Rewind", exact: true }).click();
      const prompt = page.locator(".composer-box textarea");
      await expect.poll(() => prompt.inputValue(), { timeout: 15_000 }).toBe(SECOND);
    },
    "edit-and-send-it-again": async (walk) => {
      const page = await walk.page();
      await send(page, EDITED);
      const history = walk.tavi("tasks", "history", homeId(walk.tavi));
      expect(history).toContain(EDITED);
      expect(history).not.toContain(SECOND);
      await walk.shot(undefined, { mask: [page.locator("article .text")] });
    },
    "export-the-chat": async (walk) => {
      const page = await walk.page();
      const id = homeId(walk.tavi);
      await page.getByRole("button", { name: "Details", exact: true }).click();
      await page.getByText(id, { exact: true }).first().waitFor();
      const screen = await walk.terminal({ title: "tavi tasks history", args: ["tasks", "history", id] });
      const text = screen.join("\n");
      // A rewound turn's number is not used again: the message sent again is turn 3.
      expect(text).toContain("## Turn 1");
      expect(text).not.toContain("## Turn 2");
      expect(text).toContain("## Turn 3");
      expect(text).toContain(EDITED);
    },
    "rewind-from-the-terminal": async (walk) => {
      const id = homeId(walk.tavi);
      const screen = await walk.terminal({ title: "tavi tasks history … rewind", args: ["tasks", "history", id, "rewind", "--turn", "3"] });
      expect(screen.join("\n")).toContain(EDITED);
      const history = walk.tavi("tasks", "history", id);
      expect(history).toContain("## Turn 1");
      expect(history).not.toContain("## Turn 3");
    },
    "forget-the-history": async (walk) => {
      const page = await walk.page();
      await page.getByRole("tab", { name: "Memory" }).click();
      const section = page.getByRole("region", { name: "forget this chat's history" });
      await section.getByRole("button", { name: "Forget history…" }).click();
      await section.getByRole("button", { name: "Keep it" }).waitFor();
      await walk.shot(section);
      await section.getByRole("button", { name: "Forget history", exact: true }).click();
      await section.getByText(/^Forgotten: /).waitFor({ timeout: 15_000 });
      expect(walk.tavi("tasks", "history", homeId(walk.tavi))).not.toContain(FIRST);
    },
  },
});
