import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { join } from "node:path";

import type { PluginAppIconsEntry, PluginView } from "@tavi/contracts";
import { hashPluginDirectory } from "@tavi/runtime";
import { listenLocally, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { servedIconOf } from "../../src/features/apps/builtin.js";
import { pluginAppIconEntries } from "../../src/features/plugins/actions.js";
import { createPluginUiRoute } from "../../src/server/plugin-ui-route.js";

/**
 * An app's icon from a plugin with no UI: the bridge serves the icons its approved `apps` block names,
 * as images, and nothing else of its snapshot.
 */

const directories = temporaryDirectories();
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  directories.cleanup();
});

async function fixture() {
  const dataDirectory = directories.create("tavi-app-icons-");
  const snapshot = join(dataDirectory, "plugins", "acme.notes", "1.0.0");
  mkdirSync(join(snapshot, "assets"), { recursive: true });
  writeFileSync(join(snapshot, "tavi-plugin.json"), "{}");
  writeFileSync(join(snapshot, "assets", "notes.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(snapshot, "assets", "other.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><title>not named</title></svg>');
  writeFileSync(join(snapshot, "assets", "data.json"), '{"secret":true}');
  const contentHash = hashPluginDirectory(snapshot).hash;
  const state = { approved: true, asked: 0 };
  let origin = "";
  let handler: ReturnType<typeof createPluginUiRoute> | undefined;
  const server = createServer((request, response) => {
    void handler?.handle(request, response, (request.url ?? "/").split("?")[0] ?? "/");
  });
  servers.push(server);
  const port = await listenLocally(server);
  origin = `http://127.0.0.1:${port}`;
  handler = createPluginUiRoute({
    origin,
    dataDirectory,
    // A plugin with no UI: only its icons answer, once per load.
    lookup: async (pluginId, hash): Promise<{ icons?: PluginAppIconsEntry }> => {
      state.asked += 1;
      return state.approved && pluginId === "acme.notes" && hash === contentHash
        ? { icons: { pluginId, version: "1.0.0", contentHash, paths: ["assets/notes.svg"] } }
        : {};
    },
  });
  const get = (path: string, dest = "image") =>
    new Promise<{ status: number; type: string | undefined; body: string }>((resolve, reject) => {
      const outgoing = httpRequest(
        { host: "127.0.0.1", port, path, headers: { "sec-fetch-dest": dest, "sec-fetch-site": "same-origin" } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (body += chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, type: response.headers["content-type"], body }));
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
  return { get, base: `/plugin-ui/acme.notes/${contentHash}`, state };
}

describe("an app's icon through the bridge", () => {
  it("serves the icon the approved apps block names, as an image, asking the owner once", async () => {
    const { get, base, state } = await fixture();
    const icon = await get(`${base}/assets/notes.svg`);
    expect(icon).toMatchObject({ status: 200, type: "image/svg+xml" });
    expect(icon.body).toContain("<svg");
    expect(state.asked).toBe(1);
  });

  it("serves nothing else of the snapshot, and the icon only as an image", async () => {
    const { get, base } = await fixture();
    expect((await get(`${base}/assets/other.svg`)).status).toBe(404);
    expect((await get(`${base}/assets/data.json`, "json")).status).toBe(404);
    expect((await get(`${base}/assets/notes.svg`, "script")).status).toBe(404);
  });

  it("refuses a path that climbs out of the snapshot", async () => {
    const { get, base } = await fixture();
    for (const path of [
      `${base}/../acme.notes/assets/notes.svg`,
      `${base}/assets/../../1.0.0/assets/notes.svg`,
      `${base}/assets/%2e%2e/notes.svg`,
      `${base}/assets%2Fnotes.svg`,
      `${base}/./assets/notes.svg`,
    ]) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  it("stops serving it once the owner no longer answers for that version", async () => {
    const { get, base, state } = await fixture();
    expect((await get(`${base}/assets/notes.svg`)).status).toBe(200);
    state.approved = false;
    expect((await get(`${base}/assets/notes.svg`)).status).toBe(404);
  });
});

const apps = {
  abi: "tavi.apps/1" as const,
  apps: [
    {
      id: "acme-notes",
      name: "Notes",
      summary: "",
      icon: "assets/notes.svg",
      category: "other" as const,
      scopes: [],
      tools: {},
      accountScope: "owner" as const,
    },
  ],
};
const view = (overrides: Partial<PluginView> = {}, reviewState: "approved" | "proposed" = "approved"): PluginView => ({
  id: "acme.notes",
  kind: "external",
  name: "Notes",
  description: "",
  enabled: true,
  core: false,
  activeVersion: "1.0.0",
  versions: [
    {
      version: "1.0.0",
      reviewState,
      contentHash: "a".repeat(64),
      installedAt: "2026-10-16T00:00:00.000Z",
      tools: [],
      configFields: {},
      runsOwnerCode: true,
      apps,
    },
  ],
  tools: [],
  configFields: {},
  config: {},
  runsOwnerCode: true,
  ...overrides,
});

describe("which app icons the owner answers for", () => {
  it("names an enabled plugin's approved version's icons, and none of a disabled, unreviewed or built-in one", () => {
    expect(pluginAppIconEntries([view()])).toEqual([
      { pluginId: "acme.notes", version: "1.0.0", contentHash: "a".repeat(64), paths: ["assets/notes.svg"] },
    ]);
    expect(pluginAppIconEntries([view({ enabled: false }), view({}, "proposed"), view({ kind: "builtin" })])).toEqual([]);
  });

  it("gives an app the icon's bridge path only while the bridge would serve it", () => {
    expect(servedIconOf(view(), "assets/notes.svg")).toBe(`/plugin-ui/acme.notes/${"a".repeat(64)}/assets/notes.svg`);
    expect(servedIconOf(view({ enabled: false }), "assets/notes.svg")).toBeUndefined();
    expect(servedIconOf(view({}, "proposed"), "assets/notes.svg")).toBeUndefined();
    expect(servedIconOf(view(), undefined)).toBeUndefined();
  });
});
