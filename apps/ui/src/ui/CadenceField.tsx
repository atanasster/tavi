import { useId, useState } from "react";
import {
  SCHEDULE_MAX_EVERY_HOURS,
  SCHEDULE_MAX_TIMES_PER_DAY,
  SCHEDULE_PREVIEW_RUNS,
  isValidTimeZone,
  type ReminderMonthly,
  type ScheduleSpec,
} from "@tavi/contracts";

import type { SettingsClient } from "../lib/ipc.js";
import { dayTime, todayIn, WEEKDAYS } from "../lib/time.js";
import { Button } from "./Button.js";
import { Icon } from "./Icon.js";
import { Select } from "./Select.js";
import {
  WEEK_ORDER,
  EVERY_DAY,
  toggleDay,
  type DaysMode,
  type TimesMode,
  daysMode,
  timesMode,
  listedTimes,
  withoutDays,
  withoutTimes,
  withTimes,
  nextFreeTime,
  cadenceProblems,
  knownZones,
} from "./cadence.js";
import { DayChips } from "./DayChips.js";
import { previewSaid, usePreview } from "./cadence-preview.js";

/**
 * When something runs, as one control every form shares: the days (Monday
 * first, with Every day, Weekdays and Weekends), monthly, yearly or once; one
 * or several times a day or every few hours in a window; an optional end
 * date; the time zone, from the zones this browser knows, the workspace's
 * marked; and the next runs, as the owner's scheduler will fire them.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const NTH: readonly (readonly [string, string])[] = [
  ["1", "first"],
  ["2", "second"],
  ["3", "third"],
  ["4", "fourth"],
  ["5", "fifth"],
  ["-1", "last"],
];
/** What a form lets its cadence be. */
export interface CadenceAllows {
  /** Every few hours in a window (default: allowed). */
  readonly everyHours?: boolean | undefined;
  /** Once, on a date (default: allowed); `"single"` at one time only. */
  readonly once?: boolean | "single" | undefined;
  /** An end date (default: allowed). */
  readonly until?: boolean | undefined;
}

/**
 * The cadence control. `value` is a schedule spec, possibly half-typed; each
 * change is the whole next spec. `client` (with `workspaceId`) is the owner
 * the next runs are asked of; without one, none are shown.
 */
