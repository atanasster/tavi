import type * as Composition from "../../src/runtime/composition.js";

/**
 * The composition module with the `fixture.echo` tool turned on, for a
 * CLI-driven suite whose scripted model calls a tool without a provider. The
 * tool is never on a real invocation's surface: only composition's
 * `devFixtureTools` option registers it, and the CLI never sets it. A suite
 * opts in at its top:
 *
 *     vi.mock("../../src/runtime/composition.js", async (original) => (await import("../support/dev-fixture-tool.js")).withFixtureTools(await original()));
 */
export function withFixtureTools(actual: typeof Composition): typeof Composition {
  return {
    ...actual,
    composeTaviRuntime: (options, overrides) => actual.composeTaviRuntime({ ...options, devFixtureTools: true }, overrides),
  };
}
