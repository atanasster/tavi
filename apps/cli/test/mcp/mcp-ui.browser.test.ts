import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TaviError, type ModelOutcome, type ModelPort } from "@tavi/contracts";
import { launchChromium } from "@tavi/plugin-browser/chromium";
import { until, temporaryDirectories } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { builtCanvasDirectory } from "../../src/canvas-directory.js";
import { createLocalCredentialStore } from "../../src/features/credentials/store.js";
import { startUiBridge, type UiBridge } from "../../src/server/ui-bridge.js";
import { forgetInjectionDescriptors, startInjectionOwner, type InjectionOwner } from "../injection/owner-harness.js";
import { chooseOption } from "../support/select.js";

/**
 * MCP servers through the canvas in a real browser (a doubtful claim
 * blocking Approve is `apps/ui/test/features/settings/mcp-settings-dom.test.tsx`'s): a real
 * owner, the real bridge serving the built canvas, an HTTP fake MCP server on
 * a loopback address, and Chromium as the person's browser. Without Chromium
 * or a built canvas, every test skips.
 */

type Chromium = Awaited<ReturnType<typeof launchChromium>>;
type Page = Awaited<ReturnType<Chromium["newPage"]>>;

const FAKE = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mcp"), "fake-server.mjs");
const TOOLS = [
  {
    name: "echo",
    description: "Echoes its text.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "note",
    description: "Keeps a note.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  { name: "clear_cache", description: "Clears the cache.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
];

let chromium: Chromium | undefined;
let io: InjectionOwner | undefined;
let bridge: UiBridge | undefined;
let server: ChildProcess | undefined;
let port = 0;
let skip: string | undefined;
const directories = temporaryDirectories();
const work = directories.create("tavi-mcp-ui-");
const toolsFile = join(work, "tools.json");

/** A model that calls the MCP note tool once, then answers. */
function noteModel(): ModelPort {
  return {
    stream: async (request, options) => {
      const results = request.messages.flatMap((message) => message.toolResults ?? []);
      if (!results.some((result) => result.toolName === "mcp.kb.note") && request.tools.some((tool) => tool.id === "mcp.kb.note")) {
        return {
          status: "completed",
          attemptId: request.attemptId,
          text: "",
          toolCalls: [{ id: "c-note", name: "mcp.kb.note", input: { text: "buy milk" } }],
          usage: {},
        } satisfies ModelOutcome;
      }
      options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text: "noted" });
      return { status: "completed", attemptId: request.attemptId, text: "noted", toolCalls: [], usage: {} } satisfies ModelOutcome;
    },
  };
}

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
  writeFileSync(toolsFile, JSON.stringify(TOOLS));
  server = spawn(process.execPath, [FAKE], {
    env: { PATH: process.env["PATH"] ?? "", FAKE_TRANSPORT: "http", FAKE_ERA: "modern", FAKE_TOOLS: toolsFile },
    stdio: ["ignore", "pipe", "inherit"],
  });
  port = await new Promise<number>((done) =>
    server?.stdout?.on("data", (chunk: Buffer) => {
      const match = /port (\d+)/.exec(chunk.toString());
      if (match?.[1] !== undefined) done(Number(match[1]));
    }),
  );
  // Its MCP server's tools must be offered: the domain plugins' would crowd them past MAX_MODEL_TOOLS.
  io = await startInjectionOwner({ domainPlugins: false });
  io.slot.model = noteModel();
  bridge = await startUiBridge({ dataDirectory: io.owner.directory, staticDirectory: canvas });
}, 120_000);

