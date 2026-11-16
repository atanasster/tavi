import { existsSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { TaviError, type ModelPort } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { launchChromium } from "@tavi/plugin-browser/chromium";
import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { createBrowserLiveSource } from "@tavi/plugin-browser/live";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { createIpcClient, readDiscovery, readToken } from "@tavi/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { temporaryDirectories, delay } from "@tavi/test-support";

import { builtCanvasDirectory } from "../../src/canvas-directory.js";
import { EXIT, main } from "../../src/main.js";
import type { CliIo } from "../../src/cli/io.js";
import { serve, type ServeHandle } from "../../src/server/serve.js";
import { startUiBridge, type UiBridge } from "../../src/server/ui-bridge.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * The live view in a real browser:
 * what jsdom cannot check — the sandbox, the CSPs, cross-origin resource
 * policy and an opaque-origin page loading its scripts. A real owner (its
 * fixture browser streaming frames), the real bridge serving the built canvas,
 * and Chromium as the reader's browser.
 *
 * Playwright is `@tavi/plugin-browser`'s optional peer alone (the dependency
 * rules), so Chromium is launched through that package. Without Chromium, or
 * without a built canvas, every test skips.
 */

const quietIo: CliIo = { stdout: () => undefined, stderr: () => undefined, isTty: false };
type Chromium = Awaited<ReturnType<typeof launchChromium>>;

let chromium: Chromium | undefined;
const directories = temporaryDirectories();
let directory = "";
let handle: ServeHandle | undefined;
let bridge: UiBridge | undefined;
let skip: string | undefined;
let taskId = "";
/** Tasks whose end the browser has been told of: a session opened after it stays open. */
const endedTasks = new Set<string>();
/** The kind of each input event a takeover applied to the fixture's page: never its content. */
const appliedInput: string[] = [];
const browser = (() => {
  const live = createBrowserLiveSource();
  const fixture = createFixtureBrowser({
    live,
    liveFrameMs: 50,
    sensitive: { "https://bank.example/login": "password-field" },
    onControlInput: (type) => void appliedInput.push(type),
  });
  return {
    live,
    fixture: {
      ...fixture,
      taskEnded: async (id: string) => {
        await fixture.taskEnded?.(id);
        endedTasks.add(id);
      },
    },
  };
})();

/** The reference replacement for the built-in view (examples/ui-plugins/minimal-browser-view). */
const MINIMAL_VIEW = fileURLToPath(new URL("../../../../examples/ui-plugins/minimal-browser-view", import.meta.url));

/**
 * A browser view that declares every channel and forges what only the host may
 * send — a take, input, a release — and asks for `browser.control`: none of
 * it may reach the owner (invariants 3 and 9).
 */
const GRABBER_SCRIPT = `
const ABI = "tavi.ui/1";
const send = (message) => parent.postMessage({ abi: ABI, ...message }, "*");
const seen = [];
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.abi !== ABI) return;
  seen.push(event.data.type === "channel" ? "channel:" + event.data.channel : event.data.type);
  document.body.dataset.seen = seen.join(" ");
  if (event.data.type !== "init") return;
  send({ type: "watch", channel: "browser.control" });
  send({ type: "watch", channel: "browser.live" });
  for (let round = 0; round < 3; round += 1) {
    send({ type: "take", maxWidth: 1600 });
    send({ type: "control", action: "take" });
    send({ type: "input", events: [{ type: "text", text: "grabbed" }] });
    send({ type: "release", outcome: "done" });
  }
  document.body.dataset.forged = "yes";
});
send({ type: "ready" });
`;

/** A UI plugin that tries everything a sandboxed page must not do, and writes down what happened. */
const HOSTILE_SCRIPT = `
const results = {};
// A refusal must be the page's own CSP, not a blocked answer to a request that went out.
const blocked = new Promise((resolve) => document.addEventListener("securitypolicyviolation", (event) => resolve(event.effectiveDirective), { once: true }));
try { await fetch("/api/owner", { method: "POST" }); results.fetch = "reached"; } catch { results.fetch = await Promise.race([blocked, new Promise((resolve) => setTimeout(() => resolve("failed without a CSP block"), 1000))]); }
try { void parent.document.title; results.parent = "read"; } catch { results.parent = "refused"; }
try { results.open = window.open("/") === null ? "refused" : "opened"; } catch { results.open = "refused"; }
try { void document.cookie; results.cookie = document.cookie === "" ? "none" : "read"; } catch { results.cookie = "refused"; }
document.body.dataset.results = JSON.stringify(results);
parent.postMessage({ abi: "tavi.ui/1", type: "ready" }, "*");
`;

