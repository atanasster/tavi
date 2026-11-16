import { expect } from "vitest";

import { askInChat } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

const QUESTION = "In one short sentence, what is a good name for a pet goldfish?";
const SCRIPTED = "Reply in one short sentence: what is the capital of France?";
const WRITE = "Create a file named notes.txt in your working folder containing the word hello.";

interface Needs {
  readonly needs: readonly { readonly kind: string; readonly taskId: string; readonly tool?: string }[];
}

walkGuide("get-started/which-surface", {
  configured: true,
  model: true,
  steps: {
    "chat-in-the-terminal": async (walk) => {
      const screen = await askInChat(walk, QUESTION);
      expect(screen.join("\n")).toContain(QUESTION);
      expect(screen.join("\n")).toMatch(/Done\./);
    },
    "open-the-web-canvas": async (walk) => {
      const page = await walk.open("/");
      // The same Home: the turn asked in the terminal is on the canvas.
      await page.getByText(QUESTION).first().waitFor();
      await walk.shot(undefined, { mask: [page.locator("article.run")] });
    },
    "script-it-with-tavi-run": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi run --format json",
        args: ["run", "--format", "json", SCRIPTED],
        tty: true,
        input: [{ until: "task\\.completed", wait: 120 }],
        cols: 120,
      });
      const text = screen.join("");
      expect(text).toContain('"kind":"run.started"');
      expect(text).toContain('"kind":"task.completed"');
    },
    "see-what-is-waiting-on-you": async (walk) => {
      // A run that writes a file stops on its approval: tavi run exits 3 while it waits.
      let exit = 0;
      try {
        walk.tavi("run", "--quiet", WRITE);
      } catch (error) {
        exit = (error as { status?: number }).status ?? -1;
      }
      expect(exit, "the run waits on an approval").toBe(3);
      const screen = await walk.terminal({ title: "tavi needs", args: ["needs"], cols: 140 });
      expect(screen.join("\n")).toMatch(/^! fs\.write notes\.txt/m);
      const needs = walk.taviJson<Needs>("needs");
      expect(needs.needs.map((need) => need.kind)).toContain("approval");
    },
  },
});
