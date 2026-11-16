import type { InvocationContext, ModelRoleBinding, ProviderAttemptSummary } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { createRoleTarget } from "../../src/features/models/role-target.js";

/**
 * The composition's `roleTarget`: the connections a chat used
 * come from its ledger — generation attempts only, and for a worker its chat's
 * as well — so a chat that once ran on a local model never reaches a remote role.
 */

const OWN = { connectionId: "cloud", model: "cloud-model" };
const ROLE = { connectionId: "cheap-cloud", model: "cheap" };
const LOCALITIES: Record<string, "local" | "remote"> = { cloud: "remote", "cheap-cloud": "remote", ollama: "local" };

const binding = (role: ModelRoleBinding["role"]): ModelRoleBinding => ({
  workspaceId: "default",
  role,
  target: ROLE,
  fallback: [],
  updatedAt: "2026-10-12T00:00:00.000Z",
});

function attempt(connectionId: string, purpose: ProviderAttemptSummary["purpose"]): ProviderAttemptSummary {
  return {
    callId: `call-${connectionId}`,
    attemptId: `attempt-${connectionId}`,
    connectionId,
    model: "m",
    state: "completed",
    purpose,
    usage: {},
    startedAt: "2026-10-12T00:00:00.000Z",
  };
}

function roleTargetWith(
  ledger: Record<string, readonly ProviderAttemptSummary[]>,
  bindings: readonly ModelRoleBinding[] = [binding("compaction")],
) {
  const read: string[] = [];
  const roleTarget = createRoleTarget({
    roleBindings: () => bindings,
    attempts: async (taskId) => {
      read.push(taskId);
      return ledger[taskId] ?? [];
    },
    locality: async (connectionId) => LOCALITIES[connectionId],
  });
  return { read, roleTarget };
}

const invocation = (extra: Partial<InvocationContext> = {}): InvocationContext => ({
  runId: "chat-1",
  workspaceId: "default",
  principalId: "operator",
  caller: "test",
  ...extra,
});

describe("the composition's roleTarget", () => {
  it("falls back to the fast role when the asked one is not bound, and to the chat's own model when neither is", async () => {
    const ledger = { "chat-1": [attempt("cloud", "generation")] };
    expect(await roleTargetWith(ledger, [binding("fast")]).roleTarget("compaction", invocation(), OWN)).toEqual(ROLE);
    expect(await roleTargetWith(ledger, [binding("fast")]).roleTarget("extraction", invocation(), OWN)).toEqual(ROLE);
    expect(await roleTargetWith(ledger, []).roleTarget("compaction", invocation(), OWN)).toBeUndefined();
  });

  it("uses a bound remote role for a chat that only ever ran remotely", async () => {
    const { roleTarget } = roleTargetWith({ "chat-1": [attempt("cloud", "generation")] });
    expect(await roleTarget("compaction", invocation(), OWN)).toEqual(ROLE);
  });

  it("keeps a chat now on a remote model off a remote role when its ledger holds a local generation", async () => {
    const { roleTarget } = roleTargetWith({ "chat-1": [attempt("ollama", "generation"), attempt("cloud", "generation")] });
    expect(await roleTarget("compaction", invocation(), OWN)).toBeUndefined();
  });

  it("counts only generation attempts", async () => {
    const { roleTarget } = roleTargetWith({ "chat-1": [attempt("ollama", "summary"), attempt("cloud", "generation")] });
    expect(await roleTarget("compaction", invocation(), OWN)).toEqual(ROLE);
  });

  it("counts a worker's chat's calls as well as its own", async () => {
    const { read, roleTarget } = roleTargetWith({
      "worker-1": [attempt("cloud", "generation")],
      "chat-1": [attempt("ollama", "generation")],
    });
    expect(await roleTarget("compaction", invocation({ runId: "worker-1", chatTaskId: "chat-1" }), OWN)).toBeUndefined();
    expect(read.sort()).toEqual(["chat-1", "worker-1"]);
  });

  it("answers undefined, reading no ledger, when the role is not bound", async () => {
    const { read, roleTarget } = roleTargetWith({}, [binding("main")]);
    expect(await roleTarget("extraction", invocation(), OWN)).toBeUndefined();
    expect(read).toEqual([]);
  });
});
