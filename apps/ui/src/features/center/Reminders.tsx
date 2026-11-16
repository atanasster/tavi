import { useState } from "react";

import {
  REMINDER_MAX_NOTICES,
  REMINDER_MAX_TIMES_PER_DAY,
  REMINDER_PROMPT_MAX,
  REMINDER_TEXT_MAX,
  type ReminderDeliverTo,
  type ReminderView,
  type ReminderWhen,
  type ScheduleSpec,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

import { useLoaded } from "../../hooks/use-loaded.js";
import { localDate, localTime, shiftDate } from "../../lib/time.js";
import { Icon } from "../../ui/Icon.js";
import { Select } from "../../ui/Select.js";
import { operationKey } from "../routines/api.js";
import { FormActions, FormFailure } from "../settings/FormParts.js";
import { DEFAULT_NOTICES, localToInstant, noticeFrom, noticeLabel } from "./reminder-model.js";
import { createReminder, listReminderTargets, updateReminder } from "./reminders-api.js";
import { BusyFieldset } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { cadenceProblems, listedTimes } from "../../ui/cadence.js";
import { CadenceField, type CadenceAllows } from "../../ui/CadenceField.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * Reminders in the Command Center: the New
 * reminder form, a reminder's own page, its rows in Schedule, the fired ones
 * waiting in the rail, and the browser-notification opt-in. What the page adds
 * is delivered in the app; a reminder in a chat is asked for in that chat.
 */

// ---- New reminder -----------------------------------------------------------

type Kind = "once" | "event" | "repeat";

/** A fresh key per form: a save retried after a lost answer is the same reminder. */
const newOperationKey = (): string => `ui:${operationKey()}`;

/** A reminder repeats at set times on days of the week, monthly or yearly; once and events are its own kinds. */
const REPEAT_ALLOWS: CadenceAllows = { once: false, everyHours: false };

/** The Deliver to choice meaning the app. */
const IN_APP = "app";
/** The Deliver to choice meaning the person's Home. */
const HOME = "home";
/** The Deliver to choice meaning the chat the copied reminder is said in. */
const COPIED = "copied";

/** A repeating reminder's cadence as the cadence field edits it. */
function repeatSpec(when: Extract<ReminderWhen, { readonly kind: "repeat" }>, timezone: string): ScheduleSpec {
  const [only] = when.times;
  return {
    ...(when.times.length === 1 && only !== undefined ? { at: only } : { times: [...when.times] }),
    timezone,
    ...(when.daysOfWeek === undefined ? {} : { daysOfWeek: [...when.daysOfWeek] }),
    ...definedOnly({ monthly: when.monthly, yearly: when.yearly, until: when.until }),
  };
}

/** A reminder's `when` as two are compared: its instant as a number, its other fields in one order. */
function comparable(when: ReminderWhen): unknown {
  const fields: Record<string, unknown> = { ...when };
  if (typeof fields["at"] === "string") fields["at"] = Date.parse(fields["at"]);
  return Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)));
}

/** What a new reminder may start from besides a copy: a template's words and repeat. */
export interface ReminderStart {
  readonly text: string;
  /** The repeat, without its zone: it repeats in the workspace's. */
  readonly repeat: Omit<ScheduleSpec, "timezone">;
}

/**
 * The New reminder form, inline in Schedule: text, once / event / repeat, the
 * times read in the workspace zone, an event's notices, a repeat's cadence
 * (times, days of the week, monthly or yearly, an end, its zone), where it is said (the app, Home, or a chat the operator added as a
 * delivery target), and an optional task prompt. The owner's refusal is shown
 * in its own words. Given `editing`, the same form changes that reminder in
 * place (`update`), sending only what was changed.
 */
