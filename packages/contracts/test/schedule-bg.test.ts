import { describe, expect, it } from "vitest";

import { createTranslator } from "../src/i18n.js";
import { CORE_BG } from "../src/locales/core-bg.js";
import { CORE_EN } from "../src/locales/core-en.js";
import {
  MEMORY_PROVENANCE_KEEP_ALONE,
  MEMORY_TIDY_UP_LOOK,
  memoryCardHeading,
  memoryCardItemName,
  memoryCardLine,
  memoryCardNoticeText,
  memoryCardScopeLabel,
  memoryCardStateLabel,
  memoryCardCountOf,
  memoryCardTitleText,
  memoryDigestNoticeText,
  memoryDigestOf,
  memoryKeptAllText,
  memoryListedHeading,
  memoryMayUpdateLine,
  memoryUpdatesLine,
  memoryUsedLabel,
  memoryUsedLine,
  type MemoryCardItem,
} from "../src/memory-cards.js";
import { MEMORY_FORGET_UNREACHED } from "../src/memory.js";
import { memoryEmbeddingDisclosure, memoryPersonalDisclosure, memoryPersonalEmbeddingDisclosure } from "../src/memory-settings.js";
import { daysOfWeekText, describeReminderOffset, repeatDaysText } from "../src/reminders.js";
import { NEWS_ROUTINE_TEMPLATE_ID, ROUTINE_LLM_RELEASES_INSTRUCTIONS, routineReportTitle } from "../src/routines.js";
import { schedulePrecheckSentence } from "../src/schedule-precheck.js";
import {
  SCHEDULE_FINISHED_TEXT,
  type ScheduleSpec,
  scheduleEmailTriggerSentence,
  scheduleMaxTokensText,
  scheduleNotifyText,
  schedulePausedText,
  scheduleSpecText,
  scheduleWatchSentence,
  scheduledWorkText,
  tokenCountText,
} from "../src/schedules.js";

const bg = createTranslator({ en: CORE_EN, bg: CORE_BG }, "bg");
const NBSP = " ";

const item = (fields: Partial<MemoryCardItem>): MemoryCardItem =>
  ({ token: "abcdefgh", number: 1, state: "proposed", sensitive: false, title: "Lives in Sofia", ...fields }) as MemoryCardItem;

