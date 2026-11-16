import { expect } from "vitest";

import { memoryPane, newChat, slash } from "../support/memory.js";
import { chats, send } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Config {
  readonly effective: { readonly enabled: boolean; readonly capture: string };
}

const config = (walk: { taviJson<T>(...args: string[]): T }) => walk.taviJson<Config>("memory", "config").effective;

walkGuide("memory-and-skills/pause-memory", {
  configured: true,
  model: true,
  steps: {
    "see-what-memory-is-doing": async (walk) => {
      const page = await walk.open("/");
      await newChat(page);
      await send(page, "Say hello in five words.");
      const answer = await slash(page, "/memory");
      await expect(answer.textContent()).resolves.toMatch(/Memory on/);
      await walk.shot(undefined, { mask: [page.locator(".run .markdown")] });
    },
    "turn-memory-off-in-one-chat": async (walk) => {
      const page = await walk.page();
      await page.getByRole("button", { name: /^Memory on: turn it off/ }).click();
      const off = page.getByRole("button", { name: /^Memory off: turn it on/ });
      await off.waitFor();
      expect(chats(walk.tavi)[0]?.memoryMode).toBe("off");
      await walk.shot(page.locator("main .task-header"));
    },
    "stop-tavi-suggesting-memories": async (walk) => {
      const page = await walk.open("/center/identity");
      const card = page.locator("section.memory-settings");
      await card.getByRole("switch", { name: "Learn from chats" }).click();
      await card.getByText("Off: only what you write yourself.").waitFor();
      expect(config(walk).capture).toBe("off");
      // The Memory pane, its settings whole: taller than the space a 800-pixel window leaves it.
      await page.setViewportSize({ width: 1280, height: 1100 });
      await walk.shot(memoryPane(page));
    },
    "pause-memory-everywhere": async (walk) => {
      const page = await walk.page();
      const card = page.locator("section.memory-settings");
      await card.getByRole("switch", { name: "Memory", exact: true }).click();
      await card.getByText(/^Paused: nothing is recalled/).waitFor();
      expect(config(walk).enabled).toBe(false);
      await walk.shot(memoryPane(page));
      await page.setViewportSize({ width: 1280, height: 800 });
    },
    "turn-it-back-on-from-the-terminal": async (walk) => {
      walk.tavi("memory", "config", "enabled", "on");
      await walk.terminal({ title: "tavi memory config", args: ["memory", "config"] });
      expect(config(walk)).toEqual(expect.objectContaining({ enabled: true, capture: "off" }));
      walk.tavi("memory", "config", "capture", "suggest");
      expect(config(walk).capture).toBe("suggest");
    },
  },
});
