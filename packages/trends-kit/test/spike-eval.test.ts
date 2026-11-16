import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { domainFixtures } from "@tavi/test-support/fixtures";
import { describe, expect, it } from "vitest";

import {
  judgeSweep,
  nextState,
  testSource,
  type Observation,
  type SourceTest,
  type TopicStateMemory,
  type TrendsSourceKind,
} from "../src/index.js";

/**
 * The spike-detection fixture set: daily Wikipedia pageviews
 * (CC0) and Hacker News story counts recorded around six labelled events and
 * four quiet controls, replayed as a daily 06:00 UTC sweep of all ten topics
 * together, so Benjamini–Hochberg corrects across them as it would live.
 * Ground truth is each event's onset day (the Wikipedia Current Events
 * portal's date). `TRENDS_EVAL_PRINT=1` prints the results table.
 */
interface Case {
  readonly id: string;
  readonly kind: "event" | "control";
  readonly onset: string | null;
  readonly series: Readonly<Record<string, readonly { readonly day: string; readonly value: number }[]>>;
}

const directory = join(domainFixtures("trends"), "spikes");
const cases: Case[] = readdirSync(directory)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(directory, file), "utf8")) as Case);
const KINDS: Record<string, TrendsSourceKind> = { "wikipedia-pageviews": "attention", "hn-algolia": "community" };
const alert = { growth: 3, corroboration: "two_independent" as const };
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** The first sweep has five weeks behind it: enough for a seasonal baseline. */
const FIRST_SWEEP = 36;
/** An alert counts for an event from the day before its onset to four days after. */
const EARLY_DAYS = 1;
const LATE_DAYS = 4;

interface Raise {
  readonly at: string;
  readonly state: "signal" | "confirmed";
}

/** Replays every case's daily sweeps; returns each case's raises. */
function replay(): Map<string, Raise[]> {
  const memory = new Map<string, TopicStateMemory>(cases.map((each) => [each.id, { state: "quiet", quietSweeps: 0 }]));
  const raises = new Map<string, Raise[]>(cases.map((each) => [each.id, []]));
  const length = Math.max(...cases.flatMap((each) => Object.values(each.series).map((series) => series.length)));
  for (let sweep = FIRST_SWEEP; sweep <= length; sweep += 1) {
    const pending: { readonly id: string; readonly at: string; readonly test: SourceTest }[] = [];
    for (const each of cases) {
      for (const [sourceId, series] of Object.entries(each.series)) {
        if (sweep > series.length) continue;
        // The sweep runs at 06:00 on day `sweep`, seeing each day before it.
        const firstDay = Date.parse(`${series[0]?.day ?? ""}T00:00:00.000Z`);
        const at = new Date(firstDay + sweep * DAY_MS + 6 * HOUR_MS).toISOString();
        const observations: Observation[] = series
          .slice(0, sweep)
          .map((point) => ({ start: `${point.day}T00:00:00.000Z`, value: point.value, quality: "ok" }));
        const kind = KINDS[sourceId] ?? "news";
        pending.push({
          id: each.id,
          at,
          test: testSource({ sourceId, kind, metric: "count", bucket: "day", observations, now: at, alert }),
        });
      }
    }
    const judged = judgeSweep(pending.map((entry) => entry.test));
    for (const each of cases) {
      const own = judged.filter((_, index) => pending[index]?.id === each.id);
      const at = pending.find((entry) => entry.id === each.id)?.at;
      if (at === undefined || own.length === 0) continue;
      const before = memory.get(each.id) ?? { state: "quiet", quietSweeps: 0 };
      const after = nextState(before, own, at, alert.growth);
      memory.set(each.id, after);
      if (after.state !== "quiet" && (before.state === "quiet" || (before.state === "signal" && after.state === "confirmed")))
        raises.get(each.id)?.push({ at, state: after.state });
    }
  }
  return raises;
}

interface Metrics {
  readonly confirmedRecall: number;
  readonly signalRecall: number;
  /** Hours from onset (00:00 UTC) to the first confirmed alert, per detected event. */
  readonly confirmedTtdHours: readonly number[];
  readonly falseConfirmedPerTopicWeek: number;
  readonly falseSignalsPerTopicWeek: number;
  readonly rows: readonly string[];
}

