import { describe, expect, it } from "vitest";

import {
  benjaminiHochberg,
  dispersion,
  judgeSweep,
  logGamma,
  negativeBinomialUpperTail,
  nextState,
  normalUpperTail,
  poissonUpperTail,
  testSource,
  type Observation,
  type SourceTest,
} from "../src/index.js";

const alert = { growth: 3, corroboration: "two_independent" as const };
const DAY_MS = 86_400_000;

/** Daily observations ending the day before `now`: `values[i]` is `days - i` days back. */
function daily(values: readonly number[], end = "2026-10-17T00:00:00.000Z"): Observation[] {
  return values.map((value, index) => ({
    start: new Date(Date.parse(end) - (values.length - index) * DAY_MS).toISOString(),
    value,
    quality: "ok" as const,
  }));
}

describe("the statistics", () => {
  it("compute Poisson, negative-binomial and normal upper tails", () => {
    // P(X ≥ 3 | μ = 1) = 1 − e⁻¹(1 + 1 + ½).
    expect(poissonUpperTail(3, 1)).toBeCloseTo(1 - Math.exp(-1) * 2.5, 10);
    expect(poissonUpperTail(0, 4)).toBe(1);
    // A huge dispersion is Poisson.
    expect(negativeBinomialUpperTail(30, 10, 1e9)).toBeCloseTo(poissonUpperTail(30, 10), 6);
    // Over-dispersion makes a spike less surprising.
    expect(negativeBinomialUpperTail(30, 10, 2)).toBeGreaterThan(poissonUpperTail(30, 10) * 1e3);
    expect(normalUpperTail(1.6448536)).toBeCloseTo(0.05, 6);
    expect(normalUpperTail(-1.6448536)).toBeCloseTo(0.95, 6);
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 10);
    expect(poissonUpperTail(500, 10)).toBeLessThan(1e-200);
    // A first term too small to represent: 0 above the mean, 1 below it, and quickly.
    expect(poissonUpperTail(5, 1e6)).toBe(1);
    expect(negativeBinomialUpperTail(1e7, 3, 2)).toBe(0);
  });

  it("stay accurate when a baseline's variance is at its mean up to rounding", () => {
    const k = dispersion([33, 24, 34]);
    expect(k).toBe(Number.POSITIVE_INFINITY);
    expect(negativeBinomialUpperTail(40, 91 / 3, k)).toBeCloseTo(poissonUpperTail(40, 91 / 3), 12);
    // A large finite k agrees with Poisson rather than collapsing to 0 or 1.
    expect(negativeBinomialUpperTail(31, 30.3, 1e6)).toBeCloseTo(poissonUpperTail(31, 30.3), 3);
    expect(negativeBinomialUpperTail(50, 30.3, 1e6)).toBeCloseTo(poissonUpperTail(50, 30.3), 5);
  });

  it("fit a dispersion by moments, Poisson when the sample shows no extra variance", () => {
    expect(dispersion([10, 10, 10])).toBe(Number.POSITIVE_INFINITY);
    expect(dispersion([1, 10, 1, 10])).toBeCloseTo(30.25 / 21.5, 10);
    expect(dispersion([0, 50, 0, 50, 0])).toBe(1);
  });

  it("control the false discovery rate with Benjamini–Hochberg", () => {
    expect(benjaminiHochberg([0.01, 0.04, 0.03, 0.005], 0.05)).toEqual([true, true, true, true]);
    expect(benjaminiHochberg([0.01, 0.2, 0.03], 0.05)).toEqual([true, false, true]);
    expect(benjaminiHochberg([0.04, 0.04, 0.04, 0.04, 0.04], 0.05)).toEqual([true, true, true, true, true]);
    expect(benjaminiHochberg([0.02, 0.5, 0.6, 0.7, 0.8], 0.05)).toEqual([false, false, false, false, false]);
  });
});

