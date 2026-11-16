import { expect } from "vitest";

import type { Locator } from "../../../scripts/docs/browser.mjs";
import { spanning } from "../support/automation.js";
import { dismissChecklist, homeId, lastAnswer, send } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const NAME_LINE = "You are Wren, a local-first assistant.";
const VOICE_LINE = "Your voice: warm, plain and brief. Use British spelling.";
const TUTOR = "In this chat, answer like a patient tutor: short steps, and one question back at the end.";

interface Shown {
  readonly custom: { readonly text: string } | null;
}

/** The workspace's own prompt, or undefined while the shipped default is in use (`tavi system-prompt show`). */
const custom = (walk: { taviJson<T>(...args: string[]): T }) => walk.taviJson<Shown>("system-prompt", "show").custom?.text;

/** Scrolls `target` to the middle of the window, clear of the canvas's top bar. */
const centre = (target: Locator) => target.evaluate((element) => element.scrollIntoView({ block: "center" }));

walkGuide("memory-and-skills/soul-and-identity", {
  configured: true,
  model: true,
  steps: {
    "open-soul": async (walk) => {
      const page = await walk.open("/center/identity");
      // Soul is taller than the window: a taller one shows it whole, for this step and the next two.
      await page.setViewportSize({ width: 1280, height: 1400 });
      const soul = page.getByRole("region", { name: "Soul", exact: true });
      await soul.getByRole("list", { name: "Prompt layers" }).getByText("Shipped default").first().waitFor();
      await soul.getByText("Shipped default in use").waitFor();
      expect(custom(walk)).toBeUndefined();
      await centre(soul);
      await walk.shot(soul);
    },
    "write-your-own-prompt": async (walk) => {
      const page = await walk.page();
      const soul = page.getByRole("region", { name: "Soul", exact: true });
      await soul.getByRole("button", { name: "Write a custom prompt" }).click();
      const editor = soul.getByRole("textbox", { name: "System prompt" });
      const shipped = await editor.inputValue();
      expect(shipped).toMatch(/^You are Tavi, a local-first assistant\./);
      await editor.fill(`${shipped.replace(/^You are Tavi, a local-first assistant\./, NAME_LINE).trimEnd()}\n\n${VOICE_LINE}\n`);
      // The draft as the reader sees it before Save: the new first line at the top of the box, Save below it.
      await editor.evaluate((element) => {
        element.scrollTop = 0;
      });
      await centre(soul.locator(".soul-editor"));
      await walk.shot(soul.locator(".soul-editor"));
      await soul.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => custom(walk), { timeout: 15_000 }).toContain(VOICE_LINE);
    },
    "check-the-layers": async (walk) => {
      const page = await walk.page();
      const layers = page.getByRole("region", { name: "Soul", exact: true }).getByRole("list", { name: "Prompt layers" });
      await layers.locator("li.soul-layer.off").first().waitFor();
      await centre(layers);
      await walk.shot(layers);
      await page.setViewportSize({ width: 1280, height: 800 });
    },
    "meet-the-new-voice": async (walk) => {
      const page = await walk.open("/");
      await dismissChecklist(page);
      await send(page, "Who are you? Answer in one sentence.");
      const answer = await lastAnswer(page);
      await walk.shot(undefined, { mask: [answer.locator(".text")] });
    },
    "give-one-chat-its-own-voice": async (walk) => {
      const page = await walk.page();
      await page.getByRole("button", { name: "Instructions", exact: true }).click();
      const editor = page.getByRole("region", { name: "this chat's instructions" });
      await editor.getByRole("textbox").fill(TUTOR);
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      await editor.getByText("revision 1").waitFor({ timeout: 15_000 });
      expect(walk.tavi("tasks", "instructions", homeId(walk.tavi), "show")).toContain(TUTOR);
      // The crop's padding would take half of the fold under History.
      const next = page.locator("details", { hasText: "The prompt this chat's next turn gets" });
      await next.evaluate((fold: HTMLElement) => (fold.style.visibility = "hidden"));
      const span = await spanning(page, editor.locator("h4"), editor.locator("summary", { hasText: "History" }));
      await walk.shot(span.box);
      await span.remove();
    },
    "see-it-from-a-terminal": async (walk) => {
      const screen = await walk.terminal({ title: "tavi system-prompt preview", args: ["system-prompt", "preview"], lines: 6 });
      expect(screen.join("\n")).toMatch(/not sent/);
    },
    "go-back-to-the-shipped-default": async (walk) => {
      const screen = await walk.terminal({ title: "tavi system-prompt reset", args: ["system-prompt", "reset"], lines: 4 });
      expect(screen.join("\n")).toMatch(/shipped default/);
      expect(custom(walk)).toBeUndefined();
    },
  },
});
