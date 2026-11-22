import { describe, expect, it } from "vitest";

import {
  MODS_ABI,
  ModsDeclarationSchema,
  NO_TURN_HOOKS,
  PromptSubmitHookResultSchema,
  ToolCallHookResultSchema,
  ToolCheckHookResultSchema,
  ToolResultHookResultSchema,
  TurnCompleteHookResultSchema,
  modFailureRuleOf,
  modHookReadsLine,
  modHookViewsOf,
  type ModEnvelope,
} from "../src/mods.js";
import { PLUGIN_BOUNDS, PluginManifestSchema, describePluginTool, pluginToolOutputTrust, pluginToolViews } from "../src/plugin-registry.js";

/** The `mods` contribution of a plugin manifest. */
const base = {
  schemaVersion: 2,
  abi: "tavi.providers/1",
  provenance: { format: "bundled-esm", packages: [] },
  id: "acme.guard",
  version: "1.0.0",
  name: "Guard",
  entry: "index.mjs",
};

const guard = { event: "tool.check", match: { tools: ["sandbox.run"] }, disclosure: "Asks before shell commands that delete files." };

describe("a manifest's mods block", () => {
  it("parses a manifest with no mods, as every installed plugin has", () => {
    expect(PluginManifestSchema.parse(base).mods).toBeUndefined();
  });

  it("parses declared hooks under schemaVersion 2 and the providers ABI", () => {
    const parsed = PluginManifestSchema.parse({
      ...base,
      mods: { abi: MODS_ABI, hooks: [guard, { event: "turn.complete", disclosure: "Reads token usage." }] },
    });
    expect(parsed.mods?.hooks).toHaveLength(2);
  });

  it.each([
    ["schemaVersion 3", { ...base, schemaVersion: 3 }],
    ["a top-level mods ABI", { ...base, abi: "tavi.mods/1" }],
    ["root-level permissions", { ...base, permissions: { intercept: ["tool.call"] } }],
    ["root-level hooks", { ...base, hooks: { modules: ["./hooks/register.js"] } }],
    ["an unknown event", { ...base, mods: { abi: MODS_ABI, hooks: [{ event: "prompt.expansion", disclosure: "x" }] } }],
    [
      "a tool.result hook that passes on failure",
      { ...base, mods: { abi: MODS_ABI, hooks: [{ event: "tool.result", onFailure: "skip", disclosure: "x" }] } },
    ],
    [
      "a tools match on a turn event",
      { ...base, mods: { abi: MODS_ABI, hooks: [{ event: "turn.start", match: { tools: ["fs.read"] }, disclosure: "x" }] } },
    ],
    ["the same hook twice", { ...base, mods: { abi: MODS_ABI, hooks: [guard, guard] } }],
    ["no disclosure", { ...base, mods: { abi: MODS_ABI, hooks: [{ event: "turn.start", disclosure: " " }] } }],
    ["mods without an entry", { ...base, entry: undefined, ui: undefined, mods: { abi: MODS_ABI, hooks: [guard] } }],
    ["another mods ABI", { ...base, mods: { abi: "tavi.mods/2", hooks: [guard] } }],
    ["trusted context on a hook that adds none", { ...base, mods: { abi: MODS_ABI, hooks: [{ ...guard, contextTrusted: true }] } }],
    [
      "trusted context other than true",
      { ...base, mods: { abi: MODS_ABI, hooks: [{ event: "prompt.submit", disclosure: "x", contextTrusted: false }] } },
    ],
  ])("refuses %s", (_name, manifest) => {
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it(`refuses more than ${PLUGIN_BOUNDS.maxHooks} hooks`, () => {
    const hooks = Array.from({ length: PLUGIN_BOUNDS.maxHooks + 1 }, (_, index) => ({
      event: "tool.call",
      match: { tools: [`fixture.tool${index}`] },
      disclosure: "x",
    }));
    expect(PluginManifestSchema.safeParse({ ...base, mods: { abi: MODS_ABI, hooks } }).success).toBe(false);
  });

  it("fails gating hooks closed by default", () => {
    expect(modFailureRuleOf({ event: "tool.check" })).toBe("ask");
    expect(modFailureRuleOf({ event: "tool.result" })).toBe("withhold");
    expect(modFailureRuleOf({ event: "turn.complete" })).toBe("skip");
    expect(modFailureRuleOf({ event: "tool.check", onFailure: "deny" })).toBe("deny");
  });

  it("says in Tavi's words what a hook can read, widest when it matches nothing", () => {
    expect(modHookReadsLine({ event: "tool.result" })).toBe(
      "Sees and can change the output of every tool. It sees this in every workspace.",
    );
    expect(modHookReadsLine({ event: "tool.check", match: { tools: ["sandbox.run"], sources: ["cli"] } })).toBe(
      "Sees the input of `sandbox.run` (turns from cli), and can refuse the call. It sees this in every workspace.",
    );
    expect(modHookReadsLine({ event: "prompt.submit" })).toContain("every channel");
    expect(modHookViewsOf(ModsDeclarationSchema.parse({ abi: MODS_ABI, hooks: [guard] }))[0]).toMatchObject({
      event: "tool.check",
      onFailure: "ask",
      disclosure: guard.disclosure,
    });
  });
});

describe("a prompt.submit hook's trusted context", () => {
  const submit = { event: "prompt.submit", disclosure: "Adds the open ticket's title." };

  it("is declared per hook, and shown at approval", () => {
    const parsed = PluginManifestSchema.parse({
      ...base,
      mods: {
        abi: MODS_ABI,
        hooks: [
          { ...submit, contextTrusted: true },
          { ...submit, match: { sources: ["cli"] } },
        ],
      },
    });
    const [trusted, untrusted] = modHookViewsOf(parsed.mods!);
    expect(trusted).toMatchObject({ event: "prompt.submit", contextTrusted: true });
    expect(trusted?.reads).toContain("trusted context");
    expect(untrusted?.contextTrusted).toBeUndefined();
    expect(untrusted?.reads).not.toContain("trusted context");
  });
});

describe("a plugin tool's untrusted output", () => {
  it("reads silence as untrusted; only an explicit false is trusted", () => {
    expect(pluginToolOutputTrust({})).toBe("untrusted");
    expect(pluginToolOutputTrust({ untrustedOutput: true })).toBe("untrusted");
    expect(pluginToolOutputTrust({ untrustedOutput: false })).toBe("trusted");
  });

  it("shows an explicit false at approval; the default says nothing", () => {
    const manifest = PluginManifestSchema.parse({
      ...base,
      tools: [
        { name: "page", effect: "read-only", description: "Reads a page" },
        { name: "own", effect: "read-only", description: "Its own data", untrustedOutput: false },
      ],
    });
    expect(pluginToolViews({ pluginId: "acme.tally", manifest }).map((tool) => describePluginTool(tool))).toEqual([
      "acme.tally.page (read-only)",
      "acme.tally.own (read-only, trusted output)",
    ]);
  });
});

describe("hook answers and the port", () => {
  it.each([
    ["tool.check", ToolCheckHookResultSchema, { decision: "ask", reason: "Deletes files." }],
    ["tool.check (a long deny)", ToolCheckHookResultSchema, { decision: "deny", reason: "x".repeat(500) }],
    ["tool.call", ToolCallHookResultSchema, { deny: "Not on Fridays." }],
    ["tool.call (proceed)", ToolCallHookResultSchema, {}],
    ["tool.result", ToolResultHookResultSchema, { output: { text: "ok" } }],
    ["tool.result (withhold)", ToolResultHookResultSchema, { withhold: "Could not check it." }],
    ["prompt.submit", PromptSubmitHookResultSchema, { context: ["The repo is on main."] }],
    ["prompt.submit (drop)", PromptSubmitHookResultSchema, { drop: "Outside working hours." }],
    ["turn.complete", TurnCompleteHookResultSchema, { suggestions: ["Run the tests"] }],
  ] as const)("round-trips a %s answer", (_name, schema, answer) => {
    expect(schema.parse(answer)).toEqual(answer);
  });

  it.each([
    ["a check with no decision", ToolCheckHookResultSchema, { reason: "x" }],
    ["a check that invents a decision", ToolCheckHookResultSchema, { decision: "maybe" }],
    ["an ask reason over 300 characters", ToolCheckHookResultSchema, { decision: "ask", reason: "x".repeat(301) }],
    ["a deny reason over 500 characters", ToolCheckHookResultSchema, { decision: "deny", reason: "x".repeat(501) }],
    ["a result that both answers and withholds", ToolResultHookResultSchema, { output: 1, withhold: "x" }],
    ["four suggestions", TurnCompleteHookResultSchema, { suggestions: ["a", "b", "c", "d"] }],
    ["a call answer with a made-up result", ToolCallHookResultSchema, { result: {} }],
  ] as const)("refuses %s", (_name, schema, answer) => {
    expect(schema.safeParse(answer).success).toBe(false);
  });

  it("with no hooks, every dispatch is core's answer", async () => {
    const envelope: ModEnvelope = { workspaceId: "ws", principalId: "p", taskId: "t", runId: "t", source: "cli", attended: true };
    expect(NO_TURN_HOOKS.has("tool.check", envelope, "fs.read")).toBe(false);
    const outcome = await NO_TURN_HOOKS.dispatch(
      "tool.check",
      { envelope, tool: "fs.read", callId: "c", verdict: { decision: "allow", reasons: [] } },
      async () => ({ decision: "allow" as const }),
    );
    expect(outcome).toEqual({ result: { decision: "allow" } });
  });
});

describe("a manifest's commands", () => {
  it("parses a mods block of commands alone, and refuses an empty one, a duplicate or a bad name", () => {
    const commands = [{ name: "tally", description: "Counts this chat's tool calls." }];
    expect(PluginManifestSchema.parse({ ...base, mods: { abi: MODS_ABI, commands } }).mods?.commands).toEqual(commands);
    expect(PluginManifestSchema.safeParse({ ...base, mods: { abi: MODS_ABI } }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ ...base, mods: { abi: MODS_ABI, commands: [...commands, ...commands] } }).success).toBe(false);
    expect(
      PluginManifestSchema.safeParse({ ...base, mods: { abi: MODS_ABI, commands: [{ name: "Tally", description: "x" }] } }).success,
    ).toBe(false);
  });
});
