import type { ScheduleSpec } from "@tavi/contracts";

import { Button } from "../../ui/Button.js";
import type { RoutineStart } from "../routines/RoutineForms.js";
import type { ScheduleDraft } from "./PlainSchedules.js";
import type { ReminderStart } from "./Reminders.js";

/** A schedule template: the new schedule's settings, its cadence without a zone (it runs in the workspace's). */
type ScheduleStart = Omit<ScheduleDraft, "spec"> & { readonly cadence: Omit<ScheduleSpec, "timezone"> };

/** Something to start from when nothing is scheduled: which form it opens, filled with what. */
export type ScheduleTemplate = { readonly id: string; readonly title: string } & (
  | { readonly kind: "schedule"; readonly schedule: ScheduleStart }
  | { readonly kind: "routine"; readonly routine: RoutineStart }
  | { readonly kind: "reminder"; readonly reminder: ReminderStart }
);

const WEEKDAYS = [1, 2, 3, 4, 5];

const SCHEDULE_TEMPLATES: readonly ScheduleTemplate[] = [
  {
    id: "morning-inbox-brief",
    title: "Morning inbox brief",
    kind: "schedule",
    schedule: {
      name: "Morning inbox brief",
      prompt:
        "Read my unread email and messages since yesterday. Put anything urgent first, then what needs a reply from me today, then what can wait. Keep it short.",
      cadence: { at: "07:30", daysOfWeek: WEEKDAYS },
      missedRunPolicy: "run-once-if-missed-within-6h",
      autoApproveTools: [],
      deliverTo: "home",
    },
  },
  {
    id: "weekly-research-digest",
    title: "Weekly research digest",
    kind: "routine",
    routine: {
      name: "Weekly research digest",
      objective:
        "Each week, find the most important new papers, releases and news about large language models, and say in a line why each matters",
      cadence: { at: "08:00", daysOfWeek: [1] },
    },
  },
  {
    id: "daily-stretch",
    title: "Daily stretch reminder",
    kind: "reminder",
    reminder: { text: "Stand up and stretch", repeat: { at: "15:00" } },
  },
  {
    id: "end-of-day-wrap-up",
    title: "End-of-day wrap-up",
    kind: "schedule",
    schedule: {
      name: "End-of-day wrap-up",
      prompt: "Look over today's chats and tasks: what I finished, what is still open, and the first thing to pick up tomorrow.",
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
  return (
    <div className="center-chips" role="group" aria-label="Start from a template">
      {SCHEDULE_TEMPLATES.filter((template) => template.kind !== "reminder" || reminders).map((template) => (
        <Button key={template.id} size="sm" onClick={() => onPick(template)}>
          {template.title}
        </Button>
      ))}
    </div>
  );
}
