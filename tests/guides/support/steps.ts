import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { delay } from "@tavi/test-support";
import { expect, onTestFinished } from "vitest";

import type { Locator, Page } from "../../../scripts/docs/browser.mjs";
import { cli, MODEL, type TerminalSpec } from "../../../scripts/docs/session.mjs";
import { keyFile, ownerServing, ownerStopped, showFolderAs } from "./walk.js";

/**
 * What several guide walks do the same way: read the owner's chats and setup
 * checklist back, connect the model as a reader's `tavi setup` would, send a
 * message from the canvas's composer, and leave a run waiting on you.
 */

/** Runs a tavi command on the walk's data directory and returns what it printed (`walk.tavi`). */
type Tavi = (...args: string[]) => string;

export interface Chat {
  readonly taskId: string;
  readonly status: string;
  readonly chatKind?: string;
  readonly title?: string;
  readonly memoryMode?: string;
  readonly parentChatId?: string;
}

/** The chats and workers the owner keeps, newest first (`tavi tasks`). */
export const chats = (tavi: Tavi): Chat[] => (JSON.parse(tavi("tasks")) as { tasks: Chat[] }).tasks;

/** Home's task id. */
export function homeId(tavi: Tavi): string {
  const home = chats(tavi).find((chat) => chat.chatKind === "home");
  if (home === undefined) throw new Error("no Home chat yet");
  return home.taskId;
}

/** A setup step's state on the checklist (`tavi onboard status`): `done`, `todo`, `blocked` or `skipped`. */
export function checklistState(tavi: Tavi, kind: string): string | undefined {
  const status = JSON.parse(tavi("onboard", "status", "--format", "json")) as {
    readonly steps: readonly { readonly kind: string; readonly state: string }[];
  };
  return status.steps.find((step) => step.kind === kind)?.state;
}

/**
 * Connects the walks' OpenRouter model from the key file, as `tavi setup --non-interactive` does for a reader:
 * the key is never typed.
 */
export function connectModel(tavi: Tavi): void {
  tavi("setup", "--non-interactive", "--preset", "openrouter", "--key-file", keyFile, "--model", MODEL.main, "--fast-model", MODEL.fast);
}

/**
 * Runs `tavi run <prompt>` and leaves it waiting on you: it exits 3 while an approval waits and 7 while a
 * question does. Any other way of ending is a failure.
 */
export function leaveWaiting(tavi: Tavi, prompt: string): void {
  try {
    tavi("run", prompt);
  } catch (error) {
    const status = (error as { readonly status?: number }).status;
    if (status !== 3 && status !== 7) throw error;
    return;
  }
  throw new Error(`tavi run "${prompt}" finished instead of waiting on you`);
}

/** Dismisses Home's setup checklist when it shows: a reader who walked through Welcome has none over the chat. */
export async function dismissChecklist(page: Page): Promise<void> {
  const shown = await page
    .getByRole("heading", { name: /Setup checklist/ })
    .waitFor({ timeout: 8_000 })
    .then(
      () => true,
      () => false,
    );
  if (shown)
    await page
      .getByRole("button", { name: "Dismiss", exact: true })
      .first()
      .click({ timeout: 10_000 })
      .catch(() => undefined);
}

/** `question` asked in `tavi chat` on a terminal, until the turn says Done: the screen's lines. */
export function askInChat(
  walk: { terminal(spec: TerminalSpec & { readonly title: string }): Promise<string[]> },
  question: string,
): Promise<string[]> {
  return walk.terminal({
    title: "tavi chat",
    args: ["chat"],
    tty: true,
    input: [{ wait: 4 }, { text: question, wait: 1 }, { text: "\r" }, { until: "Done\\.", wait: 120 }],
  });
}

/** Tavi's latest answer, scrolled into view. */
export async function lastAnswer(page: Page): Promise<Locator> {
  const answer = page
    .locator("article")
    .filter({ has: page.getByRole("button", { name: /^Copy response/ }) })
    .last();
  await answer.scrollIntoViewIfNeeded();
  return answer;
}

/** Sends `text` from the chat's composer and waits for the approval card it leads to, settled with its decision buttons. */
export async function askForApproval(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox").last();
  await composer.fill(text);
  await composer.press("Enter");
  await page.getByText("Needs your approval").last().waitFor({ timeout: 180_000 });
  await page.getByRole("button", { name: "Allow once" }).last().waitFor();
}

/** Until the chat's turn has ended: its header says ready (Home) or completed (any other chat). */
export async function turnEnded(page: Page): Promise<void> {
  await page
    .locator("main .task-header")
    .getByText(/^(ready|completed)$/)
    .first()
    .waitFor({ timeout: 180_000 });
}

/** Allows the waiting card once, and waits for the turn it held to end. */
export async function allowOnce(page: Page): Promise<void> {
  await page.locator("section.round").last().getByRole("button", { name: "Allow once" }).click();
  await turnEnded(page);
}

/**
 * Scrolls a tool result's box (it scrolls inside itself) so the line holding `text` is at its top: where the step
 * points, whatever lines wrap above it.
 */
