import { cpSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ModEnvelope, ModHookInput } from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/** The guide's example mods (docs/MODS.md Part B), as the examples folder ships them: installed and driven. */

const EXAMPLES = join(import.meta.dirname, "..", "..", "..", "..", "examples", "mods");
const dirs = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  dirs.cleanup();
});
const temp = () => {
  const path = dirs.create("tavi-example-mods-");
  return path;
};
const envelope: ModEnvelope = { workspaceId: "default", principalId: "operator", taskId: "t", runId: "t", source: "cli", attended: true };

async function compose(dataDirectory: string): Promise<TaviRuntime> {
  const runtime = await composeTaviRuntime(fixtureRuntimeOptions(dataDirectory, { scheduleSweepEnabled: false }), {
    requireModelTransport: false,
  });
  runtimes.push(runtime);
  return runtime;
}

/** Install, approve and enable an example, then open the owner that runs it. */
async function running(example: string, id: string, version: string): Promise<TaviRuntime> {
  const dataDir = temp();
  const source = temp();
  cpSync(join(EXAMPLES, example), source, { recursive: true });
  const setup = await compose(dataDir);
  await setup.plugins.registry.install(source, "operator");
  await setup.plugins.registry.decide(id, version, "approved", "operator");
  await setup.plugins.registry.enable(id, "operator");
  runtimes.splice(runtimes.indexOf(setup), 1);
  await setup.close();
  return compose(dataDir);
}

const check = (input: unknown, over: Partial<ModEnvelope> = {}): ModHookInput<"tool.check"> => ({
  envelope: { ...envelope, ...over },
  tool: "sandbox.run",
  callId: "c",
  input,
  verdict: { decision: "allow", reasons: [] },
});

describe("Example 3: acme-guard", () => {
  it("asks about a destructive command, refuses it unattended, and leaves the rest to the gate", async () => {
    const runtime = await running("acme-guard", "acme.guard", "0.1.0");
    expect(runtime.plugins.status("acme.guard").phase).toBe("ready");
    const allow = async () => ({ decision: "allow" as const });
    expect((await runtime.turnHooks.dispatch("tool.check", check({ command: "git", args: ["reset", "--hard"] }), allow)).result).toEqual({
      decision: "ask",
      reason: "This command discards uncommitted work.",
    });
    expect(
      (await runtime.turnHooks.dispatch("tool.check", check({ command: "rm -rf build" }, { attended: false }), allow)).result.decision,
    ).toBe("deny");
    expect((await runtime.turnHooks.dispatch("tool.check", check({ command: "ls" }), allow)).result).toEqual({ decision: "allow" });
  });
});

describe("Example 4: cache-meter", () => {
  it("shows when the prompt cache goes cold, and clears the line when nothing was cached", async () => {
    const runtime = await running("cache-meter", "acme.cachetimer", "0.1.0");
    runtime.runEventBus.publish("t", { kind: "run.started", runId: "t", attemptId: "a1", threadId: "thread-1", workspaceId: "default" });
    const end = (cacheRead: number, cacheWrite = 0) =>
      runtime.turnHooks.dispatch(
        "turn.complete",
        {
          envelope,
          outcome: "completed",
          usage: { inputTokens: 1_000, inputCacheReadTokens: cacheRead, inputCacheWriteTokens: cacheWrite },
          toolCalls: 0,
        },
        async () => ({}),
      );
    await end(800);
    await end(0);
    // A conversation's first turn writes the cache: warm from then too.
    await end(0, 900);
    const { replayed } = runtime.runEventBus.subscribe({ taskId: "t", from: "beginning", deliver: () => {} });
    const lines = replayed.flatMap((event) => (event.kind === "plugin.status" ? [event.line] : []));
    expect(lines[0]).toMatch(/^cache warm until \d\d:\d\d$/);
    expect(lines[1]).toBeUndefined();
    expect(lines[2]).toMatch(/^cache warm until \d\d:\d\d$/);
    expect(lines).toHaveLength(3);
  });
});
