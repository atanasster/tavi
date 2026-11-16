import { BUILTIN_MEMORY_DECLARATION, createBuiltinMemoryProvider } from "@tavi/plugin-defaults/memory";
import {
  BUILTIN_MEMORY_PROVIDER_ID,
  effectiveMemorySettings,
  memoryProvenanceLine,
  type EffectiveMemorySettings,
  type MemoryActor,
  type MemoryItem,
  type MemoryListAnswer,
  type MemoryPayload,
  type MemoryProvenance,
  type MemoryProvider,
  type MemoryScope,
  type ModelPort,
  type ModelRequest,
  type PluginMemoryDeclaration,
} from "@tavi/contracts";
import { fixturePromptPolicy } from "../support/prompt-policy.js";
import { MEMORY_CONSOLIDATION_ATTEMPT_PREFIX } from "@tavi/agent-host/workflow";
import { DatabaseClient, MemoryService } from "@tavi/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { decideMemoryRecord, keepAllPlain } from "../../src/features/memory/bulk.js";
import { memoryCommand } from "../../src/features/memory/owner.js";
import {
  consolidationProviderOf,
  consolidationSetDigest,
  createMemoryConsolidation,
  memoryConsolidationDoctor,
  memoryConsolidationFailureMark,
  memoryConsolidationMark,
  memoryConsolidationPersonalMark,
} from "../../src/features/memory/consolidation.js";
import { MemoryProviderRegistry } from "../../src/features/memory/providers.js";

/**
 * Weekly consolidation on the `tavi.memory` tick: off by default; at the first tick after 03:00 in the
 * workspace's zone, once a week per person; approved, normal records only,
 * personal ones in the person's oldest workspace with it on; drafts filed as
 * proposals that wait for a person — never approved by the run (invariants
 * 2 and 8); failures backed off and the week skipped after three.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Monday 12 October 2026, 01:30 in Lisbon (UTC+1): before the day's 03:00. */
