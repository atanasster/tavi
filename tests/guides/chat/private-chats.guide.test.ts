import { expect } from "vitest";

import { chats, send, showChats } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const MESSAGE = "I'm planning a surprise party for my friend Sam on 14 November. Suggest three themes, in one line.";
const TERMINAL_MESSAGE = "Suggest one small gift for a friend who loves hiking, in one line.";

walkGuide("chat/private-chats", {
  configured: true,
  model: true,
  steps: {
    "start-a-private-chat": async (walk) => {
      const page = await walk.open("/");
      await showChats(page);
      await page.getByRole("button", { name: "New private chat" }).click();
      await expect
        .poll(() => page.locator(".composer-box textarea").getAttribute("placeholder"))
        .toBe("Start a private chat: memory off, forgotten a day after its last message…");
      await walk.shot();
    },
    "talk-as-usual": async (walk) => {
      const page = await walk.page();
      await send(page, MESSAGE);
      const chat = chats(walk.tavi)[0];
      expect(chat?.memoryMode, "the chat is private").toBe("private");
      await page.getByText("Private chat", { exact: true }).first().waitFor();
      await walk.shot(undefined, { mask: [page.locator(".run .markdown")] });
    },
    "check-that-nothing-was-learned": async (walk) => {
      const page = await walk.page();
      await page.getByRole("button", { name: "Memory", exact: true }).click();
      const learned = page.getByText("Learned here", { exact: true });
      await learned.waitFor();
      expect(walk.taviJson<unknown[]>("memory", "proposals"), "nothing proposed for memory").toEqual([]);
      expect(walk.tavi("memory", "list").trim()).toBe("(no records)");
      await walk.shot(undefined, { mask: [page.locator(".run .markdown")] });
    },
    "start-one-from-the-terminal": async (walk) => {
      const before = chats(walk.tavi).length;
      const screen = await walk.terminal({
        title: "tavi chat --private",
        args: ["chat", "--private"],
        tty: true,
        input: [{ wait: 5 }, { text: TERMINAL_MESSAGE, wait: 1 }, { text: "\r" }, { until: "Done\\.", wait: 120 }],
      });
      expect(screen.join("\n")).toContain(TERMINAL_MESSAGE);
      const all = chats(walk.tavi);
      expect(all.length).toBe(before + 1);
      expect(all[0]?.memoryMode, "the terminal's chat is private").toBe("private");
      expect(all[0]?.chatKind, "never Home").not.toBe("home");
      expect(walk.taviJson<unknown[]>("memory", "proposals")).toEqual([]);
    },
  },
});
