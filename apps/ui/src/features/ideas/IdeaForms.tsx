import { hostTimeZone, localDateTime, type Idea, type IdeasRecurAnswer, type RoutineDetail } from "@tavi/contracts";
import { useId, useRef, useState } from "react";

import { useT } from "../../lib/i18n.js";
import { nextPart } from "../../lib/parts.js";
import { weekdayName } from "../../lib/time.js";
import { localToInstant } from "../center/reminder-model.js";
import { operationKey, routineRequest } from "../routines/api.js";
import { Select } from "../../ui/Select.js";
import { Modal } from "../../ui/Modal.js";
import { FormActions } from "../settings/FormParts.js";
import { useFormSubmit } from "../../hooks/use-action.js";
import { madeRecurring, remindIdea } from "./ideas-api.js";
import { BusyFieldset, Failure } from "../../ui/Parts.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";

/**
 * The forms behind an idea's *Make it recurring* and *Remind me*.
 * Nothing is created until the person
 * saves: the routine through `routines create`, which evaluates it before it
 * starts, and the reminder through the owner's `remind`, which says the idea
 * and runs nothing.
 */

const WEEKDAY_NUMBERS = [0, 1, 2, 3, 4, 5, 6] as const;

export function RecurIdea({
  idea,
  draft,
  onClose,
  onDone,
}: {
  readonly idea: Idea;
  readonly draft: IdeasRecurAnswer["draft"];
  readonly onClose: () => void;
  /** Said once the routine exists. */
  readonly onDone: (note: string) => void;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const timeZone = useTimeZone();
  const [name, setName] = useState(draft.name);
  const [objective, setObjective] = useState(draft.prompt);
  const [at, setAt] = useState("09:00");
  const [day, setDay] = useState("1");
  // One key per dialog: a retried save is the same routine, not a second one.
  const operation = useRef(operationKey());
  const said = useRef("");
  /** The words last asked about: saved again as they are, a `[part]` in them was meant. */
  const asked = useRef<string | undefined>(undefined);
  const box = useRef<HTMLTextAreaElement>(null);
  /** The `[part]` the box is being warned of, until its words change or are saved. */
  const [unfilled, setUnfilled] = useState<string>();
  const unfilledId = useId();
  const zone = timeZone ?? hostTimeZone();
  const { saving, failure, submit } = useFormSubmit(
    true,
    async () => {
      const setup =
        draft.cadence === "weekly"
          ? {
              name,
              objective,
              timezone: zone,
              triggers: [{ id: "weekly", kind: "daily" as const, at, timezone: zone, daysOfWeek: [Number(day)] }],
            }
          : { name, objective, timezone: zone, at };
      const created = await routineRequest<RoutineDetail>(client, workspaceId, {
        action: "create",
        operationKey: operation.current,
        setup,
      });
      if (!created.ok) return created.message;
      // The routine exists: the idea is done. Should that note fail, the routine still stands, and the page says so.
      const done = await madeRecurring(client, workspaceId, idea.id, created.value.routine.routineId);
      said.current = done.ok ? t("ideas.recur.created", { name }) : t("ideas.recur.createdNotMarked", { name, message: done.message });
      return undefined;
    },
    () => onDone(said.current),
  );
  /** Stops once on a `[part]` left unfilled, on the part itself, so typing replaces it or a second press keeps it. */
  const stopAtBlank = (): boolean => {
    const blank = nextPart(objective);
    if (blank === undefined || asked.current === objective) return false;
    asked.current = objective;
    setUnfilled(objective.slice(blank.start, blank.end));
    box.current?.focus();
    box.current?.setSelectionRange(blank.start, blank.end);
    return true;
  };
  return (
    <Modal title={t("ideas.recur.title")} busy={saving} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (stopAtBlank()) return;
          setUnfilled(undefined);
          submit();
        }}
      >
        <BusyFieldset busy={saving} label={t("ideas.recur.creating")} className="settings-fields">
          <label>
            {t("ideas.recur.name")}
            <input required value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            {t("ideas.recur.objective")}
            <textarea
              ref={box}
              required
              rows={4}
              value={objective}
              {...(unfilled === undefined ? {} : { "aria-invalid": true, "aria-describedby": unfilledId })}
              onChange={(event) => {
                setObjective(event.target.value);
                setUnfilled(undefined);
              }}
            />
          </label>
          {unfilled === undefined ? null : (
            <Failure alert={false} id={unfilledId}>
              {t("ideas.recur.unfilled", { part: unfilled })}
            </Failure>
          )}
          {draft.cadence === "weekly" ? (
            <label>
              {t("ideas.recur.every")}
              <Select aria-label={t("ideas.recur.weekday")} value={day} onChange={(event) => setDay(event.target.value)}>
                {WEEKDAY_NUMBERS.map((weekday) => (
                  <option key={weekday} value={String(weekday)}>
                    {weekdayName(weekday)}
                  </option>
                ))}
              </Select>
            </label>
          ) : (
            <p className="meta-sm">{t("ideas.recur.everyDay")}</p>
          )}
          <label>
            {t("ideas.recur.at")}
            <input type="time" required value={at} onChange={(event) => setAt(event.target.value)} />
          </label>
          <p className="meta-sm">{t("ideas.recur.zone", { zone })}</p>
          {failure === undefined ? null : <Failure>{failure}</Failure>}
          <FormActions saving={saving} label={t("ideas.recur.create")} onCancel={onClose} />
        </BusyFieldset>
      </form>
    </Modal>
  );
}

/** `YYYY-MM-DDTHH:MM` an hour from now on `timeZone`'s clock, as a datetime field takes it. */
function inAnHour(now: Date, timeZone: string): string {
  const later = localDateTime(new Date(now.getTime() + 60 * 60_000), timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${later.year}-${pad(later.month)}-${pad(later.day)}T${pad(later.hour)}:${pad(later.minute)}`;
}

export function RemindIdea({
  idea,
  onClose,
  onDone,
  now = () => new Date(),
}: {
  readonly idea: Idea;
  readonly onClose: () => void;
  readonly onDone: (note: string) => void;
  readonly now?: () => Date;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const timeZone = useTimeZone();
  const zone = timeZone ?? hostTimeZone();
  const [when, setWhen] = useState(() => inAnHour(now(), zone));
  const { saving, failure, submit } = useFormSubmit(
    when !== "",
    async () => {
      const [date = "", time = ""] = when.split("T");
      const at = localToInstant(date, time.slice(0, 5), zone);
      if (at === undefined || Date.parse(at) <= now().getTime()) return t("ideas.remind.ahead");
      const outcome = await remindIdea(client, workspaceId, idea.id, at);
      return outcome.ok ? undefined : outcome.message;
    },
    () => onDone(t("ideas.remind.done", { title: idea.title })),
  );
  return (
    <Modal title={t("ideas.remind.title")} busy={saving} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <BusyFieldset busy={saving} label={t("ideas.remind.setting")} className="settings-fields">
          <p>{idea.title}</p>
          <label>
            {t("ideas.remind.when", { zone })}
            <input type="datetime-local" required value={when} onChange={(event) => setWhen(event.target.value)} />
          </label>
          <p className="meta-sm">{t("ideas.remind.hint")}</p>
          {failure === undefined ? null : <Failure>{failure}</Failure>}
          <FormActions saving={saving} label={t("ideas.remind.set")} onCancel={onClose} />
        </BusyFieldset>
      </form>
    </Modal>
  );
}
