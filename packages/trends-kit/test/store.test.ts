import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { bucketStart, openItemStore, openTrendsStore, personShapedTerm, type TopicInput } from "../src/index.js";

const NOW = "2026-10-16T12:34:56.000Z";
const temp = temporaryDirectories();
afterEach(() => temp.cleanup());
const dir = () => {
  const directory = temp.create("tavi-trends-store-");
  return directory;
};
const me = { principalId: "operator", workspaceId: "default" };
const someoneElse = { principalId: "member:2", workspaceId: "default" };
const topic: TopicInput = {
  label: "Solid-state batteries",
  terms: { en: ["solid-state battery"] },
  exclude: [],
  countries: [],
  alert: { growth: 3, corroboration: "two_independent" },
};

describe("trends.db", () => {
  it("keeps each principal's topics apart", () => {
    const store = openTrendsStore(join(dir(), "trends.db"));
    const created = store.createTopic(me, topic, NOW);
    expect(created).toMatchObject({ label: "Solid-state batteries", state: "quiet", paused: false, principalId: "operator" });
    expect(store.topics(me).map((each) => each.topicId)).toEqual([created.topicId]);
    expect(store.topics(someoneElse)).toEqual([]);
    expect(() => store.topic(created.topicId, someoneElse)).toThrow(/no topic/);
    expect(() => store.removeTopic(created.topicId, someoneElse)).toThrow(/no topic/);
    expect(store.setPaused(created.topicId, me, true, NOW).paused).toBe(true);
    expect(store.activeTopics()).toEqual([]);
    store.close();
  });

  it("stores series on aligned buckets, a missing bucket as missing, and reads a window", () => {
    const store = openTrendsStore(join(dir(), "trends.db"));
    const { topicId } = store.createTopic(me, topic, NOW);
    store.putSeries(
      [
        {
          topicId,
          sourceId: "hn-algolia",
          metric: "stories",
          bucket: "hour",
          start: "2026-10-16T10:15:00Z",
          value: 4,
          quality: "approximate",
        },
        { topicId, sourceId: "hn-algolia", metric: "stories", bucket: "hour", start: "2026-10-16T11:00:00Z", value: 0, quality: "missing" },
      ],
      NOW,
    );
    expect(store.series(topicId, "hour", "2026-10-16T00:00:00.000Z", "2026-10-17T00:00:00.000Z")).toEqual([
      {
        topicId,
        sourceId: "hn-algolia",
        metric: "stories",
        bucket: "hour",
        start: "2026-10-16T10:00:00.000Z",
        value: 4,
        quality: "approximate",
      },
      {
        topicId,
        sourceId: "hn-algolia",
        metric: "stories",
        bucket: "hour",
        start: "2026-10-16T11:00:00.000Z",
        value: 0,
        quality: "missing",
      },
    ]);
    expect(() =>
      store.putSeries([{ topicId, sourceId: "x", metric: "m", bucket: "day", start: NOW, value: -1, quality: "ok" }], NOW),
    ).toThrow(/at least 0/);
    // A refused batch writes nothing.
    expect(store.series(topicId, "day", "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z")).toEqual([]);
    store.close();
  });

  it("folds hours past 35 days into days, drops days past a source's limit, and tests past 35 days", () => {
    const store = openTrendsStore(join(dir(), "trends.db"));
    const { topicId } = store.createTopic(me, topic, NOW);
    store.putSeries(
      [
        { topicId, sourceId: "hn-algolia", metric: "stories", bucket: "hour", start: "2026-09-01T01:00:00Z", value: 2, quality: "ok" },
        { topicId, sourceId: "hn-algolia", metric: "stories", bucket: "hour", start: "2026-09-01T02:00:00Z", value: 3, quality: "missing" },
        { topicId, sourceId: "youtube", metric: "views", bucket: "day", start: "2026-09-01T00:00:00Z", value: 9, quality: "ok" },
        { topicId, sourceId: "hn-algolia", metric: "stories", bucket: "hour", start: "2026-10-16T01:00:00Z", value: 1, quality: "ok" },
      ],
      NOW,
    );
    store.recordTest(topicId, "hn-algolia", "2026-09-01T00:00:00.000Z", { g: 1 });
    store.recordTest(topicId, "hn-algolia", "2026-10-16T00:00:00.000Z", { g: 2 });
    store.retain(NOW, { youtube: 30 });
    expect(store.series(topicId, "day", "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z")).toEqual([
      {
        topicId,
        sourceId: "hn-algolia",
        metric: "stories",
        bucket: "day",
        start: "2026-09-01T00:00:00.000Z",
        value: 2,
        quality: "partial",
      },
    ]);
    expect(store.series(topicId, "hour", "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z").map((point) => point.start)).toEqual([
      "2026-10-16T01:00:00.000Z",
    ]);
    expect(store.latestTests(topicId)).toEqual([{ sourceId: "hn-algolia", at: "2026-10-16T00:00:00.000Z", result: { g: 2 } }]);
    store.close();
  });

  it("folds a day once, whole, however often retention runs on the cutoff day", () => {
    const store = openTrendsStore(join(dir(), "trends.db"));
    const { topicId } = store.createTopic(me, topic, NOW);
    store.putSeries(
      Array.from({ length: 24 }, (_, hour) => ({
        topicId,
        sourceId: "hn-algolia",
        metric: "stories",
        bucket: "hour" as const,
        start: `2026-09-11T${String(hour).padStart(2, "0")}:00:00Z`,
        value: 1,
        quality: "ok" as const,
      })),
      NOW,
    );
    // Run at 12:34 and again an hour later: 2026-09-11 is the cutoff day for both.
    store.retain(NOW);
    store.retain("2026-10-16T13:34:56.000Z");
    expect(store.series(topicId, "hour", "2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z")).toHaveLength(24);
    store.retain("2026-10-17T00:00:01.000Z");
    expect(store.series(topicId, "day", "2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z")).toEqual([
      { topicId, sourceId: "hn-algolia", metric: "stories", bucket: "day", start: "2026-09-11T00:00:00.000Z", value: 24, quality: "ok" },
    ]);
    expect(store.series(topicId, "hour", "2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z")).toEqual([]);
    store.close();
  });

  it("reads a window whatever ISO form its bounds take", () => {
    const store = openTrendsStore(join(dir(), "trends.db"));
    const { topicId } = store.createTopic(me, topic, NOW);
    store.putSeries([{ topicId, sourceId: "s", metric: "m", bucket: "hour", start: "2026-10-16T10:00:00Z", value: 1, quality: "ok" }], NOW);
    expect(store.series(topicId, "hour", "2026-10-16T10:00:00Z", "2026-10-16T11:00:00Z")).toHaveLength(1);
    expect(store.series(topicId, "hour", "2026-10-16T12:00:00+02:00", "2026-10-16T13:00:00+02:00")).toHaveLength(1);
    expect(() => store.series(topicId, "hour", "yesterday", NOW)).toThrow(/not a time/);
    store.close();
  });

  it("tracks at most 50 topics a principal, and updates one in place", () => {
    const store = openTrendsStore(join(dir(), "trends.db"));
    const first = store.createTopic(me, topic, NOW);
    for (let index = 1; index < 50; index += 1) store.createTopic(me, { ...topic, label: `Topic ${String(index)}` }, NOW);
    expect(() => store.createTopic(me, topic, NOW)).toThrow(/at most 50/);
    // Another principal's limit is their own.
    expect(store.createTopic(someoneElse, topic, NOW).principalId).toBe("member:2");
    expect(store.updateTopic(first.topicId, me, { ...topic, label: "Sodium-ion" }, "2026-10-16T13:00:00.000Z")).toMatchObject({
      label: "Sodium-ion",
      updatedAt: "2026-10-16T13:00:00.000Z",
      createdAt: NOW,
    });
    store.close();
  });

  it("pauses a source after five failures in a row, or when it asks for a wait, and a success clears the count", () => {
    const store = openTrendsStore(join(dir(), "trends.db"));
    for (let index = 0; index < 4; index += 1) store.recordOutcome("gdelt-doc", { ok: false, class: "network" }, NOW);
    expect(store.health("gdelt-doc", NOW)).toMatchObject({ consecutiveFailures: 4, lastClass: "network", callsToday: 4 });
    expect(store.health("gdelt-doc", NOW).disabledUntil).toBeUndefined();
    store.recordOutcome("gdelt-doc", { ok: false, class: "schema" }, NOW);
    expect(store.health("gdelt-doc", NOW)).toMatchObject({
      consecutiveFailures: 5,
      driftCount: 1,
      disabledUntil: "2026-10-17T12:34:56.000Z",
    });
    store.recordOutcome("gdelt-doc", { ok: true }, NOW);
    expect(store.health("gdelt-doc", NOW)).toMatchObject({ consecutiveFailures: 0, lastClass: "ok" });
    store.recordOutcome("hn-algolia", { ok: false, class: "quota", pauseUntil: "2026-10-16T13:00:00.000Z" }, NOW);
    expect(store.health("hn-algolia", NOW).disabledUntil).toBe("2026-10-16T13:00:00.000Z");
    store.close();
  });

  it("keeps a topic's state since it last changed, and forgets everything when asked", () => {
    const store = openTrendsStore(join(dir(), "trends.db"));
    const { topicId } = store.createTopic(me, topic, NOW);
    store.setState(topicId, { state: "signal", quietSweeps: 0, quietSince: NOW }, NOW);
    store.setState(topicId, { state: "signal", quietSweeps: 1, quietSince: NOW }, "2026-10-16T13:00:00.000Z");
    expect(store.topic(topicId, me)).toMatchObject({ state: "signal", stateSince: NOW, quietSweeps: 1, quietSince: NOW });
    store.sweptSource(topicId, "hn-algolia", NOW);
    store.sweptTopic(topicId, NOW, "ok");
    expect(store.sweep(topicId)).toEqual({ lastSweepAt: NOW, lastOutcome: "ok", sourcesDone: { "hn-algolia": NOW } });
    store.forget();
    expect(store.topics(me)).toEqual([]);
    store.close();
  });

  it("aligns bucket starts to the hour and the UTC day", () => {
    expect(bucketStart("2026-10-16T12:34:56+02:00", "hour")).toBe("2026-10-16T10:00:00.000Z");
    expect(bucketStart("2026-10-16T23:59:59Z", "day")).toBe("2026-10-16T00:00:00.000Z");
  });
});

