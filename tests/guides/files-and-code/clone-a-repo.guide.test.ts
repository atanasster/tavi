import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect } from "vitest";

import type { Page } from "../../../scripts/docs/browser.mjs";
import { chats, homeId, projectsFolder, restartOwner, showChats, useRealTmpdir, dismissChecklist } from "../support/steps.js";
import { walkGuide } from "../support/walk.js";

useRealTmpdir();

interface Pending {
  readonly rows: readonly { readonly record: { readonly taskId: string; readonly toolId: string } }[];
}

/** The reader's `~/code`, holding the bare repository `recipes.git`. */
let code = "";
/** The chat that clones the repository. */
let taskId = "";

type Walk = { tavi(...args: string[]): string; taviJson<T>(...args: string[]): T; readonly dataDir: string };

const pending = (walk: Walk) => walk.taviJson<Pending>("approvals", "list").rows.filter((row) => row.record.taskId === taskId);
const status = (walk: Walk) => chats(walk.tavi).find((chat) => chat.taskId === taskId)?.status;
const clone = (walk: Walk) => join(walk.dataDir, "chats/default", taskId, "recipes");

/** Until the chat waits on an approval (true) or has finished its turn (false). */
async function nextStop(walk: Walk): Promise<boolean> {
  let waiting = false;
  await expect
    .poll(
      () => {
        waiting = pending(walk).length > 0;
        return waiting || status(walk) === "completed";
      },
      { timeout: 180_000, interval: 1_000 },
    )
    .toBe(true);
  return waiting;
}

/** The waiting card on the canvas, settled once its decision buttons are there. */
async function card(page: Page) {
  await page.getByRole("button", { name: "Allow once" }).last().waitFor({ timeout: 60_000 });
  return page.locator("section.round").last();
}

/**
 * A repository as one on the reader's computer: one commit, by a made-up author at a fixed time (so its id is the
 * same on every run), cloned bare into `code/recipes.git`.
 */
function makeRepository(): void {
  const top = dirname(code);
  // The sandbox's git signs commits as your global git identity: the walk's is a made-up one.
  const gitconfig = join(top, "gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = Alex Example\n\temail = alex@example.com\n");
  process.env["GIT_CONFIG_GLOBAL"] = gitconfig;
  const source = join(top, "recipes");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: top,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-01T09:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T09:00:00Z" },
    });
  git("init", "-q", "-b", "main", source);
  writeFileSync(join(source, "README.md"), "# Recipes\n");
  writeFileSync(join(source, "pancakes.md"), "# Pancakes\n\nFlour, eggs and milk.\n");
  git("-C", source, "add", ".");
  git("-C", source, "commit", "-q", "-m", "First recipes");
  git("clone", "-q", "--bare", source, join(code, "recipes.git"));
  rmSync(source, { recursive: true, force: true });
}

