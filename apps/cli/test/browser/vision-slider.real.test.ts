import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";

import type { BrowserPort, ModelPort, ModelRequest } from "@tavi/contracts";
import { createPlaywrightBrowser } from "@tavi/plugin-browser/playwright";
import { listenLocally, partialFake } from "@tavi/test-support";
import { createInMemoryArtifactRepository } from "@tavi/test-support/fakes";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runVisionLoop } from "../../src/features/browser/vision.js";

/**
 * `browser.vision_act` on a real slider (the mini-web's `/canvas`, as the browser eval's
 * miniweb-slider-vision task drives it), with the vision model faked to answer drags.
 */

const CANVAS_PAGE = `<!doctype html><html><head><title>Canvas</title></head><body><main style="margin:0;padding:0;">
  <canvas id="draw-canvas" width="200" height="100" style="position:fixed;left:40px;top:40px;width:200px;height:100px;border:1px solid #000;"></canvas>
  <input id="canvas-slider" type="range" min="0" max="100" value="10" aria-label="Canvas intensity" style="position:fixed;left:40px;top:160px;width:200px;height:24px;" />
  <button id="canvas-commit" type="button" style="position:fixed;left:40px;top:210px;width:140px;height:36px;">Place order</button>
</main></body></html>`;

let server: Server;
let baseUrl: string;
let browser: BrowserPort;
let chromiumAvailable = true;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(CANVAS_PAGE);
  });
  baseUrl = `http://127.0.0.1:${await listenLocally(server)}`;
  browser = createPlaywrightBrowser({ stagingDirectory: tmpdir(), artifacts: createInMemoryArtifactRepository() });
  try {
    await browser.close((await browser.createSession({ workspaceId: "probe" })).sessionId);
  } catch {
    chromiumAvailable = false;
  }
}, 60_000);

afterAll(async () => {
  await browser?.dispose?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("browser.vision_act on a real slider", () => {
  it("keeps moving it with each drag to the target, a click on its mark (its middle) refused on the way", async (ctx) => {
    if (!chromiumAvailable) return ctx.skip();
    const session = await browser.createSession({ workspaceId: "w1" });
    await browser.navigate(session.sessionId, `${baseUrl}/canvas`);
    const sliderValue = async (): Promise<string | undefined> =>
      (await browser.observe(session.sessionId)).elements.find((element) => element.role === "slider")?.value;
    // Observed first, as the agent does: the screenshot marks the slider, and its mark invites a click.
    expect(await sliderValue()).toBe("10");
    // Thumb positions along the 200px track at y 172: about 30, 50, 65 and 75.
    const replies: unknown[] = [
      { action: "drag", x: 66, y: 172, toX: 104, toY: 172 },
      { action: "drag", x: 104, y: 172, toX: 140, toY: 172 },
      { action: "click_ref", ref: "el-0" },
      { action: "drag", x: 140, y: 172, toX: 168, toY: 172 },
      { action: "drag", x: 168, y: 172, toX: 186, toY: 172 },
      { action: "done", summary: "set to about 75" },
    ];
    const seen: (string | undefined)[] = [];
    let turn = 0;
    const models = partialFake<ModelPort>({
      stream: async (request: ModelRequest) => {
        const input = replies[turn];
        turn += 1;
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [{ id: `c${turn}`, name: "browser.vision_act", input }],
          usage: {},
        };
      },
    });
    let ids = 0;
    const pointer = browser.pointer?.bind(browser);
    if (pointer === undefined) throw new Error("the Playwright browser acts by pointer");
    const tracked: NonNullable<BrowserPort["pointer"]> = async (sessionId, action, options) => {
      const outcome = await pointer(sessionId, action, options);
      seen.push(await sliderValue());
      return outcome;
    };
    const result = await runVisionLoop(
      { browser, models, target: async () => ({ connectionId: "main", model: "vision" }), newId: () => String((ids += 1)), now: () => "t" },
      tracked,
      { workspaceId: "w1", principalId: "operator", runId: "task-1", caller: "test" },
      session.sessionId,
      "set the Canvas intensity slider to about 75",
      12,
      new AbortController().signal,
    );
    expect(result).toMatchObject({ done: true, actions: ["drag", "drag", "drag", "drag"] });
    const values = seen.map(Number);
    // Each drag moved it further, none fell back to the middle, and it ended in the target's range.
    expect(values).toHaveLength(4);
    for (let i = 1; i < values.length; i += 1) expect(values[i]).toBeGreaterThan(values[i - 1] ?? 0);
    const final = Number(await sliderValue());
    expect(final).toBeGreaterThanOrEqual(65);
    expect(final).toBeLessThanOrEqual(85);
    await browser.close(session.sessionId);
  }, 60_000);
});
