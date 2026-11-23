import type { ScheduleSpec } from "@tavi/contracts";

import { Button } from "../../ui/Button.js";
import { translateNow, useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import type { RoutineStart } from "../routines/RoutineForms.js";
import type { ScheduleDraft } from "./PlainSchedules.js";
import type { ReminderStart } from "./Reminders.js";

/** A schedule template: the new schedule's settings, its cadence without a zone (it runs in the workspace's). */
type ScheduleStart = Omit<ScheduleDraft, "spec"> & { readonly cadence: Omit<ScheduleSpec, "timezone"> };

/**
 * Something to start from when nothing is scheduled: which form it opens, filled with what. Its button and what it
 * fills in read in the page's language; once the form is saved, the words are the person's own and stay as saved.
 */
export type ScheduleTemplate = { readonly id: string; readonly title: UiKey } & (
  | { readonly kind: "schedule"; readonly schedule: ScheduleStart }
  | { readonly kind: "routine"; readonly routine: RoutineStart }
  | { readonly kind: "reminder"; readonly reminder: ReminderStart }
);

const WEEKDAYS = [1, 2, 3, 4, 5];

/** The templates, said in the page's language when they are read: the page remounts its views on a change of language. */
const scheduleTemplates = (): readonly ScheduleTemplate[] => [
  {
    id: "morning-inbox-brief",
    title: "center.templates.morningInbox",
    kind: "schedule",
    schedule: {
      name: translateNow("center.templates.morningInbox.name"),
      prompt: translateNow("center.templates.morningInbox.prompt"),
      cadence: { at: "07:30", daysOfWeek: WEEKDAYS },
      missedRunPolicy: "run-once-if-missed-within-6h",
      autoApproveTools: [],
      deliverTo: "home",
    },
  },
  {
    id: "weekly-research-digest",
    title: "center.templates.weeklyDigest",
    kind: "routine",
    routine: {
      name: translateNow("center.templates.weeklyDigest.name"),
      objective: translateNow("center.templates.weeklyDigest.objective"),
      cadence: { at: "08:00", daysOfWeek: [1] },
    },
  },
  {
    id: "daily-stretch",
    title: "center.templates.dailyStretch",
    kind: "reminder",
    reminder: { text: translateNow("center.templates.dailyStretch.text"), repeat: { at: "15:00" } },
  },
  {
    id: "end-of-day-wrap-up",
    title: "center.templates.endOfDay",
    kind: "schedule",
    schedule: {
      name: translateNow("center.templates.endOfDay.name"),
      prompt: translateNow("center.templates.endOfDay.prompt"),
      cadence: { at: "18:00", daysOfWeek: WEEKDAYS },
      missedRunPolicy: "skip",
      autoApproveTools: [],
      deliverTo: "home",
    },
  },
];

/** A template's schedule as the schedule form starts from it, in `timezone`. */
export function templateScheduleDraft(start: ScheduleStart, timezone: string): ScheduleDraft {
  const { cadence, ...rest } = start;
  return { ...rest, spec: { ...cadence, timezone } };
}

/**
 * The templates an empty Schedule offers, each opening its form filled in:
 * nothing is created until that form is saved. A reminder's shows only where
 * the owner offers reminders.
 */
export function ScheduleTemplates({
  reminders,
  onPick,
}: {
  readonly reminders: boolean;
  readonly onPick: (template: ScheduleTemplate) => void;
}) {
  const t = useT();
  return (
    <div className="center-chips" role="group" aria-label={t("center.templates.label")}>
      {scheduleTemplates()
        .filter((template) => template.kind !== "reminder" || reminders)
        .map((template) => (
          <Button key={template.id} size="sm" onClick={() => onPick(template)}>
            {t(template.title)}
          </Button>
        ))}
    </div>
  );
}
