import { useId } from "react";
import { weekdayName, weekdayShortName } from "../lib/time.js";
import { Button } from "./Button.js";
import { WEEK_ORDER, EVERY_DAY } from "./cadence.js";

const PRESETS: readonly (readonly [string, readonly number[]])[] = [
  ["Every day", EVERY_DAY],
  ["Weekdays", [1, 2, 3, 4, 5]],
  ["Weekends", [0, 6]],
];

const sameDays = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && [...a].sort().every((day, index) => day === [...b].sort()[index]);

/**
 * The days of the week as chips, Monday first, with the presets. A chip says
 * whether it is chosen (`aria-pressed`); the last one chosen cannot be
 * unchosen, and says why.
 */
export function DayChips({
  legend = "Days",
  days,
  onToggle,
  onPreset,
}: {
  readonly legend?: string | undefined;
  /** The days chosen, 0 = Sunday … 6 = Saturday; at least one. */
  readonly days: readonly number[];
  readonly onToggle: (day: number) => void;
  readonly onPreset: (days: readonly number[]) => void;
}) {
  const hint = useId();
  const one = days.length === 1;
  return (
    <fieldset className="cadence-days">
      <legend>{legend}</legend>
      <div className="cadence-chips" role="group" aria-label="Presets">
        {PRESETS.map(([label, preset]) => (
          <Button key={label} className="center-chip" aria-pressed={sameDays(days, preset)} onClick={() => onPreset(preset)}>
            {label}
          </Button>
        ))}
      </div>
      <div className="cadence-chips" role="group" aria-label="Days of the week">
        {WEEK_ORDER.map((day) => {
          const on = days.includes(day);
          const last = on && one;
          return (
            <Button
              key={day}
              className="center-chip cadence-day"
              aria-pressed={on}
              aria-disabled={last ? true : undefined}
              aria-describedby={last ? hint : undefined}
              onClick={() => {
                if (!last) onToggle(day);
              }}
            >
              {/* Named by what it shows (WCAG 2.5.3), the full day as the abbreviation's title. */}
              <abbr title={weekdayName(day)}>{weekdayShortName(day)}</abbr>
            </Button>
          );
        })}
      </div>
      {one ? (
        <p id={hint} className="meta-sm muted">
          At least one day stays chosen.
        </p>
      ) : null}
    </fieldset>
  );
}
