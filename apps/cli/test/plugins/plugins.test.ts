import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { InvocationContext, PluginView } from "@tavi/contracts";
import { temporaryDirectories, fakeFetch as scriptedFetch } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { EXIT, main } from "../../src/main.js";
import { BUILTIN_PLUGINS } from "../../src/features/plugins/catalog.js";
import { ATTACHED, capture, turns, useAttachedOwners } from "../support/attached-owner.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * `tavi plugins` and the Plugins page's IPC family, end to end: the
 * CLI offline and under a live owner, and composition actually running what
 * was approved — and nothing that was not.
 */

const directories = temporaryDirectories({ prefix: "tavi-plugins-cli-" });
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
});
afterAll(() => directories.cleanup());

async function tavi(argv: readonly string[]) {
  const out = capture();
  const code = await main([...argv], { io: out.io });
  return { code, stdout: out.stdout(), stderr: out.stderr() };
}

const WEATHER = `
export default {
  register({ registerTool, z, config }) {
    registerTool({ name: "forecast", inputSchema: z.object({ day: z.number() }), handler: async (input) => ({ city: config.city, days: config.days, day: input.day }) });
  },
  start() { globalThis.__taviWeatherStarts = (globalThis.__taviWeatherStarts ?? 0) + 1; },
  stop() { globalThis.__taviWeatherStopped = true; },
};
`;

function pluginDirectory(code = WEATHER, overrides: Record<string, unknown> = {}): string {
  const directory = directories.create();
  writeFileSync(
    join(directory, "tavi-plugin.json"),
    JSON.stringify({
      schemaVersion: 2,
      abi: "tavi.providers/1",
      provenance: { format: "bundled-esm", packages: [] },
      id: "acme.weather",
      version: "1.0.0",
      name: "Weather",
      description: "Forecasts",
      entry: "index.mjs",
      tools: [{ name: "forecast", effect: "external", description: "Get a forecast for a day" }],
      config: { city: { type: "string", required: true }, days: { type: "number" } },
      ...overrides,
    }),
  );
  writeFileSync(join(directory, "index.mjs"), code);
  return directory;
}

async function compose(dataDirectory: string): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(fixtureRuntimeOptions(dataDirectory), {
    modelOverride: createFixtureModel({ turns: [{ text: "done" }] }),
  });
  runtimes.push(runtime);
  return runtime;
}

/** Install, approve, configure and enable the weather plugin offline. */
async function installWeather(dataDirectory: string, source = pluginDirectory()): Promise<void> {
  const at = ["--data-dir", dataDirectory];
  for (const argv of [
    ["plugins", "install", source],
    ["plugins", "approve", "acme.weather", "1.0.0", "--in-process"],
    ["plugins", "config", "acme.weather", "--set", "city=Sofia", "--set", "days=3"],
    ["plugins", "enable", "acme.weather"],
  ]) {
    const result = await tavi([...argv, ...at]);
    expect(result.code, `${argv.join(" ")}: ${result.stderr}`).toBe(EXIT.ok);
  }
}

