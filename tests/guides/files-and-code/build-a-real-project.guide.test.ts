import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import { chats, projectsFolder, restartOwner, send, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

useRealTmpdir();

interface Pending {
  readonly rows: readonly { readonly record: { readonly taskId: string; readonly toolId: string } }[];
}

/** The reader's `~/code`, made by the walk, with a small Node project in `shop/`. */
let code = "";
/** The chat that looked around, and later runs the tests. */
let taskId = "";

const pending = (walk: { taviJson<T>(...args: string[]): T }) => walk.taviJson<Pending>("approvals", "list").rows;

walkGuide("files-and-code/build-a-real-project", {
  configured: true,
  model: true,
  steps: {
    "let-tavi-look-around": async (walk) => {
      code = projectsFolder("build-a-real-project", {
        "shop/package.json": `${JSON.stringify(
          { name: "shop", private: true, type: "module", scripts: { test: "node --test", build: "node build.js" } },
          null,
          2,
        )}\n`,
        "shop/cart.js": "export const total = (items) => items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n",
        "shop/cart.test.js": [
          'import assert from "node:assert/strict";',
          'import { test } from "node:test";',
          'import { total } from "./cart.js";',
          'test("adds up the cart", () => assert.equal(total([{ price: 250, quantity: 2 }]), 500));',
          'test("an empty cart is free", () => assert.equal(total([]), 0));',
          "",
        ].join("\n"),
        "shop/build.js": [
          'import { copyFileSync, mkdirSync } from "node:fs";',
          'mkdirSync("dist", { recursive: true });',
          'copyFileSync("cart.js", "dist/cart.js");',
          'console.log("built dist/cart.js");',
          "",
        ].join("\n"),
      });
      await restartOwner(walk.dataDir, ["--fs-root", code]);
      const screen = await walk.terminal({
        title: "tavi run",
        args: [
          "run",
          "--folder",
          join(code, "shop"),
          "Look around this project: list the files and show package.json, using sandbox.run with ls and cat.",
        ],
        cols: 140,
      });
      const text = screen.join("\n");
      // The reads ran, and nothing stopped for an approval.
      expect(text).toMatch(/sandbox\.run ←/);
      expect(text).not.toMatch(/\[approval\]/);
      taskId = chats(walk.tavi).find((chat) => chat.chatKind === "run")?.taskId ?? "";
      expect(taskId).not.toBe("");
    },
    "give-a-long-build-more-time": async (walk) => {
      await restartOwner(walk.dataDir, ["--fs-root", code, "--sandbox-timeout", "300", "--sandbox-max-timeout", "1200"]);
      const screen = await walk.terminal({
        title: "tavi run",
        args: ["run", "--folder", join(code, "shop"), "Build the project with npm run build, allowing it 15 minutes (timeoutMs 900000)."],
        // It asks at the terminal; Ctrl-C leaves the call waiting, approved below as the reader would.
        tty: true,
        cols: 140,
        input: [
          { until: "\\[y/s/a/N\\]", wait: 180 },
          { text: "\u0003", wait: 3 },
        ],
      });
      expect(screen.join("\n")).toMatch(/\[approval\].*npm.*build.*900000|\[approval\].*900000.*npm/);
      const waiting = pending(walk);
      expect(waiting.map((row) => row.record.toolId)).toEqual(["sandbox.run"]);
      // Approved as a reader would, the build runs past the default ceiling's reach and writes its output.
      const buildTask = waiting[0]?.record.taskId ?? "";
      walk.tavi("approvals", "approve", buildTask);
      await expect.poll(() => existsSync(join(code, "shop/dist/cart.js")), { timeout: 60_000 }).toBe(true);
      // npm's cache went to the chat's own HOME, not yours.
      expect(existsSync(join(walk.dataDir, "chats/default", buildTask, ".home/.npm"))).toBe(true);
    },
    "run-the-tests": async (walk) => {
      const page = await walk.open(`/tasks/${taskId}`);
      const composer = page.locator(".composer-box textarea");
      await composer.fill("Run the tests with npm test.");
      await composer.press("Enter");
      const card = page.locator("section.round").last();
      await card.getByRole("button", { name: "Allow for this chat" }).waitFor({ timeout: 180_000 });
      await card.getByText(/approving covers: npm test \*/).waitFor();
      expect(pending(walk).map((row) => row.record.toolId)).toEqual(["sandbox.run"]);
      await walk.shot(card);
    },
    "allow-the-tests-for-this-chat": async (walk) => {
      const page = await walk.page();
      const answers = page.getByRole("button", { name: "Copy response" });
      const before = await answers.count();
      await page.locator("section.round").last().getByRole("button", { name: "Allow for this chat" }).click();
      await expect.poll(() => answers.count(), { timeout: 180_000, interval: 1_000 }).toBeGreaterThan(before);
      const decided = walk.taviJson<{ items: readonly unknown[] }>("approvals", "history").items.length;
      await send(page, "Run the tests again with npm test -- --test-reporter=spec.");
      // The variant ran under the chat's grant: no new round was asked or decided.
      expect(pending(walk)).toEqual([]);
      expect(walk.taviJson<{ items: readonly unknown[] }>("approvals", "history").items.length).toBe(decided);
      await page.getByText("--test-reporter=spec", { exact: false }).last().waitFor();
      // The second run's answer, which the picture is for, is in view.
      await answers.last().scrollIntoViewIfNeeded();
      await walk.shot(undefined, { mask: [page.locator("main .markdown")], frame: "answer" });
    },
    "see-what-you-allowed": async (walk) => {
      const screen = await walk.terminal({ title: "tavi permissions grants", args: ["permissions", "grants"], cols: 140 });
      expect(screen.join("\n")).toContain("npm test *");
    },
    "check-the-sandbox": async (walk) => {
      const screen = await walk.terminal({ title: "tavi sandbox check", args: ["sandbox", "check"] });
      expect(screen.join("\n")).toMatch(/^sandbox: full/m);
    },
  },
});
