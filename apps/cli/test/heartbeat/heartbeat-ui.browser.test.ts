import { existsSync } from "node:fs";
import { join } from "node:path";

import { TaviError } from "@tavi/contracts";
import { launchChromium } from "@tavi/plugin-browser/chromium";
import { until } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { builtCanvasDirectory } from "../../src/canvas-directory.js";
import { startUiBridge, type UiBridge } from "../../src/server/ui-bridge.js";
import {
  EXCLUDED_MEMORY,
  HEARTBEAT_SWEEP_MS,
  hhmm,
  promptOf,
  seedHome,
  seedMemory,
  startHeartbeatOwner,
  type HeartbeatOwner,
} from "../support/heartbeat-owner.js";
import { chooseOption } from "../support/select.js";

/**
 * The heartbeat used through the canvas in a real browser: a
 * real owner on a 1 s interval floor, the real bridge serving the
 * built canvas, and Chromium as the person's browser. Turned on and set to
 * every 2 s in Center → Heartbeat, it ticks and the page shows it; set to every
 * 4 s, it ticks at least 4 s apart; its turn is given exactly the person's own
 * memory, fenced; an item it tells shows as a card in Home, whose *Not useful*
 * reaches the next check and whose *Don't tell me* mutes it; paused, *Check
 * now* is off, and resumed it runs a manual deep look. Without Chromium, or
 * without a built canvas, every test skips. Waits are bounded polls with room
 * for a loaded suite.
 */

type Chromium = Awaited<ReturnType<typeof launchChromium>>;

let chromium: Chromium | undefined;
let owner: HeartbeatOwner | undefined;
let bridge: UiBridge | undefined;
let skip: string | undefined;
let records: { readonly preference: string; readonly fact: string } | undefined;

const the = (): HeartbeatOwner => {
  if (owner === undefined) throw new Error("no owner");
  return owner;
};
const config = async () => (await the().repositories().heartbeats.get("default", "operator"))?.config;

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
  owner = await startHeartbeatOwner("tavi-heartbeat-ui-");
  await seedHome(owner);
  records = await seedMemory(owner);
  // What the page does not set: the model it runs on, a deep look every 4 s, and instructions about the seeded fact.
  const set = await owner.client.request(
    "heartbeat",
    {
      action: "set",
      workspaceId: "default",
      changes: { model: { connectionId: "fixture", model: "fixture-model" }, everyMs: 4_000, deepCheckEveryMs: 4_000 },
    },
    "set-1",
  );
  const instructions = await owner.client.request(
    "heartbeat",
    { action: "set-instructions", workspaceId: "default", text: "Tell me if an ACME invoice payment fails" },
    "set-2",
  );
  if (!set.ok || !instructions.ok) throw new Error("could not prepare the heartbeat");
  bridge = await startUiBridge({ dataDirectory: owner.directory, staticDirectory: canvas });
}, 120_000);

afterAll(async () => {
  await chromium?.close();
  await bridge?.close();
  await owner?.close();
});

async function canvasAt(path: string) {
  if (chromium === undefined || bridge === undefined) throw new Error("not set up");
  const page = await chromium.newPage();
  await page.goto(bridge.mintLink());
  await page.waitForSelector(".canvas", { timeout: 20_000 });
  await page.goto(`${bridge.origin}${path}`);
  await page.waitForSelector(".canvas", { timeout: 20_000 });
  return page;
}

