import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { InvocationContext } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { EXIT, main } from "../../src/main.js";
import { validatePlugin } from "../../src/features/plugins/validate.js";
import { capture } from "../support/attached-owner.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";
import { directSandbox as direct } from "../support/direct-sandbox.js";

/** The guide's example plugins (docs/MODS.md B.2 and B.3), as the examples folder ships them: validated, installed and called. */

const EXAMPLES = join(import.meta.dirname, "..", "..", "..", "..", "examples", "plugins");
const dirs = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  dirs.cleanup();
});
const temp = () => {
  const path = dirs.create("tavi-example-plugins-");
  return path;
};
const context: InvocationContext = { workspaceId: "default", principalId: "operator", runId: "run-1", caller: "test" };

async function tavi(argv: readonly string[]) {
  const out = capture();
  const code = await main([...argv], { io: out.io });
  return { code, stdout: out.stdout(), stderr: out.stderr() };
}

async function compose(dataDirectory: string): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(fixtureRuntimeOptions(dataDirectory, { scheduleSweepEnabled: false }), {
    requireModelTransport: false,
  });
  runtimes.push(runtime);
  return runtime;
}

/** Install, approve, configure and enable an example, then open the owner that runs it. */
async function running(
  example: string,
  id: string,
  version: string,
  dataDir = temp(),
  set: Record<string, string> = {},
): Promise<TaviRuntime> {
  const source = temp();
  cpSync(join(EXAMPLES, example), source, { recursive: true });
  const setup = await compose(dataDir);
  await setup.plugins.registry.install(source, "operator");
  await setup.plugins.registry.decide(id, version, "approved", "operator");
  if (Object.keys(set).length > 0) await setup.plugins.registry.configure(id, set, [], "operator");
  await setup.plugins.registry.enable(id, "operator");
  runtimes.splice(runtimes.indexOf(setup), 1);
  await setup.close();
  return compose(dataDir);
}

const call = (runtime: TaviRuntime, tool: string, input: unknown) =>
  runtime.tools.get(tool)!.handler({ input, context, signal: new AbortController().signal });

describe("Example 1: acme-units", () => {
  it("validates with no problems", async () => {
    const report = await validatePlugin(join(EXAMPLES, "acme-units"), { sandbox: direct, platform: "darwin" });
    expect(report).toMatchObject({ pluginId: "acme.units", version: "0.1.0", problems: [] });
  });

  it("converts km to miles, °C to °F, and refuses a pair it cannot convert", async () => {
    const runtime = await running("acme-units", "acme.units", "0.1.0");
    expect(runtime.plugins.status("acme.units").phase).toBe("ready");
    expect(runtime.tools.get("acme.units.convert")?.effect).toBe("read-only");
    // A loaded plugin's read-only tool is one a person may add to the heartbeat's checks; no built-in tool is.
    expect(runtime.heartbeat.toolChoices()).toEqual([
      { id: "acme.units.convert", description: "Convert a value between km/mi, kg/lb or C/F" },
    ]);
    expect(((await call(runtime, "acme.units.convert", { value: 42, from: "km", to: "mi" })) as { value: number }).value).toBeCloseTo(
      26.0976,
      3,
    );
    expect(await call(runtime, "acme.units.convert", { value: 100, from: "C", to: "F" })).toEqual({ value: 212 });
    expect(await call(runtime, "acme.units.convert", { value: 5, from: "kg", to: "kg" })).toEqual({ value: 5 });
    await expect(call(runtime, "acme.units.convert", { value: 1, from: "km", to: "kg" })).rejects.toThrow(/cannot convert km to kg/);
  });
});

describe("Example 2: acme-fx", () => {
  it("validates with no problems", async () => {
    const report = await validatePlugin(join(EXAMPLES, "acme-fx"), { sandbox: direct, platform: "darwin" });
    expect(report).toMatchObject({ pluginId: "acme.fx", version: "0.1.0", problems: [] });
  });

  it("sends its stored key as a bearer token and returns the rate, never the key", async () => {
    const dataDir = temp();
    const keyFile = join(temp(), "fx.key");
    writeFileSync(keyFile, "fx-secret-123", { mode: 0o600 });
    const stored = await tavi(["credentials", "set", "plugins.acme.fx.apiKey", "--file", keyFile, "--data-dir", dataDir]);
    expect(stored.code, stored.stderr).toBe(EXIT.ok);
    const runtime = await running("acme-fx", "acme.fx", "0.1.0", dataDir, { apiKey: "plugins.acme.fx.apiKey" });
    expect(runtime.plugins.status("acme.fx").phase).toBe("ready");
    expect(runtime.tools.get("acme.fx.rate")?.effect).toBe("external");

    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ base: "EUR", rates: { USD: 1.08 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await call(runtime, "acme.fx.rate", { base: "EUR", quote: "USD" });
    expect(result).toEqual({ base: "EUR", quote: "USD", rate: 1.08 });
    expect(JSON.stringify(result)).not.toContain("fx-secret-123");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example-fx.com/latest?base=EUR&symbols=USD");
    expect(init.headers).toEqual({ Authorization: "Bearer fx-secret-123" });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    fetch.mockResolvedValueOnce(new Response("no", { status: 401 }));
    await expect(call(runtime, "acme.fx.rate", { base: "EUR", quote: "USD" })).rejects.toThrow(/example-fx answered 401/);
  });
});
