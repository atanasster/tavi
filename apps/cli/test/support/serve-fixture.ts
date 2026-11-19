import type { WorkspaceGrant } from "@tavi/runtime";

import { MEMORY_PROPOSE_ALLOW_RULE_ID } from "@tavi/contracts";

import type { TaviRuntime, TaviRuntimeOptions } from "../../src/runtime/types.js";
import { serve, type ServeHandle } from "../../src/server/serve.js";

/**
 * The runtime options a test's owner composes with: one `default`
 * workspace the operator may invoke tools, models and runs in, no provider,
 * no credential, the fixture model target, and a logger that keeps only
 * errors (and drops them). `overrides` replace any of it — a test's own
 * connection id, a provider, a sweep turned on.
 */

/** The operator's grant on the `default` workspace. */
const OPERATOR_WORKSPACE: WorkspaceGrant = {
  workspaceId: "default",
  principalId: "operator",
  permissions: ["tools.invoke", "models.invoke", "runs.create"],
};

/** Options for `composeTaviRuntime`: the fixture defaults, then `overrides`. */
export function fixtureRuntimeOptions(dataDirectory: string, overrides: Partial<TaviRuntimeOptions> = {}): TaviRuntimeOptions {
  return {
    dataDirectory,
    workspaces: [OPERATOR_WORKSPACE],
    providers: [],
    credentials: {},
    defaultConnectionId: "fixture",
    defaultModel: "fixture-model",
    logger: { level: "error", sink: () => {} },
    ...overrides,
  };
}

/** Options for `serve`: `fixtureRuntimeOptions` with the schedule sweep off, so no schedule fires mid-test. */
export function fixtureServeOptions(dataDirectory: string, overrides: Partial<TaviRuntimeOptions> = {}): TaviRuntimeOptions {
  return fixtureRuntimeOptions(dataDirectory, { scheduleSweepEnabled: false, ...overrides });
}

/**
 * Owners a test serves on its own data directories, with fixture options and no output: `start` serves one,
 * `stopLast` shuts down the newest (an owner's restart), `stopAll` every one still running (an `afterEach`).
 */
export function fixtureOwners(): {
  readonly start: (directory: string) => Promise<ServeHandle>;
  readonly stopLast: (reason: string) => Promise<void>;
  readonly stopAll: () => Promise<void>;
} {
  const handles: ServeHandle[] = [];
  return {
    start: async (directory) => {
      const handle = await serve(
        fixtureServeOptions(directory),
        { dataDirectory: directory, drainDeadlineMs: 2_000 },
        { stdout: () => {}, stderr: () => {}, isTty: false },
      );
      handles.push(handle);
      return handle;
    },
    stopLast: async (reason) => {
      await handles.pop()?.shutdown(reason);
    },
    stopAll: async () => {
      while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
    },
  };
}

/**
 * Revokes the seeded allow rule for `memory.propose`, as an operator may, so a test that uses a memory proposal as
 * its example of an asked call gets its approval round. Returns the runtime.
 */
export async function askingForMemoryProposals(runtime: TaviRuntime): Promise<TaviRuntime> {
  await runtime.store.asPort().repositories.toolPolicy.deleteRule("default", MEMORY_PROPOSE_ALLOW_RULE_ID);
  return runtime;
}
