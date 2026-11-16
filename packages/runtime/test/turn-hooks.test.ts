import { describe, expect, it } from "vitest";

import { modFolderLabels, type ModEnvelope, type ModHookDeclaration, type ModHookInput } from "@tavi/contracts";
import { sleep } from "@tavi/node-kit";

import { TurnHookRegistry, type TurnHookDecision, type TurnHookFailure } from "../src/plugin-host/turn-hooks.js";

/** The hook registry and runner. */

const envelope: ModEnvelope = { workspaceId: "ws", principalId: "p", taskId: "t", runId: "t", source: "cli", attended: true };
const declare = (event: ModHookDeclaration["event"], extra: Partial<ModHookDeclaration> = {}): ModHookDeclaration[] => [
  { event, disclosure: "test", ...extra } as ModHookDeclaration,
];
const check = (tool = "sandbox.run", over: Partial<ModHookInput<"tool.check">> = {}): ModHookInput<"tool.check"> => ({
  envelope,
  tool,
  callId: "c",
  input: { command: "ls" },
  verdict: { decision: "allow", reasons: [] },
  ...over,
});
const allow = async () => ({ decision: "allow" as const });

describe("TurnHookRegistry", () => {
  it("does not run a hook withdrawn after the dispatch began, and the hooks beneath answer", async () => {
    const registry = new TurnHookRegistry();
    let withdrawInner: () => void = () => {};
    let innerRan = false;
    registry.register("acme.outer", declare("tool.check"), "tool.check", undefined, async (e, next) => {
      withdrawInner();
      return next(e);
    });
    withdrawInner = registry.register("zeta.inner", declare("tool.check"), "tool.check", undefined, async () => {
      innerRan = true;
      return { decision: "deny" as const, reason: "too late" };
    });
    const outcome = await registry.dispatch("tool.check", check(), allow);
    expect(innerRan).toBe(false);
    expect(outcome).toEqual({ result: { decision: "allow" } });
  });

  it("tells no hook of a turn already cancelled, and ends a stalled hook at the cancel without counting it", async () => {
    const failures: TurnHookFailure[] = [];
    const registry = new TurnHookRegistry({ onFailure: (failure) => failures.push(failure) });
    let sawAbort = false;
    registry.register("acme.slow", declare("tool.check"), "tool.check", undefined, async (_e, next) => {
      await new Promise<void>((resolve) => next.signal.addEventListener("abort", () => resolve(), { once: true }));
      sawAbort = true;
      return { decision: "allow" as const };
    });
    const before = new AbortController();
    before.abort(new Error("cancelled first"));
    await expect(registry.dispatch("tool.check", check(), allow, before.signal)).rejects.toThrow("cancelled first");
    const during = new AbortController();
    const started = Date.now();
    setTimeout(() => during.abort(new Error("the person cancelled")), 20);
    await expect(registry.dispatch("tool.check", check(), allow, during.signal)).rejects.toThrow("the person cancelled");
    expect(Date.now() - started).toBeLessThan(1_000);
    await sleep(0);
    expect(sawAbort).toBe(true);
    expect(failures).toEqual([]);
  });

  it("charges a hook that calls next twice for its own time once", async () => {
    const failures: TurnHookFailure[] = [];
    const registry = new TurnHookRegistry({ budgetMs: 100, onFailure: (failure) => failures.push(failure) });
    registry.register("acme.twice", declare("tool.check"), "tool.check", undefined, async (e, next) => {
      await sleep(40);
      const [a] = await Promise.all([next(e), next(e)]);
      await sleep(40);
      return a;
    });
    const slowCore = async () => {
      await sleep(150);
      return { decision: "allow" as const };
    };
    expect((await registry.dispatch("tool.check", check(), slowCore)).result).toEqual({ decision: "allow" });
    expect(failures).toEqual([]);
  });

  it("passes a heartbeat provider's own hooks over in the turns it asked for, and no other plugin's", async () => {
    const registry = new TurnHookRegistry();
    const seen: string[] = [];
    for (const id of ["acme.heartbeat", "zeta.mod"]) {
      registry.register(id, declare("tool.call"), "tool.call", undefined, async (e, next) => {
        seen.push(id);
        return next(e);
      });
    }
    await registry.dispatch(
      "tool.call",
      check("sandbox.run", { envelope: { ...envelope, source: "heartbeat", heartbeatProvider: "acme.heartbeat" } }),
      async () => ({}),
    );
    expect(seen).toEqual(["zeta.mod"]);
    expect(registry.has("tool.call", { ...envelope, heartbeatProvider: "zeta.mod" })).toBe(true);
    await registry.dispatch("tool.call", check(), async () => ({}));
    expect(seen).toEqual(["zeta.mod", "acme.heartbeat", "zeta.mod"]);
  });

  it("passes an ideas provider's own hooks over in the prepared steps of its ideas", async () => {
    const registry = new TurnHookRegistry();
    const seen: string[] = [];
    for (const id of ["acme.ideas", "zeta.mod"]) {
      registry.register(id, declare("tool.call"), "tool.call", undefined, async (e, next) => {
        seen.push(id);
        return next(e);
      });
    }
    await registry.dispatch(
      "tool.call",
      check("web_search", { envelope: { ...envelope, source: "ideas", ideasProvider: "acme.ideas" } }),
      async () => ({}),
    );
    expect(seen).toEqual(["zeta.mod"]);
  });

  describe("heartbeat hook events", () => {
    const heartbeatEnvelope: ModEnvelope = { ...envelope, source: "heartbeat", attended: false };
    const item = (): ModHookInput<"heartbeat.item"> => ({
      envelope: heartbeatEnvelope,
      now: "2026-10-11T09:00:00.000Z",
      timezone: "UTC",
      key: "billing:1",
      urgency: "now",
      title: "A payment failed",
      sources: [{ label: "Billing" }],
      signalKeys: [],
    });
    const told = async () => ({});

    it("holds an item back or makes it wait, a drop beneath standing over a wait, each a decision of its own", async () => {
      const decisions: TurnHookDecision[] = [];
      const registry = new TurnHookRegistry({ onDecision: (decision) => decisions.push(decision) });
      registry.register("acme.wait", declare("heartbeat.item"), "heartbeat.item", undefined, async (e, next) => {
        const below = await next(e);
        return "drop" in below ? below : { urgency: "later" as const };
      });
      expect(await registry.dispatch("heartbeat.item", item(), told)).toEqual({ result: { urgency: "later" }, decidedBy: "acme.wait" });
      registry.register("zeta.drop", declare("heartbeat.item"), "heartbeat.item", undefined, async () => ({ drop: "Not on Sundays" }));
      expect((await registry.dispatch("heartbeat.item", item(), told)).result).toEqual({ drop: "Not on Sundays" });
      expect(decisions.map((decision) => decision.detail)).toEqual(["made it wait for the summary", "held back: Not on Sundays"]);
    });

    it("takes no promotion or rewrite, and a hook that throws leaves the item as decided", async () => {
      const failures: TurnHookFailure[] = [];
      for (const answer of [
        { urgency: "now" },
        { title: "Rewritten" },
        () => {
          throw new Error("boom");
        },
      ]) {
        const registry = new TurnHookRegistry({ onFailure: (failure) => failures.push(failure) });
        registry.register(
          "acme.bad",
          declare("heartbeat.item"),
          "heartbeat.item",
          undefined,
          async () => (typeof answer === "function" ? answer() : answer) as never,
        );
        expect((await registry.dispatch("heartbeat.item", item(), told)).result).toEqual({});
      }
      expect(failures).toHaveLength(3);
    });

    it("tells every heartbeat.tick observer, whatever it answers", async () => {
      const registry = new TurnHookRegistry();
      const seen: string[] = [];
      registry.register("acme.watch", declare("heartbeat.tick"), "heartbeat.tick", undefined, async (e) => {
        seen.push(`${e.wake}:${e.outcome}`);
        return undefined as never;
      });
      const outcome = await registry.dispatch(
        "heartbeat.tick",
        {
          envelope: heartbeatEnvelope,
          now: "2026-10-11T09:00:00.000Z",
          timezone: "UTC",
          wake: "interval",
          kind: "deep",
          outcome: "quiet",
          itemsNow: 0,
          itemsLater: 0,
        },
        async () => undefined,
      );
      expect(outcome.result).toBeUndefined();
      expect(seen).toEqual(["interval:quiet"]);
    });
  });

  it("runs hooks outermost-first in plugin id order, then registration order", async () => {
    const registry = new TurnHookRegistry();
    const seen: string[] = [];
    for (const id of ["zeta.mod", "alpha.mod"]) {
      registry.register(id, declare("tool.call"), "tool.call", undefined, async (e, next) => {
        seen.push(id);
        return next(e);
      });
    }
    await registry.dispatch("tool.call", check(), async () => ({}));
    expect(seen).toEqual(["alpha.mod", "zeta.mod"]);
  });

  it("hands every plugin's hook the chat's folder by label, as core sees it", async () => {
    const registry = new TurnHookRegistry();
    const seen = new Map<string, ModEnvelope>();
    for (const pluginId of ["acme.plugin", "tavi.guard"])
      registry.register(
        pluginId,
        declare("tool.check"),
        "tool.check",
        undefined,
        async (e, next) => (seen.set(pluginId, e.envelope), next(e)),
      );
    const folder = modFolderLabels({
      primary: "/Users/o/projects/site",
      primaryKind: "host",
      managed: "/Users/o/.tavi/chats/ws/t",
      scratch: "/Users/o/.tavi/chats/ws/t/.tmp",
      home: "/Users/o/.tavi/chats/ws/t/.home",
      attachments: [{ path: "/Users/o/docs", mode: "ro", label: "docs" }],
      revision: 3,
    });
    let coreSaw: ModEnvelope | undefined;
    await registry.dispatch(
      "tool.check",
      check("sandbox.run", { envelope: { ...envelope, folder } }),
      async (e) => ((coreSaw = e.envelope), { decision: "allow" as const }),
    );
    expect(folder).toEqual({
      view: "labels",
      primaryKind: "host",
      primaryLabel: "site",
      scratch: ".tmp",
      home: ".home",
      attachments: [{ label: "docs", mode: "ro" }],
      revision: 3,
    });
    for (const pluginId of ["acme.plugin", "tavi.guard"]) {
      expect(seen.get(pluginId)?.folder, pluginId).toEqual(folder);
      expect(JSON.stringify(seen.get(pluginId)), pluginId).not.toContain("/Users/o");
    }
    expect(coreSaw?.folder).toEqual(folder);
    expect(registry.handedTask("acme.plugin", seen.get("acme.plugin") as ModEnvelope)).toBe("t");
  });

  it("sees a hook registered after an earlier dispatch", async () => {
    const registry = new TurnHookRegistry();
    expect((await registry.dispatch("tool.check", check(), allow)).result).toEqual({ decision: "allow" });
    registry.register("acme.guard", declare("tool.check"), "tool.check", undefined, async () => ({
      decision: "ask",
      reason: "Deletes files.",
    }));
    expect((await registry.dispatch("tool.check", check(), allow)).result).toEqual({ decision: "ask", reason: "Deletes files." });
  });

  it("never lets a hook loosen the gate, even without calling next", async () => {
    const registry = new TurnHookRegistry();
    registry.register("acme.loose", declare("tool.check"), "tool.check", undefined, async () => ({ decision: "allow" }));
    const outcome = await registry.dispatch("tool.check", check(), async () => ({ decision: "ask" as const }));
    expect(outcome.result.decision).toBe("ask");
    expect(outcome.decidedBy).toBeUndefined();
  });

  it("names the plugin whose hook tightened the answer, and reports the decision", async () => {
    const decisions: TurnHookDecision[] = [];
    const registry = new TurnHookRegistry({ onDecision: (decision) => decisions.push(decision) });
    registry.register("acme.guard", declare("tool.check"), "tool.check", undefined, async (e, next) =>
      (await next(e)).decision === "allow" ? { decision: "deny", reason: "No." } : next(e),
    );
    const outcome = await registry.dispatch("tool.check", check(), allow);
    expect(outcome).toEqual({ result: { decision: "deny", reason: "No." }, decidedBy: "acme.guard" });
    expect(decisions).toEqual([
      { pluginId: "acme.guard", event: "tool.check", envelope, tool: "sandbox.run", detail: "allow → deny: No." },
    ]);
  });

  it("does not count time inside next against a hook's budget", async () => {
    const registry = new TurnHookRegistry({ budgetMs: 40 });
    registry.register("acme.slowcore", declare("tool.check"), "tool.check", undefined, async (e, next) => next(e));
    const outcome = await registry.dispatch("tool.check", check(), async () => {
      await sleep(120);
      return { decision: "allow" as const };
    });
    expect(outcome.result.decision).toBe("allow");
  });

  it.each([
    [
      "throws",
      async () => {
        throw new Error("boom");
      },
      "throw",
    ],
    [
      "runs past its budget",
      async () => {
        await sleep(120);
        return { decision: "allow" as const };
      },
      "timeout",
    ],
    ["answers a wrong shape", async () => ({ verdict: "fine" }), "shape"],
  ] as const)("asks when a tool.check hook %s", async (_name, hook, kind) => {
    const failures: TurnHookFailure[] = [];
    const registry = new TurnHookRegistry({ budgetMs: 40, onFailure: (failure) => failures.push(failure) });
    registry.register("acme.guard", declare("tool.check"), "tool.check", undefined, hook as never);
    const outcome = await registry.dispatch("tool.check", check(), allow);
    expect(outcome.result.decision).toBe("ask");
    expect(failures.map((failure) => failure.kind)).toEqual([kind]);
  });

  it("withholds a result when a tool.result hook fails, and refuses a call when a tool.call hook declared deny", async () => {
    const registry = new TurnHookRegistry();
    registry.register("acme.mask", declare("tool.result"), "tool.result", undefined, async () => {
      throw new Error("boom");
    });
    registry.register("acme.call", declare("tool.call", { onFailure: "deny" }), "tool.call", undefined, async () => {
      throw new Error("boom");
    });
    const result = await registry.dispatch("tool.result", { ...check(), output: { text: "x" }, isError: false }, async (e) => ({
      output: e.output,
    }));
    expect(result.result).toEqual({ withhold: "The result was withheld: acme.mask failed." });
    const call = await registry.dispatch("tool.call", check(), async () => ({}));
    expect(call.result).toEqual({ deny: "The call was refused: acme.call failed." });
  });

  it("skips a failing observer and still runs core", async () => {
    const registry = new TurnHookRegistry();
    registry.register("acme.watch", declare("turn.start"), "turn.start", undefined, () => {
      throw new Error("boom");
    });
    let ran = false;
    await registry.dispatch("turn.start", { envelope, kind: "start" }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("suspends a plugin after repeated failures, and its suspended guard still asks", async () => {
    const suspended: string[] = [];
    let calls = 0;
    const registry = new TurnHookRegistry({ breakerLimit: 3, onSuspended: (id) => suspended.push(id) });
    registry.register("acme.flaky", declare("tool.check"), "tool.check", undefined, async () => {
      calls += 1;
      throw new Error("boom");
    });
    for (let index = 0; index < 3; index += 1) await registry.dispatch("tool.check", check(), allow);
    expect(registry.suspended("acme.flaky")).toBe(true);
    expect(suspended).toEqual(["acme.flaky"]);
    expect((await registry.dispatch("tool.check", check(), allow)).result.decision).toBe("ask");
    expect(calls).toBe(3);
  });

  it("stops a withdrawn plugin's hooks, aborting one in flight", async () => {
    const registry = new TurnHookRegistry();
    let aborted = false;
    registry.register("acme.slow", declare("tool.call"), "tool.call", undefined, async (e, next) => {
      next.signal.addEventListener("abort", () => {
        aborted = true;
      });
      await sleep(30);
      return next(e);
    });
    const inFlight = registry.dispatch("tool.call", check(), async () => ({}));
    registry.withdraw("acme.slow");
    await inFlight;
    expect(aborted).toBe(true);
    expect(registry.has("tool.call", envelope, "sandbox.run")).toBe(false);
  });

  it("refuses a hook the manifest did not declare, or one wider than declared", () => {
    const registry = new TurnHookRegistry();
    expect(() => registry.register("acme.x", declare("tool.call"), "tool.check", undefined, allow)).toThrow(
      /did not declare a tool.check hook/,
    );
    expect(() =>
      registry.register(
        "acme.x",
        declare("tool.check", { match: { tools: ["sandbox.run"] } }),
        "tool.check",
        { tools: ["fs.write"] },
        allow,
      ),
    ).toThrow(/narrower match/);
    expect(() =>
      registry.register(
        "acme.x",
        declare("tool.check", { match: { tools: ["sandbox.run"] } }),
        "tool.check",
        { tools: ["sandbox.*"] },
        allow,
      ),
    ).toThrow(/narrower match/);
    expect(() =>
      registry.register(
        "acme.x",
        declare("tool.check", { match: { tools: ["browser.*"] } }),
        "tool.check",
        { tools: ["browser.act"] },
        allow,
      ),
    ).not.toThrow();
  });

  it("keeps the declared tools for a match that names a list as undefined", async () => {
    const registry = new TurnHookRegistry();
    let saw = 0;
    registry.register(
      "acme.x",
      declare("tool.check", { match: { tools: ["sandbox.run"] } }),
      "tool.check",
      { tools: undefined },
      async (e, next) => {
        saw += 1;
        return next(e);
      },
    );
    await registry.dispatch("tool.check", check("fs.write"), allow);
    expect(saw).toBe(0);
    await registry.dispatch("tool.check", check("sandbox.run"), allow);
    expect(saw).toBe(1);
  });

  it("admits a dispatch only where the match does: tool, alias, source and channel", () => {
    const registry = new TurnHookRegistry();
    registry.register("acme.a", declare("tool.call", { match: { tools: ["browser.act"] } }), "tool.call", undefined, async () => ({}));
    registry.register(
      "acme.b",
      declare("turn.start", { match: { sources: ["messaging"], channels: ["tg-main"] } }),
      "turn.start",
      undefined,
      () => undefined,
    );
    expect(registry.has("tool.call", envelope, "browser.act")).toBe(true);
    expect(registry.has("tool.call", envelope, "browser.batch")).toBe(false);
    expect(registry.has("tool.call", envelope, "browser.batch", ["browser.act"])).toBe(true);
    expect(registry.has("turn.start", envelope)).toBe(false);
    expect(registry.has("turn.start", { ...envelope, source: "messaging", channel: "tg-other" })).toBe(false);
    expect(registry.has("turn.start", { ...envelope, source: "messaging", channel: "tg-main" })).toBe(true);
  });

  it("matches a heartbeat tick by its source, and only a hook that names it or names no source sees it", () => {
    const registry = new TurnHookRegistry();
    registry.register("acme.beat", declare("turn.start", { match: { sources: ["heartbeat"] } }), "turn.start", undefined, () => undefined);
    registry.register("acme.cli", declare("model.step", { match: { sources: ["cli"] } }), "model.step", undefined, () => undefined);
    registry.register("acme.all", declare("turn.complete"), "turn.complete", undefined, () => undefined);
    const tick = { ...envelope, source: "heartbeat" as const, attended: false, chatKind: "run" as const };
    expect(registry.has("turn.start", tick)).toBe(true);
    expect(registry.has("turn.start", envelope)).toBe(false);
    expect(registry.has("model.step", tick)).toBe(false);
    expect(registry.has("turn.complete", tick)).toBe(true);
  });

  it("passes an error from beneath on as it came, without blaming the hooks above it", async () => {
    const failures: TurnHookFailure[] = [];
    const registry = new TurnHookRegistry({ breakerLimit: 2, onFailure: (failure) => failures.push(failure) });
    registry.register("acme.pass", declare("tool.check"), "tool.check", undefined, async (e, next) => next(e));
    for (let index = 0; index < 3; index += 1) {
      await expect(
        registry.dispatch("tool.check", check(), async () => {
          throw new Error("core broke");
        }),
      ).rejects.toThrow("core broke");
    }
    expect(failures).toEqual([]);
    expect(registry.suspended("acme.pass")).toBe(false);
  });

  it("does not count a cancelled turn, or a withdrawn plugin, as the hook's failure", async () => {
    const failures: TurnHookFailure[] = [];
    const registry = new TurnHookRegistry({ onFailure: (failure) => failures.push(failure) });
    registry.register(
      "acme.careful",
      declare("tool.check"),
      "tool.check",
      undefined,
      async (_e, next) =>
        new Promise((_resolve, reject) => {
          next.signal.addEventListener("abort", () => reject(next.signal.reason));
        }),
    );
    const cancel = new AbortController();
    const cancelled = registry.dispatch("tool.check", check(), allow, cancel.signal);
    cancel.abort(new Error("cancelled"));
    await expect(cancelled).rejects.toThrow("cancelled");
    const withdrawnDispatch = registry.dispatch("tool.check", check(), allow);
    registry.withdraw("acme.careful");
    expect((await withdrawnDispatch).result).toEqual({ decision: "allow" });
    expect(failures).toEqual([]);
  });

  it("keeps a withhold or a drop from beneath under a hook that answered for itself", async () => {
    const registry = new TurnHookRegistry();
    registry.register("acme.outer", declare("tool.result"), "tool.result", undefined, async () => ({ output: "fine" }));
    registry.register("zeta.inner", declare("tool.result"), "tool.result", undefined, async () => ({ withhold: "Not this one." }));
    registry.register("acme.outer", declare("prompt.submit"), "prompt.submit", undefined, async () => ({ context: ["note"] }));
    registry.register("zeta.inner", declare("prompt.submit"), "prompt.submit", undefined, async () => ({ drop: "Not now." }));
    expect(
      (await registry.dispatch("tool.result", { ...check(), output: "x", isError: false }, async (e) => ({ output: e.output }))).result,
    ).toEqual({ withhold: "Not this one." });
    expect((await registry.dispatch("prompt.submit", { envelope, prompt: "hi", steer: false }, async () => ({}))).result).toEqual({
      drop: "Not now.",
    });
  });

  it("keeps a deny from beneath under a tool.call hook that answered {}", async () => {
    const registry = new TurnHookRegistry();
    registry.register("acme.outer", declare("tool.call"), "tool.call", undefined, async () => ({}));
    registry.register("zeta.inner", declare("tool.call"), "tool.call", undefined, async () => ({ deny: "No shell today." }));
    expect((await registry.dispatch("tool.call", check(), async () => ({}))).result).toEqual({ deny: "No shell today." });
  });

  it("hands each hook only its own dispatch's envelope", async () => {
    const registry = new TurnHookRegistry();
    const seen: string[] = [];
    registry.register("acme.watch", declare("turn.start", { match: { sources: ["cli"] } }), "turn.start", undefined, (e) => {
      seen.push(`${e.envelope.workspaceId}/${e.envelope.principalId}`);
    });
    await registry.dispatch(
      "turn.start",
      { envelope: { ...envelope, workspaceId: "a", principalId: "pa" }, kind: "start" },
      async () => {},
    );
    await registry.dispatch(
      "turn.start",
      { envelope: { ...envelope, workspaceId: "b", principalId: "pb", source: "messaging" }, kind: "start" },
      async () => {},
    );
    expect(seen).toEqual(["a/pa"]);
  });

  it("names the hook that asks, with its reason, about a call core already asks about", async () => {
    const registry = new TurnHookRegistry();
    registry.register("acme.guard", declare("tool.check"), "tool.check", undefined, async () => ({
      decision: "ask",
      reason: "Deletes files.",
    }));
    const outcome = await registry.dispatch("tool.check", check(), async () => ({ decision: "ask" as const }));
    expect(outcome).toEqual({ result: { decision: "ask", reason: "Deletes files." }, decidedBy: "acme.guard" });
  });

  it("gives the hooks beneath, and core, the original event whatever a hook passes to next", async () => {
    const registry = new TurnHookRegistry();
    const guarded: unknown[] = [];
    // An outer formatter that normalises the command for the guard beneath: the guard still judges the real one.
    registry.register("acme.fmt", declare("tool.check"), "tool.check", undefined, async (e, next) =>
      next({ ...e, input: { command: "ls" } }),
    );
    registry.register("zeta.guard", declare("tool.check"), "tool.check", undefined, async (e, next) => {
      guarded.push(e.input);
      return /rm -rf/.test(String((e.input as { command?: unknown }).command)) ? { decision: "deny", reason: "Deletes files." } : next(e);
    });
    let cored: unknown;
    const outcome = await registry.dispatch("tool.check", check("sandbox.run", { input: { command: "rm -rf build" } }), async (e) => {
      cored = e.input;
      return { decision: "allow" as const };
    });
    expect(guarded).toEqual([{ command: "rm -rf build" }]);
    expect(outcome).toMatchObject({ result: { decision: "deny", reason: "Deletes files." }, decidedBy: "zeta.guard" });
    // Core is asked too (a deny is merged with what is beneath), with the call as it was emitted.
    expect(cored).toEqual({ command: "rm -rf build" });
    // A tool.result rewrite passed down would be lost: it fails the hook, so the result is withheld rather than shown unmasked.
    const failures: TurnHookFailure[] = [];
    const rewrites = new TurnHookRegistry({ onFailure: (failure) => failures.push(failure) });
    rewrites.register("acme.mask", declare("tool.result"), "tool.result", undefined, async (e, next) =>
      next({ ...e, output: { text: "masked" } }),
    );
    expect(
      (
        await rewrites.dispatch("tool.result", { ...check(), output: { text: "secret" }, isError: false }, async (e) => ({
          output: e.output,
        }))
      ).result,
    ).toEqual({ withhold: "The result was withheld: acme.mask failed." });
    expect(failures).toMatchObject([{ kind: "shape", message: expect.stringContaining("a change belongs in its answer") }]);
  });

  it("gives every hook its failure rule for an event that cannot be copied, and still asks core", async () => {
    const failures: TurnHookFailure[] = [];
    const registry = new TurnHookRegistry({ onFailure: (failure) => failures.push(failure) });
    let ran = false;
    registry.register("acme.mask", declare("tool.result"), "tool.result", undefined, async (e, next) => {
      ran = true;
      return next(e);
    });
    const outcome = await registry.dispatch("tool.result", { ...check(), output: { size: 10n }, isError: false }, async (e) => ({
      output: e.output,
    }));
    expect(ran).toBe(false);
    expect(outcome).toMatchObject({
      result: { withhold: expect.stringContaining("acme.mask could not be shown the event") },
      decidedBy: "acme.mask",
    });
    expect(failures.map((failure) => failure.kind)).toEqual(["shape"]);
  });

  it("hands every hook a frozen copy: writing to it fails the hook and changes nothing", async () => {
    const failures: TurnHookFailure[] = [];
    const registry = new TurnHookRegistry({ onFailure: (failure) => failures.push(failure) });
    registry.register("acme.sneak", declare("tool.check"), "tool.check", undefined, async (e, next) => {
      (e.input as { command: string }).command = "rm -rf /";
      return next(e);
    });
    const input = { command: "ls" };
    const outcome = await registry.dispatch("tool.check", check("sandbox.run", { input }), allow);
    expect(input).toEqual({ command: "ls" });
    // It fails closed, as a hook that throws does.
    expect(outcome.result).toMatchObject({ decision: "ask" });
    expect(failures.map((failure) => failure.kind)).toEqual(["throw"]);
  });

  it("composes tool.result rewrites outermost last, each checked against the original's shape", async () => {
    const registry = new TurnHookRegistry();
    registry.register("acme.outer", declare("tool.result"), "tool.result", undefined, async (e, next) => {
      const inner = await next(e);
      return "output" in inner ? { output: { text: `${(inner.output as { text: string }).text}!` } } : inner;
    });
    registry.register("zeta.inner", declare("tool.result"), "tool.result", undefined, async () => ({ output: { text: "masked" } }));
    const outcome = await registry.dispatch("tool.result", { ...check(), output: { text: "secret" }, isError: false }, async (e) => ({
      output: e.output,
    }));
    expect(outcome).toEqual({ result: { output: { text: "masked!" } }, decidedBy: "acme.outer" });
  });

  it("withholds, and counts as the hook's failure, a replacement that changes the output's shape", async () => {
    const failures: TurnHookFailure[] = [];
    const registry = new TurnHookRegistry({ onFailure: (failure) => failures.push(failure) });
    registry.register("acme.mask", declare("tool.result"), "tool.result", undefined, async () => ({ output: { text: 1 } }));
    const outcome = await registry.dispatch("tool.result", { ...check(), output: { text: "x" }, isError: false }, async (e) => ({
      output: e.output,
    }));
    expect(outcome.result).toEqual({ withhold: "The result was withheld: acme.mask failed." });
    expect(failures.map((failure) => failure.kind)).toEqual(["shape"]);
  });

  it("remembers the task an envelope named when handed, and lets no hook rewrite the envelope for those beneath", async () => {
    const registry = new TurnHookRegistry();
    const seen: string[] = [];
    registry.register("acme.outer", declare("tool.call"), "tool.call", undefined, async (e, next) =>
      next({ ...e, envelope: { ...e.envelope, taskId: "other" } }),
    );
    registry.register("zeta.inner", declare("tool.call"), "tool.call", undefined, async (e, next) => {
      seen.push(e.envelope.taskId);
      return next(e);
    });
    const input = check();
    await registry.dispatch("tool.call", input, async () => ({}));
    expect(seen).toEqual(["t"]);
    expect(registry.handedTask("zeta.inner", input.envelope)).toBe("t");
    expect(registry.handedTask("zeta.inner", { ...input.envelope })).toBeUndefined();
  });

  it("marks a block trusted only when its own hook's declaration says contextTrusted", async () => {
    const registry = new TurnHookRegistry();
    // A trusted outer hook that answers an untrusted inner block first cannot vouch for it: the blocks beneath stay in place.
    registry.register("acme.outer", declare("prompt.submit", { contextTrusted: true }), "prompt.submit", undefined, async (e, next) => {
      const below = await next(e);
      return "context" in below ? { context: ["outer block", ...(below.context ?? [])] } : below;
    });
    registry.register("zeta.inner", declare("prompt.submit"), "prompt.submit", undefined, async () => ({ context: ["inner block"] }));
    const outcome = await registry.dispatch("prompt.submit", { envelope, prompt: "hi", steer: false }, async () => ({}));
    expect(outcome.contextBy).toEqual([
      { pluginId: "zeta.inner", text: "inner block" },
      { pluginId: "acme.outer", text: "outer block", trusted: true },
    ]);
  });

  it("names the plugin that added each context block, and says a failed prompt hook dropped the prompt", async () => {
    const registry = new TurnHookRegistry();
    registry.register("acme.outer", declare("prompt.submit"), "prompt.submit", undefined, async (e, next) => {
      const below = await next(e);
      return "context" in below ? { context: [...(below.context ?? []), "outer block"] } : below;
    });
    registry.register("zeta.inner", declare("prompt.submit"), "prompt.submit", undefined, async () => ({ context: ["inner block"] }));
    const outcome = await registry.dispatch("prompt.submit", { envelope, prompt: "hi", steer: false }, async () => ({}));
    expect(outcome.contextBy).toEqual([
      { pluginId: "zeta.inner", text: "inner block" },
      { pluginId: "acme.outer", text: "outer block" },
    ]);
    const failing = new TurnHookRegistry();
    failing.register("acme.gate", declare("prompt.submit", { onFailure: "drop" }), "prompt.submit", undefined, async () => {
      throw new Error("boom");
    });
    expect((await failing.dispatch("prompt.submit", { envelope, prompt: "hi", steer: false }, async () => ({}))).result).toEqual({
      drop: "its prompt hook failed",
    });
  });

  it("runs a declared command, names it by its plugin when another keeps the name, and says when it failed", async () => {
    const registry = new TurnHookRegistry({ budgetMs: 40, reservedCommands: new Set(["help"]) });
    const declared = [
      { name: "tally", description: "Counts calls." },
      { name: "help", description: "Mine." },
      { name: "slow", description: "Slow." },
    ];
    expect(() => registry.registerCommand("acme.x", declared, "other", () => ({ text: "" }))).toThrow(/did not declare a \/other command/);
    registry.registerCommand("acme.x", declared, "tally", ({ args }) => ({ text: `counted ${args}` }));
    registry.registerCommand("acme.x", declared, "help", () => ({ text: "mine" }));
    registry.registerCommand("zeta.y", [{ name: "tally", description: "Also counts." }], "tally", () => ({ text: "zeta" }));
    registry.registerCommand("acme.x", declared, "slow", async () => {
      await sleep(120);
      return { text: "late" };
    });
    expect(registry.commands().map((command) => command.name)).toEqual(["acme.x:tally", "acme.x:help", "slow", "zeta.y:tally"]);
    expect(await registry.runCommand("acme.x:tally", { envelope, args: "3" })).toEqual({ text: "counted 3" });
    expect(await registry.runCommand("tally", { envelope, args: "" })).toBeUndefined();
    expect(await registry.runCommand("slow", { envelope, args: "" })).toEqual({ text: "/slow from acme.x failed: it ran out of time." });
    registry.withdraw("zeta.y");
    expect(await registry.runCommand("tally", { envelope, args: "now" })).toEqual({ text: "counted now" });
  });

  it("keeps a built-in's command under its own name when a plugin declares the same one", async () => {
    const registry = new TurnHookRegistry({ builtinPlugin: (pluginId) => pluginId === "tavi.heartbeat" });
    registry.registerCommand("acme.x", [{ name: "heartbeat", description: "Theirs." }], "heartbeat", () => ({ text: "theirs" }));
    registry.registerCommand("tavi.heartbeat", [{ name: "heartbeat", description: "Ours." }], "heartbeat", () => ({ text: "ours" }));
    expect(registry.commands().map((command) => command.name)).toEqual(["acme.x:heartbeat", "heartbeat"]);
    expect(await registry.runCommand("heartbeat", { envelope, args: "" })).toEqual({ text: "ours" });
  });

  it("stops a command at its deadline or its plugin's withdrawal, and drops a withdrawn command's late answer", async () => {
    const registry = new TurnHookRegistry({ budgetMs: 40 });
    const declared = [
      { name: "slow", description: "Slow." },
      { name: "wait", description: "Waits." },
    ];
    const stopped: string[] = [];
    registry.registerCommand("acme.x", declared, "slow", async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      stopped.push(String((signal.reason as Error).message));
      return { text: "late" };
    });
    expect(await registry.runCommand("slow", { envelope, args: "" })).toEqual({ text: "/slow from acme.x failed: it ran out of time." });
    expect(stopped).toEqual(["ran past its 40 ms budget"]);
    let finish: (value: { text: string }) => void = () => {};
    registry.registerCommand(
      "acme.x",
      declared,
      "wait",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = registry.runCommand("wait", { envelope, args: "" });
    registry.withdraw("acme.x");
    finish({ text: "too late" });
    expect(await running).toEqual({ text: "/wait: acme.x is no longer running." });
  });

  it("suspends a plugin's commands after repeated failures, never its hooks, and limits one person's rate", async () => {
    const registry = new TurnHookRegistry({ breakerLimit: 3 });
    registry.registerCommand("acme.x", [{ name: "boom", description: "Fails." }], "boom", () => {
      throw new Error("no");
    });
    registry.register("acme.x", declare("tool.check"), "tool.check", undefined, async () => ({
      decision: "deny" as const,
      reason: "guarded",
    }));
    for (let attempt = 0; attempt < 3; attempt += 1) await registry.runCommand("boom", { envelope, args: "" });
    expect(await registry.runCommand("boom", { envelope, args: "" })).toEqual({
      text: "/boom from acme.x is off: it failed too often and is suspended until the owner restarts.",
    });
    expect(registry.suspended("acme.x")).toBe(false);
    expect((await registry.dispatch("tool.check", check(), allow)).result).toEqual({ decision: "deny", reason: "guarded" });
    // Five at once from one person: the fifth is refused, and is no failure.
    const rated = new TurnHookRegistry();
    rated.registerCommand("acme.y", [{ name: "ok", description: "Fine." }], "ok", () => ({ text: "ok" }));
    const answers = await Promise.all(Array.from({ length: 5 }, () => rated.runCommand("ok", { envelope, args: "" })));
    expect(answers.map((answer) => answer?.text)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "Too many commands at once: try /ok again in a moment.",
    ]);
  });

  it("counts a hook's own ask as its decision even without a reason, and keeps the reason on a tie", async () => {
    const bare = new TurnHookRegistry();
    bare.register("acme.guard", declare("tool.check"), "tool.check", undefined, async () => ({ decision: "ask" as const }));
    expect(await bare.dispatch("tool.check", check(), async () => ({ decision: "ask" as const }))).toEqual({
      result: { decision: "ask" },
      decidedBy: "acme.guard",
    });
    // Passing core's ask through is no decision of the hook's.
    const passing = new TurnHookRegistry();
    passing.register("acme.watch", declare("tool.check"), "tool.check", undefined, async (e, next) => next(e));
    expect(await passing.dispatch("tool.check", check(), async () => ({ decision: "ask" as const }))).toEqual({
      result: { decision: "ask" },
    });
    const tie = new TurnHookRegistry();
    tie.register("acme.outer", declare("tool.check"), "tool.check", undefined, async () => ({ decision: "ask" as const }));
    tie.register("zeta.inner", declare("tool.check"), "tool.check", undefined, async () => ({
      decision: "ask" as const,
      reason: "Deletes files.",
    }));
    expect((await tie.dispatch("tool.check", check(), allow)).result).toEqual({ decision: "ask", reason: "Deletes files." });
  });

  it("withholds a result while its plugin is suspended", async () => {
    const registry = new TurnHookRegistry({ breakerLimit: 1 });
    registry.register("acme.mask", declare("tool.result"), "tool.result", undefined, async () => {
      throw new Error("broken");
    });
    const result = { ...check(), output: { text: "x" }, isError: false };
    await registry.dispatch("tool.result", result, async (e) => ({ output: e.output }));
    expect(registry.suspended("acme.mask")).toBe(true);
    expect((await registry.dispatch("tool.result", result, async (e) => ({ output: e.output }))).result).toEqual({
      withhold: "The result was withheld: acme.mask its hooks are suspended after repeated failures.",
    });
  });
});

describe("TurnHookRegistry, matches and composition", () => {
  const unchanged = async (e: ModHookInput<"tool.result">) => ({ output: e.output });
  const result = (text = "see internal.host"): ModHookInput<"tool.result"> =>
    ({ ...check("fs.read"), output: { text }, isError: false }) as unknown as ModHookInput<"tool.result">;

  it("keeps the match it checked, whatever the plugin does to its object later", async () => {
    const registry = new TurnHookRegistry();
    const match = { tools: ["fs.read"] };
    registry.register("acme.x", declare("tool.result", { match: { tools: ["fs.read"] } }), "tool.result", match, async (e, next) =>
      next(e),
    );
    match.tools.push("*");
    expect(registry.has("tool.result", envelope, "secrets.vault")).toBe(false);
    expect(registry.has("tool.result", envelope, "fs.read")).toBe(true);
  });

  it("refuses a match that is no match at registration, rather than at every dispatch", () => {
    const registry = new TurnHookRegistry();
    expect(() => registry.register("acme.x", declare("tool.check"), "tool.check", { tools: "sandbox.run" } as never, allow)).toThrow(
      /match is not one/,
    );
    expect(() => registry.has("tool.check", envelope, "sandbox.run")).not.toThrow();
  });

  it("registers at most as many hooks as a manifest may declare", () => {
    const registry = new TurnHookRegistry();
    for (let index = 0; index < 16; index += 1) registry.register("acme.x", declare("tool.check"), "tool.check", undefined, allow);
    expect(() => registry.register("acme.x", declare("tool.check"), "tool.check", undefined, allow)).toThrow(/more than 16 hooks/);
  });

  it("keeps a replacement the plugin cannot change after it answered", async () => {
    const registry = new TurnHookRegistry();
    const kept = { text: "fine" };
    registry.register("acme.x", declare("tool.result"), "tool.result", undefined, async () => ({ output: kept }));
    const outcome = await registry.dispatch("tool.result", result(), unchanged);
    kept.text = "changed later";
    expect(outcome.result).toEqual({ output: { text: "fine" } });
  });

  it("composes rewrites: an outer hook building from e keeps the inner one's masking, and context blocks add up", async () => {
    const registry = new TurnHookRegistry();
    registry.register("a.outer", declare("tool.result"), "tool.result", undefined, async (e, next) => {
      await next(e);
      return { output: { text: (e.output as { text: string }).text } };
    });
    registry.register("z.mask", declare("tool.result"), "tool.result", undefined, async () => ({ output: { text: "see [host]" } }));
    expect((await registry.dispatch("tool.result", result(), unchanged)).result).toEqual({ output: { text: "see [host]" } });
    registry.register("a.outer", declare("prompt.submit"), "prompt.submit", undefined, async () => ({ context: ["outer"] }));
    registry.register("z.inner", declare("prompt.submit"), "prompt.submit", undefined, async () => ({ context: ["inner"] }));
    const submitted = await registry.dispatch("prompt.submit", { envelope, prompt: "hi", steer: false }, async () => ({}));
    expect(submitted.result).toEqual({ context: ["inner", "outer"] });
    expect(submitted.contextBy).toEqual([
      { pluginId: "z.inner", text: "inner" },
      { pluginId: "a.outer", text: "outer" },
    ]);
  });

  it("tells every turn.complete hook the turn ended, even beneath one that does not call next", async () => {
    const registry = new TurnHookRegistry();
    let innerRan = false;
    registry.register("a.p", declare("turn.complete"), "turn.complete", undefined, async () => ({ suggestions: ["again"] }));
    registry.register("z.p", declare("turn.complete"), "turn.complete", undefined, async () => {
      innerRan = true;
      return { suggestions: ["inner"] };
    });
    const outcome = await registry.dispatch("turn.complete", { envelope, outcome: "completed", usage: {}, toolCalls: 0 }, async () => ({}));
    expect(innerRan).toBe(true);
    expect(outcome.result).toEqual({ suggestions: ["again"] });
  });

  it("drops a withdrawn hook's late answer, and does not wait for one that never answers", async () => {
    const registry = new TurnHookRegistry({ budgetMs: 2_000 });
    let withdraw: () => void = () => {};
    withdraw = registry.register("acme.late", declare("tool.result"), "tool.result", undefined, async () => {
      setTimeout(() => withdraw(), 5);
      await sleep(30);
      return { output: { text: "rewritten by a withdrawn plugin" } };
    });
    expect((await registry.dispatch("tool.result", result(), unchanged)).result).toEqual({ output: { text: "see internal.host" } });
    let withdrawStuck: () => void = () => {};
    withdrawStuck = registry.register("acme.stuck", declare("tool.check"), "tool.check", undefined, async () => {
      setTimeout(() => withdrawStuck(), 5);
      return new Promise<never>(() => {});
    });
    const started = Date.now();
    expect((await registry.dispatch("tool.check", check(), allow)).result).toEqual({ decision: "allow" });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("credits a tie to the plugin whose words stand", async () => {
    const registry = new TurnHookRegistry();
    registry.register("a.outer", declare("tool.check"), "tool.check", undefined, async () => ({
      decision: "deny" as const,
      reason: "outer's reason",
    }));
    registry.register("z.inner", declare("tool.check"), "tool.check", undefined, async () => ({
      decision: "deny" as const,
      reason: "inner's reason",
    }));
    expect(await registry.dispatch("tool.check", check(), allow)).toEqual({
      result: { decision: "deny", reason: "inner's reason" },
      decidedBy: "z.inner",
    });
  });

  it("takes next() with no argument as the original event, and refuses an output named undefined", async () => {
    const failures: TurnHookFailure[] = [];
    const registry = new TurnHookRegistry({ onFailure: (failure) => failures.push(failure) });
    registry.register("acme.x", declare("tool.result"), "tool.result", undefined, async (_e, next) => next());
    expect((await registry.dispatch("tool.result", result(), unchanged)).result).toEqual({ output: { text: "see internal.host" } });
    expect(failures).toEqual([]);
    const other = new TurnHookRegistry({ onFailure: (failure) => failures.push(failure) });
    other.register("acme.y", declare("tool.result"), "tool.result", undefined, async () => ({ output: undefined }));
    expect((await other.dispatch("tool.result", result(), unchanged)).result).toMatchObject({ withhold: expect.any(String) });
    expect(failures).toHaveLength(1);
  });

  it("binds a hook to the declaration it names exactly", () => {
    const registry = new TurnHookRegistry();
    const declared = [
      { event: "tool.check", match: { tools: ["sandbox.run"] }, onFailure: "deny", disclosure: "narrow" },
      { event: "tool.check", disclosure: "wide" },
    ] as ModHookDeclaration[];
    registry.register("acme.x", declared, "tool.check", undefined, allow);
    expect(registry.has("tool.check", envelope, "fs.read")).toBe(true);
    // An empty match, or one naming a list as undefined, is no match too.
    for (const empty of [{}, { tools: undefined }]) {
      const other = new TurnHookRegistry();
      other.register("acme.x", declared, "tool.check", empty, allow);
      expect(other.has("tool.check", envelope, "fs.read")).toBe(true);
    }
    // Key order does not change which declaration it names.
    const ordered = new TurnHookRegistry();
    const both = [
      { event: "tool.check", match: { sources: ["cli"], tools: ["sandbox.run"] }, onFailure: "deny", disclosure: "first" },
      { event: "tool.check", match: { tools: ["sandbox.run"], sources: ["cli"] }, disclosure: "second" },
    ] as ModHookDeclaration[];
    ordered.register("acme.x", both.slice(1).concat(both.slice(0, 1)), "tool.check", { sources: ["cli"], tools: ["sandbox.run"] }, allow);
    expect(ordered.has("tool.check", envelope, "sandbox.run")).toBe(true);
  });
});

describe("TurnHookRegistry, answers and credit", () => {
  const result = (text = "connect db.internal.corp", over: Partial<ModHookInput<"tool.result">> = {}): ModHookInput<"tool.result"> =>
    ({ ...check("fs.read"), output: { text }, isError: false, ...over }) as unknown as ModHookInput<"tool.result">;
  const unchanged = async (e: ModHookInput<"tool.result">) => ({ output: e.output });
  const call = (): ModHookInput<"tool.call"> =>
    ({ envelope, tool: "fs.write", callId: "c", input: {} }) as unknown as ModHookInput<"tool.call">;

  it("audits and names a tool.call deny answered without next", async () => {
    const decisions: TurnHookDecision[] = [];
    const registry = new TurnHookRegistry({ onDecision: (decision) => decisions.push(decision) });
    registry.register("acme.deny", declare("tool.call"), "tool.call", undefined, async () => ({ deny: "no" }));
    expect(await registry.dispatch("tool.call", call(), async () => ({}))).toEqual({ result: { deny: "no" }, decidedBy: "acme.deny" });
    expect(decisions.map((decision) => decision.pluginId)).toEqual(["acme.deny"]);
  });

  it("takes an observer or a filter answering nothing as no answer, not a failure", async () => {
    const failures: TurnHookFailure[] = [];
    const registry = new TurnHookRegistry({ onFailure: (failure) => failures.push(failure) });
    registry.register("acme.quiet", declare("turn.complete"), "turn.complete", undefined, async () => undefined);
    registry.register("acme.quiet", declare("tool.call"), "tool.call", undefined, async () => undefined);
    registry.register("acme.quiet", declare("prompt.submit"), "prompt.submit", undefined, async () => undefined);
    for (let index = 0; index < 6; index += 1) {
      await registry.dispatch("turn.complete", { envelope, outcome: "completed", usage: {}, toolCalls: 0 }, async () => ({}));
      await registry.dispatch("tool.call", call(), async () => ({}));
      await registry.dispatch("prompt.submit", { envelope, prompt: "hi", steer: false }, async () => ({}));
    }
    expect(failures).toEqual([]);
    expect(registry.suspended("acme.quiet")).toBe(false);
  });

  it("names the declaration a match gives in another order", async () => {
    const registry = new TurnHookRegistry();
    const declared = [
      { event: "tool.check", disclosure: "any" },
      { event: "tool.check", match: { tools: ["fs.read", "fs.grep"] }, onFailure: "deny", disclosure: "reads" },
    ] as ModHookDeclaration[];
    registry.register("acme.x", declared, "tool.check", { tools: ["fs.grep", "fs.read"] }, async () => {
      throw new Error("broke");
    });
    expect((await registry.dispatch("tool.check", check("fs.read"), allow)).result.decision).toBe("deny");
  });

  it("audits no change the workflow does not keep", async () => {
    const decisions: TurnHookDecision[] = [];
    const registry = new TurnHookRegistry({ onDecision: (decision) => decisions.push(decision) });
    registry.register("acme.note", declare("tool.check"), "tool.check", undefined, async () => ({
      decision: "allow" as const,
      reason: "fine",
    }));
    registry.register("acme.note", declare("tool.result"), "tool.result", undefined, async () => ({ output: { text: "rewritten" } }));
    expect((await registry.dispatch("tool.check", check(), allow)).decidedBy).toBeUndefined();
    const sensitive = await registry.dispatch("tool.result", result("x", { sensitive: true }), unchanged);
    expect(sensitive.decidedBy).toBeUndefined();
    const truncated = await registry.dispatch("tool.result", result("x", { truncated: true }), unchanged);
    expect(truncated.decidedBy).toBeUndefined();
    expect(decisions).toEqual([]);
  });

  it("credits an outer deny's reason over an inner deny without one to the outer plugin", async () => {
    const registry = new TurnHookRegistry();
    registry.register("acme.outer", declare("tool.check"), "tool.check", undefined, async () => ({
      decision: "deny" as const,
      reason: "outer says no",
    }));
    registry.register("zeta.inner", declare("tool.check"), "tool.check", undefined, async () => ({ decision: "deny" as const }));
    expect(await registry.dispatch("tool.check", check(), allow)).toEqual({
      result: { decision: "deny", reason: "outer says no" },
      decidedBy: "acme.outer",
    });
  });

  it("registers a command once per plugin", () => {
    const registry = new TurnHookRegistry();
    const declared = [{ name: "x", description: "X." }];
    registry.registerCommand("acme.c", declared, "x", async () => ({ text: "ok" }));
    expect(() => registry.registerCommand("acme.c", declared, "x", async () => ({ text: "ok" }))).toThrow(/twice/);
    expect(registry.commands().map((command) => command.name)).toEqual(["x"]);
  });

  it("keeps an inner rewrite an outer hook that never saw it would undo, and an outer one built on it", async () => {
    const blind = new TurnHookRegistry();
    blind.register("acme.format", declare("tool.result"), "tool.result", undefined, async (e) => ({
      output: { text: (e.output as { text: string }).text.trim() },
    }));
    blind.register("zeta.mask", declare("tool.result"), "tool.result", undefined, async () => ({ output: { text: "connect [host]" } }));
    expect((await blind.dispatch("tool.result", result("connect db.internal.corp "), unchanged)).result).toEqual({
      output: { text: "connect [host]" },
    });
    const building = new TurnHookRegistry();
    building.register("acme.format", declare("tool.result"), "tool.result", undefined, async (e, next) => {
      const inner = await next(e);
      return "output" in inner ? { output: { text: `${(inner.output as { text: string }).text}.` } } : inner;
    });
    building.register("zeta.mask", declare("tool.result"), "tool.result", undefined, async () => ({ output: { text: "connect [host]" } }));
    expect((await building.dispatch("tool.result", result(), unchanged)).result).toEqual({ output: { text: "connect [host]." } });
  });
});
