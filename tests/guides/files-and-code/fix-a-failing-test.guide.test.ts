// The function handed to evaluate runs in the browser, against its DOM.
/// <reference lib="dom" />
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { expect } from "vitest";

import type { Page } from "../../../scripts/docs/browser.mjs";
import { chats, projectsFolder, restartOwner, useRealTmpdir } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

useRealTmpdir();

interface Pending {
  readonly rows: readonly { readonly record: { readonly taskId: string; readonly toolId: string } }[];
}

/** A small project with one bug: the discount is what the order keeps, not what it takes off. */
const PROJECT = {
  "calc/package.json": `${JSON.stringify({ name: "calc", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  "calc/price.js": [
    "// The price of an order, in pence: items' prices times their quantities, less a discount in percent.",
    "export function total(items, discountPercent = 0) {",
    "  const sum = items.reduce((acc, item) => acc + item.price * item.quantity, 0);",
    "  return Math.round((sum * discountPercent) / 100);",
    "}",
    "",
  ].join("\n"),
  "calc/price.test.js": [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    "",
    'import { total } from "./price.js";',
    "",
    'test("adds up the items", () => {',
    "  assert.equal(total([{ price: 250, quantity: 2 }, { price: 100, quantity: 1 }]), 600);",
    "});",
    "",
    'test("takes the discount off", () => {',
    "  assert.equal(total([{ price: 1000, quantity: 1 }], 10), 900);",
    "});",
    "",
  ].join("\n"),
};

const PROMPT = "Run the tests with node --test, then fix the code so they pass.";

/** The project folder. */
let calc = "";
/** The chat working in it. */
let taskId = "";

/** The tests, run as a reader would run them: through `node`, never as a new executable. Throws when one fails. */
const runTests = () => execFileSync(process.execPath, ["--test"], { cwd: calc, encoding: "utf8", stdio: "pipe" });

const waiting = (walk: { taviJson<T>(...args: string[]): T }) =>
  walk.taviJson<Pending>("approvals", "list").rows.filter((row) => row.record.taskId === taskId);

/** The chat's last card, once its decision buttons are there. */
async function card(page: Page) {
  await page.getByText("Needs your approval").last().waitFor({ timeout: 180_000 });
  const round = page.locator("section.round").last();
  await round.getByRole("button", { name: "Allow once" }).waitFor();
  return round;
}

walkGuide("files-and-code/fix-a-failing-test", {
  configured: true,
  model: true,
  steps: {
    "ask-tavi-to-fix-the-test": async (walk) => {
      calc = join(projectsFolder("fix-a-failing-test", PROJECT), "calc");
      expect(runTests, "the project's test fails before the fix").toThrow();
      await restartOwner(walk.dataDir, ["--fs-root", join(calc, "..")]);
      const screen = await walk.terminal({
        title: "tavi run",
        args: ["run", "--folder", calc, PROMPT],
        tty: true,
        cols: 140,
        // It asks at the terminal; Ctrl-C leaves the call waiting for the canvas.
        input: [
          { until: "\\[y/s/a/N\\]", wait: 180 },
          { text: "\u0003", wait: 3 },
        ],
      });
      // The approval says what it runs in words: the tool's id is the canvas card's.
      expect(screen.join("\n")).toMatch(/Run “node --test” in the sandbox/);
      taskId = chats(walk.tavi).find((chat) => chat.chatKind === "run")?.taskId ?? "";
      expect(waiting(walk).map((row) => row.record.toolId)).toEqual(["sandbox.run"]);
    },
    "let-it-run-the-tests": async (walk) => {
      const page = await walk.open(`/tasks/${taskId}`);
      const round = await card(page);
      await expect(round.textContent()).resolves.toMatch(/node --test/);
      await walk.shot(round);
      await round.getByRole("button", { name: "Allow for this chat" }).click();
      // The run fails, Tavi reads the code, and stops again at the change it wants to make.
      await expect
        .poll(() => waiting(walk).map((row) => row.record.toolId), { timeout: 180_000, interval: 2_000 })
        .toEqual([expect.stringMatching(/^fs\.(edit|write)$/)]);
    },
    "check-the-fix-before-it-s-written": async (walk) => {
      const page = await walk.page();
      const round = await card(page);
      await round.getByText("Details", { exact: true }).click();
      const diff = round.locator(".call-command").first();
      await diff.waitFor();
      // The diff box shows a few lines at a time: scrolled to the lines the change takes out and puts in.
      await diff.evaluate((box: HTMLElement) => {
        const line = [...box.querySelectorAll("*")].find((node) => /^[-+]\s/.test(node.textContent ?? ""));
        if (line instanceof HTMLElement) box.scrollTop = Math.max(0, line.offsetTop - box.offsetTop - 24);
      });
      expect(() => runTests(), "nothing is written while the card waits").toThrow();
      await page.setViewportSize({ width: 1280, height: 1200 });
      await round.scrollIntoViewIfNeeded();
      await walk.shot(round);
      await page.setViewportSize({ width: 1280, height: 800 });
      await round.getByRole("button", { name: "Allow once" }).click();
    },
    "see-the-tests-pass": async (walk) => {
      const page = await walk.page();
      // Until the turn ends; a test command the chat's grant does not cover (another spelling) is allowed once.
      const done = page
        .locator("main .task-header")
        .getByText(/^(ready|completed)$/)
        .first();
      const deadline = Date.now() + 240_000;
      while (!(await done.isVisible())) {
        if (Date.now() > deadline) throw new Error("the chat did not finish");
        if (waiting(walk).length > 0) {
          const round = await card(page);
          await round.getByRole("button", { name: "Allow once" }).click();
        }
        await page.waitForTimeout(2_000);
      }
      expect(runTests()).toMatch(/# pass 2/);
      await walk.shot(undefined, { mask: [page.locator("main .markdown")], frame: "answer" });
    },
  },
});
