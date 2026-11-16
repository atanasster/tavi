import { expect } from "vitest";

import { type Chat, chats, send, showChats } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const HOME_MESSAGE = "We're thinking of a long weekend in Lisbon. In one sentence, what is it best known for?";
const SIDE_MESSAGE = "Compare two Lisbon neighbourhoods near the metro, in two short bullets.";
const TERMINAL_SIDE = "/side What is a pastel de nata? One sentence.";

walkGuide("chat/home-and-side-chats", {
  configured: true,
  model: true,
  steps: {
    "talk-in-home": async (walk) => {
      const page = await walk.open("/");
      await showChats(page);
      await expect(page.locator(".composer-box textarea").getAttribute("placeholder")).resolves.toBe("Message Home…");
      await send(page, HOME_MESSAGE);
      expect(chats(walk.tavi).filter((chat) => chat.chatKind === "home")).toHaveLength(1);
      await walk.shot(undefined, { mask: [page.locator(".run .markdown")] });
    },
    "start-a-side-chat": async (walk) => {
      const page = await walk.page();
      await page.getByRole("button", { name: "New side chat" }).click();
      await expect.poll(() => page.locator(".composer-box textarea").getAttribute("placeholder")).toBe("Start a side chat…");
      await send(page, SIDE_MESSAGE);
      const home = chats(walk.tavi).find((chat) => chat.chatKind === "home") as Chat;
      const side = chats(walk.tavi).find((chat) => chat.chatKind === "side");
      expect(side?.parentChatId, "the side chat begins from Home").toBe(home.taskId);
      await walk.shot(undefined, { mask: [page.locator(".run .markdown")] });
    },
    "see-it-report-back-in-home": async (walk) => {
      const home = chats(walk.tavi).find((chat) => chat.chatKind === "home") as Chat;
      // Home as a reader coming back to it a little later sees it: the notice's one-line summary is the side chat's
      // own, written a moment after it ends, so Home is opened once that summary exists (or after a minute and a half).
      const side = chats(walk.tavi).find((chat) => chat.chatKind === "side") as Chat;
      const summary = () => (JSON.parse(walk.tavi("tasks", side.taskId)) as { task: { summary: string | null } }).task.summary;
      await expect
        .poll(summary, { timeout: 90_000, interval: 3_000 })
        .not.toBeNull()
        .catch(() => undefined);
      const page = await walk.open(`/tasks/${home.taskId}`);
      const notice = () => page.locator('.chat-notice[data-notice-kind="side-chat-settled"]');
      await notice().waitFor({ timeout: 30_000 });
      await expect(notice().locator(".chat-notice-summary").textContent()).resolves.toMatch(/^Completed/);
      await expect(notice().getByRole("button", { name: "Open side chat" }).count()).resolves.toBe(1);
      await notice().scrollIntoViewIfNeeded();
      await walk.shot(undefined, { mask: [page.locator(".run .markdown"), notice().locator(".chat-notice-summary")] });
    },
    "branch-from-the-terminal": async (walk) => {
      const before = chats(walk.tavi).filter((chat) => chat.chatKind === "side").length;
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        input: [{ wait: 5 }, { text: TERMINAL_SIDE, wait: 1 }, { text: "\r" }, { until: "pastel de nata[\\s\\S]*Done\\.", wait: 120 }],
      });
      expect(screen.join("\n")).toContain("What is a pastel de nata?");
      const sides = chats(walk.tavi).filter((chat) => chat.chatKind === "side");
      expect(sides.length, "a second side chat").toBe(before + 1);
    },
    "go-back-with-home": async (walk) => {
      // The terminal is where the last step left it, on the side chat it started (each picture is its own run of tavi chat).
      const side = chats(walk.tavi).find((chat) => chat.chatKind === "side") as Chat;
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat", "--attach", side.taskId],
        tty: true,
        input: [{ wait: 5 }, { text: "/home", wait: 1 }, { text: "\r" }, { until: "type to continue Home", wait: 30 }, { wait: 2 }],
      });
      const text = screen.join("\n");
      expect(text).toMatch(/◆ Side chat .+ finished/);
      expect(screen.at(-1)).toMatch(/^❯/);
    },
  },
});
