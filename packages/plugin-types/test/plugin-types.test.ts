import { describe, expect, expectTypeOf, it } from "vitest";

import type { ExternalPluginContext, ExternalPluginModule, ModHookInput, ModHookResult } from "../src/index.js";

/** A plugin written against these types alone: `typecheck` is the test that matters here. */
const plugin: ExternalPluginModule = {
  register({ hooks, ui, commands, z, registerTool }: ExternalPluginContext) {
    hooks.on("tool.check", { tools: ["sandbox.run"] }, async (e, next) => {
      expectTypeOf(e).toEqualTypeOf<ModHookInput<"tool.check">>();
      const verdict = await next(e);
      const command = typeof e.input === "object" && e.input !== null && "command" in e.input ? String(e.input.command) : "";
      return command.includes("rm -rf") ? { decision: "ask", reason: "Deletes files." } : verdict;
    });
    hooks.on("turn.complete", async (e, next) => {
      ui.status(e.envelope, `${String(e.usage?.inputCacheReadTokens ?? 0)} cached`);
      ui.publish(e.envelope, "turns", 1);
      return next(e);
    });
    commands.register({ name: "tally", run: ({ args }) => ({ text: args }) });
    registerTool({ name: "lookup", inputSchema: z.object({ q: z.string() }), handler: (input) => input });
  },
};

describe("@tavi/plugin-types", () => {
  it("types a plugin module and its hooks' results", () => {
    expect(typeof plugin.register).toBe("function");
    expectTypeOf<ModHookResult<"tool.check">["decision"]>().toEqualTypeOf<"allow" | "ask" | "deny">();
  });
});
