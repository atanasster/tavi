import { describe, expect, it } from "vitest";

import { englishOf, keyedError, renderTextRef, scheduleSpecRef, scheduleSpecText, textRef, type ScheduleSpec } from "../src/index.js";
import { coreIn } from "../src/locales/core-server.js";
import { coreEnglish } from "../src/locales/core.js";

/** Words stored for later and read in Bulgarian: a schedule's cadence, a routine's missing model, counts that agree with their noun. */

const bg = coreIn("bg");
const spec: ScheduleSpec = { at: "07:00", daysOfWeek: [1, 2, 3, 4, 5], timezone: "Europe/Sofia" } as ScheduleSpec;

describe("a schedule's cadence stored in a notice", () => {
  it("keeps the English it always stored, and is said in Bulgarian when read in Bulgarian", () => {
    const said = textRef("channel.schedule.alert.specDisabled", { name: "Сутрешен бюлетин", spec: scheduleSpecRef(spec) });
    expect(englishOf(said)).toBe(
      coreEnglish("channel.schedule.alert.specDisabled", { name: "Сутрешен бюлетин", spec: scheduleSpecText(spec) }),
    );
    const bulgarian = renderTextRef(said, bg) ?? "";
    expect(bulgarian).toContain(scheduleSpecText(spec, "sentence", bg));
    expect(bulgarian).not.toContain(scheduleSpecText(spec));
  });

  it("falls back to the stored English when the spec cannot be read", () => {
    const ref = textRef("schedule.spec.stored", { spec: "every day at 07:00 (UTC)", json: "{not json" });
    expect(renderTextRef(ref, bg)).toBe("every day at 07:00 (UTC)");
  });

  it("says a finished schedule's keyed error with its cadence in Bulgarian", () => {
    const error = keyedError("INVALID_INPUT", "error.schedule.finished", { name: "Отчет", spec: scheduleSpecRef(spec) });
    expect(error.message).toContain(scheduleSpecText(spec));
    expect(renderTextRef(error.i18n!, bg)).toContain(scheduleSpecText(spec, "sentence", bg));
  });
});

describe("a routine with no model", () => {
  it("names the menu path in Bulgarian", () => {
    const error = keyedError("NOT_CONFIGURED", "error.routine.noModel");
    expect(error.message).toBe(
      "No model is configured for routines. Set a default model in Settings → Models (or `tavi models set-default`), then create the routine again.",
    );
    expect(renderTextRef(error.i18n!, bg)).toContain("Настройки → Модели");
  });
});

describe("counts that agree with their noun", () => {
  it("says one changed tool and three in their own forms, English as it was", () => {
    const one = textRef("notice.mcp.drift.withheld", { count: 1, n: "1", names: "search" });
    const three = textRef("notice.mcp.drift.withheld", { count: 3, n: "3", names: "a, b, c" });
    expect(renderTextRef(one, bg)).toBe("1 променен и задържан (search)");
    expect(renderTextRef(three, bg)).toBe("3 променени и задържани (a, b, c)");
    expect(englishOf(one)).toBe("1 changed and withheld (search)");
    // A notice stored before counts were kept has no count: its plural form, as before.
    expect(renderTextRef(textRef("notice.mcp.drift.added", { n: "1" }), bg)).toBe("1 нови, чакат преглед");
    expect(bg("notice.routine.delivery.why.failures", { count: 1, n: "1" })).toBe("1 изпращане не успя");
    expect(bg("cli.heartbeat.log.tokens", { count: 1, n: "1" })).toBe("1 токен");
    expect(bg("cli.heartbeat.bytes", { count: 1, n: "1" })).toBe("1 байт");
    expect(bg("tui.card.diffMore", { count: 1, n: "1" })).toBe("      … още 1 ред в подробностите в tavi ui");
    expect(coreEnglish("cli.heartbeat.log.tokens", { count: 1234, n: "1234" })).toBe("1234 tokens");
  });

  it("keeps a number with its unit on one line", () => {
    expect(bg("cli.onboard.ask.nameTooLong")).toBe("най-много 80 знака");
    expect(bg("channel.memory.card.oneSensitive")).toMatch(/^1 чувствителен/);
  });
});
