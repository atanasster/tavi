import { createServer } from "node:http";

import { describe, expect, it, afterEach } from "vitest";

import { parseArgs } from "../../src/cli/parse.js";
import { endpointFor } from "../../src/features/mcp/actions.js";
import { mcpAddManifest } from "../../src/features/mcp/add.js";
import { argumentFloor } from "../../src/features/mcp/bridge.js";
import { GOOGLE_MAPS_PRESET } from "../../src/features/mcp/presets/google-maps.js";
import { otherWaysIn } from "../../src/features/mcp/presets/index.js";
import { EXIT, main } from "../../src/main.js";
import { capture } from "../support/attached-owner.js";
import { HOMEASSISTANT_PRESET } from "../../src/features/mcp/presets/homeassistant.js";
import { PRESET_SLUGS } from "../../src/features/apps/owner.js";
import { TODOIST_PRESET, TODOIST_TOKEN_PRESET } from "../../src/features/mcp/presets/todoist.js";
import { HOSTED_PRESETS } from "../../src/features/mcp/presets/hosted.js";
import { decide, observeTools } from "../../src/features/mcp/review.js";
import { McpSupervisor } from "../../src/features/mcp/supervisor.js";
import type { McpToolRecord } from "@tavi/contracts";
import { listenLocally, temporaryDirectories } from "@tavi/test-support";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

/** The Home Assistant preset; the real run is `mcp-homeassistant.live.test.ts`. */

const record = (name: string, effect: McpToolRecord["suggestedEffect"]): McpToolRecord => ({
  pluginId: "mcp.home",
  version: "1.0.0",
  name,
  toolId: `mcp.home.${name.toLowerCase()}`,
  observedDefHash: "h",
  observedDef: { name, inputSchema: { type: "object" } },
  suggestedEffect: effect,
  suggestedMinRisk: "high",
  doubtful: false,
  flagged: false,
  state: "pending",
});
const none = { effects: {}, floors: {}, timeouts: {}, disabled: new Set<string>() };

describe("the homeassistant preset", () => {
  it("writes a remote manifest: the url and token as settings, the token a credential, lan, and its name", () => {
    const manifest = mcpAddManifest({ slug: "home", form: { kind: "preset", preset: "homeassistant" } });
    expect(manifest).toMatchObject({
      id: "mcp.home",
      name: "Home Assistant",
      config: { url: { type: "string", required: true }, token: { type: "credential", required: true } },
      mcp: {
        transport: "http",
        url: { setting: "url" },
        headers: { Authorization: { prefix: "Bearer ", setting: "token" } },
        network: { lan: true },
        auth: "headers",
        preset: "homeassistant",
      },
    });
    expect(parseArgs(["mcp", "add", "home", "--preset", "homeassistant"])).toMatchObject({
      mcp: { action: "add", form: { kind: "preset", preset: "homeassistant" } },
    });
    expect(() => parseArgs(["mcp", "add", "home", "--preset", "strava"])).toThrow(
      /--preset must be one of homeassistant, google-maps, todoist, todoist-token, linear, notion, sentry, stripe, figma, received "strava"/,
    );
    expect(() => parseArgs(["mcp", "add", "home", "--preset", "homeassistant", "--lan"])).toThrow(/a preset sets its own/);
  });

  it("turning on or off is critical unless every domain and device class it names is safe, and it names one", () => {
    const floors = HOMEASSISTANT_PRESET.floors({ name: "intent__HassTurnOff", effect: "mutating" })?.argFloors ?? [];
    expect(argumentFloor(floors, { name: "Kitchen light", domain: ["light"] })).toBe("low");
    expect(argumentFloor(floors, { area: "Hallway" })).toBe("critical");
    expect(argumentFloor(floors, { name: "Front door", domain: ["lock"] })).toBe("critical");
    expect(argumentFloor(floors, { name: "Garage", domain: ["switch"], device_class: ["garage"] })).toBe("critical");
    expect(argumentFloor(floors, { domain: ["light", "cover"] })).toBe("critical");
    expect(argumentFloor(floors, { domain: [] })).toBe("critical");
    // A scene can unlock a door or open a cover: not safe.
    expect(argumentFloor(floors, { name: "Leave home", domain: ["scene"] })).toBe("critical");
  });

  it("is an allowlist: a targeting intent gets the floor, a reviewed write keeps its suggestion, any other write is critical", () => {
    const floors = HOMEASSISTANT_PRESET.floors;
    expect(floors({ name: "intent__HassToggle", effect: "mutating" })?.argFloors).toHaveLength(1);
    expect(floors({ name: "light__HassLightSet", effect: "mutating" })).toBeUndefined();
    expect(floors({ name: "todo__HassListAddItem", effect: "mutating" })).toBeUndefined();
    // Exposing a cover or a valve adds an intent nobody reviewed here.
    expect(floors({ name: "intent__HassSetPosition", effect: "mutating" })).toEqual({ minRisk: "critical" });
    expect(floors({ name: "valve__HassValveOpen", effect: "mutating" })).toEqual({ minRisk: "critical" });
    expect(floors({ name: "script__goodnight", effect: "external" })).toEqual({ minRisk: "critical" });
    expect(floors({ name: "homeassistant__GetLiveContext", effect: "read-only" })).toBeUndefined();
  });

  it("joins each tool's decision at approval: floors on HassTurnOn/Off, critical scripts, the rest as suggested", () => {
    const tools = [
      record("intent__HassTurnOn", "mutating"),
      record("script__goodnight", "external"),
      record("light__HassLightSet", "mutating"),
      record("homeassistant__GetLiveContext", "read-only"),
    ];
    const decisions = decide(tools, none, true, new Map(), HOMEASSISTANT_PRESET);
    expect(decisions["intent__HassTurnOn"]).toMatchObject({
      minRisk: "high",
      argFloors: [{ risk: "critical", identify: ["domain", "device_class"] }],
    });
    expect(decisions["script__goodnight"]).toMatchObject({ minRisk: "critical" });
    expect(decisions["light__HassLightSet"]).toMatchObject({ minRisk: "high" });
    expect(decisions["light__HassLightSet"]).not.toHaveProperty("argFloors");
    expect(decisions["homeassistant__GetLiveContext"]).toMatchObject({ effect: "read-only" });
  });

  it("a stricter preset reaches a decision carried from an earlier version", () => {
    const tools = [record("intent__HassSetPosition", "mutating")];
    const carried = new Map([
      [
        "intent__HassSetPosition",
        { decision: { effect: "mutating" as const, minRisk: "high" as const, timeoutMs: 60_000, askTainted: true }, from: "1.0.0" },
      ],
    ]);
    expect(decide(tools, none, true, carried, HOMEASSISTANT_PRESET)["intent__HassSetPosition"]).toMatchObject({ minRisk: "critical" });
  });
});