describe("tavi plugins offline", () => {
  it("enables and disables a UI-only plugin without asking for a restart, and shows what it adds to the canvas", async () => {
    const dataDirectory = directories.create(),
      at = ["--data-dir", dataDirectory];
    const source = directories.create();
    writeFileSync(
      join(source, "tavi-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "bundled-esm", packages: [] },
        id: "acme.view",
        version: "1.0.0",
        name: "Acme view",
        ui: {
          abi: "tavi.ui/1",
          contributions: [
            {
              id: "live",
              role: "browser-view",
              title: "Browser",
              document: "live.html",
              channels: ["browser.live"],
              placements: [{ slot: "chat.panel.tab" }],
              disclosure: "Receives live images of the agent's pages.",
            },
          ],
        },
      }),
    );
    writeFileSync(join(source, "live.html"), "<!doctype html>");
    for (const argv of [
      ["plugins", "install", source],
      ["plugins", "approve", "acme.view", "1.0.0"],
    ])
      expect((await tavi([...argv, ...at])).code).toBe(EXIT.ok);
    const enabled = await tavi(["plugins", "enable", "acme.view", ...at]);
    expect(enabled.code, enabled.stderr).toBe(EXIT.ok);
    expect(enabled.stderr).not.toContain("restart");
    const shown = await tavi(["plugins", "show", "acme.view", ...at]);
    expect(shown.stdout).toContain("runs no owner code");
    expect(shown.stdout).toContain(
      "live (role browser-view) → chat.panel.tab; receives browser.live — Receives live images of the agent's pages.",
    );
    const disabled = await tavi(["plugins", "disable", "acme.view", ...at]);
    expect(disabled.code, disabled.stderr).toBe(EXIT.ok);
    expect(disabled.stderr).not.toContain("restart");
  });

  it("still asks for a restart when an enabled version that runs code is replaced by a UI-only one", async () => {
    const dataDirectory = directories.create(),
      at = ["--data-dir", dataDirectory];
    await installWeather(dataDirectory);
    const uiOnly = directories.create();
    writeFileSync(
      join(uiOnly, "tavi-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "bundled-esm", packages: [] },
        id: "acme.weather",
        version: "2.0.0",
        name: "Weather view",
        ui: {
          abi: "tavi.ui/1",
          contributions: [{ id: "panel", title: "Weather", document: "panel.html", placements: [{ slot: "chat.panel.tab" }] }],
        },
      }),
    );
    writeFileSync(join(uiOnly, "panel.html"), "<!doctype html>");
    for (const argv of [
      ["plugins", "install", uiOnly],
      ["plugins", "approve", "acme.weather", "2.0.0"],
    ])
      expect((await tavi([...argv, ...at])).code).toBe(EXIT.ok);
    const switched = await tavi(["plugins", "enable", "acme.weather", "--version", "2.0.0", ...at]);
    expect(switched.code, switched.stderr).toBe(EXIT.ok);
    expect(switched.stderr).toContain("restart `tavi serve`");
  });

  it("lists built-ins, installs, reviews, configures, enables and shows an external plugin", async () => {
    const dataDirectory = directories.create(),
      at = ["--data-dir", dataDirectory];
    const listed = await tavi(["plugins", "list", ...at]);
    expect(listed.code, listed.stderr).toBe(EXIT.ok);
    expect(listed.stdout).toContain("tavi.persistence\tbuiltin (core)\tenabled\tbuilt-in");
    expect(listed.stdout).toContain("tavi.schedules\tbuiltin\tenabled");

    const source = pluginDirectory();
    const installed = await tavi(["plugins", "add", source, ...at]);
    expect(installed.code, installed.stderr).toBe(EXIT.ok);
    expect(installed.stdout).toContain("installed acme.weather@1.0.0 (proposed)");
    expect((await tavi(["plugins", "enable", "acme.weather", ...at])).code).toBe(EXIT.usage);

    expect((await tavi(["plugins", "approve", "acme.weather", "1.0.0", ...at])).stdout).toContain("acme.weather@1.0.0 approved");
    const missing = await tavi(["plugins", "enable", "acme.weather", ...at]);
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.stderr).toContain("city is required");
    expect((await tavi(["plugins", "config", "acme.weather", "--set", "city=Sofia", "--set", "days=3", ...at])).code).toBe(EXIT.ok);
    const enabled = await tavi(["plugins", "enable", "acme.weather", ...at]);
    expect(enabled.stdout).toContain("acme.weather enabled at 1.0.0");
    expect(enabled.stderr).toContain("restart `tavi serve`");

    const shown = await tavi(["plugins", "show", "acme.weather", "--format", "json", ...at]);
    const view = JSON.parse(shown.stdout) as PluginView;
    expect(view).toMatchObject({ kind: "external", enabled: true, activeVersion: "1.0.0", config: { city: "Sofia", days: 3 } });
    expect(view.tools).toEqual([{ id: "acme.weather.forecast", effect: "external", description: "Get a forecast for a day" }]);
    expect(view.versions[0]?.reviewState).toBe("approved");
  });

  it("shows a tool's trusted output at review, and says nothing for the untrusted default", async () => {
    const dataDirectory = directories.create(),
      at = ["--data-dir", dataDirectory];
    const tools = [
      { name: "forecast", effect: "external", description: "Get a forecast for a day" },
      { name: "own", effect: "read-only", description: "Its own data", untrustedOutput: false },
    ];
    expect((await tavi(["plugins", "add", pluginDirectory(WEATHER, { tools }), ...at])).code).toBe(EXIT.ok);
    expect((await tavi(["plugins", "approve", "acme.weather", "1.0.0", ...at])).code).toBe(EXIT.ok);
    expect((await tavi(["plugins", "add", pluginDirectory(WEATHER, { version: "1.1.0", tools }), ...at])).code).toBe(EXIT.ok);
    const shown = await tavi(["plugins", "show", "acme.weather", ...at]);
    expect(shown.code, shown.stderr).toBe(EXIT.ok);
    expect(shown.stdout).toContain("declares tools: acme.weather.forecast (external), acme.weather.own (read-only, trusted output)");
    expect(shown.stdout).toContain("  acme.weather.forecast\texternal\tGet a forecast for a day");
    expect(shown.stdout).toContain("  acme.weather.own\tread-only, trusted output\tIts own data");
  });

  it("refuses to disable a core built-in, and removes an external plugin only once disabled", async () => {
    const dataDirectory = directories.create(),
      at = ["--data-dir", dataDirectory];
    const core = await tavi(["plugins", "disable", "tavi.persistence", ...at]);
    expect(core.code).toBe(EXIT.usage);
    expect(core.stderr).toContain("cannot be disabled");
    // The terminal's and canvas's chats reach a task only through it.
    expect((await tavi(["plugins", "disable", "tavi.localmessaging", ...at])).code).toBe(EXIT.usage);
    await installWeather(dataDirectory);
    expect((await tavi(["plugins", "remove", "acme.weather", ...at])).code).toBe(EXIT.usage);
    expect((await tavi(["plugins", "disable", "acme.weather", ...at])).code).toBe(EXIT.ok);
    expect((await tavi(["plugins", "remove", "acme.weather", ...at])).stdout).toContain("removed acme.weather 1.0.0");
    expect((await tavi(["plugins", "show", "acme.weather", ...at])).code).toBe(EXIT.unavailable);
  });

  it("shows each version's isolation, network domains and raw secrets, and approves a pre-worker version again as a worker", async () => {
    const dataDirectory = directories.create(),
      at = ["--data-dir", dataDirectory];
    const source = pluginDirectory(WEATHER, {
      config: { city: { type: "string", required: true }, key: { type: "credential" } },
      network: { domains: ["api.weather.test"] },
      rawSecrets: ["key"],
    });
    expect((await tavi(["plugins", "install", source, ...at])).code).toBe(EXIT.ok);
    // Approved as before workers: the registry records no isolation.
    const runtime = await compose(dataDirectory);
    await runtime.plugins.registry.decide("acme.weather", "1.0.0", "approved", "operator");
    runtimes.splice(runtimes.indexOf(runtime), 1);
    await runtime.close();
    const before = await tavi(["plugins", "show", "acme.weather", ...at]);
    expect(before.code, before.stderr).toBe(EXIT.ok);
    expect(before.stdout).toContain("    runs UNSANDBOXED in the owner's process (approved before workers; approve it again to choose)\n");
    expect(before.stdout).toContain("    network domains: api.weather.test\n");
    expect(before.stdout).toContain("    raw secrets (a worker holds their real values): key\n");
    const approved = await tavi(["plugins", "approve", "acme.weather", "1.0.0", ...at]);
    expect(approved.code, approved.stderr).toBe(EXIT.ok);
    expect(approved.stdout).toContain("acme.weather@1.0.0 approved, runs as a confined worker");
    expect((await tavi(["plugins", "show", "acme.weather", ...at])).stdout).toContain("    runs as a confined worker\n");
  });

  it("disables and re-enables the built-in Jev router like any optional plugin", async () => {
    const dataDirectory = directories.create(),
      at = ["--data-dir", dataDirectory];
    const disabled = await tavi(["plugins", "disable", "tavi.router", ...at]);
    expect(disabled.code).toBe(EXIT.ok);
    expect(disabled.stdout).toContain("tavi.router disabled");
    expect(disabled.stderr).toContain("restart `tavi serve`");
    const listed = JSON.parse((await tavi(["plugins", "list", "--format", "json", ...at])).stdout) as { plugins: PluginView[] };
    expect(listed.plugins.find((plugin) => plugin.id === "tavi.router")).toMatchObject({ kind: "builtin", core: false, enabled: false });
    expect((await tavi(["plugins", "enable", "tavi.router", ...at])).code).toBe(EXIT.ok);
  });

  it("rejects bad arguments before touching the data directory", async () => {
    expect((await tavi(["plugins"])).code).toBe(EXIT.usage);
    expect((await tavi(["plugins", "approve", "acme.weather"])).code).toBe(EXIT.usage);
    expect((await tavi(["plugins", "config", "acme.weather"])).code).toBe(EXIT.usage);
    expect((await tavi(["plugins", "config", "acme.weather", "--set", "novalue"])).code).toBe(EXIT.usage);
    expect((await tavi(["plugins", "list", "--version", "1.0.0"])).code).toBe(EXIT.usage);
  });
});