describe("the schedule part in Bulgarian", () => {
  it("says a memory card's words", () => {
    expect(memoryCardNoticeText({ count: 2, flush: false }, bg).title).toBe("2 неща за запомняне");
    expect(memoryCardNoticeText({ count: 1, flush: true }, bg).title).toBe("1 нещо за запомняне отпреди чатът да започне начисто");
    expect(memoryDigestNoticeText({ listed: 10, waiting: 14, oldestExpires: "чт 15 окт" }, bg).title).toBe(
      "10 от 14 неща чакат да бъдат запомнени — най-старото изтича чт 15 окт",
    );
    expect(memoryCardScopeLabel("chat:1", bg)).toBe("само в този чат");
    expect(memoryCardStateLabel("saved", bg)).toBe("Запазено");
    expect(memoryCardItemName(item({ sensitive: true }), bg)).toBe("Чувствителен запис");
    expect(memoryCardItemName(item({ title: null }), bg)).toBe("Спомен без заглавие");
    expect(memoryUpdatesLine({ title: null }, bg)).toBe("обновява: запазен спомен");
    expect(memoryMayUpdateLine({ title: "Живее в Лисабон" }, bg)).toBe("може да обнови: Живее в Лисабон");
    expect(memoryKeptAllText(4, 0, bg)).toBe("Запазих 4");
    expect(memoryKeptAllText(4, 2, bg)).toBe("Запазих 4 · 2 искат преглед — отвори Tavi");
  });

  it("reads a card's stored English title back in Bulgarian, and leaves English as stored", () => {
    const stored = memoryCardNoticeText({ count: 3, flush: true }).title;
    expect(memoryCardTitleText(stored)).toBe(stored);
    expect(memoryCardTitleText(stored, bg)).toBe("3 неща за запомняне отпреди чатът да започне начисто");
    const digest = memoryDigestNoticeText({ listed: 1, waiting: 1, oldestExpires: "Thu 15 Oct" }).title;
    expect(memoryDigestOf(digest)).toEqual({ waiting: 1 });
    expect(memoryCardTitleText(digest, bg)).toBe("1 нещо чака да бъде запомнено — най-старото изтича чт, 15 окт");
    expect(memoryCardTitleText("Something else", bg)).toBe("Something else");
  });

  it("says a card's heading", () => {
    const card = { title: "2 things to remember", forgotten: 0, items: [item({}), item({ number: 2, state: "saved" })] };
    expect(memoryCardHeading(card, bg)).toBe("1 нещо за запомняне");
    expect(memoryCardHeading({ ...card, items: [item({})] }, bg)).toBe("Предложено · запомни навсякъде");
    expect(memoryCardHeading({ ...card, items: [], forgotten: 2 }, bg)).toBe("Забравено · 2");
    expect(memoryCardHeading({ ...card, items: [] }, bg)).toBe("2 неща за запомняне · решено");
    expect(memoryCardLine({ ...card, items: [] }, bg)).toBe("◆ 2 неща за запомняне — решено");
  });

  it("says what an answer used", () => {
    expect(memoryUsedLabel(3, 0, bg)).toBe("Използвах 3 спомена");
    expect(memoryUsedLabel(1, 5, bg)).toBe("Използвах 1 спомен · прегледах още 5");
    expect(memoryListedHeading(6, 0, bg)).toBe("Прегледах 6 спомена");
    expect(memoryUsedLine(3, 0, bg)).toBe("памет: 3 използвани · /why");
  });

  it("says memory's disclosures", () => {
    expect(memoryEmbeddingDisclosure({ connectionId: "openai", records: 1 }, bg)).toContain("1 одобрен спомен");
    expect(memoryPersonalEmbeddingDisclosure({ connectionId: "openai", personal: 12_000 }, bg)).toContain(`12${NBSP}000 от одобрените ти`);
    expect(memoryPersonalDisclosure("mem0", bg)).toContain("към mem0, доставчика на памет");
  });

  it("keeps the English constants", () => {
    expect(MEMORY_TIDY_UP_LOOK).toBe("tidy-up, open Tavi to compare");
    expect(MEMORY_PROVENANCE_KEEP_ALONE).toBe("Keep all leaves it waiting");
    expect(MEMORY_FORGET_UNREACHED).toBe("Chats that quoted or used it keep their copy until the chat is forgotten.");
    expect(SCHEDULE_FINISHED_TEXT).toMatch(/^finished: its last run is past/);
  });

  it("says a schedule's cadence", () => {
    const daily: ScheduleSpec = { times: ["19:00", "07:00", "12:00"], timezone: "Europe/Sofia" };
    expect(scheduleSpecText(daily, "sentence", bg)).toBe("всеки ден в 07:00, 12:00 и 19:00 (Europe/Sofia)");
    expect(scheduleSpecText(daily, "label", bg)).toBe("Всеки ден 07:00, 12:00, 19:00 · Europe/Sofia");
    const working: ScheduleSpec = { daysOfWeek: [1, 2, 3, 4, 5], everyHours: 2, between: { from: "08:00", to: "18:00" }, timezone: "UTC" };
    expect(scheduleSpecText(working, "sentence", bg)).toBe("пн–пт, на всеки 2 часа от 08:00 до 18:00 (UTC)");
    expect(scheduleSpecText(working, "label", bg)).toBe(`пн–пт на 2${NBSP}ч 08:00–18:00 · UTC`);
    const monthly: ScheduleSpec = { at: "09:00", monthly: { dayOfMonth: 1 }, until: "2027-01-01", timezone: "UTC" };
    expect(scheduleSpecText(monthly, "label", bg)).toBe("Всеки месец на 1-во число, 09:00 до 2027-01-01 · UTC");
    expect(scheduleSpecText({ at: "09:00", once: "2026-11-05", timezone: "UTC" }, "sentence", bg)).toBe(
      "веднъж на 2026-11-05 в 09:00 (UTC)",
    );
  });

  it("keeps a schedule's cadence in English byte for byte", () => {
    const working: ScheduleSpec = {
      daysOfWeek: [1, 2, 3, 4, 5],
      everyHours: 2,
      between: { from: "08:00", to: "18:00" },
      timezone: "Europe/Sofia",
    };
    expect(scheduleSpecText(working)).toBe("every Mon–Fri, every 2 hours from 08:00 to 18:00 (Europe/Sofia)");
    expect(scheduleSpecText({ ...working, daysOfWeek: undefined }, "label")).toBe("Daily every 2 h 08:00–18:00 · Europe/Sofia");
    const monthly: ScheduleSpec = { times: ["09:00", "18:00"], monthly: { dayOfMonth: 1 }, timezone: "Europe/Sofia" };
    expect(scheduleSpecText(monthly, "label")).toBe("Monthly on the 1st, 09:00, 18:00 · Europe/Sofia");
    expect(scheduleSpecText({ at: "09:00", once: "2026-11-05", everyHours: 1, timezone: "UTC" }, "label")).toBe(
      "Once on 2026-11-05, hourly 00:00–23:59 · UTC",
    );
    expect(scheduleSpecText({ ...monthly, until: "2027-01-01" })).toBe(
      "every month on the 1st at 09:00 and 18:00 (Europe/Sofia) until 2027-01-01",
    );
    expect(
      scheduledWorkText({
        month: "2026-10",
        timezone: "UTC",
        since: "",
        until: "",
        tokens: 12_345,
        usd: 0.4,
        budget: 1_000_000,
        percent: 1,
      }),
    ).toBe("12,345 tokens (about $0.40) of a 1,000,000-token monthly budget (1%)");
  });

  it("says a schedule's notices, ceilings and state", () => {
    expect(scheduleNotifyText("always", bg)).toBe("след всяко пускане");
    expect(tokenCountText(12_345, bg)).toBe(`12${NBSP}345${NBSP}токена`);
    expect(tokenCountText(1, bg)).toBe(`1${NBSP}токен`);
    expect(scheduleMaxTokensText({ maxTokens: 5000 }, bg)).toBe(`спира, щом едно пускане използва повече от 5000${NBSP}токена`);
    expect(schedulePausedText({ enabled: false, pausedReason: "failures" }, new Date(), bg)).toBe(
      "на пауза след 3 неуспешни пускания поред; възобнови го, за да тръгне отново",
    );
    expect(schedulePausedText({ enabled: false }, new Date(), bg)).toBe("на пауза");
    expect(
      scheduledWorkText(
        { month: "2026-10", timezone: "UTC", since: "", until: "", tokens: 12_345, usd: 0.42, budget: 1_000_000, percent: 1 },
        bg,
      ),
    ).toBe(`12${NBSP}345${NBSP}токена (около 0,42${NBSP}$) от месечен бюджет от 1${NBSP}000${NBSP}000${NBSP}токена (1%)`);
    expect(scheduleEmailTriggerSentence({ connectionId: "mail", senders: ["a@b.c"], subject: "Отчет", since: "x" }, bg)).toBe(
      "включено: поща в mail от a@b.c с „Отчет“ в темата, пускане само за четене",
    );
  });

  it("says a watcher and a pre-check", () => {
    const spec: ScheduleSpec = { everyHours: 1, timezone: "UTC" };
    expect(scheduleWatchSentence({ spec, precheck: { kind: "page-changed", target: "https://example.com/" } }, bg)).toBe(
      "следи страницата https://example.com/ всеки час; пуска се само когато тя се промени",
    );
    expect(schedulePrecheckSentence(undefined, bg)).toBe("няма: всяко задействане се пуска");
    expect(schedulePrecheckSentence({ kind: "feed-has-new", target: "https://example.com/feed" }, bg)).toBe(
      "пуска се само когато емисията https://example.com/feed има нови записи от последната проверка",
    );
  });

  it("says weekdays, repeats and notices", () => {
    expect(daysOfWeekText([1, 3], bg)).toBe("пн, ср");
    expect(daysOfWeekText([6, 0], bg)).toBe("сб, нд");
    expect(repeatDaysText({ monthly: { dayOfMonth: 31 } }, "sentence", bg)).toBe(
      "всеки месец на 31-во число (в по-кратките месеци — на последния ден)",
    );
    expect(repeatDaysText({ monthly: { dayOfMonth: 15 } }, "label", bg)).toBe("Всеки месец на 15-о число");
    expect(repeatDaysText({ monthly: { dayOfMonth: 27 } }, "label", bg)).toBe("Всеки месец на 27-мо число");
    expect(repeatDaysText({ monthly: { nth: -1, weekday: 5 } }, "sentence", bg)).toBe("всеки месец на последния пт");
    expect(repeatDaysText({ monthly: { nth: 1, weekday: 3 } }, "sentence", bg)).toBe("всеки месец на първата ср");
    expect(repeatDaysText({ yearly: { month: 2, day: 29 } }, "label", bg)).toBe("Всяка година на 29 фев");
    expect(repeatDaysText({ yearly: { month: 2, day: 29 } }, "label")).toBe("Yearly on 29 Feb");
    expect(repeatDaysText({ monthly: { nth: -1, weekday: 5 } })).toBe("every month on the last Fri");
    expect(repeatDaysText({ monthly: { dayOfMonth: 22 } })).toBe("every month on the 22nd");
    expect(repeatDaysText({ monthly: { dayOfMonth: 12 } })).toBe("every month on the 12th");
    expect(describeReminderOffset({ amount: 15, unit: "m" }, bg)).toBe(`15${NBSP}минути преди`);
    expect(describeReminderOffset({ amount: 1, unit: "d", at: "20:00" }, bg)).toBe(`1${NBSP}ден преди, в 20:00`);
    expect(describeReminderOffset({ amount: 1, unit: "d", at: "20:00" })).toBe("1 day before at 20:00");
    expect(describeReminderOffset({ amount: 1200, unit: "m" })).toBe("1200 minutes before");
  });

  it("names a model-releases report", () => {
    const snapshot = {
      report: { templateVersion: NEWS_ROUTINE_TEMPLATE_ID },
      agent: { instructions: ROUTINE_LLM_RELEASES_INSTRUCTIONS },
    } as Parameters<typeof routineReportTitle>[0];
    expect(routineReportTitle(snapshot, "Моите новини", bg)).toBe("Новини за LLM");
    expect(routineReportTitle(snapshot, "Моите новини")).toBe("LLM news");
  });
});

