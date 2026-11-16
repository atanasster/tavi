import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import { walkGuide } from "../support/walk.js";

interface Tasks {
  readonly tasks: readonly { readonly taskId: string; readonly chatKind: string }[];
}

const SPENDING = "month,groceries,transport\nJuly,212.40,64.00\nAugust,198.15,71.50\nSeptember,240.80,58.25\n";

/**
 * A 64×64 GIF of one colour (orange): every entry of its four-colour palette is
 * that colour, and its picture data restarts the code table every two pixels,
 * so each code is three bits.
 */
function swatch(): Buffer {
  const size = 64;
  const codes: number[] = [];
  for (let pixel = 0; pixel < size * size; pixel += 2) codes.push(4, 0, 0);
  codes.push(5);
  const packed: number[] = [];
  let bits = 0;
  let count = 0;
  for (const code of codes) {
    bits |= code << count;
    count += 3;
    while (count >= 8) {
      packed.push(bits & 0xff);
      bits >>= 8;
      count -= 8;
    }
  }
  if (count > 0) packed.push(bits & 0xff);
  const blocks: number[] = [];
  for (let at = 0; at < packed.length; at += 255) {
    const block = packed.slice(at, at + 255);
    blocks.push(block.length, ...block);
  }
  const orange = [0xf2, 0x8c, 0x28];
  return Buffer.from([
    ...Buffer.from("GIF89a"),
    size,
    0,
    size,
    0,
    0x81,
    0,
    0,
    ...orange,
    ...orange,
    ...orange,
    ...orange,
    0x2c,
    0,
    0,
    0,
    0,
    size,
    0,
    size,
    0,
    0,
    2,
    ...blocks,
    0,
    0x3b,
  ]);
}

/** The reader's files, made for the walk in a folder of their own: nothing of anyone's. */
const directories = temporaryDirectories();
const files = directories.create("tavi-docs-attach-");
// Deleted however the walk ends.
afterAll(() => directories.cleanup());
writeFileSync(join(files, "spending.csv"), SPENDING);
writeFileSync(join(files, "swatch.gif"), swatch());
// A PNG's signature and header, enough for the box to know it for one.
writeFileSync(join(files, "photo.png"), Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex"));

walkGuide("chat/attach-files-to-chat", {
  configured: true,
  model: true,
  steps: {
    "attach-a-file": async (walk) => {
      const page = await walk.open("/");
      await page.locator("input[type=file]").setInputFiles(join(files, "spending.csv"));
      const chips = page.getByRole("list", { name: "Attached files" });
      await chips.getByText("spending.csv").waitFor();
      await walk.shot(page.locator("form").last());
    },
    "add-an-image": async (walk) => {
      const page = await walk.page();
      await page.locator("input[type=file]").setInputFiles(join(files, "swatch.gif"));
      const chips = page.getByRole("list", { name: "Attached files" });
      await chips.getByText("swatch.gif").waitFor();
      await expect.poll(() => chips.getByRole("listitem").count()).toBe(2);
      await page.getByRole("button", { name: "Remove swatch.gif" }).waitFor();
      await walk.shot(page.locator("form").last());
    },
    "ask-about-them-and-send": async (walk) => {
      const page = await walk.page();
      const prompt = page.locator(".composer-box textarea");
      await prompt.fill("Which month had the highest groceries spend, and what colour is the image? Two short lines.");
      await prompt.press("Enter");
      await page
        .getByRole("button", { name: /^Copy response/ })
        .first()
        .waitFor({ timeout: 180_000 });
      // The spreadsheet went in the message, and the chat opened the uploaded image.
      const home = (JSON.parse(walk.tavi("tasks")) as Tasks).tasks.find((task) => task.chatKind === "home");
      const history = walk.tavi("tasks", "history", home?.taskId ?? "");
      expect(history).toContain("spending.csv");
      expect(history).toContain("artifacts.view_image");
      await page.getByText("artifacts.view_image").first().waitFor();
      await walk.shot(undefined, { mask: [page.locator("article .text")] });
    },
    "know-what-is-refused": async (walk) => {
      const page = await walk.page();
      await page.locator("input[type=file]").setInputFiles(join(files, "photo.png"));
      await page.getByText(/^photo\.png: the canvas takes a PDF, a video/).waitFor();
      expect(await page.getByRole("list", { name: "Attached files" }).count()).toBe(0);
      await walk.shot(page.locator("form").last());
    },
  },
});
