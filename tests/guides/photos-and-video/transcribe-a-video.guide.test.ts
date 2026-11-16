import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import { homeId, lastAnswer, send } from "../support/steps.js";
import { checkedAnalyzers, installAnalyzers } from "../support/video.js";
import { walkGuide } from "../support/walk.js";

const directories = temporaryDirectories();
const files = directories.create("tavi-docs-video-");
// Deleted however the walk ends.
afterAll(() => directories.cleanup());

/**
 * A made-up notice read by the system's own voice over a plain green frame, made for the walk and never committed:
 * nobody's recording.
 */
const video = join(files, "allotment-notice.mp4");
execFileSync("say", [
  "-v",
  "Samantha",
  "-o",
  join(files, "notice.aiff"),
  "Hello, this is the Riverside allotment society with two notices. First, the water will be off on Saturday the fourteenth, " +
    "from nine until noon, so please fill your cans on Friday evening. Second, the seed swap moves to the church hall this year, " +
    "starting at two o'clock. Thank you.",
]);
execFileSync("ffmpeg", [
  ...["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x2f6b3a:s=640x360:r=10", "-i", join(files, "notice.aiff")],
  ...["-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", video],
]);

walkGuide("photos-and-video/transcribe-a-video", {
  configured: true,
  model: true,
  steps: {
    "set-up-transcription": async (walk) => {
      await installAnalyzers(walk.dataDir, ["ggml-base.bin"], {
        transcribe: [{ type: "builtin", id: "whisper-cpp", model: { path: "ggml-base.bin", licence: "MIT" } }],
      });
      const page = await walk.open("/settings/models");
      await walk.shot(await checkedAnalyzers(page, /whisper-cpp/));
    },
    "attach-the-video": async (walk) => {
      const page = await walk.open("/");
      await page.locator("input[type=file]").setInputFiles(video);
      await page.getByRole("list", { name: "Attached files" }).getByText("allotment-notice.mp4").waitFor();
      await walk.shot(page.locator("form").last());
    },
    "ask-for-a-transcript": async (walk) => {
      const page = await walk.page();
      await send(page, "Transcribe this video with video.transcribe, with the time each sentence starts.");
      expect(walk.tavi("tasks", "history", homeId(walk.tavi))).toContain("video.transcribe");
      const answer = await lastAnswer(page);
      await expect(answer.textContent()).resolves.toMatch(/allotment/i);
      await page.getByText("video.transcribe").first().waitFor();
      await walk.shot(undefined, { mask: [page.locator("article .text")] });
    },
    "ask-about-what-was-said": async (walk) => {
      const page = await walk.page();
      await send(page, "When is the water off, and what should I do before then? One short line.");
      const answer = await lastAnswer(page);
      await expect(answer.textContent()).resolves.toMatch(/Saturday/i);
      await walk.shot(answer, { mask: [answer.locator(".text")] });
    },
  },
});
