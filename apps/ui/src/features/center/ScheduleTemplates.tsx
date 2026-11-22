import type { ScheduleSpec } from "@tavi/contracts";

import { Button } from "../../ui/Button.js";
import { useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import type { RoutineStart } from "../routines/RoutineForms.js";
import type { ScheduleDraft } from "./PlainSchedules.js";
import type { ReminderStart } from "./Reminders.js";

/** A schedule template: the new schedule's settings, its cadence without a zone (it runs in the workspace's). */
type ScheduleStart = Omit<ScheduleDraft, "spec"> & { readonly cadence: Omit<ScheduleSpec, "timezone"> };

/**
 * Something to start from when nothing is scheduled: which form it opens, filled with what. Its button reads in the
 * page's language; what it fills in is written to the owner, so it stays as it is.
 */
export type ScheduleTemplate = { readonly id: string; readonly title: UiKey } & (
  | { readonly kind: "schedule"; readonly schedule: ScheduleStart }
  | { readonly kind: "routine"; readonly routine: RoutineStart }
  | { readonly kind: "reminder"; readonly reminder: ReminderStart }
);

const WEEKDAYS = [1, 2, 3, 4, 5];

const SCHEDULE_TEMPLATES: readonly ScheduleTemplate[] = [
  {
    id: "morning-inbox-brief",
    title: "center.templates.morningInbox",
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
    title: "center.templates.weeklyDigest",
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
    title: "center.templates.dailyStretch",
    kind: "reminder",
    reminder: { text: "Stand up and stretch", repeat: { at: "15:00" } },
  },
  {
    id: "end-of-day-wrap-up",
    title: "center.templates.endOfDay",
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
  const t = useT();
  return (
    <div className="center-chips" role="group" aria-label={t("center.templates.label")}>
      {SCHEDULE_TEMPLATES.filter((template) => template.kind !== "reminder" || reminders).map((template) => (
        <Button key={template.id} size="sm" onClick={() => onPick(template)}>
          {t(template.title)}
        </Button>
      ))}
    </div>
  );
}
