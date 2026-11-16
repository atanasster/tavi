import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { TaviError, type ModelPort } from "@tavi/contracts";
import { launchChromium } from "@tavi/plugin-browser/chromium";
import { waitFor, temporaryDirectories, delay } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { createIpcClient, readDiscovery, readToken } from "@tavi/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { builtCanvasDirectory } from "../../src/canvas-directory.js";
import type { CliIo } from "../../src/cli/io.js";
import { serve, type ServeHandle } from "../../src/server/serve.js";
import { startUiBridge, type UiBridge } from "../../src/server/ui-bridge.js";

/**
 * The live view's soak: a real owner
 * driving real Chromium sessions, the real bridge, and the built canvas in
 * Chromium tabs — 3 sessions, each watched by 2 tabs, for `TAVI_SOAK_MINUTES`
 * (30 by default), with one session taken over and typed into continuously
 * for `TAVI_TAKEOVER_MINUTES` (15) meanwhile. Every minute it samples each
 * tab's frames and connection, and the owner's memory and CPU.
 *
 * It passes when every tab saw frames every minute, no tab's connection was
 * closed (`fallingBehind` or otherwise), the owner's memory stayed bounded,
 * and every character typed reached the page. Runs only with `TAVI_SOAK=1`;
 * `TAVI_SOAK_REPORT=<file>` writes the samples there as JSON.
 */

const SOAK = process.env["TAVI_SOAK"] === "1";
const MINUTES = Number(process.env["TAVI_SOAK_MINUTES"] ?? "30");
const TAKEOVER_MINUTES = Number(process.env["TAVI_TAKEOVER_MINUTES"] ?? "15");
const MINUTE_MS = Number(process.env["TAVI_SOAK_MINUTE_MS"] ?? "60000");
const quietIo: CliIo = { stdout: () => undefined, stderr: () => undefined, isTty: false };

/** A page that never stops moving (so its screencast keeps sending), with a field whose length it shows. */
const PAGE = `<!doctype html><html><head><title>Soak</title></head><body style="font:16px sans-serif">
<p>Frame <span id=tick>0</span></p><div id=box style="width:60px;height:60px;background:teal;position:relative"></div>
<textarea id=field style="width:320px;height:120px"></textarea><p>Typed <span id=count>0</span></p>
<script>
let n = 0;
(function step() { n += 1; document.getElementById("tick").textContent = n; document.getElementById("box").style.left = (n % 200) + "px"; requestAnimationFrame(step); })();
document.getElementById("field").addEventListener("input", (event) => { document.getElementById("count").textContent = event.target.value.length; });
</script></body></html>`;

type Chromium = Awaited<ReturnType<typeof launchChromium>>;

let skip: string | undefined;
let chromium: Chromium | undefined;
const directories = temporaryDirectories();
let directory = "";
let handle: ServeHandle | undefined;
let bridge: UiBridge | undefined;
let site: Server | undefined;
const warnings: string[] = [];

beforeAll(async () => {
  if (!SOAK) {
    skip = "TAVI_SOAK is not set";
    return;
  }
  const canvas = builtCanvasDirectory();
  if (canvas === undefined) {
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
  directory = directories.create("tavi-soak-");
  site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(PAGE);
  });
  await new Promise<void>((resolve) => site?.listen(0, "127.0.0.1", resolve));
  const model: ModelPort = createFixtureModel({ turns: [{ text: "done" }] });
  handle = await serve(
    {
      dataDirectory: directory,
      workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      providers: [],
      credentials: {},
      defaultConnectionId: "soak",
      defaultModel: "soak-model",
      logger: { level: "warn", sink: (line) => void warnings.push(typeof line === "string" ? line : JSON.stringify(line)) },
      scheduleSweepEnabled: false,
    },
    {
      dataDirectory: directory,
      drainDeadlineMs: 10_000,
      modelTarget: { source: "default", connectionId: "soak", model: "soak-model", workspaceId: "default" },
    },
    quietIo,
    { modelOverride: model },
  );
  bridge = await startUiBridge({ dataDirectory: directory, staticDirectory: canvas });
}, 120_000);

afterAll(async () => {
  await chromium?.close();
  await bridge?.close();
  await handle?.shutdown("soak");
  await new Promise<void>((resolve) => (site === undefined ? resolve() : site.close(() => resolve())));
  directories.cleanup();
}, 120_000);

/** Polls `check` until it holds; a check that throws (a page mid-navigation) counts as not yet. */
const eventually = (check: () => Promise<boolean>): Promise<void> => waitFor(() => check().catch(() => false), 30_000, { intervalMs: 200 });