describe("composition runs approved plugins and nothing else", () => {
  it("registers an enabled plugin's declared tool with its manifest effect, runs it with its settings, and starts and stops it", async () => {
    const dataDirectory = directories.create();
    await installWeather(dataDirectory);
    const globals = globalThis as { __taviWeatherStarts?: number; __taviWeatherStopped?: boolean };
    const before = globals.__taviWeatherStarts ?? 0;
    const runtime = await compose(dataDirectory);
    expect(runtime.plugins.status("acme.weather")).toEqual({ phase: "ready" });
    expect(globals.__taviWeatherStarts).toBe(before + 1);
    const tool = runtime.tools.get("acme.weather.forecast");
    expect(tool).toMatchObject({
      effect: "external",
      version: "1.0.0",
      description: "Get a forecast for a day",
      requiredPermissions: ["tools.invoke"],
    });
    const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "run-1", caller: "test" };
    await expect(tool!.handler({ input: { day: 2 }, context, signal: new AbortController().signal })).resolves.toEqual({
      city: "Sofia",
      days: 3,
      day: 2,
    });
    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    expect(globals.__taviWeatherStopped).toBe(true);
  });

  it("isolates a plugin that throws while registering, and one that declares no such tool: the owner still starts", async () => {
    for (const code of [
      "export function register() { throw new Error('broken on purpose'); }",
      "export function register({ registerTool, z }) { registerTool({ name: 'undeclared', inputSchema: z.object({}), handler: async () => 1 }); }",
    ]) {
      const dataDirectory = directories.create();
      await installWeather(dataDirectory, pluginDirectory(code));
      const runtime = await compose(dataDirectory);
      expect(runtime.host.admissionOpen).toBe(true);
      const status = runtime.plugins.status("acme.weather");
      expect(status.phase).toBe("failed");
      expect(status.error).toMatch(/broken on purpose|not declared in the approved manifest/);
      expect(runtime.tools.get("acme.weather.forecast")).toBeUndefined();
      expect(runtime.tools.get("acme.weather.undeclared")).toBeUndefined();
    }
  });

  it("leaves out a built-in the operator disabled, and keeps an unapproved plugin out", async () => {
    const dataDirectory = directories.create(),
      at = ["--data-dir", dataDirectory];
    expect((await tavi(["plugins", "disable", "tavi.reminderrule", ...at])).code).toBe(EXIT.ok);
    expect((await tavi(["plugins", "install", pluginDirectory(), ...at])).code).toBe(EXIT.ok);
    const runtime = await compose(dataDirectory);
    const composed = runtime.host.status().map((status) => status.id);
    expect(composed).not.toContain("tavi.reminderrule");
    expect(composed).toContain("tavi.persistence");
    expect(runtime.plugins.status("acme.weather").phase).toBe("not_composed");
    expect(runtime.tools.get("acme.weather.forecast")).toBeUndefined();
  });

  it("offers a tool that needs another plugin's tools only while they are registered (requiresTools)", async () => {
    const code = `export default { register({ registerTool, z }) {
      for (const name of ["forecast", "plan"]) registerTool({ name, inputSchema: z.object({}), handler: async () => name });
    } };`;
    const source = pluginDirectory(code, {
      tools: [
        { name: "forecast", effect: "read-only", description: "Get a forecast", requiresTools: ["nobody.missing"] },
        { name: "plan", effect: "read-only", description: "Plan a form the browser observed", requiresTools: ["browser.observe"] },
      ],
    });
    const offeredIds = async (runtime: TaviRuntime) =>
      (await runtime.tools.listOffered({ workspaceId: "default", principalId: "operator" } as never)).map((tool) => tool.id);
    const withBrowser = directories.create();
    await installWeather(withBrowser, source);
    const runtime = await compose(withBrowser);
    expect(await offeredIds(runtime)).toContain("acme.weather.plan");
    expect(await offeredIds(runtime)).not.toContain("acme.weather.forecast");
    await expect(
      runtime.tools
        .get("acme.weather.forecast")
        ?.handler({ input: {}, context: { workspaceId: "default", principalId: "operator", runId: "t", caller: "test" } } as never),
    ).rejects.toMatchObject({ code: "UNAVAILABLE", message: expect.stringContaining("nobody.missing") });
    // The browser disabled, the tool that reads its observations is not offered either.
    const withoutBrowser = directories.create();
    expect((await tavi(["plugins", "disable", "tavi.browser", "--data-dir", withoutBrowser])).code).toBe(EXIT.ok);
    await installWeather(withoutBrowser, source);
    expect(await offeredIds(await compose(withoutBrowser))).not.toContain("acme.weather.plan");
  });

  it("the built-in catalog names exactly what composition can compose, and core means providing a service", async () => {
    const runtime = await compose(directories.create());
    const composed = new Set(runtime.host.status().map((status) => status.id));
    const catalog = new Set(BUILTIN_PLUGINS.map((plugin) => plugin.id));
    // Everything composed with a model connection is in the catalog; the catalog adds serve-only retention and
    // the serve-only heartbeat and memory hosts, the reminder scheduler and the task summarizer, and the guard, whose hooks join the turn rather than the host, and only once it is enabled.
    for (const id of composed) expect(catalog.has(id), id).toBe(true);
    for (const id of catalog)
      if (!composed.has(id))
        expect([
          "tavi.retention",
          "tavi.ideas",
          "tavi.heartbeat",
          "tavi.heartbeatagent",
          "tavi.heartbeatsignals",
          "tavi.memory",
          "tavi.browserview",
          "tavi.guard",
          // Desktop control, off until enabled.
          "tavi.desktop",
          // The reminder scheduler and the task summarizer run only in an owner that runs its schedulers.
          "tavi.reminders",
          "tavi.tasksummaries",
        ]).toContain(id);
    // A UI-only built-in composes nothing: it is the canvas's to frame, and says so.
    for (const plugin of BUILTIN_PLUGINS) expect(composed.has(plugin.id) && plugin.uiOnly === true, plugin.id).toBe(false);
    expect(BUILTIN_PLUGINS.find((plugin) => plugin.id === "tavi.browserview")).toMatchObject({
      core: false,
      uiOnly: true,
      ui: { contributions: [{ id: "live", role: "browser-view", channels: ["browser.live"] }] },
    });
  });
});

