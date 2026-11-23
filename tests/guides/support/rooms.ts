// The functions handed to page.evaluate run in the browser, against its DOM.
/// <reference lib="dom" />
import { spawn } from "node:child_process";

import { expect, onTestFinished } from "vitest";

import type { Locator, Page } from "../../../scripts/docs/browser.mjs";
import { cli } from "../../../scripts/docs/session.mjs";
import { ready, toolsCalled } from "./extend.js";
import { restartOwner, turnEnded } from "./steps.js";
import { account, askUser, hidePersonal, secretPath } from "./user.js";

/**
 * What the Discord and email guides' walks share: the Discord plugin installed from this repository, the person's own
 * bot added from its token file and one room of their test server; the person's Gmail signed in through their own
 * Google client; a person allowed with a one-time code they send themselves; and the chat a channel started. A secret is only ever handed to a command by its path, and
 * each step only the person can do is asked through the ask file (`askUser`) and checked in Tavi itself.
 */

type Walk = {
  readonly dataDir: string;
  tavi(...args: string[]): string;
  taviJson<T>(...args: string[]): T;
  needsUser(what: string): void;
  open(route: string): Promise<Page>;
};

/** The Discord plugin's built folder, as the pages give it: relative to the repository, where the walks run. */
export const DISCORD_PLUGIN = "packages/external/discord/dist-plugin";
export const DISCORD_ID = "discord.channel";
export const DISCORD_VERSION = "0.1.2";
/** The room's own name in Tavi, as the pages give it. */
export const ROOM_LABEL = "general";
/** The name the pictures show for the person: the display name the walks give them. */
export const YOU = "Ana";

export interface Connection {
  readonly connectionId: string;
  readonly providerId: string;
  readonly accountIdentity: string;
  readonly status: {
    readonly state: string;
    readonly lastInboundAt?: string;
    readonly lastSendAt?: string;
  };
}

/** The walk's one connection of `provider`, as `tavi channels list` has it. */
export function connection(walk: Pick<Walk, "taviJson">, provider: string): Connection {
  const found = walk
    .taviJson<{ connections: readonly Connection[] }>("channels", "list")
    .connections.find((each) => each.providerId === provider);
  if (found === undefined) throw new Error(`no ${provider} connection yet`);
  return found;
}

/** Until the connection of `provider` is open. */
export async function opened(walk: Pick<Walk, "taviJson">, provider: string): Promise<void> {
  await expect.poll(() => connection(walk, provider).status.state, { timeout: 60_000, interval: 1_000 }).toBe("running");
}

/** The CLI's environment as the session gives it: none of the caller's TAVI_* settings, no keychain, a fixed zone. */
function cliEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TAVI_")));
  return { ...env, TAVI_CREDENTIAL_KEYCHAIN: "off", TZ: "Europe/London", LANG: "en_US.UTF-8" };
}

/**
 * A tavi command that waits on the person (a pairing code, a sign-in), started on the walk's data directory: what it
 * printed so far, and its exit code once it ended. It is stopped when the walk ends.
 */
function waiting(walk: Walk, args: readonly string[]): { printed(): string; exit(): number | null | undefined } {
  const child = spawn(process.execPath, [cli, ...args, "--data-dir", walk.dataDir], { env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] });
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
  let printed = "";
  let exit: number | null | undefined;
  child.stdout.on("data", (chunk: Buffer) => (printed += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (printed += chunk.toString()));
  child.once("exit", (code) => (exit = code));
  return { printed: () => printed, exit: () => exit };
}

/** Picks `option` (its text, or a pattern) in the canvas's drop-down `select` (a combobox of the page's own). */
export async function pick(page: Page, select: Locator, option: string | RegExp): Promise<void> {
  await select.click();
  await page.getByRole("option", { name: option }).first().click();
}

/** A value from accounts.json the walk can do without (`mailgunPublicUrl`): undefined when it is not there. */
export function optionalAccount(key: string): string | undefined {
  try {
    return account(key);
  } catch {
    return undefined;
  }
}

/** Installs, approves and enables the Discord plugin as the page says, and restarts the owner so it loads it. */
export async function installDiscord(walk: Walk, shown: { install?: boolean; approve?: boolean } = {}): Promise<void> {
  if (shown.install !== true) walk.tavi("plugins", "install", DISCORD_PLUGIN);
  if (shown.approve !== true) walk.tavi("plugins", "approve", DISCORD_ID, DISCORD_VERSION, "--in-process");
  walk.tavi("plugins", "enable", DISCORD_ID);
  await restartOwner(walk.dataDir, []);
  await ready(walk, DISCORD_ID);
}

