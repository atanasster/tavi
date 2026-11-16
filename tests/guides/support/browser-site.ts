import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { delay } from "@tavi/test-support";
import { afterAll, expect } from "vitest";

import { type Locator, type Page, root } from "../../../scripts/docs/browser.mjs";
import { cli, MODEL } from "../../../scripts/docs/session.mjs";
import { showChats } from "./steps.js";

/**
 * What the browser guides' walks share: a made-up website on 127.0.0.1
 * (`tests/guides/fixtures/harbour-lane-books/server.mjs`), served in its own
 * process so a CLI read-back that blocks the walk never blocks the page, and
 * an owner the browser may open it from. The browser never opens this
 * machine unless the operator lists its `host:port` with
 * `tavi serve --browser-allow-host`, so the walk stops the session's owner and
 * starts one with that flag, on the same data directory. Everything it starts
 * is stopped when the file's walk ends.
 */

export interface FixtureSite {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** `127.0.0.1:<port>`: what `--browser-allow-host` lists. */
  readonly host: string;
  /** The seats picked on `/seats` so far, in order. */
  readonly chosen: readonly string[];
}

/** The children's environment, as the session gives its own: none of the caller's TAVI_* settings, no keychain, a fixed zone. */
const env = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TAVI_"))),
  TAVI_CREDENTIAL_KEYCHAIN: "off",
  TZ: "Europe/London",
  LANG: "en_US.UTF-8",
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Until `child` has exited, sending SIGTERM first and SIGKILL after five seconds. */
function stop(child: ChildProcess | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return resolve();
    const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * The fixture site and its owner for one walk file: call it at the top of the
 * file. `open(dataDir)` (once per walk; later calls return the same site)
 * starts the site and restarts the owner with it allowed; `stopOwner()` and
 * `startOwner()` stop and start that owner, for commands that run only on the
 * data directory. The owner runs `main` (the pinned model unless a walk needs another).
 */
export function fixtureSite(main: string = MODEL.main): {
  open(dataDir: string): Promise<FixtureSite>;
  stopOwner(): Promise<void>;
  startOwner(): Promise<void>;
} {
  let site: ChildProcess | undefined;
  let owner: ChildProcess | undefined;
  let directory: string | undefined;
  let opened: Promise<FixtureSite> | undefined;
  let host = "";

  const startOwner = async (): Promise<void> => {
    const dataDir = directory as string;
    const args = ["serve", "--connection", MODEL.connection, "--model", main, "--browser-allow-host", host];
    const child = spawn(process.execPath, [cli, ...args, "--data-dir", dataDir], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
    owner = child;
    let seen = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`tavi serve did not start: ${seen.slice(-400)}`)), 60_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        seen += String(chunk);
        if (/"serving": true/.test(seen)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        seen += String(chunk);
      });
      child.once("exit", (code) => reject(new Error(`tavi serve exited ${code}: ${seen.slice(-400)}`)));
    });
  };

  /** Stops whichever owner holds the data directory: the session's, by the pid it recorded, or ours. */
  const stopOwner = async (): Promise<void> => {
    if (owner !== undefined) {
      await stop(owner);
      owner = undefined;
      return;
    }
    const record = join(directory as string, "owner.process.json");
    if (!existsSync(record)) return;
    const { pid } = JSON.parse(readFileSync(record, "utf8")) as { readonly pid: number };
    if (!alive(pid)) return;
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 30_000;
    while (alive(pid) && Date.now() < deadline) await delay(200);
    if (alive(pid)) throw new Error(`the session's owner (pid ${pid}) did not stop`);
  };

  afterAll(async () => {
    await stop(owner);
    await stop(site);
    // The session deletes its data directory before this owner has stopped: what the owner wrote after that goes too.
    if (directory !== undefined && existsSync(directory))
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 60_000);

  return {
    open(dataDir) {
      opened ??= (async () => {
        directory = dataDir;
        const child = spawn(process.execPath, [join(root, "tests/guides/fixtures/harbour-lane-books/server.mjs")], {
          stdio: ["ignore", "pipe", "inherit"],
        });
        site = child;
        const chosen: string[] = [];
        const origin = await new Promise<string>((resolve, reject) => {
          let buffered = "";
          child.once("exit", (code) => reject(new Error(`the fixture site exited ${code}`)));
          child.stdout?.on("data", (chunk: Buffer) => {
            buffered += String(chunk);
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";
            for (const line of lines) {
              if (line.startsWith("http://")) resolve(line.trim());
              else if (line.startsWith("chosen ")) chosen.push(line.slice("chosen ".length).trim());
            }
          });
        });
        host = new URL(origin).host;
        await stopOwner();
        await startOwner();
        return { origin, host, chosen };
      })();
      return opened;
    },
    stopOwner,
    startOwner,
  };
}