describe("failure leaves nothing a model can call", () => {
  it("configures provider instances as structured JSON without loading code", async () => {
    const dataDirectory = directories.create();
    const source = pluginDirectory('throw new Error("must not execute offline");', {
      capabilities: [
        {
          id: "lookup",
          kind: "search",
          settings: { endpoint: { type: "string", required: true, description: "Endpoint" } },
          credentials: ["apiKey"],
          disclosure: "Search terms",
        },
      ],
    });
    expect((await tavi(["plugins", "install", source, "--data-dir", dataDirectory])).code).toBe(EXIT.ok);
    const instances = [
      {
        id: "work",
        factory: "lookup",
        workspaceId: "default",
        accountId: "work",
        settings: { endpoint: "https://api.example" },
        credentials: { apiKey: "plugins.acme.weather.work.key" },
      },
    ];
    expect(
      (await tavi(["plugins", "config", "acme.weather", "--instances", JSON.stringify(instances), "--data-dir", dataDirectory])).code,
    ).toBe(EXIT.ok);
    const shown = await tavi(["plugins", "show", "acme.weather", "--format", "json", "--data-dir", dataDirectory]);
    expect(JSON.parse(shown.stdout).instances).toEqual(instances);
    const badJson = await tavi(["plugins", "config", "acme.weather", "--instances", "bad-json", "--data-dir", dataDirectory]);
    expect(badJson).toMatchObject({ code: EXIT.usage, stderr: expect.stringContaining("--instances must be a JSON array") });
    const duplicate = await tavi([
      "plugins",
      "config",
      "acme.weather",
      "--instances",
      JSON.stringify([...instances, ...instances]),
      "--data-dir",
      dataDirectory,
    ]);
    expect(duplicate).toMatchObject({ code: EXIT.usage, stderr: expect.stringContaining("duplicate instance IDs") });
    expect(duplicate.stderr).not.toContain("JSON array");
  });

  it.each(["register", "start"])("cleans registration resources and stops once after %s fails", async (hook) => {
    const dataDirectory = directories.create();
    const marker = join(dataDirectory, "cleanup.txt");
    await installWeather(
      dataDirectory,
      pluginDirectory(`
      import { appendFileSync } from "node:fs";
      export default {
        register({ scope, registerTool, z }) {
          scope.defer(() => appendFileSync(${JSON.stringify(marker)}, "cleanup\\n"));
          registerTool({ name: "forecast", inputSchema: z.object({}), handler: () => "ran" });
          ${hook === "register" ? 'throw new Error("registration failed");' : ""}
        },
        start() { ${hook === "start" ? 'throw new Error("startup failed");' : ""} },
        stop() { appendFileSync(${JSON.stringify(marker)}, "stop\\n"); },
      };`),
    );
    const runtime = await compose(dataDirectory);
    expect(runtime.plugins.status("acme.weather").phase).toBe("failed");
    expect(runtime.tools.get("acme.weather.forecast")).toBeUndefined();
    expect(readFileSync(marker, "utf8")).toBe("cleanup\nstop\n");
    await runtime.close();
    expect(readFileSync(marker, "utf8")).toBe("cleanup\nstop\n");
  });

  it("a plugin whose start fails keeps its tools out of every offer and refuses calls", async () => {
    const dataDirectory = directories.create();
    await installWeather(
      dataDirectory,
      pluginDirectory(`
      export default {
        register({ registerTool, z }) { registerTool({ name: "forecast", inputSchema: z.object({}), handler: async () => "ran" }); },
        start() { throw new Error("no connection"); },
      };`),
    );
    const runtime = await compose(dataDirectory);
    expect(runtime.plugins.status("acme.weather")).toEqual({ phase: "failed", error: "no connection" });
    expect((await runtime.tools.listOffered({ workspaceId: "default" })).some((tool) => tool.id === "acme.weather.forecast")).toBe(false);
    expect(runtime.tools.get("acme.weather.forecast")).toBeUndefined();
  });

  it("checks every tool before registering any: a collision with a built-in's model name registers none", async () => {
    const dataDirectory = directories.create();
    const source = pluginDirectory(
      "export function register({ registerTool, z }) { for (const name of ['alpha', 'to']) registerTool({ name, inputSchema: z.object({}), handler: async () => name }); }",
      {
        id: "messaging.send",
        tools: [
          { name: "alpha", effect: "read-only", description: "a" },
          { name: "to", effect: "external", description: "b" },
        ],
      },
    );
    const at = ["--data-dir", dataDirectory];
    for (const argv of [
      ["plugins", "install", source],
      ["plugins", "approve", "messaging.send", "1.0.0", "--in-process"],
      ["plugins", "config", "messaging.send", "--set", "city=Sofia"],
      ["plugins", "enable", "messaging.send"],
    ]) {
      const result = await tavi([...argv, ...at]);
      expect(result.code, `${argv.join(" ")}: ${result.stderr}`).toBe(EXIT.ok);
    }
    const runtime = await compose(dataDirectory);
    expect(runtime.plugins.status("messaging.send").error).toMatch(/collides/);
    expect(runtime.tools.get("messaging.send.alpha")).toBeUndefined();
    expect(runtime.tools.get("messaging.send.to")).toBeUndefined();
  });
});