describe("health past drift and the authors a read saw", () => {
  it("pauses a source when more than half its answers today drift, of at least four, and counts drift afresh each day", () => {
    const store = openTrendsStore(join(dir(), "trends.db"));
    const at = (minute: number, day = "2026-10-17") => `${day}T10:${String(minute).padStart(2, "0")}:00.000Z`;
    store.recordOutcome("gdelt-doc", { ok: true }, at(1));
    store.recordOutcome("gdelt-doc", { ok: false, class: "schema" }, at(2));
    store.recordOutcome("gdelt-doc", { ok: true }, at(3));
    // Two of four is half, not more than half.
    store.recordOutcome("gdelt-doc", { ok: false, class: "schema" }, at(4));
    expect(store.health("gdelt-doc", at(4))).toMatchObject({ driftCount: 2, callsToday: 4 });
    expect(store.health("gdelt-doc", at(4))).not.toHaveProperty("disabledUntil");
    store.recordOutcome("gdelt-doc", { ok: false, class: "schema" }, at(5));
    expect(store.health("gdelt-doc", at(5))).toMatchObject({ driftCount: 3, callsToday: 5, disabledUntil: "2026-10-18T10:05:00.000Z" });
    // Three of three drift, but three calls are too few to judge.
    store.recordOutcome("hn-algolia", { ok: false, class: "schema" }, at(1));
    store.recordOutcome("hn-algolia", { ok: false, class: "schema" }, at(2));
    store.recordOutcome("hn-algolia", { ok: false, class: "schema" }, at(3));
    expect(store.health("hn-algolia", at(3))).toMatchObject({ driftCount: 3, callsToday: 3 });
    expect(store.health("hn-algolia", at(3))).not.toHaveProperty("disabledUntil");
    // A new day starts the count again.
    expect(store.health("gdelt-doc", at(1, "2026-10-19"))).toMatchObject({ driftCount: 0, callsToday: 0 });
    store.close();
  });

  it("knows the authors a read saw today, by handle or id, only as hashes, and forgets them the next day", () => {
    const items = openItemStore(join(dir(), "items.db"));
    items.upsert(
      [
        {
          ref: "1",
          url: "https://bsky.app/profile/did:plc:x/post/1",
          title: "t",
          author: "did:plc:x",
          authorNames: ["someone.bsky.social"],
        },
      ],
      { source: "bluesky-search", origin: "adapter", ttlMs: 86_400_000 },
      NOW,
    );
    expect(items.seenAuthor("@someone.bsky.social", NOW)).toBe(true);
    expect(items.seenAuthor("did:plc:x", NOW)).toBe(true);
    expect(items.seenAuthor("solid-state battery", NOW)).toBe(false);
    expect(JSON.stringify(items.db.prepare("SELECT * FROM seen_authors").all())).not.toContain("someone");
    items.expire("2026-10-17T12:00:00.000Z");
    expect(items.seenAuthor("someone.bsky.social", "2026-10-17T12:00:00.000Z")).toBe(false);
    items.close();
  });
});

