import { join } from "node:path";

import { expect } from "vitest";

import { root } from "../../../scripts/docs/browser.mjs";
import { homeId, lastAnswer, send, scrollResultTo } from "../support/steps.js";
import { checkedAnalyzers, installAnalyzers } from "../support/video.js";
import { walkGuide } from "../support/walk.js";

/** Half squats from the CDC's public-domain "Muscle Strengthening at Home" (see the fixture's SOURCE.md). */
const clip = join(root, "tests/guides/fixtures/check-exercise-form/half-squats.mp4");

walkGuide("photos-and-video/check-exercise-form", {
  configured: true,
  model: true,
  steps: {
    "set-up-the-pose-add-on": async (walk) => {
      await installAnalyzers(walk.dataDir, ["rtmpose-s.onnx", "rtmdet-nano.onnx"], {
        pose: [
          {
            type: "builtin",
            id: "rtmpose",
            model: { path: "rtmpose-s.onnx", detectorPath: "rtmdet-nano.onnx", licence: "Apache-2.0" },
          },
        ],
      });
      const page = await walk.open("/settings/models");
      await walk.shot(await checkedAnalyzers(page, /rtmpose \(builtin\): ready/));
    },
    "attach-your-clip": async (walk) => {
      const page = await walk.open("/");
      await page.locator("input[type=file]").setInputFiles(clip);
      await page.getByRole("list", { name: "Attached files" }).getByText("half-squats.mp4").waitFor();
      await walk.shot(page.locator("form").last());
    },
    "ask-about-your-form": async (walk) => {
      const page = await walk.page();
      await send(
        page,
        "Measure my squats in this clip with video.pose (movement squat): count the reps and tell me my knee and hip angles at the bottom. Short.",
      );
      expect(walk.tavi("tasks", "history", homeId(walk.tavi))).toContain("`video.pose` completed");
      const answer = await lastAnswer(page);
      await expect(answer.textContent()).resolves.toMatch(/\d+\s*°|degrees|reps?/i);
      await page.getByText("video.pose").first().waitFor();
      await walk.shot(undefined, { mask: [page.locator("article .text")] });
    },
    "read-what-the-measures-can-t-tell": async (walk) => {
      const page = await walk.page();
      // The call that measured: alone, it is its own line; with others, it is folded into "Worked · N steps", opened first.
      const pose = page.getByText("video.pose", { exact: true });
      const nested = page.locator("details.tool-completed").filter({ has: pose }).last();
      let opened = nested;
      if ((await nested.count()) > 0) {
        await page.locator("details.tools").filter({ has: nested }).last().locator("summary").first().click();
        await nested.locator("summary").first().click();
      } else {
        opened = page.locator("details.tools").filter({ has: pose }).last();
        await opened.locator("summary").first().click();
      }
      const result = opened.locator("pre").filter({ hasText: '"setup"' }).first();
      await result
        .getByText(/"validated": false/)
        .first()
        .waitFor();
      await result.scrollIntoViewIfNeeded();
      // The result scrolls in its box: the setup's lines at its top, where the step points.
      await scrollResultTo(result, '"setup"');
      await walk.shot(result);
    },
  },
});
