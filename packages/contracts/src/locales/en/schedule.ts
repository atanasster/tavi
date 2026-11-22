/** The `core` words for memory cards and settings, schedules, reminders and routines, in English. */
export const schedule = {
  /** A card notice's stored words: how many things it holds. */
  "memory.card.things": { one: "{n} thing to remember", other: "{n} things to remember" },
  "memory.card.thingsFlush": {
    one: "{n} thing to remember from before this chat rolled over",
    other: "{n} things to remember from before this chat rolled over",
  },
  /** A digest's stored words: "3 things waiting to be remembered — the oldest expires Thu 15 Oct". */
  "memory.digest.title": {
    one: "{n} thing waiting to be remembered — the oldest expires {date}",
    other: "{n} things waiting to be remembered — the oldest expires {date}",
  },
  /** More wait than are listed: "10 of 14 things …"; `count` is how many wait. */
  "memory.digest.titleOf": {
    one: "{listed} of {n} thing waiting to be remembered — the oldest expires {date}",
    other: "{listed} of {n} things waiting to be remembered — the oldest expires {date}",
  },
  "memory.card.scope.chat": "this chat only",
  "memory.card.scope.everywhere": "remember everywhere",
  "memory.card.state.proposed": "Proposed",
  "memory.card.state.saved": "Saved",
  "memory.card.state.discarded": "Discarded",
  "memory.card.state.expired": "Expired",
  "memory.card.state.revoked": "Revoked",
  "memory.card.state.replaced": "Replaced",
  "memory.card.state.forgotten": "Forgotten",
  "memory.card.state.hidden": "Waiting for its person",
  "memory.card.item.hidden": "Another person's memory",
  "memory.card.item.sensitive": "Sensitive item",
  "memory.card.item.untitled": "Untitled memory",
  "memory.card.heading.forgottenCount": "Forgotten · {count}",
  "memory.card.heading.titleDecided": "{title} · decided",
  "memory.card.heading.proposed": "Proposed · {scope}",
  "memory.card.heading.stateCount": "{state} · {count}",
  "memory.card.heading.decided": "Decided",
  "memory.card.tidyUpLook": "tidy-up, open Tavi to compare",
  "memory.card.tidyUpNeedsLook": "This tidy-up needs a look — open Tavi to compare it with what it replaces, and keep it there.",
  "memory.card.updates": "updates: {title}",
  "memory.card.mayUpdate": "may update: {title}",
  "memory.card.aKeptMemory": "a kept memory",
  "memory.card.keepAllLeavesIt": "Keep all leaves it waiting",
  "memory.card.keptAll": "Kept {count}",
  "memory.card.keptAllNeedsLook": {
    one: "Kept {kept} · {n} needs a look — open Tavi to review",
    other: "Kept {kept} · {n} needs a look — open Tavi to review",
  },
  "memory.used.lookedThrough": { one: "Looked through {n} memory", other: "Looked through {n} memories" },
  "memory.used.lookedThroughMore": "Looked through {n} more",
  "memory.used.used": { one: "Used {n} memory", other: "Used {n} memories" },
  "memory.used.usedAndLooked": {
    one: "Used {n} memory · looked through {listed} more",
    other: "Used {n} memories · looked through {listed} more",
  },
  /** The terminal's dim line after an answer: "memory: 3 used · /why". */
  "memory.usedLine": "memory: {parts} · /why",
  "memory.usedLine.used": { one: "{n} used", other: "{n} used" },
  "memory.usedLine.looked": { one: "{n} looked through", other: "{n} looked through" },
  /** The terminal's one line for a card. */
  "memory.line.decided": "{title} — decided",
  "memory.line.items": { one: "{n} item", other: "{n} items" },
  "memory.line.tidyUp": "(tidy-up)",
  "memory.line.sensitiveItem": "sensitive item",
  "memory.line.sensitiveItems": { one: "{n} sensitive item", other: "{n} sensitive items" },
  "memory.line.openToReview": "open Tavi to review",
  "memory.line.openForSensitive": "open Tavi for the sensitive one",
  "memory.line.openToReplace": "open Tavi to replace the update",
  "memory.line.openToCompare": "open Tavi to compare the tidy-up",
  "memory.forget.unreached": "Chats that quoted or used it keep their copy until the chat is forgotten.",
  "memory.disclosure.embedding": {
    one: "Memory text and each message's retrieval query will be sent to {connection} to compute embeddings: {count} approved memory of this workspace now, and each new one as it is approved. Personal memory is not sent unless you turn on personal memory too, so it is matched by its words only.",
    other:
      "Memory text and each message's retrieval query will be sent to {connection} to compute embeddings: {count} approved memories of this workspace now, and each new one as it is approved. Personal memory is not sent unless you turn on personal memory too, so it is matched by its words only.",
  },
  "memory.disclosure.personalEmbedding": {
    one: "Your personal memory is shared by all your workspaces: turning this on sends {count} of your approved personal memories (never sensitive ones) to {connection} to compute embeddings now, and each new one as it is approved. Other people's personal memory is never sent there.",
    other:
      "Your personal memory is shared by all your workspaces: turning this on sends {count} of your approved personal memories (never sensitive ones) to {connection} to compute embeddings now, and each new one as it is approved. Other people's personal memory is never sent there.",
  },
  "memory.disclosure.personal":
    "Personal memory is your own and shared by all your workspaces: turning this on sends your approved personal memories (never sensitive ones) to {provider}, this workspace's memory provider, and keeps it up to date with them.",

  /** A schedule's cadence as a sentence: "every day at 07:00 (Europe/Sofia)". */
  "schedule.spec.once": "once on {date}",
  "schedule.spec.onceLabel": "Once on {date}",
  "schedule.spec.everyDay": "every day",
  "schedule.spec.daily": "Daily",
  "schedule.spec.everyWeekdays": "every {weekdays}",
  /** The last of several times: "07:00, 12:00 and 19:00". */
  "schedule.spec.listAnd": "{items} and {last}",
  "schedule.spec.sentenceAt": "{days} at {times} ({timezone})",
  "schedule.spec.sentenceEvery": "{days}, {step} from {from} to {to} ({timezone})",
  "schedule.spec.everyHours": { one: "every hour", other: "every {count} hours" },
  "schedule.spec.until": "{spec} until {date}",
  /** A cadence as a label leads with it: "Daily 07:00 · Europe/Sofia". */
  "schedule.spec.labelAt": "{days} {times}",
  /** After a dated pattern: "Monthly on the 1st, 09:00". */
  "schedule.spec.labelAtDated": "{days}, {times}",
  "schedule.spec.labelEvery": "{days} {step} {from}–{to}",
  "schedule.spec.labelEveryDated": "{days}, {step} {from}–{to}",
  "schedule.spec.everyHoursShort": { one: "hourly", other: "every {count} h" },
  "schedule.spec.labelZone": "{spec} · {timezone}",
  "schedule.notify.whenSent": "only when a run has something to send; a run with nothing to tell stays quiet",
  "schedule.notify.ifChanged": "after each run, but never the same result twice in a row",
  "schedule.notify.always": "after every run",
  "schedule.tokens": { one: "{count} token", other: "{count} tokens" },
  "schedule.maxTokens": "stopped once a run uses more than {tokens}",
  "schedule.paused.failures": "paused after {count} failed runs in a row; resume it to run again",
  "schedule.paused.plain": "paused",
  "schedule.finished": "finished: its last run is past; move its once or until date later, or drop the until, to run it again",
  /** A month's scheduled work: "12,345 tokens (about $0.42) of a 1,000,000-token monthly budget (1%)". */
  "schedule.work.withCost": "{tokens} (about ${dollars}.{cents})",
  "schedule.work.withBudget": "{tokens} of a {budget}-token monthly budget ({percent}%)",
  "schedule.work.withCostAndBudget": "{tokens} (about ${dollars}.{cents}) of a {budget}-token monthly budget ({percent}%)",
  "schedule.email.off": "off",
  "schedule.email.on": "on: mail on {connection} from {senders}, read-only run",
  "schedule.email.onSubject": 'on: mail on {connection} from {senders}, subject holding "{subject}", read-only run',
  /** What a watcher does: "watches the page https://… every hour; runs only when it changes". */
  "schedule.watch.page": "watches the page {target} {every}; runs only when it changes",
  "schedule.watch.feed": "watches the feed {target} {every}; runs only when it has new items",
  "schedule.watch.file": "watches the file {target} {every}, and soon after it changes while tavi serve runs; runs only when it changes",
  "schedule.watch.at": "at {times}",
  "schedule.watch.between": "{every} from {from} to {to}",
  "schedule.precheck.none": "none: every fire runs",
  "schedule.precheck.page": "runs only when the page {target} has changed since the last check",
  "schedule.precheck.feed": "runs only when the feed {target} has new items since the last check",
  "schedule.precheck.file": "runs only when the file {target} has changed since the last check",

  /** A monthly or yearly repeat: "every month on the 31st", "Yearly on 29 Feb". */
  "schedule.repeat.everyMonth": "every month",
  "schedule.repeat.monthly": "Monthly",
  "schedule.repeat.everyYear": "every year",
  "schedule.repeat.yearly": "Yearly",
  "schedule.repeat.withDay": "{lead} {day}",
  "schedule.repeat.dayOfMonth": "on the {ordinal}",
  "schedule.repeat.dayOfMonthLate": "on the {ordinal} (the last day in shorter months)",
  /** A day of the month as an ordinal, by how the number ends: 1, 21, 31 / 2, 22 / 3, 23 / 4, 24 / 7, 8, 27, 28 / the rest. */
  "schedule.repeat.ordinal.d1": "{day}st",
  "schedule.repeat.ordinal.d2": "{day}nd",
  "schedule.repeat.ordinal.d3": "{day}rd",
  "schedule.repeat.ordinal.d4": "{day}th",
  "schedule.repeat.ordinal.d78": "{day}th",
  "schedule.repeat.ordinal.other": "{day}th",
  "schedule.repeat.nthWeekday": "on the {nth} {weekday}",
  /**
   * The nth weekday of a month, in two agreement classes for languages whose
   * ordinal agrees with the weekday: `m` for Mon, Tue, Thu, Fri; `f` for Sun, Wed, Sat.
   */
  "schedule.repeat.nth.1.m": "first",
  "schedule.repeat.nth.1.f": "first",
  "schedule.repeat.nth.2.m": "second",
  "schedule.repeat.nth.2.f": "second",
  "schedule.repeat.nth.3.m": "third",
  "schedule.repeat.nth.3.f": "third",
  "schedule.repeat.nth.4.m": "fourth",
  "schedule.repeat.nth.4.f": "fourth",
  "schedule.repeat.nth.5.m": "fifth",
  "schedule.repeat.nth.5.f": "fifth",
  "schedule.repeat.nth.last.m": "last",
  "schedule.repeat.nth.last.f": "last",
  "schedule.repeat.onDate": "on {date}",

  /** A reminder's notice: "15 minutes before", "1 day before at 20:00"; `count` picks the form, `amount` is written. */
  "reminder.offset.minutes": { one: "{amount} minute before", other: "{amount} minutes before" },
  "reminder.offset.hours": { one: "{amount} hour before", other: "{amount} hours before" },
  "reminder.offset.days": { one: "{amount} day before", other: "{amount} days before" },
  "reminder.offset.at": "{span} at {time}",

  "routine.report.llmNews": "LLM news",
} as const;
