import { describe, expect, it } from "vitest";

import {
  BLOCKED_DESKTOP_APPS,
  PluginManifestSchema,
  approvedIsolation,
  createDesktopLiveTarget,
  defaultDesktopAppGrantTier,
  isBlockedDesktopApp,
  isDesktopAuthDialog,
  isDesktopCredentialNode,
  isTaviDesktopApp,
  workerRefusal,
} from "../src/index.js";

/** Where an approval runs a plugin's code. */

const manifest = (fields: Record<string, unknown> = {}) =>
  PluginManifestSchema.parse({
    schemaVersion: 2,
    abi: "tavi.providers/1",
    provenance: { format: "bundled-esm", packages: [] },
    id: "acme.tool",
    version: "1.0.0",
    name: "Tool",
    entry: "index.mjs",
    ...fields,
  });
const pigeon = {
  providerId: "pigeon",
  label: "Pigeon",
  kind: "chat",
  description: "Messages by carrier pigeon.",
  settings: [{ key: "loft", label: "Loft", type: "string", required: true }],
  auth: { kind: "secrets", fields: [{ key: "token", label: "Token" }] },
  sender: { label: "Pigeon ID", placeholder: "p-1", pattern: "p-\\d+", normalize: "none", authentication: "provider" },
  target: { label: "Pigeon ID", placeholder: "p-1", pattern: "p-\\d+", normalize: "none" },
  ingress: [{ name: "events", methods: ["POST"], scope: "connection", maxBodyBytes: 1024 }],
};
/** A version with no `entry`: it only adds to the canvas. */
const noCode = () => {
  const { entry: _entry, ...rest } = manifest();
  return rest;
};

describe("workerRefusal", () => {
  it("lets a plugin of tools, hooks and commands be a worker, and says why one handing over live objects cannot", () => {
    expect(workerRefusal(manifest())).toBeUndefined();
    expect(workerRefusal(noCode())).toMatch(/runs no code/);
    expect(workerRefusal(manifest({ provides: ["channel"], channels: [pigeon], channelAbi: 1 }))).toMatch(/messaging channels/);
  });
});

describe("approvedIsolation", () => {
  it("runs a plugin that can be a worker as one, unless the approver opts out by name", () => {
    expect(approvedIsolation(manifest(), {})).toBe("process");
    expect(approvedIsolation(manifest(), { inProcess: true })).toBe("in-process");
  });

  it("refuses one that asks for, or needs, the owner's process without the opt-out", () => {
    expect(() => approvedIsolation(manifest({ isolation: "in-process" }), {})).toThrow(/--in-process/);
    expect(approvedIsolation(manifest({ isolation: "in-process" }), { inProcess: true })).toBe("in-process");
  });

  it("records nothing for a version that runs no owner code", () => {
    expect(approvedIsolation(noCode(), {})).toBeUndefined();
  });

  it("accepts rawSecrets only for credential settings, and only screen in devices", () => {
    expect(PluginManifestSchema.safeParse({ ...manifest(), config: { key: { type: "string" } }, rawSecrets: ["key"] }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...manifest(), config: { key: { type: "credential" } }, rawSecrets: ["key"] }).success).toBe(
      true,
    );
    expect(PluginManifestSchema.safeParse({ ...manifest(), devices: ["screen"] }).success).toBe(true);
    expect(PluginManifestSchema.safeParse({ ...manifest(), devices: ["camera"] }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...manifest(), network: { domains: ["*"] } }).success).toBe(false);
  });
});

