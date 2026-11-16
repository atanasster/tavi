/**
 * What the account-backed connected-apps and desktop walks share: an app read back as `tavi apps show` has it, the
 * person's Google client given from its file, the address of a sign-in the canvas opened (handed to the person, who
 * signs in in their own browser, never in the walk's), and the desktop helper the person built once.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { delay, temporaryDirectories } from "@tavi/test-support";
import { expect } from "vitest";

import type { Locator, Page } from "../../../scripts/docs/browser.mjs";
import { allowUntilAnswered, newChat, newestTask, toolCalls } from "./browser-site.js";
import { pick } from "./rooms.js";
import { allowOnce, restartOwner, send } from "./steps.js";
import { account, accountsFolder, askFile, askUser, secretPath } from "./user.js";

/** What these walks need of the walk: its data directory and the CLI bound to it. */
interface Walk {
  readonly dataDir: string;
  tavi(...args: string[]): string;
  taviJson<T = unknown>(...args: string[]): T;
  page(): Promise<Page>;
  open(path: string): Promise<Page>;
}

/** One account of `tavi apps show <app> --format json`: the fields these walks read. */
export interface AppAccount {
  readonly accountId: string;
  readonly health: string;
  readonly identity?: string;
  readonly signedInAt?: string;
  readonly on?: boolean;
  readonly mailbox?: string;
  readonly calendar?: boolean;
  readonly receives?: boolean;
}

/** `tavi apps show <app> --format json`: the fields these walks read. */
export interface ShownApp {
  readonly appId: string;
  readonly health: string;
  readonly accounts: readonly AppAccount[];
  readonly tools: readonly {
    readonly toolId: string;
    readonly state: string;
  }[];
}

/** The app as the owner has it now. */
export const shownApp = (walk: Walk, appId: string): ShownApp => walk.taviJson<{ app: ShownApp }>("apps", "show", appId).app;

/** Whether an account of the app is signed in: an MCP sign-in says when; a channel account (Google) names who it is. */
export const signedIn = (walk: Walk, appId: string): boolean =>
  shownApp(walk, appId).accounts.some((each) => each.signedInAt !== undefined || (each.identity !== undefined && each.health === "ready"));

/** The app's first account. */
export function firstAccount(walk: Walk, appId: string): AppAccount {
  const first = shownApp(walk, appId).accounts[0];
  if (first === undefined) throw new Error(`${appId} has no account`);
  return first;
}

/**
 * Hands every Google app the person's own client, as `tavi apps client --file` does: the Desktop app client's JSON as
 * the console downloads it, from the person's secrets folder, read by the CLI and never by the walk. The data
 * directory's credentials must be encrypted.
 */
export function googleClient(walk: Walk, appId: string): string {
  return walk.tavi("apps", "client", appId, "--file", secretPath("google-oauth-client.json"));
}

/**
 * Clicks `start` and returns the address of the sign-in page it opened in a window of its own. The walk's browser
 * is headless and nobody signs in there: its request to the provider is stopped before it leaves, the window is
 * closed, and the person opens the address in their own browser.
 */
