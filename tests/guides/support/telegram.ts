// The functions handed to page.evaluate run in the browser, against its DOM.
/// <reference lib="dom" />
import { spawn, spawnSync } from "node:child_process";

import { expect, onTestFinished } from "vitest";

import type { Locator } from "../../../scripts/docs/browser.mjs";
import { cli } from "../../../scripts/docs/session.mjs";
import { account, askUser, hidePersonal, secretPath } from "./user.js";
import { ownerStopped, type WalkContext } from "./walk.js";

/**
 * What the Telegram guides' walks share: the person's own bot, added from its token file (never read into the walk),
 * the person pairing their own Telegram account with a one-time code, and a message they send to the bot seen arriving
 * in Tavi. Every account step is gated on `telegram`
 * (`TAVI_GUIDE_PROVIDED=telegram`) and asks the person through the ask file (`askUser`): the walk waits for Tavi itself
 * to see the step done.
 */

type Walk = {
  readonly dataDir: string;
  tavi(...args: string[]): string;
  taviJson<T>(...args: string[]): T;
  needsUser(what: string): void;
};

/** The name the pictures show in place of the person's own: the binding names the walks give them. */
export const PLACEHOLDER_NAME = "Sam";

/** The person's bot, as `@BotFather` named it, without its `@`. */
const bot = (): string => account("telegramBotUsername").replace(/^@/, "");

export interface TelegramConnection {
  readonly connectionId: string;
  readonly providerId: string;
  readonly accountIdentity: string;
  readonly status: {
    readonly state: string;
    readonly lastInboundAt?: string;
    readonly lastSendAt?: string;
    readonly lastError?: string;
  };
}

/** The walk's one Telegram connection, as `tavi channels list` has it. */
export function telegram(walk: Walk): TelegramConnection {
  const found = walk
    .taviJson<{ connections: readonly TelegramConnection[] }>("channels", "list")
    .connections.find((connection) => connection.providerId === "telegram");
  if (found === undefined) throw new Error("no Telegram connection yet");
  return found;
}

/** The token's file, for `--secret-file token=<path>`: the walk never reads it. Gates the walk on the person's bot. */
export function tokenFile(walk: Walk): string {
  walk.needsUser("telegram");
  return secretPath("telegram-bot.token");
}

/** Until the bot's connection is open: its token checked out and Telegram answered. */
export async function running(walk: Walk): Promise<void> {
  await expect.poll(() => telegram(walk).status.state, { timeout: 60_000, interval: 1_000 }).toBe("running");
}

/** Adds the person's bot as `tavi channels add telegram --secret-file token=<file>` does, and waits for it to open. */
export async function addBot(walk: Walk): Promise<string> {
  walk.tavi("channels", "add", "telegram", "--secret-file", `token=${tokenFile(walk)}`);
  await running(walk);
  return telegram(walk).connectionId;
}

/** The person allowed under `principal` on the bot, as `tavi channels people` lists them. */
export function person(walk: Walk, principal: string): { readonly externalSenderId: string; readonly displayName?: string } | undefined {
  const found = walk
    .taviJson<{
      people: readonly { externalSenderId: string; principalId: string; displayName?: string }[];
    }>("channels", "people")
    .people.find((each) => each.principalId === principal);
  if (found !== undefined) hidePersonal(found.externalSenderId);
  return found;
}

/** What the person is asked to do to send a pairing code: the deep link when there is one, else the command. */
const sendCodeHow = (code: string, link: string | undefined): string =>
  `In Telegram, ${link === undefined ? "" : `open ${link} and tap Start, or `}send /link ${code} to @${bot()}`;

/**
 * The person sends the code `panel` shows (a pairing panel of the canvas) from their phone; resolves once `claimed`
 * (the panel's question about who sent it) is shown. The question names the person: never picture it.
 */
export async function sendCodeFrom(panel: Locator, claimed: Locator, guide: string): Promise<void> {
  const code = ((await panel.locator("[data-pairing-code]").first().textContent()) ?? "").trim();
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const link = (await panel.getByRole("link", { name: "Open in Telegram" }).getAttribute("href")) ?? undefined;
  await askUser(guide, sendCodeHow(code, link), () => claimed.isVisible(), 10 * 60_000);
}

