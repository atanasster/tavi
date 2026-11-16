import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { delay } from "@tavi/test-support";

/**
 * What the account guides' walks share: the person's own accounts, read by path from a folder only they write
 * (`~/.config/tavi-guides`, or `TAVI_GUIDE_ACCOUNTS`), and steps only the person can do — a tap on their phone, a
 * sign-in, a macOS grant. Such a step is written to the ask file (`TAVI_GUIDE_ASK_FILE`), which whoever runs the
 * walk watches and relays, and the walk waits until it sees the step done in Tavi itself. A token is never read
 * into the walk: a command is handed its path. Everything that says who the person is becomes a placeholder in every
 * picture (`personalSwaps`): the harness applies it, and fails a picture that still shows any of it.
 */

/** The folder holding the person's tokens and `accounts.json`. */
export const accountsFolder = process.env["TAVI_GUIDE_ACCOUNTS"] ?? join(homedir(), ".config", "tavi-guides");

/** Where a walk writes what it needs the person to do, one line each. */
export const askFile = process.env["TAVI_GUIDE_ASK_FILE"] ?? join(tmpdir(), "tavi-guide-ask.txt");

/** The ids the pictures show, each from its own run of digits, as long as the id it replaces: columns stay aligned. */
function shownId(id: string, index: number): string {
  const tail = String(index + 1);
  return `1${"0".repeat(Math.max(0, id.length - 1 - tail.length))}${tail}`;
}

/** What a picture shows for each `accounts.json` value that says who the person is: `id` for a numeric id. */
const SHOWN_AS: Readonly<Record<string, string>> = {
  googleEmail: "you@gmail.com",
  emailSender: "you@example.com",
  googleOauthClientId: "your-client-id.apps.googleusercontent.com",
  mailgunPublicUrl: "https://tavi.example.com",
  mailgunRecipient: "tavi@mail.example.com",
  mailgunDomain: "mail.example.com",
  telegramBotUsername: "yourbot",
  telegramYourName: "Sam",
  telegramYourUsername: "sam",
  discordApplicationId: "id",
  discordGuildId: "id",
  discordChannelId: "id",
  discordBotName: "Tavi",
  discordServerName: "Test server",
  discordYourName: "Ana",
  discordSecondName: "Sam",
};

/**
 * The address that emails Tavi and gets its answers in the email walks: `emailSender` when the person names one that
 * may receive mail from the walks, else the Google account's own.
 */
export function emailSender(): string {
  const file = join(accountsFolder, "accounts.json");
  const value = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)["emailSender"] : undefined;
  return typeof value === "string" && value !== "" ? value : account("googleEmail");
}

/** The `accounts.json` values no picture needs to hide. */
const NOT_PERSONAL: ReadonlySet<string> = new Set(["oauthPort"]);

/** Ids and names only a walk finds out (a sender's numeric id), kept for this walk's pictures. */
const foundInWalk: [string, string][] = [];

/** Keeps `value` out of this walk's pictures. A numeric id needs no `shown`: it gets a made-up one. */
export function hidePersonal(value: string, shown?: string): void {
  if (value === "" || foundInWalk.some(([known]) => known === value)) return;
  foundInWalk.push([value, shown ?? shownId(value, 100 + foundInWalk.length)]);
}

/** Every `[personal value, placeholder]` a picture must swap, longest first: empty while no accounts are set up. */
export function personalSwaps(): readonly (readonly [string, string])[] {
  const file = join(accountsFolder, "accounts.json");
  const accounts = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}) as Record<string, unknown>;
  const pairs: [string, string][] = [...foundInWalk];
  for (const [index, [key, shown]] of Object.entries(SHOWN_AS).entries()) {
    const value = accounts[key];
    if (typeof value !== "string" || value === "") continue;
    const bare = value.replace(/^@/, "");
    pairs.push([bare, shown === "id" ? shownId(bare, index) : shown]);
    // The Gmail address with the +tavi tag a filter labels, which holds no plain address to swap.
    if (key === "googleEmail") pairs.push([plusAddress(bare), plusAddress(shown)]);
    // A model or a platform may use a person's first name alone.
    if (/(Your|Second)Name$/.test(key) && bare.includes(" ")) pairs.push([bare.split(" ")[0] as string, shown]);
  }
  // An address or a handle may come back lowercased; a name keeps its case, so "Mark" never eats the word "mark".
  const lowered = pairs
    .filter(([value]) => !/^[A-Z][a-z]+$/.test(value))
    .map(([value, shown]): [string, string] => [value.toLowerCase(), shown]);
  return [...new Map([...pairs, ...lowered])].filter(([value, shown]) => !shown.includes(value)).sort((a, b) => b[0].length - a[0].length);
}

/** The placeholders of what still shows in `text`, for a failure that does not print the values themselves. */
export function personalLeft(text: string): string[] {
  return personalSwaps()
    .filter(([value]) => text.includes(value))
    .map(([, shown]) => shown);
}

/** `you@gmail.com` with the `+tavi` tag a Gmail filter labels: `you+tavi@gmail.com`. */
export function plusAddress(address = account("googleEmail")): string {
  const at = address.lastIndexOf("@");
  return `${address.slice(0, at)}+tavi${address.slice(at)}`;
}

/** The path of the person's secret `name` (e.g. `telegram-bot.token`), refused when missing or readable by others. */
export function secretPath(name: string): string {
  const path = join(accountsFolder, name);
  if (!existsSync(path)) throw new Error(`needs ${path} (a file only you write)`);
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path} is readable by others: chmod 600 it`);
  return path;
}

/** A value from `accounts.json` (names, addresses, ids — never a secret). */
export function account(key: string): string {
  if (!(key in SHOWN_AS) && !NOT_PERSONAL.has(key)) throw new Error(`"${key}" has no placeholder for the pictures: add it to SHOWN_AS`);
  const file = join(accountsFolder, "accounts.json");
  const value = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)[key] : undefined;
  if (typeof value !== "string" || value === "") throw new Error(`needs "${key}" in ${file}`);
  return value;
}

/**
 * Asks the person to do `what` (said as an instruction to them) and waits until `done` holds, polling it every two
 * seconds for at most `timeoutMs` (15 minutes by default). The request and its outcome are appended to the ask file.
 */
export async function askUser(guide: string, what: string, done: () => boolean | Promise<boolean>, timeoutMs = 15 * 60_000): Promise<void> {
  appendFileSync(askFile, `ASK ${new Date().toISOString()} ${guide}: ${what}\n`);
  for (let waited = 0; !(await done()); waited += 2_000) {
    if (waited > timeoutMs) {
      appendFileSync(askFile, `GAVE-UP ${new Date().toISOString()} ${guide}: ${what}\n`);
      throw new Error(`${guide}: waited ${timeoutMs / 60_000} minutes for you to ${what}`);
    }
    await delay(2_000);
  }
  appendFileSync(askFile, `DONE ${new Date().toISOString()} ${guide}: ${what}\n`);
}
