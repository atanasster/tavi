import { existsSync } from "node:fs";
import { join } from "node:path";

import { TaviError } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { DatabaseClient } from "@tavi/runtime";
import { launchChromium } from "@tavi/plugin-browser/chromium";
import { temporaryDirectories, until } from "@tavi/test-support";
import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { builtCanvasDirectory } from "../../src/canvas-directory.js";
import type { OwnerModelTarget } from "../../src/features/run/owner.js";
import { serve, type ServeHandle } from "../../src/server/serve.js";
import { startOnboardingStub } from "../support/onboarding-stub.js";
import { startUiBridge, type UiBridge } from "../../src/server/ui-bridge.js";

/**
 * Welcome in a real browser against a real owner: a fresh store's `tavi serve`, the real bridge serving the built
 * canvas, and Chromium as the person's browser. The bare chat is sent to
 * Welcome on a first run (the App's redirect, once a browser session); the
 * model step is walked with the Custom preset against an OpenAI-compatible
 * stub on a free port, by keyboard where a person would type; the model
 * verifies, becomes the default, and the step is done with no restart. An
 * owner launched with a provider of its own is never redirected. Without
 * Chromium, or without a built canvas, every test skips. Waits are bounded.
 */

type Chromium = Awaited<ReturnType<typeof launchChromium>>;

let chromium: Chromium | undefined;
let canvas: string | undefined;
let skip: string | undefined;

const KEY = "sk-test-welcome-browser-7c2e";

beforeAll(async () => {
  canvas = builtCanvasDirectory();
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
}, 120_000);

afterAll(async () => {
  await chromium?.close();
});

const directories = temporaryDirectories();
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  directories.cleanup();
});

/** Lists `m1`; calls the probe tool for verify and answers anything else in words; refuses any other key. */
async function stub(): Promise<string> {
  const started = await startOnboardingStub(KEY);
  cleanups.push(() => started.close());
  return started.baseUrl;
}

/**
 * An owner on a fresh store: with no model (`providers` empty), or launched
 * with one of its own; `noFlow` disables the built-in flow before it starts,
 * as `tavi plugins disable tavi.onboarding` would, so no flow is installed.
 */
async function owner(launched: boolean, noFlow = false): Promise<{ readonly handle: ServeHandle; readonly bridge: UiBridge }> {
  const directory = directories.create("tavi-welcome-ui-");
  if (noFlow) {
    const store = await DatabaseClient.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    await store.asPort().repositories.plugins.putSetting({
      pluginId: "tavi.onboarding",
      enabled: false,
      config: {},
      updatedBy: "operator",
      updatedAt: nowTimestamp(),
    });
    await store.close();
  }
  const placeholder: OwnerModelTarget = { source: "placeholder", connectionId: "default", model: "default", workspaceId: "default" };
  const handle = await serve(
    {
      dataDirectory: directory,
      workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      ...(launched
        ? {
            providers: [
              { connectionId: "fixture", kind: "openai-compatible" as const, baseUrl: "http://127.0.0.1:1/v1", credentialRef: "fixture" },
            ],
            credentials: {},
            defaultConnectionId: "fixture",
            defaultModel: "fixture-model",
          }
        : {
            providers: [],
            credentials: {},
            defaultConnectionId: "default",
            defaultModel: "default",
            modelTargetUnconfigured: true,
            liveModelTarget: {},
          }),
      logger: { level: "error", sink: () => {} },
      scheduleSweepEnabled: false,
    },
    {
      dataDirectory: directory,
      drainDeadlineMs: 5_000,
      modelTarget: launched ? { source: "flags", connectionId: "fixture", model: "fixture-model", workspaceId: "default" } : placeholder,
    },
    { stdout: () => {}, stderr: () => {}, isTty: false },
    { browserOverride: createFixtureBrowser() },
  );
  cleanups.push(() => handle.shutdown("test cleanup"));
  if (canvas === undefined) throw new Error("no canvas");
  const bridge = await startUiBridge({ dataDirectory: directory, staticDirectory: canvas });
  cleanups.push(() => bridge.close());
  return { handle, bridge };
}