describe("trends.db's Wikidata cache", () => {
  it("caches Wikidata's answers until they expire", () => {
    const store = openTrendsStore(join(dir(), "trends.db"));
    expect(store.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    store.putWikidata("entity:Q1", { qid: "Q1" }, "2026-10-17T00:00:00.000Z", 86_400_000);
    expect(store.wikidata("entity:Q1", "2026-10-17T12:00:00.000Z")).toEqual({ qid: "Q1" });
    expect(store.wikidata("entity:Q1", "2026-10-18T00:00:01.000Z")).toBeUndefined();
    store.retain("2026-10-19T00:00:00.000Z");
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM wikidata_cache").get()).toEqual({ n: 0 });
    store.close();
  });
});

describe("cache/items.db", () => {
  it("keeps items for their window only, with authors as a hash salted per day", () => {
    const store = openItemStore(join(dir(), "items.db"));
    const [stored] = store.upsert(
      [{ ref: "1", url: "https://www.example.org/a", title: "  A   title ", text: "x".repeat(3_000), author: "@someone" }],
      { source: "bluesky-search", origin: "adapter", ttlMs: 24 * 3_600_000, topicId: "t_1" },
      NOW,
    );
    expect(stored).toMatchObject({
      itemId: expect.stringMatching(/^bluesky-search:[0-9a-f]{24}$/),
      outlet: "example.org",
      title: "A title",
      origin: "adapter",
      expiresAt: "2026-10-17T12:34:56.000Z",
    });
    expect(stored?.text.length).toBe(2_048);
    expect(stored?.authorHash).toMatch(/^[0-9a-f]{16}$/);
    expect(stored?.authorHash).not.toContain("someone");
    // The same author tomorrow is a different hash: no one is followed across days.
    expect(store.authorHash("@someone", "2026-10-17T00:00:00.000Z")).not.toBe(stored?.authorHash);
    expect(store.forTopic("t_1", "2026-10-16T00:00:00.000Z", NOW).map((item) => item.itemId)).toEqual([stored?.itemId]);
    expect(store.many([stored?.itemId ?? ""], "2026-10-17T12:34:57.000Z")).toEqual([]);
    expect(store.expire("2026-10-17T12:34:57.000Z")).toBe(1);
    store.close();
  });

  it("keeps a re-read item's topic, set and text when the new read lacks them, and reads a set in order", () => {
    const store = openItemStore(join(dir(), "items.db"));
    const placement = { source: "hn-algolia", origin: "adapter" as const, ttlMs: 3_600_000 };
    store.upsert(
      [
        { ref: "b", url: "https://example.org/b", title: "B", text: "first text" },
        { ref: "a", url: "https://example.org/a", title: "A" },
      ],
      { ...placement, topicId: "t_1", itemSet: "set-1" },
      NOW,
    );
    const [again] = store.upsert([{ ref: "b", url: "https://example.org/b", title: "B, retitled" }], placement, NOW);
    expect(again).toMatchObject({ title: "B, retitled", text: "first text" });
    expect(store.forSet("set-1", NOW).map((item) => item.title)).toEqual(["B, retitled", "A"]);
    expect(store.forTopic("t_1", "2026-10-16T00:00:00.000Z", NOW)).toHaveLength(2);
    expect(() =>
      store.upsert(
        Array.from({ length: 501 }, (_, index) => ({ ref: String(index), url: "https://example.org/", title: "x" })),
        placement,
        NOW,
      ),
    ).toThrow(/at most 500/);
    store.close();
  });

  it("keeps today's salt when an earlier day's hash is asked for", () => {
    const store = openItemStore(join(dir(), "items.db"));
    const today = store.authorHash("someone", NOW);
    store.authorHash("someone", "2026-10-15T00:00:00.000Z");
    expect(store.authorHash("someone", NOW)).toBe(today);
    store.close();
  });
});

describe("person-shaped terms", () => {
  it("are handles, accounts and DIDs, not topics", () => {
    for (const term of ["@jane", "＠jane", "u/jane", "/u/jane", "did:plc:abc"]) expect(personShapedTerm(term), term).toBe(true);
    for (const term of ["solid-state battery", "AT&T", "C++ @ scale"]) expect(personShapedTerm(term), term).toBe(false);
  });
});
