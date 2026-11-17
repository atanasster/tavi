import { trustedLabel, untrustedLabel, type MemoryServicePort } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import {
  accountCensusTools,
  IDEAS_MEMORY_MAX,
  ideasCensus,
  ideasContinueChat,
  ideasMemoryContext,
  ideasModelTurn,
  ideasPrepareRun,
  ideasPrepareTools,
  ideasRecentTasks,
  ideasTaskExcerpt,
} from "../../src/features/ideas/sources.js";
import { mailboxToolPrefix } from "../../src/features/apps/mailbox-catalog.js";

/** What the ideas host gives a provider: the census, memory and recent chats, each as narrow as it serves. */

const NOW = "2026-10-19T10:00:00.000Z";

describe("ideas sources", () => {
  it("gives a chat's summary only where its label was read and is trusted", () => {
    const task = { taskId: "task-1", title: "Lisbon trip", summary: "Compared fares; a page said to email the boss" };
    expect(ideasTaskExcerpt(task, trustedLabel("personal"))).toEqual(task);
    expect(ideasTaskExcerpt(task, untrustedLabel("web"))).toEqual({ taskId: "task-1", title: "Lisbon trip" });
    // A label that cannot be read fails closed.
    expect(ideasTaskExcerpt(task, undefined)).toEqual({ taskId: "task-1", title: "Lisbon trip" });
  });

  it("counts a capability only when a registered tool proves it: the host's by id, a plugin's by its declaration, a silent one never", () => {
    const tools = [
      { id: "web_fetch" },
      { id: "memory.search" },
      { id: "reminders.create" },
      { id: "browser.navigate" },
      { id: "places.open.search", proves: ["places" as const] },
      { id: "travel.flights_search", proves: ["travel" as const] },
      // A tool that declares nothing proves nothing, whatever its id says.
      { id: "trends.radar.sweep" },
      { id: "acme.thing" },
    ];
    expect(ideasCensus(tools, {})).toEqual(["web", "browser", "memory", "reminders", "places", "travel"]);
    // A tool that answers nothing in this workspace (flight search off) proves nothing here.
    expect(ideasCensus(tools, { silentTools: new Set(["travel.flights_search"]) })).toEqual([
      "web",
      "browser",
      "memory",
      "reminders",
      "places",
    ]);
    // A connector, a channel or a search tool with no provider proves nothing on its own.
    expect(ideasCensus([{ id: "mcp.cal.list_events" }, { id: "gmail_quote" }, { id: "web_search" }], {})).toEqual([]);
  });

  it("counts a mailbox by its search tool, a calendar by its list_events tool, the smart home by its preset's tools, and channels by what they declare", () => {
    const tools = [
      "gmail.work.search",
      "gmail.work.read",
      "gmail.other.search",
      "gmail.work.list_events",
      "mcp.home.turn_on",
      "mcp.maps.search",
    ].map((id) => ({ id }));
    const presets = new Map([
      ["home", "homeassistant"],
      ["maps", "google-maps"],
      ["gone", "homeassistant"],
    ]);
    expect(
      ideasCensus(tools, {
        presets,
        mailboxSearchTools: new Set(["gmail.work.search"]),
        calendarTools: new Set(["gmail.work.list_events"]),
        // Telegram's and Discord's descriptors declare messaging; Mailgun's nothing.
        channels: [["messaging"], ["messaging"], []],
      }),
    ).toEqual(["mailbox", "calendar", "home", "messaging"]);
    // Another workspace's mailbox or calendar, a server not allowed here (left out of presets), or one with no tools registered prove nothing.
    expect(
      ideasCensus(tools, {
        presets: new Map([["gone", "homeassistant"]]),
        mailboxSearchTools: new Set(["gmail.mine.search"]),
        calendarTools: new Set(["gmail.mine.list_events"]),
      }),
    ).toEqual([]);
  });

  it("counts a Google account's mailbox and calendar only once it is signed in, not while its setup waits", () => {
    const account = (connectionId: string, authState: "none" | "connected" | "expired") => ({
      providerId: "gmail",
      connectionId,
      authState,
    });
    const census = (states: readonly ("none" | "connected" | "expired")[]) => {
      const connections = states.map((state, index) => account(`gmail-${String(index)}`, state));
      const accountTools = accountCensusTools(connections, () => ({ mailbox: true, calendar: true }));
      const tools = connections.flatMap((connection) =>
        ["search", "list_events"].map((tool) => ({ id: `${mailboxToolPrefix("gmail", connection.connectionId)}${tool}` })),
      );
      return ideasCensus(tools, accountTools);
    };
    expect(census(["none"])).toEqual([]);
    expect(census(["expired"])).toEqual([]);
    expect(census(["none", "connected"])).toEqual(["mailbox", "calendar"]);
  });

  it("reads own-scope preferences, facts and lessons that recall would use: not past, not sensitive, not on a revoked source", async () => {
    const record = (recordId: string, overrides: Record<string, unknown> = {}) => ({
      recordId,
      kind: "fact",
      sensitivity: "normal",
      status: "approved",
      scope: { kind: "personal" },
      currentRevisionId: `rev-${recordId}`,
      currentRevision: { revisionId: `rev-${recordId}` },
      ...overrides,
    });
    const listed = [
      record("a"),
      record("pref", { kind: "preference" }),
      record("sensitive", { sensitivity: "sensitive" }),
      record("shared", { scope: { kind: "shared_workspace" } }),
      // A run's own memory (invariant 1): never read, whatever else it is.
      record("runlocal", { scope: { kind: "run_local", runId: "run-1" } }),
      record("past", { validTo: "2026-01-01T00:00:00.000Z" }),
      record("revoked"),
      ...Array.from({ length: 60 }, (_, index) => record(`more-${index}`)),
    ];
    const asked: { list?: unknown; eligible: string[] } = { eligible: [] };
    const batches: number[] = [];
    const memory = {
      list: (input: unknown) => ((asked.list = input), listed),
      // Search's own filters: a revoked source is left out here, as recall leaves it out.
      eligible: (input: { recordIds: readonly string[] }) => (
        batches.push(input.recordIds.length),
        asked.eligible.push(...input.recordIds),
        input.recordIds
          .filter((recordId) => recordId !== "revoked")
          .map((recordId) => ({
            recordId,
            revisionId: `rev-${recordId}`,
            scope: { kind: "personal" },
            kind: "fact",
            title: `Title ${recordId}`,
            snippet: `Body ${recordId}`,
            recordedAt: NOW,
            superseded: false,
            conflict: false,
          }))
      ),
    } as unknown as Pick<MemoryServicePort, "list" | "eligible">;
    const excerpts = await ideasMemoryContext(memory, { workspaceId: "default", principalId: "operator" }, NOW);
    // More candidates than one `eligible` call takes are asked in batches of MEMORY_SEARCH_MAX.
    expect(batches.every((size) => size <= 50)).toBe(true);
    expect(batches.length).toBeGreaterThan(1);
    expect(asked.eligible).not.toContain("sensitive");
    expect(asked.eligible).not.toContain("shared");
    expect(asked.eligible).not.toContain("runlocal");
    expect(asked.eligible).not.toContain("past");
    expect(excerpts.map((excerpt) => excerpt.recordId)).not.toContain("revoked");
    expect(excerpts).toHaveLength(IDEAS_MEMORY_MAX);
    // A preference is the person's profile: it comes before a passing fact.
    expect(excerpts.slice(0, 2)).toEqual([
      { recordId: "pref", revisionId: "rev-pref", kind: "preference", text: "Title pref — Body pref" },
      { recordId: "a", revisionId: "rev-a", kind: "fact", text: "Title a — Body a" },
    ]);
    expect(asked.list).toMatchObject({
      kinds: ["preference", "fact", "lesson"],
      statuses: ["approved"],
      actor: { workspaceId: "default", principalId: "operator", caller: "ideas" },
    });
  });

  it("reads the person's profile first: core me.* facts, then preferences and lessons, before newer passing facts", async () => {
    const record = (recordId: string, kind: string, topicKey?: string) => ({
      recordId,
      kind,
      sensitivity: "normal",
      status: "approved",
      scope: { kind: "personal" },
      currentRevisionId: `rev-${recordId}`,
      currentRevision: { revisionId: `rev-${recordId}` },
      ...(topicKey === undefined ? {} : { topicKey }),
    });
    // Newest first, as the store lists them: 70 passing facts, then the profile, older.
    const listed = [
      ...Array.from({ length: 70 }, (_, index) => record(`passing-${index}`, "fact")),
      record("lesson", "lesson"),
      record("pref", "preference"),
      record("core", "fact", "me.hobby"),
    ];
    let limit: number | undefined;
    const memory = {
      list: (input: { limit?: number }) => ((limit = input.limit), listed),
      eligible: (input: { recordIds: readonly string[] }) =>
        input.recordIds.map((recordId) => ({
          recordId,
          revisionId: `rev-${recordId}`,
          scope: { kind: "personal" },
          title: recordId,
          snippet: "",
          recordedAt: NOW,
          superseded: false,
          conflict: false,
        })),
    } as unknown as Pick<MemoryServicePort, "list" | "eligible">;
    const excerpts = await ideasMemoryContext(memory, { workspaceId: "default", principalId: "operator" }, NOW);
    expect(limit).toBeGreaterThanOrEqual(listed.length);
    expect(excerpts).toHaveLength(IDEAS_MEMORY_MAX);
    expect(excerpts.slice(0, 4).map(({ recordId, kind }) => [recordId, kind])).toEqual([
      ["core", "fact"],
      ["pref", "preference"],
      ["lesson", "lesson"],
      ["passing-0", "fact"],
    ]);
  });

  it("never runs a provider's turn on the chat's main model: with no fast model bound it refuses", async () => {
    let called = 0;
    const turn = ideasModelTurn({
      principalOf: () => "operator",
      fastTarget: async () => undefined,
      models: { stream: async () => ((called += 1), { status: "completed", text: "{}", usage: {} }) as never },
      newId: () => "a1",
      now: () => NOW,
    });
    await expect(
      turn({ workspaceId: "default", runId: "irun-1" }, { system: "", user: "hi", maxOutputTokens: 100 }, new AbortController().signal),
    ).rejects.toThrow(/fast model/);
    expect(called).toBe(0);
  });

  it("gives only the person's own chats with a real title: no prompt line, messaging, run, worker or Home, no private or memory-off chat", () => {
    expect(
      ideasRecentTasks([
        { taskId: "new", title: "Garden plan", titleSource: "generated" },
        { taskId: "old", title: "Job offers", titleSource: "reader", summary: "Compared offers" },
        // Part of it forgotten: its summary may tell of what was erased, so only the title goes.
        {
          taskId: "partly-forgotten",
          title: "Trip budget",
          titleSource: "generated",
          summary: "Paid 400 for the hotel",
          summaryState: "pending",
        },
        { taskId: "prompt", title: "my bank pin is", titleSource: "prompt" },
        { taskId: "group", title: "Team chat", titleSource: "generated", origin: "messaging" },
        { taskId: "run", title: "Nightly report", titleSource: "generated", chatKind: "run" },
        { taskId: "worker", title: "Sub-task", titleSource: "generated", chatKind: "worker" },
        { taskId: "home", title: "Home", titleSource: "home", chatKind: "home" },
        { taskId: "private", title: "Doctor results", titleSource: "generated", memoryMode: "private" },
        { taskId: "off", title: "Taxes", titleSource: "generated", memoryMode: "off" },
        { taskId: "untitled", title: " ", titleSource: "generated" },
      ]),
    ).toEqual([
      { taskId: "new", title: "Garden plan" },
      { taskId: "old", title: "Job offers", summary: "Compared offers" },
      { taskId: "partly-forgotten", title: "Trip budget" },
    ]);
  });

  it("runs a provider's turn on the fast model as the operator, keeping no copy, and says what a failed one spent", async () => {
    const requests: { request: Record<string, unknown>; options: Record<string, unknown> }[] = [];
    let status: "completed" | "failed" = "completed";
    const turn = ideasModelTurn({
      principalOf: (workspaceId) => (workspaceId === "default" ? "operator" : undefined),
      fastTarget: async (workspaceId) => (workspaceId === "nofast" ? undefined : { connectionId: "conn", model: "small" }),
      models: {
        stream: async (request, options) =>
          (requests.push({ request: request as never, options: options as never }),
          {
            status,
            text: "{}",
            usage: { inputTokens: 300, outputTokens: 50 },
            ...(status === "failed" ? { error: { message: "stopped" } } : {}),
          }) as never,
      },
      newId: () => "a1",
      now: () => "2026-10-19T10:00:00.000Z",
    });
    const signal = new AbortController().signal;
    expect(await turn({ workspaceId: "default", runId: "irun-1" }, { system: "", user: "hi", maxOutputTokens: 500 }, signal)).toEqual({
      text: "{}",
      tokens: 350,
    });
    expect(requests[0]?.request).toMatchObject({
      connectionId: "conn",
      model: "small",
      runId: "irun-1",
      attemptId: "ideas-a1",
      maxOutputTokens: 500,
      tools: [],
      messages: [{ role: "user", text: "hi" }],
    });
    expect(requests[0]?.options).toMatchObject({
      keepRequest: false,
      context: { workspaceId: "default", principalId: "operator", runId: "irun-1", caller: "ideas" },
    });
    status = "failed";
    await expect(
      turn({ workspaceId: "default", runId: "irun-1" }, { system: "s", user: "hi", maxOutputTokens: 500 }, signal),
    ).rejects.toMatchObject({ message: "stopped", tokens: 350 });
    await expect(
      turn({ workspaceId: "nofast", runId: "irun-1" }, { system: "", user: "hi", maxOutputTokens: 500 }, signal),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("offers Continue for the newest own chat summarised in the last three days, and none older", () => {
    const now = new Date("2026-10-19T10:00:00.000Z");
    const row = (taskId: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
      taskId,
      title: `Chat ${taskId}`,
      titleSource: "generated",
      summary: "What it did.",
      summaryState: "ready",
      updatedAt,
      ...extra,
    });
    expect(
      ideasContinueChat(
        [
          row("dm", "2026-10-19T09:00:00.000Z", { origin: "messaging" }),
          row("private", "2026-10-19T08:00:00.000Z", { memoryMode: "private" }),
          row("pending", "2026-10-19T07:00:00.000Z", { summaryState: "pending" }),
          row("ok", "2026-10-17T10:00:00.000Z"),
        ],
        now,
      ),
    ).toEqual({ taskId: "ok", title: "Chat ok" });
    expect(ideasContinueChat([row("old", "2026-10-15T09:00:00.000Z")], now)).toBeUndefined();
    expect(ideasContinueChat([row("none", "2026-10-19T09:00:00.000Z", { summary: null })], now)).toBeUndefined();
  });

  it("offers a prepared step only the read-only tools its uses prove, and none when one is missing", () => {
    const tools = [
      { id: "web_search", effect: "read-only" },
      { id: "web_fetch", effect: "read-only" },
      { id: "places.open.search", effect: "read-only", proves: ["places" as const] },
      { id: "places.open.book", effect: "external", proves: ["places" as const] },
      { id: "travel.flights_search", effect: "read-only", proves: ["travel" as const] },
      { id: "fs.read", effect: "read-only" },
    ];
    expect(ideasPrepareTools(["web", "places"], tools)).toEqual(["places.open.search", "web_fetch", "web_search"]);
    expect(ideasPrepareTools(["travel"], tools)).toEqual(["travel.flights_search"]);
    expect(ideasPrepareTools(["web", "trends"], tools)).toEqual([]);
  });

  it("runs a prepared step as a tainted, unattended ideas run with only its read-only tools, a new admission each time", async () => {
    const admitted: Record<string, unknown>[] = [];
    let status: "completed" | "failed" = "completed";
    let now = "2026-10-19T10:00:00.000Z";
    const cancelled: string[] = [];
    const providers = new Map<string, string>();
    const seenProviders: (string | undefined)[] = [];
    let spent = 0;
    const run = ideasPrepareRun({
      principalOf: () => "operator",
      tools: () => [
        { id: "web_search", effect: "read-only" },
        { id: "web_fetch", effect: "read-only" },
        { id: "fs.write", effect: "write" },
      ],
      workflow: () => ({
        admit: async (input, options) => {
          admitted.push(input as never);
          await input.onAdmitted?.({ taskId: "prep-1", threadId: "t", created: true } as never);
          seenProviders.push(providers.get("prep-1"));
          await options?.onToolEvent?.({} as never);
          return { taskId: "prep-1", threadId: "t", created: true, replay: false, outcome: { status, finalText: "Found it." } };
        },
      }),
      cancel: async (taskId, reason) => void cancelled.push(`${taskId}: ${reason}`),
      tokensOf: async () => spent,
      providers,
      now: () => now,
    });
    const at = "2026-10-19T09:00:00.000Z";
    const chosen: Parameters<typeof run>[1] = {
      id: "idea-1",
      workspaceId: "default",
      runId: "run-1",
      providerId: "tavi.ideasagent",
      key: "travel.fares",
      category: "travel",
      icon: "✈️",
      title: "I can find fares",
      pitch: "Fares.",
      label: "Fares",
      prompt: "Find the cheapest flights from Sofia to Lisbon.",
      basis: [{ kind: "general", ref: "general" }],
      uses: [{ capability: "web", approval: false }],
      score: 0.5,
      status: "active",
      pinned: false,
      shownRuns: 0,
      createdAt: at,
      updatedAt: at,
      expiresAt: at,
    };
    expect(await run({ workspaceId: "default" }, chosen, new AbortController().signal)).toEqual({ taskId: "prep-1", text: "Found it." });
    expect(admitted[0]).toMatchObject({
      origin: "ideas",
      chatKind: "run",
      prompt: chosen.prompt,
      context: { workspaceId: "default", principalId: "operator", caller: "ideas", inheritedTaint: true },
      executionPolicy: { mode: "unattended", humanQuestionsAllowed: false, toolAllowlist: ["web_fetch", "web_search"] },
    });
    now = "2026-10-20T10:00:00.000Z";
    status = "failed";
    expect(await run({ workspaceId: "default" }, chosen, new AbortController().signal)).toBeUndefined();
    expect(admitted[1]?.["operationKey"]).not.toBe(admitted[0]?.["operationKey"]);
    // While it ran, its provider was named for the hooks; once done, no longer.
    expect(seenProviders[0]).toBe("tavi.ideasagent");
    expect(providers.size).toBe(0);
    // Past its reserve it is stopped, once.
    expect(cancelled).toEqual([]);
    spent = 20_000;
    status = "completed";
    await run({ workspaceId: "default" }, chosen, new AbortController().signal);
    expect(cancelled).toEqual(["prep-1: the idea's first step spent its share of the day's tokens"]);
    // An idea none of whose tools is here is not run.
    expect(
      await run({ workspaceId: "default" }, { ...chosen, uses: [{ capability: "trends", approval: false }] }, new AbortController().signal),
    ).toBeUndefined();
    expect(admitted).toHaveLength(3);
  });

  it("takes a prepared step from local data on the local model, saved before it runs", async () => {
    const order: string[] = [];
    const run = ideasPrepareRun({
      principalOf: () => "operator",
      tools: () => [{ id: "web_fetch", effect: "read-only" }],
      workflow: () => ({
        admit: async (input) => {
          await input.onAdmitted?.({ taskId: "prep-1", threadId: "t", created: true } as never);
          order.push("model call");
          return {
            taskId: "prep-1",
            threadId: "t",
            created: true,
            replay: false,
            outcome: { status: "completed", finalText: "Found it." },
          };
        },
      }),
      cancel: async () => {},
      tokensOf: async () => 0,
      providers: new Map(),
      now: () => NOW,
      localModel: {
        target: async () => ({ connectionId: "ollama", model: "llama" }),
        choose: async (scope, taskId, target) => void order.push(`${scope.workspaceId}/${taskId} on ${target.connectionId}`),
      },
    });
    const idea: Parameters<typeof run>[1] = {
      id: "idea-1",
      workspaceId: "default",
      runId: "run-1",
      providerId: "tavi.ideasagent",
      key: "k",
      category: "travel",
      icon: "✈️",
      title: "t",
      pitch: "p",
      label: "l",
      prompt: "Look it up.",
      basis: [{ kind: "general", ref: "general" }],
      uses: [{ capability: "web", approval: false }],
      score: 0.5,
      status: "active",
      pinned: false,
      shownRuns: 0,
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: NOW,
    };
    await run({ workspaceId: "default" }, idea, new AbortController().signal);
    expect(order).toEqual(["default/prep-1 on ollama", "model call"]);
  });
});