beforeAll(async () => {
  const canvas = builtCanvasDirectory();
  if (canvas === undefined || !existsSync(join(canvas, "plugins", "tavi.browserview"))) {
    skip = "the canvas is not built";
    return;
  }
  try {
    chromium = await launchChromium({ headless: true });
  } catch (error) {
    // Only a missing Playwright or Chromium skips: one that fails to start must fail these security tests.
    if (error instanceof TaviError && error.code === "CAPABILITY_MISSING") {
      skip = error.message;
      return;
    }
    throw error;
  }
  directory = directories.create("tavi-live-view-");
  // The hostile plugin: installed, approved and enabled before the owner starts.
  const hostile = directories.create("tavi-hostile-");
  writeFileSync(
    join(hostile, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.hostile",
      version: "1.0.0",
      name: "Hostile",
      ui: {
        abi: "tavi.ui/1",
        contributions: [{ id: "probe", title: "Probe", document: "probe.html", placements: [{ slot: "chat.panel.tab" }] }],
      },
    }),
  );
  writeFileSync(
    join(hostile, "probe.html"),
    '<!doctype html><html><head><script type="module" src="probe.js"></script></head><body></body></html>',
  );
  writeFileSync(join(hostile, "probe.js"), HOSTILE_SCRIPT);
  for (const argv of [
    ["plugins", "install", hostile],
    ["plugins", "approve", "acme.hostile", "1.0.0"],
    ["plugins", "enable", "acme.hostile"],
  ]) {
    if ((await main([...argv, "--data-dir", directory], { io: quietIo })) !== EXIT.ok) throw new Error(`${argv.join(" ")} failed`);
  }
  // The grabber, and the reference replacement as an operator installs it.
  const grabber = directories.create("tavi-grabber-");
  writeFileSync(
    join(grabber, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.grabber",
      version: "1.0.0",
      name: "Grabber",
      ui: {
        abi: "tavi.ui/1",
        contributions: [
          {
            id: "view",
            role: "browser-view",
            title: "Grab",
            document: "grab.html",
            channels: ["browser.live", "browser.control"],
            disclosure: "Wants everything.",
            placements: [{ slot: "chat.panel.tab" }],
          },
        ],
      },
    }),
  );
  writeFileSync(
    join(grabber, "grab.html"),
    '<!doctype html><html><head><script type="module" src="grab.js"></script></head><body></body></html>',
  );
  writeFileSync(join(grabber, "grab.js"), GRABBER_SCRIPT);
  for (const argv of [
    ["plugins", "install", grabber],
    ["plugins", "approve", "acme.grabber", "1.0.0"],
    ["plugins", "enable", "acme.grabber"],
    ["plugins", "install", MINIMAL_VIEW],
    ["plugins", "approve", "example.browserview", "1.0.0"],
    ["plugins", "enable", "example.browserview"],
  ]) {
    if ((await main([...argv, "--data-dir", directory], { io: quietIo })) !== EXIT.ok) throw new Error(`${argv.join(" ")} failed`);
  }
  const model: ModelPort = createFixtureModel({ turns: [{ text: "done" }] });
  handle = await serve(
    fixtureServeOptions(directory, { defaultConnectionId: "running-conn", defaultModel: "running-model" }),
    {
      dataDirectory: directory,
      drainDeadlineMs: 5_000,
      modelTarget: { source: "default", connectionId: "running-conn", model: "running-model", workspaceId: "default" },
    },
    quietIo,
    { modelOverride: model, browserOverride: browser.fixture, liveOverride: browser.live },
  );
  bridge = await startUiBridge({ dataDirectory: directory, staticDirectory: canvas });
  // A chat, and a browser session of it the fixture streams.
  const discovery = readDiscovery(directory);
  const token = readToken(directory);
  if (discovery === undefined || token === undefined) throw new Error("no owner");
  const client = await createIpcClient({ endpoint: discovery.endpoint, sessionId: discovery.sessionId, token });
  try {
    const run = await client.request(
      "run",
      { prompt: "browse", workspaceId: "default", principal: "operator", operationKey: "live-view-browser", approval: "approve" },
      "run-1",
    );
    taskId = (run.result as { taskId: string }).taskId;
  } finally {
    client.close();
  }
  // The run answers before its end is marked; a session opened before that would be made inactive with it.
  await expectEventually(async () => endedTasks.has(taskId));
}, 120_000);

afterAll(async () => {
  await chromium?.close();
  await bridge?.close();
  await handle?.shutdown("test");
  directories.cleanup();
});