describe("a header-authenticated server (auth: headers)", () => {
  it("reads its headers for every request, so a rotated token applies on the next call", async () => {
    let reads = 0;
    const manifest = mcpAddManifest({ slug: "home", form: { kind: "preset", preset: "homeassistant" } });
    const { endpoint } = await endpointFor(
      manifest,
      { config: { url: "http://127.0.0.1:1/api/mcp", token: "plugins.mcp.home.token" } } as never,
      { pluginId: "mcp.home", version: "1.0.0", sandboxState: "srt", transport: "http", treeIndexStale: false },
      {
        registry: {} as never,
        mcp: {} as never,
        dataDirectory: "/nonexistent",
        now: () => "2026-10-14T00:00:00.000Z",
        resolveSecret: async () => `token-${String((reads += 1))}`,
      },
    );
    if (endpoint.transport !== "http" || endpoint.headers === undefined) throw new Error("not an http endpoint");
    expect(await endpoint.headers()).toEqual({ Authorization: "Bearer token-2" });
    expect(await endpoint.headers()).toEqual({ Authorization: "Bearer token-3" });
  });

  it("a refused credential fails the call as an auth failure, and the server is not backed off", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("Unauthorized");
    });
    const port = await listenLocally(server);
    const data = directories.create("tavi-mcp-auth-");
    const supervisor = new McpSupervisor({
      dataDirectory: data,
      spec: async () => ({
        pluginId: "mcp.home",
        version: "1.0.0",
        transport: "http",
        maxMessageBytes: 1024 * 1024,
        concurrency: 4,
        prior: { kind: "legacy" },
        endpoint: async () => ({ transport: "http", url: `http://127.0.0.1:${String(port)}/api/mcp` }),
      }),
    });
    try {
      await expect(supervisor.call("mcp.home", "intent__HassTurnOn", {}, { timeoutMs: 5_000 })).rejects.toMatchObject({
        code: "NOT_AUTHORIZED",
        details: { mcpFailure: "auth" },
      });
      expect(supervisor.status("mcp.home")).toMatchObject({ failures: 0 });
      expect(supervisor.status("mcp.home").state).not.toBe("backing-off");
      // And again at once: nothing waits out a backoff.
      await expect(supervisor.call("mcp.home", "intent__HassTurnOn", {}, { timeoutMs: 5_000 })).rejects.toMatchObject({
        details: { mcpFailure: "auth" },
      });
    } finally {
      await supervisor.shutdown();
      server.close();
    }
  });
});

