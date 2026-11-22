import { describe, expect, it } from "vitest";
import { localizedText, type HeartbeatState, type ScheduleRecord, type TextRef } from "@tavi/contracts";
import { coreIn } from "@tavi/contracts/locales/core-server";

import { deliverHeartbeatAlert, type HeartbeatDeliveryPort } from "../src/hosts/heartbeat-delivery.js";
import { pauseIfFailing } from "../src/schedulers/schedule-alerts.js";
import { labelledOutcome, MANUAL_RUN, manualRunOf } from "../src/schedulers/schedule-run-kind.js";
import { textRef } from "@tavi/contracts";

/** What the heartbeat and the scheduler post to Home keeps its keys, so Home says it in its reader's language. */

const bg = coreIn("bg");

describe("Home notices from the heartbeat and the scheduler keep their keys", () => {
  it("posts a heartbeat's pause with its title by key, and sends the English to its targets", async () => {
    const notified: { title: string; summary: string; titleRef?: TextRef }[] = [];
    const sent: string[] = [];
    const port = {
      notify: async (_state: HeartbeatState, notice: { title: string; summary: string; titleRef?: TextRef }) => {
        notified.push(notice);
        return true;
      },
      send: async (_state: HeartbeatState, _target: unknown, message: { text: string }) => {
        sent.push(message.text);
        return "accepted" as const;
      },
    } as unknown as HeartbeatDeliveryPort;
    const state = {
      workspaceId: "w1",
      principalId: "alice",
      config: { targets: [{ connectionId: "c1", to: "me" }] },
    } as unknown as HeartbeatState;
    await deliverHeartbeatAlert(
      port,
      state,
      { key: "pause:budget", title: textRef("notice.heartbeat.paused.title"), text: "Over budget." },
      () => undefined,
    );
    expect(notified[0]).toMatchObject({
      title: "Your heartbeat paused",
      summary: "Over budget.",
      titleRef: { key: "notice.heartbeat.paused.title" },
    });
    expect(localizedText(notified[0]?.title ?? "", notified[0]?.titleRef, bg)).toBe("Пулсът ти е на пауза");
    expect(sent).toEqual(["Your heartbeat paused\n\nOver budget."]);
  });

  it("tells Home of a schedule paused for its failures by key, with the English its target reads", async () => {
    const home: { text: string; ref?: TextRef }[] = [];
    const schedule = { scheduleId: "s-1", name: "brief", workspaceId: "w1", principalId: "alice" } as ScheduleRecord;
    await pauseIfFailing(schedule, { fireTime: "2026-11-22T07:00:00.000Z", alertIdentity: "fire" }, {
      schedules: { pauseForFailures: async () => true },
      now: () => "2026-11-22T07:01:00.000Z",
      log: () => undefined,
      alertHome: async (_schedule: ScheduleRecord, alert: { text: string; ref?: TextRef }) => {
        home.push(alert);
        return true;
      },
    } as never);
    expect(home[0]?.text).toMatch(/^Schedule "brief" was paused: its last \d+ runs failed/);
    expect(home[0]?.ref?.key).toBe("notice.schedule.paused.text");
    expect(localizedText(home[0]?.text ?? "", home[0]?.ref, bg)).toMatch(
      /^Графикът „brief“ е на пауза: последните му \d+ пускания не успяха/,
    );
  });

  it("names what asked for a run before its outcome, by key", () => {
    const said = textRef("schedule.outcome.notPosted.failed");
    expect(labelledOutcome(false, said)).toBe(said);
    expect(localizedText("", labelledOutcome(MANUAL_RUN, said), bg)).toBe(
      "ръчно пускане: завърши, но резултатът не е публикуван: публикуването в „Начало“ не успя",
    );
    const webhook = manualRunOf({ webhook: {} });
    expect(webhook === false ? undefined : webhook.label).toBe("webhook run (no payload): ");
    expect(localizedText("", labelledOutcome(webhook, said), coreIn("en"))).toBe(
      "webhook run (no payload): completed, but its result was not posted: posting it into Home failed",
    );
    // What the call carried is Tavi's words too, said in the reader's language.
    expect(localizedText("", labelledOutcome(webhook, said), bg)).toMatch(/^пускане от уебхук \(без съдържание\): /);
    const carried = manualRunOf({ webhook: { payload: "abc" } });
    expect(carried === false ? undefined : carried.label).toMatch(/^webhook run \(payload 3 bytes, sha256 [0-9a-f]{16}\): $/);
    expect(localizedText("", labelledOutcome(carried, said), bg)).toMatch(/^пускане от уебхук \(съдържание 3 Б, sha256 [0-9a-f]{16}\): /);
  });
});
