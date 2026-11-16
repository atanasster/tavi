import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { TaviError } from "@tavi/contracts";
import { launchChromium } from "@tavi/plugin-browser/chromium";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { createIpcClient, readDiscovery, readToken, type IpcClient } from "@tavi/runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";

import type { CliIo } from "../../src/cli/io.js";
import { serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * `browser.request_handoff` against real Chromium: a model asks for a person on a sign-in page; a
 * watcher takes the page, types a secret into its field through forwarded
 * input and hands back `done`; the task goes on with the outcome and a fresh
 * observation of the page — in which the secret is not. The host-drawn
 * `<select>`, dialogs and a followed tab are covered against real Chromium at
 * the control target (`packages/builtin/browser/test/playwright.real.test.ts`).
 * Without Chromium, the test skips.
 */

const quietIo: CliIo = { stdout: () => undefined, stderr: () => undefined, isTty: false };
const SECRET = "hunter2-correct-horse";
const SIGN_IN = `<!doctype html><html><head><title>Sign in</title></head><body style="margin:0">
  <label for="user" style="position:absolute;left:10px;top:50px">User</label>
  <input id="user" name="user" style="position:absolute;left:10px;top:10px;width:200px;height:30px" oninput="document.title = 'Typed ' + this.value.length + ' characters'">
</body></html>`;

let skip: string | undefined;
const directories = temporaryDirectories();
let directory = "";
let site: Server | undefined;
let handle: ServeHandle | undefined;
let client: IpcClient | undefined;
let model: ReturnType<typeof createFixtureModel> | undefined;

beforeAll(async () => {
  try {
    const chromium = await launchChromium({ headless: true });
    await chromium.close();
  } catch (error) {
    if (error instanceof TaviError && error.code === "CAPABILITY_MISSING") {
      skip = error.message;
      return;
    }
    throw error;
  }
  site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(SIGN_IN);
  });
  await new Promise<void>((resolve) => site?.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/login`;
  model = createFixtureModel({
    turns: [
      { toolCall: { id: "call-open", name: "browser.create_session", input: {} } },
      { toolCall: { id: "call-nav", name: "browser.navigate", input: { sessionId: "browser-session-1", url } } },
      {
        toolCall: {
          id: "call-hand",
          name: "browser.request_handoff",
          input: { sessionId: "browser-session-1", reason: "sign-in", instructions: "Sign in, then hand back" },
        },
      },
      { text: "Signed in; carrying on." },
    ],
  });
  directory = directories.create("tavi-handoff-real-");
  handle = await serve(
    fixtureServeOptions(directory, { browserAllowedHosts: ["127.0.0.1"] }),
    {
      dataDirectory: directory,
      drainDeadlineMs: 10_000,
      modelTarget: { source: "default", connectionId: "fixture", model: "fixture-model", workspaceId: "default" },
    },
    quietIo,
    { modelOverride: model },
  );
  const discovery = readDiscovery(directory);
  const token = readToken(directory);
  if (discovery === undefined || token === undefined) throw new Error("no owner");
  client = await createIpcClient({ endpoint: discovery.endpoint, sessionId: discovery.sessionId, token });
}, 120_000);

afterAll(async () => {
  client?.close();
  await handle?.shutdown("test");
  await new Promise<void>((resolve) => (site === undefined ? resolve() : site.close(() => resolve())));
  directories.cleanup();
}, 60_000);

describe("a browser handoff in real Chromium", () => {
  it("lets a person sign in through forwarded input and hand back, and the agent's next observation of the page holds nothing they typed", async (ctx) => {
    if (skip !== undefined || handle === undefined || client === undefined || model === undefined) return ctx.skip();
    const calls = model.calls;
    const live = client;
    const repositories = handle.runtime.store.asPort().repositories;
    const run = await live.request(
      "run",
      { prompt: "sign in to the shop", workspaceId: "default", principal: "operator", operationKey: "handoff-real-1", approval: "approve" },
      "run-1",
    );
    expect(run.ok, JSON.stringify(run.error)).toBe(true);
    const taskId = (run.result as { taskId: string }).taskId;
    await vi.waitFor(async () => expect((await repositories.agentWaits.getActiveByTask(taskId))?.handoff?.reason).toBe("sign-in"), {
      timeout: 60_000,
      interval: 200,
    });
    const sessionId = (await repositories.agentWaits.getActiveByTask(taskId))?.handoff?.sessionId ?? "";

    const watched = await live.request("browser-live", { action: "watch", workspaceId: "default", taskId, sessionId }, "watch-1");
    expect(watched.ok, JSON.stringify(watched.error)).toBe(true);
    const subscriptionId = (watched.result as { subscriptionId: string }).subscriptionId;
    const act = (payload: Record<string, unknown>, id: string) =>
      live.request("browser-live", { subscriptionId, sessionId, ...payload }, id);
    expect((await act({ action: "take", maxWidth: 800 }, "take-1")).ok).toBe(true);
    // A click into the field, then the secret as typed text.
    expect(
      (
        await act(
          {
            action: "input",
            seq: 1,
            events: [
              { type: "mouse", action: "down", x: 50, y: 25, button: "left", clickCount: 1 },
              { type: "mouse", action: "up", x: 50, y: 25, button: "left", clickCount: 1 },
              { type: "text", text: SECRET },
            ],
          },
          "input-1",
        )
      ).ok,
    ).toBe(true);
    expect((await act({ action: "release", outcome: "done", note: "Signed in" }, "release-1")).ok).toBe(true);

    await vi.waitFor(async () => expect((await repositories.tasks.get(taskId))?.status).toBe("completed"), {
      timeout: 60_000,
      interval: 200,
    });
    const handedBack = calls
      .at(-1)
      ?.messages.filter((message) => message.role === "tool")
      .at(-1);
    const result = JSON.stringify(handedBack?.toolResults);
    expect(result).toMatch(/"outcome":"done"/);
    // The page was observed again after the hand-back: what was typed reached it (the page counts it in its
    // title), and the observation says nothing of what it was.
    expect(result).toContain(`Typed ${SECRET.length} characters`);
    expect(result).not.toContain(SECRET);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  }, 180_000);
});