describe("one source's test", () => {
  const now = "2026-10-17T06:00:00.000Z";

  it("raises a news spike well over its previous days, with every number shown", () => {
    const test = testSource({
      sourceId: "gdelt-doc",
      kind: "news",
      metric: "articles",
      bucket: "day",
      observations: daily([9, 11, 10, 12, 8, 10, 11, 60]),
      now,
      alert,
    });
    expect(test).toMatchObject({
      test: "count",
      x: 60,
      baseline: 10,
      baselineKind: "previous-days",
      floorMet: true,
      crossChecked: true,
      window: { from: "2026-10-16T00:00:00.000Z", to: "2026-10-17T00:00:00.000Z" },
    });
    expect(test.g).toBeCloseTo(65 / 15 - 1, 10);
    expect(test.growthBaseline).toBe(10);
    expect(test.p).toBeLessThan(1e-10);
  });

  it("reads 1 → 4 as +50%, not +300%, and leaves it under the floor", () => {
    const test = testSource({
      sourceId: "gdelt-doc",
      kind: "news",
      metric: "articles",
      bucket: "day",
      observations: daily([1, 1, 1, 1, 1, 1, 1, 4]),
      now,
      alert,
    });
    expect(test.g).toBeCloseTo(0.5, 10);
    expect(test.floorMet).toBe(false);
  });

  it("tests a lagging daily source on its newest day read, never on a day not yet published", () => {
    const observations = [
      ...daily([300, 310, 290, 305, 295, 300, 310, 2_400]),
      { start: "2026-10-17T00:00:00.000Z", value: 0, quality: "missing" as const },
    ];
    const test = testSource({
      sourceId: "wikipedia-pageviews",
      kind: "attention",
      metric: "views",
      bucket: "day",
      observations,
      now: "2026-10-17T20:00:00.000Z",
      alert,
    });
    expect(test).toMatchObject({ test: "count", x: 2_400, floorMet: true, window: { to: "2026-10-17T00:00:00.000Z" } });
    // A robust z for a baseline in the hundreds.
    expect(test.k).toBeUndefined();
    expect(test.z).toBeGreaterThan(10);
  });

  it("will not test without three earlier days, with most of today missing, or on a stale source", () => {
    expect(testSource({ sourceId: "s", kind: "news", metric: "m", bucket: "day", observations: daily([5, 50]), now, alert })).toMatchObject(
      { test: "insufficient", reason: expect.stringMatching(/3 earlier days; 1 were read/) },
    );
    const hours = Array.from({ length: 24 * 5 }, (_, index) => ({
      start: new Date(Date.parse("2026-10-12T06:00:00.000Z") + index * 3_600_000).toISOString(),
      value: 1,
      quality: (index >= 24 * 4 + 6 ? "missing" : "ok") as Observation["quality"],
    }));
    expect(testSource({ sourceId: "s", kind: "social", metric: "authors", bucket: "hour", observations: hours, now, alert })).toMatchObject(
      { test: "count", window: { to: "2026-10-16T12:00:00.000Z" } },
    );
    expect(
      testSource({
        sourceId: "s",
        kind: "news",
        metric: "m",
        bucket: "day",
        observations: daily([1, 1, 1, 1, 9], "2026-10-01T00:00:00.000Z"),
        now,
        alert,
      }),
    ).toMatchObject({ test: "insufficient", reason: expect.stringMatching(/three days/) });
  });

  it("uses the same weekday of earlier weeks when four or more were read, so a weekly rhythm is no spike", () => {
    // Mondays run at 50, other days at 10: a Monday of 52 is ordinary.
    // The tested day is index 36; the same weekday of earlier weeks is index 36 − 7k, so index % 7 === 1.
    const values: number[] = Array.from({ length: 36 }, (_, index) => (index % 7 === 1 ? 50 : 10));
    values.push(52);
    const test = testSource({
      sourceId: "hn-algolia",
      kind: "community",
      metric: "stories",
      bucket: "day",
      observations: daily(values),
      now,
      alert,
    });
    expect(test).toMatchObject({ test: "count", baselineKind: "seasonal" });
    expect(test.baseline).toBe(50);
    expect(test.p).toBeGreaterThan(0.05);
  });

  it("scales the seasonal baseline by how the last week ran against earlier ones", () => {
    // The last week ran at twice the level: its Monday baseline is 100, not 50.
    const values: number[] = Array.from({ length: 36 }, (_, index) => (index % 7 === 1 ? 50 : 10) * (index >= 29 ? 2 : 1));
    values.push(100);
    const test = testSource({
      sourceId: "hn-algolia",
      kind: "community",
      metric: "stories",
      bucket: "day",
      observations: daily(values),
      now,
      alert,
    });
    expect(test).toMatchObject({ baselineKind: "seasonal", baseline: 100 });
  });

  it("fails the cross-check when yesterday was bigger", () => {
    const test = testSource({
      sourceId: "gdelt-doc",
      kind: "news",
      metric: "articles",
      bucket: "day",
      observations: daily([10, 10, 10, 10, 10, 90, 60]),
      now,
      alert,
    });
    expect(test.crossChecked).toBe(false);
  });

  it("treats a place on Google's trending list now as a presence test, with no p-value or growth of its own", () => {
    const observations: Observation[] = [{ start: "2026-10-17T05:00:00.000Z", value: 2_000, quality: "approximate" }];
    expect(
      testSource({ sourceId: "gtrends-rss", kind: "search", metric: "traffic", bucket: "hour", observations, now, alert }),
    ).toMatchObject({ test: "presence", x: 2_000, floorMet: true, p: 1, g: 0 });
    // On the list 20 hours ago is not now.
    const earlier: Observation[] = [{ start: "2026-10-16T10:00:00.000Z", value: 2_000, quality: "approximate" }];
    expect(
      testSource({ sourceId: "gtrends-rss", kind: "search", metric: "traffic", bucket: "hour", observations: earlier, now, alert }),
    ).toMatchObject({ test: "presence", x: 0, floorMet: false });
  });

  it("measures growth over the previous days even when a seasonal baseline tests it", () => {
    const values: number[] = Array.from({ length: 36 }, (_, index) => (index % 7 === 1 ? 50 : 10));
    values.push(52);
    const test = testSource({
      sourceId: "hn-algolia",
      kind: "community",
      metric: "stories",
      bucket: "day",
      observations: daily(values),
      now,
      alert,
    });
    expect(test).toMatchObject({ baselineKind: "seasonal", baseline: 50, growthBaseline: 10 });
    expect(test.g).toBeCloseTo(57 / 15 - 1, 10);
  });

  it("builds a seasonal baseline from an hourly series", () => {
    const start = Date.parse("2026-09-12T06:00:00.000Z");
    const hours = Array.from({ length: 35 * 24 }, (_, index) => ({
      start: new Date(start + index * 3_600_000).toISOString(),
      value: 1,
      quality: "ok" as const,
    }));
    expect(
      testSource({ sourceId: "bluesky-search", kind: "social", metric: "authors", bucket: "hour", observations: hours, now, alert }),
    ).toMatchObject({ test: "count", baselineKind: "seasonal", x: 24, baseline: 24 });
  });

  it("holds pageviews to twice their 30-day median, not their week's", () => {
    // 2,100 is over twice a month of 1,000 a day, but not over twice a month of 1,500.
    const values = [...Array.from<number>({ length: 23 }).fill(1_000), ...Array.from<number>({ length: 7 }).fill(1_000), 2_100];
    expect(
      testSource({
        sourceId: "wikipedia-pageviews",
        kind: "attention",
        metric: "views",
        bucket: "day",
        observations: daily(values),
        now,
        alert,
      }).floorMet,
    ).toBe(true);
    const busyMonth = [...Array.from<number>({ length: 30 }).fill(1_500), 2_100];
    expect(
      testSource({
        sourceId: "wikipedia-pageviews",
        kind: "attention",
        metric: "views",
        bucket: "day",
        observations: daily(busyMonth),
        now,
        alert,
      }).floorMet,
    ).toBe(false);
  });
});