describe("desktop contracts", () => {
  it("fails closed on unresolved apps and blocks password managers and Tavi identifiers", () => {
    expect(BLOCKED_DESKTOP_APPS).toContain("com.1password.1password");
    expect(BLOCKED_DESKTOP_APPS).toContain("ai.tavi.app");
    expect(isBlockedDesktopApp(undefined, undefined)).toBe(true);
    expect(isBlockedDesktopApp("", "")).toBe(true);
    expect(isBlockedDesktopApp("com.1password.1password", "1Password")).toBe(true);
    expect(isBlockedDesktopApp("com.apple.keychainaccess", "Keychain Access")).toBe(true);
    expect(isBlockedDesktopApp("ai.tavi.desktop", "Tavi")).toBe(true);
    expect(isTaviDesktopApp("ai.tavi.app")).toBe(true);
    expect(isBlockedDesktopApp("com.apple.TextEdit", "TextEdit")).toBe(false);
  });

  it("identifies credential roles/subroles, auth dialogs, and grant tiers", () => {
    expect(isDesktopCredentialNode({ role: "AXTextField", subrole: "AXSecureTextField" })).toBe(true);
    expect(isDesktopCredentialNode({ role: "AXSecureTextField" })).toBe(true);
    expect(isDesktopCredentialNode({ role: "AXTextField", subrole: "AXStandardTextField" })).toBe(false);

    expect(isDesktopAuthDialog({ bundleId: "com.apple.securityagent" })).toBe(true);
    expect(isDesktopAuthDialog({ windowTitle: "Finder wants to make changes." })).toBe(true);
    expect(isDesktopAuthDialog({ bundleId: "com.apple.TextEdit", windowTitle: "Untitled" })).toBe(false);

    expect(defaultDesktopAppGrantTier("com.apple.Safari", "Safari")).toBe("view-only");
    expect(defaultDesktopAppGrantTier("com.apple.Terminal", "Terminal")).toBe("click-only");
    expect(defaultDesktopAppGrantTier("com.apple.systempreferences", "System Settings")).toBe("warning");
    expect(defaultDesktopAppGrantTier("com.apple.TextEdit", "TextEdit")).toBe("full");
  });

  it("adapts DesktopPort into LiveTarget and LiveControlTarget", async () => {
    const actions: unknown[] = [];
    const live = createDesktopLiveTarget(
      {
        apps: async () => [],
        tree: async (app) => ({ app: { bundleId: app, name: app, pid: 1 }, nodes: [] }),
        capture: async () => ({
          data: "Zm9v",
          mediaType: "image/jpeg",
          scale: { logicalWidth: 1440, logicalHeight: 900, imageWidth: 720, imageHeight: 450 },
        }),
        act: async (action) => {
          actions.push(action);
          return { status: "accepted" };
        },
        focusedElement: async () => ({
          app: { bundleId: "com.apple.TextEdit", name: "TextEdit", pid: 10 },
          role: "AXTextField",
          subrole: "AXSecureTextField",
        }),
      },
      { target: { kind: "display" } },
    );

    expect(await live.target.sensitivity([])).toBe("password-field");
    await live.control.input({ type: "text", text: "hi" });
    expect(actions).toEqual([{ kind: "type", text: "hi" }]);
    // A press held, moved and let go is the person's drag; a double press clicks twice.
    actions.length = 0;
    for (const [action, x] of [
      ["down", 10],
      ["move", 50],
      ["up", 90],
    ] as const)
      await live.control.input({ type: "mouse", action, x, y: 20, button: "left", clickCount: 1 });
    await live.control.input({ type: "mouse", action: "down", x: 10, y: 20, button: "left", clickCount: 2 });
    expect(actions).toEqual([
      { kind: "mouse_down", x: 10, y: 20, button: "left" },
      { kind: "move", x: 50, y: 20 },
      { kind: "mouse_up", x: 90, y: 20, button: "left" },
      { kind: "click", x: 10, y: 20, button: "left", double: true },
    ]);
  });

  it("keeps a held button held until a release lands, and lets go of it when the person's control ends", async () => {
    const actions: unknown[] = [];
    let refuseRelease = true;
    const live = createDesktopLiveTarget(
      {
        apps: async () => [],
        tree: async (app) => ({ app: { bundleId: app, name: app, pid: 1 }, nodes: [] }),
        capture: async () => ({
          data: "",
          mediaType: "image/jpeg",
          scale: { logicalWidth: 1, logicalHeight: 1, imageWidth: 1, imageHeight: 1 },
        }),
        act: async (action) => {
          actions.push(action.kind);
          return action.kind === "mouse_up" && refuseRelease ? { status: "rejected" } : { status: "accepted" };
        },
      },
      { target: { kind: "display" } },
    );
    const end = await live.control.begin({ dialog: () => undefined, fileChooser: () => undefined });
    await live.control.input({ type: "mouse", action: "down", x: 1, y: 1, button: "left", clickCount: 1 });
    await live.control.input({ type: "mouse", action: "up", x: 2, y: 2, button: "left", clickCount: 1 });
    refuseRelease = false;
    await end();
    expect(actions).toEqual(["mouse_down", "mouse_up", "mouse_up"]);
  });

  it("hides the desktop while nothing says what has focus", async () => {
    const live = createDesktopLiveTarget(
      {
        apps: async () => [],
        tree: async (app) => ({ app: { bundleId: app, name: app, pid: 1 }, nodes: [] }),
        capture: async () => ({
          data: "",
          mediaType: "image/jpeg",
          scale: { logicalWidth: 1, logicalHeight: 1, imageWidth: 1, imageHeight: 1 },
        }),
        act: async () => ({ status: "accepted" }),
      },
      { target: { kind: "display" } },
    );
    expect(await live.target.sensitivity([])).toBe("blocked-host");
  });
});