/** Opens a new chat on the canvas, out of the way of the setup checklist a reader who skipped Welcome still has. */
export async function newChat(page: Page): Promise<void> {
  await showChats(page);
  await page
    .getByRole("button", { name: "Dismiss", exact: true })
    .first()
    .click({ timeout: 8_000 })
    .catch(() => undefined);
  const button = page.getByRole("button", { name: /^New (side )?chat$/ }).first();
  // The button can stay away from a page opened on a busy machine: a reload brings it.
  await button.waitFor({ timeout: 20_000 }).catch(async () => {
    await page.reload();
    await showChats(page);
  });
  await button.click({ timeout: 60_000 });
}

/** Sends `text` from the composer; returns how many answers the chat had before it, for `allowUntilAnswered`. */
export async function sendPrompt(page: Page, text: string): Promise<number> {
  const box = page.locator(".composer-box textarea");
  const before = await page.getByRole("button", { name: "Copy response" }).count();
  await box.fill(text);
  await box.press("Enter");
  return before;
}

/** The newest decision card's first of **Allow for this chat** and **Allow once**. */
const decision = (page: Page): Locator => {
  const card = page.locator("section.round").last();
  return card
    .getByRole("button", { name: "Allow for this chat" })
    .or(card.getByRole("button", { name: "Allow once" }))
    .first();
};

/** Until a decision card is up (its buttons drawn), for at most `timeoutMs`: the card. */
export async function nextCard(page: Page, timeoutMs = 240_000): Promise<Locator> {
  await decision(page).waitFor({ timeout: timeoutMs });
  // The card has settled once its buttons are there: give its text a moment to finish drawing.
  await page.waitForTimeout(500);
  return page.locator("section.round").last();
}

/**
 * Answers every card the turn shows with the first of **Allow for this
 * chat** and **Allow once** it offers, calling `onCard` with each card first,
 * until a new answer is in (more than `before`). Returns how many cards it
 * answered. A turn that fails throws, with what the chat says.
 */
