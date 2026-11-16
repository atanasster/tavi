import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { join } from "node:path";

import type { PluginUiEntry } from "@tavi/contracts";
import { hashPluginDirectory } from "@tavi/runtime";
import { listenLocally, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { createPluginUiRoute, parsePluginUiPath } from "../../src/server/plugin-ui-route.js";

/**
 * The bridge's `/plugin-ui/` route:
 * which requests it answers, with which headers, and when it refuses.
 */

const directories = temporaryDirectories();
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  directories.cleanup();
});

const ui = {
  abi: "tavi.ui/1" as const,
  contributions: [
    { id: "live", title: "Browser", document: "ui/live.html", channels: [], placements: [{ slot: "chat.panel.tab" as const }] },
  ],
};

/** A data directory holding one installed snapshot, and the route over it. */
async function fixture() {
  const dataDirectory = directories.create("tavi-plugin-ui-");
  const snapshot = join(dataDirectory, "plugins", "acme.view", "1.0.0");
  mkdirSync(join(snapshot, "ui"), { recursive: true });
  writeFileSync(join(snapshot, "tavi-plugin.json"), "{}");
  writeFileSync(join(snapshot, "ui", "live.html"), '<!doctype html><script src="live.js"></script>');
  writeFileSync(join(snapshot, "ui", "live.js"), "parent.postMessage('hi', '*');");
  writeFileSync(join(snapshot, "ui", "notes.txt"), "not served");
  writeFileSync(join(snapshot, "ui", "face.woff2"), "wOF2");
  writeFileSync(join(snapshot, "ui", "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const contentHash = hashPluginDirectory(snapshot).hash;
  // A built-in's files, in the canvas build, under their build hash.
  const staticDirectory = join(dataDirectory, "canvas");
  const builtin = join(staticDirectory, "plugins", "tavi.view");
  mkdirSync(builtin, { recursive: true });
  writeFileSync(join(builtin, "live.html"), "<!doctype html><p>built in</p>");
  const builtinHash = hashPluginDirectory(builtin).hash;
  const state = { approved: true, asked: 0, hash: contentHash };
  let origin = "";
  const route = () =>
    createPluginUiRoute({
      origin,
      dataDirectory,
      staticDirectory,
      lookup: async (pluginId, hash): Promise<{ entry?: PluginUiEntry }> => {
        state.asked += 1;
        if (pluginId === "tavi.view" && hash === builtinHash) return { entry: { pluginId, kind: "builtin", contentHash: builtinHash, ui } };
        return state.approved && pluginId === "acme.view" && hash === state.hash
          ? { entry: { pluginId, kind: "external", version: "1.0.0", contentHash: hash, ui } }
          : {};
      },
    });
  let handler: ReturnType<typeof route> | undefined;
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    void handler?.handle(request, response, path).then((handled) => {
      if (!handled) {
        response.writeHead(418);
        response.end();
      }
    });
  });
  servers.push(server);
  const port = await listenLocally(server);
  origin = `http://127.0.0.1:${port}`;
  handler = route();
  const get = (path: string, headers: Record<string, string>) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      const outgoing = httpRequest({ host: "127.0.0.1", port, path, headers }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
  const base = `/plugin-ui/acme.view/${contentHash}`;
  return { get, base, origin, snapshot, state, frameSource: handler.frameSource, builtinHash, contentHash };
}

const asDocument = { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" };
const asScript = { "sec-fetch-dest": "script", "sec-fetch-site": "cross-site", origin: "null", "sec-fetch-mode": "cors" };

describe("the /plugin-ui/ route", () => {
  it("serves an approved document framed by the canvas, with its own CSP and no X-Frame-Options, then its script to the sandboxed page", async () => {
    const { get, base, origin, frameSource } = await fixture();
    expect(frameSource).toBe(`${origin}/plugin-ui/`);
    const page = await get(`${base}/ui/live.html`, asDocument);
    expect(page.status).toBe(200);
    expect(page.body).toContain("<script");
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(page.headers["x-frame-options"]).toBeUndefined();
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["cache-control"]).toBe("no-store");
    const csp = String(page.headers["content-security-policy"]);
    expect(csp).toContain(`script-src ${origin}${base}/`);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain(`frame-ancestors ${origin}`);
    expect(csp).toContain("sandbox allow-scripts");
    const script = await get(`${base}/ui/live.js`, asScript);
    expect(script.status).toBe(200);
    expect(script.headers["access-control-allow-origin"]).toBe("null");
    expect(script.headers["content-security-policy"]).toBeUndefined();
    // An icon the canvas itself shows, same-origin.
    expect((await get(`${base}/ui/live.js`, { "sec-fetch-dest": "script", "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  it("refuses every request outside the Sec-Fetch matrix", async () => {
    const { get, base } = await fixture();
    expect((await get(`${base}/ui/live.html`, asDocument)).status).toBe(200);
    for (const headers of [
      {},
      { "sec-fetch-dest": "document", "sec-fetch-site": "none" },
      { "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site" },
      { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-site" },
    ])
      expect((await get(`${base}/ui/live.html`, headers)).status, "document").toBe(403);
    for (const headers of [
      { "sec-fetch-dest": "script", "sec-fetch-site": "cross-site", origin: "http://evil.example" },
      { "sec-fetch-dest": "script", "sec-fetch-site": "same-site" },
      { "sec-fetch-dest": "empty", "sec-fetch-site": "cross-site", origin: "null" },
      { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" },
      {},
    ])
      expect((await get(`${base}/ui/live.js`, headers)).status).toBe(403);
  });

  it("serves the canvas's icon before any document loaded, asking the owner as a document does, and nothing once revoked", async () => {
    const { get, base, state } = await fixture();
    const icon = await get(`${base}/ui/icon.svg`, { "sec-fetch-dest": "image", "sec-fetch-site": "same-origin" });
    expect(icon.status).toBe(200);
    expect(icon.headers["content-type"]).toBe("image/svg+xml");
    expect(state.asked).toBe(1);
    // Cached now: the next one does not ask.
    expect((await get(`${base}/ui/icon.svg`, { "sec-fetch-dest": "image", "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect(state.asked).toBe(1);
    state.approved = false;
    expect((await get(`${base}/ui/live.html`, asDocument)).status).toBe(404);
    expect((await get(`${base}/ui/icon.svg`, { "sec-fetch-dest": "image", "sec-fetch-site": "same-origin" })).status).toBe(404);
  });

  it("serves nothing for a path that escapes the snapshot, an unknown type, or a plugin not approved", async () => {
    const { get, base, state } = await fixture();
    state.approved = false;
    expect((await get(`${base}/ui/live.js`, asScript)).status).toBe(404);
    state.approved = true;
    for (const path of [
      `${base}/../1.0.0/ui/live.html`,
      `${base}/ui/%2e%2e/live.html`,
      `${base}/ui/notes.txt`,
      `${base}/tavi-plugin.json/x.html`,
      "/plugin-ui/acme.view/abc/ui/live.html",
      "/plugin-ui/ACME/ui/live.html",
    ]) {
      expect((await get(path, asDocument)).status, path).toBe(404);
    }
    expect(parsePluginUiPath(`${base}/ui/live.html`)).toMatchObject({ pluginId: "acme.view", file: "ui/live.html" });
    expect(parsePluginUiPath(`${base}/./live.html`)).toBeUndefined();
  });

  it("asks the owner on every document, refusing a plugin no longer approved and forgetting its files", async () => {
    const { get, base, state } = await fixture();
    expect((await get(`${base}/ui/live.html`, asDocument)).status).toBe(200);
    expect((await get(`${base}/ui/live.html`, asDocument)).status).toBe(200);
    expect(state.asked).toBe(2);
    state.approved = false;
    expect((await get(`${base}/ui/live.html`, asDocument)).status).toBe(404);
    expect((await get(`${base}/ui/live.js`, asScript)).status).toBe(404);
  });

  it("refuses a snapshot changed on disk after approval", async () => {
    const { get, base, snapshot } = await fixture();
    writeFileSync(join(snapshot, "ui", "live.js"), "fetch('https://evil.example');");
    expect((await get(`${base}/ui/live.html`, asDocument)).status).toBe(404);
  });

  it("serves a built-in from the canvas build under its build hash, and fonts to the opaque origin with CORS null", async () => {
    const { get, base, builtinHash } = await fixture();
    const builtin = await get(`/plugin-ui/tavi.view/${builtinHash}/live.html`, asDocument);
    expect(builtin.status).toBe(200);
    expect(builtin.body).toContain("built in");
    expect((await get(`/plugin-ui/tavi.view/${"0".repeat(64)}/live.html`, asDocument)).status).toBe(404);
    expect((await get(`${base}/ui/live.html`, asDocument)).status).toBe(200);
    const font = await get(`${base}/ui/face.woff2`, { "sec-fetch-dest": "font", "sec-fetch-site": "cross-site", origin: "null" });
    expect(font.status).toBe(200);
    expect(font.headers["access-control-allow-origin"]).toBe("null");
  });

  it("forgets an older hash of a plugin once a newer one is served", async () => {
    const { get, base, snapshot, state } = await fixture();
    expect((await get(`${base}/ui/live.html`, asDocument)).status).toBe(200);
    writeFileSync(join(snapshot, "ui", "live.js"), "// 2.0");
    state.hash = hashPluginDirectory(snapshot).hash;
    const newer = `/plugin-ui/acme.view/${state.hash}`;
    expect((await get(`${newer}/ui/live.html`, asDocument)).status).toBe(200);
    expect((await get(`${base}/ui/live.js`, asScript)).status).toBe(404);
    expect((await get(`${newer}/ui/live.js`, asScript)).body).toBe("// 2.0");
  });
});