function evaluate(raises: ReadonlyMap<string, readonly Raise[]>): Metrics {
  let confirmable = 0;
  let confirmedHits = 0;
  let signalHits = 0;
  let events = 0;
  let falseConfirmed = 0;
  let falseSignals = 0;
  let quietDays = 0;
  const ttd: number[] = [];
  const rows: string[] = [];
  for (const each of cases) {
    const own = raises.get(each.id) ?? [];
    const days = Math.max(...Object.values(each.series).map((series) => series.length)) - FIRST_SWEEP + 1;
    const families = new Set(Object.keys(each.series).map((sourceId) => KINDS[sourceId])).size;
    if (each.kind === "control" || each.onset === null) {
      quietDays += days;
      falseConfirmed += own.filter((raise) => raise.state === "confirmed").length;
      falseSignals += own.length;
      rows.push(
        `${each.id} (control): ${own.length === 0 ? "no alarm" : own.map((raise) => `${raise.state} ${raise.at.slice(0, 10)}`).join(", ")}`,
      );
      continue;
    }
    events += 1;
    if (families >= 2) confirmable += 1;
    const onset = Date.parse(`${each.onset}T00:00:00.000Z`);
    const inWindow = (raise: Raise): boolean =>
      Date.parse(raise.at) >= onset - EARLY_DAYS * DAY_MS && Date.parse(raise.at) <= onset + LATE_DAYS * DAY_MS;
    const early = own.filter((raise) => Date.parse(raise.at) < onset - EARLY_DAYS * DAY_MS);
    falseConfirmed += early.filter((raise) => raise.state === "confirmed").length;
    falseSignals += early.length;
    quietDays += Math.max(
      0,
      Math.round(
        (onset -
          EARLY_DAYS * DAY_MS -
          (Date.parse(`${Object.values(each.series)[0]?.[0]?.day ?? ""}T00:00:00.000Z`) + FIRST_SWEEP * DAY_MS)) /
          DAY_MS,
      ),
    );
    const firstSignal = own.find(inWindow);
    const firstConfirmed = own.find((raise) => raise.state === "confirmed" && inWindow(raise));
    if (firstSignal !== undefined) signalHits += 1;
    if (firstConfirmed !== undefined) {
      confirmedHits += 1;
      ttd.push((Date.parse(firstConfirmed.at) - onset) / HOUR_MS);
    }
    rows.push(
      `${each.id} (onset ${each.onset}, ${String(families)} famil${families === 1 ? "y" : "ies"}): ${firstConfirmed === undefined ? (firstSignal === undefined ? "missed" : `signal ${firstSignal.at}`) : `confirmed ${firstConfirmed.at}, ${String((Date.parse(firstConfirmed.at) - onset) / HOUR_MS)} h after onset`}`,
    );
  }
  const topicWeeks = quietDays / 7;
  return {
    confirmedRecall: confirmedHits / confirmable,
    signalRecall: signalHits / events,
    confirmedTtdHours: ttd,
    falseConfirmedPerTopicWeek: falseConfirmed / topicWeeks,
    falseSignalsPerTopicWeek: falseSignals / topicWeeks,
    rows,
  };
}

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;

describe("the spike-detection fixture set", () => {
  const metrics = evaluate(replay());
  if (process.env["TRENDS_EVAL_PRINT"] === "1") {
    console.log(
      [
        ...metrics.rows,
        `confirmed recall ${metrics.confirmedRecall.toFixed(2)} (events with two families), signal recall ${metrics.signalRecall.toFixed(2)}, median time to confirmed ${String(median(metrics.confirmedTtdHours))} h, false confirmed ${metrics.falseConfirmedPerTopicWeek.toFixed(3)} and false signals ${metrics.falseSignalsPerTopicWeek.toFixed(3)} per topic-week`,
      ].join("\n"),
    );
  }

  it("records ten cases: six labelled events and four quiet controls", () => {
    expect(cases.filter((each) => each.kind === "event")).toHaveLength(6);
    expect(cases.filter((each) => each.kind === "control")).toHaveLength(4);
  });

  it("confirms at least 80% of the events two families can confirm within four days, half of them within a day and a half of onset", () => {
    expect(metrics.confirmedRecall).toBeGreaterThanOrEqual(0.8);
    // Daily sources: the onset day is read at the next morning's sweep, 30 hours after the onset began.
    expect(median(metrics.confirmedTtdHours)).toBeLessThanOrEqual(30);
  });

  it("raises a signal for every event, the single-family one included", () => {
    expect(metrics.signalRecall).toBe(1);
  });

  it("raises at most one false alert, confirmed or signal, per four topic-weeks", () => {
    expect(metrics.falseConfirmedPerTopicWeek).toBeLessThanOrEqual(0.25);
    expect(metrics.falseSignalsPerTopicWeek).toBeLessThanOrEqual(0.25);
  });
});
