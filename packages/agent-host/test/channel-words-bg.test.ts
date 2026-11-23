import { textRef, type HeartbeatLedgerRow, type HeartbeatState, type ScheduleRecord, type TextRef } from "@tavi/contracts";
import { coreEnglish } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { describe, expect, it } from "vitest";

import {
  deliverHeartbeatAlert,
  deliverHeartbeatDigest,
  deliverHeartbeatItems,
  retractHeartbeatItems,
  type HeartbeatDeliveryPort,
} from "../src/hosts/heartbeat-delivery.js";
import { sendAlert } from "../src/schedulers/schedule-alerts.js";

/**
 * A heartbeat's and a schedule's messages to a chat app are said in the
 * workspace's language (I18N-PLAN Tier 3 step 4); Home keeps the English with
 * its key, and an English workspace reads as before.
 */

const bg = coreIn("bg");
const AT = new Date("2026-10-11T09:00:00.000Z");

/** The Latin words left in `text` once `allowed` (names, codes) are taken out. */
const englishLeft = (text: string, allowed: readonly string[] = []): readonly string[] =>
  [...text.matchAll(/[A-Za-z]{3,}/g)].map((match) => match[0]).filter((word) => !allowed.includes(word));

function port(words?: typeof bg) {
  const sent: string[] = [];
  const subjects: string[] = [];
  const edited: string[] = [];
  const notified: { title: string; summary: string; titleRef?: TextRef; summaryRef?: TextRef }[] = [];
  const delivery: HeartbeatDeliveryPort = {
    ...(words === undefined ? {} : { words: async () => words }),
    notify: async (_state, notice) => {
      notified.push(notice);
      return true;
    },
    send: async (_state, _target, message) => {
      sent.push(message.text);
      subjects.push(message.subject);
      return "accepted";
    },
    edit: async (_state, _target, message) => {
      edited.push(message.text);
      return true;
    },
  };
  return { delivery, sent, subjects, edited, notified };
}

const state = {
  workspaceId: "w1",
  principalId: "alice",
  config: { targets: [{ connectionId: "c1", to: "me" }] },
} as unknown as HeartbeatState;

const row = {
  itemId: "hbi-1",
  key: "k",
  hash: "h",
  title: "A payment failed",
  body: "Card ending 4242",
  sources: [{ label: "Stripe" }],
  urgency: "now",
  state: "told",
  heldBack: false,
  lastToldAt: "2026-10-11T08:00:00.000Z",
} as unknown as HeartbeatLedgerRow;

describe("a heartbeat's channel messages in Bulgarian", () => {
  it("says an item's sources, a digest's title, a retraction and a pause alert in Bulgarian", async () => {
    const run = port(bg);
    await deliverHeartbeatItems(run.delivery, state, [row], () => undefined);
    expect(run.sent[0]).toBe("A payment failed\n\nCard ending 4242\n\nИзточници: Stripe");

    const repository = {
      digestItems: async () => [row, { ...row, itemId: "hbi-2", title: "A build broke" }],
      markDigested: async () => undefined,
    };
    await deliverHeartbeatDigest(
      { repository: repository as never, newId: () => "x" },
      run.delivery,
      state,
      { start: "w" },
      AT,
      () => undefined,
    );
    expect(run.sent[1]?.split("\n")[0]).toBe(bg("notice.heartbeat.digest.title", { count: 2, n: "2" }));
    expect(englishLeft(run.subjects[1] ?? "")).toEqual([]);
    // Home keeps the English, with its key.
    expect(run.notified[1]).toMatchObject({ title: "2 things from your heartbeat", titleRef: { key: "notice.heartbeat.digest.title" } });

    await retractHeartbeatItems(run.delivery, state, [row], AT, "UTC", () => undefined);
    expect(run.edited[0]?.split("\n")[0]).toBe("Решено · 09:00");

    await deliverHeartbeatAlert(
      run.delivery,
      state,
      {
        key: "pause:provider",
        title: textRef("notice.heartbeat.paused.title"),
        text: textRef("channel.heartbeat.alert.providerMissing", { providerId: "acme" }),
      },
      () => undefined,
    );
    expect(englishLeft(run.sent.at(-1) ?? "", ["acme"])).toEqual([]);
    expect(run.notified.at(-1)).toMatchObject({
      summary: "The heartbeat paused: its provider acme is not available. Use the built-in one, or pick another.",
      summaryRef: { key: "channel.heartbeat.alert.providerMissing" },
    });
  });

  it("reads as before in English, with or without words", async () => {
    for (const words of [undefined, coreEnglish]) {
      const run = port(words);
      await deliverHeartbeatItems(run.delivery, state, [row], () => undefined);
      expect(run.sent[0]).toBe("A payment failed\n\nCard ending 4242\n\nSources: Stripe");
      await retractHeartbeatItems(run.delivery, state, [row], AT, "UTC", () => undefined);
      expect(run.edited[0]?.split("\n")[0]).toBe("Resolved · 09:00");
    }
  });

  it("falls back to English when the words cannot be read", async () => {
    const run = port();
    const warned: string[] = [];
    const failing: HeartbeatDeliveryPort = {
      ...run.delivery,
      words: async () => {
        throw new Error("store closed");
      },
    };
    await deliverHeartbeatItems(failing, state, [row], (_level, message) => warned.push(message));
    expect(run.sent[0]).toContain("Sources: Stripe");
    expect(warned).toHaveLength(1);
  });
});

describe("a schedule's alert in Bulgarian", () => {
  const schedule = {
    scheduleId: "s-1",
    name: "brief",
    workspaceId: "w1",
    principalId: "alice",
    alert: { connectionId: "c1", destination: "chat-1" },
  } as unknown as ScheduleRecord;

  function deps(words?: typeof bg, accepted = true) {
    const sent: string[] = [];
    const home: { text: string; ref?: TextRef }[] = [];
    return {
      sent,
      home,
      deps: {
        messaging: {
          send: async (message: { parts: readonly { content?: string }[] }) => {
            sent.push(message.parts[0]?.content ?? "");
            return { status: accepted ? "accepted" : "rejected", retryable: false, parts: [] };
          },
        },
        alertHome: async (_schedule: ScheduleRecord, alert: { text: string; ref?: TextRef }) => {
          home.push(alert);
          return true;
        },
        log: () => undefined,
        ...(words === undefined ? {} : { channelWords: async () => words }),
      } as never,
    };
  }

  const missed = textRef("channel.schedule.alert.missed", {
    name: "brief",
    reason: textRef("channel.schedule.alert.missedSkip", { minutes: "42" }),
  });

  it("is sent to its target in Bulgarian, and posted to Home in English with its key", async () => {
    const run = deps(bg, false);
    await sendAlert(schedule, { identity: "fire", kind: "missed-run", text: missed }, run.deps);
    expect(run.sent[0]).toBe("Планираното изпълнение „brief“ не се изпълни: пропуснато: закъсняло с 42 мин (правило: пропусни).");
    expect(englishLeft(run.sent[0] ?? "", ["brief"])).toEqual([]);
    expect(run.home[0]).toMatchObject({
      text: 'Scheduled run "brief" did not run: skipped: missed by 42m (policy: skip).',
      ref: missed,
    });
  });

  it("reads as before in English", async () => {
    const run = deps();
    await sendAlert(schedule, { identity: "fire", kind: "missed-run", text: missed }, run.deps);
    expect(run.sent[0]).toBe('Scheduled run "brief" did not run: skipped: missed by 42m (policy: skip).');
  });
});