export function CadenceField({
  legend = "When",
  value,
  onChange,
  workspaceZone,
  client,
  workspaceId,
  allows = {},
  maxTimes = SCHEDULE_MAX_TIMES_PER_DAY,
}: {
  readonly legend?: string | undefined;
  readonly value: ScheduleSpec;
  readonly onChange: (next: ScheduleSpec) => void;
  /** The workspace's zone, marked in the list and offered back when another is chosen. */
  readonly workspaceZone?: string | undefined;
  readonly client?: SettingsClient | undefined;
  readonly workspaceId?: string | undefined;
  readonly allows?: CadenceAllows | undefined;
  readonly maxTimes?: number | undefined;
}) {
  const ids = useId();
  const spec = value;
  const problems = cadenceProblems(spec);
  const preview = usePreview(client, workspaceId, spec, problems.length === 0);
  const [zones] = useState(knownZones);
  const mode = daysMode(spec);
  const timing = timesMode(spec);
  const times = listedTimes(spec);
  const onceSingle = allows.once === "single" && mode === "once";
  const canHours = allows.everyHours !== false && !onceSingle;
  const zoneToday = isValidTimeZone(spec.timezone) ? todayIn(spec.timezone) : todayIn(undefined);
  const [, month = 1, day = 1] = zoneToday.split("-").map(Number);
  // A stored date already past stays as it is: only a newly picked date is held to today or later.
  const [stored] = useState(value);
  const earliest = (storedDate: string | undefined, date: string | undefined) =>
    storedDate !== undefined && date === storedDate && storedDate < zoneToday ? undefined : zoneToday;
  const problem = (path: string) => problems.find((item) => item.path === path);
  const problemsId = `${ids}-problems`;
  const invalid = (path: string) => (problem(path) === undefined ? {} : { "aria-invalid": true, "aria-describedby": problemsId });

  const setDays = (next: DaysMode) => {
    const rest = withoutDays(spec);
    if (next === "weekly") return onChange(rest);
    if (next === "monthly") return onChange({ ...rest, monthly: { dayOfMonth: Math.min(day, 30) } });
    if (next === "yearly") return onChange({ ...rest, yearly: { month, day } });
    const { until: _until, ...once } = rest;
    if (allows.once !== "single") return onChange({ ...once, once: zoneToday });
    const at = spec.everyHours === undefined ? (times[0] ?? "09:00") : (spec.between?.from ?? "09:00");
    return onChange({ ...withTimes(once, [at]), once: zoneToday });
  };
  const setTiming = (next: TimesMode) => {
    if (next === "times") return onChange(withTimes(spec, [spec.between?.from ?? "09:00"]));
    return onChange({ ...withoutTimes(spec), everyHours: 2, between: { from: "08:00", to: "20:00" } });
  };
  const weekly = spec.daysOfWeek ?? EVERY_DAY;
  const setWeekly = (days: readonly number[]) => {
    const rest = withoutDays(spec);
    onChange(days.length === 7 ? rest : { ...rest, daysOfWeek: [...days] });
  };
  const monthly: ReminderMonthly = spec.monthly ?? { dayOfMonth: 1 };
  const monthlyKind = "nth" in monthly ? "weekday" : monthly.dayOfMonth === 31 ? "last" : "day";
  const setMonthly = (next: ReminderMonthly) => onChange({ ...withoutDays(spec), monthly: next });
  const daysChoices: readonly (readonly [DaysMode, string])[] = [
    ["weekly", "On days of the week"],
    ["monthly", "Monthly"],
    ["yearly", "Yearly"],
    ...(allows.once === false ? [] : ([["once", "Once"]] as const)),
  ];
  const maxShown = onceSingle ? 1 : maxTimes;

  return (
    <fieldset className="cadence" aria-describedby={problems.length > 0 ? problemsId : undefined}>
      <legend>{legend}</legend>
      <div className="cadence-row" role="radiogroup" aria-label="Repeats">
        {daysChoices.map(([choice, label]) => (
          <label key={choice} className="cadence-option">
            <input type="radio" name={`${ids}-days`} value={choice} checked={mode === choice} onChange={() => setDays(choice)} />
            {label}
          </label>
        ))}
      </div>
      {mode === "weekly" ? (
        <DayChips days={weekly} onToggle={(toggled) => setWeekly(toggleDay(weekly, toggled))} onPreset={setWeekly} />
      ) : null}
      {mode === "monthly" ? (
        <div className="cadence-row">
          <Select
            aria-label="Monthly on"
            value={monthlyKind}
            onChange={(event) => {
              const kind = event.target.value;
              setMonthly(kind === "last" ? { dayOfMonth: 31 } : kind === "weekday" ? { nth: 1, weekday: 1 } : { dayOfMonth: 1 });
            }}
          >
            <option value="day">On day</option>
            <option value="weekday">On the</option>
            <option value="last">On the last day</option>
          </Select>
          {"dayOfMonth" in monthly && monthlyKind === "day" ? (
            <Select
              aria-label="Day of the month"
              value={String(monthly.dayOfMonth)}
              onChange={(event) => setMonthly({ dayOfMonth: Number(event.target.value) })}
            >
              {Array.from({ length: 30 }, (_, index) => (
                <option key={index + 1} value={String(index + 1)}>
                  {index + 1}
                </option>
              ))}
            </Select>
          ) : null}
          {"nth" in monthly ? (
            <>
              <Select
                aria-label="Which week"
                value={String(monthly.nth)}
                onChange={(event) => setMonthly({ ...monthly, nth: Number(event.target.value) as typeof monthly.nth })}
              >
                {NTH.map(([nth, label]) => (
                  <option key={nth} value={nth}>
                    {label}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Weekday"
                value={String(monthly.weekday)}
                onChange={(event) => setMonthly({ ...monthly, weekday: Number(event.target.value) })}
              >
                {WEEK_ORDER.map((weekday) => (
                  <option key={weekday} value={String(weekday)}>
                    {WEEKDAYS[weekday]}
                  </option>
                ))}
              </Select>
            </>
          ) : null}
        </div>
      ) : null}
      {mode === "yearly" && spec.yearly !== undefined ? (
        <div className="cadence-row">
          <Select
            aria-label="Month"
            value={String(spec.yearly.month)}
            onChange={(event) =>
              onChange({ ...withoutDays(spec), yearly: { day: spec.yearly?.day ?? 1, month: Number(event.target.value) } })
            }
          >
            {MONTHS.map((name, index) => (
              <option key={name} value={String(index + 1)}>
                {name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Day"
            value={String(spec.yearly.day)}
            onChange={(event) =>
              onChange({ ...withoutDays(spec), yearly: { month: spec.yearly?.month ?? 1, day: Number(event.target.value) } })
            }
          >
            {Array.from({ length: 31 }, (_, index) => (
              <option key={index + 1} value={String(index + 1)}>
                {index + 1}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      {mode === "once" ? (
        <label className="cadence-inline">
          On
          <input
            type="date"
            required
            min={earliest(stored.once, spec.once)}
            value={spec.once ?? ""}
            onChange={(event) => onChange({ ...spec, once: event.target.value })}
            {...invalid("once")}
          />
        </label>
      ) : null}
      {canHours ? (
        <div className="cadence-row" role="radiogroup" aria-label="Times of day">
          <label className="cadence-option">
            <input type="radio" name={`${ids}-times`} checked={timing === "times"} onChange={() => setTiming("times")} />
            At set times
          </label>
          <label className="cadence-option">
            <input type="radio" name={`${ids}-times`} checked={timing === "hours"} onChange={() => setTiming("hours")} />
            Every few hours
          </label>
        </div>
      ) : null}
      {timing === "times" ? (
        <div className="cadence-row">
          <span aria-hidden="true">At</span>
          {times.map((time, index) => (
            <span key={index} className="cadence-time">
              <label>
                <span className="visually-hidden">{times.length === 1 ? "Time" : `Time ${index + 1}`}</span>
                <input
                  type="time"
                  required
                  value={time}
                  onChange={(event) =>
                    onChange(
                      withTimes(
                        spec,
                        times.map((each, at) => (at === index ? event.target.value : each)),
                      ),
                    )
                  }
                  {...invalid("times")}
                />
              </label>
              {times.length > 1 ? (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove time ${time}`}
                  onClick={() =>
                    onChange(
                      withTimes(
                        spec,
                        times.filter((_, at) => at !== index),
                      ),
                    )
                  }
                >
                  <Icon name="close" size="sm" />
                </Button>
              ) : null}
            </span>
          ))}
          {times.length < maxShown ? (
            <Button size="sm" onClick={() => onChange(withTimes(spec, [...times, nextFreeTime(times)]))}>
              Add a time
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="cadence-row">
          <span className="cadence-inline">
            Every
            <Select
              aria-label="Every how many hours"
              value={String(spec.everyHours ?? 1)}
              onChange={(event) => onChange({ ...spec, everyHours: Number(event.target.value) })}
            >
              {Array.from({ length: SCHEDULE_MAX_EVERY_HOURS }, (_, index) => (
                <option key={index + 1} value={String(index + 1)}>
                  {index === 0 ? "hour" : `${index + 1} hours`}
                </option>
              ))}
            </Select>
          </span>
          <label className="cadence-inline">
            from
            <input
              type="time"
              required
              aria-label="Window start"
              value={spec.between?.from ?? "00:00"}
              onChange={(event) => onChange({ ...spec, between: { from: event.target.value, to: spec.between?.to ?? "23:59" } })}
              {...invalid("between")}
            />
          </label>
          <label className="cadence-inline">
            to
            <input
              type="time"
              required
              aria-label="Window end"
              value={spec.between?.to ?? "23:59"}
              onChange={(event) => onChange({ ...spec, between: { from: spec.between?.from ?? "00:00", to: event.target.value } })}
              {...invalid("between")}
            />
          </label>
        </div>
      )}
      {allows.until !== false && mode !== "once" ? (
        <label className="cadence-inline">
          Until (optional)
          <input
            type="date"
            aria-label="Until"
            min={earliest(stored.until, spec.until)}
            value={spec.until ?? ""}
            onChange={(event) => {
              const { until: _until, ...rest } = spec;
              onChange(event.target.value === "" ? rest : { ...rest, until: event.target.value });
            }}
            {...invalid("until")}
          />
        </label>
      ) : null}
      <div className="cadence-row">
        <label className="cadence-inline">
          Time zone
          <input
            aria-label="Time zone"
            list={`${ids}-zones`}
            autoComplete="off"
            spellCheck={false}
            required
            maxLength={64}
            value={spec.timezone}
            onChange={(event) => onChange({ ...spec, timezone: event.target.value })}
            {...invalid("timezone")}
          />
        </label>
        <datalist id={`${ids}-zones`}>
          {workspaceZone === undefined ? null : <option value={workspaceZone} label={`${workspaceZone} (workspace zone)`} />}
          {zones
            .filter((zone) => zone !== workspaceZone)
            .map((zone) => (
              <option key={zone} value={zone} />
            ))}
        </datalist>
        {workspaceZone === undefined ? null : spec.timezone === workspaceZone ? (
          <span className="meta-sm muted">(workspace zone)</span>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => onChange({ ...spec, timezone: workspaceZone })}>
            Use the workspace zone ({workspaceZone})
          </Button>
        )}
      </div>
      {/* Mounted while empty, so the first problem is announced as it appears. */}
      <ul id={problemsId} className="cadence-problems list-reset" aria-live="polite">
        {problems.map((item) => (
          <li key={item.path}>{item.message}</li>
        ))}
      </ul>
      {client === undefined ? null : (
        <div className="cadence-preview">
          {/* Only the next run is said as it changes; the rest are there to read. */}
          <span className="visually-hidden" aria-live="polite">
            {problems.length > 0 ? "" : previewSaid(preview, spec.timezone)}
          </span>
          <span className="cadence-label">Next {SCHEDULE_PREVIEW_RUNS} runs</span>
          {problems.length > 0 ? (
            <p className="meta-sm muted">Shown once the schedule above is complete.</p>
          ) : preview.state === "waiting" ? (
            <p className="meta-sm muted">Working them out…</p>
          ) : preview.state === "failed" ? (
            <p className="meta-sm muted">Not available: {preview.message}</p>
          ) : preview.runs.length === 0 ? (
            <p className="meta-sm muted">It does not run again.</p>
          ) : (
            <ol className="list-reset">
              {preview.runs.map((run) => (
                <li key={run}>
                  <time dateTime={run}>{dayTime(run, spec.timezone, todayIn(spec.timezone))}</time>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </fieldset>
  );
}
