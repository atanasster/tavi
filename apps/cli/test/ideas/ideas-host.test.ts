import {
  IDEA_DEFAULT_SETTINGS,
  IdeasProviderError,
  type IdeaDraft,
  type IdeasGenerateRequest,
  type IdeasProvider,
  type IdeaSettings,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { createBuiltinIdeasProvider } from "@tavi/plugin-defaults/ideas";
import {
  IdeasHost,
  IdeasProviderRegistry,
  digestPicked,
  ideaOfDigestReply,
  nextIdeasVolume,
  offeredIdeas,
  preparable,
  runIdeas,
  sendIdeasDigest,
  type IdeasHostDependencies,
} from "@tavi/agent-host/ideas-host";
import { describe, expect, it } from "vitest";

import { SqliteStore } from "../support/database-fixture.js";
import { delay } from "@tavi/test-support";

/** The ideas host: any provider, the same rules — gates, receives, validation, the ledger. */

const NOW = new Date("2026-10-19T10:00:00.000Z");

const idea = (key: string, overrides: Partial<IdeaDraft> = {}): IdeaDraft => ({
  key,
  category: (key.split(".")[0] ?? "travel") as IdeaDraft["category"],
  icon: "💡",
  title: `I can do ${key}`,
  pitch: "A pitch.",
  label: key,
  prompt: `Do ${key}.`,
  basis: [{ kind: "general", ref: "general" }],
  uses: [{ capability: "web", approval: false }],
  ...overrides,
});

async function fixture(
  options: {
    readonly settings?: Partial<IdeaSettings>;
    readonly brief?: string;
    readonly now?: () => Date;
    readonly turn?: IdeasHostDependencies["turn"];
    readonly workspaces?: readonly string[];
    readonly prepare?: IdeasHostDependencies["prepare"];
  } = {},
) {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  const repositories = store.asPort().repositories;
  if (options.settings !== undefined || options.brief !== undefined) {
    await repositories.ideas.saveSettings({
      workspaceId: "default",
      settings: { ...IDEA_DEFAULT_SETTINGS, ...options.settings },
      ...(options.brief === undefined ? {} : { brief: options.brief }),
      now: NOW.toISOString(),
    });
  }
  const providers = new IdeasProviderRegistry();
  let ids = 0;
  const seen: IdeasGenerateRequest[] = [];
  const deps: IdeasHostDependencies = {
    repositories,
    providers,
    census: async () => ["web", "memory", "reminders", "travel", "mailbox"],
    memory: async () => [
      { recordId: "mem-1", revisionId: "rev-1", kind: "fact", text: "Planning a trip to Lisbon in May; wants cheap flights" },
    ],
    tasks: async () => [{ taskId: "task-1", title: "Garden plan for the balcony" }],
    timezone: async () => "Europe/Sofia",
    now: options.now ?? (() => NOW),
    newId: () => `n${(ids += 1)}`,
    ...(options.turn === undefined ? {} : { turn: options.turn }),
    ...(options.prepare === undefined ? {} : { prepare: options.prepare }),
    ...(options.workspaces === undefined ? {} : { workspaces: async () => options.workspaces ?? [] }),
  };
  /** A plugin provider that answers `ideas` and records what it was given. */
  const plugin = (
    answer: (request: IdeasGenerateRequest) => Promise<unknown>,
    receives: IdeasHostDependencies extends never ? never : readonly ("memory" | "tasks" | "brief" | "ledger")[] = [
      "memory",
      "tasks",
      "brief",
      "ledger",
    ],
    maxRunSeconds = 30,
    usesTurns = false,
  ): IdeasProvider => {
    const provider: IdeasProvider = {
      generate: async (request) => (seen.push(request), (await answer(request)) as Awaited<ReturnType<IdeasProvider["generate"]>>),
    };
    providers.install("acme.ideas", { provider, kind: "plugin", receives, maxRunSeconds, usesTurns });
    return provider;
  };
  return { repositories, providers, deps, seen, plugin };
}

describe("the ideas host", () => {
  it("runs the built-in provider: ideas stored with their provider, the run recorded", async () => {
    const { repositories, providers, deps } = await fixture();
    providers.install("tavi.ideasagent", {
      provider: createBuiltinIdeasProvider(),
      kind: "builtin",
      receives: ["memory", "tasks", "brief", "ledger"],
      maxRunSeconds: 30,
    });
    const run = await runIdeas(deps, "default", "refresh");
    expect(run).toMatchObject({ outcome: "generated", providerId: "tavi.ideasagent", trigger: "refresh" });
    const listed = await repositories.ideas.list({ workspaceId: "default", now: NOW.toISOString() });
    expect(listed.length).toBe(run.generated);
    expect(listed[0]).toMatchObject({ key: "travel.fare-watch", providerId: "tavi.ideasagent", basis: [{ kind: "memory", ref: "mem-1" }] });
    for (const stored of listed)
      for (const use of stored.uses) expect(["web", "memory", "reminders", "travel", "mailbox"]).toContain(use.capability);
  });

  it("validates what a plugin proposes: drops what breaks the contract, rewrites excerpts, sets approvals", async () => {
    const { repositories, deps, plugin } = await fixture({ brief: "Nothing about money." });
    plugin(async () => ({
      ideas: [
        {
          idea: idea("travel.ok", {
            basis: [{ kind: "memory", ref: "mem-1", excerpt: "the provider's own words" }],
            uses: [{ capability: "mailbox", approval: false }],
          }),
          score: 0.9,
        },
        { idea: idea("travel.brief", { basis: [{ kind: "brief", ref: "brief" }] }), score: 0.8 },
        { idea: idea("travel.unknown-tool", { uses: [{ capability: "messaging", approval: true }] }), score: 0.7 },
        { idea: idea("travel.invented", { basis: [{ kind: "memory", ref: "mem-404" }] }), score: 0.7 },
        { idea: idea("travel.wrong-section", { category: "shopping" }), score: 0.7 },
        { idea: idea("travel.ok", { title: "again" }), score: 0.6 },
        { idea: idea("travel.nan"), score: Number.NaN },
        "not an idea",
      ],
    }));
    await repositories.ideas.saveSettings({
      workspaceId: "default",
      settings: { ...IDEA_DEFAULT_SETTINGS, provider: "acme.ideas" },
      now: NOW.toISOString(),
    });
    const logged: unknown[] = [];
    const run = await runIdeas({ ...deps, log: (_message, fields) => logged.push(fields["reason"]) }, "default", "refresh");
    expect(run).toMatchObject({ outcome: "generated", generated: 2, dropped: 6 });
    // The rules the first few broke are said on the run and in the log, each once.
    expect(run.reason).toBe(
      "Left out: idea 3 (travel.unknown-tool): it uses messaging, which this workspace does not have; " +
        "idea 4 (travel.invented): it cites a basis the provider was not given; idea 5: key: an idea's key starts with its section, shopping.",
    );
    expect(logged).toHaveLength(3);
    const byKey = new Map(
      (await repositories.ideas.list({ workspaceId: "default", now: NOW.toISOString() })).map((stored) => [stored.key, stored]),
    );
    expect(byKey.get("travel.ok")).toMatchObject({
      providerId: "acme.ideas",
      basis: [{ kind: "memory", ref: "mem-1", excerpt: "Planning a trip to Lisbon in May; wants cheap flights" }],
      uses: [{ capability: "mailbox", approval: true }],
    });
    expect(byKey.get("travel.brief")?.basis).toEqual([{ kind: "brief", ref: "brief", excerpt: "Nothing about money." }]);
  });

  it("gives a provider only what its manifest asks for and the person allows", async () => {
    const { repositories, deps, seen, plugin } = await fixture({ settings: { provider: "acme.ideas" }, brief: "More garden." });
    plugin(async () => ({ ideas: [] }), ["ledger"]);
    await runIdeas(deps, "default", "refresh");
    expect(seen[0]).toMatchObject({
      workspaceId: "default",
      timezone: "Europe/Sofia",
      capabilities: ["web", "memory", "reminders", "travel", "mailbox"],
    });
    expect(seen[0]?.memory).toBeUndefined();
    expect(seen[0]?.tasks).toBeUndefined();
    expect(seen[0]?.brief).toBeUndefined();
    expect(seen[0]?.ledger).toMatchObject({ dismissedKeys: [], active: [] });
    // Everything asked for, but the person switched memory off: still none.
    plugin(async () => ({ ideas: [] }));
    await repositories.ideas.saveSettings({
      workspaceId: "default",
      settings: { ...IDEA_DEFAULT_SETTINGS, provider: "acme.ideas", sources: { memory: false, tasks: true, brief: true } },
      now: NOW.toISOString(),
    });
    await runIdeas(deps, "default", "refresh");
    expect(seen[1]?.memory).toBeUndefined();
    expect(seen[1]?.tasks).toEqual([{ taskId: "task-1", title: "Garden plan for the balcony" }]);
    expect(seen[1]?.brief).toBe("More garden.");
    expect(Object.isFrozen(seen[1])).toBe(true);
    // The prompts the person edited are their own words: a provider without chats does not see them.
    await repositories.ideas.saveSettings({
      workspaceId: "default",
      settings: { ...IDEA_DEFAULT_SETTINGS, provider: "acme.ideas", sources: { memory: true, tasks: false, brief: true } },
      now: NOW.toISOString(),
    });
    await repositories.ideas.startRun({ runId: "seed", workspaceId: "default", trigger: "schedule", now: NOW.toISOString() });
    await repositories.ideas.store({
      workspaceId: "default",
      runId: "seed",
      providerId: "acme.ideas",
      now: NOW.toISOString(),
      ideas: [{ id: "i-e", score: 0.5, draft: idea("travel.e") }],
    });
    await repositories.ideas.finishRun({ runId: "seed", outcome: "generated", now: NOW.toISOString() });
    await repositories.ideas.feedback({
      id: "f-e",
      workspaceId: "default",
      signal: "edited",
      ideaId: "i-e",
      editedPrompt: "My own words",
      now: NOW.toISOString(),
    });
    await runIdeas(deps, "default", "refresh");
    expect(seen[2]?.ledger?.examples).toEqual([]);
  });

  it("tells a provider the workspace's language only when it is not English", async () => {
    const { deps, seen, plugin } = await fixture({ settings: { provider: "acme.ideas" } });
    plugin(async () => ({ ideas: [] }));
    await runIdeas(deps, "default", "refresh");
    await runIdeas({ ...deps, locale: async () => "en" }, "default", "refresh");
    await runIdeas({ ...deps, locale: async () => "bg" }, "default", "refresh");
    expect(seen[0]?.locale).toBeUndefined();
    expect(seen[1]?.locale).toBeUndefined();
    expect(seen[2]?.locale).toBe("bg");
  });

  it("skips while off or while its provider is missing, and says why", async () => {
    const off = await fixture({ settings: { enabled: false } });
    expect(await runIdeas(off.deps, "default", "refresh")).toMatchObject({ outcome: "skipped", reason: "Ideas are off" });
    const missing = await fixture({ settings: { provider: "gone.ideas" } });
    expect(await runIdeas(missing.deps, "default", "refresh")).toMatchObject({
      outcome: "skipped",
      reason: "The ideas provider gone.ideas is not installed or not running",
    });
  });

  it("a scheduled run with the same inputs asks nothing; a refresh always asks", async () => {
    const { deps, seen, plugin } = await fixture({ settings: { provider: "acme.ideas" } });
    plugin(async () => ({ ideas: [{ idea: idea("travel.a"), score: 0.5 }] }));
    expect(await runIdeas(deps, "default", "schedule")).toMatchObject({ outcome: "generated" });
    expect(await runIdeas(deps, "default", "schedule")).toMatchObject({ outcome: "unchanged" });
    expect(await runIdeas(deps, "default", "refresh")).toMatchObject({ outcome: "generated" });
    expect(seen).toHaveLength(2);
  });

  it("asks on the first scheduled run after setup is finished, whatever the inputs, until one has generated", async () => {
    let now = new Date("2026-10-20T08:00:00.000Z");
    let completedAt: string | undefined;
    const { deps, seen, plugin } = await fixture({ settings: { provider: "acme.ideas" }, now: () => now });
    plugin(async () => ({ ideas: [{ idea: idea("travel.a"), score: 0.5 }] }));
    const withSetup = { ...deps, freshSince: async () => completedAt };
    expect(await runIdeas(withSetup, "default", "schedule")).toMatchObject({ outcome: "generated" });
    // Setup finished; the next morning's run would find nothing changed, and asks anyway.
    completedAt = "2026-10-20T09:00:00.000Z";
    now = new Date("2026-10-21T08:30:00.000Z");
    expect(await runIdeas(withSetup, "default", "schedule")).toMatchObject({ outcome: "generated" });
    // Kept: the usual rule is back.
    now = new Date("2026-10-21T09:30:00.000Z");
    expect(await runIdeas(withSetup, "default", "schedule")).toMatchObject({ outcome: "unchanged" });
    expect(seen).toHaveLength(2);
  });

  it("promises nothing past its window, and logs a completion it could not read", async () => {
    const logged: string[] = [];
    let now = new Date("2026-10-20T08:00:00.000Z");
    const { deps, plugin } = await fixture({ settings: { provider: "acme.ideas" }, now: () => now });
    plugin(async () => ({ ideas: [{ idea: idea("travel.a"), score: 0.5 }] }));
    expect(await runIdeas(deps, "default", "schedule")).toMatchObject({ outcome: "generated" });
    now = new Date("2026-10-22T08:00:00.000Z");
    expect(await runIdeas({ ...deps, freshSince: async () => "2026-10-20T09:00:00.000Z" }, "default", "schedule")).toMatchObject({
      outcome: "unchanged",
    });
    expect(
      await runIdeas(
        {
          ...deps,
          log: (message: string) => void logged.push(message),
          freshSince: async () => {
            throw new Error("locked");
          },
        },
        "default",
        "schedule",
      ),
    ).toMatchObject({ outcome: "unchanged" });
    expect(logged).toContain("when setup was finished could not be read; the usual rule applies");
  });

  it("records a provider's failure, and stops one past its deadline", async () => {
    const failing = await fixture({ settings: { provider: "acme.ideas" } });
    failing.plugin(async () => {
      throw new IdeasProviderError("budget");
    });
    expect((await runIdeas(failing.deps, "default", "refresh")).reason).toBe("The ideas provider acme.ideas failed (budget): budget");
    const slow = await fixture({ settings: { provider: "acme.ideas" } });
    slow.plugin(async () => await new Promise(() => undefined), ["ledger"], 1);
    const run = await runIdeas(slow.deps, "default", "refresh");
    expect(run).toMatchObject({ outcome: "failed" });
    expect(run.reason).toContain("took longer than 1s");
  });

  it("runs one refresh at a time per workspace, and one more after it however many were asked for", async () => {
    const { repositories, deps, plugin } = await fixture({ settings: { provider: "acme.ideas" } });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    plugin(async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { ideas: [] };
    });
    const host = new IdeasHost(deps);
    expect(await host.refresh("default")).toBe("started");
    expect(await host.refresh("default")).toBe("queued");
    expect(await host.refresh("default")).toBe("queued");
    release();
    await host.idle();
    expect(calls).toBe(2);
    expect(await repositories.ideas.refreshesSince("default", NOW.toISOString())).toBe(2);
  });

  it("quotes what it gave the provider, not what the provider changed it to", async () => {
    const { repositories, deps, plugin } = await fixture({ settings: { provider: "acme.ideas" } });
    plugin(async (request) => {
      // A provider rewriting what it was handed: the request is frozen to the bottom, and its copy is what is quoted.
      const first = request.memory?.[0] as { text: string } | undefined;
      expect(() => {
        if (first !== undefined) first.text = "I told Tavi I hate my boss";
      }).toThrow(TypeError);
      return { ideas: [{ idea: idea("travel.a", { basis: [{ kind: "memory", ref: "mem-1" }] }), score: 0.5 }] };
    });
    await runIdeas(deps, "default", "refresh");
    expect((await repositories.ideas.list({ workspaceId: "default", now: NOW.toISOString() }))[0]?.basis).toEqual([
      { kind: "memory", ref: "mem-1", excerpt: "Planning a trip to Lisbon in May; wants cheap flights" },
    ]);
  });

  it("never gives a provider a source the person excluded", async () => {
    const { repositories, deps, seen, plugin } = await fixture({ settings: { provider: "acme.ideas" }, brief: "More garden." });
    plugin(async () => ({ ideas: [] }));
    for (const basisRef of ["mem-1", "task-1", "brief"])
      await repositories.ideas.feedback({
        id: `x-${basisRef}`,
        workspaceId: "default",
        signal: "exclude-basis",
        basisRef,
        now: NOW.toISOString(),
      });
    await runIdeas(deps, "default", "refresh");
    expect(seen[0]?.memory).toEqual([]);
    expect(seen[0]?.tasks).toEqual([]);
    expect(seen[0]?.brief).toBeUndefined();
  });

  it("keeps nothing from a run whose brief was rewritten while it ran", async () => {
    const { repositories, deps, plugin } = await fixture({ settings: { provider: "acme.ideas" }, brief: "More garden." });
    plugin(async () => {
      await repositories.ideas.saveSettings({ workspaceId: "default", brief: "Nothing about money.", now: NOW.toISOString() });
      return { ideas: [{ idea: idea("travel.a", { basis: [{ kind: "brief", ref: "brief" }] }), score: 0.5 }] };
    });
    expect(await runIdeas(deps, "default", "refresh")).toMatchObject({
      outcome: "skipped",
      reason: "The person rewrote the ideas brief during the run",
    });
  });

  it("keeps nothing from a run whose provider was switched while it ran", async () => {
    const { repositories, deps, plugin } = await fixture({ settings: { provider: "acme.ideas" } });
    plugin(async () => {
      await repositories.ideas.saveSettings({
        workspaceId: "default",
        settings: { ...IDEA_DEFAULT_SETTINGS, provider: "tavi.ideasagent" },
        now: NOW.toISOString(),
      });
      return { ideas: [{ idea: idea("travel.a"), score: 0.5 }] };
    });
    expect(await runIdeas(deps, "default", "refresh")).toMatchObject({
      outcome: "skipped",
      reason: "The workspace now uses the ideas provider tavi.ideasagent",
    });
    expect(await repositories.ideas.list({ workspaceId: "default", now: NOW.toISOString() })).toEqual([]);
  });

  it("records a provider's error as one plain line", async () => {
    const { deps, plugin } = await fixture({ settings: { provider: "acme.ideas" } });
    plugin(async () => {
      throw new Error("bad\u001b]0;pwned\u0007\nnews");
    });
    expect((await runIdeas(deps, "default", "refresh")).reason).toBe("The ideas provider acme.ideas failed (transport): bad]0;pwned news");
  });

  it("is ready only when a provider says exactly so", async () => {
    const providers = new IdeasProviderRegistry();
    const install = (id: string, status: () => unknown) =>
      providers.install(id, {
        provider: { generate: async () => ({ ideas: [] }), status: status as never },
        kind: "plugin",
        receives: [],
        maxRunSeconds: 5,
      });
    install("yes", () => ({ ready: true }));
    install("no", () => ({ ready: "no" }));
    install("late", async () => ({ ready: true }));
    install("throws", () => {
      throw new Error("down");
    });
    expect(Object.fromEntries(providers.list().map((entry) => [entry.id, entry.ready]))).toEqual({
      yes: true,
      no: false,
      late: false,
      throws: false,
    });
  });

  it("records a refusal from the store other than a switch as a failure", async () => {
    const { repositories, deps, plugin } = await fixture({ settings: { provider: "acme.ideas" } });
    await repositories.ideas.startRun({ runId: "old", workspaceId: "other", trigger: "schedule", now: NOW.toISOString() });
    await repositories.ideas.store({
      workspaceId: "other",
      runId: "old",
      providerId: "acme.ideas",
      now: NOW.toISOString(),
      ideas: [{ id: "idea-n1", score: 0.5, draft: idea("travel.taken") }],
    });
    // The host's next id collides with an idea of another workspace: a CONFLICT that is not a switch.
    plugin(async () => ({ ideas: [{ idea: idea("travel.a"), score: 0.5 }] }));
    let ids = 0;
    const run = await runIdeas({ ...deps, newId: () => ((ids += 1) === 2 ? "n1" : `x${ids}`) }, "default", "refresh");
    expect(run.outcome).toBe("failed");
  });

  it("answers busy, and starts nothing, while a run is still open in the store", async () => {
    const { repositories, deps, plugin, seen } = await fixture({ settings: { provider: "acme.ideas" } });
    plugin(async () => ({ ideas: [] }));
    await repositories.ideas.startRun({ runId: "elsewhere", workspaceId: "default", trigger: "refresh", now: NOW.toISOString() });
    const host = new IdeasHost(deps);
    expect(await host.refresh("default")).toBe("busy");
    await host.idle();
    expect(seen).toHaveLength(0);
  });

  it("records a failure however strange the throw, and never leaves the run open", async () => {
    for (const thrown of [
      Object.create(null),
      Object.assign(new Error("x"), { message: 42 }),
      {
        get reason() {
          throw new Error("getter");
        },
      },
    ]) {
      const { repositories, deps, plugin } = await fixture({ settings: { provider: "acme.ideas" } });
      plugin(async () => {
        throw thrown;
      });
      expect(await runIdeas(deps, "default", "refresh")).toMatchObject({
        outcome: "failed",
        reason: "The ideas provider acme.ideas failed (transport): unknown error",
      });
      expect((await repositories.ideas.lastRun("default"))?.outcome).toBe("failed");
    }
  });

  it("fails an answer that is not { ideas: [...] }, and keeps no inputs hash from it", async () => {
    for (const answer of [null, 5, { ideas: "x" }]) {
      const { repositories, deps, plugin } = await fixture({ settings: { provider: "acme.ideas" } });
      plugin(async () => answer);
      expect(await runIdeas(deps, "default", "schedule")).toMatchObject({
        outcome: "failed",
        reason: expect.stringContaining("(invalid)"),
      });
      expect(await repositories.ideas.lastInputsHash("default")).toBeUndefined();
    }
  });

  it("fails at once when the provider's plugin has already stopped, whatever the provider does", async () => {
    const { deps, providers } = await fixture({ settings: { provider: "acme.ideas" } });
    const stopped = new AbortController();
    stopped.abort(new Error("the plugin stopped"));
    let called = 0;
    // As the external wrapper does once its plugin stops: a call refused at once. It must never be made, so nothing is left unheard.
    providers.install("acme.ideas", {
      provider: {
        generate: async () => {
          called += 1;
          throw new IdeasProviderError("transport");
        },
      },
      kind: "plugin",
      receives: [],
      maxRunSeconds: 30,
      signal: stopped.signal,
    });
    expect(await runIdeas(deps, "default", "refresh")).toMatchObject({
      outcome: "failed",
      reason: expect.stringContaining("the plugin stopped"),
    });
    expect(called).toBe(0);
  });

  it("reads at most four pages of proposals, and counts the rest and the cap's evictions as dropped", async () => {
    const { deps, plugin } = await fixture({ settings: { provider: "acme.ideas" } });
    plugin(async () => ({ ideas: Array.from({ length: 100 }, (_, index) => ({ idea: idea(`travel.k${index}`), score: index / 100 })) }));
    // 100 offered: 48 read (4 × 12), 12 kept, 36 evicted at once, 52 never read.
    expect(await runIdeas(deps, "default", "refresh")).toMatchObject({ outcome: "generated", generated: 12, dropped: 88 });
  });

  it("refuses a refresh past the hour's limit as the run would start", async () => {
    const { deps, plugin } = await fixture({ settings: { provider: "acme.ideas" } });
    plugin(async () => ({ ideas: [] }));
    const host = new IdeasHost(deps);
    for (let index = 0; index < 3; index += 1) {
      expect(await host.refresh("default")).toBe("started");
      await host.idle();
    }
    await expect(host.refresh("default")).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("offers a model turn only to a provider that declares one, and records what it spent", async () => {
    const asked: { scope: unknown; input: unknown }[] = [];
    const { deps, seen, plugin } = await fixture({
      settings: { provider: "acme.ideas" },
      turn: async (scope, input) => (asked.push({ scope, input }), { text: '{"ideas":[]}', tokens: 700 }),
    });
    plugin(async () => ({ ideas: [] }));
    await runIdeas(deps, "default", "refresh");
    expect(seen[0]?.host).toBeUndefined();
    plugin(
      async (request) => {
        expect(await request.host?.runTurn({ system: "s", user: "u", maxOutputTokens: 99_999 })).toEqual({ text: '{"ideas":[]}' });
        return { ideas: [] };
      },
      undefined,
      30,
      true,
    );
    const run = await runIdeas(deps, "default", "refresh");
    expect(run).toMatchObject({ outcome: "generated", tokens: 700 });
    expect(asked).toEqual([
      { scope: { workspaceId: "default", runId: run.id }, input: { system: "s", user: "u", maxOutputTokens: 2_000 } },
    ]);
    expect(await deps.repositories.ideas.spentSince("default", "2026-10-18T21:00:00.000Z")).toMatchObject({ tokens: 700 });
  });

  it("refuses a turn past the day's budget or the run's turns, and the provider writes without it", async () => {
    let calls = 0;
    const { deps, plugin } = await fixture({
      settings: { provider: "acme.ideas", dailyTokens: 3_000 },
      turn: async () => ((calls += 1), { text: "ok", tokens: 1_200 }),
    });
    const refusals: string[] = [];
    plugin(
      async (request) => {
        for (let index = 0; index < 4; index += 1) {
          await request.host
            ?.runTurn({ system: "", user: "u", maxOutputTokens: 1_000 })
            .catch((error: unknown) => refusals.push(error instanceof IdeasProviderError ? error.reason : "other"));
        }
        await request.host
          ?.runTurn({ system: "", user: " " })
          .catch((error: unknown) => refusals.push(error instanceof IdeasProviderError ? error.reason : "other"));
        return { ideas: [{ idea: idea("travel.a"), score: 0.5 }] };
      },
      undefined,
      30,
      true,
    );
    expect(await runIdeas(deps, "default", "refresh")).toMatchObject({ outcome: "generated", generated: 1, tokens: 1_200 * 2 });
    // 1 200 + 1 000 fits 3 000; 2 400 + 1 000 does not: the third and fourth are refused; an empty prompt is invalid.
    expect(calls).toBe(2);
    expect(refusals).toEqual(["budget", "budget", "invalid"]);
    // The next run of the day starts with what this one spent.
    calls = 0;
    await runIdeas(deps, "default", "refresh");
    expect(calls).toBe(0);
  });

  it("runs each workspace once a local day inside its hours, and says when the next is due", async () => {
    let now = new Date("2026-10-19T03:00:00.000Z"); // 06:00 in Sofia: before its hours
    const { deps, seen, plugin } = await fixture({ settings: { provider: "acme.ideas" }, workspaces: ["default"], now: () => now });
    plugin(async () => ({ ideas: [{ idea: idea("travel.a"), score: 0.5 }] }));
    const host = new IdeasHost(deps);
    expect(await host.nextAt("default")).toBeUndefined();
    host.start(60 * 60_000);
    try {
      expect(await host.nextAt("default")).toBe("2026-10-19T05:00:00.000Z");
      await host.schedule();
      await host.idle();
      expect(seen).toHaveLength(0);
      now = new Date("2026-10-19T06:00:00.000Z");
      expect(await host.nextAt("default")).toBe(now.toISOString());
      await host.schedule();
      await host.idle();
      expect(await deps.repositories.ideas.lastRun("default", "schedule")).toMatchObject({ outcome: "generated", trigger: "schedule" });
      now = new Date("2026-10-19T12:00:00.000Z");
      await host.schedule();
      await host.idle();
      expect(seen).toHaveLength(1);
      expect(await host.nextAt("default")).toBe("2026-10-20T05:00:00.000Z");
      // A new local day: due again, and with nothing changed it asks no one.
      now = new Date("2026-10-20T06:00:00.000Z");
      await host.schedule();
      await host.idle();
      expect(await deps.repositories.ideas.lastRun("default", "schedule")).toMatchObject({ outcome: "unchanged" });
      expect(seen).toHaveLength(1);
    } finally {
      host.stop();
    }
  });

  it("counts what a failed turn spent against the day", async () => {
    let calls = 0;
    const { deps, plugin } = await fixture({
      settings: { provider: "acme.ideas", dailyTokens: 2_500 },
      turn: async () => {
        calls += 1;
        throw Object.assign(new Error("the model stopped"), { tokens: 1_000 });
      },
    });
    plugin(
      async (request) => {
        for (let index = 0; index < 3; index += 1)
          await request.host?.runTurn({ system: "", user: "u", maxOutputTokens: 1_000 }).catch(() => undefined);
        return { ideas: [] };
      },
      undefined,
      30,
      true,
    );
    // 0 + 1 000 fits; 1 000 + 1 000 fits; 2 000 + 1 000 does not.
    expect(await runIdeas(deps, "default", "refresh")).toMatchObject({ outcome: "generated", tokens: 2_000 });
    expect(calls).toBe(2);
  });

  it("says the next run starts at the schedule's next look, not now, after a refresh inside the hours", async () => {
    const now = new Date("2026-10-19T06:00:00.000Z"); // 09:00 in Sofia: inside its hours
    const { deps, plugin } = await fixture({ settings: { provider: "acme.ideas" }, workspaces: ["default"], now: () => now });
    plugin(async () => ({ ideas: [{ idea: idea("travel.a"), score: 0.5 }] }));
    const host = new IdeasHost(deps);
    host.start(15 * 60_000);
    try {
      expect(await host.refresh("default")).toBe("started");
      await host.idle();
      expect(await host.nextAt("default")).toBe("2026-10-19T06:15:00.000Z");
    } finally {
      host.stop();
    }
  });

  it("runs hours that cross midnight once, not again after midnight", async () => {
    let now = new Date("2026-10-19T20:00:00.000Z"); // 23:00 in Sofia
    const { deps, seen, plugin } = await fixture({
      settings: { provider: "acme.ideas", hours: { start: "22:00", end: "06:00" } },
      workspaces: ["default"],
      now: () => now,
    });
    plugin(async () => ({ ideas: [{ idea: idea("travel.a"), score: 0.5 }] }));
    const host = new IdeasHost(deps);
    host.start(60 * 60_000);
    try {
      await host.schedule();
      await host.idle();
      now = new Date("2026-10-19T22:30:00.000Z"); // 01:30 the next local day, the same window
      await host.schedule();
      await host.idle();
      expect(seen).toHaveLength(1);
      expect(await host.nextAt("default")).toBe("2026-10-20T19:00:00.000Z");
    } finally {
      host.stop();
    }
  });

  it("the next run honours every card action: not now, not interested, a muted section, more like this, a source set aside", async () => {
    const { repositories, providers, deps } = await fixture();
    providers.install("tavi.ideasagent", {
      provider: createBuiltinIdeasProvider(),
      kind: "builtin",
      receives: ["memory", "tasks", "brief", "ledger"],
      maxRunSeconds: 30,
    });
    await runIdeas(deps, "default", "schedule");
    const first = await repositories.ideas.list({ workspaceId: "default", now: NOW.toISOString() });
    const cited = first.find((item) => item.basis.some((basis) => basis.ref === "mem-1"));
    const general = first.filter((item) => item.basis.every((basis) => basis.kind === "general"));
    const [snoozed, dismissed, boosted] = general;
    const muted = general.find((item) => ![snoozed, dismissed, boosted].some((other) => other?.category === item.category))?.category;
    if (cited === undefined || snoozed === undefined || dismissed === undefined || boosted === undefined || muted === undefined)
      throw new Error("the first run offered too little to steer");
    const at = NOW.toISOString();
    await repositories.ideas.feedback({
      id: "f1",
      workspaceId: "default",
      signal: "not-now",
      ideaId: snoozed.id,
      snoozedUntil: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
      now: at,
    });
    await repositories.ideas.feedback({ id: "f2", workspaceId: "default", signal: "not-interested", ideaId: dismissed.id, now: at });
    await repositories.ideas.feedback({ id: "f3", workspaceId: "default", signal: "mute-category", category: muted, now: at });
    await repositories.ideas.feedback({ id: "f4", workspaceId: "default", signal: "more-like-this", ideaId: boosted.id, now: at });
    await repositories.ideas.feedback({
      id: "f5",
      workspaceId: "default",
      signal: "exclude-basis",
      ideaId: cited.id,
      basisRef: "mem-1",
      now: at,
    });
    expect(await runIdeas(deps, "default", "schedule")).toMatchObject({ outcome: "generated" });
    const next = await repositories.ideas.list({ workspaceId: "default", now: at });
    const keys = next.map((item) => item.key);
    expect(keys).not.toContain(snoozed.key);
    expect(keys).not.toContain(dismissed.key);
    expect(next.some((item) => item.category === muted)).toBe(false);
    expect(next.some((item) => item.basis.some((basis) => basis.ref === "mem-1"))).toBe(false);
    expect(next.find((item) => item.key === boosted.key)?.score).toBeGreaterThan(boosted.score);
  });

  it("moves the volume with a week's take-up: halved below 10 %, doubled above 40 %, within 4–12", () => {
    expect(nextIdeasVolume(12, { shown: 20, tried: 1 })).toBe(6);
    expect(nextIdeasVolume(6, { shown: 20, tried: 1 })).toBe(4);
    expect(nextIdeasVolume(4, { shown: 20, tried: 0 })).toBe(4);
    expect(nextIdeasVolume(4, { shown: 10, tried: 5 })).toBe(8);
    expect(nextIdeasVolume(8, { shown: 10, tried: 5 })).toBe(12);
    expect(nextIdeasVolume(12, { shown: 20, tried: 4 })).toBe(12);
    // Too few shown says nothing.
    expect(nextIdeasVolume(12, { shown: 7, tried: 0 })).toBe(12);
  });

  it("a scheduled run after a week of ideas left untried asks for fewer, and keeps no more than it asked for; a refresh keeps the volume", async () => {
    let now = new Date("2026-10-12T10:00:00.000Z");
    const { repositories, deps, seen, plugin } = await fixture({ settings: { provider: "acme.ideas" }, now: () => now });
    let round = 0;
    plugin(async () => ({
      ideas: Array.from({ length: 12 }, (_, index) => ({ idea: idea(`travel.r${round}-${index}`), score: 0.9 - index / 100 })),
    }));
    // A week of runs: twelve shown each day, none tried.
    for (let day = 0; day < 7; day += 1) {
      round = day;
      now = new Date(Date.parse("2026-10-12T10:00:00.000Z") + day * 86_400_000);
      await runIdeas(deps, "default", "refresh");
    }
    round = 99;
    now = new Date("2026-10-19T10:00:00.000Z");
    const run = await runIdeas(deps, "default", "schedule");
    expect((await repositories.ideas.settings("default")).settings.volume).toBe(6);
    expect(seen.at(-1)?.limits.maxIdeas).toBe(6);
    // Twelve offered, six kept: the other six count as dropped (the cap may keep out more, the week's ideas still active).
    expect(run.outcome).toBe("generated");
    expect(run.generated).toBeLessThanOrEqual(6);
    expect(run.dropped).toBeGreaterThanOrEqual(6);
    round = 100;
    await runIdeas(deps, "default", "refresh");
    expect(seen.at(-1)?.limits.maxIdeas).toBe(6);
    // The next day's run, still within the week since it moved: the volume stays.
    now = new Date("2026-10-20T10:00:00.000Z");
    round = 101;
    await runIdeas(deps, "default", "schedule");
    expect((await repositories.ideas.settings("default")).settings.volume).toBe(6);
  });

  it("with the memory source off, the next run cites no memory", async () => {
    const { repositories, providers, deps } = await fixture({ settings: { sources: { memory: false, tasks: true, brief: true } } });
    providers.install("tavi.ideasagent", {
      provider: createBuiltinIdeasProvider(),
      kind: "builtin",
      receives: ["memory", "tasks", "brief", "ledger"],
      maxRunSeconds: 30,
    });
    expect(await runIdeas(deps, "default", "refresh")).toMatchObject({ outcome: "generated" });
    const listed = await repositories.ideas.list({ workspaceId: "default", now: NOW.toISOString() });
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.some((stored) => stored.basis.some((basis) => basis.kind === "memory"))).toBe(false);
  });

  it("prepares the day's first steps on the daily run only: two read-only ideas with nothing left to fill, best first", async () => {
    const asked: string[] = [];
    let taskIds = 0;
    // Each run a minute on: a scheduled run with the same inputs as the last asks nothing.
    let minutes = 0;
    const { repositories, deps, plugin } = await fixture({
      now: () => new Date(NOW.getTime() + minutes * 60_000),
      settings: { provider: "acme.ideas" },
      prepare: async (_scope, chosen) => (asked.push(chosen.key), { taskId: `prep-${(taskIds += 1)}`, text: `Found for ${chosen.key}` }),
    });
    // The fixture's store has no tasks for the prepared runs: count them as the composition's admissions would.
    const admitted: string[] = [];
    const preparedSince = repositories.ideas.preparedSince.bind(repositories.ideas);
    repositories.ideas.preparedSince = async (workspaceId, since) => ({
      ...(await preparedSince(workspaceId, since)),
      count: admitted.length,
    });
    const base = { score: 0.5 };
    plugin(
      async () => ({
        ideas: [
          { idea: idea("travel.ask", { uses: [{ capability: "web", approval: true }] }), score: 0.99 },
          { idea: idea("travel.fill", { prompt: "Find flights to [city]." }), score: 0.98 },
          { idea: idea("travel.mail", { uses: [{ capability: "mailbox", approval: false }] }), score: 0.97 },
          { idea: idea("travel.a"), score: 0.9 },
          { idea: idea("travel.b"), ...base },
          { idea: idea("travel.c"), score: 0.4 },
        ],
      }),
      ["ledger"],
    );
    const prepare = deps.prepare!;
    const counted: IdeasHostDependencies = {
      ...deps,
      prepare: async (scope, chosen, signal) => {
        const result = await prepare(scope, chosen, signal);
        if (result !== undefined) admitted.push(result.taskId);
        return result;
      },
    };
    await runIdeas(counted, "default", "refresh");
    expect(asked).toEqual([]);
    minutes += 1;
    await runIdeas(counted, "default", "schedule");
    expect(asked).toEqual(["travel.a", "travel.b"]);
    const listed = await repositories.ideas.list({ workspaceId: "default", now: NOW.toISOString() });
    expect(listed.find((stored) => stored.key === "travel.a")?.prepared).toMatchObject({ taskId: "prep-1", text: "Found for travel.a" });
    // Two a day: the next daily run prepares nothing more.
    minutes += 1;
    await runIdeas(counted, "default", "schedule");
    expect(asked).toHaveLength(2);
    expect(preparable(listed.find((stored) => stored.key === "travel.c")!, NOW)).toBe(true);
    expect(preparable(listed.find((stored) => stored.key === "travel.a")!, NOW)).toBe(false);
  });

  it("starts no prepared run the day's tokens could not cover, and renews an answer before it goes stale", async () => {
    const asked: string[] = [];
    let minutes = 0;
    const { repositories, deps, plugin } = await fixture({
      now: () => new Date(NOW.getTime() + minutes * 60_000),
      settings: { provider: "acme.ideas" },
      prepare: async (_scope, chosen) => (asked.push(chosen.key), { taskId: `prep-${asked.length}`, text: `Found for ${chosen.key}` }),
    });
    plugin(async () => ({ ideas: [{ idea: idea("travel.a"), score: 0.9 }] }), ["ledger"]);
    // 30 000 spent already: one more run's worst case (15 000) would pass the day's 40 000.
    repositories.ideas.preparedSince = async () => ({ count: 0, tokens: 30_000 });
    await runIdeas(deps, "default", "schedule");
    expect(asked).toEqual([]);
    repositories.ideas.preparedSince = async () => ({ count: 0, tokens: 0 });
    minutes += 1;
    await runIdeas(deps, "default", "schedule");
    expect(asked).toEqual(["travel.a"]);
    const stored = (await repositories.ideas.list({ workspaceId: "default", now: NOW.toISOString() }))[0]!;
    expect(preparable(stored, new Date(NOW.getTime() + 19 * 3_600_000))).toBe(false);
    expect(preparable(stored, new Date(NOW.getTime() + 21 * 3_600_000))).toBe(true);
  });

  it("sends the weekly digest only when set, on its day inside the hours, once, with the best three; one reply in its chat picks one", async () => {
    const sent: { connectionId: string; text: string; effectId: string }[] = [];
    let accepted = false;
    let now = new Date("2026-10-19T10:00:00.000Z"); // a Monday, 13:00 in Sofia
    const { repositories, deps, plugin } = await fixture({ settings: { provider: "acme.ideas" }, now: () => now, workspaces: ["default"] });
    const withSend: IdeasHostDependencies = {
      ...deps,
      sendDigest: async (input) => (sent.push(input), accepted ? { status: "sent", chatId: "chat-9" } : { status: "skipped" }),
    };
    plugin(async () => ({ ideas: ["a", "b", "c", "d"].map((name, index) => ({ idea: idea(`travel.${name}`), score: 0.9 - index / 10 })) }));
    await runIdeas(withSend, "default", "refresh");
    // Off by default.
    expect(await sendIdeasDigest(withSend, "default")).toBe("not-due");
    const { settings } = await repositories.ideas.settings("default");
    await repositories.ideas.saveSettings({
      workspaceId: "default",
      settings: { ...settings, digest: { channel: "tg-1", weekday: 2 } },
      now: now.toISOString(),
    });
    // Not its day.
    expect(await sendIdeasDigest(withSend, "default")).toBe("not-due");
    await repositories.ideas.saveSettings({
      workspaceId: "default",
      settings: { ...settings, digest: { channel: "tg-1", weekday: 1 } },
      now: now.toISOString(),
    });
    // Refused: tried again at the next look, under a key of its own.
    expect(await sendIdeasDigest(withSend, "default")).toBe("skipped");
    now = new Date("2026-10-19T10:15:00.000Z");
    accepted = true;
    expect(await sendIdeasDigest(withSend, "default")).toBe("sent");
    // A key per day, connection and refusal: the refused send is retried under the next one, never the accepted send again.
    expect(sent.map((attempt) => attempt.effectId)).toEqual([
      "ideas-digest:default:2026-10-19:tg-1:0",
      "ideas-digest:default:2026-10-19:tg-1:1",
    ]);
    expect(sent.at(-1)).toMatchObject({
      connectionId: "tg-1",
      text: "Ideas for you this week:\n1. I can do travel.a\n2. I can do travel.b\n3. I can do travel.c\n\nReply 1, 2, 3 to start one, or see more in Tavi's Ideas tab.",
    });
    expect(await sendIdeasDigest(withSend, "default")).toBe("not-due");
    const reply = (text: string, chatId = "chat-9", connectionId = "tg-1") =>
      ideaOfDigestReply(deps, { workspaceId: "default", connectionId, chatId, text });
    // Only in the chat it went to, and only what it listed.
    expect(await reply("1", "group-1")).toBeUndefined();
    expect(await reply("1", "chat-9", "discord-1")).toBeUndefined();
    expect(await reply("4")).toBeUndefined();
    expect(await reply("1 more thing")).toBeUndefined();
    expect((await reply("3."))?.key).toBe("travel.c");
    // A day on, a bare number answers something else; "try 2" still picks.
    now = new Date("2026-10-20T11:00:00.000Z");
    expect(await reply("2")).toBeUndefined();
    expect((await reply("try 2"))?.key).toBe("travel.b");
    // In Bulgarian too, whatever the workspace speaks.
    expect((await reply("Пробвай 2"))?.key).toBe("travel.b");
    expect((await reply("опитай 2!"))?.key).toBe("travel.b");
    // Once picked, no later reply picks again.
    await digestPicked(deps, "default");
    expect(await reply("try 2")).toBeUndefined();
    // Once a week, whatever is set since: moved to Tuesday, it waits out the week rather than sending again now.
    await repositories.ideas.saveSettings({
      workspaceId: "default",
      patch: { digest: { channel: "tg-1", weekday: 2 } },
      now: now.toISOString(),
    });
    expect(await sendIdeasDigest(withSend, "default")).toBe("not-due");
    now = new Date("2026-10-27T10:00:00.000Z"); // the next Tuesday, with the week's ideas looked for again
    await runIdeas(withSend, "default", "refresh");
    expect(await sendIdeasDigest(withSend, "default")).toBe("sent");
  });

  it("refuses a refresh while Ideas is off, and one that would follow the run under way past the hour's limit", async () => {
    const { repositories, deps, plugin } = await fixture({ settings: { provider: "acme.ideas" } });
    let gate: Promise<void> = Promise.resolve();
    plugin(async () => {
      await gate;
      return { ideas: [] };
    });
    const host = new IdeasHost(deps);
    await repositories.ideas.saveSettings({ workspaceId: "default", patch: { enabled: false }, now: nowTimestamp() });
    await expect(host.refresh("default")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await repositories.ideas.saveSettings({ workspaceId: "default", patch: { enabled: true }, now: nowTimestamp() });
    for (let index = 0; index < 2; index += 1) {
      expect(await host.refresh("default")).toBe("started");
      await host.idle();
    }
    // The hour's third refresh is still running: a fourth is refused now, not dropped once it ends.
    let open = (): void => undefined;
    gate = new Promise((resolve) => {
      open = resolve;
    });
    expect(await host.refresh("default")).toBe("started");
    await expect(host.refresh("default")).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    open();
    await host.idle();
  });

  it("the schedule's look sends the digest once the day's run is in", async () => {
    const sent: string[] = [];
    const { repositories, deps, plugin } = await fixture({
      settings: { provider: "acme.ideas" },
      now: () => new Date("2026-10-19T10:00:00.000Z"),
      workspaces: ["default"],
    });
    plugin(async () => ({ ideas: [{ idea: idea("travel.a"), score: 0.9 }] }));
    const { settings } = await repositories.ideas.settings("default");
    await repositories.ideas.saveSettings({
      workspaceId: "default",
      settings: { ...settings, digest: { channel: "tg-1", weekday: 1 } },
      now: "2026-10-19T10:00:00.000Z",
    });
    const host = new IdeasHost({
      ...deps,
      sendDigest: async (input) => (sent.push(input.connectionId), { status: "sent", chatId: "chat-9" }),
    });
    host.start(60 * 60_000);
    try {
      await host.schedule();
      await host.idle();
      expect(sent).toEqual([]);
      await host.schedule();
      await host.idle();
      expect(sent).toEqual(["tg-1"]);
    } finally {
      host.stop();
    }
  });

  it("prepares only an idea that rests on nothing of the person's", () => {
    const at = new Date("2026-10-19T10:00:00.000Z");
    const general = {
      ...idea("travel.g"),
      id: "g",
      workspaceId: "default",
      runId: "r",
      providerId: "tavi.ideasagent",
      score: 0.5,
      status: "active" as const,
      pinned: false,
      shownRuns: 0,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
      expiresAt: at.toISOString(),
    };
    expect(preparable(general, at)).toBe(true);
    expect(preparable({ ...general, basis: [{ kind: "memory", ref: "mem-1", excerpt: "Lisbon" }] }, at)).toBe(false);
    expect(preparable({ ...general, prompt: "Find flights to [city]." }, at)).toBe(false);
  });

  it("lists, picks and prepares only what the tab offers: no muted section, no other provider, no capability gone", async () => {
    let census: readonly string[] = ["web", "mailbox"];
    const now = new Date("2026-10-19T10:00:00.000Z");
    const { repositories, deps, plugin } = await fixture({ settings: { provider: "acme.ideas" }, now: () => now });
    const withCensus: IdeasHostDependencies = {
      ...deps,
      census: async () => census as never,
      sendDigest: async () => ({ status: "sent", chatId: "chat-9" }),
    };
    plugin(async () => ({
      ideas: [
        { idea: idea("travel.mail", { uses: [{ capability: "mailbox", approval: false }] }), score: 0.9 },
        { idea: idea("shopping.muted"), score: 0.8 },
        { idea: idea("travel.ok"), score: 0.7 },
      ],
    }));
    await runIdeas(withCensus, "default", "refresh");
    await repositories.ideas.feedback({
      id: "m1",
      workspaceId: "default",
      signal: "mute-category",
      category: "shopping",
      now: now.toISOString(),
    });
    census = ["web"];
    const { settings } = await repositories.ideas.settings("default");
    expect((await offeredIdeas(withCensus, "default", settings)).map((offered) => offered.key)).toEqual(["travel.ok"]);
    await repositories.ideas.saveSettings({
      workspaceId: "default",
      patch: { digest: { channel: "tg-1", weekday: 1 } },
      now: now.toISOString(),
    });
    expect(await sendIdeasDigest(withCensus, "default")).toBe("sent");
    expect((await repositories.ideas.settings("default")).settings.digestSent?.ideaIds).toHaveLength(1);
    // Ideas turned off: a reply is only a message.
    await repositories.ideas.saveSettings({ workspaceId: "default", patch: { enabled: false }, now: now.toISOString() });
    expect(
      await ideaOfDigestReply(withCensus, { workspaceId: "default", connectionId: "tg-1", chatId: "chat-9", text: "1" }),
    ).toBeUndefined();
  });

  it("an unchanged look keeps what it offered alive, and asks again once nothing is left", async () => {
    let now = new Date("2026-10-12T10:00:00.000Z");
    const { repositories, deps, seen, plugin } = await fixture({ settings: { provider: "acme.ideas" }, now: () => now });
    plugin(async () => ({ ideas: [{ idea: idea("travel.a"), score: 0.9 }] }));
    await runIdeas(deps, "default", "schedule");
    // A week of quiet days, each a look that finds nothing changed: the idea is still offered at the end.
    for (let day = 1; day <= 8; day += 1) {
      now = new Date(Date.parse("2026-10-12T10:00:00.000Z") + day * 86_400_000);
      expect(await runIdeas(deps, "default", "schedule")).toMatchObject({ outcome: "unchanged" });
    }
    expect((await repositories.ideas.list({ workspaceId: "default", now: now.toISOString() })).map((offered) => offered.key)).toEqual([
      "travel.a",
    ]);
    // Nothing left (dismissed): the next look asks the provider again.
    const [only] = await repositories.ideas.list({ workspaceId: "default", now: now.toISOString() });
    await repositories.ideas.feedback({
      id: "d1",
      workspaceId: "default",
      signal: "not-interested",
      ideaId: only!.id,
      now: now.toISOString(),
    });
    const asked = seen.length;
    now = new Date(now.getTime() + 86_400_000);
    await runIdeas(deps, "default", "schedule");
    expect(seen.length).toBe(asked + 1);
  });

  it("prepares nothing when the person's ideas budget is 0", async () => {
    const asked: string[] = [];
    let minutes = 0;
    const { deps, plugin } = await fixture({
      settings: { provider: "acme.ideas", dailyTokens: 0 },
      now: () => new Date(NOW.getTime() + minutes * 60_000),
      prepare: async (_scope, chosen) => (asked.push(chosen.key), { taskId: "p", text: "x" }),
    });
    plugin(async () => ({ ideas: [{ idea: idea("travel.a"), score: 0.9 }] }), ["ledger"]);
    await runIdeas(deps, "default", "schedule");
    minutes += 1;
    await runIdeas(deps, "default", "schedule");
    expect(asked).toEqual([]);
  });

  it("prepares a general idea only from a provider that cannot have put the person's notes in it", async () => {
    const asked: string[] = [];
    let minutes = 0;
    const { deps, plugin } = await fixture({
      settings: { provider: "acme.ideas" },
      now: () => new Date(NOW.getTime() + minutes * 60_000),
      prepare: async (_scope, chosen) => (asked.push(chosen.key), { taskId: "p", text: "x" }),
    });
    // It reads memory, so a "general" basis is only its word: nothing is prepared.
    plugin(async () => ({ ideas: [{ idea: idea("travel.a"), score: 0.9 }] }), ["memory", "ledger"]);
    await runIdeas(deps, "default", "schedule");
    minutes += 1;
    await runIdeas(deps, "default", "schedule");
    expect(asked).toEqual([]);
  });

  it("prepares an external provider's ideas once the operator turns prepareExternal on", async () => {
    const asked: string[] = [];
    let minutes = 0;
    const { deps, plugin } = await fixture({
      settings: { provider: "acme.ideas", prepareExternal: true },
      now: () => new Date(NOW.getTime() + minutes * 60_000),
      prepare: async (_scope, chosen) => (asked.push(chosen.key), { taskId: "p", text: "x" }),
    });
    plugin(async () => ({ ideas: [{ idea: idea("travel.a"), score: 0.9 }] }), ["memory", "ledger"]);
    await runIdeas(deps, "default", "schedule");
    minutes += 1;
    await runIdeas(deps, "default", "schedule");
    expect(asked).toEqual(["travel.a"]);
  });

  it("prepared steps and model turns spend one day's budget", async () => {
    const asked: string[] = [];
    const minutes = 0;
    const { repositories, deps, plugin } = await fixture({
      settings: { provider: "acme.ideas", dailyTokens: 20_000 },
      now: () => new Date(NOW.getTime() + minutes * 60_000),
      prepare: async (_scope, chosen) => (asked.push(chosen.key), { taskId: "p", text: "x" }),
    });
    plugin(async () => ({ ideas: [{ idea: idea("travel.a"), score: 0.9 }] }), ["ledger"]);
    // Turns spent 6 000 of the 20 000: a run's worst case (15 000) no longer fits, though the prepare pool is untouched.
    const spentSince = repositories.ideas.spentSince.bind(repositories.ideas);
    repositories.ideas.spentSince = async (workspaceId, since) => ({ ...(await spentSince(workspaceId, since)), tokens: 6_000 });
    await runIdeas(deps, "default", "schedule");
    expect(asked).toEqual([]);
    // And a turn counts what prepared steps spent: 19 500 of 20 000 leaves no room for a 1 000-token answer.
    repositories.ideas.spentSince = async (workspaceId, since) => ({ ...(await spentSince(workspaceId, since)), tokens: 0 });
    repositories.ideas.preparedSince = async () => ({ count: 1, tokens: 19_500 });
    const refusals: string[] = [];
    plugin(
      async (request) => {
        await request.host
          ?.runTurn({ system: "", user: "u", maxOutputTokens: 1_000 })
          .catch((error: unknown) => refusals.push(error instanceof IdeasProviderError ? error.reason : "other"));
        return { ideas: [] };
      },
      ["ledger"],
      30,
      true,
    );
    const withTurn: IdeasHostDependencies = { ...deps, turn: async () => ({ text: "ok", tokens: 10 }) };
    await runIdeas(withTurn, "default", "refresh");
    expect(refusals).toEqual(["budget"]);
  });

  it("holds turns asked at once against the day, and counts what a turn stopped at the deadline spent", async () => {
    let calls = 0;
    const { deps, plugin } = await fixture({
      settings: { provider: "acme.ideas", dailyTokens: 2_500 },
      turn: async () => ((calls += 1), await delay(5), { text: "ok", tokens: 900 }),
    });
    const refusals: string[] = [];
    plugin(
      async (request) => {
        // Three at once, each up to 1 000: only two fit 2 500 together.
        await Promise.all(
          [0, 1, 2].map(
            async () =>
              await request.host
                ?.runTurn({ system: "", user: "u", maxOutputTokens: 1_000 })
                .catch((error: unknown) => refusals.push(error instanceof IdeasProviderError ? error.reason : "other")),
          ),
        );
        return { ideas: [] };
      },
      ["ledger"],
      30,
      true,
    );
    expect(await runIdeas(deps, "default", "refresh")).toMatchObject({ outcome: "generated", tokens: 1_800 });
    expect(calls).toBe(2);
    expect(refusals).toEqual(["budget"]);
    // Stopped at its 1 s deadline mid-turn: the run waits for the turn to say what it spent.
    const slow = await fixture({
      settings: { provider: "acme.ideas" },
      turn: async (_scope, _input, signal) =>
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => setTimeout(() => reject(Object.assign(new Error("stopped"), { tokens: 450 })), 20), {
            once: true,
          });
        }),
    });
    slow.plugin(async (request) => await request.host?.runTurn({ system: "", user: "u" }), ["ledger"], 1, true);
    expect(await runIdeas(slow.deps, "default", "refresh")).toMatchObject({ outcome: "failed", tokens: 450 });
  });

  it("reads no memory or chats while memory is paused", async () => {
    const { deps, seen, plugin } = await fixture({ settings: { provider: "acme.ideas" }, brief: "More about the garden." });
    plugin(async () => ({ ideas: [] }));
    await runIdeas({ ...deps, memoryOn: async () => false }, "default", "refresh");
    expect(seen[0]?.memory).toBeUndefined();
    expect(seen[0]?.tasks).toBeUndefined();
    expect(seen[0]?.ledger?.examples).toEqual([]);
    expect(seen[0]?.brief).toBe("More about the garden.");
  });
});