afterAll(async () => {
  await chromium?.close();
  await bridge?.close();
  await io?.close();
  server?.kill("SIGKILL");
  forgetInjectionDescriptors();
  directories.cleanup();
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

const the = (): InjectionOwner => {
  if (io === undefined) throw new Error("no owner");
  return io;
};

describe("MCP servers through the canvas", () => {
  // The server is `kb`: the injection owner registers its own `mcp.docs.lookup` stand-in.
  it("add, token, probe, review, approve, enable; a chat's call approved from the Inbox; a drift reviewed from Center; disabled, gone", async (ctx) => {
    if (skip !== undefined) return ctx.skip();
    const runtime = the().owner.handle.runtime;
    const repositories = the().owner.repositories();
    // MCP servers are apps: added from Discover, set up on their page.
    const page = await canvasAt("/settings/apps/discover");
    try {
      // Add the HTTP fake with a token, on the local network.
      await page.getByText("Add an MCP server by its address or npm package").click();
      const form = page.getByRole("form", { name: "Add an MCP server" });
      await form.getByLabel("Name").fill("kb");
      await form.getByLabel("URL").fill(`http://127.0.0.1:${String(port)}/mcp`);
      await form.getByLabel(/Sends a token/).check();
      await form.getByLabel(/On my network/).check();
      await form.getByRole("button", { name: "Add server" }).click();
      await until(
        async () => (await runtime.plugins.registry.list()).some((view) => view.id === "mcp.kb"),
        (added) => added,
      );
      // Its page opens on its connect sheet: this one has nothing to sign in to.
      await page.getByRole("heading", { level: 1, name: /kb/ }).waitFor({ timeout: 20_000 });
      const sheet = page.getByRole("dialog");
      await sheet.waitFor({ timeout: 20_000 });
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "hidden", timeout: 20_000 });
      // Its token: written once on its page, kept in the credential store, its reference in the server's settings.
      await page.getByLabel(/^token/).fill("fake-token");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await until(
        async () => (await runtime.plugins.registry.show("mcp.kb")).config["token"],
        (value) => value === "plugins.mcp.kb.token",
      );
      expect(await createLocalCredentialStore(the().owner.directory).getSecret("plugins.mcp.kb.token")).toBe("fake-token");
      await page.getByRole("button", { name: "Test", exact: true }).click();
      await until(
        async () => (await repositories.mcp.listTools("mcp.kb")).length,
        (count) => count === 3,
      );
      // The review: clear_cache claims read-only with a write name, so Approve waits for a choice.
      await page.getByRole("button", { name: "Review tools" }).click();
      const review = page.getByRole("dialog", { name: /Review mcp\.kb/ });
      await review.getByText("DOUBTFUL: claims read-only but has a write name").waitFor({ timeout: 20_000 });
      expect(await review.getByRole("button", { name: "Approve 1.0.0" }).isDisabled()).toBe(true);
      await chooseOption(review.getByLabel("Effect of clear_cache"), "mutating");
      await chooseOption(review.getByLabel("Effect of note"), "external");
      await review.getByRole("button", { name: "Approve 1.0.0" }).click();
      await until(
        async () => (await repositories.mcp.getVersion("mcp.kb", "1.0.0"))?.approvedAt,
        (at) => at !== undefined,
      );
      const decided = Object.fromEntries(
        (await repositories.mcp.listTools("mcp.kb", "1.0.0")).map((tool) => [tool.name, tool.decision?.effect]),
      );
      expect(decided).toEqual({ clear_cache: "mutating", echo: "read-only", note: "external" });
      await page.getByRole("button", { name: "Turn kb on" }).first().click();
      await until(
        async () => runtime.tools.get("mcp.kb.note") !== undefined,
        (registered) => registered,
      );

      // A chat uses the tool, and its call is approved from the Inbox.
      const chat = await canvasAt("/");
      const box = chat.locator(".composer-box textarea");
      await until(
        async () => !(await box.isDisabled()),
        (ready) => ready,
      );
      await box.fill("Note that I need milk.");
      await box.press("Enter");
      const pending = await until(
        async () => (await repositories.approvals.listPending(50)).filter((row) => row.toolId === "mcp.kb.note"),
        (rows) => rows.length === 1,
      );
      const taskId = pending[0]?.taskId ?? "";
      const inbox = await canvasAt("/center/approvals");
      await inbox.getByRole("button", { name: "Allow once" }).first().click();
      await until(
        async () => (await repositories.approvals.listForTask(taskId))[0]?.state,
        (state) => state === "granted",
      );
      await chat.close();
      await inbox.close();

      // The server changes a tool; Center names the server, and its review approves the change.
      writeFileSync(
        toolsFile,
        JSON.stringify(TOOLS.map((tool) => (tool.name === "note" ? { ...tool, description: "Keeps a note, now with tags." } : tool))),
      );
      // The owner's own drift check may get there first, and this one then finds nothing new: what counts is the notice.
      await runtime.mcp.checkDrift("mcp.kb");
      const notices = await until(
        async () => (await repositories.mcp.listNotices({ pluginId: "mcp.kb", open: true })).filter((notice) => notice.kind === "drift"),
        (open) => open.length === 1,
      );
      expect(notices[0]?.detail).toMatchObject({ withheld: ["mcp.kb.note"] });
      expect(runtime.tools.get("mcp.kb.note")).toBeUndefined();
      const center = await canvasAt("/center");
      // Its app's repair, which opens its review.
      await center.getByText("Review kb's tools").click();
      const drift = center.getByRole("dialog", { name: /Review mcp\.kb/ });
      // Exactly the notice: the "What changed since it was approved" details below it say the same words.
      await drift.getByText("CHANGED since it was approved", { exact: true }).waitFor({ timeout: 20_000 });
      await drift.getByRole("button", { name: "Approve 1.0.0" }).click();
      await until(
        async () => (await repositories.mcp.listNotices({ pluginId: "mcp.kb", open: true })).length,
        (open) => open === 0,
      );
      await until(
        async () => runtime.tools.get("mcp.kb.note") !== undefined,
        (registered) => registered,
      );
      await center.close();

      // Turned off from its page, the tool is gone for the next turn.
      await page.reload();
      await page.waitForSelector(".canvas", { timeout: 20_000 });
      await page.getByRole("button", { name: "Turn kb off" }).click();
      await until(
        async () => runtime.tools.list().filter((tool) => tool.id.startsWith("mcp.kb.")).length,
        (left) => left === 0,
      );
    } finally {
      await page.close();
    }
  }, 180_000);
});
