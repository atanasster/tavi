import { IDEA_DEFAULT_SETTINGS, IDEA_SNOOZE_MS, IDEA_TTL_MS, TaviError, type IdeaDraft, type IdeasPayload } from "@tavi/contracts";
import { catalogueIdea, IDEA_CATALOGUE, ideaWordsIn } from "@tavi/plugin-kit/ideas";
import { describe, expect, it } from "vitest";

import {
  ideaChatEnded,
  ideaChatSeeded,
  ideaPreparedAnswer,
  ideasCommand,
  type IdeasCommandDependencies,
} from "../../src/features/ideas/owner.js";
import { SqliteStore } from "../support/database-fixture.js";

/** `ideas` on the owner: every action against the store. */

const NOW = new Date("2026-10-19T10:00:00.000Z");

const draft = (key: string, overrides: Partial<IdeaDraft> = {}): IdeaDraft => ({
  key,
  category: "travel",
  icon: "✈️",
  title: `I can help with ${key}`,
  pitch: "A pitch.",
  label: `Try ${key}`,
  prompt: `Help me with ${key}.`,
  basis: [{ kind: "memory", ref: "mem-1" }],
  uses: [{ capability: "web", approval: false }],
  ...overrides,
});

async function fixture(extra: Partial<IdeasCommandDependencies> = {}) {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  const repositories = store.asPort().repositories;
  let ids = 0;
  const deps: IdeasCommandDependencies = {
    repositories,
    principalOf: (workspaceId) => (workspaceId === "default" || workspaceId === "other" ? "operator" : undefined),
    now: () => NOW,
    newId: () => `n${(ids += 1)}`,
    ...extra,
  };
  const seed = async (drafts: readonly IdeaDraft[], workspaceId = "default") => {
    await repositories.ideas.startRun({ runId: `run-${workspaceId}`, workspaceId, trigger: "schedule", now: NOW.toISOString() });
    const stored = (
      await repositories.ideas.store({
        workspaceId,
        runId: `run-${workspaceId}`,
        providerId: "tavi.ideasagent",
        now: NOW.toISOString(),
        ideas: drafts.map((item, index) => ({ id: `${workspaceId}-${item.key}`, score: 0.9 - index / 10, draft: item })),
      })
    ).stored;
    await repositories.ideas.finishRun({ runId: `run-${workspaceId}`, outcome: "generated", now: NOW.toISOString() });
    return stored;
  };
  const call = async (payload: IdeasPayload) => {
    const answer = await ideasCommand(deps, payload);
    if (!answer.ok) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
    return answer.result as Record<string, unknown>;
  };
  const refusal = async (payload: IdeasPayload) => {
    const answer = await ideasCommand(deps, payload);
    if (answer.ok) throw new Error(`${payload.action} was accepted`);
    return answer.error;
  };
  return { repositories, deps, seed, call, refusal };
}

