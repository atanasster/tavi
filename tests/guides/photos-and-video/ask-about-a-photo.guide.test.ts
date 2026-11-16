import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import { root } from "../../../scripts/docs/browser.mjs";
import { homeId, send, lastAnswer } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

/** A drawn still life (three apples in a blue bowl, a lemon beside it), saved as a GIF: nobody's photo. */
const picture = join(root, "tests/guides/fixtures/ask-about-a-photo/fruit-bowl.gif");

const directories = temporaryDirectories();
const files = directories.create("tavi-docs-photo-");
// Deleted however the walk ends.
afterAll(() => directories.cleanup());
/** A JPEG's first bytes, enough for the box to know it for one. */
writeFileSync(join(files, "holiday.jpg"), Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex"));

const viewed = (history: string) => history.split("artifacts.view_image").length - 1;

walkGuide("photos-and-video/ask-about-a-photo", {
  configured: true,
  model: true,
  steps: {
    "attach-the-picture": async (walk) => {
      const page = await walk.open("/");
      await page.locator("input[type=file]").setInputFiles(picture);
      await page.getByRole("list", { name: "Attached files" }).getByText("fruit-bowl.gif").waitFor();
      await walk.shot(page.locator("form").last());
    },
    "ask-about-it": async (walk) => {
      const page = await walk.page();
      await send(page, "What fruit is in this picture, and how many of each? One short line.");
      expect(viewed(walk.tavi("tasks", "history", homeId(walk.tavi)))).toBeGreaterThanOrEqual(1);
      await page.getByText("artifacts.view_image").first().waitFor();
      await walk.shot(undefined, { mask: [page.locator("article .text")] });
    },
    "ask-a-follow-up": async (walk) => {
      const page = await walk.page();
      await send(page, "What colour is the bowl? One short line.");
      const answer = await lastAnswer(page);
      await expect(answer.textContent()).resolves.toMatch(/blue/i);
      await walk.shot(answer, { mask: [answer.locator(".text")] });
    },
    "know-which-pictures-go": async (walk) => {
      const page = await walk.page();
      await page.locator("input[type=file]").setInputFiles(join(files, "holiday.jpg"));
      await page.getByText(/^holiday\.jpg: the canvas takes a PDF, a video/).waitFor();
      expect(await page.getByRole("list", { name: "Attached files" }).count()).toBe(0);
      await walk.shot(page.locator("form").last());
    },
  },
});
