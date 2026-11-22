import { useId, useState, type ReactNode } from "react";
import type { ScheduleRecord, SchedulesPayload } from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

import { translateNow, useT } from "../../lib/i18n.js";
import { attempt, type Outcome, type SettingsClient } from "../../lib/ipc.js";
import type { UiKey } from "../../locales/en.js";
import { useAction, type ActionTone } from "../../hooks/use-action.js";
import { Button } from "../../ui/Button.js";
import { notStartedText } from "./schedule-model.js";
import { scheduleRequest, showSchedule } from "./schedules-api.js";
import { ScheduleForm } from "./ScheduleForm.js";

/**
 * Plain schedules — a prompt run on a daily cadence, with no routine around
 * it — as rows of Schedule's Recurring list,
 * where Settings → Schedules folded in: the row's actions and the add, edit
 * and duplicate form they open. The owner's `schedules` requests are in
 * `schedules-api.ts`, the form is `ScheduleForm`, the row itself is `RecurringRow`.
 */

/** What a row's controls do, and the one form open at a time. */
export interface ScheduleActions {
  readonly busy: string | undefined;
  readonly note: string | undefined;
  readonly tone: ActionTone;
  /** One action on the schedule `name`d: its note says what changed. */
  readonly act: (payload: SchedulesPayload, name: string) => Promise<void>;
  readonly edit: (scheduleId: string) => void;
  /** The add form, filled from the schedule `show` reads: a copy under a new name. */
  readonly duplicate: (scheduleId: string) => void;
  readonly create: () => void;
  readonly openLast: (taskId: string) => void;
  /** The add or edit form, while one is open. */
  readonly form: ReactNode;
}

/** What each change says once the owner took it. */
const CHANGED: Partial<Record<SchedulesPayload["action"], UiKey>> = {
  enable: "center.plainSchedules.resumed",
  disable: "center.plainSchedules.paused",
};

/** An action that only reads: nothing is read again after it. */
const READ_ONLY = { reload: false } as const;

/**
 * The plain schedules' actions: one at a time, each ending in a note that
 * says what changed (or why not) and `reload`. Run now opens the task it
 * started; a task that cannot be opened says so rather than failing quietly.
 * Deleting is not here: it waits behind its Undo (`useUndoDelete`).
 */
export function useScheduleActions(
  client: SettingsClient,
  workspaceId: string,
  reload: () => void,
  onFollow?: (taskId: string) => Promise<void>,
  timeZone?: string,
): ScheduleActions {
  const t = useT();
  const { busy, note, tone, run, say } = useAction(reload);
  const [editing, setEditing] = useState<ScheduleRecord | ScheduleDraft | "new">();
  const follow = (taskId: string, done: string, refused: string): Promise<Outcome<string | undefined>> =>
    attempt(
      async () => {
        await onFollow?.(taskId);
        return done;
      },
      (message) => t("center.plainSchedules.openRefused", { refused, message }),
    );
  const act = (payload: SchedulesPayload, name: string) =>
    run(`${payload.action}:${payload.scheduleId ?? ""}`, async () => {
      const answer = await scheduleRequest<{ taskId?: string; outcome?: { reason?: string; kind?: string } }>(client, {
        ...payload,
        workspaceId,
      });
      if (!answer.ok) return answer;
      if (payload.action === "run") {
        if (answer.value.taskId)
          return follow(
            answer.value.taskId,
            t("center.plainSchedules.started", { name }),
            t("center.plainSchedules.startedNotOpened", { name }),
          );
        return { ok: false, message: t("center.plainSchedules.notStarted", { name, reason: notStartedText(answer.value.outcome) }) };
      }
      return { ok: true, value: t(CHANGED[payload.action] ?? "center.plainSchedules.saved", { name }) };
    });
  const edit = (scheduleId: string): void =>
    void run(
      `edit:${scheduleId}`,
      async () => {
        const answer = await scheduleRequest<ScheduleRecord>(client, { action: "show", workspaceId, scheduleId });
        if (!answer.ok) return answer;
        setEditing(answer.value);
        return { ok: true, value: undefined };
      },
      READ_ONLY,
    );
  const duplicate = (scheduleId: string): void =>
    void run(
      `duplicate:${scheduleId}`,
      async () => {
        const answer = await showSchedule(client, workspaceId, scheduleId);
        if (!answer.ok) return answer;
        setEditing(scheduleDraft(answer.value));
        return { ok: true, value: undefined };
      },
      READ_ONLY,
    );
  const openLast = (taskId: string): void =>
    void run(
      `open:${taskId}`,
      () => follow(taskId, t("center.plainSchedules.taskOpened"), t("center.plainSchedules.taskNotOpened")),
      READ_ONLY,
    );
  const existing = editing !== undefined && editing !== "new" && "scheduleId" in editing ? editing : undefined;
  const form = editing ? (
    <ScheduleForm
      key={existing?.scheduleId ?? (editing === "new" ? "new" : "copy")}
      client={client}
      workspaceId={workspaceId}
      initial={existing}
      draft={editing === "new" || existing !== undefined ? undefined : editing}
      timeZone={timeZone}
      onClose={() => setEditing(undefined)}
      onSaved={(name) => {
        setEditing(undefined);
        reload();
        say(t(existing === undefined ? "center.plainSchedules.created" : "center.plainSchedules.saved", { name }));
      }}
    />
  ) : null;
  return { busy, note, tone, act, edit, duplicate, create: () => setEditing("new"), openLast, form };
}

