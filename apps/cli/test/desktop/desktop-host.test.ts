import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DesktopPort, type DesktopTreeResult, isRefusedEarly } from "@tavi/contracts";
import { partialFake, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESKTOP_STOPPED_NOTICE,
  createDesktopWorkspaces,
  createOwnerDesktopBridge,
  desktopHelperBuild,
  desktopHelperMissing,
  desktopHelperPath,
  grantedTierOf,
  requireDesktopHelper,
} from "../../src/features/desktop/host.js";
import { DESKTOP_PLUGIN_ID } from "../../src/features/plugins/catalog.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/** What a call threw. */
function captured(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

const directories = temporaryDirectories({ prefix: "tavi-desktop-host-" });
afterEach(() => directories.cleanup());

describe("desktop control on the owner", () => {
  it("has the bridge give the same build commands as the tools when the helper is missing (QA-20261110-1905)", async () => {
    const dataDirectory = directories.create();
    const bridge = createOwnerDesktopBridge(dataDirectory, () => undefined);
    const message = desktopHelperMissing(dataDirectory);
    expect(() => requireDesktopHelper(dataDirectory)).toThrow(message);
    await expect(bridge.apps()).rejects.toMatchObject({ code: "NOT_CONFIGURED", message });
    expect(message).not.toMatch(/pnpm/);
    await bridge.dispose();
  });

  it("refuses a missing helper in Tavi's own words, before it reached anything, so the chat stays untainted (QA 1894)", async () => {
    const dataDirectory = directories.create();
    const bridge = createOwnerDesktopBridge(dataDirectory, () => undefined);
    expect(isRefusedEarly(captured(() => requireDesktopHelper(dataDirectory)))).toBe(true);
    expect(isRefusedEarly(await bridge.apps().catch((error: unknown) => error))).toBe(true);
    await bridge.dispose();
  });

  it("grants an app the list names, by bundle id or name in any case, at its built-in tier, and no other", () => {
    const granted = ["com.apple.TextEdit", "terminal", "Finder"];
    expect(grantedTierOf(granted, { bundleId: "com.apple.TextEdit", name: "TextEdit" })).toBe("full");
    expect(grantedTierOf(granted, { bundleId: "com.apple.Terminal", name: "Terminal" })).toBe("click-only");
    expect(grantedTierOf(granted, { bundleId: "com.apple.finder", name: "Finder" })).toBe("warning");
    expect(grantedTierOf(granted, { bundleId: "com.apple.Notes", name: "Notes" })).toBeUndefined();
    expect(grantedTierOf([], { bundleId: "com.apple.TextEdit", name: "TextEdit" })).toBeUndefined();
  });

  it("holds each workspace to the apps it granted, as they are when it calls", async () => {
    const tree = (bundleId: string, name: string): DesktopTreeResult => ({ app: { bundleId, name, pid: 1 }, nodes: [] });
    const desktop = partialFake<DesktopPort>({
      tree: async (app) => (app === "com.apple.TextEdit" ? tree("com.apple.TextEdit", "TextEdit") : tree("com.apple.Notes", "Notes")),
    });
    const grants: Record<string, string[]> = { w1: ["com.apple.TextEdit"], w2: [] };
    const workspaces = createDesktopWorkspaces({ desktop, grantedApps: async (workspaceId) => grants[workspaceId] ?? [] });
    await workspaces.refresh("w1", "run-1");
    await workspaces.refresh("w2", "run-2");
    await expect(workspaces.portFor("w1").tree("com.apple.TextEdit")).resolves.toMatchObject({ app: { name: "TextEdit" } });
    await expect(workspaces.portFor("w2").tree("com.apple.TextEdit")).rejects.toThrow(/not granted/);
    // A grant removed since is gone at the next call.
    grants["w1"] = [];
    await workspaces.refresh("w1", "run-1");
    await expect(workspaces.portFor("w1").tree("com.apple.TextEdit")).rejects.toThrow(/not granted/);
    // The card reads the same grants.
    expect(workspaces.tierOf("w1", { bundleId: "com.apple.TextEdit", name: "TextEdit" })).toBeUndefined();
    grants["w1"] = ["TextEdit"];
    await workspaces.refresh("w1", "run-1");
    expect(workspaces.tierOf("w1", { bundleId: "com.apple.TextEdit", name: "TextEdit" })).toBe("full");
    // What desktop.observe lists: the grants as last read, the workspace's own.
    expect(workspaces.grantedApps("w1")).toEqual(["TextEdit"]);
    expect(workspaces.grantedApps("w2")).toEqual([]);
    expect(workspaces.grantedApps("unread")).toEqual([]);
    // Each workspace keeps its own gate, and so its own observed trees.
    expect(workspaces.portFor("w1")).toBe(workspaces.portFor("w1"));
    expect(workspaces.portFor("w1")).not.toBe(workspaces.portFor("w2"));
  });

  it("stops every run that used desktop control at the abort hotkey, a card still pending too, and acts again in a later run", async () => {
    const acted: string[] = [];
    const desktop = partialFake<DesktopPort>({
      act: async (action) => (acted.push(action.kind), { status: "accepted" as const }),
      focusedElement: async () => undefined,
      abort: async () => undefined,
    });
    const told: { readonly workspaceId: string; readonly runId: string }[][] = [];
    const workspaces = createDesktopWorkspaces({ desktop, grantedApps: async () => [], onStopped: (runs) => void told.push([...runs]) });
    const wait = { kind: "wait", ms: 1 } as const;
    const stopped = { code: "CANCELLED", message: expect.stringMatching(/abort hotkey/) };
    await workspaces.refresh("w1", "run-a");
    await workspaces.refresh("w1", "run-b");
    // Run c's card is being asked about: no call of it has acted yet.
    workspaces.noteRun("w1", "run-c");
    workspaces.abortAll();
    // Each run it stopped is told so in its chat, once (QA-20261110-1906).
    expect(told).toEqual([["run-a", "run-b", "run-c"].map((runId) => ({ workspaceId: "w1", runId }))]);
    expect(DESKTOP_STOPPED_NOTICE).toBe("Desktop control stopped for this run");
    workspaces.abortAll();
    expect(told).toHaveLength(1);
    for (const run of ["run-a", "run-b", "run-c"]) await expect(workspaces.refresh("w1", run), run).rejects.toMatchObject(stopped);
    // A run that starts after it acts, and its gate is clear.
    await workspaces.refresh("w1", "run-d");
    await expect(workspaces.portFor("w1").act(wait, { attended: true })).resolves.toMatchObject({ status: "accepted" });
    expect(acted).toEqual(["wait"]);
  });

  it("refuses until the helper is built, saying the commands that build it for this data directory", () => {
    const dataDirectory = directories.create();
    expect(() => requireDesktopHelper(dataDirectory)).toThrow(
      expect.objectContaining({ code: "NOT_CONFIGURED", message: expect.stringContaining("swiftc -O") }),
    );
    const [mkdir, compile, sign] = desktopHelperBuild(dataDirectory);
    expect(mkdir).toBe(`mkdir -p '${join(dataDirectory, "desktop")}'`);
    expect(compile).toMatch(/^swiftc -O '.*native\/helper\.swift' -o /);
    expect(compile).toContain(`'${desktopHelperPath(dataDirectory)}'`);
    expect(sign).toBe(`codesign -s - --force '${desktopHelperPath(dataDirectory)}'`);
    // A path is quoted for a shell to read it literally: nothing in it expands.
    expect(desktopHelperBuild("/data/it's $HOME")[0]).toBe(`mkdir -p '/data/it'\\''s $HOME/desktop'`);
    mkdirSync(join(dataDirectory, "desktop"));
    // A file that cannot be run is no helper.
    writeFileSync(desktopHelperPath(dataDirectory), "");
    expect(() => requireDesktopHelper(dataDirectory)).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
    chmodSync(desktopHelperPath(dataDirectory), 0o700);
    expect(requireDesktopHelper(dataDirectory)).toBe(desktopHelperPath(dataDirectory));
  });
});

describe("tavi.desktop as a built-in", () => {
  const runtimes: TaviRuntime[] = [];
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.close();
  });
  async function compose(dataDirectory: string): Promise<TaviRuntime> {
    const runtime = await composeTaviRuntime(fixtureRuntimeOptions(dataDirectory, { scheduleSweepEnabled: false }), {
      requireModelTransport: false,
    });
    runtimes.push(runtime);
    return runtime;
  }

  it("offers no desktop tools until enabled, and then, on macOS, refuses until its helper is built", async () => {
    const dataDirectory = directories.create();
    const first = await compose(dataDirectory);
    expect((await first.plugins.registry.show(DESKTOP_PLUGIN_ID, first.plugins)).enabled).toBe(false);
    expect(first.tools.get("desktop.act")).toBeUndefined();
    await first.plugins.registry.enable(DESKTOP_PLUGIN_ID, "operator");
    await runtimes.splice(0)[0]?.close();
    const second = await compose(dataDirectory);
    const observe = second.tools.get("desktop.observe");
    if (process.platform !== "darwin") {
      expect(observe).toBeUndefined();
      return;
    }
    expect(second.tools.get("desktop.act")).toBeDefined();
    await expect(
      observe?.handler({
        input: { app: "com.apple.TextEdit" },
        context: { workspaceId: "default", principalId: "operator", runId: "t", caller: "test" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED", message: expect.stringContaining("swiftc -O") });
  });
});
