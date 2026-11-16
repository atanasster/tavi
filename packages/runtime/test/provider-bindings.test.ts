import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { evaluateGate, type InvocationContext, type ProviderBinding, type SessionGrant, type ToolRule } from "@tavi/contracts";
import { OwnedResourceScope, ProviderBindings, ProviderFactoryRegistry, executeProvider, providerRevision } from "../src/index.js";

const context: InvocationContext = { workspaceId: "a", principalId: "owner", runId: "run", caller: "test" };
const binding: ProviderBinding = {
  kind: "search",
  instanceId: "account-a",
  workspaceId: "a",
  principalId: "owner",
  accountId: "a",
  endpoint: "https://provider.example",
  implementationHash: "a".repeat(64),
  configRevision: "b".repeat(64),
};
async function fixture() {
  const owner = new OwnedResourceScope();
  const factories = new ProviderFactoryRegistry<{ search(): string }>();
  const search = vi.fn(() => "result");
  factories.register("search", { settingsSchema: z.object({}), create: () => ({ search }) }, owner);
  const instance = await factories.create("search", {
    instanceId: "account-a",
    settings: {},
    credentials: {},
    readSecret: async () => null,
    owner,
  });
  const bindings = new ProviderBindings<{ search(): string }>();
  bindings.register(binding, instance, owner);
  const resolved = bindings.resolve(context, binding.instanceId);
  const authorize = vi.fn(async () => {});
  const reserve = vi.fn(async () => {});
  const execute = (overrides: Partial<Parameters<typeof executeProvider<{ search(): string }, string>>[0]> = {}) =>
    executeProvider({
      resolved,
      context,
      expectedBindingHash: resolved.bindingHash,
      signal: new AbortController().signal,
      attemptId: "attempt",
      purpose: "search",
      authorize,
      reserve,
      invoke: async (provider) => provider.search(),
      ...overrides,
    });
  return { owner, bindings, resolved, search, authorize, reserve, execute };
}

describe("scoped provider execution", () => {
  it("refuses another workspace or principal before authorization or reservation", async () => {
    const f = await fixture();
    for (const other of [
      { ...context, workspaceId: "b" },
      { ...context, principalId: "other" },
    ]) {
      expect(() => f.bindings.resolve(other, binding.instanceId)).toThrow(/another workspace or principal/);
      await expect(f.execute({ context: other })).rejects.toThrow(/authorization/);
    }
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.search).not.toHaveBeenCalled();
    await f.owner.dispose();
  });
  it.each(["authorize", "reserve"] as const)("rechecks withdrawal after awaiting %s", async (stage) => {
    const f = await fixture();
    await expect(
      f.execute({
        [stage]: async () => {
          f.owner.abort(new Error("withdrawn"));
        },
      }),
    ).rejects.toThrow("withdrawn");
    expect(f.search).not.toHaveBeenCalled();
    await f.owner.dispose();
  });
  it("reserves once and keeps the versioned envelope out of provider payloads", async () => {
    const f = await fixture();
    expect(await f.execute()).toBe("result");
    expect(f.reserve).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      binding,
      bindingHash: providerRevision(binding),
      runId: "run",
      attemptId: "attempt",
      purpose: "search",
      caller: "test",
    });
    expect(f.search).toHaveBeenCalledExactlyOnceWith();
    await f.owner.dispose();
  });
  it("rechecks live configuration after reservation", async () => {
    const f = await fixture();
    let current = true;
    await expect(
      f.execute({
        resolved: {
          ...f.resolved,
          validate: async () => {
            if (!current) throw new Error("configuration changed");
          },
        },
        reserve: async () => {
          current = false;
        },
      }),
    ).rejects.toThrow("configuration changed");
    expect(f.search).not.toHaveBeenCalled();
    await f.owner.dispose();
  });
});

describe("provider grants", () => {
  const originalHash = providerRevision(binding);
  const rule: ToolRule = {
    ruleId: "rule",
    toolPattern: "web_search",
    decision: "allow",
    source: "operator",
    workspaceId: "a",
    createdBy: "owner",
    createdVia: "config",
    createdAt: "2026-09-28T00:00:00Z",
    bindingHash: originalHash,
  };
  const grant: SessionGrant = {
    grantId: "grant",
    taskId: "run",
    workspaceId: "a",
    toolId: "web_search",
    bindingHash: originalHash,
    approvalId: "approval",
    createdBy: "owner",
    createdAt: "2026-09-28T00:00:00Z",
  };
  it.each([
    { endpoint: "https://other.example" },
    { accountId: "b" },
    { implementationHash: "c".repeat(64) },
    { configRevision: "d".repeat(64) },
  ])("does not transfer session or standing authority to %j", (changed) => {
    const decide = (bindingHash: string, rules: ToolRule[], sessionGrants: SessionGrant[]) =>
      evaluateGate({
        toolId: "web_search",
        effect: "external",
        gatedEffects: new Set(["external"]),
        origin: "cli",
        tainted: false,
        rules,
        sessionGrants,
        assessment: { bindingHash, subjects: [], display: { title: "Search" }, risk: "medium", reasons: [] },
      });
    expect(decide(originalHash, [rule], []).decision).toBe("allow");
    expect(decide(originalHash, [], [grant]).decision).toBe("allow");
    expect(decide(providerRevision({ ...binding, ...changed }), [rule], [grant]).decision).toBe("ask");
  });
});
