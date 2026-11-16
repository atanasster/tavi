import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModEnvelope } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories, delay } from "@tavi/test-support";

import { parseArgs } from "../../src/cli/parse.js";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { main } from "../../src/main.js";
import { renderServiceUnit } from "../../src/features/service/unit.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/** `tavi serve --dev-plugin`. */

const dirs = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  dirs.cleanup();
});

const temp = () => {
  const path = dirs.create("tavi-dev-plugin-");
  return path;
};

const workspaces = [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke", "models.invoke", "runs.create"] }];
const envelope: ModEnvelope = { workspaceId: "default", principalId: "operator", taskId: "t", runId: "t", source: "cli", attended: true };
const check = {
  envelope,
  tool: "sandbox.run",
  callId: "c",
  input: { command: "ls" },
  verdict: { decision: "allow" as const, reasons: [] },
};

const denying = (reason: string) => `export function register({ hooks }) {
  hooks.on("tool.check", { tools: ["sandbox.run"] }, async () => ({ decision: "deny", reason: ${JSON.stringify(reason)} }));
}`;

function devPlugin(code: string): string {
  const path = temp();
  writeFileSync(join(path, "index.mjs"), code);
  writeFileSync(
    join(path, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.dev",
      version: "0.0.1",
      name: "Dev",
      entry: "index.mjs",
      mods: {
        abi: "tavi.mods/1",
        hooks: [{ event: "tool.check", match: { tools: ["sandbox.run"] }, onFailure: "deny", disclosure: "Denies everything." }],
      },
    }),
  );
  return path;
}

async function compose(devPlugins: readonly string[], dataDirectory = temp()): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(fixtureServeOptions(dataDirectory, { workspaces, devPlugins }), {
    requireModelTransport: false,
  });
  runtimes.push(runtime);
  return runtime;
}

const decided = async (runtime: TaviRuntime) =>
  (await runtime.turnHooks.dispatch("tool.check", check, async () => ({ decision: "allow" as const }))).result;

describe("dev plugins", () => {
  it("loads an unapproved folder, lists it as dev, and reloads it after a save", async () => {
    const source = devPlugin(denying("first"));
    const runtime = await compose([source]);
    expect(await decided(runtime)).toEqual({ decision: "deny", reason: "first" });
    expect(await runtime.plugins.registry.show("acme.dev", runtime.plugins)).toMatchObject({
      id: "acme.dev",
      dev: true,
      enabled: true,
      directory: source,
      phase: "ready",
    });
    // Nothing was installed.
    expect(await runtime.store.asPort().repositories.plugins.listVersions()).toMatchObject({ versions: [] });

    writeFileSync(join(source, "index.mjs"), denying("second"));
    await vi.waitFor(async () => expect(await decided(runtime)).toEqual({ decision: "deny", reason: "second" }), {
      timeout: 5_000,
      interval: 100,
    });

    // A save that no longer checks out keeps the last good load running.
    writeFileSync(join(source, "index.mjs"), `import x from "left-pad"; ${denying("third")}`);
    await delay(800);
    expect(await decided(runtime)).toEqual({ decision: "deny", reason: "second" });
  });

  it("shows a reload whose register throws as failed, and runs the next good save with its breaker closed", async () => {
    const source = devPlugin(`export function register({ hooks }) {
      hooks.on("tool.check", { tools: ["sandbox.run"] }, async () => { throw new Error("broken"); });
    }`);
    const runtime = await compose([source]);
    for (let attempt = 0; attempt < 5; attempt += 1) await decided(runtime);
    expect(runtime.plugins.status("acme.dev").phase).toBe("degraded");

    writeFileSync(join(source, "index.mjs"), "export function register() { throw new Error('register broke'); }");
    await vi.waitFor(
      () => expect(runtime.plugins.status("acme.dev")).toMatchObject({ phase: "failed", error: expect.stringContaining("register broke") }),
      { timeout: 5_000, interval: 100 },
    );
    expect(runtime.turnHooks.has("tool.check", envelope, "sandbox.run")).toBe(false);

    writeFileSync(join(source, "index.mjs"), denying("fixed"));
    await vi.waitFor(async () => expect(await decided(runtime)).toEqual({ decision: "deny", reason: "fixed" }), {
      timeout: 5_000,
      interval: 100,
    });
    expect(runtime.plugins.status("acme.dev").phase).toBe("ready");
  });

  it("tries a failed reload again when the same content is saved again", async () => {
    const source = devPlugin(denying("first"));
    const runtime = await compose([source]);
    // Fails on its first load and loads on the next: what a second save of the same content gives it.
    const flaky = `export async function register({ hooks, state }) {
      const tries = ((await state.load()).tries ?? 0) + 1;
      await state.put("tries", tries);
      if (tries === 1) throw new Error("not yet");
      hooks.on("tool.check", { tools: ["sandbox.run"] }, async () => ({ decision: "deny", reason: "second try" }));
    }`;
    writeFileSync(join(source, "index.mjs"), flaky);
    await vi.waitFor(
      () => expect(runtime.plugins.status("acme.dev")).toMatchObject({ phase: "failed", error: expect.stringContaining("not yet") }),
      { timeout: 5_000, interval: 100 },
    );
    writeFileSync(join(source, "index.mjs"), flaky);
    await vi.waitFor(async () => expect(await decided(runtime)).toEqual({ decision: "deny", reason: "second try" }), {
      timeout: 5_000,
      interval: 100,
    });
  });

  it("keeps a dev plugin's hook audit apart from an installed plugin's of the same id", async () => {
    const runtime = await compose([devPlugin(denying("not now"))]);
    expect(await decided(runtime)).toEqual({ decision: "deny", reason: "not now" });
    // Its decision is credited to the dev plugin, so a verdict's rule is mod:dev:<id>, never the installed plugin's.
    expect((await runtime.turnHooks.dispatch("tool.check", check, async () => ({ decision: "allow" as const }))).decidedBy).toBe(
      "dev:acme.dev",
    );
    const repository = runtime.store.asPort().repositories.plugins;
    await vi.waitFor(
      async () => expect((await runtime.plugins.registry.show("acme.dev", runtime.plugins)).hookActivity).toMatchObject({ decisions: 2 }),
      { timeout: 2_000, interval: 50 },
    );
    expect(await repository.hookActivity("acme.dev", 0)).toMatchObject({ decisions: 0, failures: 0 });
    // Its audit rows name its own rule too.
    expect((await repository.listHookEvents("dev:acme.dev", 10)).map((row) => row.ruleId)).toEqual([
      "mod:dev:acme.dev",
      "mod:dev:acme.dev",
    ]);
  });

  it("does not bring back on a save a dev plugin the operator stopped", async () => {
    const dataDirectory = temp();
    const source = devPlugin(denying("dev"));
    // An installed plugin of the same id, so `tavi plugins disable` can name it.
    const setup = await compose([], dataDirectory);
    await setup.plugins.registry.install(source, "operator");
    await setup.plugins.registry.decide("acme.dev", "0.0.1", "approved", "operator");
    await setup.plugins.registry.enable("acme.dev", "operator");
    runtimes.splice(runtimes.indexOf(setup), 1);
    await setup.close();

    const runtime = await compose([source], dataDirectory);
    expect(await decided(runtime)).toEqual({ decision: "deny", reason: "dev" });
    await runtime.plugins.registry.disable("acme.dev", "operator");
    expect(await decided(runtime)).toEqual({ decision: "allow" });
    writeFileSync(join(source, "index.mjs"), denying("back again"));
    await delay(800);
    expect(await decided(runtime)).toEqual({ decision: "allow" });
    expect((await runtime.plugins.registry.show("acme.dev", runtime.plugins)).phase).toBe("stopped");
  });

  it("keeps a dev plugin's state apart from an installed plugin's of the same id", async () => {
    const source = devPlugin(`export function register({ hooks, state }) {
      hooks.on("tool.check", { tools: ["sandbox.run"] }, async () => { await state.put("seen", "dev"); return { decision: "deny", reason: "dev" }; });
    }`);
    const runtime = await compose([source]);
    await runtime.store.asPort().repositories.plugins.putPluginState("acme.dev", "seen", "installed", nowTimestamp());
    await decided(runtime);
    const plugins = runtime.store.asPort().repositories.plugins;
    expect(await plugins.loadPluginState("acme.dev")).toEqual({ seen: "installed" });
    expect(await plugins.loadPluginState("dev:acme.dev")).toEqual({ seen: "dev" });
  });

  it("refuses a folder install would refuse, at start", async () => {
    const source = devPlugin(`import x from "left-pad"; ${denying("x")}`);
    await expect(compose([source])).rejects.toThrow("bundle dependency left-pad into the artifact");
  });
});