describe("secrets and diagnostics", () => {
  it("gives a plugin its own credential through secret(), resolved from the credentials store, and nothing else", async () => {
    const dataDirectory = directories.create(),
      at = ["--data-dir", dataDirectory];
    const source = pluginDirectory(
      `
      export default {
        register({ registerTool, z, secret }) {
          registerTool({ name: "forecast", inputSchema: z.object({ key: z.string() }), handler: async ({ key }) => secret(key) });
        },
      };`,
      { config: { apiKey: { type: "credential", required: true }, city: { type: "string" }, spareKey: { type: "credential" } } },
    );
    const valueFile = join(directories.create(), "value");
    writeFileSync(valueFile, "weather-secret-123", { mode: 0o600 });
    for (const argv of [
      ["credentials", "set", "plugins.acme.weather.key", "--file", valueFile],
      ["plugins", "install", source],
      ["plugins", "approve", "acme.weather", "1.0.0", "--in-process"],
      ["plugins", "config", "acme.weather", "--set", "apiKey=plugins.acme.weather.key", "--set", "city=Sofia"],
      ["plugins", "enable", "acme.weather"],
    ]) {
      const result = await tavi([...argv, ...at]);
      expect(result.code, `${argv.join(" ")}: ${result.stderr}`).toBe(EXIT.ok);
    }
    // The setting shows the reference, never the value.
    expect((await tavi(["plugins", "show", "acme.weather", ...at])).stdout).not.toContain("weather-secret-123");
    const runtime = await compose(dataDirectory);
    const tool = runtime.tools.get("acme.weather.forecast")!;
    const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "run-1", caller: "test" };
    const call = (key: string) => tool.handler({ input: { key }, context, signal: new AbortController().signal });
    await expect(call("apiKey")).resolves.toBe("weather-secret-123");
    await expect(call("city")).rejects.toThrow(/not a credential setting/);
    // A declared credential nobody set is absent, not refused: a plugin with an optional key still starts and runs.
    await expect(call("spareKey")).resolves.toBeNull();
  });

  it("doctor verifies enabled plugins without importing them, and reports one that would not load", async () => {
    const dataDirectory = directories.create(),
      marker = join(directories.create(), "imported");
    await installWeather(
      dataDirectory,
      pluginDirectory(`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n${WEATHER}`),
    );
    const report = async () => {
      const result = await tavi(["doctor", "--data-dir", dataDirectory]);
      return JSON.parse(result.stdout) as { pluginRegistry: { id: string; phase?: string; error?: string }[] };
    };
    expect((await report()).pluginRegistry.find((plugin) => plugin.id === "acme.weather")).toMatchObject({ phase: "verified" });
    expect(existsSync(marker)).toBe(false);
    writeFileSync(join(dataDirectory, "plugins", "acme.weather", "1.0.0", "index.mjs"), "export function register() {}\n");
    const tampered = (await report()).pluginRegistry.find((plugin) => plugin.id === "acme.weather");
    expect(tampered).toMatchObject({ phase: "failed" });
    expect(tampered?.error).toMatch(/approved hash/);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("backup and restore carry installed plugins", () => {
  it("restores an enabled plugin's snapshot so it still loads, hash intact", async () => {
    const dataDirectory = directories.create(),
      out = join(directories.create(), "snapshot"),
      restored = directories.create();
    await installWeather(dataDirectory);
    expect((await tavi(["backup", "--out", out, "--data-dir", dataDirectory])).code).toBe(EXIT.ok);
    const back = await tavi(["restore", "--from", out, "--data-dir", restored]);
    expect(back.code, back.stderr).toBe(EXIT.ok);
    const runtime = await compose(restored);
    expect(runtime.plugins.status("acme.weather")).toEqual({ phase: "ready" });
    expect(runtime.tools.get("acme.weather.forecast")).toBeDefined();
  });

  it("replaces a live plugins directory rather than overlaying it, keeping the old one aside", async () => {
    const dataDirectory = directories.create(),
      out = join(directories.create(), "snapshot");
    await installWeather(dataDirectory);
    expect((await tavi(["backup", "--out", out, "--data-dir", dataDirectory])).code).toBe(EXIT.ok);
    // A file the snapshot does not have: overlaid, it would change the hash and the plugin would be refused.
    writeFileSync(join(dataDirectory, "plugins", "acme.weather", "1.0.0", "extra.mjs"), "export {};\n");
    expect((await tavi(["restore", "--from", out, "--data-dir", dataDirectory])).code).toBe(EXIT.ok);
    const runtime = await compose(dataDirectory);
    expect(runtime.plugins.status("acme.weather")).toEqual({ phase: "ready" });
    expect(readdirSync(dataDirectory).some((name) => name.startsWith("plugins.pre-restore-"))).toBe(true);
  });
});

const owners = useAttachedOwners("tavi-plugins-");

describe("tavi plugins under a live owner", ATTACHED, () => {
  it("answers with each plugin's phase, installs over IPC and notes when a change waits for a restart", async () => {
    const directory = owners.tempDirectory();
    await installWeather(directory);
    await owners.startOwner(turns([]), { directory });
    const at = ["--data-dir", directory];

    const listed = await tavi(["plugins", "list", "--format", "json", ...at]);
    expect(listed.code, listed.stderr).toBe(EXIT.ok);
    const plugins = (JSON.parse(listed.stdout) as { plugins: PluginView[] }).plugins;
    expect(plugins.find((plugin) => plugin.id === "acme.weather")).toMatchObject({ enabled: true, phase: "ready" });
    expect(plugins.find((plugin) => plugin.id === "tavi.persistence")).toMatchObject({ core: true, phase: "ready" });

    const second = pluginDirectory(WEATHER, { version: "1.1.0" });
    const installed = await tavi(["plugins", "install", second, ...at]);
    expect(installed.code, installed.stderr).toBe(EXIT.ok);
    expect(installed.stdout).toContain("installed acme.weather@1.1.0 (proposed)");

    const disabled = await tavi(["plugins", "disable", "acme.weather", ...at]);
    expect(disabled.code, disabled.stderr).toBe(EXIT.ok);
    expect(disabled.stderr).toContain("restart `tavi serve`");
    const core = await tavi(["plugins", "disable", "tavi.persistence", ...at]);
    expect(core.code).toBe(EXIT.usage);
  });
});

describe("UI built-ins' content hash", () => {
  it("hashes the files the canvas build ships for each UI built-in, and offers none without them", async () => {
    const { builtinPluginsWithUi } = await import("../../src/features/plugins/catalog.js");
    const { hashPluginDirectory } = await import("@tavi/runtime");
    const canvas = directories.create();
    const shipped = join(canvas, "plugins", "tavi.browserview");
    mkdirSync(shipped, { recursive: true });
    writeFileSync(join(shipped, "live.html"), "<!doctype html>");
    const hashed = builtinPluginsWithUi(canvas).find((plugin) => plugin.id === "tavi.browserview");
    expect(hashed?.uiContentHash).toBe(hashPluginDirectory(shipped).hash);
    expect(builtinPluginsWithUi(undefined).find((plugin) => plugin.id === "tavi.browserview")?.uiContentHash).toBeUndefined();
    expect(builtinPluginsWithUi(directories.create()).find((plugin) => plugin.id === "tavi.browserview")?.uiContentHash).toBeUndefined();
    expect(builtinPluginsWithUi(canvas).find((plugin) => plugin.id === "tavi.persistence")?.uiContentHash).toBeUndefined();
  });
});

describe("tavi plugins ui", () => {
  /** Install, approve and enable a UI-only plugin that can fill browser-view. */
  async function acmeView(dataDirectory: string, channels: readonly string[] = ["browser.live"]): Promise<void> {
    const source = directories.create();
    writeFileSync(
      join(source, "tavi-plugin.json"),
      JSON.stringify({
        schemaVersion: 2,
        abi: "tavi.providers/1",
        provenance: { format: "bundled-esm", packages: [] },
        id: "acme.view",
        version: "1.0.0",
        name: "Acme view",
        ui: {
          abi: "tavi.ui/1",
          contributions: [
            {
              id: "live",
              role: "browser-view",
              title: "Browser",
              document: "live.html",
              channels: [...channels],
              placements: [{ slot: "chat.panel.top", height: { min: 100, default: 200, max: 300 } }],
              disclosure: "Sees every page the agent opens.",
            },
          ],
        },
      }),
    );
    writeFileSync(join(source, "live.html"), "<!doctype html>");
    for (const argv of [
      ["plugins", "install", source],
      ["plugins", "approve", "acme.view", "1.0.0"],
      ["plugins", "enable", "acme.view"],
    ]) {
      expect((await tavi([...argv, "--data-dir", dataDirectory])).code).toBe(EXIT.ok);
    }
  }

  it("says what browser.control asks for, and that Tavi's own takeover surface is used instead, before a plugin may watch the browser", async () => {
    const dataDirectory = directories.create(),
      at = ["--data-dir", dataDirectory];
    await acmeView(dataDirectory, ["browser.live", "browser.control"]);
    const unconfirmed = await tavi(["plugins", "ui", "set-role", "browser-view", "acme.view", ...at]);
    expect(unconfirmed.code).toBe(EXIT.usage);
    expect(unconfirmed.stderr).toContain(
      "acme.view receives browser.live, browser.control: Sees every page the agent opens. It also asks to see and type into pages you take over, sign-in pages included; Tavi draws its own takeover surface, so it is not given them.",
    );
  });

  it("chooses a plugin for a role only once its disclosure was confirmed, and falls back to the built-in once it cannot fill it", async () => {
    const dataDirectory = directories.create(),
      at = ["--data-dir", dataDirectory];
    await acmeView(dataDirectory);
    const listed = await tavi(["plugins", "ui", "list", ...at]);
    expect(listed.code, listed.stderr).toBe(EXIT.ok);
    expect(listed.stdout).toContain("role browser-view: tavi.browserview (built-in)");
    expect(listed.stdout).toContain("acme.view/live\tnot shown\tchat.panel.top\tbrowser.live");

    const unconfirmed = await tavi(["plugins", "ui", "set-role", "browser-view", "acme.view", ...at]);
    expect(unconfirmed.code).toBe(EXIT.usage);
    expect(unconfirmed.stderr).toContain("acme.view receives browser.live: Sees every page the agent opens.");
    expect(unconfirmed.stderr).toContain("--yes");
    const confirmed = await tavi(["plugins", "ui", "set-role", "browser-view", "acme.view", "--yes", ...at]);
    expect(confirmed.code, confirmed.stderr).toBe(EXIT.ok);
    expect(confirmed.stdout).toContain("browser-view is now acme.view");
    expect(confirmed.stdout).toContain("acme.view/live\tshown");

    expect((await tavi(["plugins", "ui", "set-role", "browser-view", "acme.missing", "--yes", ...at])).code).toBe(EXIT.usage);
    expect((await tavi(["plugins", "disable", "acme.view", ...at])).code).toBe(EXIT.ok);
    const fallen = await tavi(["plugins", "ui", "list", ...at]);
    expect(fallen.stdout).toContain("warning: acme.view cannot fill browser-view");
    // doctor says so too.
    const doctor = await tavi(["doctor", ...at]);
    expect(JSON.parse(doctor.stdout).uiRoleFallbacks).toEqual([
      {
        workspaceId: "default",
        role: "browser-view",
        wanted: "acme.view",
        using: "tavi.browserview",
        warning: expect.stringContaining("tavi.browserview is used meanwhile"),
      },
    ]);
    expect((await tavi(["plugins", "ui", "set-role", "browser-view", "off", ...at])).stdout).toContain("browser-view is now off");
    expect((await tavi(["plugins", "ui", "set-role", "browser-view", "builtin", ...at])).stdout).toContain(
      "browser-view is now tavi.browserview (built-in)",
    );
  });

  it("places a contribution in other slots, hides it, and puts it back, refusing a slot that does not exist", async () => {
    const dataDirectory = directories.create(),
      at = ["--data-dir", dataDirectory];
    await acmeView(dataDirectory);
    const moved = await tavi([
      "plugins",
      "ui",
      "place",
      "acme.view/live",
      "chat.panel.tab,chat.panel.top",
      "--show",
      "always",
      "--format",
      "json",
      ...at,
    ]);
    expect(moved.code, moved.stderr).toBe(EXIT.ok);
    expect(JSON.parse(moved.stdout).placements).toEqual({
      "acme.view/live": {
        slots: [{ slot: "chat.panel.tab" }, { slot: "chat.panel.top", height: { min: 100, default: 200, max: 300 }, show: "always" }],
      },
    });
    expect((await tavi(["plugins", "ui", "place", "acme.view/live", "hidden", ...at])).stdout).toContain(
      "acme.view/live\tnot shown\tchat.panel.top (hidden)",
    );
    expect(
      JSON.parse((await tavi(["plugins", "ui", "place", "acme.view/live", "default", "--format", "json", ...at])).stdout).placements,
    ).toEqual({});
    expect((await tavi(["plugins", "ui", "place", "acme.view/live", "sidebar", ...at])).code).toBe(EXIT.usage);
    expect((await tavi(["plugins", "ui", "place", "acme.view/nothing", "hidden", ...at])).code).toBe(EXIT.usage);
    expect((await tavi(["plugins", "ui", "frobnicate", ...at])).code).toBe(EXIT.usage);
  });
});

describe("the builtin channels", () => {
  it("ask the owner for a file part's bytes within the channel's own cap, from the sending workspace", async () => {
    const { BUILTIN_CHANNELS } = await import("../../src/features/plugins/catalog.js");
    const { TELEGRAM_MAX_ATTACHMENT_BYTES } = await import("@tavi/plugin-telegram/connector");
    const asked: { artifactId: string; workspaceId: string; maxBytes: number }[] = [];
    const fakeFetch = scriptedFetch(async (url, init) => {
      if (url.endsWith("/getMe")) return new Response(JSON.stringify({ ok: true, result: { id: 1 } }));
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const host = {
      now: () => "2026-10-09T00:00:00.000Z",
      fetch: fakeFetch,
      readArtifact: async (artifactId: string, workspaceId: string, maxBytes: number) => {
        asked.push({ artifactId, workspaceId, maxBytes });
        return undefined;
      },
    };
    expect(BUILTIN_CHANNELS.map((channel) => channel.connector(host).providerId)).toEqual(
      BUILTIN_CHANNELS.map((channel) => channel.descriptor.providerId),
    );
    const telegram = BUILTIN_CHANNELS.find((channel) => channel.descriptor.providerId === "telegram");
    const instance = telegram?.connector(host).createConnection({
      connection: {
        connectionId: "c",
        providerId: "telegram",
        accountIdentity: "a",
        workspaceId: "w",
        configRevision: 1,
        enabled: true,
        credentialRef: "r",
      },
      config: {},
      credentials: { get: async () => "token", accessToken: async () => "" },
    });
    await instance?.start();
    try {
      const outcome = await instance?.send({
        effectId: "e",
        connectionId: "c",
        workspaceId: "w2",
        destination: { chatId: "7" },
        parts: [{ kind: "file", artifactId: "art-1" }],
      });
      // Nothing the owner would release: refused, never sent.
      expect(outcome?.parts[0]?.status).toBe("rejected");
      expect(asked).toEqual([{ artifactId: "art-1", workspaceId: "w2", maxBytes: TELEGRAM_MAX_ATTACHMENT_BYTES }]);
    } finally {
      await instance?.stop();
    }
  });
});
