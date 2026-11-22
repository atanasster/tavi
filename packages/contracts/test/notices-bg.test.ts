import { describe, expect, it } from "vitest";

import {
  ChatNoticeSchema,
  englishOf,
  localizedText,
  navPath,
  noticeWordsOf,
  renderTextRef,
  scheduledWorkRef,
  scheduledWorkText,
  storedWords,
  textRef,
  TextRefSchema,
} from "../src/index.js";
import { createTranslator } from "../src/i18n.js";
import { CORE_BG } from "../src/locales/core-bg.js";
import { CORE_EN } from "../src/locales/core-en.js";
import { coreEnglish } from "../src/locales/core.js";

const bg = createTranslator({ en: CORE_EN, bg: CORE_BG }, "bg");

/** Notices and fire outcomes stored by key: their English as it always was, and Bulgarian when read. */
describe("stored notice words", () => {
  it("says a reference in English as the notice always stored it, nested references first", () => {
    const status = textRef("notice.status.failedWithCode", { code: "TIMEOUT" });
    expect(englishOf(textRef("notice.schedule.result.summary", { status, text: "Partial brief" }))).toBe("Failed (TIMEOUT)\nPartial brief");
    expect(englishOf(textRef("notice.conversation.summary", { count: 1, n: "1", time: "14:05" }))).toBe(
      "1 new message, the last at 14:05 UTC",
    );
    expect(englishOf(textRef("notice.conversation.summary", { count: 3, n: "3", time: "14:05" }))).toBe(
      "3 new messages, the last at 14:05 UTC",
    );
    expect(englishOf(textRef("notice.epoch.summary.archived", { count: 1200, n: "1200", artifact: "art-1" }))).toBe(
      "1200 earlier message(s) were summarized and archived as art-1.",
    );
  });

  it("says a notice in Bulgarian, with a person's words left as they are", () => {
    expect(renderTextRef(textRef("notice.schedule.result.title", { name: "Morning brief" }), bg)).toBe("Пускане по график „Morning brief“");
    expect(renderTextRef(textRef("notice.sideChat.title.named", { name: "Trip" }), bg)).toBe("Страничният чат „Trip“ приключи");
    expect(
      renderTextRef(
        textRef("notice.schedule.result.summary", { status: textRef("notice.status.completed"), text: "Three meetings today." }),
        bg,
      ),
    ).toBe("Завършено\nThree meetings today.");
    expect(renderTextRef(textRef("notice.conversation.summary", { count: 1, n: "1", time: "14:05" }), bg)).toBe(
      "1 ново съобщение, последното в 14:05 UTC",
    );
    expect(renderTextRef(textRef("notice.conversation.summary", { count: 5, n: "5", time: "14:05" }), bg)).toBe(
      "5 нови съобщения, последното в 14:05 UTC",
    );
    expect(renderTextRef(textRef("notice.heartbeat.digest.title", { count: 1, n: "1" }), bg)).toBe("1 нещо от пулса ти");
    expect(renderTextRef(textRef("notice.heartbeat.digest.title", { count: 4, n: "4" }), bg)).toBe("4 неща от пулса ти");
    expect(renderTextRef(textRef("notice.epoch.summary.lossy", { count: 2, n: "2" }), bg)).toBe(
      "2 по-ранни съобщения са обобщени; не можаха да се запазят в архив.",
    );
  });

  it("puts a menu path in a routine's notice by key, so it follows the menu's words", () => {
    const resume = textRef("notice.routine.resumeHint", { path: navPath("nav.route.center", "nav.center.schedule") });
    expect(englishOf(resume)).toBe("Resume it in Center → Schedule, or ask Tavi in chat to resume it.");
    expect(renderTextRef(resume, bg)).toBe("Пусни я отново от Център → График или помоли Tavi в чата да я пусне отново.");
    const why = textRef("notice.routine.delivery.why.failures", { n: "3" });
    const fix = textRef("notice.routine.delivery.fix.credentials");
    expect(renderTextRef(textRef("notice.routine.delivery.text", { name: "News", label: "Me", why, fix }), bg)).toBe(
      "Рутина „News“: доставката до „Me“ е на пауза, защото 3 изпращания подред не успяха. Проучването продължава, а докладите остават в приложението. Свържи канала отново и доставката ще продължи сама.",
    );
  });

  it("says the month's scheduled work by key exactly as scheduledWorkText says it", () => {
    const usage = {
      month: "2026-11",
      timezone: "UTC",
      since: "2026-11-01T00:00:00.000Z",
      until: "2026-12-01T00:00:00.000Z",
      tokens: 800_000,
      usd: 0.42,
      budget: 1_000_000,
      percent: 80,
    };
    expect(englishOf(scheduledWorkRef(usage))).toBe(scheduledWorkText(usage));
    expect(renderTextRef(scheduledWorkRef(usage), bg)).toBe(scheduledWorkText(usage, bg));
    const summary = textRef("notice.scheduledBudget.summary", { usage: scheduledWorkRef(usage), month: usage.month });
    expect(renderTextRef(summary, bg)).toMatch(/^Графиците и рутините ти са използвали /);
  });

  it("says a fire's outcome after what asked for its run", () => {
    const said = textRef("schedule.outcome.notPosted.noHome");
    const labelled = textRef("schedule.outcome.labelled", { label: textRef("schedule.outcome.label.manual"), said });
    expect(englishOf(labelled)).toBe("manual run: completed, but its result was not posted: there is no Home to post it in (Home is off)");
    expect(renderTextRef(labelled, bg)).toMatch(/^ръчно пускане: завърши, но резултатът не е публикуван/);
    expect(renderTextRef(textRef("schedule.outcome.emailRefused", { count: 2, n: "2", causes: "2 sender" }), bg)).toBe(
      "задействането с имейл отказа 2 имейла този час (2 sender)",
    );
  });

  it("falls back to the stored English for no key, an unknown key, or an unknown key nested in one", () => {
    expect(localizedText("Reminder", undefined, bg)).toBe("Reminder");
    expect(localizedText("Reminder", { key: "notice.gone" }, bg)).toBe("Reminder");
    expect(localizedText("Failed\nx", { key: "notice.schedule.result.summary", params: { status: { key: "nope" }, text: "x" } }, bg)).toBe(
      "Failed\nx",
    );
    expect(localizedText("Reminder", textRef("notice.reminder.title"), bg)).toBe("Напомняне");
    expect(localizedText("Reminder", textRef("notice.reminder.title"), coreEnglish)).toBe("Reminder");
  });

  it("stores plain words as they are, and Tavi's with their reference", () => {
    expect(storedWords("Stretch")).toEqual({ text: "Stretch" });
    expect(noticeWordsOf({ title: textRef("notice.reminder.title"), summary: "Stretch" })).toEqual({
      title: "Reminder",
      summary: "Stretch",
      titleRef: { key: "notice.reminder.title" },
    });
  });

  it("validates a stored reference, and a notice from before references", () => {
    expect(TextRefSchema.safeParse(textRef("notice.run.title", { id: "t1" })).success).toBe(true);
    expect(TextRefSchema.safeParse({ key: "" }).success).toBe(false);
    let deep: { key: string; params?: { inner: unknown } } = { key: "notice.reminder.title" };
    for (let depth = 0; depth < 10; depth += 1) deep = { key: "notice.summary.joined", params: { inner: deep } };
    expect(TextRefSchema.safeParse(deep).success).toBe(false);
    const old = {
      noticeId: "n1",
      taskId: "t1",
      kind: "reminder",
      title: "Reminder",
      summary: "x",
      afterSeq: 0,
      createdAt: "2026-11-22T00:00:00.000Z",
    };
    expect(ChatNoticeSchema.parse(old)).toEqual(old);
  });
});