describe("tavi service units", () => {
  // A system unit runs serve as an ordinary user: root is refused at render time.
  const unit = {
    nodePath: "/usr/bin/node",
    executablePath: "/opt/tavi/executable.mjs",
    dataDirectory: "/var/tavi",
    label: "dev.tavi.serve",
    systemd: { user: "tavi" },
  };
  it("mark the owner as a service, so serve refuses --dev-plugin, and never carry one", () => {
    expect(renderServiceUnit({ ...unit, kind: "launchd" })).toContain("<key>TAVI_SERVICE</key>\n    <string>1</string>");
    expect(renderServiceUnit({ ...unit, kind: "systemd" })).toContain("Environment=TAVI_SERVICE=1");
    expect(() => renderServiceUnit({ ...unit, kind: "systemd", serveArgs: ["--dev-plugin", "/src/mod"] })).toThrow(
      "a service runs only approved plugins",
    );
  });
});

describe("the developer loop's commands", () => {
  it("parses plugins validate and serve --dev-plugin", () => {
    expect(parseArgs(["plugins", "validate", "./mod", "--format", "json"])).toMatchObject({
      command: "plugins",
      plugins: { action: "validate", path: "./mod", format: "json" },
    });
    expect(() => parseArgs(["plugins", "validate"])).toThrow("plugins validate needs a plugin directory path");
    expect(parseArgs(["serve", "--dev-plugin", "./a", "--dev-plugin", "/b"])).toMatchObject({
      command: "serve",
      serve: { devPlugins: ["./a", "/b"] },
    });
  });

  it("refuses serve --dev-plugin under a service", async () => {
    const errors: string[] = [];
    vi.stubEnv("TAVI_SERVICE", "1");
    try {
      const code = await main(["serve", "--data-dir", temp(), "--dev-plugin", devPlugin(denying("x"))], {
        io: {
          stdout: () => {},
          stderr: (text: string) => errors.push(text),
          isTty: false,
        },
      });
      expect(code).toBe(2);
      expect(errors.join("")).toContain("--dev-plugin is refused when the owner runs as a service");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