export async function scrollResultTo(result: Locator, text: string): Promise<void> {
  await result.evaluate((element, wanted) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = (node.textContent ?? "").indexOf(wanted);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);
      element.scrollTop += range.getBoundingClientRect().top - element.getBoundingClientRect().top - 8;
      return;
    }
  }, text);
}

/** Opens the chats list when the canvas has it folded away. */
export async function showChats(page: Page): Promise<void> {
  const show = page.getByRole("button", { name: "Show chats" });
  if (await show.isVisible()) await show.click();
}

/** Sends `text` from the composer and waits for its answer to finish: a new answer, and nothing left queued. */
export async function send(page: Page, text: string): Promise<void> {
  const box = page.locator(".composer-box textarea");
  const answers = page.getByRole("button", { name: "Copy response" });
  const before = await answers.count();
  await box.fill(text);
  await box.press("Enter");
  await expect
    .poll(() => answers.count(), { timeout: 120_000, interval: 1_000 })
    .toBeGreaterThan(before)
    .catch(async (error: unknown) => {
      // An answer that never came because the turn stopped on an approval: say which, rather than only that time ran out.
      const card = page.locator("section.round").filter({ hasText: "Needs your approval" }).last();
      if ((await card.count()) > 0)
        throw new Error(`"${text}" stopped on an approval: ${((await card.textContent()) ?? "").slice(0, 300)}`);
      throw error;
    });
  await expect.poll(async () => (await box.getAttribute("placeholder")) ?? "", { timeout: 30_000 }).not.toMatch(/^Queue/);
}

/**
 * Makes the system's temporary folder its real path (on macOS `/var/folders/…` is `/private/var/folders/…`), so the
 * throwaway data directory and the folders a walk makes there are spelled as the owner prints them and the pictures'
 * redaction finds them. Call it at the top of a walk that shows a folder's path.
 */
export function useRealTmpdir(): void {
  process.env["TMPDIR"] = realpathSync(tmpdir());
}

/** The owner's environment, as the session gives its children: none of the caller's TAVI_* settings, a fixed zone. */
function ownerEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TAVI_")));
  return { ...env, TAVI_CREDENTIAL_KEYCHAIN: "off", TZ: "Europe/London", LANG: "en_US.UTF-8" };
}

const ownerRunning = (dataDir: string): boolean =>
  spawnSync("pgrep", ["-f", `serve .*--data-dir ${dataDir}$`], { encoding: "utf8" }).stdout.trim() !== "";

/**
 * Stops the walk's `tavi serve` and starts it again with `flags` (such as `--fs-root <dir>`), as a reader restarts
 * theirs with a new flag. Call it before the canvas is first opened. The new owner is stopped when the walk ends.
 */
export async function restartOwner(dataDir: string, flags: readonly string[]): Promise<void> {
  ownerStopped();
  spawnSync("pkill", ["-TERM", "-f", `serve .*--data-dir ${dataDir}$`]);
  for (let waited = 0; ownerRunning(dataDir); waited += 250) {
    if (waited > 30_000) throw new Error("the walk's owner did not stop");
    await delay(250);
  }
  const args = [cli, "serve", "--connection", MODEL.connection, "--model", MODEL.main, ...flags, "--data-dir", dataDir];
  const owner: ChildProcess = spawn(process.execPath, args, { env: ownerEnv(), stdio: ["ignore", "pipe", "pipe"] });
  onTestFinished(async () => {
    if (owner.exitCode !== null || owner.signalCode !== null) return;
    const ended = new Promise((resolve) => owner.once("exit", resolve));
    owner.kill("SIGTERM");
    const force = setTimeout(() => owner.kill("SIGKILL"), 15_000);
    await ended;
    clearTimeout(force);
    // A turn still running holds the owner's drain up to its deadline: longer than a hook's default ten seconds.
  }, 30_000);
  let seen = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tavi serve did not start: ${seen.slice(-400)}`)), 60_000);
    const read = (chunk: Buffer) => {
      seen += chunk.toString();
      if (/"serving": true/.test(seen)) {
        clearTimeout(timer);
        ownerServing();
        resolve();
      }
    };
    owner.stdout?.on("data", read);
    owner.stderr?.on("data", read);
    owner.once("exit", (code) => reject(new Error(`tavi serve exited ${code}: ${seen.slice(-400)}`)));
  });
}

/**
 * A folder of projects the walk makes, as a reader's `~/code`: `files` (paths relative to it, and their text) are
 * written into `<tmp>/tavi-guide-<slug>/code`, which is returned, and the folder is deleted when the walk ends. Its
 * path is the same on every run, so the pictures that show it do not change; `slug` keeps walks run together apart.
 */
export function projectsFolder(slug: string, files: Readonly<Record<string, string>>): string {
  const top = join(realpathSync(tmpdir()), `tavi-guide-${slug}`);
  rmSync(top, { recursive: true, force: true });
  const code = join(top, "code");
  mkdirSync(code, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(code, path)), { recursive: true });
    writeFileSync(join(code, path), text);
  }
  onTestFinished(() => rmSync(top, { recursive: true, force: true }));
  // The pages call the reader's project folder ~/code: so do the pictures, not the walk's temporary one.
  showFolderAs(code, "~/code");
  return code;
}
