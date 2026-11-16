import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import type { InvocationContext, ProviderBinding, WebSearchProvider } from "@tavi/contracts";
import { OwnedResourceScope, ProviderBindings, ProviderFactoryRegistry, executeProvider } from "@tavi/runtime";

import { externalProviderInstances, type ExternalProviderRegistries } from "../../src/features/plugins/provider-instances.js";

/** A workspace's plugin provider serves the people allowed there, as their own calls. */

const binding: ProviderBinding = {
  kind: "search",
  instanceId: "acme.search",
  workspaceId: "w",
  principalId: "operator",
  accountId: "acme",
  endpoint: "https://search.example",
  implementationHash: "a".repeat(64),
  configRevision: "b".repeat(64),
};
const context = (principalId: string, workspaceId = "w"): InvocationContext => ({ workspaceId, principalId, runId: "run", caller: "test" });

describe("a plugin provider instance and the people of its workspace", () => {
  it("is resolved and run for an allowed person, bound to them, and refused to anyone else", async () => {
    const owner = new OwnedResourceScope();
    const factories = new ProviderFactoryRegistry<WebSearchProvider>();
    const search = vi.fn(async () => ({ results: [] }));
    factories.register(
      "search",
      { settingsSchema: z.object({}), create: () => ({ id: "acme", available: () => true, search }) as unknown as WebSearchProvider },
      owner,
    );
    const instance = await factories.create("search", {
      instanceId: binding.instanceId,
      settings: {},
      credentials: {},
      readSecret: async () => null,
      owner,
    });
    const registries = {
      search: { factories, bindings: new ProviderBindings<WebSearchProvider>() },
    } as unknown as ExternalProviderRegistries;
    registries.search.bindings.register(binding, instance, owner);
    const people = new Set(["ana"]);
    const instances = externalProviderInstances(registries, {
      principalFor: (workspaceId) => (workspaceId === "w" ? "operator" : undefined),
      actsIn: (workspaceId, principalId) => workspaceId === "w" && (principalId === "operator" || people.has(principalId)),
      readSecret: async () => null,
      credentialRevision: async () => "1",
    });

    const resolved = instances.resolveSearch(binding.instanceId, context("ana"));
    expect(resolved.binding).toMatchObject({ workspaceId: "w", principalId: "ana", instanceId: binding.instanceId });
    // Its dispatch checks name her, so it runs as her call.
    await executeProvider({
      resolved,
      context: context("ana"),
      expectedBindingHash: resolved.bindingHash,
      signal: new AbortController().signal,
      attemptId: "a",
      purpose: "search",
      authorize: async () => {},
      reserve: async () => {},
      invoke: async (provider) => provider.search({ query: "q" } as never),
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(instances.resolveSearch(binding.instanceId, context("operator")).binding.principalId).toBe("operator");

    // Nobody else: not a stranger, not her in another workspace, not her once she is no longer allowed.
    expect(() => instances.resolveSearch(binding.instanceId, context("mallory"))).toThrow(/another workspace or principal/);
    expect(() => instances.resolveSearch(binding.instanceId, context("ana", "other"))).toThrow(/another workspace or principal/);
    people.delete("ana");
    expect(() => instances.resolveSearch(binding.instanceId, context("ana"))).toThrow(/another workspace or principal/);
    await owner.dispose();
  });
});