describe("the google-maps preset", () => {
  it("writes a remote manifest at Google's Grounding Lite address, the person's own API key in X-Goog-Api-Key", () => {
    const manifest = mcpAddManifest({ slug: "gmaps", form: { kind: "preset", preset: "google-maps" } });
    expect(manifest).toMatchObject({
      id: "mcp.gmaps",
      name: "Google Maps",
      config: { apiKey: { type: "credential", required: true } },
      mcp: {
        transport: "http",
        url: { value: "https://mapstools.googleapis.com/mcp" },
        headers: { "X-Goog-Api-Key": { setting: "apiKey" } },
        auth: "headers",
        preset: "google-maps",
      },
    });
    expect(manifest.mcp?.network).toBeUndefined();
    expect(parseArgs(["mcp", "add", "gmaps", "--preset", "google-maps"])).toMatchObject({
      mcp: { form: { kind: "preset", preset: "google-maps" } },
    });
  });

  it("keeps each tool's own annotations and adds no floor; its description names Google's attribution and model rules", () => {
    const listed = ["search_places", "lookup_weather", "compute_routes", "search_along_route", "resolve_names", "resolve_maps_urls"].map(
      (name) => ({
        name,
        inputSchema: { type: "object" as const },
        annotations: { readOnlyHint: true, openWorldHint: true },
      }),
    );
    const tools = observeTools("mcp.gmaps", "1.0.0", "gmaps", listed).map((tool) => ({ ...tool, state: "pending" as const }));
    const decisions = decide(tools, none, true, new Map(), GOOGLE_MAPS_PRESET);
    for (const name of listed.map((tool) => tool.name)) {
      expect(decisions[name], name).toMatchObject({ effect: "read-only" });
      expect(decisions[name], name).not.toHaveProperty("argFloors");
    }
    expect(GOOGLE_MAPS_PRESET.effect).toBeUndefined();
    expect(GOOGLE_MAPS_PRESET.description).toMatch(/Google Maps source links/);
    expect(GOOGLE_MAPS_PRESET.description).toMatch(/must not cache, store or train/);
    expect(Object.keys(GOOGLE_MAPS_PRESET.app?.tools ?? {}).sort()).toEqual(listed.map((tool) => tool.name).sort());
  });
});

describe("the todoist preset", () => {
  it("writes a remote OAuth manifest at Doist's hosted server, with no client of your own to set", () => {
    const manifest = mcpAddManifest({ slug: "todoist", form: { kind: "preset", preset: "todoist" } });
    expect(manifest).toMatchObject({
      id: "mcp.todoist",
      name: "Todoist",
      mcp: { transport: "http", url: { value: "https://ai.todoist.net/mcp" }, auth: "oauth", preset: "todoist" },
    });
    expect(TODOIST_PRESET.app?.auth).toMatchObject({ kind: "oauth", client: "registration" });
    expect(parseArgs(["mcp", "add", "todoist", "--preset", "todoist"])).toMatchObject({
      mcp: { form: { kind: "preset", preset: "todoist" } },
    });
  });

  it("keeps the tools' own annotations, and gives delete-object a high floor", () => {
    const listed = [
      { name: "find-tasks", inputSchema: { type: "object" as const }, annotations: { readOnlyHint: true } },
      { name: "add-tasks", inputSchema: { type: "object" as const }, annotations: { readOnlyHint: false, destructiveHint: false } },
      { name: "delete-object", inputSchema: { type: "object" as const }, annotations: { readOnlyHint: false, destructiveHint: true } },
    ];
    const tools = observeTools("mcp.todoist", "1.0.0", "todoist", listed).map((tool) => ({ ...tool, state: "pending" as const }));
    const decisions = decide(tools, none, true, new Map(), TODOIST_PRESET);
    expect(decisions["find-tasks"]).toMatchObject({ effect: "read-only" });
    expect(decisions["add-tasks"]).not.toHaveProperty("minRisk");
    expect(decisions["delete-object"]).toMatchObject({ minRisk: "high" });
  });
});