describe("the live view's soak", () => {
  it(
    `keeps 3 sessions × 2 tabs streaming for ${MINUTES} minutes, with a ${TAKEOVER_MINUTES}-minute takeover typing throughout`,
    async (ctx) => {
      if (skip !== undefined || handle === undefined || bridge === undefined || chromium === undefined || site === undefined)
        return ctx.skip();
      const runtime = handle.runtime;
      const repositories = runtime.store.asPort().repositories;
      const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;

      // Three chats, each with a browser session on the moving page.
      const discovery = readDiscovery(directory);
      const token = readToken(directory);
      if (discovery === undefined || token === undefined) throw new Error("no owner");
      const client = await createIpcClient({ endpoint: discovery.endpoint, sessionId: discovery.sessionId, token });
      const chats: { taskId: string; sessionId: string; historyId: string }[] = [];
      try {
        for (let index = 0; index < 3; index += 1) {
          const run = await client.request(
            "run",
            { prompt: `soak ${index}`, workspaceId: "default", principal: "operator", operationKey: `soak-${index}`, approval: "approve" },
            `run-${index}`,
          );
          const taskId = (run.result as { taskId: string }).taskId;
          await eventually(async () => (await repositories.tasks.get(taskId))?.status === "completed");
          // Its end is reported to the browser after the run answers: a session opened before that is kept inactive.
          await delay(500);
          const session = await runtime.browser.createSession({ workspaceId: "default", taskId });
          await runtime.browser.navigate(session.sessionId, url);
          const listed = await repositories.browserHistory.sessions({ workspaceId: "default", taskId, open: true, limit: 1 });
          const historyId = listed[0]?.sessionId;
          if (historyId === undefined) throw new Error("no history for the session");
          chats.push({ taskId, sessionId: session.sessionId, historyId });
        }
      } finally {
        client.close();
      }

      // Two tabs per chat, each counting the frames its built-in view shows and its connection's closes.
      const signIn = async () => {
        const page = await chromium!.newPage();
        await page.goto(bridge!.mintLink());
        await page.waitForSelector(".canvas", { timeout: 30_000 });
        return page;
      };
      const tabs: { chat: number; page: Awaited<ReturnType<typeof signIn>>; closes: number[]; last: number }[] = [];
      for (const [chat, { taskId }] of chats.entries()) {
        for (let copy = 0; copy < 2; copy += 1) {
          const page = await signIn();
          const tab = { chat, page, closes: [] as number[], last: 0 };
          page.on("websocket", (socket) => socket.on("close", () => void tab.closes.push(Date.now())));
          await page.goto(`${bridge.origin}/tasks/${taskId}/plugin:tavi.browserview/live`);
          await page.waitForSelector('iframe[data-plugin="tavi.browserview"]', { timeout: 30_000 });
          await eventually(async () => page.frames().some((frame) => frame.url().includes("/plugin-ui/tavi.browserview/")));
          const view = page.frames().find((frame) => frame.url().includes("/plugin-ui/tavi.browserview/"));
          // Run in the view's frame (this package has no DOM types): counts each new picture shown.
          await view?.evaluate(`(() => {
          const image = document.querySelector("[data-frame]");
          globalThis.shown = 0;
          if (image !== null) new MutationObserver(() => { globalThis.shown += 1; }).observe(image, { attributes: true, attributeFilter: ["src"] });
        })()`);
          tabs.push(tab);
        }
      }
      const framesOf = async (tab: (typeof tabs)[number]): Promise<number> => {
        const view = tab.page.frames().find((frame) => frame.url().includes("/plugin-ui/tavi.browserview/"));
        return Number((await view?.evaluate("globalThis.shown ?? 0").catch(() => -1)) ?? -1);
      };

      // The takeover: a seventh tab takes the first chat's session from the Command Center and types into its field.
      const taker = await signIn();
      const takerCloses: number[] = [];
      /** Letter keys the canvas sent to the owner: what was typed must all have gone, and all reach the page. */
      let keysSent = 0;
      taker.on("websocket", (socket) => {
        socket.on("close", () => void takerCloses.push(Date.now()));
        socket.on("framesent", (frame) => {
          const text = typeof frame.payload === "string" ? frame.payload : "";
          if (text.includes('"action":"input"')) keysSent += (text.match(/"action":"down","key":"[a-j]"/g) ?? []).length;
        });
      });
      await taker.goto(`${bridge.origin}/center/browser`);
      const card = taker.locator(".browser-card", { has: taker.locator(`a[href="/tasks/${encodeURIComponent(chats[0]!.taskId)}"]`) });
      await card.getByRole("button", { name: "Take control" }).click();
      await eventually(async () =>
        ((await taker.locator(".takeover strong").first().textContent()) ?? "").startsWith("You're in control"),
      ).catch(async (error: unknown) => {
        throw new Error(
          `the takeover did not start: ${await taker
            .locator(".takeover")
            .textContent()
            .catch(() => "(no surface)")}`,
          { cause: error },
        );
      });
      const surface = taker.locator(".takeover img");
      await eventually(async () => (await surface.count()) === 1);
      // Into the field: the picture is the page, so its place there is the field's.
      const box = await surface.boundingBox();
      if (box === null) throw new Error("no picture of the page");
      await taker.mouse.click(box.x + box.width * 0.12, box.y + box.height * 0.22);

      const samples: Record<string, unknown>[] = [];
      let typed = 0;
      const startedAt = Date.now();
      /** The takeover: typing for its minutes, then handed back at once (left alone, "Still working?" would hand it back itself). */
      const takeover = (async () => {
        while (Date.now() - startedAt < TAKEOVER_MINUTES * MINUTE_MS) {
          await taker.keyboard.type("abcdefghij", { delay: 40 });
          typed += 10;
        }
        const surfaceSaid = (
          await taker
            .locator(".takeover [role=alert]")
            .allTextContents()
            .catch(() => [])
        ).join(" | ");
        await taker.getByRole("button", { name: "Done — hand back" }).click();
        await taker.getByRole("button", { name: "Hand back", exact: true }).click();
        await eventually(async () => (await taker.locator(".takeover").count()) === 0);
        const text = await runtime.browser.read(chats[0]!.sessionId);
        return {
          surfaceSaid,
          handedBackAtMinute: Math.round(((Date.now() - startedAt) / MINUTE_MS) * 10) / 10,
          shown: Number(/Typed (\d+)/.exec(text.text)?.[1] ?? "-1"),
        };
      })();
      // Awaited after the sampling; meanwhile a failure is held, not unhandled.
      takeover.catch(() => undefined);

      let cpu = process.cpuUsage();
      let cpuAt = Date.now();
      for (let minute = 1; minute <= MINUTES; minute += 1) {
        await delay(MINUTE_MS);
        const frames: number[] = [];
        for (const tab of tabs) {
          const now = await framesOf(tab);
          frames.push(now - tab.last);
          tab.last = now;
        }
        const used = process.cpuUsage(cpu);
        const elapsed = Date.now() - cpuAt;
        cpu = process.cpuUsage();
        cpuAt = Date.now();
        const memory = process.memoryUsage();
        samples.push({
          minute,
          framesPerTab: frames,
          tabCloses: tabs.map((tab) => tab.closes.length),
          takerCloses: takerCloses.length,
          typed,
          rssMiB: Math.round(memory.rss / (1024 * 1024)),
          heapMiB: Math.round(memory.heapUsed / (1024 * 1024)),
          cpuPercent: Math.round(((used.user + used.system) / 1000 / elapsed) * 1000) / 10,
        });
      }
      // Handed back, the page shows every character typed.
      const { surfaceSaid, handedBackAtMinute, shown } = await takeover;

      const report = {
        surfaceSaid,
        keysSent,
        handedBackAtMinute,
        minutes: MINUTES,
        takeoverMinutes: TAKEOVER_MINUTES,
        minuteMs: MINUTE_MS,
        sessions: chats.length,
        tabs: tabs.length,
        typed,
        shownOnPage: shown,
        warnings: warnings.filter((line) => /live|bridge|browser|connection/i.test(line)).slice(0, 50),
        samples,
      };
      const out = process.env["TAVI_SOAK_REPORT"];
      if (out !== undefined) writeFileSync(out, JSON.stringify(report, null, 2));

      // Every tab saw frames every minute, and none was closed.
      for (const sample of samples)
        expect(
          (sample["framesPerTab"] as number[]).every((count) => count > 0),
          JSON.stringify(sample),
        ).toBe(true);
      expect(tabs.every((tab) => tab.closes.length === 0)).toBe(true);
      expect(takerCloses).toEqual([]);
      // Memory bounded: no growth — the last third's median within 1.5× that of the third after a warm-up minute or three.
      const rss = samples.map((sample) => sample["rssMiB"] as number);
      const third = Math.max(1, Math.floor(rss.length / 3));
      const warmup = Math.min(3, Math.max(0, rss.length - 2 * third));
      const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
      expect(median(rss.slice(-third))).toBeLessThanOrEqual(median(rss.slice(warmup, warmup + third)) * 1.5);
      // CPU bounded: no minute past 80 % of one core (this process: owner, bridge and the Playwright client).
      for (const sample of samples) expect(sample["cpuPercent"] as number, JSON.stringify(sample)).toBeLessThanOrEqual(80);
      // Nothing about the live view, the bridge or the browser was warned about.
      expect(report.warnings).toEqual([]);
      expect(surfaceSaid).toBe("");
      expect(keysSent).toBe(typed);
      expect(shown).toBe(typed);
    },
    (MINUTES + 10) * 60_000,
  );
});