export async function allowUntilAnswered(
  page: Page,
  before: number,
  options: { readonly onCard?: (card: Locator, index: number) => Promise<void>; readonly timeoutMs?: number } = {},
): Promise<number> {
  const box = page.locator(".composer-box textarea");
  const answers = page.getByRole("button", { name: "Copy response" });
  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  let cards = 0;
  while (Date.now() < deadline) {
    const decide = decision(page);
    if (await decide.isVisible()) {
      await page.waitForTimeout(500);
      await options.onCard?.(page.locator("section.round").last(), cards);
      // The card may go before the click lands (the turn moved on): look again rather than fail.
      if (
        !(await decide.click({ timeout: 10_000 }).then(
          () => true,
          () => false,
        ))
      )
        continue;
      cards++;
      await decide.waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
      continue;
    }
    if ((await answers.count()) > before && (await box.getAttribute("placeholder"))?.startsWith("Queue") !== true) return cards;
    if (await page.getByRole("button", { name: "Retry" }).isVisible()) {
      throw new Error(`the turn failed: ${((await page.locator("main").textContent()) ?? "").slice(-600)}`);
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error("no answer within the time limit");
}

/** Sends `text` and allows what its turn asks (`allowUntilAnswered`). */
export async function askAndAllow(
  page: Page,
  text: string,
  options: { readonly onCard?: (card: Locator, index: number) => Promise<void>; readonly timeoutMs?: number } = {},
): Promise<number> {
  return allowUntilAnswered(page, await sendPrompt(page, text), options);
}

/** The newest chat's task id (`tavi tasks`, newest first). */
export function newestTask(tavi: (...args: string[]) => string): string {
  const { tasks } = JSON.parse(tavi("tasks")) as { readonly tasks: readonly { readonly taskId: string }[] };
  const first = tasks[0];
  if (first === undefined) throw new Error("no task yet");
  return first.taskId;
}

export interface ToolCall {
  readonly toolName: string;
  readonly status: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly output?: unknown;
}

/** The tool calls a task made, with what each answered (`tavi tasks <task-id>`). */
export function toolCalls(tavi: (...args: string[]) => string, taskId: string): readonly ToolCall[] {
  const shown = JSON.parse(tavi("tasks", taskId)) as { readonly history?: { readonly tools?: readonly ToolCall[] } };
  return shown.history?.tools ?? [];
}

/**
 * Signs in on the page under your control, from its focused username field: the username, Tab, the password, then
 * `shot` (the step's picture), then Enter. A picture takes focus off that page, so it is given back first.
 */
export async function typeSignIn(page: Page, user: string, password: string, shot: () => Promise<void>): Promise<void> {
  await page.keyboard.type(user, { delay: 30 });
  await page.keyboard.press("Tab");
  await page.keyboard.type(password, { delay: 30 });
  await page.waitForTimeout(1_500);
  await shot();
  await page.locator(".takeover-page").focus();
  await page.keyboard.press("Enter");
}

/** The bookshop's host as a recipe names it: no port, no `www.`. */
export const BOOKSHOP_HOST = "127.0.0.1";

/** `findBooks` on the fixture site, until the bookshop's recipe is kept: the first step of the walks about recipes. */
export async function findBooksForRecipe(
  walk: Parameters<typeof findBooks>[0] & { readonly dataDir: string; taviJson<T>(...args: string[]): T },
  site: ReturnType<typeof fixtureSite>,
): Promise<Page> {
  const { origin } = await site.open(walk.dataDir);
  return findBooks(walk, origin, () =>
    walk
      .taviJson<{ readonly recipes: readonly { readonly host: string }[] }>("browser", "recipes")
      .recipes.some((recipe) => recipe.host === BOOKSHOP_HOST),
  );
}

/**
 * The bookshop walks' first step: in a new chat, Tavi opens the shop, shows the Fiction shelf in stock and by
 * price, and lists the books with browser.extract, which keeps the site's recipe (`kept`). A model that read the page
 * instead is asked once more, plainly. Returns the page, with the step's picture taken.
 */
export async function findBooks(
  walk: {
    open(route: string): Promise<Page>;
    shot(target?: Locator, options?: { readonly mask?: readonly Locator[]; readonly frame?: "answer" }): Promise<void>;
  },
  origin: string,
  kept: () => boolean,
): Promise<Page> {
  const page = await walk.open("/");
  await newChat(page);
  await askAndAllow(
    page,
    `Open ${origin}/ in the browser, show the Fiction shelf, tick In stock only, choose Sort by price, then use browser.extract to list the books shown with their authors and prices.`,
  );
  if (!kept()) await askAndAllow(page, "Now use browser.extract on that page to list the books (title, author, price).");
  if (!kept()) throw new Error("no recipe was kept for the bookshop");
  await walk.shot(undefined, { mask: [page.locator("main .markdown")], frame: "answer" });
  return page;
}

/** Until Tavi asks for you in the browser: the browser cards on the way are allowed for this chat, as the guide says. */
export async function untilHandoff(page: Page, count: number): Promise<void> {
  const take = page.locator(".handoff-card").getByRole("button", { name: "Take control" });
  for (const started = Date.now(); Date.now() - started < 240_000; ) {
    if ((await take.count()) >= count && (await take.last().isVisible())) return;
    const allow = page.locator("section.round").getByRole("button", { name: "Allow for this chat" });
    if ((await allow.count()) > 0 && (await allow.last().isEnabled()))
      await allow
        .last()
        .click({ timeout: 5_000 })
        .catch(() => undefined);
    await page.waitForTimeout(1_000);
  }
  throw new Error(`Tavi never asked for you in the browser: ${((await page.locator("main").textContent()) ?? "").slice(-1_500)}`);
}

/** The page under your control, once its first picture has come. */
export async function takeover(page: Page): Promise<void> {
  await page.getByText("You're in control — Tavi is paused").waitFor({ timeout: 60_000 });
  await page.locator(".takeover-page img").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1_500);
}

/** Clicks the page under your control where it has nothing to click, so the keys that follow go to it. */
export async function clickPage(page: Page): Promise<void> {
  const picture = page.locator(".takeover-page img");
  const box = await picture.boundingBox();
  if (box === null) throw new Error("the page under your control is not shown");
  await picture.click({ position: { x: 12, y: box.height - 12 } });
  await page.locator(".takeover-page").focus();
}

/** Presses Tab `times` times in the page under your control. */
export async function tab(page: Page, times: number): Promise<void> {
  for (let index = 0; index < times; index++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(150);
  }
}

/**
 * With Tavi asking for you at a made-up site's sign-in: take control, sign in with the site's test username and
 * password (past its two header links, Tab reaches the username), `shot` pictures it as `typeSignIn` does, then hand
 * the browser back.
 */
export async function signInYourself(
  page: Page,
  site: { readonly user: string; readonly password: string; readonly requests: readonly string[] },
  shot: () => Promise<void>,
): Promise<void> {
  await page.locator(".handoff-card").last().getByRole("button", { name: "Take control" }).click();
  await takeover(page);
  await clickPage(page);
  await tab(page, 3);
  await typeSignIn(page, site.user, site.password, shot);
  await expect.poll(() => site.requests.includes("POST /login"), { timeout: 20_000 }).toBe(true);
  await page.waitForTimeout(1_500);
  await page.getByRole("button", { name: "Done — hand back" }).click();
  await page.getByRole("button", { name: "Hand back", exact: true }).click();
}

/**
 * Answers the browser's cards until the turn is over (at most `timeoutMs`): Allow for this chat where a card offers it,
 * else Allow once, as a page's form asks each time; a card whose text matches `refuse` is denied instead.
 */
export async function browserUntilEnded(
  page: Page,
  options: { readonly refuse?: RegExp; readonly timeoutMs?: number } = {},
): Promise<void> {
  const over = page
    .locator("main .task-header")
    .getByText(/^(ready|completed)$/)
    .first();
  const round = page.locator("section.round").last();
  for (const started = Date.now(); !(await over.isVisible()); await page.waitForTimeout(1_000)) {
    if (Date.now() - started > (options.timeoutMs ?? 300_000))
      throw new Error(`the turn did not end: ${((await page.locator("main").textContent()) ?? "").slice(-1_500)}`);
    if ((await round.getByRole("button", { name: "Deny…" }).count()) === 0) continue;
    if (options.refuse?.test((await round.textContent()) ?? "") === true) {
      await round
        .getByRole("button", { name: "Deny…" })
        .click({ timeout: 5_000 })
        .catch(() => undefined);
      await round
        .getByRole("button", { name: "Deny", exact: true })
        .click({ timeout: 5_000 })
        .catch(() => undefined);
      continue;
    }
    const allow = round.getByRole("button", { name: /^(Allow for this chat|Allow once)$/ }).first();
    if (await allow.isEnabled().catch(() => false)) await allow.click({ timeout: 5_000 }).catch(() => undefined);
  }
}