const T0 = new Date("2026-10-12T00:30:00.000Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

const TIDY_MERGE = JSON.stringify({
  tidy: [
    {
      action: "merge",
      ids: ["m1", "m2"],
      title: "Garden",
      body: "Keeps a vegetable garden and grows tomatoes in it",
      reason: "the same garden",
    },
  ],
});

/** A model that answers consolidation calls with `answer` (or throws it); each call is kept. */
function scriptedModel(answer: () => string | Error = () => TIDY_MERGE) {
  const calls: { readonly request: ModelRequest; readonly keepRequest: unknown }[] = [];
  const model: ModelPort = {
    async stream(request, options) {
      if (!request.attemptId.startsWith(MEMORY_CONSOLIDATION_ATTEMPT_PREFIX)) throw new Error(`unexpected call ${request.attemptId}`);
      calls.push({ request, keepRequest: options.keepRequest });
      const text = answer();
      if (text instanceof Error) throw text;
      return { attemptId: request.attemptId, status: "completed", text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  return { model, calls };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

const operatorIn = (workspaceId: string): MemoryActor => ({ principalId: "operator", workspaceId, caller: "cli", authority: "operator" });

async function fixture(input: { readonly settings?: Partial<EffectiveMemorySettings>; readonly workspaces?: readonly string[] } = {}) {
  const store = await DatabaseClient.open({ databasePath: ":memory:", inMemory: true });
  closers.push(() => store.close());
  const repositories = store.asPort().repositories;
  const clock = { now: T0 };
  let ids = 0;
  const memory = new MemoryService(store.asPort(), { now: () => clock.now.toISOString(), newId: (prefix) => `${prefix}-${(ids += 1)}` });
  const workspaces = input.workspaces ?? ["default"];
  const settings: EffectiveMemorySettings = { ...effectiveMemorySettings(undefined), consolidation: "weekly", ...input.settings };
  const logs: { readonly message: string; readonly fields: Record<string, unknown> }[] = [];
  const providers = new MemoryProviderRegistry();
  providers.install(BUILTIN_MEMORY_PROVIDER_ID, {
    kind: "builtin",
    provider: createBuiltinMemoryProvider(),
    declaration: BUILTIN_MEMORY_DECLARATION,
  });
  /** The operator's Home in a workspace: where the run's mark is kept. */
  const home = async (workspaceId: string) =>
    (
      await repositories.tasks.admit({
        prompt: fixturePromptPolicy,
        workspaceId,
        principalId: "operator",
        operationKey: `home-${workspaceId}`,
        kind: "start",
        intent: { prompt: "home" },
        checkpointNamespace: "",
        origin: "web",
        chatKind: "home",
        now: T0.toISOString(),
        newTaskId: `home-${workspaceId}`,
        newThreadId: `thread-${workspaceId}`,
        newAdmissionId: `admission-${workspaceId}`,
      })
    ).task.taskId;
  for (const workspaceId of workspaces) await home(workspaceId);
  const keep = async (workspaceId: string, scope: MemoryScope, body: string, kind: "fact" | "lesson" = "fact") =>
    await memory.remember({ actor: operatorIn(workspaceId), scope, kind, body });
  const job = (
    model: ModelPort,
    settingsOf: (workspaceId: string) => EffectiveMemorySettings = () => settings,
    extra: Partial<Parameters<typeof createMemoryConsolidation>[0]> = {},
  ) =>
    createMemoryConsolidation({
      models: model,
      memory,
      repositories,
      workspaces: () => workspaces.map((workspaceId) => ({ workspaceId, principalId: "operator" })),
      peopleOf: () => ["operator"],
      memorySettings: async (workspaceId) => settingsOf(workspaceId),
      timezoneOf: async () => "Europe/Lisbon",
      providers,
      targetOf: async () => ({ connectionId: "fixture", model: "fixture-model" }),
      newId: (prefix) => `${prefix}-${(ids += 1)}`,
      now: () => clock.now,
      log: (message, fields) => logs.push({ message, fields }),
      ...extra,
    });
  const marks = async (workspaceId = "default") =>
    (await repositories.transcripts.memoryMarksSince({ workspaceId, kind: "consolidate", since: new Date(0).toISOString() }))
      .map((mark) => mark.mark)
      .sort();
  const proposals = async (workspaceId = "default") =>
    await memory.list({ actor: operatorIn(workspaceId), view: "operator", statuses: ["proposed"] });
  return { store, memory, clock, logs, keep, job, marks, proposals, providers };
}

const garden = (workspaceId = "default"): MemoryScope => ({ kind: "personal_workspace", principalId: "operator", workspaceId });

describe("weekly consolidation", () => {
  it("memory invariant 27: reads a local chat's record only on a local tidy-up model", async () => {
    const { clock, memory, job } = await fixture();
    await memory.remember({ actor: operatorIn("default"), scope: garden(), kind: "fact", body: "Keeps a vegetable garden" });
    await memory.remember({
      actor: operatorIn("default"),
      scope: garden(),
      kind: "fact",
      body: "Grows secret tomatoes in the garden",
      localOrigin: true,
    });
    await memory.remember({ actor: operatorIn("default"), scope: garden(), kind: "fact", body: "Waters the garden at dawn" });
    clock.now = at(2 * HOUR + 31 * 60_000);
    const remote = scriptedModel();
    await job(remote.model, undefined, { isLocal: async () => false }).tick();
    const prompt = remote.calls[0]?.request.messages.at(-1)?.text ?? "";
    expect(prompt).toContain("Keeps a vegetable garden");
    expect(prompt).not.toContain("secret tomatoes");
  });

  it("is off by default, and never runs while memory is paused", async () => {
    const { clock, keep, job, marks } = await fixture({ settings: { consolidation: "off" } });
    await keep("default", garden(), "Keeps a vegetable garden");
    await keep("default", garden(), "Grows tomatoes in the garden");
    const { model, calls } = scriptedModel();
    clock.now = at(10 * HOUR);
    await job(model).tick();
    await job(model, () => ({ ...effectiveMemorySettings(undefined), consolidation: "weekly", enabled: false })).tick();
    expect(calls).toEqual([]);
    expect(await marks()).toEqual([]);
  });

  it("memory invariant 2: runs at the first tick after 03:00 in the workspace's zone, once a week, filing tidy-ups that only ever wait for a person", async () => {
    const { clock, memory, keep, job, marks, proposals, logs } = await fixture();
    const first = await keep("default", garden(), "Keeps a vegetable garden");
    const second = await keep("default", garden(), "Grows tomatoes in the garden");
    await keep("default", { kind: "personal", principalId: "operator" }, "Takes the dog out at 7", "lesson");
    const { model, calls } = scriptedModel();
    const consolidation = job(model);
    // 02:59 in Lisbon: not yet.
    clock.now = at(HOUR + 29 * 60_000);
    await consolidation.tick();
    expect(calls).toHaveLength(0);
    clock.now = at(2 * HOUR + 31 * 60_000);
    await consolidation.tick();
    expect(calls).toHaveLength(1);
    const { request, keepRequest } = calls[0]!;
    expect(keepRequest).toBe(false);
    expect(request.purpose).toBe("extraction");
    expect(request.maxOutputTokens).toBe(2_000);
    const prompt = request.messages.at(-1)?.text ?? "";
    expect(prompt).toContain("Keeps a vegetable garden");
    expect(prompt).toContain("Takes the dog out at 7");
    // One proposal, by the consolidation's author, superseding both inputs once approved — never approved by the run.
    const waiting = await proposals();
    expect(waiting).toHaveLength(1);
    const tidy = waiting[0]!;
    expect(tidy.status).toBe("proposed");
    const history = await memory.history({ actor: operatorIn("default"), recordId: tidy.recordId });
    expect(history.revisions[0]?.author).toBe("provider:tavi.memoryprovider:consolidate");
    expect(history.reviews).toEqual([]);
    const related = await memory.related({ actor: operatorIn("default"), recordId: tidy.recordId });
    expect(related.supersedes?.map((entry) => entry.recordId)).toEqual([first.recordId, second.recordId]);
    // The run held the person's personal records, so it marks them run for every other workspace.
    expect(await marks()).toEqual([
      memoryConsolidationMark({ date: "2026-10-12", outcome: "claimed" }),
      memoryConsolidationMark({
        date: "2026-10-12",
        outcome: "ran",
        filed: 1,
        drafts: 1,
        dropped: { secret: 0, sensitive: 0, known: 0, invalid: 0 },
      }),
      memoryConsolidationPersonalMark("2026-10-12"),
      // What the run read, so an unchanged set is not sent again.
      expect.stringMatching(/^s2026-10-12;[a-f0-9]{32}$/),
    ]);
    expect(logs.find((entry) => entry.message === "memory consolidation ran")?.fields).toMatchObject({ drafts: 1, filed: 1 });
    expect(JSON.stringify(logs)).not.toContain("garden");
    // Once a week: not again that day, nor six days on.
    for (const later of [3 * HOUR, 6 * DAY + 3 * HOUR]) {
      clock.now = at(later);
      await consolidation.tick();
    }
    expect(calls).toHaveLength(1);
    // A week on, the records are as that run read them (the merge still waits): the week counts as run, unasked.
    clock.now = at(7 * DAY + 3 * HOUR);
    await consolidation.tick();
    expect(calls).toHaveLength(1);
    expect(await proposals()).toHaveLength(1);
    expect(logs.some((entry) => entry.message.startsWith("memory consolidation skipped: the records are as the last run read them"))).toBe(
      true,
    );
    // A skip writes no set mark, so the week after reads the set again: a date in its words may have passed.
    clock.now = at(14 * DAY + 3 * HOUR);
    await consolidation.tick();
    expect(calls).toHaveLength(2);
    // A run asked for now, the next day, runs over the same set: it is the person's ask.
    clock.now = at(15 * DAY + 3 * HOUR);
    await consolidation.consolidateNow({ workspaceId: "default" });
    expect(calls).toHaveLength(3);
    // Neither a bulk keep nor a card's, a channel's or a command's single Keep keeps it; the Center's Keep, with its
    // before and after, does, and the inputs are superseded, not deleted.
    const listed: MemoryItem = {
      ...tidy,
      target: "personal",
      title: null,
      body: null,
      redacted: false,
      truncated: false,
      sourceCount: 0,
      supersedes: related.supersedes ? [...related.supersedes] : [],
    };
    const bulk = await keepAllPlain([listed], async () => "done");
    expect(bulk).toEqual({ kept: [], needsLook: 1 });
    const decided = await decideMemoryRecord({
      record: listed,
      decision: "approve",
      run: async () => await memory.approve({ actor: operatorIn("default"), recordId: tidy.recordId }),
      reread: async () => undefined,
    });
    expect(decided).toBe("tidy");
    expect((await memory.get({ actor: operatorIn("default"), recordId: tidy.recordId })).status).toBe("proposed");
    await memory.approve({ actor: operatorIn("default"), recordId: tidy.recordId });
    for (const input of [first, second]) {
      expect((await memory.get({ actor: operatorIn("default"), recordId: input.recordId })).status).toBe("superseded");
      expect((await memory.history({ actor: operatorIn("default"), recordId: input.recordId })).revisions).toHaveLength(1);
    }
  });

  it("a tidy-up over a record proposed after a page was read carries the join of its inputs' provenance onto its Tidy-up card, and the run's model never sees it", async () => {
    const { store, clock, memory, keep, job, proposals } = await fixture();
    const read: MemoryProvenance = {
      integrity: "untrusted",
      sources: ["web"],
      refs: [{ source: "web", ref: "call-1", host: "seeds.example.com", at: T0.toISOString() }],
    };
    const actor: MemoryActor = { ...operatorIn("default"), caller: "agent", authority: "model" };
    const first = await memory.approve({
      actor: operatorIn("default"),
      recordId: (await memory.propose({ actor, scope: garden(), kind: "fact", body: "Keeps a vegetable garden", provenance: read }))
        .recordId,
    });
    await keep("default", garden(), "Grows tomatoes in the garden");
    const { model, calls } = scriptedModel();
    clock.now = at(2 * HOUR + 31 * 60_000);
    await job(model).tick();
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]?.request.messages)).not.toContain("seeds.example.com");
    const [tidy] = await proposals();
    expect(tidy).toBeDefined();
    const history = await memory.history({ actor: operatorIn("default"), recordId: tidy!.recordId });
    expect(history.revisions[0]?.provenance).toEqual(read);
    expect((await memory.history({ actor: operatorIn("default"), recordId: first.recordId })).revisions[0]?.provenance).toEqual(read);
    // The Center's Tidy-up card reads it from the `memory` command's listing.
    const repositories = store.asPort().repositories;
    const listed = await memoryCommand({ memory, repositories, principalOf: () => "operator", fromBridge: true, now: () => clock.now }, {
      action: "list",
      statuses: ["proposed"],
    } as MemoryPayload);
    const item = listed.ok ? (listed.result as MemoryListAnswer).records.find((record) => record.recordId === tidy!.recordId) : undefined;
    expect(item?.supersedes).toHaveLength(2);
    expect(memoryProvenanceLine(item?.provenance, { tidyUp: true })).toBe(
      "Merges memories proposed after a chat read a web page (seeds.example.com)",
    );
  });

  it("two workspaces with consolidation on produce one set of drafts for the person's personal records", async () => {
    const { clock, keep, job, marks } = await fixture({ workspaces: ["default", "w2"] });
    await keep("default", { kind: "personal", principalId: "operator" }, "Takes the dog out at 7");
    await keep("default", { kind: "personal", principalId: "operator" }, "Walks the dog every morning at seven");
    await keep("w2", garden("w2"), "The w2 project ships on Fridays at 5");
    const { model, calls } = scriptedModel(() => JSON.stringify({ tidy: [] }));
    const consolidation = job(model);
    clock.now = at(3 * HOUR);
    // One run a tick across the owner: two ticks run both workspaces.
    await consolidation.tick();
    await consolidation.tick();
    await consolidation.tick();
    expect(calls).toHaveLength(2);
    const prompts = calls.map((call) => call.request.messages.at(-1)?.text ?? "");
    expect(prompts.filter((prompt) => prompt.includes("Takes the dog out at 7"))).toHaveLength(1);
    expect(prompts.filter((prompt) => prompt.includes("The w2 project ships on Fridays at 5"))).toHaveLength(1);
    // The personal records went to the oldest workspace's run, not the other's.
    expect(prompts[0]).toContain("dog");
    expect(prompts[1]).not.toContain("dog");
    expect(await marks("default")).toHaveLength(4);
    expect(await marks("default")).toContain(memoryConsolidationPersonalMark("2026-10-12"));
    expect(await marks("w2")).toHaveLength(3);
  });

  /** Two workspaces: the oldest, `default`, under `first`'s settings until changed; `w2` on. */
  async function twoWorkspaces(first: Partial<EffectiveMemorySettings>) {
    const made = await fixture({ workspaces: ["default", "w2"] });
    await made.keep("default", { kind: "personal", principalId: "operator" }, "Takes the dog out at 7");
    await made.keep("default", garden(), "The default project ships on Mondays at 9");
    await made.keep("w2", garden("w2"), "The w2 project ships on Fridays at 5");
    const { model, calls } = scriptedModel(() => JSON.stringify({ tidy: [] }));
    const on: EffectiveMemorySettings = { ...effectiveMemorySettings(undefined), consolidation: "weekly" };
    const settings = new Map<string, EffectiveMemorySettings>([
      ["default", { ...on, ...first }],
      ["w2", on],
    ]);
    const consolidation = made.job(model, (workspaceId) => settings.get(workspaceId) as EffectiveMemorySettings);
    const prompts = () => calls.map((call) => call.request.messages.at(-1)?.text ?? "");
    return { ...made, consolidation, prompts, turnOnDefault: () => void settings.set("default", on) };
  }

  it("a person's personal records run once a week across workspaces when the oldest was paused at its run", async () => {
    const { clock, consolidation, prompts, turnOnDefault } = await twoWorkspaces({ enabled: false });
    clock.now = at(3 * HOUR);
    await consolidation.tick();
    // The oldest paused: the other holds the personal records' run.
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]).toContain("dog");
    // Resumed two days on, the oldest runs its own records, not the person's again that week.
    turnOnDefault();
    clock.now = at(2 * DAY + 3 * HOUR);
    await consolidation.tick();
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).toContain("ships on Mondays");
    expect(prompts()[1]).not.toContain("dog");
  });

  it("a person's personal records run once a week across workspaces when consolidation is switched on in the oldest mid-week", async () => {
    const { clock, consolidation, prompts, turnOnDefault } = await twoWorkspaces({ consolidation: "off" });
    clock.now = at(3 * HOUR);
    await consolidation.tick();
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]).toContain("dog");
    turnOnDefault();
    clock.now = at(3 * DAY + 3 * HOUR);
    await consolidation.tick();
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).not.toContain("dog");
    // A week on, the other is no longer the home; the oldest takes the person's records again once that week has passed.
    clock.now = at(7 * DAY + 3 * HOUR);
    await consolidation.tick();
    expect(prompts()).toHaveLength(3);
    expect(prompts()[2]).not.toContain("dog");
    clock.now = at(10 * DAY + 3 * HOUR);
    await consolidation.tick();
    expect(prompts()).toHaveLength(4);
    expect(prompts()[3]).toContain("dog");
  });

  it("memory invariant 24: a failing run is retried after an hour, and the third failure skips the week", async () => {
    const { clock, keep, job, marks } = await fixture();
    await keep("default", garden(), "Keeps a vegetable garden of 3 beds");
    const { model, calls } = scriptedModel(() => new Error("provider down"));
    const consolidation = job(model);
    clock.now = at(3 * HOUR);
    await consolidation.tick();
    clock.now = at(3 * HOUR + 30 * 60_000);
    await consolidation.tick();
    expect(calls).toHaveLength(1);
    clock.now = at(4 * HOUR + 1);
    await consolidation.tick();
    clock.now = at(5 * HOUR + 2);
    await consolidation.tick();
    expect(calls).toHaveLength(3);
    clock.now = at(6 * HOUR + 3);
    await consolidation.tick();
    clock.now = at(9 * HOUR);
    await consolidation.tick();
    expect(calls).toHaveLength(3);
    expect(await marks()).toEqual(
      [
        memoryConsolidationMark({ date: "2026-10-12", outcome: "skipped" }),
        memoryConsolidationFailureMark("2026-10-12", 1),
        memoryConsolidationFailureMark("2026-10-12", 2),
        memoryConsolidationFailureMark("2026-10-12", 3),
      ].sort(),
    );
    expect(
      memoryConsolidationDoctor({
        consolidation: "weekly",
        month: (await marks()).map((mark) => ({ mark, at: at(6 * HOUR).toISOString() })),
        spend: { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 },
      }),
    ).toEqual({
      consolidation: "weekly",
      lastRun: null,
      filed: 0,
      drafts: 0,
      failures: 3,
      skipped: 1,
      spend: { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 },
    });
  });
});