describe("a sweep's judgement and a topic's state", () => {
  const count = (sourceId: string, kind: SourceTest["kind"], p: number, g = 4): SourceTest => ({
    sourceId,
    kind,
    metric: "m",
    test: "count",
    x: 50,
    baseline: 5,
    p,
    z: 5,
    g,
    floorMet: true,
    crossChecked: true,
  });

  it("passes a test only as a discovery that meets its floor and its cross-check", () => {
    const judged = judgeSweep([
      count("a", "news", 0.001),
      count("b", "community", 0.5),
      { ...count("c", "social", 0.001), crossChecked: false },
      { ...count("d", "news", 0.001), floorMet: false },
    ]);
    expect(judged.map((test) => [test.sourceId, test.pBh, test.passed])).toEqual([
      ["a", true, true],
      ["b", false, false],
      ["c", true, false],
      ["d", true, false],
    ]);
    // A presence test passes on its own; an insufficient one never; neither takes a place in the correction.
    const presence = { ...count("g", "search", 1, 0), test: "presence" as const };
    const insufficient = { ...count("i", "news", 0), test: "insufficient" as const };
    const mixed = judgeSweep([presence, insufficient, count("a", "news", 0.02), count("b", "news", 0.04)]);
    expect(mixed.map((test) => test.passed)).toEqual([true, false, true, true]);
    expect(mixed[0]).not.toHaveProperty("pBh");
  });

  it("confirms with two families, signals with one, and counts two sources of one family once", () => {
    const passed = (sourceId: string, kind: SourceTest["kind"]): SourceTest => ({ ...count(sourceId, kind, 0.001), passed: true });
    const quiet = { state: "quiet" as const, quietSweeps: 0 };
    expect(nextState(quiet, [passed("gdelt-doc", "news"), passed("rss-europe", "news")], "2026-10-17T06:00:00.000Z", 3)).toEqual({
      state: "signal",
      quietSweeps: 0,
    });
    expect(nextState(quiet, [passed("gdelt-doc", "news"), passed("hn-algolia", "community")], "2026-10-17T06:00:00.000Z", 3).state).toBe(
      "confirmed",
    );
    // The topic's rule: passing tests that all grow under the threshold raise nothing.
    expect(
      nextState(
        quiet,
        [
          { ...passed("gdelt-doc", "news"), g: 2 },
          { ...passed("hn-algolia", "community"), g: 2.5 },
        ],
        "2026-10-17T06:00:00.000Z",
        3,
      ).state,
    ).toBe("quiet");
    // One family growing past it is enough for the topic, and the other still counts toward confirmed.
    expect(
      nextState(quiet, [{ ...passed("gdelt-doc", "news"), g: 2 }, passed("hn-algolia", "community")], "2026-10-17T06:00:00.000Z", 3).state,
    ).toBe("confirmed");
    // A presence on Google's list raises the topic though it has no growth of its own.
    expect(nextState(quiet, [{ ...passed("gtrends-rss", "search"), test: "presence", g: 0 }], "2026-10-17T06:00:00.000Z", 3).state).toBe(
      "signal",
    );
    // A signal joined by a second family is confirmed; a confirmed topic left with one family stays confirmed.
    const signal = { state: "signal" as const, quietSweeps: 0 };
    expect(nextState(signal, [passed("gdelt-doc", "news"), passed("hn-algolia", "community")], "2026-10-17T07:00:00.000Z", 3).state).toBe(
      "confirmed",
    );
    expect(nextState({ state: "confirmed", quietSweeps: 0 }, [passed("gdelt-doc", "news")], "2026-10-17T08:00:00.000Z", 3).state).toBe(
      "confirmed",
    );
  });

  it("falls quiet only after two calm sweeps, and is not raised again within 12 hours", () => {
    const raised = { state: "confirmed" as const, quietSweeps: 0 };
    const calm: SourceTest = { ...count("a", "news", 0.5), z: 0.2, passed: false };
    const once = nextState(raised, [calm], "2026-10-17T01:00:00.000Z", 3);
    expect(once).toMatchObject({ state: "confirmed", quietSweeps: 1 });
    const twice = nextState(once, [calm], "2026-10-17T02:00:00.000Z", 3);
    expect(twice).toEqual({ state: "quiet", quietSweeps: 0, quietSince: "2026-10-17T02:00:00.000Z" });
    const spike: SourceTest = { ...count("a", "news", 0.001), passed: true };
    // The cooldown counts from falling quiet, not from the raise.
    expect(nextState(twice, [spike], "2026-10-17T13:00:00.000Z", 3).state).toBe("quiet");
    expect(nextState(twice, [spike], "2026-10-17T14:00:00.000Z", 3)).toMatchObject({ state: "signal" });
    // No count test at all is no evidence of calm.
    expect(nextState(raised, [{ ...calm, test: "insufficient" }], "2026-10-17T01:00:00.000Z", 3).quietSweeps).toBe(0);
    // Still elevated, though not passing: no calm sweep counted.
    expect(nextState(raised, [{ ...calm, z: 2 }], "2026-10-17T01:00:00.000Z", 3).quietSweeps).toBe(0);
  });
});