export function NewReminderForm({
  timeZone,
  today,
  originTaskId,
  draft,
  editing,
  start,
  onClose,
  onSaved,
}: {
  /** A reminder to change in place (Edit): the form starts from it and saves over it. */
  readonly editing?: ReminderView | undefined;
  /** A template to start from: its text and repeat, filled in for a new reminder. */
  readonly start?: ReminderStart | undefined;
  /** A reminder to start from (Duplicate): its text, when, task prompt and where it is said, saved as a new reminder for the same person under its label. */
  readonly draft?: ReminderView | undefined;
  /** The chat the reminder is asked from, when a chat's panel asks: the chat lists it. */
  readonly originTaskId?: string | undefined;
  /** The workspace zone the times are read in. */
  readonly timeZone: string;
  /** Today in that zone, `YYYY-MM-DD`. */
  readonly today: string;
  readonly onClose: () => void;
  readonly onSaved: (reminder: ReminderView, message: string) => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const [operationKey] = useState(newOperationKey);
  const seed = editing ?? draft;
  const from = seed?.when;
  const [text, setText] = useState(seed?.text ?? start?.text ?? "");
  const [kind, setKind] = useState<Kind>(from?.kind ?? (start === undefined ? "once" : "repeat"));
  const [date, setDate] = useState(from !== undefined && from.kind !== "repeat" ? localDate(from.at, timeZone) : shiftDate(today, 1));
  const [time, setTime] = useState(from !== undefined && from.kind !== "repeat" ? localTime(from.at, timeZone) : "09:00");
  const [notices, setNotices] = useState<readonly string[]>(from?.kind === "event" ? from.notify : DEFAULT_NOTICES);
  const [noticeAmount, setNoticeAmount] = useState("15");
  const [noticeUnit, setNoticeUnit] = useState<"m" | "h" | "d">("m");
  const [noticeAt, setNoticeAt] = useState("");
  const [repeat, setRepeat] = useState<ScheduleSpec>(() =>
    from?.kind === "repeat" && seed !== undefined
      ? repeatSpec(from, seed.timezone)
      : start === undefined
        ? { at: "09:00", timezone: timeZone }
        : { ...start.repeat, timezone: timeZone },
  );
  const [withPrompt, setWithPrompt] = useState(seed?.prompt !== undefined);
  const [prompt, setPrompt] = useState(seed?.prompt ?? "");
  // A copy is said where the reminder it copies was, once that chat is among the targets.
  const [deliver, setDeliver] = useState(
    seed?.deliverTo.kind === "conversation" ? COPIED : seed?.deliverTo.kind === "home" ? HOME : IN_APP,
  );
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  // Where else it can be said: the chats the operator added for routines. None when they cannot be read.
  const targets = useLoaded(() => listReminderTargets(client, workspaceId));
  const chats = targets.data ?? [];
  const copiedTo = seed?.deliverTo.kind === "conversation" ? seed.deliverTo : undefined;
  const chat =
    deliver === COPIED
      ? chats.find((target) => target.connectionId === copiedTo?.connectionId && target.chatId === copiedTo.conversationId)
      : chats.find((target) => target.targetId === deliver);

  const addNotice = (): void => {
    const notice = noticeFrom(Number(noticeAmount), noticeUnit, noticeUnit === "d" ? noticeAt : undefined);
    if (notice === undefined) return setError("A notice is a whole number of minutes, hours or days before, at most 30 days.");
    if (notices.includes(notice)) return setError("That notice is already there.");
    if (notices.length >= REMINDER_MAX_NOTICES) return setError(`An event can have at most ${REMINDER_MAX_NOTICES} notices.`);
    setNotices([...notices, notice]);
    setError(undefined);
  };

  const build = (): ReminderWhen | string => {
    if (kind === "repeat") {
      const problem = cadenceProblems(repeat)[0];
      if (problem !== undefined) return problem.message;
      return {
        kind: "repeat",
        times: [...listedTimes(repeat)].sort(),
        ...(repeat.daysOfWeek === undefined ? {} : { daysOfWeek: [...repeat.daysOfWeek].sort((a, b) => a - b) }),
        ...definedOnly({ monthly: repeat.monthly, yearly: repeat.yearly, until: repeat.until }),
      };
    }
    const at = localToInstant(date, time, timeZone);
    if (at === undefined) return "Pick a date and a time.";
    if (kind === "once") return { kind: "once", at };
    if (notices.length === 0) return "An event needs at least one notice.";
    return { kind: "event", at, notify: [...notices] };
  };

  const submit = async (): Promise<void> => {
    if (saving) return;
    const trimmed = text.trim();
    if (trimmed === "") return setError("Say what to remind you of.");
    const when = build();
    if (typeof when === "string") return setError(when);
    const task = withPrompt ? prompt.trim() : "";
    if (withPrompt && task === "") return setError("Write the task's prompt, or untick “Also start a task”.");
    setSaving(true);
    setError(undefined);
    const deliverTo: ReminderDeliverTo | undefined =
      chat !== undefined
        ? { kind: "conversation", connectionId: chat.connectionId, conversationId: chat.chatId }
        : deliver === HOME
          ? { kind: "home" }
          : undefined;
    const zone = kind === "repeat" ? repeat.timezone : timeZone;
    if (editing !== undefined) {
      // A chat it was said in that is not among the targets stays as it is.
      const where: ReminderDeliverTo | undefined = deliverTo ?? (deliver === COPIED ? undefined : { kind: "app" });
      const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
      const changes = {
        ...(trimmed === editing.text ? {} : { text: trimmed }),
        ...(same(comparable(when), comparable(editing.when)) ? {} : { when }),
        ...(zone === editing.timezone ? {} : { timezone: zone }),
        ...((task === "" ? undefined : task) === editing.prompt ? {} : { prompt: task === "" ? null : task }),
        ...(where === undefined || same(where, editing.deliverTo) ? {} : { deliverTo: where }),
      };
      const changed = await updateReminder(client, workspaceId, editing.reminderId, editing.updatedAt, changes);
      setSaving(false);
      if (!changed.ok) return setError(changed.message);
      onSaved(changed.value.reminder, `${changed.value.reminder.text} saved.`);
      return;
    }
    const answer = await createReminder(client, workspaceId, {
      text: trimmed,
      when,
      timezone: zone,
      ...(task === "" ? {} : { prompt: task }),
      ...(deliverTo === undefined ? {} : { deliverTo }),
      ...(originTaskId === undefined ? {} : { originTaskId }),
      ...(draft === undefined ? {} : { principalId: draft.principalId, copyOf: draft.reminderId }),
      operationKey,
    });
    setSaving(false);
    if (!answer.ok) return setError(answer.message);
    const skipped = answer.value.skippedNotices.map(noticeLabel);
    const note =
      answer.value.duplicate === true
        ? "That reminder was already set."
        : skipped.length > 0
          ? `Reminder set. Already past, so not sent: ${skipped.join(", ")}.`
          : "Reminder set.";
    onSaved(answer.value.reminder, note);
  };

  return (
    <form
      className="section-card reminder-form"
      aria-label={editing === undefined ? "New reminder" : "Edit reminder"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className="center-subhead">{editing === undefined ? "New reminder" : "Edit reminder"}</h2>
      <BusyFieldset busy={saving} className="settings-fields">
        <label>
          Remind me to
          <input
            name="text"
            autoFocus
            maxLength={REMINDER_TEXT_MAX}
            value={text}
            placeholder="Take your pills"
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <div className="reminder-kinds" role="radiogroup" aria-label="Kind">
          {(
            [
              ["once", "Once"],
              ["event", "Event"],
              ["repeat", "Repeat"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="reminder-kind">
              <input type="radio" name="reminder-kind" value={value} checked={kind === value} onChange={() => setKind(value)} />
              {label}
            </label>
          ))}
        </div>
        {kind === "repeat" ? (
          <CadenceField
            legend="Repeats"
            value={repeat}
            onChange={setRepeat}
            workspaceZone={timeZone}
            client={client}
            workspaceId={workspaceId}
            allows={REPEAT_ALLOWS}
            maxTimes={REMINDER_MAX_TIMES_PER_DAY}
          />
        ) : (
          <div className="reminder-row">
            <label>
              {kind === "event" ? "Event date" : "Date"}
              <input name="date" type="date" required value={date} min={today} onChange={(event) => setDate(event.target.value)} />
            </label>
            <label>
              Time
              <input name="time" type="time" required value={time} onChange={(event) => setTime(event.target.value)} />
            </label>
          </div>
        )}
        {kind === "event" ? (
          <div className="reminder-notices">
            <span className="reminder-label">Remind me</span>
            <ul className="list-reset" aria-label="Notices">
              {notices.map((notice) => (
                <li key={notice} className="chip">
                  {noticeLabel(notice)}
                  <Button
                    variant="bare"
                    aria-label={`Remove notice ${noticeLabel(notice)}`}
                    onClick={() => setNotices(notices.filter((item) => item !== notice))}
                  >
                    <Icon name="close" size="sm" />
                  </Button>
                </li>
              ))}
            </ul>
            <div className="reminder-row">
              <input
                aria-label="Notice amount"
                type="number"
                min={1}
                max={43200}
                value={noticeAmount}
                onChange={(event) => setNoticeAmount(event.target.value)}
              />
              <Select
                aria-label="Notice unit"
                value={noticeUnit}
                onChange={(event) => setNoticeUnit(event.target.value as "m" | "h" | "d")}
              >
                <option value="m">minutes before</option>
                <option value="h">hours before</option>
                <option value="d">days before</option>
              </Select>
              {noticeUnit === "d" ? (
                <input aria-label="Notice time" type="time" value={noticeAt} onChange={(event) => setNoticeAt(event.target.value)} />
              ) : null}
              <Button size="sm" onClick={addNotice}>
                Add notice
              </Button>
            </div>
          </div>
        ) : null}
        {kind === "repeat" ? null : <p className="muted">Times are in {timeZone}.</p>}
        <div className="reminder-deliver">
          <label>
            <span className="reminder-label">Deliver to</span>
            <Select
              aria-label="Deliver to"
              value={chat !== undefined ? chat.targetId : deliver === HOME ? HOME : IN_APP}
              onChange={(event) => setDeliver(event.target.value)}
            >
              <option value={IN_APP}>This app</option>
              <option value={HOME}>Home</option>
              {chats.map((target) => (
                <option key={target.targetId} value={target.targetId}>
                  {target.label}
                </option>
              ))}
            </Select>
          </label>
          <p className="muted">
            {chat === undefined && deliver === HOME
              ? "A notice in your Home, and its task's result another when it settles. With Home turned off, it is said in this app."
              : chat === undefined
                ? `The Center's badge and rail, and a browser notification when turned on. ${chats.length === 0 ? "To be reminded in a chat on one of your channels, ask for the reminder in that chat." : "Or pick a chat you added as a delivery target."}`
                : `Said in ${chat.label}. If it cannot be sent there for a while, it shows in this app instead.`}
          </p>
        </div>
        <label className="reminder-check">
          <input type="checkbox" checked={withPrompt} onChange={(event) => setWithPrompt(event.target.checked)} />
          Also start a task with this prompt
        </label>
        {withPrompt ? (
          <textarea
            aria-label="Task prompt"
            maxLength={REMINDER_PROMPT_MAX}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        ) : null}
        <FormFailure message={error} />
        <FormActions saving={saving} label="Save reminder" onCancel={onClose} />
      </BusyFieldset>
    </form>
  );
}

// ---- Rows in Schedule -----------------------------------------------------------

// ---- A reminder's page -----------------------------------------------------------

// ---- The rail: fired, not yet seen -----------------------------------------------------------

// ---- Browser notifications -----------------------------------------------------------
