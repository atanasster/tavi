import {
  IDEA_DEFAULT_SETTINGS,
  IDEA_IGNORED_RUNS,
  IDEA_MAX_ACTIVE,
  IDEA_RUN_STALE_MS,
  IDEA_TTL_MS,
  type IdeaDraft,
  type IdeaSignal,
} from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { SqliteStore } from "../src/persistence/store.js";
import { unquoteIdeasCiting } from "../src/persistence/ideas-repository.js";

/** Ideas' store: upsert by key, the ledger, time, the cap, workspaces, runs and settings. */

const NOW = "2026-10-19T10:00:00.000Z";
const later = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
const DAY = 24 * 60 * 60_000;
const WEEK = 7 * DAY;

const draft = (key: string, overrides: Partial<IdeaDraft> = {}): IdeaDraft => ({
  key,
  category: (key.split(".")[0] ?? "travel") as IdeaDraft["category"],
  icon: "✈️",
  title: `I can help with ${key}`,
  pitch: "A pitch.",
  label: "Try it",
  prompt: `Help me with ${key}.`,
  basis: [{ kind: "memory", ref: "mem-1" }],
  uses: [{ capability: "web", approval: false }],
  ...overrides,
});

function fixture() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  const ideas = store.asPort().repositories.ideas;
  let runs = 0;
  let feedbacks = 0;
  const offer = (
    items: readonly { key: string; score?: number; id?: string; overrides?: Partial<IdeaDraft> }[],
    now = NOW,
    workspaceId = "default",
    providerId = "tavi.ideasagent",
  ) => {
    runs += 1;
    const runId = `run-${runs}`;
    ideas.startRun({ runId, workspaceId, trigger: "schedule", providerId, now });
    const stored = ideas.store({
      workspaceId,
      runId,
      providerId,
      now,
      ideas: items.map((item) => ({
        id: item.id ?? `idea-${runs}-${item.key}`,
        score: item.score ?? 0.5,
        draft: draft(item.key, item.overrides),
      })),
    });
    ideas.finishRun({ runId, outcome: "generated", now });
    return stored;
  };
  const say = (
    signal: IdeaSignal,
    fields: { ideaId?: string; category?: IdeaDraft["category"]; basisRef?: string; editedPrompt?: string; snoozedUntil?: string } = {},
    now = NOW,
    workspaceId = "default",
  ) => ideas.feedback({ id: `fb-${(feedbacks += 1)}`, workspaceId, signal, now, ...fields });
  const list = (now = NOW, includeInactive = false) => ideas.list({ workspaceId: "default", now, includeInactive });
  const keyed = (now = NOW) => new Map(list(now, true).map((idea) => [idea.key, idea]));
  return { store, ideas, offer, say, list, keyed };
}

