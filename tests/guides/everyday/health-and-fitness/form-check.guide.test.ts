import { join } from "node:path";

import { expect } from "vitest";

import { root } from "../../../../scripts/docs/browser.mjs";
import type { Page } from "../../../../scripts/docs/browser.mjs";
import { newChat } from "../../support/browser-site.js";
import { recipePrompt, shotAlone, wholeAnswer } from "../../support/recipes.js";
import { chats, dismissChecklist, lastAnswer, send } from "../../support/steps.js";
import { installAnalyzers } from "../../support/video.js";
import { walkGuide } from "../../support/walk.js";

/** The clip of the exercise-form guide: public-domain half squats (see the fixture's SOURCE.md). */
const clip = join(root, "tests/guides/fixtures/check-exercise-form/half-squats.mp4");

let page: Page;

walkGuide("everyday/health-and-fitness/form-check", {
  configured: true,
  model: true,
  steps: {
    "ask-for-it": async (walk) => {
      await installAnalyzers(walk.dataDir, ["rtmpose-s.onnx", "rtmdet-nano.onnx"], {
        pose: [
          {
            type: "builtin",
            id: "rtmpose",
            model: { path: "rtmpose-s.onnx", detectorPath: "rtmdet-nano.onnx", licence: "Apache-2.0" },
          },
        ],
      });
      const prompt = recipePrompt("health-home.form-check", { exercise: "squats" });
      page = await walk.open("/");
      await dismissChecklist(page);
      await newChat(page);
      await page.locator("input[type=file]").setInputFiles(clip);
      await page.getByRole("list", { name: "Attached files" }).getByText("half-squats.mp4").waitFor();
      await page.locator(".composer-box textarea").fill(prompt);
      await shotAlone(walk, page.locator("form").last());
      await send(page, prompt);
    },
    "read-the-coaching": async (walk) => {
      const chat = chats(walk.tavi).find((candidate) => candidate.chatKind !== "home");
      expect(walk.tavi("tasks", "history", chat?.taskId ?? "")).toContain("`video.pose` completed");
      const answer = await lastAnswer(page);
      await expect(answer.textContent()).resolves.toMatch(/\d+\s*°|degrees|reps?/i);
      await wholeAnswer(walk, page);
    },
  },
});
