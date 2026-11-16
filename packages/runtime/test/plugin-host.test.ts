import { describe, expect, it, vi } from "vitest";

import { createServiceToken, type PluginDefinition } from "@tavi/contracts";
import { PluginHost, PluginHostError } from "@tavi/runtime";

const AlphaService = createServiceToken<{ readonly name: string }>("test.alpha");
const BetaService = createServiceToken<{ readonly alpha: { readonly name: string } }>("test.beta");
const GammaService = createServiceToken<{ readonly value: number }>("test.gamma");

const plugin = (overrides: Partial<PluginDefinition> & Pick<PluginDefinition, "id">): PluginDefinition => ({
  version: "0.0.0",
  provides: [],
  requires: [],
  start: () => ({}),
  ...overrides,
});

describe("PluginHost composition validation", () => {
  it("rejects duplicate plugin ids before any plugin starts", () => {
    const start = vi.fn(() => ({}));
    expect(() => new PluginHost([plugin({ id: "test.one", start }), plugin({ id: "test.one", start })], { buildId: "t" })).toThrowError(
      PluginHostError,
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects two providers of the same service", () => {
    const host = () =>
      new PluginHost(
        [
          plugin({ id: "test.a", provides: [AlphaService], start: () => ({ [AlphaService.id]: { name: "a" } }) }),
          plugin({ id: "test.b", provides: [AlphaService], start: () => ({ [AlphaService.id]: { name: "b" } }) }),
        ],
        { buildId: "t" },
      );
    expect(host).toThrowError(/provided by both/);
  });

  it("rejects a missing required dependency", () => {
    expect(() => new PluginHost([plugin({ id: "test.a", requires: [AlphaService] })], { buildId: "t" })).toThrowError(
      /requires test.alpha/,
    );
  });

  it("allows a missing optional dependency and surfaces it as undefined", async () => {
    const host = new PluginHost(
      [
        plugin({
          id: "test.a",
          optional: [AlphaService],
          start: ({ dependencies }) => {
            expect(dependencies.tryGet(AlphaService)).toBeUndefined();
            return {};
          },
        }),
      ],
      { buildId: "t" },
    );
    await host.start();
    expect(host.admissionOpen).toBe(true);
  });

  it("refuses an undeclared optional lookup", async () => {
    const host = new PluginHost(
      [
        plugin({
          id: "test.a",
          optional: [AlphaService],
          start: ({ dependencies }) => {
            expect(() => dependencies.tryGet(BetaService)).toThrowError(/undeclared service/);
            return {};
          },
        }),
      ],
      { buildId: "t" },
    );
    await host.start();
  });

  it("rejects a dependency cycle", () => {
    expect(
      () =>
        new PluginHost(
          [
            plugin({ id: "test.a", provides: [AlphaService], requires: [BetaService] }),
            plugin({ id: "test.b", provides: [BetaService], requires: [AlphaService] }),
          ],
          { buildId: "t" },
        ),
    ).toThrowError(/cycle/);
  });

  it("rejects invalid plugin ids", () => {
    expect(() => new PluginHost([plugin({ id: "NotDotted" })], { buildId: "t" })).toThrowError(/Invalid plugin id/);
  });
});

describe("PluginHost lifecycle", () => {
  it("starts providers before consumers and stops consumers before providers", async () => {
    const order: string[] = [];
    const host = new PluginHost(
      [
        plugin({
          id: "test.consumer",
          requires: [AlphaService],
          start: ({ dependencies, scope }) => {
            order.push("start:consumer");
            expect(dependencies.get(AlphaService).name).toBe("alpha");
            scope.defer(() => {
              order.push("stop:consumer");
            });
            return {};
          },
        }),
        plugin({
          id: "test.provider",
          provides: [AlphaService],
          start: ({ scope }) => {
            order.push("start:provider");
            scope.defer(() => {
              order.push("stop:provider");
            });
            return { [AlphaService.id]: { name: "alpha" } };
          },
        }),
      ],
      { buildId: "t" },
    );

    await host.start();
    expect(order).toEqual(["start:provider", "start:consumer"]);

    const report = await host.stop();
    expect(report.clean).toBe(true);
    expect(order).toEqual(["start:provider", "start:consumer", "stop:consumer", "stop:provider"]);
    expect(host.admissionOpen).toBe(false);
  });

  it("unwinds newly started plugins and partial resources on startup failure", async () => {
    const disposed: string[] = [];
    const host = new PluginHost(
      [
        plugin({
          id: "test.good",
          provides: [AlphaService],
          start: ({ scope }) => {
            scope.defer(() => {
              disposed.push("good");
            });
            return { [AlphaService.id]: { name: "alpha" } };
          },
        }),
        plugin({
          id: "test.bad",
          requires: [AlphaService],
          start: ({ scope }) => {
            scope.defer(() => {
              disposed.push("bad-partial");
            });
            throw new Error("boom");
          },
        }),
      ],
      { buildId: "t" },
    );

    await expect(host.start()).rejects.toThrowError(/test.bad failed to start/);
    expect(disposed).toEqual(["bad-partial", "good"]);
    expect(host.admissionOpen).toBe(false);
    expect(host.phaseOf("test.bad")).toBe("failed");
    expect(host.phaseOf("test.good")).toBe("stopped");
  });

  it("rejects a plugin that does not return its declared services", async () => {
    const host = new PluginHost([plugin({ id: "test.a", provides: [AlphaService], start: () => ({}) })], { buildId: "t" });
    await expect(host.start()).rejects.toThrowError(/did not provide it/);
  });

  it("rejects a plugin that returns an undeclared service", async () => {
    // Every declared service is supplied, so the only possible complaint is the
    // extra `test.gamma` key: the host must not publish undeclared services.
    const host = new PluginHost(
      [
        plugin({
          id: "test.a",
          provides: [AlphaService, BetaService],
          start: () => ({
            [AlphaService.id]: { name: "a" },
            [BetaService.id]: { alpha: { name: "a" } },
            [GammaService.id]: { value: 1 },
          }),
        }),
      ],
      { buildId: "t" },
    );
    await expect(host.start()).rejects.toThrowError(/undeclared service/);
  });

  it("stops serving a service once its provider stops", async () => {
    let released = false;
    const host = new PluginHost(
      [
        plugin({
          id: "test.provider",
          provides: [AlphaService],
          start: ({ scope }) => {
            scope.defer(() => {
              released = true;
            });
            return { [AlphaService.id]: { name: "alpha" } };
          },
        }),
      ],
      { buildId: "t" },
    );
    await host.start();
    await host.stop();
    expect(released).toBe(true);
    expect(host.phaseOf("test.provider")).toBe("stopped");
  });

  it("disposes exactly once when stop is called twice", async () => {
    const dispose = vi.fn();
    const host = new PluginHost(
      [
        plugin({
          id: "test.a",
          provides: [AlphaService],
          start: ({ scope }) => {
            scope.defer(dispose);
            return { [AlphaService.id]: { name: "alpha" } };
          },
        }),
      ],
      { buildId: "t" },
    );
    await host.start();
    await host.stop();
    await host.stop();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("reports aggregated disposal failures and continues unwinding", async () => {
    const order: string[] = [];
    const host = new PluginHost(
      [
        plugin({
          id: "test.a",
          provides: [AlphaService],
          start: ({ scope }) => {
            scope.defer(() => {
              order.push("first");
            });
            scope.defer(() => {
              order.push("second");
              throw new Error("disposer failed");
            });
            return { [AlphaService.id]: { name: "alpha" } };
          },
        }),
      ],
      { buildId: "t" },
    );
    await host.start();
    const report = await host.stop();
    expect(order).toEqual(["second", "first"]);
    expect(report.clean).toBe(false);
    expect(report.failures).toEqual([{ pluginId: "test.a", message: "disposer failed" }]);
  });

  it("reports a hung disposer as unclean rather than successful", async () => {
    const host = new PluginHost(
      [
        plugin({
          id: "test.hung",
          provides: [AlphaService],
          start: ({ scope }) => {
            scope.defer(
              () =>
                new Promise<void>(() => {
                  /* never resolves */
                }),
            );
            return { [AlphaService.id]: { name: "alpha" } };
          },
        }),
      ],
      { buildId: "t", shutdownDeadlineMs: 20 },
    );
    await host.start();
    const report = await host.stop();
    expect(report.timedOut).toBe(true);
    expect(report.clean).toBe(false);
    expect(host.phaseOf("test.hung")).toBe("failed");
  });

  it("refuses to defer cleanup after disposal has started", async () => {
    let scopeRef: { defer: (d: () => void) => void } | undefined;
    const host = new PluginHost(
      [
        plugin({
          id: "test.a",
          provides: [AlphaService],
          start: ({ scope }) => {
            scopeRef = scope;
            return { [AlphaService.id]: { name: "alpha" } };
          },
        }),
      ],
      { buildId: "t" },
    );
    await host.start();
    await host.stop();
    expect(() => scopeRef?.defer(() => {})).toThrowError(/already been disposed/);
  });

  it("starts the same composition in the same order every time", async () => {
    const runs: string[][] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const order: string[] = [];
      const host = new PluginHost(
        [
          plugin({
            id: "test.zeta",
            provides: [GammaService],
            start: () => {
              order.push("zeta");
              return { [GammaService.id]: { value: 1 } };
            },
          }),
          plugin({
            id: "test.alpha",
            provides: [AlphaService],
            requires: [GammaService],
            start: () => {
              order.push("alpha");
              return { [AlphaService.id]: { name: "a" } };
            },
          }),
        ],
        { buildId: "t" },
      );
      await host.start();
      await host.stop();
      runs.push(order);
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[0]).toEqual(["zeta", "alpha"]);
  });
});

describe("PluginHost replacement seam", () => {
  /**
   * The consumer definition below is byte-identical across both runs; only the
   * provider changes. That is the replaceability property:
   * a consumer is written against a service contract, not an implementation.
   */
  const consumer = (observed: { value?: string }): PluginDefinition =>
    plugin({
      id: "test.consumer",
      requires: [AlphaService],
      start: ({ dependencies }) => {
        observed.value = dependencies.get(AlphaService).name;
        return {};
      },
    });

  const provider = (name: string): PluginDefinition =>
    plugin({
      id: "test.provider",
      provides: [AlphaService],
      start: () => ({ [AlphaService.id]: { name } }),
    });

  it("swaps a model-style provider without editing its consumer", async () => {
    const first: { value?: string } = {};
    const firstHost = new PluginHost([provider("fixture"), consumer(first)], { buildId: "t" });
    await firstHost.start();
    await firstHost.stop();

    const second: { value?: string } = {};
    const secondHost = new PluginHost([provider("production"), consumer(second)], { buildId: "t" });
    await secondHost.start();
    await secondHost.stop();

    expect(first.value).toBe("fixture");
    expect(second.value).toBe("production");
  });
});

describe("PluginHost ordering and lifetime guards", () => {
  it("starts a provider before a consumer that declares it as optional", async () => {
    const order: string[] = [];
    const host = new PluginHost(
      [
        // Sorted ids would otherwise place the consumer first and silently leave
        // its optional lookup undefined even though the provider is selected.
        plugin({
          id: "test.aaa.consumer",
          optional: [AlphaService],
          start: ({ dependencies }) => {
            const alpha = dependencies.tryGet(AlphaService);
            order.push(alpha === undefined ? "consumer:missing" : `consumer:${alpha.name}`);
            return {};
          },
        }),
        plugin({
          id: "test.zzz.provider",
          provides: [AlphaService],
          start: () => {
            order.push("provider");
            return { [AlphaService.id]: { name: "alpha" } };
          },
        }),
      ],
      { buildId: "t" },
    );
    await host.start();
    expect(order).toEqual(["provider", "consumer:alpha"]);
    await host.stop();
  });

  it("refuses a second start of the same composition", async () => {
    const host = new PluginHost(
      [
        plugin({
          id: "test.a",
          provides: [AlphaService],
          start: () => ({ [AlphaService.id]: { name: "alpha" } }),
        }),
      ],
      { buildId: "t" },
    );
    await host.start();
    expect(host.isPristine).toBe(false);
    await expect(host.start()).rejects.toThrowError(/can only be started once/);
    await host.stop();
  });

  it("refuses to start a composition that was already stopped", async () => {
    const host = new PluginHost(
      [
        plugin({
          id: "test.a",
          provides: [AlphaService],
          start: () => ({ [AlphaService.id]: { name: "alpha" } }),
        }),
      ],
      { buildId: "t" },
    );
    await host.start();
    await host.stop();
    await expect(host.start()).rejects.toThrowError(/can only be started once/);
  });

  it("reports how many disposers actually ran, not how many services exist", async () => {
    const host = new PluginHost(
      [
        plugin({
          id: "test.a",
          provides: [AlphaService],
          start: ({ scope }) => {
            scope.defer(() => {});
            scope.defer(() => {});
            scope.defer(() => {});
            return { [AlphaService.id]: { name: "alpha" } };
          },
        }),
      ],
      { buildId: "t" },
    );
    await host.start();
    await host.stop();
    const status = host.status().find((entry) => entry.id === "test.a");
    expect(status?.disposersRun).toBe(3);
  });

  it("counts a deadline-truncated disposal as unclean", async () => {
    const host = new PluginHost(
      [
        plugin({
          id: "test.hung",
          provides: [AlphaService],
          start: ({ scope }) => {
            scope.defer(() => {});
            scope.defer(
              () =>
                new Promise<void>(() => {
                  /* never resolves */
                }),
            );
            return { [AlphaService.id]: { name: "alpha" } };
          },
        }),
      ],
      { buildId: "t", shutdownDeadlineMs: 20 },
    );
    await host.start();
    const report = await host.stop();
    expect(report.clean).toBe(false);
    expect(report.failures.some((failure) => /disposers ran/.test(failure.message))).toBe(true);
  });
});

it.each(["timeout", "failure"] as const)("retains %s from startup cleanup in later shutdown reports", async (mode) => {
  const blocked = Promise.withResolvers<void>();
  const host = new PluginHost(
    [
      plugin({
        id: "test.startup",
        start: ({ scope }) => {
          scope.defer(async () => {
            if (mode === "failure") throw new Error("cleanup failed");
            await blocked.promise;
          });
          throw new Error("startup failed");
        },
      }),
    ],
    { buildId: "test", shutdownDeadlineMs: 10 },
  );
  await expect(host.start()).rejects.toThrow("startup failed");
  const report = await host.stop();
  expect(report.clean).toBe(false);
  expect(report.timedOut).toBe(mode === "timeout");
  if (mode === "failure") expect(report.failures).toContainEqual({ pluginId: "test.startup", message: "cleanup failed" });
  blocked.resolve();
  expect((await host.stop()).clean).toBe(false);
});
