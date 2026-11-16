import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";

import type { BrowserPort, InvocationContext } from "@tavi/contracts";
import { createPlaywrightBrowser } from "@tavi/plugin-browser/playwright";
import { ToolRegistry } from "@tavi/runtime";
import { listenLocally, delay } from "@tavi/test-support";
import { createInMemoryArtifactRepository } from "@tavi/test-support/fakes";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerBrowserTools } from "../../src/features/sandbox/tools.js";

/**
 * A call decided on one site is not made on another, in a real Chromium: the
 * page moves itself by a timed script after the click was decided, and the
 * click is refused. The fixture runs on `localhost` and `other.localhost`,
 * exempt from the private-address rule only. Skipped when Chromium cannot launch here.
 */

const FIXTURE_HOSTS = ["127.0.0.1", "localhost", "*.localhost"];
const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "stale", caller: "test" };

let server: Server;
let port = 0;
let browser: BrowserPort;
let registry: ToolRegistry;
let chromiumAvailable = true;
const posts: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST") posts.push(`${req.headers.host ?? ""}${req.url ?? ""}`);
    res.writeHead(200, { "Content-Type": "text/html" });
    if (req.url === "/moves") {
      res.end(`<!doctype html><html><head><title>Moves</title></head><body><button id="go" onclick="fetch('/clicked', { method: 'POST' })">Next</button>
        <script>setTimeout(() => { location.href = "http://other.localhost:${port}/landed"; }, 2500);</script></body></html>`);
      return;
    }
    res.end(
      `<!doctype html><html><head><title>Other</title></head><body><button onclick="fetch('/clicked', { method: 'POST' })">Next</button></body></html>`,
    );
  });
  port = await listenLocally(server);
  browser = createPlaywrightBrowser({ stagingDirectory: tmpdir(), artifacts: createInMemoryArtifactRepository() });
  registry = new ToolRegistry();
  registerBrowserTools(registry, browser, { privateHostsAllowed: FIXTURE_HOSTS, allowedHosts: [] });
  try {
    const session = await browser.createSession({ workspaceId: "probe" });
    await browser.close(session.sessionId);
  } catch {
    chromiumAvailable = false;
  }
}, 60_000);

afterAll(async () => {
  await browser.dispose?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("a page that moves itself after a call was decided", () => {
  it("refuses the click on the host it moved to", async (ctx) => {
    if (!chromiumAvailable) return ctx.skip();
    const signal = new AbortController().signal;
    const run = (id: string, input: unknown, extra: Record<string, unknown> = {}) =>
      registry.get(id)!.handler({ input, context, signal, operatorApproved: true, ...extra } as never);
    const opened = (await run("browser.create_session", { url: `http://localhost:${port}/moves` })) as {
      sessionId: string;
      page: { epoch: number; elements: { ref: string; text?: string }[] };
    };
    const ref = opened.page.elements.find((element) => element.text === "Next")?.ref ?? "";
    const click = { sessionId: opened.sessionId, ref, epoch: opened.page.epoch, kind: "click" };
    const decided = registry.get("browser.act")!.assess!(click, context).scopeHost;
    expect(decided).toBe(`localhost:${port}`);
    await delay(3_500);
    await expect(run("browser.act", click, { assessedHosts: [decided] })).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
      message: expect.stringContaining(`the page moved to other.localhost:${port}`),
    });
    expect(posts).toEqual([]);
  }, 60_000);
});