describe("ideas command", () => {
  it("lists active ideas with the ledger and the last run, and chips from the best", async () => {
    const { seed, call } = await fixture({ nextRunAt: async () => "2026-10-20T08:00:00.000Z" });
    await seed([draft("travel.a"), draft("travel.b"), draft("travel.c"), draft("travel.d")]);
    const listed = await call({ action: "list" });
    expect((listed["ideas"] as { key: string }[]).map((idea) => idea.key)).toEqual(["travel.a", "travel.b", "travel.c", "travel.d"]);
    expect(listed).toMatchObject({
      mutedCategories: [],
      excludedBasis: [],
      lastRun: { id: "run-default" },
      nextAt: "2026-10-20T08:00:00.000Z",
    });
    expect(await call({ action: "chips" })).toEqual({
      chips: ["a", "b", "c"].map((name) => ({
        ideaId: `default-travel.${name}`,
        label: `Try travel.${name}`,
        prompt: `Help me with travel.${name}.`,
        uses: [{ capability: "web", approval: false }],
      })),
    });
    expect((await call({ action: "chips", limit: 1 }))["chips"]).toHaveLength(1);
  });

  it("offers its own chips in the workspace's language: the label, and the prompt the person sends", async () => {
    const { repositories, call } = await fixture({
      census: async () => ["web", "reminders", "travel"],
      continueChat: async () => ({ taskId: "task-1", title: "Бюджет за пътуването" }),
    });
    await repositories.workspaceSettings.set({
      workspaceId: "default",
      settings: { locale: "bg" },
      expectedRevision: (await repositories.workspaceSettings.get("default")).revision,
      actor: "operator",
      now: NOW.toISOString(),
    });
    expect(await call({ action: "chips" })).toEqual({
      chips: [
        { taskId: "task-1", label: "Продължи: Бюджет за пътуването", prompt: "Да продължим „Бюджет за пътуването“." },
        { label: "Търси в мрежата", prompt: "Потърси в мрежата за [тема] и обобщи какво намираш." },
        { label: "Намери полети", prompt: "Намери най-евтините полети от [откъде] до [докъде] около [дати]." },
      ],
    });
  });

  it("says a built-in idea stored before a language change in the new language, and a reworded one as written", async () => {
    const { repositories, seed, call } = await fixture({ ideaWords: ideaWordsIn });
    const fares = IDEA_CATALOGUE.find((template) => template.key === "travel.fare-watch");
    if (fares === undefined) throw new Error("travel.fare-watch is not in the catalogue");
    const english = catalogueIdea(fares);
    await seed([english, draft("travel.own")]);
    await repositories.workspaceSettings.set({
      workspaceId: "default",
      settings: { locale: "bg" },
      expectedRevision: (await repositories.workspaceSettings.get("default")).revision,
      actor: "operator",
      now: NOW.toISOString(),
    });
    const bulgarian = catalogueIdea(fares, "bg");
    const listed = (await call({ action: "list" }))["ideas"] as { key: string; title: string; prompt: string }[];
    expect(listed.map(({ key, title, prompt }) => ({ key, title, prompt }))).toEqual([
      { key: "travel.fare-watch", title: bulgarian.title, prompt: bulgarian.prompt },
      { key: "travel.own", title: "I can help with travel.own", prompt: "Help me with travel.own." },
    ]);
    expect((await call({ action: "chips" }))["chips"]).toEqual([
      expect.objectContaining({ label: bulgarian.label, prompt: bulgarian.prompt }),
      expect.objectContaining({ label: "Try travel.own" }),
    ]);
    expect(await call({ action: "try", id: "default-travel.fare-watch" })).toMatchObject({ prompt: bulgarian.prompt });
  });

  it("with no ideas to offer, chips for what Tavi can do here; Continue first for a recent chat; never more than three", async () => {
    let latest: { taskId: string; title: string } | undefined;
    const { seed, call } = await fixture({ census: async () => ["memory", "pdf", "web", "reminders"], continueChat: async () => latest });
    expect(await call({ action: "chips" })).toEqual({
      chips: [
        { label: "Search the web", prompt: "Search the web for [topic] and summarise what you find." },
        { label: "Set a reminder", prompt: "Remind me to [thing] at [time]." },
        { label: "Summarise a PDF", prompt: "Summarise the attached PDF and list its key points." },
      ],
    });
    latest = { taskId: "task-1", title: "Trip budget" };
    await seed([draft("travel.a"), draft("travel.b"), draft("travel.c")]);
    expect(await call({ action: "chips" })).toEqual({
      chips: [
        { taskId: "task-1", label: "Continue: Trip budget", prompt: 'Let\'s continue "Trip budget".' },
        expect.objectContaining({ ideaId: "default-travel.a" }),
        expect.objectContaining({ ideaId: "default-travel.b" }),
      ],
    });
    // A chat set aside with Don't use this, or chats switched off, is not offered to continue.
    await call({ action: "feedback", signal: "exclude-basis", basisRef: "task-1" });
    expect(((await call({ action: "chips" }))["chips"] as { label: string }[])[0]?.label).not.toBe("Continue: Trip budget");
    await call({ action: "feedback", signal: "include-basis", basisRef: "task-1" });
    await call({ action: "set-settings", changes: { sources: { tasks: false } } });
    expect(((await call({ action: "chips" }))["chips"] as { label: string }[])[0]?.label).not.toBe("Continue: Trip budget");
    await call({ action: "set-settings", changes: { sources: { tasks: true } } });
    // Ideas off: the capability chips still help; chips off: none at all.
    await call({ action: "set-settings", changes: { enabled: false } });
    expect(((await call({ action: "chips" }))["chips"] as { label: string }[]).map((chip) => chip.label)).toEqual([
      "Continue: Trip budget",
      "Search the web",
      "Set a reminder",
    ]);
    await call({ action: "set-settings", changes: { chips: false } });
    expect(await call({ action: "chips" })).toEqual({ chips: [] });
  });

  it("offers no chips while ideas or chips are off", async () => {
    const { seed, call } = await fixture();
    await seed([draft("travel.a")]);
    await call({ action: "set-settings", changes: { chips: false } });
    expect(await call({ action: "chips" })).toEqual({ chips: [] });
    await call({ action: "set-settings", changes: { chips: true, enabled: false } });
    expect(await call({ action: "chips" })).toEqual({ chips: [] });
  });

  it("a muted section or an excluded basis leaves the list and the chips at once", async () => {
    const { seed, call } = await fixture();
    await seed([
      draft("travel.a"),
      draft("shopping.b", { category: "shopping", icon: "🛒" }),
      draft("travel.c", { basis: [{ kind: "memory", ref: "mem-2" }] }),
    ]);
    await call({ action: "feedback", signal: "mute-category", category: "shopping" });
    await call({ action: "feedback", signal: "exclude-basis", id: "default-travel.c", basisRef: "mem-2" });
    expect((await call({ action: "list" }))["ideas"]).toEqual([expect.objectContaining({ key: "travel.a" })]);
    expect(await call({ action: "chips" })).toEqual({ chips: [expect.objectContaining({ ideaId: "default-travel.a" })] });
    await call({ action: "feedback", signal: "unmute-category", category: "shopping" });
    // The mute expired what it hid: unmuting lets a later run offer that section again, not the old rows.
    expect(((await call({ action: "list" }))["ideas"] as { key: string }[]).map((idea) => idea.key)).toEqual(["travel.a"]);
  });

  it("try hands back the prompt and marks the idea tried, and nothing else", async () => {
    const { seed, call, repositories } = await fixture();
    await seed([draft("travel.a")]);
    expect(await call({ action: "try", id: "default-travel.a" })).toMatchObject({
      prompt: "Help me with travel.a.",
      idea: { status: "tried" },
    });
    expect(await repositories.reminders.list({ workspaceId: "default", statuses: ["active"], limit: 10 })).toMatchObject({ reminders: [] });
  });

  it("an idea of another workspace, or a workspace this owner does not serve, is not found", async () => {
    const { seed, refusal } = await fixture();
    await seed([draft("travel.a")], "other");
    expect(await refusal({ action: "try", id: "other-travel.a" })).toMatchObject({ code: "NOT_FOUND" });
    expect(await refusal({ action: "list", workspaceId: "elsewhere" })).toMatchObject({ code: "NOT_FOUND" });
  });

  it("feedback steers the ledger: not now, not interested, a muted section, an excluded basis", async () => {
    const { seed, call, refusal, repositories } = await fixture();
    await seed([draft("travel.a"), draft("travel.b"), draft("shopping.c", { category: "shopping", icon: "🛒" }), draft("travel.d")]);
    expect(await call({ action: "feedback", signal: "not-now", id: "default-travel.a" })).toMatchObject({
      idea: { status: "snoozed", snoozedUntil: new Date(NOW.getTime() + IDEA_SNOOZE_MS).toISOString() },
    });
    expect(await call({ action: "feedback", signal: "not-interested", id: "default-travel.b" })).toMatchObject({
      idea: { status: "dismissed" },
    });
    await call({ action: "feedback", signal: "mute-category", id: "default-shopping.c" });
    expect(await refusal({ action: "feedback", signal: "exclude-basis", id: "default-travel.d", basisRef: "mem-9" })).toMatchObject({
      code: "INVALID_INPUT",
    });
    await call({ action: "feedback", signal: "more-like-this", id: "default-travel.d" });
    // An edit is recorded by the owner from the chat an idea started, never sent by a client.
    expect(
      await refusal({ action: "feedback", signal: "edited", id: "default-travel.d", editedPrompt: "Help me with d, in June." } as never),
    ).toMatchObject({ code: "INVALID_INPUT" });
    await repositories.ideas.seedChat({
      id: "s-d",
      workspaceId: "default",
      ideaId: "default-travel.d",
      taskId: "task-d",
      sent: "Help me with d, in June.",
      now: NOW.toISOString(),
    });
    await call({ action: "feedback", signal: "exclude-basis", id: "default-travel.d", basisRef: "mem-1" });
    expect(await repositories.ideas.ledger("default", NOW.toISOString())).toMatchObject({
      // Excluding mem-1 also ended the snoozed travel.a, which rested on it.
      dismissedKeys: ["travel.b"],
      snoozedKeys: [],
      mutedCategories: ["shopping"],
      excludedBasis: ["mem-1"],
      boostedKeys: ["travel.d"],
      examples: ["Help me with d, in June."],
    });
    await call({ action: "feedback", signal: "include-basis", basisRef: "mem-1" });
    await call({ action: "feedback", signal: "unmute-category", category: "shopping" });
    expect(await call({ action: "list" })).toMatchObject({ mutedCategories: [], excludedBasis: [] });
    // Only the dismissal is left to forget: the snooze ended with the exclusion, and the exclusion was taken back.
    expect(await call({ action: "reset", what: "ledger" })).toEqual({ cleared: 1 });
    expect(await call({ action: "reset", what: "categories" })).toEqual({ cleared: 0 });
  });

  it("restores a dismissed idea, and a dismissal from a stale tab still counts", async () => {
    const { seed, call, repositories } = await fixture();
    await seed([draft("travel.a"), draft("travel.z")]);
    await call({ action: "feedback", signal: "not-interested", id: "default-travel.a" });
    expect(await call({ action: "restore", id: "default-travel.a" })).toMatchObject({ idea: { status: "active" } });
    // Weeks on, the tab still shows travel.z, which has since expired: the dismissal reaches the ledger anyway.
    const late = new Date(NOW.getTime() + 2 * IDEA_TTL_MS);
    const answer = await ideasCommand(
      { repositories, principalOf: () => "operator", now: () => late },
      { action: "feedback", signal: "not-interested", id: "default-travel.z" },
    );
    expect(answer).toMatchObject({ ok: true, result: { idea: { status: "dismissed" } } });
    expect((await repositories.ideas.ledger("default", late.toISOString())).dismissedKeys).toEqual(["travel.z"]);
  });

  it("hides an idea whose capability left the census, in the list and the chips", async () => {
    const { seed, call } = await fixture({ census: async () => ["web", "memory"] });
    await seed([draft("travel.a"), draft("travel.f", { uses: [{ capability: "travel", approval: false }] })]);
    expect(((await call({ action: "list" }))["ideas"] as { key: string }[]).map((idea) => idea.key)).toEqual(["travel.a"]);
    expect(((await call({ action: "chips" }))["chips"] as { ideaId: string }[]).map((chip) => chip.ideaId)).toEqual(["default-travel.a"]);
  });

  it("chooses a provider only among those installed, and retires the old one's unpinned ideas", async () => {
    const providers = [
      { id: "tavi.ideasagent", kind: "builtin" as const, receives: ["memory", "tasks", "brief", "ledger"] as const, ready: true },
      { id: "acme.ideas", kind: "plugin" as const, receives: ["ledger"] as const, ready: true, disclosure: "Sends nothing anywhere." },
    ].map((provider) => ({ ...provider, receives: [...provider.receives] }));
    const { seed, call, refusal } = await fixture({ providers: () => providers });
    await seed([draft("travel.a"), draft("travel.p")]);
    await call({ action: "pin", id: "default-travel.p" });
    expect(await call({ action: "list" })).toMatchObject({ provider: "tavi.ideasagent", providers });
    expect(await refusal({ action: "set-settings", changes: { provider: "nope.ideas" } })).toMatchObject({ code: "NOT_FOUND" });
    expect(await call({ action: "set-settings", changes: { provider: "acme.ideas" } })).toMatchObject({
      settings: { provider: "acme.ideas", enabled: true },
    });
    expect(((await call({ action: "list" }))["ideas"] as { key: string }[]).map((idea) => idea.key)).toEqual(["travel.p"]);
    // Turning ideas off keeps the provider chosen.
    expect(await call({ action: "set-settings", changes: { enabled: false } })).toMatchObject({
      settings: { provider: "acme.ideas", enabled: false },
    });
    expect(await (await fixture()).refusal({ action: "set-settings", changes: { provider: "acme.ideas" } })).toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("pins, and drafts a routine only for an idea that repeats", async () => {
    const { seed, call, refusal } = await fixture({
      routineExists: async (_workspaceId, principalId, routineId) => principalId === "operator" && routineId === "routine-1",
    });
    await seed([
      draft("travel.a"),
      draft("travel.b", { recurring: { cadence: "weekly" } }),
      draft("travel.c", { recurring: { cadence: "daily" } }),
    ]);
    expect(await call({ action: "pin", id: "default-travel.a" })).toMatchObject({ idea: { pinned: true } });
    expect(await call({ action: "unpin", id: "default-travel.a" })).toMatchObject({ idea: { pinned: false } });
    expect(await refusal({ action: "recur", id: "default-travel.a" })).toMatchObject({ code: "INVALID_INPUT" });
    const noRoutines = await fixture({ census: async () => ["web"] });
    await noRoutines.seed([draft("travel.b", { recurring: { cadence: "weekly" } })]);
    expect(await noRoutines.refusal({ action: "recur", id: "default-travel.b" })).toMatchObject({ code: "UNAVAILABLE" });
    expect(await call({ action: "recur", id: "default-travel.b" })).toEqual({
      draft: { name: "Try travel.b", prompt: "Help me with travel.b.", cadence: "weekly" },
    });
    // Created through routines: the idea is done; one that does not repeat is not.
    expect(await call({ action: "made-recurring", id: "default-travel.b", routineId: "routine-1" })).toMatchObject({
      idea: { status: "done" },
    });
    expect(await refusal({ action: "made-recurring", id: "default-travel.a", routineId: "routine-1" })).toMatchObject({
      code: "INVALID_INPUT",
    });
    // A routine that does not exist closes nothing.
    expect(await refusal({ action: "made-recurring", id: "default-travel.c", routineId: "made-up" })).toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not draft a monthly idea as a routine, which repeats only daily or weekly", async () => {
    const { seed, refusal } = await fixture();
    await seed([draft("travel.m", { recurring: { cadence: "monthly" } })]);
    expect(await refusal({ action: "recur", id: "default-travel.m" })).toMatchObject({
      code: "UNAVAILABLE",
      message: "A routine cannot repeat monthly yet; set a reminder instead",
    });
  });

  it("remind says the idea in the app and never runs its prompt; only for an idea still offered, where reminders run", async () => {
    const { seed, call, refusal, repositories } = await fixture();
    await seed([draft("travel.a"), draft("travel.b")]);
    const { reminderId } = (await call({ action: "remind", id: "default-travel.a", at: "2026-10-20T09:00:00.000Z" })) as {
      reminderId: string;
    };
    const reminder = await repositories.reminders.get(reminderId);
    expect(reminder).toMatchObject({
      text: "Try travel.a: Help me with travel.a.",
      deliverTo: { kind: "app" },
      createdBy: "user",
      principalId: "operator",
    });
    expect(reminder?.prompt).toBeUndefined();
    await call({ action: "feedback", signal: "not-interested", id: "default-travel.b" });
    expect(await refusal({ action: "remind", id: "default-travel.b", at: "2026-10-20T09:00:00.000Z" })).toMatchObject({ code: "CONFLICT" });
    const noReminders = await fixture({ census: async () => ["web"] });
    await noReminders.seed([draft("travel.c")]);
    expect(await noReminders.refusal({ action: "remind", id: "default-travel.c", at: "2026-10-20T09:00:00.000Z" })).toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("refresh needs a host, and passes its answer and its refusal on", async () => {
    expect(await (await fixture()).refusal({ action: "refresh" })).toMatchObject({ code: "UNAVAILABLE" });
    const { call } = await fixture({ refresh: async () => "busy" });
    expect(await call({ action: "refresh" })).toEqual({ status: "busy" });
    // The hour's limit is the store's, counted as the run starts: the host's refusal reaches the person as it is.
    const limited = await fixture({
      refresh: async () => {
        throw new TaviError("QUOTA_EXCEEDED", "Ideas were refreshed 3 times in the last hour; at most 3 are allowed");
      },
    });
    expect(await limited.refusal({ action: "refresh" })).toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("keeps a pinned idea in a muted section on the list, so it can be unpinned", async () => {
    const { seed, call } = await fixture();
    await seed([draft("shopping.p", { category: "shopping", icon: "🛒" }), draft("shopping.q", { category: "shopping", icon: "🛒" })]);
    await call({ action: "pin", id: "default-shopping.p" });
    await call({ action: "feedback", signal: "mute-category", category: "shopping" });
    expect(((await call({ action: "list" }))["ideas"] as { key: string }[]).map((idea) => idea.key)).toEqual(["shopping.p"]);
    // Listed so it can be unpinned, never offered as a chip.
    expect(await call({ action: "chips" })).toEqual({ chips: [] });
  });

  it("stops quoting the brief when it is rewritten, and memory when it is switched off", async () => {
    const { seed, call, repositories } = await fixture();
    await call({ action: "set-brief", text: "More garden." });
    await seed([
      draft("travel.b", { basis: [{ kind: "brief", ref: "brief", excerpt: "More garden." }] }),
      draft("travel.m", { basis: [{ kind: "memory", ref: "mem-1", excerpt: "Lisbon" }] }),
    ]);
    await call({ action: "set-brief", text: "Nothing about money." });
    const keys = async () => (await repositories.ideas.list({ workspaceId: "default", now: NOW.toISOString() })).map((idea) => idea.key);
    expect(await keys()).toEqual(["travel.m"]);
    await call({ action: "set-settings", changes: { sources: { memory: false } } });
    expect(await keys()).toEqual([]);
  });

  it("reads and writes the brief and the settings, a change keeping what it does not name", async () => {
    const { call } = await fixture();
    expect(await call({ action: "brief" })).toEqual({ text: "" });
    expect(await call({ action: "set-brief", text: "More about the garden." })).toEqual({ text: "More about the garden." });
    expect(await call({ action: "settings" })).toEqual({ settings: IDEA_DEFAULT_SETTINGS });
    expect(
      await call({ action: "set-settings", changes: { sources: { memory: false }, digest: { channel: "telegram", weekday: 1 } } }),
    ).toEqual({
      settings: {
        ...IDEA_DEFAULT_SETTINGS,
        sources: { memory: false, tasks: true, brief: true },
        digest: { channel: "telegram", weekday: 1 },
      },
    });
    expect(await call({ action: "set-settings", changes: { digest: null } })).toEqual({
      settings: { ...IDEA_DEFAULT_SETTINGS, sources: { memory: false, tasks: true, brief: true } },
    });
    expect(await call({ action: "brief" })).toEqual({ text: "More about the garden." });
  });

  it("lets a page steer but not switch the provider or the digest, or change the hours or the budget, and says whether a fast model is set", async () => {
    const { call, refusal } = await fixture({
      fromBridge: true,
      providers: () => [
        { id: "tavi.ideasagent", kind: "builtin", receives: [], ready: true },
        { id: "acme.ideas", kind: "plugin", receives: ["memory"], ready: true },
      ],
      modelSet: async () => false,
    });
    expect(await refusal({ action: "set-settings", workspaceId: "default", changes: { provider: "acme.ideas" } })).toMatchObject({
      code: "NOT_AUTHORIZED",
    });
    expect(await refusal({ action: "set-settings", workspaceId: "default", changes: { digest: null } })).toMatchObject({
      code: "NOT_AUTHORIZED",
    });
    expect(
      await refusal({ action: "set-settings", workspaceId: "default", changes: { hours: { start: "07:00", end: "22:00" } } }),
    ).toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(await refusal({ action: "set-settings", workspaceId: "default", changes: { dailyTokens: 0 } })).toMatchObject({
      code: "NOT_AUTHORIZED",
    });
    // Nor what a provider reading the person's notes may prepare unattended.
    expect(await refusal({ action: "set-settings", workspaceId: "default", changes: { prepareExternal: true } })).toMatchObject({
      code: "NOT_AUTHORIZED",
    });
    expect(
      await call({ action: "set-settings", workspaceId: "default", changes: { provider: "tavi.ideasagent", chips: false } }),
    ).toMatchObject({ settings: { provider: "tavi.ideasagent", chips: false } });
    expect(await call({ action: "list", workspaceId: "default" })).toMatchObject({ modelSet: false });
  });

  it("turns prepareExternal off when the workspace switches providers, unless it is set with the switch", async () => {
    const { call } = await fixture({
      providers: () => [
        { id: "tavi.ideasagent", kind: "builtin", receives: [], ready: true },
        { id: "acme.ideas", kind: "plugin", receives: ["memory"], ready: true },
      ],
    });
    await call({ action: "set-settings", workspaceId: "default", changes: { prepareExternal: true } });
    expect(await call({ action: "set-settings", workspaceId: "default", changes: { provider: "acme.ideas" } })).toMatchObject({
      settings: { provider: "acme.ideas", prepareExternal: false },
    });
    expect(
      await call({ action: "set-settings", workspaceId: "default", changes: { provider: "tavi.ideasagent", prepareExternal: true } }),
    ).toMatchObject({ settings: { provider: "tavi.ideasagent", prepareExternal: true } });
  });

  it("links a chat to the idea that started it only for the operator, and marks it done only when the turn completed", async () => {
    const { seed, deps } = await fixture();
    const [stored] = await seed([draft("travel.a")]);
    const idea = stored!;
    const repositories = deps.repositories;
    const modes: Record<string, string | undefined> = { "task-private": "private", "task-off": "off" };
    const memoryModeOf = async (taskId: string) => modes[taskId];
    await ideaChatSeeded(
      { ...deps, memoryModeOf, newId: () => "x1" },
      { workspaceId: "default", principalId: "someone-else", ideaId: idea.id, taskId: "task-1", sent: "Mine" },
    );
    expect((await repositories.ideas.ledger("default", NOW.toISOString())).examples).toEqual([]);
    // A private or memory-off chat is never linked, and its words are never kept.
    for (const taskId of ["task-private", "task-off"])
      await ideaChatSeeded(
        { ...deps, memoryModeOf, newId: () => taskId },
        { workspaceId: "default", principalId: "operator", ideaId: idea.id, taskId, sent: "Private words" },
      );
    expect((await repositories.ideas.ledger("default", NOW.toISOString())).examples).toEqual([]);
    await ideaChatSeeded(
      { ...deps, memoryModeOf, newId: () => "x2" },
      { workspaceId: "default", principalId: "operator", ideaId: idea.id, taskId: "task-1", sent: "Mine" },
    );
    expect((await repositories.ideas.ledger("default", NOW.toISOString())).examples).toEqual(["Mine"]);
    let status = "failed";
    const tasks = { get: async () => ({ status }) } as unknown as Parameters<typeof ideaChatEnded>[0]["tasks"];
    await ideaChatEnded({ ideas: repositories.ideas, tasks }, "task-1", "d1", NOW.toISOString());
    expect((await repositories.ideas.get("default", idea.id))?.status).toBe("active");
    status = "completed";
    await ideaChatEnded({ ideas: repositories.ideas, tasks }, "task-1", "d2", NOW.toISOString());
    expect((await repositories.ideas.get("default", idea.id))?.status).toBe("done");
  });

  it("gives the first turn of a chat started from a prepared idea its answer, only the operator's and only while fresh", async () => {
    const { seed, deps } = await fixture();
    const [first, second] = await seed([draft("travel.a"), draft("travel.b")]);
    const ideas = deps.repositories.ideas;
    await ideas.prepared({ workspaceId: "default", ideaId: first!.id, taskId: "prep-1", text: "Cheapest: €120.", now: NOW.toISOString() });
    await ideas.prepared({
      workspaceId: "default",
      ideaId: second!.id,
      taskId: "prep-2",
      text: "Old news.",
      now: new Date(NOW.getTime() - 25 * 60 * 60_000).toISOString(),
    });
    expect(await ideaPreparedAnswer(deps, "default", "operator", first!.id)).toEqual({
      title: "I can help with travel.a",
      text: "Cheapest: €120.",
    });
    expect(await ideaPreparedAnswer(deps, "default", "operator", second!.id)).toBeUndefined();
    expect(await ideaPreparedAnswer(deps, "default", "someone-else", first!.id)).toBeUndefined();
  });
});
