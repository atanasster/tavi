import { expect } from "vitest";

import { keptWith, newChat, rememberFact, slash } from "../support/memory.js";
import { chats, send } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

interface Why {
  readonly records: readonly { readonly recordId: string }[];
  readonly used?: { readonly used: number };
}

const DINNER = "Suggest a quick dinner I could cook tonight, in one line.";

walkGuide("memory-and-skills/why-that-answer", {
  configured: true,
  model: true,
  seed: [rememberFact("Diet", "I'm vegetarian")],
  steps: {
    "ask-something-your-memory-covers": async (walk) => {
      const page = await walk.open("/");
      await newChat(page);
      await send(page, DINNER);
      const diet = keptWith(walk, "vegetarian");
      const why = walk.taviJson<Why>("memory", "why", chats(walk.tavi)[0]?.taskId ?? "");
      expect(
        why.records.map((record) => record.recordId),
        "the answer was given the kept fact",
      ).toContain(diet?.recordId);
      // The chip follows the answer, once its saved turn is read back.
      const chip = page.locator(".memory-used-chip").last();
      await chip.waitFor();
      await expect(chip.textContent()).resolves.toMatch(/Used 1 memory/);
      await chip.scrollIntoViewIfNeeded();
      await walk.shot(undefined, { mask: [page.locator(".run .markdown")] });
    },
    "open-the-chip": async (walk) => {
      const page = await walk.page();
      const used = page.locator(".memory-used").last();
      await used.locator(".memory-used-chip").click();
      await used.getByRole("button", { name: /^Forget: / }).waitFor();
      // Opened at the foot of the transcript, it would sit under the message box.
      await used.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await walk.shot(used);
    },
    "ask-with-why": async (walk) => {
      const page = await walk.page();
      const answer = await slash(page, "/why");
      await expect(answer.textContent()).resolves.toMatch(/The answer used 1 memory/);
      await walk.shot(answer);
    },
    "ask-in-the-terminal": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        input: [
          { wait: 4 },
          { text: DINNER, wait: 1 },
          { text: "\r" },
          { until: "Done\\.", wait: 120 },
          { text: "/why", wait: 1 },
          { text: "\r" },
          { until: "The answer used", wait: 20 },
        ],
      });
      const text = screen.join("\n");
      expect(text).toMatch(/memory: 1 used · \/why/);
      expect(text).toMatch(/The answer used 1 memory/);
    },
  },
});