/** The bot's token file, for `--secret-file token=<path>`: the walk never reads it. Gates the walk on the person's bot. */
export function discordToken(walk: Walk): string {
  walk.needsUser("discord");
  return secretPath("discord-bot.token");
}

/** The rooms of the Discord connection, as `tavi channels rooms <connection>` answers. */
export interface Rooms {
  readonly rooms: readonly {
    readonly conversationId: string;
    readonly label: string;
    readonly members: string;
  }[];
  readonly candidates?: readonly { readonly id: string }[];
  readonly waiting: readonly { readonly conversationId: string }[];
}
export const rooms = (walk: Walk, connectionId: string): Rooms => walk.taviJson<Rooms>("channels", "rooms", connectionId);

/**
 * A page's starting point after the Discord guide: the plugin in, the person's bot added and open, and the room of
 * their test server listened to. Returns the connection id.
 */
async function discordWithRoom(walk: Walk): Promise<string> {
  const token = discordToken(walk);
  await installDiscord(walk);
  walk.tavi("channels", "add", "discord", "--secret-file", `token=${token}`);
  await opened(walk, "discord");
  const { connectionId } = connection(walk, "discord");
  walk.tavi("channels", "rooms", connectionId, "add", account("discordChannelId"), "--label", ROOM_LABEL);
  return connectionId;
}

/**
 * Allowed people, on the canvas: asks for a one-time code for the person of the connection named `label` — yourself (`me`), or someone
 * with an ID of their own — and has the person send it (`how`, an instruction naming the code). Returns the pairing
 * panel once a message claimed the code, its sender's platform name replaced, for the step's picture; confirming it
 * is the caller's.
 */
export async function pairingClaimed(
  walk: Walk,
  guide: string,
  options: {
    readonly connectionId: string;
    readonly label: string;
    readonly me?: boolean;
    readonly principal?: string;
    readonly name: string;
    how(code: string): string;
  },
): Promise<{ page: Page; panel: Locator }> {
  const page = await walk.open("/settings/people");
  const form = page.locator("form", { has: page.getByRole("heading", { name: "Allow a person" }) });
  await pick(page, form.getByRole("combobox", { name: "Person connection" }), options.label);
  if (options.me === true) await form.getByRole("checkbox", { name: "This is me" }).check();
  else await form.getByRole("textbox", { name: "Person ID" }).fill(options.principal ?? "");
  await form.getByRole("textbox", { name: "Display name" }).fill(options.name);
  await form.getByRole("button", { name: "Pair with a code" }).click();
  const panel = page.getByRole("region", { name: "Pairing" });
  const code = ((await panel.locator("[data-pairing-code]").textContent({ timeout: 15_000 })) ?? "").trim();
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const claimed = panel.getByText("carried the code");
  await askUser(guide, options.how(code), () => claimed.isVisible(), 10 * 60_000);
  // The question names the sender as their platform calls them: the picture says only whose account it was.
  await claimed
    .locator("strong")
    .evaluate((who, name) => (who.textContent = name), options.me === true ? "your own account" : "their account");
  return { page, panel };
}

/**
 * Confirms a claimed pairing (**Yes, it's me** when you paired yourself, `me`; **Allow them** for anyone else), and
 * waits until `principal` is allowed on the connection. Returns their sender id.
 */
export async function allowThem(walk: Walk, panel: Locator, connectionId: string, principal: string, me = false): Promise<string> {
  await panel.getByRole("button", { name: me ? "Yes, it's me" : "Allow them" }).click();
  let sender: string | undefined;
  await expect
    .poll(
      () =>
        (sender = walk
          .taviJson<{
            people: readonly { externalSenderId: string; principalId: string }[];
          }>("channels", "people", connectionId)
          .people.find((each) => each.principalId === principal)?.externalSenderId),
      { timeout: 15_000 },
    )
    .toBeDefined();
  hidePersonal(sender as string);
  return sender as string;
}

/**
 * Pairs the person's own account on `connectionId` as `tavi channels link <connection> --yes --name <name>` does, for
 * a walk whose page starts with them allowed: they send the code (`how`), and the link is made once Tavi sees it.
 */