async function opened(bridge: UiBridge) {
  if (chromium === undefined) throw new Error("not set up");
  const page = await chromium.newPage();
  cleanups.push(() => page.close());
  await page.goto(bridge.mintLink());
  await page.waitForSelector(".canvas", { timeout: 20_000 });
  return page;
}

/**
 * Resolves once the page has had an onboarding status answer (its `firstRun`)
 * over the bridge's socket: the App decides its redirect on that answer, so a
 * "no redirect" check made after it, and one turn of the page's task queue, is
 * made after the decision rather than after a guessed wait.
 */
function statusAnswered(page: Awaited<ReturnType<typeof opened>>): Promise<void> {
  return new Promise((resolve) => {
    page.on("websocket", (socket) => {
      socket.on("framereceived", (frame) => {
        if (String(frame.payload).includes('"firstRun"')) resolve();
      });
    });
  });
}

describe("Welcome in the browser", () => {
  it("sends a first run's bare chat to Welcome, and walks the model step to a verified default with no restart", async (ctx) => {
    if (skip !== undefined) return ctx.skip(skip);
    const baseUrl = await stub();
    const { handle, bridge } = await owner(false);
    const page = await opened(bridge);
    await page.goto(`${bridge.origin}/`);
    await page.waitForURL(/\/welcome/u, { timeout: 20_000 });
    await page.getByRole("heading", { level: 1, name: "Choose the model Tavi thinks with" }).waitFor({ timeout: 20_000 });

    await page.getByRole("button", { name: "Show all providers" }).click();
    await page.getByRole("button", { name: /^Custom/u }).click();
    // Focus follows the choice: the first field of the key form, not the page.
    expect(await page.evaluate("document.activeElement?.type")).toBe("url");
    await page.keyboard.type(baseUrl);
    await page.getByLabel("Custom key").fill(KEY);
    await page.keyboard.press("Enter");

    await page.getByRole("button", { name: "Verify" }).waitFor({ timeout: 20_000 });
    expect(await page.evaluate("document.activeElement?.closest('.welcome-roles') !== null")).toBe(true);
    await page.getByRole("button", { name: "Verify" }).click();
    await page.getByText("Inference ready: m1").waitFor({ timeout: 30_000 });
    expect(await page.content()).not.toContain(KEY);

    const model = async () => (await handle.runtime.store.services.modelConfig.getWorkspaceDefault("default"))?.target;
    expect(await until(model, (target) => target !== undefined)).toMatchObject({ model: "m1" });
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { level: 1, name: "About you" }).waitFor({ timeout: 20_000 });
    const verifications = await handle.runtime.store.asPort().repositories.onboarding.verifications("default", "model");
    expect(verifications.find((row) => row.role === "main")).toMatchObject({ ok: true, model: "m1" });
  }, 120_000);

  it("with no flow installed, keeps a first run on the chat, and Welcome opened anyway says to run tavi onboard", async (ctx) => {
    if (skip !== undefined) return ctx.skip(skip);
    const { bridge } = await owner(false, true);
    const page = await opened(bridge);
    const answered = statusAnswered(page);
    await page.goto(`${bridge.origin}/`);
    await page.locator(".composer-box textarea").waitFor({ timeout: 20_000 });
    // After the redirect was decided on the status answer, the page is still the chat.
    await answered;
    await page.evaluate("new Promise((resolve) => setTimeout(resolve, 0))");
    expect(new URL(page.url()).pathname).not.toContain("welcome");
    await page.goto(`${bridge.origin}/welcome`);
    await page.getByRole("heading", { level: 1, name: "Guided setup is turned off" }).waitFor({ timeout: 20_000 });
    expect(await page.getByText("tavi onboard").count()).toBeGreaterThan(0);
  }, 120_000);

  it("never redirects an owner launched with a provider of its own", async (ctx) => {
    if (skip !== undefined) return ctx.skip(skip);
    const { bridge } = await owner(true);
    const page = await opened(bridge);
    const answered = statusAnswered(page);
    await page.goto(`${bridge.origin}/`);
    await page.locator(".composer-box textarea").waitFor({ timeout: 20_000 });
    // After the redirect was decided on the status answer, the page is still the chat.
    await answered;
    await page.evaluate("new Promise((resolve) => setTimeout(resolve, 0))");
    expect(new URL(page.url()).pathname).not.toContain("welcome");
  }, 120_000);
});
