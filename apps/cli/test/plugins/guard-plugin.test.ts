import { afterEach, describe, expect, it } from "vitest";

import { NO_TURN_HOOKS, type ModEnvelope, type ModHookInput } from "@tavi/contracts";
import { GUARD_PLUGIN_ID } from "@tavi/plugin-guard/manifest";
import { temporaryDirectories } from "@tavi/test-support";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { main } from "../../src/main.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/** The built-in `tavi.guard` as the owner composes it; its hook's own cases are `@tavi/plugin-guard`'s. */

const envelope: ModEnvelope = { workspaceId: "default", principalId: "operator", taskId: "t", runId: "t", source: "cli", attended: true };
const check = (input: unknown, over: Partial<ModEnvelope> = {}): ModHookInput<"tool.check"> => ({
  envelope: { ...envelope, ...over },
  tool: "sandbox.run",
  callId: "c",
  input,
  verdict: { decision: "ask", reasons: [] },
});

const dirs = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  dirs.cleanup();
});

async function compose(dataDirectory: string): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(fixtureRuntimeOptions(dataDirectory, { scheduleSweepEnabled: false }), {
    requireModelTransport: false,
  });
  runtimes.push(runtime);
  return runtime;
}

describe("tavi.guard as a built-in", () => {
  it("is off until enabled, and then hooks sandbox.run with its declared disclosure", async () => {
    const dataDir = dirs.create("tavi-guard-");
    const first = await compose(dataDir);
    const off = await first.plugins.registry.show(GUARD_PLUGIN_ID, first.plugins);
    expect(off.enabled).toBe(false);
    expect(off.mods?.[0]).toMatchObject({ event: "tool.check", match: { tools: ["sandbox.run"] }, onFailure: "ask" });
    expect(first.turnHooks.has("tool.check", envelope, "sandbox.run")).toBe(false);
    await first.plugins.registry.enable(GUARD_PLUGIN_ID, "operator");
    runtimes.splice(runtimes.indexOf(first), 1);
    await first.close();
    const second = await compose(dataDir);
    expect((await second.plugins.registry.show(GUARD_PLUGIN_ID, second.plugins)).enabled).toBe(true);
    const outcome = await second.turnHooks.dispatch("tool.check", check({ command: "rm -rf build" }), async () => ({
      decision: "ask" as const,
    }));
    expect(outcome.decidedBy).toBe(GUARD_PLUGIN_ID);
    expect(NO_TURN_HOOKS.has("tool.check", envelope)).toBe(false);
    // What its hook takes, from the running owner.
    expect((await second.plugins.registry.show(GUARD_PLUGIN_ID, second.plugins)).hookLatency).toMatchObject([
      { event: "tool.check", samples: 1 },
    ]);
    runtimes.splice(runtimes.indexOf(second), 1);
    await second.close();
    // `tavi plugins show` prints a built-in's hooks and their activity, as an external plugin's.
    let out = "";
    await main(["plugins", "show", GUARD_PLUGIN_ID, "--data-dir", dataDir], {
      io: {
        stdout: (text) => void (out += text),
        stderr: () => {},
        isTty: false,
      },
    });
    expect(out).toContain("hooks:");
    expect(out).toContain("tool.check");
    expect(out).toMatch(/hook activity: 1 decision, /);
  });

  it("leaves the turn at once when it is disabled, without a restart", async () => {
    const dataDir = dirs.create("tavi-guard-live-");
    const first = await compose(dataDir);
    await first.plugins.registry.enable(GUARD_PLUGIN_ID, "operator");
    runtimes.splice(runtimes.indexOf(first), 1);
    await first.close();
    const second = await compose(dataDir);
    expect(second.turnHooks.has("tool.check", envelope, "sandbox.run")).toBe(true);
    await second.plugins.registry.disable(GUARD_PLUGIN_ID, "operator");
    expect(second.turnHooks.has("tool.check", envelope, "sandbox.run")).toBe(false);
  });
});