async function linkYourself(walk: Walk, guide: string, connectionId: string, how: (code: string) => string): Promise<void> {
  const link = waiting(walk, ["channels", "link", connectionId, "--yes", "--name", YOU]);
  await expect.poll(() => /\/link (\S+)/.exec(link.printed())?.[1], { timeout: 30_000 }).toBeDefined();
  const code = /\/link (\S+)/.exec(link.printed())?.[1] as string;
  await askUser(guide, how(code), () => link.exit() !== undefined, 10 * 60_000);
  // What it printed last names the person: never shown, even on failure.
  expect(link.exit(), "tavi channels link").toBe(0);
}

/** A chat a channel started, as `tavi tasks` lists it. */
export interface ChannelChat {
  readonly taskId: string;
  readonly status: string;
  readonly principalId?: string;
  readonly conversationHome?: { readonly kind: string };
}

/** The newest chat on `connectionId` that `matches`, if there is one. */
function channelChat(walk: Walk, connectionId: string, matches: (chat: ChannelChat) => boolean = () => true): ChannelChat | undefined {
  const tasks = (JSON.parse(walk.tavi("tasks")) as { tasks: readonly ChannelChat[] }).tasks;
  return tasks.find((task) => JSON.stringify(task).includes(connectionId) && matches(task));
}

/**
 * Asks the person to send a message (`what`, an instruction), and waits until Tavi took a message in on `provider`'s
 * connection after it, and the chat it went to (`matches`) has answered it: back between turns.
 */