describe("the heartbeat through the canvas", () => {
  it("turned on at every 2 s in Center → Heartbeat it ticks and the page shows it; at every 4 s it ticks at least 4 s apart, given exactly the person's memory", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const page = await canvasAt("/center/heartbeat");
    try {
      await page.waitForSelector(".heartbeat-page h1", { timeout: 20_000 });
      const revision = async () => (await config())?.revision ?? 0;
      const before = await revision();
      // Hours around now, then on, then every 2 s — as a person sets them.
      await page.getByLabel("Active from").fill(hhmm(new Date(Date.now() - 60 * 60_000)));
      await until(revision, (value) => value > before);
      await page
        .locator(".heartbeat-page input[type=time]")
        .nth(1)
        .fill(hhmm(new Date(Date.now() + 60 * 60_000)));
      await until(revision, (value) => value > before + 1);
      await page.getByRole("switch", { name: "Heartbeat" }).click();
      await until(
        async () => (await config())?.enabled,
        (on) => on === true,
      );
      await chooseOption(page.getByLabel("How often"), String(2_000));
      await until(
        async () => (await config())?.everyMs,
        (every) => every === 2_000,
      );
      // A check with wake reason `interval`, and the page shows it.
      await until(the().ticks, (rows) => rows.some((row) => row.wakeReason === "interval"));
      await page.waitForSelector(".heartbeat-log li", { timeout: 20_000 });
      // Every 4 s: two checks at least 4 s apart.
      await chooseOption(page.getByLabel("How often"), String(4_000));
      await until(
        async () => (await config())?.everyMs,
        (every) => every === 4_000,
      );
      const marked = (await the().ticks()).filter((row) => row.wakeReason === "interval").length;
      const later = (await until(the().ticks, (rows) => rows.filter((row) => row.wakeReason === "interval").length >= marked + 2)).filter(
        (row) => row.wakeReason === "interval",
      );
      const apart = Date.parse(later[0]?.createdAt ?? "") - Date.parse(later[1]?.createdAt ?? "");
      expect(apart).toBeGreaterThanOrEqual(4_000 - HEARTBEAT_SWEEP_MS);
      // Its deep looks were given exactly the person's own two records, fenced in the prompt.
      const deep = (await the().ticks()).find((row) => row.kind === "deep" && row.outcome !== "skipped");
      expect(((deep?.inputs as { memory?: { recordId: string }[] } | null)?.memory ?? []).map((record) => record.recordId).sort()).toEqual(
        [records?.preference, records?.fact].sort(),
      );
      const prompt = promptOf(the().requests.findLast((request) => promptOf(request).includes('<untrusted source="memory">')));
      expect(prompt).toContain("[fact] ACME pays invoices late but always pays");
      expect(prompt).toContain("[preference] tone: short");
      for (const excluded of EXCLUDED_MEMORY) expect(prompt).not.toContain(excluded);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("shows what it tells as a card in Home; Not useful reaches the next check, and Don't tell me mutes it", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    the().report([
      {
        key: "billing:invoice:1042",
        urgency: "now",
        title: "ACME invoice 1042 failed",
        sources: [{ label: "Billing" }],
        instructionLine: 1,
      },
    ]);
    const item = await until(
      async () =>
        (
          await the()
            .repositories()
            .heartbeats.ledgerRows({ workspaceId: "default", principalId: "operator", keys: ["billing:invoice:1042"] })
        )[0],
      (row) => row !== undefined,
    );
    const page = await canvasAt("/tasks/home-1");
    try {
      const card = page.locator(".heartbeat-item", { hasText: "ACME invoice 1042 failed" });
      await card.waitFor({ timeout: 20_000 });
      expect(await card.locator(".heartbeat-item-source").textContent()).toContain("Billing");
      expect(await card.locator(".heartbeat-item-source").textContent()).toContain("from your line 1");
      await card.getByRole("button", { name: "Not useful" }).click();
      await until(
        async () =>
          (
            await the()
              .repositories()
              .heartbeats.ledgerRow({ workspaceId: "default", principalId: "operator", itemId: item?.itemId ?? "" })
          )?.feedback,
        (feedback) => feedback === "down",
      );
      const asked = the().requests.length;
      await until(
        async () => the().requests.slice(asked).map(promptOf),
        (prompts) => prompts.some((prompt) => prompt.includes('"feedback":"down"')),
      );
      await card.getByRole("button", { name: "Don't tell me about this" }).click();
      await card.locator(".heartbeat-item-receipt").waitFor({ timeout: 20_000 });
      expect(
        (
          await the()
            .repositories()
            .heartbeats.ledgerRow({ workspaceId: "default", principalId: "operator", itemId: item?.itemId ?? "" })
        )?.state,
      ).toBe("muted");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("paused, Check now is off and refused; resumed, Check now runs a manual deep look the page counts", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const page = await canvasAt("/center/heartbeat");
    try {
      await page.waitForSelector(".heartbeat-page h1", { timeout: 20_000 });
      await chooseOption(page.getByRole("combobox", { name: "Pause" }), "resume");
      await until(
        async () => (await config())?.paused,
        (paused) => paused !== undefined,
      );
      // The page learns it is paused after the owner does.
      await until(
        () => page.getByRole("button", { name: "Check now" }).isDisabled(),
        (disabled) => disabled,
      );
      const refused = await the().client.request("heartbeat", { action: "run-now", workspaceId: "default" }, "run-now-paused");
      expect(refused).toMatchObject({ ok: false, error: { message: expect.stringContaining("paused") } });
      await page.getByRole("button", { name: "Resume" }).click();
      await until(
        async () => (await config())?.paused,
        (paused) => paused === undefined,
      );
      await page.getByRole("button", { name: "Check now" }).click();
      await until(the().ticks, (rows) => rows.some((row) => row.wakeReason === "manual" && row.kind === "deep"));
      await until(
        async () => await page.locator(".heartbeat-log li").allTextContents(),
        (rows) => rows.some((row) => row.includes("Looked deeper")),
      );
    } finally {
      await page.close();
    }
  }, 60_000);
});