export async function signInAddress(page: Page, start: Locator): Promise<string> {
  const context = page.context();
  let address: string | undefined;
  const stop = async (route: { request(): { url(): string }; abort(): Promise<void> }): Promise<void> => {
    address ??= route.request().url();
    await route.abort();
  };
  await context.route(/^https:\/\//, stop);
  try {
    const opened = context.waitForEvent("page", { timeout: 60_000 });
    await start.click();
    const popup = await opened;
    for (let waited = 0; address === undefined && waited < 30_000; waited += 250) await delay(250);
    await popup.close();
  } finally {
    await context.unroute(/^https:\/\//, stop);
  }
  if (address === undefined) throw new Error("the sign-in opened no provider's page");
  return address;
}

/**
 * The desktop helper the person built once, from the commands Tavi prints, in their accounts folder
 * (`desktop/tavi-desktop-helper`): the walks never build or sign it.
 */
const builtHelper = (): string => join(accountsFolder, "desktop", "tavi-desktop-helper");

/**
 * Links the helper the person built into the walk's data directory, where Tavi looks for it. A link, not a copy:
 * a fresh copy of an executable is held by macOS's first-run check for up to a minute.
 */
export function linkDesktopHelper(dataDir: string): void {
  const helper = builtHelper();
  if (!existsSync(helper)) throw new Error(`needs ${helper}: build it once with the commands desktop control prints`);
  mkdirSync(join(dataDir, "desktop"), { recursive: true });
  const target = join(dataDir, "desktop", "tavi-desktop-helper");
  if (!existsSync(target)) symlinkSync(helper, target);
}

/**
 * Whether the helper the person built has the Accessibility permission, from its own `ready` line: started from here,
 * macOS asks about the same app `tavi serve` runs under. It is stopped once it has said.
 */
async function helperTrusted(): Promise<boolean> {
  const child = spawn(builtHelper(), [], { stdio: ["pipe", "pipe", "ignore"] });
  try {
    return await new Promise<boolean>((resolve) => {
      let seen = "";
      const timer = setTimeout(() => resolve(false), 15_000);
      child.stdout.on("data", (chunk: Buffer) => {
        seen += chunk.toString();
        const line = seen.split("\n").find((each) => each.includes('"ready"'));
        if (line === undefined) return;
        clearTimeout(timer);
        try {
          resolve((JSON.parse(line) as { accessibility?: boolean }).accessibility === true);
        } catch {
          resolve(false);
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

/**
 * A file the person creates (`touch`) to say they pressed the abort hotkey: nothing in Tavi shows a press until the
 * next action of the run is refused, which the walk then checks.
 */
const abortPressedMarker = (slug: string): string => join(accountsFolder, `pressed-abort-${slug.replaceAll("/", "-")}`);

/** The connect sheet (or any dialog) open on the page. */
export const dialogOf = (page: Page): Locator => page.getByRole("dialog");

/** Opens Discover and returns the card of the preset `name`, its Add button drawn. */
export async function discoverCard(page: Page, name: string): Promise<Locator> {
  // Exact: "Google" is also the start of "Google Maps".
  const card = page.getByRole("article", { name, exact: true });
  await card.getByRole("button", { name: "Add", exact: true }).waitFor({ timeout: 30_000 });
  await card.scrollIntoViewIfNeeded();
  return card;
}

/**
 * The sheet's sign-in: starts it, hands the person the address of the provider's page, and waits until the owner has
 * the account signed in. The sheet then says who it signed in as.
 */
export async function personSignsIn(
  walk: Walk,
  page: Page,
  appId: string,
  button: string,
  slug: string,
  who: string,
  check: () => boolean = () => signedIn(walk, appId),
): Promise<void> {
  const address = await signInAddress(page, page.getByRole("button", { name: button }));
  await askUser(slug, `open this address in your own browser on this Mac and sign in as ${who}, allowing what it asks: ${address}`, check);
}

/**
 * A Google account added, its calendar on, the person's client given and signed in, as Connect Google Calendar's
 * steps 1 to 5 leave it: what the other Google guides take as done before they start. The person signs in once;
 * with `mailbox`, the agent may read and draft in the mailbox too, asked for in that same sign-in.
 */
export async function googleAccountSignedIn(
  walk: Walk,
  slug: string,
  who: string,
  options: { readonly mailbox?: boolean } = {},
): Promise<void> {
  walk.tavi("credentials", "encrypt");
  const page = await walk.open("/settings/apps/discover");
  const card = await discoverCard(page, "Google");
  await card.getByRole("button", { name: "Add", exact: true }).click();
  const sheet = dialogOf(page);
  await sheet.getByLabel("Let the agent use your calendar").check();
  if (options.mailbox === true) await sheet.getByLabel("Let the agent read and draft in your mailbox").check();
  await sheet.getByLabel("Reach Tavi through this account").uncheck();
  await sheet.getByRole("button", { name: "Next" }).click();
  await sheet.getByText("Drop the client's JSON file here").waitFor();
  expect(googleClient(walk, "gmail")).toMatch(/OAuth client is saved/);
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
  await page
    .locator(".apps-account")
    .getByRole("button", { name: /^(Sign in|Reconnect)$/ })
    .first()
    .click();
  await personSignsIn(walk, page, "gmail", "Sign in to Google", slug, who);
  // Only the test account: a browser signed in to another (the person's own) must not let a walk read it.
  const signedInAs = firstAccount(walk, "gmail").identity?.toLowerCase();
  if (signedInAs !== account("googleEmail").toLowerCase())
    throw new Error("Google signed in another account than the test account: the walk stops before anything reads it");
  await page.keyboard.press("Escape");
}

/** The review dialog from the sheet's last step, its tools' table drawn: it fails, saying so, when nothing listed the tools yet. */
export async function reviewFromSheet(page: Page): Promise<Locator> {
  await dialogOf(page).getByRole("button", { name: "Review its tools" }).click();
  const dialog = dialogOf(page);
  await dialog.locator("table.mcp-tools").or(dialog.getByText("Not probed yet")).first().waitFor({ timeout: 60_000 });
  if (await dialog.getByText("Not probed yet").isVisible())
    throw new Error("the review after the sign-in lists no tools yet: the guide must say to choose Test first");
  return dialog;
}

/** Approves the review open in the dialog, then turns the app on from its page's head. */
export async function approveAndTurnOn(page: Page, appName: string): Promise<void> {
  await dialogOf(page)
    .getByRole("button", { name: /^Approve / })
    .click();
  const turnOn = page.getByRole("button", { name: `Turn ${appName} on` }).first();
  await turnOn.waitFor({ timeout: 30_000 });
  await turnOn.click();
  await page.getByRole("region", { name: "What it can do" }).waitFor({ timeout: 30_000 });
}

/** The completed calls of `tool` in the newest chat. */
export const completedCalls = (walk: Walk, tool: string | RegExp): number =>
  toolCalls(walk.tavi, newestTask(walk.tavi)).filter(
    (call) => (typeof tool === "string" ? call.toolName === tool : tool.test(call.toolName)) && call.status === "completed",
  ).length;

/** In a new chat, asks `prompt` and waits for the answer: the chat's picture masks Tavi's own words. */
export async function askInNewChat(walk: Walk & WalkShots, page: Page, prompt: string, tools: readonly (string | RegExp)[]): Promise<void> {
  await newChat(page);
  await send(page, prompt);
  const called = toolCalls(walk.tavi, newestTask(walk.tavi)).map((call) => call.toolName);
  for (const tool of tools)
    expect(
      called.some((name) => (typeof tool === "string" ? name === tool : tool.test(name))),
      `${String(tool)} was called`,
    ).toBe(true);
  await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
}

/** What these walks need of the walk's pictures. */
interface WalkShots {
  shot(target?: Locator, options?: { readonly mask?: readonly Locator[] }): Promise<void>;
}

/** The tools waiting on you now (`tavi approvals list`). */
export const waitingTools = (walk: Walk): string[] =>
  walk.taviJson<{ rows: { record: { toolId: string } }[] }>("approvals", "list").rows.map((row) => row.record.toolId);

/** Before a picture: the sheet's "Connected … as <who>." loses its "as …", for an account the guide has no placeholder for. */
export async function hideIdentity(sheet: Locator): Promise<void> {
  await sheet.locator('[role="status"]').evaluateAll((nodes) => {
    for (const node of nodes) node.textContent = (node.textContent ?? "").replace(/^(Connected .+?) as .+\.$/, "$1.");
  });
}

/**
 * Opens a tool call of the transcript, by its tool's name, and scrolls it to the top: a call folded into "Worked ·
 * N steps" is opened with its group; `said`, when given, picks the call whose output says it. Returns the call.
 */
export async function openCall(page: Page, tool: string, said?: string | RegExp): Promise<Locator> {
  const main = page.locator("main");
  const named = page.locator("summary", { hasText: tool });
  const isOpen = (details: Locator): Promise<boolean> => details.evaluate((element) => (element as HTMLDetailsElement).open);
  const group = main.locator("details.tools").filter({ has: named }).last();
  if ((await group.count()) > 0 && !(await isOpen(group))) await group.locator("summary").first().click();
  const call = main.locator("details", { has: named, ...(said === undefined ? {} : { hasText: said }) }).last();
  if (!(await isOpen(call))) await call.locator("summary").first().click();
  await call
    .locator("summary")
    .first()
    .evaluate((summary) => summary.scrollIntoView({ block: "start" }));
  return call;
}

/** The newest chat's calls of a desktop tool that did not complete, with what each said. */
export const refusedDesktopCalls = (walk: Walk): { readonly tool: string; readonly said: string }[] =>
  toolCalls(walk.tavi, newestTask(walk.tavi))
    .filter((call) => call.toolName.startsWith("desktop.") && call.status !== "completed")
    .map((call) => ({ tool: call.toolName, said: JSON.stringify(call.output ?? "") }));

/** The app the walk runs under, which macOS asks about for the helper it starts: what the person grants. */
export const grantedTo = (): string => process.env["__CFBundleIdentifier"] ?? "the terminal or app that runs pnpm test:guides";

/** Turns desktop control on in the walk's data directory with TextEdit granted, and starts its owner again with it. */
export async function desktopOn(walk: Walk): Promise<void> {
  walk.tavi("plugins", "enable", "tavi.desktop");
  walk.tavi("config", "set", "desktop.grantedApps", "com.apple.TextEdit");
  await restartOwner(walk.dataDir, []);
}

/** The folder of the walk's own TextEdit document. */
const scratch = temporaryDirectories();

/**
 * Opens a new, empty TextEdit document for the walk to act in: a file of the walk's own, never one of the person's.
 * TextEdit keeps it open after the walk; the person closes it.
 */
export function openScratchDocument(): void {
  const folder = scratch.create("tavi-scratch-");
  const file = join(folder, "Tavi scratch.txt");
  writeFileSync(file, "");
  const opened = spawnSync("open", ["-a", "TextEdit", file], { encoding: "utf8" });
  if (opened.status !== 0) throw new Error(`could not open TextEdit: ${opened.stderr}`);
}

/** Asks the person to grant Accessibility and Screen Recording, unless the helper already has them, and waits until it has. */
export async function grantsGiven(slug: string): Promise<void> {
  if (await helperTrusted()) return;
  await askUser(
    slug,
    `in System Settings → Privacy & Security, turn on Accessibility and Screen Recording for ${grantedTo()} (the app the walk runs under)`,
    helperTrusted,
  );
}

/**
 * With a desktop call's card waiting: the person presses the abort hotkey (and says so, as nothing in Tavi shows a
 * press), then every card of the run is allowed, and each of its calls is refused because the hotkey stopped it.
 * Returns the tool of the first call it refused.
 */
export async function abortWhileCardWaits(walk: Walk, page: Page, slug: string, before: number): Promise<string> {
  const marker = abortPressedMarker(slug);
  rmSync(marker, { force: true });
  await askUser(slug, `press ⌘⇧Esc (Cmd+Shift+Escape) once now, while Tavi's card waits, then run: touch '${marker}'`, () =>
    existsSync(marker),
  );
  rmSync(marker, { force: true });
  await allowUntilAnswered(page, before);
  const stopped = refusedDesktopCalls(walk).find((call) => /abort hotkey/.test(call.said));
  expect(stopped, "a desktop call refused by the hotkey").toBeDefined();
  expect(completedCalls(walk, "desktop.act"), "no action ran").toBe(0);
  return (stopped as { tool: string }).tool;
}

/** Says something to the person in the ask file that needs no answer, such as what to revoke after the walk. */
export function remind(slug: string, what: string): void {
  appendFileSync(askFile, `REMIND ${new Date().toISOString()} ${slug}: ${what}\n`);
}

/**
 * A keyed app's **Your key** step: its picture with the field still empty, then, once the person has the key
 * (`gate`), the key pasted from their file (read by path, never printed), saved and tested, until the review
 * lists `tools` tools (or any). The field is masked by CSS (`input.secret`, not `type="password"`), and no picture
 * is taken after it is filled.
 */
export async function pasteKeyAndTest(
  walk: Walk & WalkShots & { needsUser(what: string): void },
  key: { readonly gate: string; readonly file: string; readonly pluginId: string; readonly tools?: number },
): Promise<void> {
  const sheet = dialogOf(await walk.page());
  const field = sheet.locator("input.secret").first();
  await field.waitFor();
  await walk.shot(sheet);
  walk.needsUser(key.gate);
  await field.fill(readFileSync(secretPath(key.file), "utf8").trim());
  await sheet.getByRole("button", { name: "Save and test" }).click();
  await sheet.getByRole("button", { name: "Review its tools" }).waitFor({ timeout: 60_000 });
  const listed = (): number => walk.taviJson<{ tools: readonly unknown[] }>("mcp", "review", key.pluginId).tools.length;
  const poll = expect.poll(listed, { timeout: 60_000, interval: 1_000 });
  await (key.tools === undefined ? poll.toBeGreaterThan(0) : poll.toBe(key.tools));
}

/** `tavi config set tasks.home mcp:todoist`, pictured as `tavi config get tasks.home` prints it. */
export async function todoistTaskHome(
  walk: Walk & { terminal(spec: { readonly title: string; readonly args: string[] }): Promise<string[]> },
): Promise<void> {
  walk.tavi("config", "set", "tasks.home", "mcp:todoist");
  const screen = await walk.terminal({ title: "tavi config get tasks.home", args: ["config", "get", "tasks.home"] });
  expect(screen.join("\n")).toMatch(/tasks\.home = mcp:todoist/);
}

/** In a new chat, asks for one to-do; Todoist's add-tasks waits on its card (pictured), then is allowed once. */
export async function addTodoistTask(walk: Walk & WalkShots): Promise<void> {
  const page = await walk.open("/");
  await newChat(page);
  const composer = page.getByRole("textbox").last();
  await composer.fill("Add a to-do: Tavi guide test, due tomorrow.");
  await composer.press("Enter");
  // The card, or the turn ending without one: then say what the model did instead.
  const card = page.getByText("Needs your approval").last();
  const ended = page
    .locator("main .task-header")
    .getByText(/^(ready|completed|failed)$/)
    .first();
  await card.or(ended).waitFor({ timeout: 180_000 });
  if (!(await card.isVisible())) {
    const calls = toolCalls(walk.tavi, newestTask(walk.tavi)).map((call) => `${call.toolName} (${call.status})`);
    const said = (await page.locator("main .markdown").last().textContent())?.slice(0, 400) ?? "";
    throw new Error(`no approval card: the turn called [${calls.join(", ")}] and said: ${said}`);
  }
  await page.getByRole("button", { name: "Allow once" }).last().waitFor();
  expect(waitingTools(walk)).toEqual(["mcp.todoist.add_tasks"]);
  await walk.shot(page.locator("section.round").last());
  await allowOnce(page);
  expect(completedCalls(walk, "mcp.todoist.add_tasks")).toBe(1);
}

/**
 * In the review open in the dialog, each FLAGGED (or DOUBTFUL) tool waits on "Choose…": the person reads it and,
 * as the guides say, takes the suggested effect (the server's own annotation). Returns how many were flagged.
 */
export async function chooseSuggestedForFlagged(page: Page, dialog: Locator): Promise<number> {
  const unchosen = dialog.getByRole("combobox", { name: /^Effect of / }).filter({ hasText: "Choose…" });
  const flagged = await unchosen.count();
  while ((await unchosen.count()) > 0) await pick(page, unchosen.first(), /\(suggested\)$/);
  expect(await dialog.getByRole("button", { name: /^Approve / }).isEnabled()).toBe(true);
  return flagged;
}

/** Scrolls the review in the dialog to `toolId`'s row, centred, and back to its left edge, for its picture. */
export async function showToolRow(dialog: Locator, toolId: string): Promise<void> {
  await dialog
    .locator("tr", { hasText: toolId })
    .first()
    .evaluate((row) => {
      row.scrollIntoView({ block: "center", inline: "start" });
      for (let at: HTMLElement | null = row.parentElement; at !== null; at = at.parentElement) at.scrollLeft = 0;
    });
}
