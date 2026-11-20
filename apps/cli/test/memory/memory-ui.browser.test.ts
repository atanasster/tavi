import { existsSync } from "node:fs";
import { join } from "node:path";

import { TaviError, type MemoryGetAnswer } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { launchChromium } from "@tavi/plugin-browser/chromium";
import { until } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { builtCanvasDirectory } from "../../src/canvas-directory.js";
import { startUiBridge, type UiBridge } from "../../src/server/ui-bridge.js";
import {
  MANIFEST_MARKERS,
  OPERATOR_ACTOR,
  PERSONAL,
  REMEMBER_PHRASE,
  VEGETARIAN,
  memoryTools,
  savedTurns,
  startMemoryOwner,
  contextOf,
  type MemoryOwner,
} from "../support/memory-owner.js";

/**
 * Memory used through the canvas in a real browser: a real owner whose model proposes "You're vegetarian" when told to
 * remember it, the real bridge serving the built canvas, and Chromium as the
 * person's browser. U1 a *Proposed* card's *Keep* reaches the next prompt;
 * U2 `/remember` in the composer posts a *Saved* card whose *Undo* forgets
 * it; U3 *Forget* from an answer's "Used 1 memory" list, then `/why`; U4 the
 * chat header's memory toggle; U6 the digest in Home and its *Keep all*.
 * U5 *Facts* ticked under Settings' *Keep without asking*: the
 * next fact proposal arrives *Saved* with *Undo*. U7 a proposal akin to a
 * kept untagged fact shows "may update:" with *Replace*, *Keep both* and
 * *Discard* (no *Keep*), and *Replace* corrects the kept record. `memory-flow.test.ts` runs
 * the same over IPC in the default suite. Without Chromium, or without a
 * built canvas, every test skips. Waits are bounded polls.
 */

type Chromium = Awaited<ReturnType<typeof launchChromium>>;
type Page = Awaited<ReturnType<Chromium["newPage"]>>;

let chromium: Chromium | undefined;
let owner: MemoryOwner | undefined;
let bridge: UiBridge | undefined;
let skip: string | undefined;

const the = (): MemoryOwner => {
  if (owner === undefined) throw new Error("no owner");
  return owner;
};

beforeAll(async () => {
  const canvas = builtCanvasDirectory();
  if (canvas === undefined || !existsSync(join(canvas, "index.html"))) {
    skip = "the canvas is not built";
    return;
  }
  try {
    chromium = await launchChromium({ headless: true });
  } catch (error) {
    if (error instanceof TaviError && error.code === "CAPABILITY_MISSING") {
      skip = error.message;
      return;
    }
    throw error;
  }
  owner = await startMemoryOwner("tavi-memory-ui-");
  bridge = await startUiBridge({ dataDirectory: owner.directory, staticDirectory: canvas });
}, 120_000);

afterAll(async () => {
  await chromium?.close();
  await bridge?.close();
  await owner?.close();
});

async function canvasAt(path: string): Promise<Page> {
  if (chromium === undefined || bridge === undefined) throw new Error("not set up");
  const page = await chromium.newPage();
  await page.goto(bridge.mintLink());
  await page.waitForSelector(".canvas", { timeout: 20_000 });
  await page.goto(`${bridge.origin}${path}`);
  await page.waitForSelector(".canvas", { timeout: 20_000 });
  return page;
}

/** Types a message in the composer and sends it with Enter, as a person does. */
async function say(page: Page, text: string): Promise<void> {
  const box = page.locator(".composer-box textarea");
  await until(
    async () => !(await box.isDisabled()),
    (ready) => ready,
  );
  await box.fill(text);
  await box.press("Enter");
}

/** The operator's chats, newest first. */
const chats = async (): Promise<readonly string[]> =>
  (await the().handle.runtime.store.listTaskSessions({ workspaceId: "default", principalId: "operator", limit: 50 })).rows.map(
    (row) => row.taskId,
  );

/** Starts a new chat from the composer, as a person does; answers its task once its first turn is saved. */
async function newChat(page: Page, text: string): Promise<string> {
  const known = new Set(await chats());
  await say(page, text);
  const [taskId = ""] = (await until(chats, (rows) => rows.some((row) => !known.has(row)))).filter((row) => !known.has(row));
  await savedTurns(the(), taskId, 1);
  return taskId;
}

/** Sends a message in the chat on screen and waits for its turn to be saved; answers the generation request it made. */
async function turn(page: Page, taskId: string, text: string) {
  const before = (await the().repositories().transcripts.page(taskId, { limit: 50 })).entries.length;
  const from = the().requests.length;
  await say(page, text);
  await savedTurns(the(), taskId, before + 1);
  return await until(
    async () => the().generationsSince(from)[0],
    (request) => request !== undefined,
  );
}