/** What a new schedule's form may start from: another schedule's settings, without its id or history. */
export type ScheduleDraft = Pick<ScheduleRecord, "name" | "prompt" | "spec" | "missedRunPolicy" | "autoApproveTools"> &
  Partial<
    Pick<
      ScheduleRecord,
      "agentId" | "alert" | "humanCheckpoints" | "notify" | "maxTokens" | "deliverTo" | "maxRunMinutes" | "precheck" | "watch"
    >
  >;

/** A copy of `record` to start a new schedule from: its settings, named "<name> (copy)". */
function scheduleDraft(record: ScheduleRecord): ScheduleDraft {
  return {
    name: translateNow("center.plainSchedules.copyName", { name: record.name }),
    prompt: record.prompt,
    spec: record.spec,
    missedRunPolicy: record.missedRunPolicy,
    autoApproveTools: record.autoApproveTools,
    ...definedOnly({
      agentId: record.agentId,
      alert: record.alert,
      humanCheckpoints: record.humanCheckpoints,
      notify: record.notify,
      maxTokens: record.maxTokens,
      deliverTo: record.deliverTo,
      maxRunMinutes: record.maxRunMinutes,
      precheck: record.precheck,
    }),
    ...(record.watch === true ? { watch: true as const } : {}),
  };
}

/** An on/off switch: a button that says what pressing it does, and whether it is on. */
export function Switch({
  on,
  label,
  warning,
  hint,
  disabled,
  onToggle,
}: {
  readonly on: boolean;
  readonly label: string;
  /** What is wrong while it is on: the switch is drawn in the warning colour, and says it. */
  readonly warning?: string | undefined;
  /** Why it cannot be pressed, said the same way without the warning colour. */
  readonly hint?: string | undefined;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}) {
  const t = useT();
  const describedId = useId();
  const said = warning ?? hint;
  return (
    <>
      <Button
        variant="bare"
        role="switch"
        className={warning === undefined ? "switch" : "switch switch-warning"}
        aria-checked={on}
        aria-label={label}
        aria-describedby={said === undefined ? undefined : describedId}
        title={said === undefined ? label : t("center.plainSchedules.switchTitle", { label, said })}
        disabled={disabled}
        onClick={onToggle}
      />
      {said === undefined ? null : (
        <span id={describedId} className="visually-hidden">
          {said}
        </span>
      )}
    </>
  );
}