export async function messageAnswered(
  walk: Walk,
  guide: string,
  provider: string,
  what: string,
  matches: (chat: ChannelChat) => boolean = () => true,
): Promise<ChannelChat> {
  const { connectionId, status } = connection(walk, provider);
  const before = status.lastInboundAt ?? "";
  await askUser(guide, what, () => (connection(walk, provider).status.lastInboundAt ?? "") > before);
  let chat: ChannelChat | undefined;
  // On a timeout, the chats the connection has, each with its status and home: which one never answered, or none came.
  const seen = (): string =>
    (JSON.parse(walk.tavi("tasks")) as { tasks: readonly ChannelChat[] }).tasks
      .filter((task) => JSON.stringify(task).includes(connectionId))
      .map((task) => `${task.status}: ${Object.keys(task).join(" ")}`)
      .join(", ") || "no chat on the connection";
  try {
    await expect
      .poll(
        () => {
          chat = channelChat(walk, connectionId, matches);
          return chat !== undefined && !/running|queued|admitted|waiting/.test(chat.status);
        },
        { timeout: 240_000, interval: 2_000 },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(`no answered chat on ${provider}: ${seen()}`, { cause: error });
  }
  return chat as ChannelChat;
}

/** A chat's page on the canvas, settled on its last answer. */
export async function chatPage(walk: Walk, taskId: string): Promise<Page> {
  const page = await walk.open(`/tasks/${taskId}`);
  await page
    .getByRole("button", { name: /^Copy response/ })
    .first()
    .waitFor({ timeout: 60_000 });
  return page;
}

/**
 * The person's Gmail as a channel, as the Google guides leave it: credentials encrypted, a Gmail connection reading the
 * label `tavi`, their own Desktop app client given from its file (read by the CLI, never by the walk), and the
 * account signed in — the person opens the address `tavi channels connect` prints and signs in themselves. Returns
 * the connection id.
 */
export async function gmailSignedIn(walk: Walk, guide: string): Promise<string> {
  walk.needsUser("google");
  walk.tavi("credentials", "encrypt");
  walk.tavi("channels", "add", "gmail", "--set", "label=tavi");
  const { connectionId } = connection(walk, "gmail");
  walk.tavi("apps", "client", "gmail", "--file", secretPath("google-oauth-client.json"));
  const signIn = waiting(walk, ["channels", "connect", connectionId]);
  await expect.poll(() => /(https:\/\/accounts\.google\.com\/\S+)/.exec(signIn.printed())?.[1], { timeout: 30_000 }).toBeDefined();
  const url = /(https:\/\/accounts\.google\.com\/\S+)/.exec(signIn.printed())?.[1] as string;
  await askUser(
    guide,
    `Open this address in your own browser, sign in as ${account("googleEmail")} and tick every box it lists: ${url}`,
    () => signIn.exit() !== undefined,
    10 * 60_000,
  );
  expect(signIn.exit(), "tavi channels connect").toBe(0);
  await opened(walk, "gmail");
  return connectionId;
}

/** Allows the person's own address on the connection named `label` from Allowed people, as themselves: the form, for its picture. */
export async function allowYourAddress(walk: Walk, label: string, address: string): Promise<{ page: Page; form: Locator }> {
  const page = await walk.open("/settings/people");
  const form = page.locator("form", { has: page.getByRole("heading", { name: "Allow a person" }) });
  await pick(page, form.getByRole("combobox", { name: "Person connection" }), label);
  await form.getByRole("textbox", { name: "Email address" }).fill(address);
  await form.getByRole("checkbox", { name: "This is me" }).check();
  await form.getByRole("textbox", { name: "Display name" }).fill(YOU);
  return { page, form };
}

/** Saves the Allow a person form, and waits until the address is allowed. */
export async function allowPerson(walk: Walk, form: Locator, connectionId: string): Promise<void> {
  await form.getByRole("button", { name: "Allow person" }).click();
  await expect.poll(() => walk.tavi("channels", "people", connectionId), { timeout: 15_000 }).toContain("operator");
}

/** `tavi approvals list`: the fields the poll walks read. */
interface Pending {
  readonly rows: readonly { readonly record: { readonly taskId: string; readonly toolId: string } }[];
}

/** The chat whose approval for `tool` is waiting, once there is one. */
export const waitingFor = (walk: Pick<Walk, "taviJson">, tool: string): string | undefined =>
  walk.taviJson<Pending>("approvals", "list").rows.find((row) => row.record.toolId === tool)?.record.taskId;

/** A chat's page on its newest approval card, settled and in view: the card, for a step's picture. */
export async function waitingCard(walk: Walk, taskId: string): Promise<Locator> {
  const page = await walk.open(`/tasks/${taskId}`);
  const round = page.locator("section.round").last();
  await round.getByRole("button", { name: "Allow once" }).waitFor({ timeout: 60_000 });
  await round.scrollIntoViewIfNeeded();
  return round;
}

/**
 * A poll asked for in the room, as Run a poll and the poll recipes begin: the bot on the person's server with its
 * room, the person linked to themselves, then `message` written by them in the room, until its poll's card waits.
 * Returns the room chat's task id.
 */
export async function pollAskedInTheRoom(walk: Walk, guide: string, message: string): Promise<string> {
  const connectionId = await discordWithRoom(walk);
  await linkYourself(walk, guide, connectionId, (code) => `In Discord, open a DM with your bot and send it: /link ${code}`);
  await askUser(guide, `In the room's channel, write: ${message}`, () => waitingFor(walk, "messaging.create_poll") !== undefined);
  const taskId = waitingFor(walk, "messaging.create_poll") as string;
  // `tavi tasks` reads the data directory, which keeps no conversation home: the room's chat names its channel.
  expect(JSON.stringify(channelChat(walk, connectionId, (chat) => chat.taskId === taskId) ?? {})).toContain(account("discordChannelId"));
  return taskId;
}

/** The waiting poll allowed once, and the room chat's turn over with the poll posted. Returns the chat's page. */
export async function pollPosted(walk: Walk, taskId: string): Promise<Page> {
  await (await waitingCard(walk, taskId)).getByRole("button", { name: "Allow once" }).click();
  const page = await chatPage(walk, taskId);
  await turnEnded(page);
  expect(toolsCalled(walk, taskId)).toContain("messaging.create_poll");
  return page;
}

/**
 * A poll recipe's walk, the same for each: `message` asked in the room, its poll's card pictured, then the poll allowed
 * and posted, the room's chat pictured with Tavi's words masked. For `walkGuide`.
 */
export function pollRecipe(guide: string, message: string) {
  let taskId = "";
  type Shooting = Walk & { shot(target?: Locator, options?: { readonly mask?: readonly Locator[] }): Promise<void> };
  return {
    configured: true,
    model: true,
    timeoutMs: 1_800_000,
    steps: {
      "ask-for-it-in-the-room": async (walk: Shooting) => {
        // Before you start: the bot on the person's server, with its room, and the person allowed.
        taskId = await pollAskedInTheRoom(walk, guide, message);
        await walk.shot(await waitingCard(walk, taskId));
      },
      "approve-the-poll": async (walk: Shooting) => {
        const page = await pollPosted(walk, taskId);
        await walk.shot(undefined, { mask: [page.locator("main .markdown")] });
      },
    },
  };
}
