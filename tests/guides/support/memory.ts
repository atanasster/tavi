/**
 * What the memory guides' walks share: memory read back through the CLI (`tavi memory list` and `proposals` under
 * the owner, which carry each record's title and body), a seed command that keeps a fact, the chat's memory card,
 * and a slash command's answer on the canvas.
 */
import { join } from "node:path";

import { delay } from "@tavi/test-support";
import { expect } from "vitest";

import type { Locator, Page } from "../../../scripts/docs/browser.mjs";
import { dismissChecklist, showChats } from "./steps.js";

/** A memory row as `tavi memory list --format json` prints it under the owner. */
export interface MemoryRow {
  readonly recordId: string;
  readonly kind: string;
  readonly status: string;
  readonly title?: string;
  readonly body?: string;
  readonly topicKey?: string;
  readonly sensitivity?: string;
  readonly currentRevisionId?: string;
}

type Json = { taviJson<T>(...args: string[]): T };

/** Your kept memory: every approved record you can see (`tavi memory list` lists a discarded one too, until it is erased). */
export const kept = (walk: Json, ...options: string[]): MemoryRow[] =>
  walk.taviJson<MemoryRow[]>("memory", "list", ...options).filter((row) => row.status === "approved");

/** What waits for your review. */
export const waiting = (walk: Json): MemoryRow[] => walk.taviJson<MemoryRow[]>("memory", "proposals");

/** The kept record whose title or body holds `text` (case aside). */
export function keptWith(walk: Json, text: string): MemoryRow | undefined {
  const wanted = text.toLowerCase();
  return kept(walk).find((row) => `${row.title ?? ""} ${row.body ?? ""}`.toLowerCase().includes(wanted));
}

/** A seed command that keeps a fact as `tavi memory remember` does: no model, kept at once. */
export function rememberFact(title: string, body: string, topic?: string): readonly string[] {
  return ["memory", "remember", "--kind", "fact", "--title", title, "--body", body, ...(topic === undefined ? [] : ["--topic", topic])];
}

/** Opens a new chat from Home, as a reader does with **+** above the chats list. */
export async function newChat(page: Page): Promise<void> {
  await dismissChecklist(page);
  await showChats(page);
  await page
    .getByRole("button", { name: /^New (side )?chat$/ })
    .first()
    .click();
}

/**
 * The chat's memory cards from turns and commands: not the review digest, which the owner may post into the chat
 * you used last at any minute while something waits ("1 thing waiting to be remembered…").
 */
export const turnCards = (page: Page): Locator => page.locator("article.memory-card").filter({ hasNotText: /waiting to be remembered/ });

/** The chat's newest memory card, once it shows, scrolled into view. */
export async function memoryCard(page: Page, timeout = 180_000): Promise<Locator> {
  const card = turnCards(page).last();
  // Read from the owner once posted: its heading shows when it has its words.
  await card.locator(".memory-card-heading").waitFor({ timeout });
  // Wholly in view: a card posted below the fold is not followed by the transcript, and a sliver counts as visible.
  await card.evaluate((element) => element.scrollIntoView({ block: "center" }));
  return card;
}

/** Types a slash command into the chat's box and returns its answer, the note above the box (`/<name>: …`). */
export async function slash(page: Page, text: string): Promise<Locator> {
  const box = page.locator(".composer-box textarea");
  const name = /^\/(\S+)/.exec(text)?.[1] ?? "";
  const answer = page
    .locator("p.notice")
    .filter({ hasText: `/${name}:` })
    .last();
  const before = (await answer.count()) > 0 ? await answer.textContent() : null;
  await box.fill(text);
  await box.press("Enter");
  // The same command's earlier answer stays until this one replaces it.
  await expect.poll(async () => ((await answer.count()) > 0 ? await answer.textContent() : before), { timeout: 30_000 }).not.toBe(before);
  return answer;
}

/** Center → Soul & memory's Memory pane: its header with **Remember**, its settings, proposals and records. */
export const memoryPane = (page: Page): Locator => page.locator('section.soul-pane[aria-labelledby="memory-title"]');

/**
 * Sends `text`, which asks Tavi to remember something, and waits for the memory card its `memory.propose` leads to.
 * No approval comes first (the seeded `seeded-memory-propose` rule; SECURITY-MODEL.md, "What is not asked about"):
 * an approval card is a failure of the step, not something to click through.
 */
export async function proposeFromChat(page: Page, text: string): Promise<Locator> {
  const box = page.locator(".composer-box textarea");
  const cards = turnCards(page);
  const before = await cards.count();
  await box.fill(text);
  await box.press("Enter");
  const ended = page
    .locator("main .task-header")
    .getByText(/^(ready|completed)$/)
    .first();
  for (let waited = 0; !((await cards.count()) > before && (await ended.isVisible())); waited += 1_000) {
    const shown = async () => ((await page.locator("main .runs").textContent()) ?? "").slice(-1_500);
    if (waited > 240_000) throw new Error(`"${text}" led to no memory card; the chat ends: ${await shown()}`);
    if ((await page.getByRole("button", { name: /^(Allow once|Allow the rest)$/ }).count()) > 0)
      throw new Error(`"${text}" stopped on an approval card before its memory card: ${await shown()}`);
    await delay(1_000);
  }
  return memoryCard(page);
}

/**
 * The model requests the owner kept (`models.keptRequests`, the newest 10 of each task) since `since` (an ISO time),
 * as their JSON text, read from the walk's database without writing to it. What a call was really given: the
 * profile ("About the person") is in no listing a reader sees.
 */
export async function requestsSince(dataDir: string, since: string): Promise<string[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dataDir, "tavi.sqlite"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT request FROM tavi_provider_attempt_requests WHERE started_at >= ? ORDER BY started_at").all(since);
    return rows.map((row) => String((row as { request: unknown }).request));
  } finally {
    db.close();
  }
}