describe("ideas repository", () => {
  it("stores a run's ideas best first, and a key offered again keeps its id and counts the run", () => {
    const { offer, list } = fixture();
    offer([
      { key: "travel.a", score: 0.2 },
      { key: "travel.b", score: 0.9 },
    ]);
    expect(list().map((idea) => idea.key)).toEqual(["travel.b", "travel.a"]);
    const again = offer([{ key: "travel.a", score: 0.95, overrides: { title: "I can do a, better" } }], later(1_000));
    // Offered again a second later: the same idea, rewritten, and not yet a second day's showing.
    expect(again.stored[0]).toMatchObject({
      id: "idea-1-travel.a",
      runId: "run-2",
      providerId: "tavi.ideasagent",
      shownRuns: 1,
      title: "I can do a, better",
      expiresAt: later(1_000 + IDEA_TTL_MS),
    });
    expect(list(later(1_000)).map((idea) => idea.key)).toEqual(["travel.a", "travel.b"]);
  });

  it("refuses what the ledger rules out: dismissed, snoozed, a muted section, an excluded basis, tried lately", () => {
    const { offer, say, keyed } = fixture();
    offer([{ key: "travel.a" }, { key: "travel.b" }, { key: "travel.t" }]);
    const ids = keyed();
    say("not-interested", { ideaId: ids.get("travel.a")!.id });
    say("not-now", { ideaId: ids.get("travel.b")!.id, snoozedUntil: later(WEEK) });
    say("tried", { ideaId: ids.get("travel.t")!.id });
    say("mute-category", { category: "shopping" });
    say("exclude-basis", { basisRef: "mem-9" });
    const result = offer(
      [
        { key: "travel.a" },
        { key: "travel.b" },
        { key: "travel.t" },
        { key: "shopping.c" },
        { key: "travel.e", overrides: { basis: [{ kind: "memory", ref: "mem-9" }] } },
        { key: "travel.d" },
      ],
      later(1_000),
    );
    expect([...result.refused].sort()).toEqual(["shopping.c", "travel.a", "travel.b", "travel.e", "travel.t"]);
    expect(result.stored.map((idea) => idea.key)).toEqual(["travel.d"]);
    say("unmute-category", { category: "shopping" }, later(2_000));
    expect(offer([{ key: "shopping.c" }], later(3_000)).stored).toHaveLength(1);
  });

  it("a muted section or an excluded basis expires the active ideas it hides, but not pinned ones", () => {
    const { ideas, offer, say, list } = fixture();
    offer([
      { key: "travel.a" },
      { key: "shopping.b" },
      { key: "shopping.p" },
      { key: "travel.c", overrides: { basis: [{ kind: "task", ref: "task-1" }] } },
    ]);
    const pinned = list().find((idea) => idea.key === "shopping.p")!;
    ideas.setPinned("default", pinned.id, true, NOW);
    say("mute-category", { category: "shopping" });
    say("exclude-basis", { basisRef: "task-1" });
    expect(
      list()
        .map((idea) => idea.key)
        .sort(),
    ).toEqual(["shopping.p", "travel.a"]);
  });

  it(`keeps at most ${IDEA_MAX_ACTIVE} active through every path, and never evicts a pinned one`, () => {
    const { ideas, offer, say, list } = fixture();
    offer([{ key: "travel.pinned", score: 0 }]);
    ideas.setPinned("default", list()[0]!.id, true, NOW);
    const result = offer(
      Array.from({ length: IDEA_MAX_ACTIVE + 1 }, (_, index) => ({ key: `travel.k${index}`, score: (index + 1) / 100 })),
    );
    expect(result.evicted).toEqual(["idea-2-travel.k0", "idea-2-travel.k1"]);
    expect(list()).toHaveLength(IDEA_MAX_ACTIVE);
    // A snooze ending, and a restore, push past the cap; the lowest scores go.
    const lowest = list().find((idea) => idea.key === "travel.k2")!;
    say("not-now", { ideaId: list().find((idea) => idea.key === "travel.k12")!.id, snoozedUntil: later(DAY) });
    offer([{ key: "travel.new", score: 0.99 }], later(1));
    expect(list(later(1))).toHaveLength(IDEA_MAX_ACTIVE);
    expect(list(later(DAY))).toHaveLength(IDEA_MAX_ACTIVE);
    expect(ideas.get("default", lowest.id)?.status).toBe("expired");
  });

  it(`refuses to pin more than ${IDEA_MAX_ACTIVE}, and an idea offered past a full pinned page goes at once`, () => {
    const { ideas, offer, list } = fixture();
    offer(Array.from({ length: IDEA_MAX_ACTIVE }, (_, index) => ({ key: `travel.k${index}` })));
    for (const idea of list()) ideas.setPinned("default", idea.id, true, NOW);
    expect(offer([{ key: "travel.more", score: 0.99 }], later(1)).evicted).toEqual(["idea-2-travel.more"]);
  });

  it("retires a pinned idea once it is tried or made recurring: unpinned, it frees its place and expires with its week", () => {
    const { ideas, offer, say, list } = fixture();
    offer(Array.from({ length: IDEA_MAX_ACTIVE }, (_, index) => ({ key: `travel.k${index}` })));
    for (const idea of list()) ideas.setPinned("default", idea.id, true, NOW);
    const [tried, recurring] = list();
    say("tried", { ideaId: tried!.id }, later(1));
    say("done", { ideaId: recurring!.id }, later(1));
    expect(ideas.get("default", tried!.id)).toMatchObject({ status: "tried", pinned: false });
    expect(ideas.get("default", recurring!.id)).toMatchObject({ status: "done", pinned: false });
    // Their two places are free again.
    const fresh = offer([{ key: "travel.fresh" }, { key: "travel.fresher" }], later(2)).stored;
    for (const idea of fresh) ideas.setPinned("default", idea.id, true, later(2));
    expect(list(later(2)).filter((idea) => idea.pinned)).toHaveLength(IDEA_MAX_ACTIVE);
    // A retired idea is not pinned again.
    expect(() => ideas.setPinned("default", tried!.id, true, later(2))).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    // And it goes with its week, as an unpinned one does.
    expect(ideas.get("default", tried!.id)?.status).toBe("tried");
    list(later(1 + IDEA_TTL_MS + 1));
    expect(ideas.get("default", tried!.id)?.status).toBe("expired");
  });

  it("settles time: a week's snooze brings the idea back for a fresh week, and ideas expire unless pinned", () => {
    const { ideas, offer, say, list, keyed } = fixture();
    offer([{ key: "travel.a" }, { key: "travel.b" }, { key: "travel.c" }]);
    const ids = keyed();
    ideas.setPinned("default", ids.get("travel.b")!.id, true, NOW);
    say("not-now", { ideaId: ids.get("travel.c")!.id, snoozedUntil: later(WEEK) });
    expect(list(later(WEEK)).map((idea) => [idea.key, idea.expiresAt])).toEqual([
      ["travel.b", later(IDEA_TTL_MS)],
      ["travel.c", later(WEEK + IDEA_TTL_MS)],
    ]);
    expect(ideas.get("default", ids.get("travel.a")!.id)?.status).toBe("expired");
  });

  it("two snoozes of one key that end together bring back one idea, the other expired", () => {
    const { store, ideas, offer, say, list } = fixture();
    offer([{ key: "travel.a", score: 0.4 }]);
    const first = list()[0]!;
    say("tried", { ideaId: first.id });
    // A tried row kept past its week (its expiry pushed out here) while its key is offered again.
    store.handle.prepare("UPDATE tavi_ideas SET expires_at = ? WHERE idea_id = ?").run(later(3 * WEEK), first.id);
    offer([{ key: "travel.a", score: 0.9 }], later(WEEK + 1));
    const second = list(later(WEEK + 1)).find((idea) => idea.key === "travel.a")!;
    say("not-now", { ideaId: first.id, snoozedUntil: later(2 * WEEK) }, later(WEEK + 2));
    say("not-now", { ideaId: second.id, snoozedUntil: later(2 * WEEK) }, later(WEEK + 2));
    expect(
      list(later(2 * WEEK))
        .filter((idea) => idea.key === "travel.a")
        .map((idea) => idea.id),
    ).toEqual([second.id]);
    expect(ideas.get("default", first.id)?.status).toBe("expired");
  });

  it("reads an idea stored under a capability's old name as its category now, merged with one it now shares", () => {
    const { store, ideas, offer, list } = fixture();
    offer([{ key: "travel.a" }]);
    const first = list()[0]!;
    store.handle.prepare("UPDATE tavi_ideas SET uses_json = ? WHERE idea_id = ?").run(
      JSON.stringify([
        { capability: "gmail", approval: false },
        { capability: "telegram", approval: false },
        { capability: "discord", approval: true },
      ]),
      first.id,
    );
    expect(ideas.get("default", first.id)?.uses).toEqual([
      { capability: "mailbox", approval: false },
      { capability: "messaging", approval: true },
    ]);
    expect(list().map((idea) => idea.id)).toEqual([first.id]);
  });

  it("restore clears every dismissed row of the key from the ledger", () => {
    const { store, ideas, offer, say, list } = fixture();
    offer([{ key: "travel.a" }]);
    const first = list()[0]!;
    say("not-interested", { ideaId: first.id });
    // A second dismissed row of the key, as an older owner could leave one.
    store.handle
      .prepare(
        "INSERT INTO tavi_ideas SELECT 'older-row', workspace_id, run_id, idea_key, use_case, category, icon, title, pitch, label, prompt, basis_json, uses_json, recurring_cadence, score, status, pinned, shown_runs, created_at, updated_at, expires_at, snoozed_until, provider_id, last_shown_at, seeded_task_id, prepared_task_id, prepared_text, prepared_at FROM tavi_ideas WHERE idea_id = ?",
      )
      .run(first.id);
    ideas.restore("default", first.id, later(1));
    expect(ideas.ledger("default", later(1)).dismissedKeys).toEqual([]);
    expect(ideas.get("default", "older-row")?.status).toBe("expired");
  });

  it("a dismissal reaches the ledger even for an idea that already expired, and unpins it", () => {
    const { ideas, offer, say, list } = fixture();
    offer([{ key: "travel.a" }]);
    const [idea] = list();
    list(later(IDEA_TTL_MS));
    expect(say("not-interested", { ideaId: idea!.id }, later(IDEA_TTL_MS))).toMatchObject({ status: "dismissed", pinned: false });
    expect(ideas.ledger("default", later(IDEA_TTL_MS)).dismissedKeys).toEqual(["travel.a"]);
    expect(offer([{ key: "travel.a" }], later(IDEA_TTL_MS + 1)).refused).toEqual(["travel.a"]);
  });

  it("restore undoes a dismissal or a snooze, and its key leaves the ledger", () => {
    const { ideas, offer, say, list, keyed } = fixture();
    offer([{ key: "travel.a" }, { key: "travel.b" }]);
    const ids = keyed();
    say("not-interested", { ideaId: ids.get("travel.a")!.id });
    say("not-now", { ideaId: ids.get("travel.b")!.id, snoozedUntil: later(WEEK) });
    expect(ideas.restore("default", ids.get("travel.a")!.id, later(1))).toMatchObject({ status: "active" });
    expect(ideas.restore("default", ids.get("travel.b")!.id, later(1))).toMatchObject({ status: "active" });
    expect(ideas.ledger("default", later(1)).dismissedKeys).toEqual([]);
    expect(list(later(1))).toHaveLength(2);
    expect(() => ideas.restore("default", ids.get("travel.a")!.id, later(2))).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("an idea offered on three days and never opened is let go, and its key rests", () => {
    const { ideas, offer, list } = fixture();
    // Refreshes within a day count once: four offers in an hour leave it alone.
    for (let minute = 0; minute < 4; minute += 1) offer([{ key: "travel.a" }], later(minute * 60_000));
    expect(list(later(3_600_000))[0]?.shownRuns).toBe(1);
    for (let day = 1; day < IDEA_IGNORED_RUNS; day += 1) offer([{ key: "travel.a" }], later(day * DAY));
    const result = offer([{ key: "travel.a" }], later(IDEA_IGNORED_RUNS * DAY));
    expect(result.refused).toEqual(["travel.a"]);
    expect(ideas.ledger("default", later(IDEA_IGNORED_RUNS * DAY)).suppressedKeys).toEqual(["travel.a"]);
  });

  it("a burst of refreshes counts once, however old the idea is", () => {
    const { offer, list } = fixture();
    offer([{ key: "travel.a" }]);
    // Three days on, not offered since (nothing changed on the schedule): a refresh counts, the next ones that hour do not.
    for (let minute = 0; minute < 4; minute += 1) offer([{ key: "travel.a" }], later(3 * DAY + minute * 60_000));
    expect(list(later(3 * DAY + 3_600_000))[0]?.shownRuns).toBe(2);
  });

  it("a done idea stays tried-lately for a week from when it was done", () => {
    const { ideas, offer, say, list } = fixture();
    offer([{ key: "travel.a" }]);
    const idea = list()[0]!;
    say("done", { ideaId: idea.id }, later(IDEA_TTL_MS - DAY));
    expect(ideas.ledger("default", later(IDEA_TTL_MS + DAY)).recentKeys).toEqual(["travel.a"]);
    expect(offer([{ key: "travel.a" }], later(IDEA_TTL_MS + DAY)).refused).toEqual(["travel.a"]);
  });

  it("a snooze that ends brings nothing back that the person has since ruled out", () => {
    const { ideas, offer, say, keyed, list } = fixture();
    offer([
      { key: "travel.a" },
      { key: "shopping.b" },
      { key: "travel.c", overrides: { basis: [{ kind: "task", ref: "task-1" }] } },
      { key: "travel.d" },
    ]);
    const ids = keyed();
    for (const key of ["travel.a", "shopping.b", "travel.c", "travel.d"])
      say("not-now", { ideaId: ids.get(key)!.id, snoozedUntil: later(DAY) });
    say("mute-category", { category: "shopping" });
    say("exclude-basis", { basisRef: "task-1" });
    ideas.saveSettings({ workspaceId: "default", settings: { ...IDEA_DEFAULT_SETTINGS, provider: "acme.ideas" }, now: NOW });
    // The muted and excluded ones ended as the signal landed; the other provider's is not this provider's to bring back.
    expect(list(later(DAY))).toEqual([]);
    ideas.saveSettings({ workspaceId: "default", settings: IDEA_DEFAULT_SETTINGS, now: NOW });
    expect(ideas.get("default", ids.get("travel.d")!.id)?.status).toBe("expired");
    expect(ideas.get("default", ids.get("shopping.b")!.id)?.status).toBe("expired");
  });

  it("a dismissal ends every other row of its key and drops the words it quoted", () => {
    const { ideas, offer, say, list } = fixture();
    offer([{ key: "travel.a", overrides: { basis: [{ kind: "memory", ref: "mem-1", excerpt: "Trip to Lisbon" }] } }]);
    const first = list()[0]!;
    say("tried", { ideaId: first.id });
    offer([{ key: "travel.a" }], later(WEEK + 1));
    const second = list(later(WEEK + 1))[0]!;
    expect(second.id).not.toBe(first.id);
    say("not-interested", { ideaId: first.id }, later(WEEK + 2));
    expect(ideas.get("default", second.id)?.status).toBe("expired");
    expect(ideas.get("default", first.id)?.basis).toEqual([{ kind: "memory", ref: "mem-1" }]);
  });

  it("stores a run's ideas only while its provider is still the selection and Ideas is on", () => {
    const { ideas } = fixture();
    const store = (providerId: string) => () =>
      ideas.store({
        workspaceId: "default",
        runId: "r",
        providerId,
        whileSelected: true,
        now: NOW,
        ideas: [{ id: "i-1", score: 0.5, draft: draft("travel.a") }],
      });
    expect(store("acme.ideas")).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    ideas.saveSettings({ workspaceId: "default", settings: { ...IDEA_DEFAULT_SETTINGS, enabled: false }, now: NOW });
    expect(store("tavi.ideasagent")).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    ideas.saveSettings({ workspaceId: "default", settings: IDEA_DEFAULT_SETTINGS, now: NOW });
    expect(store("tavi.ideasagent")().stored).toHaveLength(1);
  });

  it("a done idea expires with its week, as a tried one does", () => {
    const { ideas, offer, say, list } = fixture();
    offer([{ key: "travel.a" }]);
    const idea = list()[0]!;
    say("done", { ideaId: idea.id });
    list(later(IDEA_TTL_MS + 1));
    expect(ideas.get("default", idea.id)?.status).toBe("expired");
  });

  it("keeps every idea in its workspace: another workspace's is not found", () => {
    const { ideas, offer, say } = fixture();
    offer([{ key: "travel.a", id: "shared-id" }], NOW, "other");
    expect(ideas.get("default", "shared-id")).toBeUndefined();
    expect(() => say("tried", { ideaId: "shared-id" })).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => ideas.setPinned("default", "shared-id", true, NOW)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => offer([{ key: "travel.b", id: "shared-id" }])).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("each signal names what it is about", () => {
    const { say } = fixture();
    expect(() => say("mute-category")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => say("exclude-basis")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => say("not-interested")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => say("not-now", { snoozedUntil: NOW })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("the ledger carries what to favour: boosted keys and sections, and edited prompts", () => {
    const { ideas, offer, say, list } = fixture();
    offer([{ key: "travel.a" }]);
    const [idea] = list();
    say("more-like-this", { ideaId: idea!.id });
    say("edited", { ideaId: idea!.id, editedPrompt: "Help me with a, in June." });
    expect(ideas.ledger("default", NOW)).toMatchObject({
      boostedKeys: ["travel.a"],
      boostedCategories: ["travel"],
      examples: ["Help me with a, in June."],
    });
  });

  it("a reset forgets dismissals and exclusions and ends snoozes; another unmutes sections", () => {
    const { ideas, offer, say, keyed } = fixture();
    offer([{ key: "travel.a" }, { key: "travel.b" }]);
    const ids = keyed();
    say("not-interested", { ideaId: ids.get("travel.a")!.id });
    say("not-now", { ideaId: ids.get("travel.b")!.id, snoozedUntil: later(WEEK) });
    say("exclude-basis", { basisRef: "mem-2" });
    say("mute-category", { category: "people" });
    expect(ideas.reset({ workspaceId: "default", what: "ledger", now: later(1) })).toBe(3);
    expect(ideas.get("default", ids.get("travel.b")!.id)?.status).toBe("active");
    expect(ideas.ledger("default", later(1))).toMatchObject({
      dismissedKeys: [],
      snoozedKeys: [],
      excludedBasis: [],
      mutedCategories: ["people"],
    });
    expect(ideas.reset({ workspaceId: "default", what: "categories", now: later(1) })).toBe(1);
    expect(offer([{ key: "travel.a" }], later(2)).stored).toHaveLength(1);
  });

  it("retires another provider's unpinned ideas, and forgets ideas citing a forgotten source", () => {
    const { ideas, offer, list } = fixture();
    offer([{ key: "travel.a" }, { key: "travel.p" }], NOW, "default", "old.provider");
    ideas.setPinned("default", list().find((idea) => idea.key === "travel.p")!.id, true, NOW);
    offer([{ key: "travel.b", overrides: { basis: [{ kind: "task", ref: "task-7" }] } }], NOW, "default", "new.provider");
    expect(ideas.retireProvider("default", "new.provider", later(1))).toBe(1);
    expect(
      list(later(1))
        .map((idea) => idea.key)
        .sort(),
    ).toEqual(["travel.b", "travel.p"]);
    expect(ideas.forgetBasis("task-7")).toBe(1);
    expect(list(later(1)).map((idea) => idea.key)).toEqual(["travel.p"]);
  });

  it("refuses a malformed idea, a key outside its section, control characters, a score out of range, a key twice", () => {
    const { ideas } = fixture();
    const store = (items: { key: string; score: number; overrides?: Partial<IdeaDraft> }[]) => () =>
      ideas.store({
        workspaceId: "default",
        runId: "run-x",
        providerId: "p",
        now: NOW,
        ideas: items.map((item, index) => ({ id: `i-${index}`, score: item.score, draft: draft(item.key, item.overrides) })),
      });
    expect(store([{ key: "travel.a", score: 0.5, overrides: { basis: [] } }])).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(store([{ key: "travel.a", score: 0.5, overrides: { category: "shopping" } }])).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(store([{ key: "travel.a", score: 0.5, overrides: { title: "I can ‮help" } }])).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(store([{ key: "travel.a", score: 1.5 }])).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(
      store([
        { key: "travel.a", score: 0.5 },
        { key: "travel.a", score: 0.6 },
      ]),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("records runs: one at a time, a lost one failed, the last hash that counts, refreshes and spend", () => {
    const { ideas } = fixture();
    ideas.startRun({ runId: "r1", workspaceId: "default", trigger: "schedule", providerId: "p", now: NOW });
    expect(() => ideas.startRun({ runId: "r2", workspaceId: "default", trigger: "refresh", now: later(1_000) })).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    ideas.startRun({ runId: "r2", workspaceId: "default", trigger: "refresh", now: later(IDEA_RUN_STALE_MS) });
    expect(ideas.lastRun("default")?.id).toBe("r2");
    expect(ideas.lastRun("default")?.providerId).toBeUndefined();
    expect(
      ideas.finishRun({ runId: "r2", outcome: "generated", inputsHash: "h1", tokens: 100, usd: 0.01, now: later(IDEA_RUN_STALE_MS + 1) }),
    ).toMatchObject({ outcome: "generated", inputsHash: "h1" });
    expect(() => ideas.finishRun({ runId: "r1", outcome: "generated", now: NOW })).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    ideas.startRun({ runId: "r3", workspaceId: "default", trigger: "schedule", now: later(IDEA_RUN_STALE_MS + 2) });
    expect(() => ideas.finishRun({ runId: "r3", outcome: "failed", reason: "x".repeat(501), now: later(IDEA_RUN_STALE_MS + 3) })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    ideas.finishRun({ runId: "r3", outcome: "failed", reason: "The provider timed out.", now: later(IDEA_RUN_STALE_MS + 3) });
    expect(ideas.lastInputsHash("default")).toBe("h1");
    expect(ideas.refreshesSince("default", NOW)).toBe(1);
    expect(ideas.spentSince("default", NOW)).toEqual({ tokens: 100, usd: 0.01 });
  });

  it("prunes old expired ideas, finished runs and ranking feedback, keeping the ledger", () => {
    const { ideas, offer, say, list } = fixture();
    offer([{ key: "travel.a" }, { key: "travel.b" }]);
    say("not-interested", { ideaId: list()[0]!.id });
    say("more-like-this", { ideaId: list()[0]!.id });
    list(later(IDEA_TTL_MS));
    expect(ideas.prune(later(IDEA_TTL_MS + 1))).toBe(3);
    expect(ideas.ledger("default", later(IDEA_TTL_MS + 1)).dismissedKeys).toHaveLength(1);
  });

  it("settings start at the defaults, and a save keeps what it does not name", () => {
    const { ideas } = fixture();
    expect(ideas.settings("default")).toEqual({ settings: IDEA_DEFAULT_SETTINGS, brief: "" });
    ideas.saveSettings({ workspaceId: "default", brief: "More about the garden.", now: NOW });
    const saved = ideas.saveSettings({ workspaceId: "default", settings: { ...IDEA_DEFAULT_SETTINGS, chips: false }, now: later(1) });
    expect(saved).toEqual({ settings: { ...IDEA_DEFAULT_SETTINGS, chips: false }, brief: "More about the garden.", updatedAt: later(1) });
    expect(ideas.settings("default")).toEqual(saved);
    expect(() => ideas.saveSettings({ workspaceId: "default", brief: "x".repeat(2_001), now: NOW })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("leaves a pinned idea through a mute and an ended snooze; an exclusion ends it, pin and all", () => {
    const { ideas, offer, say, keyed } = fixture();
    offer([{ key: "shopping.p" }, { key: "travel.q", overrides: { basis: [{ kind: "task", ref: "task-1" }] } }]);
    const ids = keyed();
    for (const key of ["shopping.p", "travel.q"]) ideas.setPinned("default", ids.get(key)!.id, true, NOW);
    say("not-now", { ideaId: ids.get("shopping.p")!.id, snoozedUntil: later(DAY) });
    say("mute-category", { category: "shopping" });
    expect(ideas.list({ workspaceId: "default", now: later(DAY) }).map((idea) => idea.key)).toContain("shopping.p");
    say("exclude-basis", { basisRef: "task-1" }, later(DAY));
    expect(ideas.get("default", ids.get("travel.q")!.id)).toMatchObject({ status: "expired", pinned: false });
  });

  it("restore refuses an idea its section's mute or a source's exclusion would hide", () => {
    const { ideas, offer, say, keyed } = fixture();
    offer([{ key: "shopping.a" }, { key: "travel.b", overrides: { basis: [{ kind: "task", ref: "task-1" }] } }]);
    const ids = keyed();
    say("not-interested", { ideaId: ids.get("shopping.a")!.id });
    say("not-interested", { ideaId: ids.get("travel.b")!.id });
    say("mute-category", { category: "shopping" });
    say("exclude-basis", { basisRef: "task-1" });
    expect(() => ideas.restore("default", ids.get("shopping.a")!.id, later(1))).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    expect(() => ideas.restore("default", ids.get("travel.b")!.id, later(1))).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("refuses a refresh past the hour's limit in the transaction that starts it", () => {
    const { ideas } = fixture();
    for (let index = 0; index < 3; index += 1) {
      ideas.startRun({ runId: `r${index}`, workspaceId: "default", trigger: "refresh", refreshesPerHour: 3, now: later(index * 1_000) });
      ideas.finishRun({ runId: `r${index}`, outcome: "generated", now: later(index * 1_000 + 1) });
    }
    expect(() =>
      ideas.startRun({ runId: "r3", workspaceId: "default", trigger: "refresh", refreshesPerHour: 3, now: later(10_000) }),
    ).toThrow(expect.objectContaining({ code: "QUOTA_EXCEEDED" }));
    expect(
      ideas.startRun({ runId: "r4", workspaceId: "default", trigger: "refresh", refreshesPerHour: 3, now: later(3_700_000) }).outcome,
    ).toBe("running");
  });

  it("stores nothing from a run that read a source the person switched off meanwhile", () => {
    const { ideas } = fixture();
    ideas.saveSettings({
      workspaceId: "default",
      settings: { ...IDEA_DEFAULT_SETTINGS, sources: { memory: false, tasks: true, brief: true } },
      now: NOW,
    });
    expect(() =>
      ideas.store({
        workspaceId: "default",
        runId: "r",
        providerId: "tavi.ideasagent",
        whileSelected: true,
        usedSources: ["memory"],
        now: NOW,
        ideas: [{ id: "i", score: 0.5, draft: draft("travel.a") }],
      }),
    ).toThrow(expect.objectContaining({ code: "CONFLICT", details: expect.objectContaining({ notSelected: true }) }));
  });

  it("unquote ends the unpinned ideas citing a source and drops its words from the rest", () => {
    const { ideas, offer, list } = fixture();
    offer([
      { key: "travel.a", overrides: { basis: [{ kind: "brief", ref: "brief", excerpt: "More garden" }] } },
      { key: "travel.p", overrides: { basis: [{ kind: "brief", ref: "brief", excerpt: "More garden" }] } },
      { key: "travel.m", overrides: { basis: [{ kind: "memory", ref: "mem-1", excerpt: "Lisbon" }] } },
    ]);
    const pinned = list().find((idea) => idea.key === "travel.p")!;
    ideas.setPinned("default", pinned.id, true, NOW);
    ideas.unquote({ workspaceId: "default", ref: "brief", now: later(1) });
    expect(list(later(1)).map((idea) => [idea.key, idea.basis])).toEqual([
      ["travel.p", [{ kind: "brief", ref: "brief" }]],
      ["travel.m", [{ kind: "memory", ref: "mem-1", excerpt: "Lisbon" }]],
    ]);
    ideas.unquote({ workspaceId: "default", kind: "memory", now: later(2) });
    expect(list(later(2)).map((idea) => idea.key)).toEqual(["travel.p"]);
  });

  it("forgetting a source takes the prompts edited from its ideas; a reset takes every edited prompt", () => {
    const { store, ideas, offer, say, list } = fixture();
    offer([{ key: "travel.a", overrides: { basis: [{ kind: "task", ref: "task-1" }] } }, { key: "travel.b" }]);
    const [a, b] = [...list()].sort((x, y) => x.key.localeCompare(y.key));
    say("edited", { ideaId: a!.id, editedPrompt: "From the forgotten chat" });
    say("edited", { ideaId: b!.id, editedPrompt: "Kept until a reset" });
    store.asPort().repositories.ideas.forgetBasis("task-1");
    expect(ideas.ledger("default", NOW).examples).toEqual(["Kept until a reset"]);
    ideas.reset({ workspaceId: "default", what: "ledger", now: later(1) });
    expect(ideas.ledger("default", later(1)).examples).toEqual([]);
  });

  it("prunes old snoozes and settled mute and exclusion pairs, keeping what still holds", () => {
    const { ideas, offer, say, list } = fixture();
    offer([{ key: "travel.a" }]);
    say("not-now", { ideaId: list()[0]!.id, snoozedUntil: later(DAY) });
    say("mute-category", { category: "people" });
    say("unmute-category", { category: "people" }, later(1));
    say("mute-category", { category: "work" });
    say("exclude-basis", { basisRef: "mem-9" });
    say("include-basis", { basisRef: "mem-9" }, later(1));
    ideas.prune(later(DAY * 400));
    expect(ideas.ledger("default", later(DAY * 400))).toMatchObject({ mutedCategories: ["work"], excludedBasis: [] });
    // Nothing of the settled pairs or the snooze is left to read.
    expect(ideas.prune(later(DAY * 401))).toBe(0);
  });

  it("names each source set aside by the kind it was on the idea it was set aside from", () => {
    const { ideas, offer, say, keyed } = fixture();
    offer([
      { key: "travel.a", overrides: { basis: [{ kind: "task", ref: "task-1", excerpt: "Trip" }] } },
      { key: "travel.b", overrides: { basis: [{ kind: "memory", ref: "mem-2", excerpt: "Lisbon" }] } },
    ]);
    const ids = keyed();
    say("exclude-basis", { ideaId: ids.get("travel.a")!.id, basisRef: "task-1" });
    say("exclude-basis", { ideaId: ids.get("travel.b")!.id, basisRef: "mem-2" });
    say("exclude-basis", { basisRef: "brief" });
    say("exclude-basis", { basisRef: "mem-9" });
    say("include-basis", { basisRef: "mem-2" });
    expect(ideas.excludedSources("default", NOW)).toEqual([
      { ref: "task-1", kind: "task" },
      { ref: "brief", kind: "brief" },
      { ref: "mem-9" },
    ]);
  });

  it("links a chat an idea started, keeps an edited prompt, marks the idea done when the chat finishes, and counts what was taken up", async () => {
    const { ideas, offer, say, keyed } = fixture();
    offer([{ key: "travel.a" }, { key: "travel.b" }, { key: "work.c", overrides: { category: "work" } }]);
    const ids = keyed();
    const a = ids.get("travel.a")!;
    say("tried", { ideaId: a.id });
    // Sent as written: linked, nothing recorded as edited.
    ideas.seedChat({ id: "s1", workspaceId: "default", ideaId: a.id, taskId: "task-a", sent: a.prompt, now: NOW });
    expect(ideas.ledger("default", NOW).examples).toEqual([]);
    const b = ids.get("travel.b")!;
    say("tried", { ideaId: b.id });
    ideas.seedChat({
      id: "s2",
      workspaceId: "default",
      ideaId: b.id,
      taskId: "task-b",
      sent: "Help me with Lisbon in May, please.",
      now: NOW,
    });
    expect(ideas.ledger("default", NOW).examples).toEqual(["Help me with Lisbon in May, please."]);
    expect(() => ideas.seedChat({ id: "s3", workspaceId: "other", ideaId: a.id, taskId: "task-x", sent: "x", now: NOW })).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    // The chat's turn finished: done, once.
    expect(ideas.chatFinished("task-a", "f1", NOW)?.status).toBe("done");
    expect(ideas.chatFinished("task-a", "f2", NOW)).toBeUndefined();
    expect(ideas.chatFinished("task-none", "f3", NOW)).toBeUndefined();
    // Tried twice, edited once, done once, all in travel.
    expect(ideas.ledger("default", NOW).categoryPriors).toEqual({ travel: 1 + 1 + 0.5 + 2 });
    // The same idea tried again weighs its section once.
    say("tried", { ideaId: b.id });
    expect(ideas.ledger("default", NOW).categoryPriors).toEqual({ travel: 1 + 1 + 0.5 + 2 });
    expect(ideas.acceptance("default", "2026-01-01T00:00:00.000Z")).toMatchObject({ tried: 2 });
  });

  it("forgetting a chat an idea started drops the link and what was sent there", () => {
    const { ideas, offer, keyed } = fixture();
    offer([{ key: "travel.a" }]);
    const a = keyed().get("travel.a")!;
    ideas.seedChat({ id: "s1", workspaceId: "default", ideaId: a.id, taskId: "task-a", sent: "My own words", now: NOW });
    // Tried again in a second chat: forgetting the first takes only its words.
    ideas.seedChat({ id: "s2", workspaceId: "default", ideaId: a.id, taskId: "task-b", sent: "Other words", now: NOW });
    ideas.forgetBasis("task-a");
    expect(ideas.ledger("default", NOW).examples).toEqual(["Other words"]);
    ideas.forgetBasis("task-b");
    expect(ideas.ledger("default", NOW).examples).toEqual([]);
    expect(ideas.chatFinished("task-a", "f1", NOW)).toBeUndefined();
  });

  it("keeps an idea's prepared answer for a day, counts the day's prepared runs, and prunes their runs once no idea offers them", () => {
    const { store, ideas, offer, keyed } = fixture();
    offer([{ key: "travel.a" }, { key: "travel.b" }]);
    const a = keyed().get("travel.a")!;
    const admit = (taskId: string, at: string) =>
      store.asPort().repositories.tasks.admit({
        workspaceId: "default",
        principalId: "operator",
        operationKey: taskId,
        kind: "start",
        intent: { prompt: "Find flights" },
        checkpointNamespace: "",
        origin: "ideas",
        now: () => at,
        newTaskId: () => taskId,
        newThreadId: () => `thread-${taskId}`,
        newAdmissionId: () => `admission-${taskId}`,
      });
    admit("prep-1", NOW);
    expect(
      ideas.prepared({ workspaceId: "default", ideaId: a.id, taskId: "prep-1", text: "  Cheapest: €120 on Wizz.  ", now: NOW })?.prepared,
    ).toEqual({ taskId: "prep-1", text: "Cheapest: €120 on Wizz.", at: NOW });
    expect(ideas.preparedSince("default", NOW)).toMatchObject({ count: 1 });
    // Another workspace's idea, or one no longer offered, takes nothing.
    expect(ideas.prepared({ workspaceId: "other", ideaId: a.id, taskId: "prep-1", text: "x", now: NOW })).toBeUndefined();
    // A day on, the answer is gone; the run goes at the next prune.
    expect(ideas.get("default", a.id)?.prepared).toBeDefined();
    expect(ideas.list({ workspaceId: "default", now: later(DAY + 1) }).find((idea) => idea.id === a.id)?.prepared).toBeUndefined();
    store.handle.prepare("UPDATE tavi_tasks SET status = 'completed' WHERE task_id = 'prep-1'").run();
    ideas.prune("2000-01-01T00:00:00.000Z", later(2 * DAY));
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_tasks WHERE task_id = 'prep-1'").get()).toEqual({ n: 0 });
  });

  it("patches settings inside its transaction: a host's note and a person's edit never overwrite each other", () => {
    const { ideas } = fixture();
    ideas.saveSettings({ workspaceId: "default", patch: { sources: { memory: false } }, now: NOW });
    ideas.saveSettings({ workspaceId: "default", patch: { volume: 6, volumeAt: NOW }, now: NOW });
    expect(ideas.settings("default").settings).toMatchObject({ volume: 6, sources: { memory: false, tasks: true, brief: true } });
    ideas.saveSettings({
      workspaceId: "default",
      patch: {
        digest: { channel: "tg-1", weekday: 1 },
        digestSent: { on: "2026-10-19", at: NOW, connectionId: "tg-1", chatId: "c", ideaIds: ["i"] },
      },
      now: NOW,
    });
    ideas.saveSettings({ workspaceId: "default", clear: ["digest", "digestSent"], now: NOW });
    expect(ideas.settings("default").settings.digest).toBeUndefined();
    expect(ideas.settings("default").settings.digestSent).toBeUndefined();
    expect(() => ideas.saveSettings({ workspaceId: "default", patch: { volume: 99 }, now: NOW })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("keeps what is offered alive on a look that changes nothing", () => {
    const { ideas, offer, list } = fixture();
    offer([{ key: "travel.a" }]);
    expect(ideas.keepOffered("default", later(IDEA_TTL_MS - DAY))).toBe(1);
    expect(list(later(IDEA_TTL_MS + DAY)).map((idea) => idea.key)).toEqual(["travel.a"]);
  });

  it("drops a prepared answer when the idea's words or tools change, and keeps its run for the day's cap", () => {
    const { store, ideas, offer, keyed } = fixture();
    offer([{ key: "travel.a" }]);
    const a = keyed().get("travel.a")!;
    store.asPort().repositories.tasks.admit({
      workspaceId: "default",
      principalId: "operator",
      operationKey: "prep-1",
      kind: "start",
      intent: { prompt: "x" },
      checkpointNamespace: "",
      origin: "ideas",
      now: () => NOW,
      newTaskId: () => "prep-1",
      newThreadId: () => "t-prep-1",
      newAdmissionId: () => "a-prep-1",
    });
    ideas.prepared({ workspaceId: "default", ideaId: a.id, taskId: "prep-1", text: "Found.", now: NOW });
    // The same words again: the answer stays.
    offer([{ key: "travel.a" }]);
    expect(ideas.get("default", a.id)?.prepared).toBeDefined();
    offer([{ key: "travel.a", overrides: { prompt: "Something else now." } }]);
    expect(ideas.get("default", a.id)?.prepared).toBeUndefined();
    // What the run spent today still counts against the day's prepared steps.
    expect(ideas.preparedSince("default", NOW)).toMatchObject({ count: 1 });
    store.handle.prepare("UPDATE tavi_tasks SET status = 'completed' WHERE task_id = 'prep-1'").run();
    ideas.prune("2000-01-01T00:00:00.000Z", later(2 * DAY));
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_tasks WHERE task_id = 'prep-1'").get()).toEqual({ n: 0 });
  });

  it("keeps no prepared answer for words or tools rewritten while its step ran", () => {
    const { ideas, offer, keyed } = fixture();
    offer([{ key: "travel.a" }]);
    const a = keyed().get("travel.a")!;
    const ranFor = { prompt: a.prompt, uses: a.uses };
    // A run rewrote the idea while its step was looking: the answer is for the old words.
    offer([{ key: "travel.a", overrides: { prompt: "Something else now." } }]);
    expect(ideas.prepared({ workspaceId: "default", ideaId: a.id, taskId: "prep-5", text: "Found.", ranFor, now: NOW })).toBeUndefined();
    expect(ideas.get("default", a.id)?.prepared).toBeUndefined();
    const now = ideas.get("default", a.id)!;
    expect(
      ideas.prepared({
        workspaceId: "default",
        ideaId: a.id,
        taskId: "prep-5",
        text: "Found.",
        ranFor: { prompt: now.prompt, uses: now.uses },
        now: NOW,
      })?.prepared?.text,
    ).toBe("Found.");
  });

  it("prunes the prepared run of an idea deleted in the same pass", () => {
    const { store, ideas, offer, keyed, say } = fixture();
    offer([{ key: "travel.a" }]);
    const a = keyed().get("travel.a")!;
    store.asPort().repositories.tasks.admit({
      workspaceId: "default",
      principalId: "operator",
      operationKey: "prep-4",
      kind: "start",
      intent: { prompt: "x" },
      checkpointNamespace: "",
      origin: "ideas",
      now: () => NOW,
      newTaskId: () => "prep-4",
      newThreadId: () => "t-prep-4",
      newAdmissionId: () => "a-prep-4",
    });
    ideas.prepared({ workspaceId: "default", ideaId: a.id, taskId: "prep-4", text: "Found.", now: NOW });
    store.handle.prepare("UPDATE tavi_tasks SET status = 'completed' WHERE task_id = 'prep-4'").run();
    say("mute-category", { category: "travel" });
    expect(ideas.get("default", a.id)).toMatchObject({ status: "expired", prepared: { taskId: "prep-4" } });
    ideas.prune(later(1), later(2 * DAY));
    expect(ideas.get("default", a.id)).toBeUndefined();
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_tasks WHERE task_id = 'prep-4'").get()).toEqual({ n: 0 });
  });

  it("restore keeps the idea it brings back, and makes room by expiring another", () => {
    const { ideas, offer, say, keyed, list } = fixture();
    offer([{ key: "travel.low", score: 0.01 }]);
    const low = keyed().get("travel.low")!;
    say("not-interested", { ideaId: low.id });
    offer(
      Array.from({ length: IDEA_MAX_ACTIVE }, (_, index) => ({ key: `travel.k${index}`, score: 0.5 + index / 100 })),
      later(1),
    );
    expect(ideas.restore("default", low.id, later(2))).toMatchObject({ status: "active" });
    expect(list(later(2))).toHaveLength(IDEA_MAX_ACTIVE);
    expect(ideas.get("default", "idea-2-travel.k0")?.status).toBe("expired");
    expect(ideas.ledger("default", later(2)).dismissedKeys).not.toContain("travel.low");
  });

  it("restore refuses when every place is pinned, keeping the dismissal", () => {
    const { ideas, offer, say, keyed } = fixture();
    offer([{ key: "travel.low" }]);
    const low = keyed().get("travel.low")!;
    say("not-interested", { ideaId: low.id });
    offer(
      Array.from({ length: IDEA_MAX_ACTIVE }, (_, index) => ({ key: `travel.k${index}` })),
      later(1),
    );
    for (const idea of keyed(later(1)).values()) if (idea.status === "active") ideas.setPinned("default", idea.id, true, later(1));
    expect(() => ideas.restore("default", low.id, later(2))).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    expect(ideas.get("default", low.id)?.status).toBe("dismissed");
    expect(ideas.ledger("default", later(2)).dismissedKeys).toContain("travel.low");
  });

  it("leaves out of the examples what was typed in a chat the person set aside", () => {
    const { ideas, offer, say, keyed } = fixture();
    offer([{ key: "travel.a" }]);
    const a = keyed().get("travel.a")!;
    ideas.seedChat({ id: "s1", workspaceId: "default", ideaId: a.id, taskId: "task-x", sent: "My own words", now: NOW });
    ideas.seedChat({ id: "s2", workspaceId: "default", ideaId: a.id, taskId: "task-y", sent: "Other words", now: NOW });
    say("exclude-basis", { basisRef: "task-x" }, later(1));
    expect(ideas.ledger("default", later(1)).examples).toEqual(["Other words"]);
    say("include-basis", { basisRef: "task-x" }, later(2));
    expect(ideas.ledger("default", later(2)).examples).toEqual(["Other words", "My own words"]);
  });

  it("forgets a basis whole or not at all", () => {
    const { store, ideas, offer, keyed } = fixture();
    offer([{ key: "travel.a", overrides: { basis: [{ kind: "task", ref: "task-z" }] } }]);
    const a = keyed().get("travel.a")!;
    ideas.seedChat({ id: "s1", workspaceId: "default", ideaId: a.id, taskId: "task-z", sent: "My own words", now: NOW });
    store.handle.exec("CREATE TEMP TRIGGER refuse_idea_delete BEFORE DELETE ON tavi_ideas BEGIN SELECT RAISE(ABORT, 'refused'); END");
    expect(() => ideas.forgetBasis("task-z")).toThrow();
    // The edited example deleted first comes back with the idea that could not go.
    expect(ideas.ledger("default", NOW).examples).toEqual(["My own words"]);
    store.handle.exec("DROP TRIGGER refuse_idea_delete");
    expect(ideas.forgetBasis("task-z")).toBe(1);
    expect(ideas.ledger("default", NOW).examples).toEqual([]);
  });

  it("counts as shown only what was seen, and a routine made from an idea as taken up", () => {
    const { ideas, offer, say, keyed } = fixture();
    offer(Array.from({ length: IDEA_MAX_ACTIVE + 3 }, (_, index) => ({ key: `travel.k${index}`, score: 0.9 - index / 100 })));
    // The three the cap expired at once were never seen.
    expect(ideas.acceptance("default", NOW)).toEqual({ shown: IDEA_MAX_ACTIVE, tried: 0 });
    say("done", { ideaId: keyed().get("travel.k0")!.id });
    expect(ideas.acceptance("default", NOW)).toMatchObject({ tried: 1 });
  });

  it("restores only an idea of the provider in use", () => {
    const { ideas, offer, say, keyed } = fixture();
    offer([{ key: "travel.a" }], NOW, "default", "acme.old");
    const a = keyed().get("travel.a")!;
    say("not-interested", { ideaId: a.id });
    expect(() => ideas.restore("default", a.id, NOW)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("stops quoting a source no longer to be quoted, and forgetting it leaves the prepared run to prune, counted for the day", () => {
    const { store, ideas, offer, keyed } = fixture();
    offer([
      { key: "travel.a", overrides: { basis: [{ kind: "memory", ref: "mem-2", excerpt: "Lisbon" }] } },
      { key: "travel.b", overrides: { basis: [{ kind: "memory", ref: "mem-3", excerpt: "Porto" }] } },
    ]);
    const ids = keyed();
    store.asPort().repositories.tasks.admit({
      workspaceId: "default",
      principalId: "operator",
      operationKey: "prep-3",
      kind: "start",
      intent: { prompt: "x" },
      checkpointNamespace: "",
      origin: "ideas",
      now: () => NOW,
      newTaskId: () => "prep-3",
      newThreadId: () => "t-prep-3",
      newAdmissionId: () => "a-prep-3",
    });
    ideas.prepared({ workspaceId: "default", ideaId: ids.get("travel.b")!.id, taskId: "prep-3", text: "Found.", now: NOW });
    unquoteIdeasCiting(store.handle, "mem-2", NOW);
    expect(ideas.get("default", ids.get("travel.a")!.id)).toMatchObject({ status: "expired", basis: [{ kind: "memory", ref: "mem-2" }] });
    ideas.forgetBasis("mem-3");
    expect(ideas.get("default", ids.get("travel.b")!.id)).toBeUndefined();
    expect(ideas.preparedSince("default", NOW)).toMatchObject({ count: 1 });
    store.handle.prepare("UPDATE tavi_tasks SET status = 'completed' WHERE task_id = 'prep-3'").run();
    ideas.prune("2000-01-01T00:00:00.000Z", later(2 * DAY));
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_tasks WHERE task_id = 'prep-3'").get()).toEqual({ n: 0 });
  });
});
