import type { ModEnvelope, ModHookInput } from "@tavi/contracts";

import type { guardCheck } from "../../src/index.js";

/** What `tavi.guard`'s hook is called with in its tests: an attended CLI turn's envelope, and the next hook's ask. */

const envelope: ModEnvelope = { workspaceId: "default", principalId: "operator", taskId: "t", runId: "t", source: "cli", attended: true };

/** A `tool.check` of `sandbox.run` given `input`, its envelope's fields `over` (a `locale`, say), its verdict so far to ask. */
export const check = (input: unknown, over: Partial<ModEnvelope> = {}): ModHookInput<"tool.check"> => ({
  envelope: { ...envelope, ...over },
  tool: "sandbox.run",
  callId: "c",
  input,
  verdict: { decision: "ask", reasons: [] },
});

/** The hook after the guard: it asks. */
export const next: Parameters<typeof guardCheck>[1] = Object.assign(async () => ({ decision: "ask" as const }), {
  signal: new AbortController().signal,
});
