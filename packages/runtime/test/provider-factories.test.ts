import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ProviderFactoryContext } from "@tavi/contracts/plugin-sdk";
import { OwnedResourceScope, ProviderFactoryRegistry } from "@tavi/runtime";

const input = (instanceId: string, owner = new OwnedResourceScope()) => ({
  instanceId,
  owner,
  settings: { endpoint: `https://${instanceId}.example` },
  credentials: { apiKey: instanceId },
  readSecret: async (ref: string) => `secret-${ref}`,
});

describe("provider factory ownership", () => {
  it("validates settings and isolates accounts and credential names", async () => {
    const owner = new OwnedResourceScope();
    const registry = new ProviderFactoryRegistry<{ endpoint: string; secret: (key: string) => Promise<string | null> }>();
    const create = vi.fn(({ settings, credential }: ProviderFactoryContext<{ endpoint: string }>) => ({
      endpoint: settings.endpoint,
      secret: credential,
    }));
    registry.register("fixture", { settingsSchema: z.object({ endpoint: z.url() }), create }, owner);
    await expect(registry.create("fixture", { ...input("bad"), settings: { endpoint: "invalid" } })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    const a = await registry.create("fixture", input("a"));
    const b = await registry.create("fixture", input("b"));
    expect(a.get()).not.toBe(b.get());
    expect(await a.get().secret("apiKey")).toBe("secret-a");
    expect(await b.get().secret("apiKey")).toBe("secret-b");
    await expect(a.get().secret("other")).rejects.toThrow(/not configured/);
    owner.abort();
    expect(a.signal.aborted).toBe(true);
    expect(() => a.get()).toThrow();
    await owner.dispose();
    await expect(registry.create("fixture", input("c"))).rejects.toThrow(/unavailable/);
  });

  it("cleans a failed factory once, and never publishes after account withdrawal", async () => {
    const registry = new ProviderFactoryRegistry<object>();
    const owner = new OwnedResourceScope();
    const account = new OwnedResourceScope();
    const cleanup = vi.fn();
    let release: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.register(
      "fixture",
      {
        settingsSchema: z.object({}),
        async create({ scope }) {
          scope.defer(cleanup);
          await wait;
          return {};
        },
      },
      owner,
    );
    const pending = registry.create("fixture", input("a", account));
    await Promise.resolve();
    account.abort();
    release();
    await expect(pending).rejects.toThrow(/withdrawn/);
    await Promise.all([account.dispose(), owner.dispose()]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it.each(["abort", "timeout"])("settles a noncooperative constructor on %s", async (cause) => {
    vi.useFakeTimers();
    try {
      const registry = new ProviderFactoryRegistry<object>();
      const owner = new OwnedResourceScope();
      const account = new OwnedResourceScope();
      const cleanup = vi.fn();
      registry.register(
        "fixture",
        {
          settingsSchema: z.object({}),
          create({ scope }) {
            scope.defer(cleanup);
            return new Promise<object>(() => {});
          },
        },
        owner,
      );
      const pending = registry.create("fixture", input("a", account));
      const rejected = expect(pending).rejects.toThrow(cause === "abort" ? /withdrawn/ : /timed out/);
      await Promise.resolve();
      if (cause === "abort") await account.dispose();
      else await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      await owner.dispose();
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers instance cleanup once when the factory and account share a scope", async () => {
    const registry = new ProviderFactoryRegistry<object>();
    const owner = new OwnedResourceScope();
    registry.register(
      "fixture",
      {
        settingsSchema: z.object({}),
        create({ scope }) {
          scope.defer(() => {
            throw new Error("cleanup");
          });
          return {};
        },
      },
      owner,
    );
    await registry.create("fixture", input("a", owner));
    expect(await owner.dispose()).toHaveLength(1);
  });

  it("aggregates construction and cleanup failure", async () => {
    const registry = new ProviderFactoryRegistry<object>();
    const owner = new OwnedResourceScope();
    registry.register(
      "fixture",
      {
        settingsSchema: z.object({}),
        create({ scope }) {
          scope.defer(() => {
            throw new Error("cleanup");
          });
          throw new Error("construction");
        },
      },
      owner,
    );
    await expect(registry.create("fixture", input("a"))).rejects.toThrow(/construction and cleanup/);
    expect((await owner.dispose()).length).toBe(1);
  });
});