describe("the todoist-token preset", () => {
  it("reaches the same server with the person's API token as a Bearer header, under the same name, with the same tools and floors", () => {
    const manifest = mcpAddManifest({ slug: "todoist", form: { kind: "preset", preset: "todoist-token" } });
    expect(manifest).toMatchObject({
      id: "mcp.todoist",
      name: "Todoist (API token)",
      config: { apiToken: { type: "credential", required: true } },
      mcp: {
        transport: "http",
        url: { value: "https://ai.todoist.net/mcp" },
        headers: { Authorization: { prefix: "Bearer ", setting: "apiToken" } },
        auth: "headers",
        preset: "todoist-token",
      },
    });
    expect(TODOIST_TOKEN_PRESET.app?.auth).toBeUndefined();
    expect(TODOIST_TOKEN_PRESET.app?.tools).toEqual(TODOIST_PRESET.app?.tools);
    expect(TODOIST_TOKEN_PRESET.floors({ name: "delete-object", effect: "mutating" })).toEqual({ minRisk: "high" });
    expect(PRESET_SLUGS["todoist-token"]).toBe("todoist");
  });

  it("is the other way into Todoist's server: adding it beside the sign-in offers the switch, not a version conflict", async () => {
    expect(otherWaysIn("todoist-token")).toEqual(["todoist"]);
    expect(otherWaysIn("todoist")).toEqual(["todoist-token"]);
    expect(otherWaysIn("google-maps")).toEqual([]);
    const at = ["--data-dir", directories.create("tavi-todoist-ways-")];
    const run = async (argv: readonly string[]) => {
      const out = capture();
      return { code: await main([...argv, ...at], { io: out.io }), stderr: out.stderr() };
    };
    const first = await run(["mcp", "add", "todoist", "--preset", "todoist", "--no-probe"]);
    expect(first.stderr).toBe("");
    expect(first.code).toBe(EXIT.ok);
    for (const slug of ["todoist", "tasks"]) {
      const second = await run(["mcp", "add", slug, "--preset", "todoist-token", "--no-probe"]);
      expect(second.code).toBe(EXIT.usage);
      expect(second.stderr).not.toContain("bump the version");
      expect(second.stderr).toContain(
        "mcp.todoist is already added as Todoist, another way into the same server: Tavi keeps one. Switch it with `tavi apps add todoist-token --switch` while Tavi runs, or remove it first (`tavi plugins remove mcp.todoist`)",
      );
    }
  });
});

describe("the hosted presets", () => {
  it("each writes a remote OAuth manifest at its vendor's server, its client registered by the server, no floor added", () => {
    for (const preset of HOSTED_PRESETS) {
      const manifest = mcpAddManifest({ slug: preset.id, form: { kind: "preset", preset: preset.id } });
      expect(manifest, preset.id).toMatchObject({
        id: `mcp.${preset.id}`,
        name: preset.name,
        mcp: { transport: "http", url: { value: expect.stringMatching(/^https:\/\/mcp\./) }, auth: "oauth", preset: preset.id },
      });
      expect(preset.app?.auth).toMatchObject({ kind: "oauth", client: "registration" });
      // A client of the person's own can be set, for a server that stops registering them.
      expect(Object.keys(manifest.config ?? {}).sort(), preset.id).toEqual(["clientId", "clientSecret"]);
      expect(preset.floors({ name: "anything", effect: "read-only" })).toBeUndefined();
      expect(preset.floors({ name: "anything", effect: "mutating" })).toEqual(preset.id === "stripe" ? { minRisk: "high" } : undefined);
    }
    expect(HOSTED_PRESETS.map((preset) => preset.id)).toEqual(["linear", "notion", "sentry", "stripe", "figma"]);
  });
});

describe("the preset rule", () => {
  it("each preset names what withdraws it, and was checked within 180 days: a release re-checks it, or this fails", () => {
    for (const preset of [HOMEASSISTANT_PRESET, GOOGLE_MAPS_PRESET, TODOIST_PRESET, ...HOSTED_PRESETS]) {
      expect(preset.withdrawnIf.length, preset.id).toBeGreaterThan(20);
      const age = Date.now() - Date.parse(`${preset.checked}T00:00:00Z`);
      expect(
        age / 86_400_000,
        `${preset.id} was last checked on ${preset.checked}: check it against the live server, then update checked`,
      ).toBeLessThan(180);
    }
  });
});