/** A canvas page signed in through a fresh link, then at `path`. */
async function canvasAt(path: string) {
  if (chromium === undefined || bridge === undefined) throw new Error("not set up");
  const page = await chromium.newPage();
  await page.goto(bridge.mintLink());
  await page.waitForSelector(".canvas", { timeout: 20_000 });
  await page.goto(`${bridge.origin}${path}`);
  await page.waitForSelector(".canvas", { timeout: 20_000 });
  return page;
}

/** A document request as only the canvas's iframe makes it. */
function documentStatus(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    if (bridge === undefined) return reject(new Error("no bridge"));
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: bridge.port,
        path,
        headers: {
          host: `127.0.0.1:${bridge.port}`,
          "sec-fetch-dest": "iframe",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "navigate",
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("the live view in a real browser", () => {
  it("renders the fixture's frames in the built-in view, and hides a page with a password field", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const session = await browser.fixture.createSession({ workspaceId: "default", taskId });
    await browser.fixture.navigate(session.sessionId, "https://example.com/news");
    const page = await canvasAt(`/tasks/${taskId}/plugin:tavi.browserview/live`);
    try {
      const view = page.frameLocator('iframe[data-plugin="tavi.browserview"]');
      await expectEventually(async () => (await view.locator("[data-chip]").textContent()) === "Live");
      expect(await view.locator("[data-frame]").getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);
      expect(await view.locator("[data-host]").textContent()).toBe("example.com");
      await browser.fixture.navigate(session.sessionId, "https://bank.example/login");
      await expectEventually(async () => (await view.locator("[data-chip]").textContent()) === "Hidden — sensitive page");
      expect(await view.locator("[data-frame]").isHidden()).toBe(true);
    } finally {
      await page.close();
      await browser.fixture.close(session.sessionId);
    }
  }, 60_000);

  it("keeps a hostile plugin from the network, the canvas and new windows, and refuses its document once disabled", async (ctx) => {
    if (skip !== undefined || handle === undefined) return ctx.skip();
    const page = await canvasAt(`/tasks/${taskId}/plugin:acme.hostile/probe`);
    try {
      const probe = page.frameLocator('iframe[data-plugin="acme.hostile"]');
      await expectEventually(async () => (await probe.locator("body").getAttribute("data-results")) !== null);
      expect(JSON.parse((await probe.locator("body").getAttribute("data-results")) ?? "{}")).toEqual({
        fetch: "connect-src",
        parent: "refused",
        open: "refused",
        cookie: "refused",
      });
      const src = (await page.locator('iframe[data-plugin="acme.hostile"]').getAttribute("src")) ?? "";
      expect(await documentStatus(src)).toBe(200);
      await handle.runtime.plugins.registry.disable("acme.hostile", "operator");
      expect(await documentStatus(src)).toBe(404);
      // The page tears the frame down once the change reaches it.
      await expectEventually(async () => (await page.locator('iframe[data-plugin="acme.hostile"]').count()) === 0, 30_000);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("taking the browser over in a real browser", () => {
  it("takes a live session from the Command Center, types into it, sees a sign-in page the other watchers do not, and hands it back", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const session = await browser.fixture.createSession({ workspaceId: "default", taskId });
    await browser.fixture.navigate(session.sessionId, "https://bank.example/login");
    // The fixture records no history; the Command Center lists what history holds, under the live view's id.
    await handle?.runtime.store
      .asPort()
      .repositories.browserHistory.open({ sessionId: "fixture-live-2", workspaceId: "default", taskId, openedAt: nowTimestamp() });
    const page = await canvasAt("/center/browser");
    try {
      await page.getByRole("button", { name: "Take control" }).first().click();
      const surface = page.getByRole("dialog");
      await expectEventually(async () => ((await surface.locator("strong").first().textContent()) ?? "").startsWith("You're in control"));
      expect(browser.live.controlState("fixture-live-2")).toBe("operator");
      // The person sees the sign-in page; everyone else is still told it is hidden.
      await expectEventually(async () => (await surface.locator("img").count()) === 1);
      expect(await surface.textContent()).toContain("Tavi doesn't see what you type");
      // Its colour is the operator's while they hold it.
      expect(await page.locator(".takeover").getAttribute("class")).toContain("takeover-operator");
      await surface.locator("img").click();
      await page.keyboard.type("hunter2");
      await page.keyboard.press("Escape");
      await expectEventually(async () => appliedInput.includes("mouse") && appliedInput.filter((type) => type === "key").length >= 8);
      // Agent calls wait while the person holds the page.
      await expect(browser.fixture.observe(session.sessionId)).rejects.toMatchObject({ code: "CONFLICT" });
      await surface.getByRole("button", { name: "Done — hand back" }).click();
      await surface.getByLabel("Anything Tavi should know?").fill("Signed in");
      await surface.getByRole("button", { name: "Hand back", exact: true }).click();
      await expectEventually(async () => browser.live.controlState("fixture-live-2") === "agent");
      await expectEventually(async () => (await page.locator(".takeover").count()) === 0);
      await browser.fixture.observe(session.sessionId);
    } finally {
      await page.close();
      await browser.fixture.close(session.sessionId);
    }
  }, 60_000);
});

describe("replacing the browser view", () => {
  it("chooses the reference replacement as the browser view, which then receives the live channel and nothing else", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const chosen = await main(["plugins", "ui", "set-role", "browser-view", "example.browserview", "--yes", "--data-dir", directory], {
      io: quietIo,
    });
    expect(chosen).toBe(EXIT.ok);
    const session = await browser.fixture.createSession({ workspaceId: "default", taskId });
    await browser.fixture.navigate(session.sessionId, "https://example.com/news");
    const page = await canvasAt(`/tasks/${taskId}/plugin:example.browserview/live`);
    try {
      const view = page.frameLocator('iframe[data-plugin="example.browserview"]');
      // Several frames: each one's credit came back, or the stream would have stopped at two.
      await expectEventually(
        async () =>
          ((await view.locator("body").getAttribute("data-seen")) ?? "").split(" ").filter((kind) => kind === "channel:browser.live:frame")
            .length >= 5,
      );
      expect(await view.locator("[data-frame]").getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);
      expect(await view.locator("[data-status]").textContent()).toContain("https://example.com/news");
      const seen = ((await view.locator("body").getAttribute("data-seen")) ?? "").split(" ");
      // The host's own messages, and the one channel it declared: nothing else.
      expect(
        seen.filter(
          (kind) => !kind.startsWith("channel:browser.live:") && !["init", "theme", "size", "visibility", "context"].includes(kind),
        ),
      ).toEqual([]);
    } finally {
      await page.close();
      await browser.fixture.close(session.sessionId);
      await main(["plugins", "ui", "set-role", "browser-view", "builtin", "--data-dir", directory], { io: quietIo });
    }
  }, 60_000);

  it("keeps a view that forges the host's controls from taking the browser over or typing into it (invariants 3 and 9)", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const session = await browser.fixture.createSession({ workspaceId: "default", taskId });
    await browser.fixture.navigate(session.sessionId, "https://example.com/forms");
    const historyId =
      browser.live.sessions({ workspaceId: "default", taskIds: [taskId] }).find((info) => info.url === "https://example.com/forms")
        ?.sessionId ?? "";
    const typedBefore = appliedInput.length;
    // Chosen as the browser view, with every channel it asked for confirmed: still no control.
    expect(
      await main(["plugins", "ui", "set-role", "browser-view", "acme.grabber", "--yes", "--data-dir", directory], { io: quietIo }),
    ).toBe(EXIT.ok);
    const page = await canvasAt(`/tasks/${taskId}/plugin:acme.grabber/view`);
    try {
      const view = page.frameLocator('iframe[data-plugin="acme.grabber"]');
      await expectEventually(async () => (await view.locator("body").getAttribute("data-forged")) === "yes");
      // The live channel it may have arrives; by then its forged messages, sent alongside, have long been handled.
      await expectEventually(
        async () =>
          ((await view.locator("body").getAttribute("data-seen")) ?? "").split(" ").filter((kind) => kind === "channel:browser.live")
            .length >= 3,
      );
      expect(browser.live.controlState(historyId)).toBe("agent");
      expect(appliedInput.length).toBe(typedBefore);
      await browser.fixture.observe(session.sessionId);
      // It got the channel it may have, and never the control one.
      const seen = ((await view.locator("body").getAttribute("data-seen")) ?? "").split(" ");
      expect(seen).toContain("channel:browser.live");
      expect(seen).not.toContain("channel:browser.control");
    } finally {
      await page.close();
      await browser.fixture.close(session.sessionId);
      await main(["plugins", "ui", "set-role", "browser-view", "builtin", "--data-dir", directory], { io: quietIo });
    }
  }, 60_000);
});

/** Polls `check` until it holds, or fails after `timeoutMs`. */
async function expectEventually(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    if (await check().catch((error: unknown) => ((last = error), false))) return;
    if (Date.now() > deadline) throw new Error("the condition did not hold in time", { cause: last });
    await delay(100);
  }
}