describe("who drafts a run", () => {
  const builtin = { id: BUILTIN_MEMORY_PROVIDER_ID, provider: createBuiltinMemoryProvider() };
  const plugin = (
    capabilities: PluginMemoryDeclaration["capabilities"],
  ): {
    readonly kind: "plugin";
    readonly id: string;
    readonly provider: MemoryProvider;
    readonly declaration: PluginMemoryDeclaration;
  } => ({
    kind: "plugin",
    id: "acme.memory",
    provider: { recall: async () => ({ hits: [] }), consolidate: async () => ({ drafts: [] }) },
    declaration: { abi: "tavi.memory/1", capabilities, index: "host", receives: ["records", "conversation"] },
  });
  const egress = (records: boolean, includePersonal: boolean) => ({ records, conversation: false, includePersonal });

  it("memory invariant 26: an external provider that declares consolidate, only with records on, and personal records only with includePersonal; else the built-in", () => {
    expect(consolidationProviderOf({ provider: plugin(["recall", "consolidate"]), egress: egress(true, false) }, builtin, false)?.id).toBe(
      "acme.memory",
    );
    expect(consolidationProviderOf({ provider: plugin(["recall", "consolidate"]), egress: egress(false, false) }, builtin, false)?.id).toBe(
      BUILTIN_MEMORY_PROVIDER_ID,
    );
    expect(consolidationProviderOf({ provider: plugin(["recall", "consolidate"]), egress: egress(true, false) }, builtin, true)?.id).toBe(
      BUILTIN_MEMORY_PROVIDER_ID,
    );
    expect(consolidationProviderOf({ provider: plugin(["recall", "consolidate"]), egress: egress(true, true) }, builtin, true)?.id).toBe(
      "acme.memory",
    );
    expect(consolidationProviderOf({ provider: plugin(["recall"]), egress: egress(true, true) }, builtin, true)?.id).toBe(
      BUILTIN_MEMORY_PROVIDER_ID,
    );
  });

  it("names a different set whenever a record's revision, the drafter, the model or the sensitive setting differs", () => {
    const record = (revisionId: string) =>
      ({ scope: { kind: "personal", principalId: "operator" }, snapshot: { recordId: "mem-1", revisionId } }) as never;
    const run = { drafter: "tavi.memoryprovider", model: "c/m", sensitive: "skip" };
    const base = consolidationSetDigest([record("rev-1")], run);
    expect(consolidationSetDigest([record("rev-1")], run)).toBe(base);
    for (const changed of [
      consolidationSetDigest([record("rev-2")], run),
      consolidationSetDigest([record("rev-1")], { ...run, drafter: "other" }),
      consolidationSetDigest([record("rev-1")], { ...run, model: "c/n" }),
      consolidationSetDigest([record("rev-1")], { ...run, sensitive: "propose" }),
    ])
      expect(changed).not.toBe(base);
  });
});