describe("memory through the canvas", () => {
  it("U1: told to remember, a Proposed card appears; Keep approves it, and the next turn's prompt carries it", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const page = await canvasAt("/");
    try {
      const chat = await newChat(page, `I'm vegetarian, ${REMEMBER_PHRASE}`);
      const card = page.locator(".memory-card", { hasText: VEGETARIAN.title });
      await card.waitFor({ timeout: 20_000 });
      expect(await card.locator(".memory-card-heading").textContent()).toMatch(/^Proposed · /);
      const recordId = (await the().cards(chat))[0]?.items[0]?.recordId ?? "";
      await card.getByRole("button", { name: `Keep: ${VEGETARIAN.title}` }).click();
      await until(
        async () => (await the().record(recordId))?.status,
        (status) => status === "approved",
      );
      await until(
        async () => await card.locator(".memory-card-heading").textContent(),
        (heading) => heading === "Saved",
      );
      const next = await turn(page, chat, "any vegetarian dinner ideas?");
      expect(contextOf(next)).toContain(VEGETARIAN.body);
      // Cleaned up so the later flows read only their own memory.
      await the().forget(recordId);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("U2: /remember in the composer posts a Saved card; Undo forgets it with a journal row, and the next prompt does not carry it", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const page = await canvasAt("/");
    try {
      const chat = await newChat(page, "hello");
      await say(page, "/remember I prefer metric units");
      await page.getByRole("status").filter({ hasText: "/remember:" }).waitFor({ timeout: 20_000 });
      const saved = page.locator(".memory-card", { hasText: "I prefer metric units" });
      await saved.waitFor({ timeout: 20_000 });
      // Held by its notice, not its text: once forgotten, the card holds no text of the record.
      const card = page.locator(`[data-memory-card="${await saved.getAttribute("data-memory-card")}"]`);
      expect(await card.locator(".memory-card-heading").textContent()).toBe("Saved");
      const recordId = (await the().cards(chat)).flatMap((each) => each.items).find((item) => item.state === "saved")?.recordId ?? "";
      expect((await the().record(recordId))?.status).toBe("approved");
      await card.getByRole("button", { name: "Undo: I prefer metric units" }).click();
      await until(
        async () => await the().deletions(recordId),
        (rows) => rows === 1,
      );
      expect(await the().record(recordId)).toBeUndefined();
      await until(
        async () => await card.locator(".memory-card-heading").textContent(),
        (heading) => heading === "Forgotten",
      );
      expect(await card.textContent()).not.toContain("metric units");
      const next = await turn(page, chat, "which metric units again?");
      expect(contextOf(next)).not.toContain("prefer metric units");
    } finally {
      await page.close();
    }
  }, 60_000);

  it('U3: expanded, an answer\'s "Used 1 memory" lists the record; Forget forgets it, and /why lists nothing for the next answer', async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const record = await the().handle.runtime.memory.remember({
      actor: OPERATOR_ACTOR,
      scope: PERSONAL,
      kind: "fact",
      body: "The wombat sleeps in Lisbon",
    });
    const page = await canvasAt("/");
    try {
      const chat = await newChat(page, "where does the wombat sleep?");
      const chip = page.getByRole("button", { name: "Used 1 memory" });
      await chip.waitFor({ timeout: 20_000 });
      expect(await chip.getAttribute("aria-expanded")).toBe("false");
      await chip.click();
      expect(await chip.getAttribute("aria-expanded")).toBe("true");
      const forget = page.getByRole("button", { name: "Forget: The wombat sleeps in Lisbon" });
      await forget.waitFor({ timeout: 20_000 });
      await forget.click();
      await until(
        async () => await the().record(record.recordId),
        (item) => item === undefined,
      );
      await turn(page, chat, "and the wombat?");
      await say(page, "/why");
      const why = page.getByRole("status").filter({ hasText: "/why:" });
      await why.waitFor({ timeout: 20_000 });
      expect(await why.textContent()).toBe("/why: The last answer used no memory.");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("U4: memory turned off in the chat header shows its icon, and the next prompt has no manifest and no memory tools", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const record = await the().handle.runtime.memory.remember({
      actor: OPERATOR_ACTOR,
      scope: PERSONAL,
      kind: "fact",
      body: "The otter swims at dawn",
    });
    const page = await canvasAt("/");
    try {
      const chat = await newChat(page, "when does the otter swim?");
      await page.getByRole("button", { name: "Memory on: turn it off for this chat" }).click();
      const off = page.getByRole("button", { name: "Memory off: turn it on for this chat" });
      await off.waitFor({ timeout: 20_000 });
      // An icon only: its name says the state, and it is drawn crossed out.
      expect(await off.getAttribute("class")).toContain("memory-mode-off");
      expect(await off.locator("svg").count()).toBe(1);
      expect((await the().repositories().tasks.get(chat))?.memoryMode).toBe("off");
      const next = await turn(page, chat, "when does the otter swim?");
      for (const marker of MANIFEST_MARKERS) expect(contextOf(next)).not.toContain(marker);
      expect(contextOf(next)).not.toContain("The otter swims");
      expect(memoryTools(next)).toEqual([]);
      await the().forget(record.recordId);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("U5: Facts ticked under Keep without asking in Settings: the next fact proposal arrives Saved with Undo, and its review names the settings revision", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const before = await the().handle.runtime.store.asPort().repositories.workspaceSettings.get("default");
    const center = await canvasAt("/center/identity");
    try {
      const keep = center.getByRole("group", { name: "Keep without asking" });
      await keep.waitFor({ timeout: 20_000 });
      const facts = keep.getByRole("checkbox", { name: "Facts" });
      expect(await facts.isChecked()).toBe(false);
      // Ticked once the owner saved it: the box follows the settings it reads back.
      await facts.click();
      await keep.getByText("You'll still see each one, with Undo").waitFor({ timeout: 20_000 });
    } finally {
      await center.close();
    }
    const ticked = await until(
      async () => await the().handle.runtime.store.asPort().repositories.workspaceSettings.get("default"),
      (read) => read.settings.memory?.autoApprove?.includes("fact") === true,
    );
    const page = await canvasAt("/");
    try {
      const chat = await newChat(page, `I'm vegetarian and cook at home, ${REMEMBER_PHRASE}`);
      const card = page.locator(".memory-card", { hasText: VEGETARIAN.title });
      await card.waitFor({ timeout: 20_000 });
      await until(
        async () => await card.locator(".memory-card-heading").textContent(),
        (heading) => heading === "Saved",
      );
      const undo = card.getByRole("button", { name: `Undo: ${VEGETARIAN.title}` });
      await undo.waitFor({ timeout: 20_000 });
      const recordId = (await the().cards(chat))[0]?.items[0]?.recordId ?? "";
      const got = await the().memory<MemoryGetAnswer>({ action: "get", recordId });
      expect(got.reviews.map((review) => review.reason)).toEqual([`auto-approve (settings revision ${ticked.revision})`]);
      await undo.click();
      await until(
        async () => await the().deletions(recordId),
        (rows) => rows === 1,
      );
    } finally {
      await page.close();
      const now = await the().handle.runtime.store.asPort().repositories.workspaceSettings.get("default");
      await the().handle.runtime.store.asPort().repositories.workspaceSettings.set({
        workspaceId: "default",
        settings: before.settings,
        expectedRevision: now.revision,
        actor: "operator:test",
        now: nowTimestamp(),
      });
    }
  }, 60_000);

  it("U6: a proposal 25 days old is listed by the digest notice in Home; Keep all approves it", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const proposal = await the().propose("I cycle to work");
    the().setDigestClock(the().daysAfter(proposal.recordedAt, 25));
    const page = await canvasAt(`/tasks/${the().homeId}`);
    try {
      const digest = page.locator(".memory-card", { has: page.getByRole("button", { name: "Keep all" }) });
      await digest.waitFor({ timeout: 20_000 });
      expect(await digest.locator(".memory-card-item").allTextContents()).toEqual(
        expect.arrayContaining([expect.stringContaining("I cycle to work")]),
      );
      await digest.getByRole("button", { name: "Keep all" }).click();
      await until(
        async () => (await the().record(proposal.recordId))?.status,
        (status) => status === "approved",
      );
      await page
        .locator(".memory-card .status-note, .memory-card [role=status]", { hasText: /^Kept 1/ })
        .first()
        .waitFor({ timeout: 20_000 });
    } finally {
      the().setDigestClock(undefined);
      await page.close();
    }
  }, 60_000);

  it('U7: a proposal akin to a kept untagged fact shows "may update:" with Replace, Keep both and Discard, no Keep; Replace corrects the kept record', async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const kept = await the().handle.runtime.memory.remember({
      actor: OPERATOR_ACTOR,
      scope: PERSONAL,
      kind: "fact",
      title: "Diet",
      body: "The person is vegan and cooks at home.",
    });
    expect(kept.topicKey).toBeUndefined();
    const page = await canvasAt("/");
    try {
      const chat = await newChat(page, `I'm vegetarian now, ${REMEMBER_PHRASE}`);
      const card = page.locator(".memory-card", { hasText: VEGETARIAN.title });
      await card.waitFor({ timeout: 20_000 });
      await card.getByText("may update: Diet").waitFor({ timeout: 20_000 });
      const proposalId = (await the().cards(chat))[0]?.items[0]?.recordId ?? "";
      expect(await card.getByRole("button", { name: `Keep both: ${VEGETARIAN.title}` }).count()).toBe(1);
      expect(await card.getByRole("button", { name: `Discard: ${VEGETARIAN.title}` }).count()).toBe(1);
      expect(await card.getByRole("button", { name: `Keep: ${VEGETARIAN.title}` }).count()).toBe(0);
      await card.getByRole("button", { name: `Replace: ${VEGETARIAN.title}` }).click();
      const corrected = await until(
        async () => await the().record(kept.recordId),
        (record) => record?.body === VEGETARIAN.body,
      );
      expect(corrected?.status).toBe("approved");
      await until(
        async () => (await the().record(proposalId))?.status,
        (status) => status === "rejected",
      );
      const got = await the().memory<MemoryGetAnswer>({ action: "get", recordId: proposalId });
      expect(got.reviews.map((review) => review.reason)).toEqual(["applied as a correction"]);
      await the().forget(kept.recordId);
    } finally {
      await page.close();
    }
  }, 60_000);
});