walkGuide("files-and-code/clone-a-repo", {
  configured: true,
  model: true,
  steps: {
    "ask-tavi-to-clone-a-repository": async (walk) => {
      code = projectsFolder("clone-a-repo", { "README.md": "Projects.\n" });
      makeRepository();
      await restartOwner(walk.dataDir, ["--fs-root", code]);
      // The one-time link signs the canvas in from the page itself: let it finish before moving on.
      await (await walk.page()).getByText("connected", { exact: true }).first().waitFor({ timeout: 30_000 });
      const page = await walk.open("/");
      await dismissChecklist(page);
      await showChats(page);
      const fresh = page.getByRole("button", { name: /^New (side )?chat$/ }).first();
      await fresh.click();
      const composer = page.locator(".composer-box textarea");
      await composer.fill(`Clone the git repository at ${join(code, "recipes.git")} into a folder called recipes.`);
      await composer.press("Enter");
      await expect
        .poll(() => walk.taviJson<Pending>("approvals", "list").rows.length, { timeout: 180_000, interval: 1_000 })
        .toBeGreaterThan(0);
      const round = await card(page);
      const rows = walk.taviJson<Pending>("approvals", "list").rows;
      expect(rows.map((row) => row.record.toolId)).toEqual(["sandbox.run"]);
      taskId = rows[0]?.record.taskId ?? "";
      await expect(round.textContent()).resolves.toMatch(/git clone/);
      await walk.shot(round);
      await round.getByRole("button", { name: "Allow once" }).click();
      expect(await nextStop(walk)).toBe(false);
      expect(existsSync(join(clone(walk), "pancakes.md"))).toBe(true);
    },
    "look-at-its-history": async (walk) => {
      const page = await walk.page();
      const decided = walk.taviJson<{ items: readonly unknown[] }>("approvals", "history").items.length;
      const answers = page.getByRole("button", { name: "Copy response" });
      const before = await answers.count();
      const composer = page.locator(".composer-box textarea");
      await composer.fill("Show the commits in recipes, one line each.");
      await composer.press("Enter");
      // recipes is a repository in a subfolder, whose own config git would read: even git log there asks first.
      const round = await card(page);
      await expect(round.textContent()).resolves.toMatch(/git\b.*\blog\b/);
      await round.getByRole("button", { name: "Allow once" }).click();
      expect(await nextStop(walk)).toBe(false);
      expect(walk.taviJson<{ items: readonly unknown[] }>("approvals", "history").items.length).toBe(decided + 1);
      await expect.poll(() => answers.count(), { timeout: 60_000 }).toBeGreaterThan(before);
      await answers.last().scrollIntoViewIfNeeded();
      await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
    },
    "change-a-file-and-commit-it": async (walk) => {
      const page = await walk.page();
      const composer = page.locator(".composer-box textarea");
      await composer.fill("Add a recipe for scrambled eggs in recipes/eggs.md and commit it.");
      await composer.press("Enter");
      // The chat still reads completed from the last turn until this one starts: wait for it, or for its first card.
      await expect.poll(() => pending(walk).length > 0 || status(walk) !== "completed", { timeout: 60_000, interval: 500 }).toBe(true);
      let pictured = false;
      for (let round = 0; round < 8 && (await nextStop(walk)); round++) {
        const waiting = await card(page);
        // The picture is the commit's card, as the reader decides it.
        if (!pictured && /git .*commit/.test((await waiting.textContent()) ?? "")) {
          await walk.shot(waiting);
          pictured = true;
        }
        await waiting.getByRole("button", { name: "Allow once" }).click();
        await expect.poll(() => pending(walk).length, { timeout: 30_000 }).toBe(0);
      }
      expect(pictured, "a card for git commit").toBe(true);
      const log = execFileSync("git", ["-C", clone(walk), "log", "--format=%an %s"], { encoding: "utf8" });
      expect(log.trim().split("\n")).toHaveLength(2);
      expect(log).toMatch(/^Alex Example /);
    },
    "start-a-new-repository": async (walk) => {
      const screen = await walk.terminal({
        title: "tavi chat",
        args: ["chat"],
        tty: true,
        cols: 140,
        input: [
          { wait: 4 },
          { text: "Start a new git repository in a folder called notes.", wait: 1 },
          { text: "\r" },
          { until: "a always", wait: 180 },
          { text: "y", wait: 2 },
          { until: "Done\\.", wait: 180 },
        ],
      });
      expect(screen.join("\n")).toMatch(/git (?:-C \S+ )?init/);
      expect(existsSync(join(walk.dataDir, "chats/default", homeId(walk.tavi), "notes/.git"))).toBe(true);
    },
    "find-the-files": async (walk) => {
      const page = await walk.open(`/tasks/${taskId}`);
      // The panel hangs to the right of the chip: the window is wide enough to show it whole.
      await page.setViewportSize({ width: 1920, height: 1000 });
      await page.locator(".folder-chip:visible").last().click();
      const panel = page.locator(".folder-panel");
      await panel.getByRole("button", { name: "Open recipes" }).click();
      await panel.getByRole("button", { name: "Download eggs.md" }).waitFor();
      await walk.shot(panel);
      await page.setViewportSize({ width: 1280, height: 800 });
    },
  },
});
