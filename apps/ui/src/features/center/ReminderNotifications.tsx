import { useEffect, useMemo, useRef, useState } from "react";

import type { ReminderFireView } from "@tavi/contracts";

import { useAction } from "../../hooks/use-action.js";
import { mapOutcome, type SettingsClient } from "../../lib/ipc.js";
import { readStoredJson, writeStoredJson } from "../../lib/storage.js";
import { dayTime, todayIn } from "../../lib/time.js";
import { Icon } from "../../ui/Icon.js";
import { ActionNote } from "../../ui/Parts.js";
import { acknowledgeReminder, listReminderFires, snoozeReminder } from "./reminders-api.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/** Fired reminders not yet seen, at the top of the rail, each with Done and Snooze. */
export function UnseenReminderCards({
  fires,
  timeZone,
  changed,
}: {
  readonly fires: readonly ReminderFireView[];
  readonly timeZone: string | undefined;
  /** A card was answered: the unseen list is read again. */
  readonly changed: () => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const { busy, note, tone, run } = useAction(changed);
  if (fires.length === 0 && note === undefined) return null;
  const key = (fire: ReminderFireView) => `${fire.reminderId}@${fire.fireAt}`;
  return (
    <section className="reminder-cards" aria-label="Reminders">
      <h2 className="eyebrow">
        <Icon name="bell" size="sm" />
        Reminders
      </h2>
      <ul className="list-reset">
        {fires.map((fire) => (
          <li key={key(fire)} className="reminder-card">
            <span className="reminder-card-text">⏰ {fire.text}</span>
            <span className="reminder-card-when meta-sm">
              {dayTime(fire.firedAt ?? fire.fireAt, timeZone, todayIn(timeZone))}
              {fire.late === true ? " · late" : ""}
            </span>
            <span className="reminder-card-actions">
              <Button
                variant="primary"
                size="sm"
                aria-label={`Done: ${fire.text}`}
                disabled={busy !== undefined}
                onClick={() =>
                  void run(`done:${key(fire)}`, async () => {
                    const done = await acknowledgeReminder(client, workspaceId, fire.reminderId, fire.fireAt);
                    return mapOutcome(done, () => undefined);
                  })
                }
              >
                Done
              </Button>
              {([10, 60] as const).map((minutes) => (
                <Button
                  size="sm"
                  key={minutes}
                  aria-label={`Snooze ${minutes === 10 ? "10 min" : "1 h"}: ${fire.text}`}
                  disabled={busy !== undefined}
                  onClick={() =>
                    void run(`snooze:${key(fire)}`, async () => {
                      const done = await snoozeReminder(client, workspaceId, fire.reminderId, minutes, fire.fireAt);
                      return mapOutcome(done, (value) => `Snoozed “${fire.text}” until ${dayTime(value.followUp.fireAt, timeZone)}.`);
                    })
                  }
                >
                  Snooze {minutes === 10 ? "10 min" : "1 h"}
                </Button>
              ))}
            </span>
          </li>
        ))}
      </ul>
      <ActionNote note={note} tone={tone} />
    </section>
  );
}
/** The browser's permission, or `unsupported` where there is no Notification API. */
export type NotificationState = NotificationPermission | "unsupported";
function notificationState(): NotificationState {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}
/**
 * "Turn on notifications": asks the browser for permission on the click, and
 * never on its own. Once granted, a reminder fired in the app shows a browser
 * notification while the canvas is open.
 */
export function NotificationToggle() {
  const [state, setState] = useState<NotificationState>(notificationState);
  const [asking, setAsking] = useState(false);
  if (state === "unsupported") return null;
  if (state === "granted") return <span className="muted reminder-notify-on">Notifications on while this page is open</span>;
  if (state === "denied")
    return <span className="muted reminder-notify-off">Notifications are blocked for this site in the browser's settings</span>;
  return (
    <Button
      variant="ghost"
      disabled={asking}
      onClick={() => {
        setAsking(true);
        void Promise.resolve(Notification.requestPermission())
          .then((answer) => setState(answer))
          .catch(() => setState(notificationState()))
          .finally(() => setAsking(false));
      }}
    >
      <Icon name="bell" size="sm" />
      Turn on notifications
    </Button>
  );
}
/** Shown so far, per workspace: what the next page load does not show again. */
export const NOTIFIED_STORAGE_KEY = "tavi.reminders.notified";
const NOTIFIED_KEEP = 300;
/** A fire this much older than the first read still counts as new: the owner's tick and the read can straddle it. */
const NOTIFY_SLACK_MS = 60_000;
function readNotified(workspaceId: string): Set<string> {
  const parsed = readStoredJson(`${NOTIFIED_STORAGE_KEY}.${workspaceId}`);
  return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
}
/** Storage may be full or blocked: the page still works, and may show a notification twice. */
function writeNotified(workspaceId: string, keys: ReadonlySet<string>): void {
  writeStoredJson(`${NOTIFIED_STORAGE_KEY}.${workspaceId}`, [...keys].slice(-NOTIFIED_KEEP));
}
/**
 * One browser notification per reminder fire that appears while the canvas is
 * open. The first list read is the baseline and shows nothing, so opening the
 * page never replays old fires; after that a fire not seen before — on this
 * page or, through `localStorage`, on another — shows `⏰ <text>` once, when
 * permission was granted.
 */
export function useReminderNotifications(workspaceId: string, fires: readonly ReminderFireView[] | undefined): void {
  const seen = useRef<Set<string> | undefined>(undefined);
  const workspace = useRef(workspaceId);
  if (workspace.current !== workspaceId) {
    workspace.current = workspaceId;
    seen.current = undefined;
  }
  const baselineAt = useRef(0);
  const keys = useMemo(
    () =>
      fires === undefined
        ? undefined
        : fires.map((fire) => ({
            key: `${fire.reminderId}@${fire.fireAt}`,
            text: fire.text,
            firedAt: Date.parse(fire.firedAt ?? fire.fireAt),
          })),
    [fires],
  );
  useEffect(() => {
    if (keys === undefined) return;
    const stored = readNotified(workspaceId);
    if (seen.current === undefined) {
      seen.current = new Set(keys.map((item) => item.key));
      baselineAt.current = Date.now();
      for (const item of keys) stored.add(item.key);
      writeNotified(workspaceId, stored);
      return;
    }
    // Only a fire that happened since the first read is new: an old one coming into view (a longer list, another workspace's) is not.
    const fresh = keys.filter(
      (item) => !seen.current?.has(item.key) && !stored.has(item.key) && item.firedAt >= baselineAt.current - NOTIFY_SLACK_MS,
    );
    for (const item of keys) seen.current.add(item.key);
    if (fresh.length === 0) return;
    for (const item of fresh) stored.add(item.key);
    writeNotified(workspaceId, stored);
    if (notificationState() !== "granted") return;
    for (const item of fresh) {
      try {
        // The fire as its tag: a second tab showing the same fire replaces this one rather than stacking.
        new Notification(`⏰ ${item.text}`, { tag: item.key });
      } catch {
        // A browser that refuses a page notification (some want a service worker): the rail still shows it.
      }
    }
  }, [keys, workspaceId]);
}
/**
 * The reminders fired since the page first read the unseen list and not yet
 * done, each by its fire key and text, for the page to say out loud once
 * (a11y.ts `useSaidOnce`). The first read is the baseline: opening the page
 * does not read old fires aloud.
 */
export function useFreshReminders(
  workspaceId: string,
  fires: readonly ReminderFireView[] | undefined,
): readonly { readonly key: string; readonly text: string }[] {
  const baseline = useRef<{ readonly workspaceId: string; readonly keys: ReadonlySet<string> } | undefined>(undefined);
  return useMemo(() => {
    if (fires === undefined) return [];
    const key = (fire: ReminderFireView): string => `${fire.reminderId}@${fire.fireAt}`;
    if (baseline.current?.workspaceId !== workspaceId) {
      baseline.current = { workspaceId, keys: new Set(fires.map(key)) };
      return [];
    }
    const known = baseline.current.keys;
    return fires.filter((fire) => !known.has(key(fire))).map((fire) => ({ key: key(fire), text: fire.text }));
  }, [workspaceId, fires]);
}
/**
 * The fired reminders not yet seen: read on mount, and again whenever the
 * feed reports a reminder change (`revision`). Off when the owner does not
 * offer reminders.
 */
export function useUnseenReminders(
  client: SettingsClient,
  workspaceId: string,
  enabled: boolean,
  revision: number,
): { readonly fires: readonly ReminderFireView[] | undefined; readonly reload: () => void } {
  // Kept with the workspace they were read for: another workspace's fires are never handed out, not even for one render.
  const [read, setRead] = useState<{ readonly workspaceId: string; readonly fires: readonly ReminderFireView[] }>();
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void listUnseen(client, workspaceId).then((fires) => {
      if (current && fires !== undefined) setRead({ workspaceId, fires });
    });
    return () => {
      current = false;
    };
  }, [client, workspaceId, enabled, revision, generation]);
  return {
    fires: enabled && read?.workspaceId === workspaceId ? read.fires : undefined,
    reload: () => setGeneration((value) => value + 1),
  };
}
async function listUnseen(client: SettingsClient, workspaceId: string): Promise<readonly ReminderFireView[] | undefined> {
  const answer = await listReminderFires(client, workspaceId, true);
  return answer.ok ? answer.value.fires : undefined;
}
