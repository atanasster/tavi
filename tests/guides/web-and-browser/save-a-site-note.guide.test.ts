import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import { BOOKSHOP_HOST as HOST, findBooksForRecipe, fixtureSite } from "../support/browser-site.js";
import { walkGuide } from "../support/walk.js";

interface Notes {
  readonly notes: readonly { readonly id: string; readonly hosts: readonly string[]; readonly state: string }[];
}

const site = fixtureSite();
/** The id Tavi gives a note proposed from the bookshop's recipe. */
const NOTE = "recipe-127-0-0-1";

const noteState = (walk: { taviJson<T>(...args: string[]): T }) =>
  walk.taviJson<Notes>("browser", "site-notes").notes.find((note) => note.id === NOTE)?.state;

walkGuide("web-and-browser/save-a-site-note", {
  configured: true,
  model: true,
  steps: {
    "ask-tavi-to-find-something-on-a-site": async (walk) => {
      await findBooksForRecipe(walk, site);
    },
    "save-the-recipe-as-a-site-note": async (walk) => {
      const page = await walk.open("/settings/general");
      await page.getByText("Site recipes", { exact: true }).evaluate((heading) => heading.scrollIntoView({ block: "start" }));
      await page.getByRole("button", { name: `Save as a site note: ${HOST}` }).click();
      await page.getByText(`Saved as the site note ${NOTE}, off`).waitFor();
      const file = join(walk.dataDir, "site-notes", `${NOTE}.json`);
      expect(existsSync(file)).toBe(true);
      expect((JSON.parse(readFileSync(file, "utf8")) as { hosts: string[] }).hosts).toEqual([HOST]);
      await walk.shot();
    },
    "stop-tavi-and-list-your-notes": async (walk) => {
      await site.stopOwner();
      expect(noteState(walk)).toBe("off");
      const screen = await walk.terminal({ title: "tavi browser site-notes", args: ["browser", "site-notes"] });
      expect(screen.join("\n")).toContain(`${NOTE} — `);
    },
    "turn-the-note-on": async (walk) => {
      const screen = await walk.terminal({
        title: `tavi browser site-notes --on ${NOTE}`,
        args: ["browser", "site-notes", "--on", NOTE],
      });
      expect(screen.join("\n")).toContain(`${NOTE} is on`);
      expect(noteState(walk)).toBe("on");
      // As the step says, Tavi is started again, and reads the note from then on.
      await site.startOwner();
    },
    "turn-it-off-when-you-no-longer-want-it": async (walk) => {
      await site.stopOwner();
      const screen = await walk.terminal({
        title: `tavi browser site-notes --off ${NOTE}`,
        args: ["browser", "site-notes", "--off", NOTE],
      });
      expect(screen.join("\n")).toContain(`${NOTE} is off`);
      expect(noteState(walk)).toBe("off");
    },
  },
});