/** The CLI's environment as the session gives it: none of the caller's TAVI_* settings, no keychain, a fixed zone. */
function cliEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TAVI_")));
  return { ...env, TAVI_CREDENTIAL_KEYCHAIN: "off", TZ: "Europe/London", LANG: "en_US.UTF-8" };
}

/**
 * Pairs the person's own Telegram account as `tavi channels link <connection> --yes --name <name>` does, for a walk
 * whose page starts from a paired bot: the code it prints goes to the person, and the link is made once they send it.
 * Returns their Telegram user id. Nothing it printed is shown: its last line names the person.
 */
export async function pairByCode(
  walk: Walk,
  guide: string,
  options: { readonly name: string; readonly principal?: string },
): Promise<string> {
  const principal = options.principal ?? "operator";
  const args = [cli, "channels", "link", telegram(walk).connectionId, "--yes", "--name", options.name];
  if (options.principal !== undefined) args.push("--principal", options.principal);
  const child = spawn(process.execPath, [...args, "--data-dir", walk.dataDir], { env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] });
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
  let printed = "";
  child.stdout.on("data", (chunk: Buffer) => (printed += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (printed += chunk.toString()));
  let exit: number | null | undefined;
  child.once("exit", (code) => (exit = code));
  await expect.poll(() => /\/link (\S+)/.exec(printed)?.[1], { timeout: 30_000 }).toBeDefined();
  const code = /\/link (\S+)/.exec(printed)?.[1] as string;
  const link = /(https:\/\/t\.me\/\S+)/.exec(printed)?.[1];
  await askUser(guide, sendCodeHow(code, link), () => exit !== undefined, 10 * 60_000);
  // Only the lines that do not name the person, if it failed.
  expect(exit, printed.replace(/^linked .*$/m, "")).toBe(0);
  const paired = person(walk, principal);
  expect(paired?.displayName).toBe(options.name);
  return paired?.externalSenderId as string;
}

/** Asks the person to send `text` to their bot, and waits until Tavi took a message in on it. */
export async function askToSend(walk: Walk, guide: string, text: string): Promise<void> {
  const before = telegram(walk).status.lastInboundAt ?? "";
  await askUser(guide, `In Telegram, send this to @${bot()}: ${text}`, () => (telegram(walk).status.lastInboundAt ?? "") > before);
}

/** When Tavi last sent through the bot in this run of the owner ("" before it has). */
export const lastSend = (walk: Walk): string => telegram(walk).status.lastSendAt ?? "";

/** Until Tavi has sent through the bot since `since` (a `lastSend`). */
export async function sentSince(walk: Walk, since: string, timeoutMs = 180_000): Promise<void> {
  await expect.poll(() => lastSend(walk) > since, { timeout: timeoutMs, interval: 2_000 }).toBe(true);
}

/** The step's picture: the chat Telegram started, opened on the canvas once its answer is there, the model's words masked. */
export async function shotTelegramChat(walk: Walk & Pick<WalkContext, "open" | "shot">): Promise<void> {
  const page = await walk.open(`/tasks/${telegramChat(walk)}`);
  await page
    .getByRole("button", { name: /^Copy response/ })
    .first()
    .waitFor({ timeout: 60_000 });
  await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
}

/** The newest chat Telegram started, by its task id (`tavi tasks`). */
function telegramChat(walk: Walk): string {
  const tasks = (
    JSON.parse(walk.tavi("tasks")) as {
      tasks: readonly { taskId: string; chatKind?: string }[];
    }
  ).tasks;
  const chat = tasks.find((task) => task.chatKind !== "home" && JSON.stringify(task).includes("telegram"));
  if (chat === undefined) throw new Error("no chat from Telegram yet");
  return chat.taskId;
}

/** The walk's `tavi serve`, by process id (none once it stopped). */
const ownerPids = (dataDir: string): number[] =>
  spawnSync("pgrep", ["-f", `serve .*--data-dir ${dataDir}$`], { encoding: "utf8" })
    .stdout.split("\n")
    .filter((line) => line.trim() !== "")
    .map(Number);

/** Stops the walk's own `tavi serve`, as a reader presses Ctrl-C in its terminal: for the commands that need it stopped. */
export async function stopOwner(dataDir: string): Promise<void> {
  ownerStopped();
  for (const pid of ownerPids(dataDir)) process.kill(pid, "SIGTERM");
  await expect.poll(() => ownerPids(dataDir).length, { timeout: 30_000, interval: 250 }).toBe(0);
}