describe("counts as text", () => {
  it("never groups a stored count, so the titles read back the same", () => {
    const card = memoryCardNoticeText({ count: 1200, flush: false }).title;
    expect(card).toBe("1200 things to remember");
    expect(memoryCardCountOf(card)).toBe(1200);
    expect(memoryCardTitleText(card, bg)).toBe("1200 неща за запомняне");
    const digest = memoryDigestNoticeText({ listed: 10, waiting: 1200, oldestExpires: "Tue 29 Sept" }).title;
    expect(digest).toBe("10 of 1200 things waiting to be remembered — the oldest expires Tue 29 Sept");
    expect(memoryDigestOf(digest)).toEqual({ waiting: 1200 });
    expect(memoryCardTitleText(digest, bg)).toBe("10 от 1200 неща чакат да бъдат запомнени — най-старото изтича вт, 29 сеп");
    expect(memoryDigestNoticeText({ listed: 1200, waiting: 1200, oldestExpires: "Thu 15 Oct" }).title).toBe(
      "1200 things waiting to be remembered — the oldest expires Thu 15 Oct",
    );
  });

  it("leaves a digest date it cannot read as stored", () => {
    const digest = memoryDigestNoticeText({ listed: 2, waiting: 2, oldestExpires: "15 October" }).title;
    expect(memoryCardTitleText(digest, bg)).toBe("2 неща чакат да бъдат запомнени — най-старото изтича 15 October");
  });

  it("says display counts without grouping, in agreement for one", () => {
    expect(memoryUsedLabel(1200, 1500)).toBe("Used 1200 memories · looked through 1500 more");
    expect(memoryListedHeading(1200, 0)).toBe("Looked through 1200 memories");
    expect(memoryListedHeading(1200, 3)).toBe("Looked through 1200 more");
    expect(memoryUsedLine(1200, 1500)).toBe("memory: 1200 used, 1500 looked through · /why");
    expect(memoryUsedLine(1, 1, bg)).toBe("памет: 1 използван, 1 прегледан · /why");
    expect(memoryUsedLine(2, 0, bg)).toBe("памет: 2 използвани · /why");
    expect(memoryKeptAllText(1200, 1200)).toBe("Kept 1200 · 1200 needs a look — open Tavi to review");
  });
});
