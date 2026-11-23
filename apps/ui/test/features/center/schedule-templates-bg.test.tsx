// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { ScheduleTemplates, type ScheduleTemplate } from "../../../src/features/center/ScheduleTemplates.js";
import { clickSettled as click, mountSettled as mount } from "../../support/dom.js";
import { inBulgarian } from "../../support/bulgarian.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** An empty Schedule's templates in Bulgarian: each button, and what it fills its form with, read in the page's language. */

inBulgarian();

describe("schedule templates in Bulgarian", () => {
  it("fills each form with Bulgarian words, so the reminder later sends them", async () => {
    const picked: ScheduleTemplate[] = [];
    const page = await mount(<ScheduleTemplates reminders onPick={(template) => picked.push(template)} />);
    const buttons = [...page.querySelectorAll("button")];
    expect(buttons.map((item) => item.textContent)).toEqual([
      "Сутрешен преглед на пощата",
      "Седмичен обзор на проучвания",
      "Напомняне за разтягане",
      "Равносметка за деня",
    ]);
    for (const item of buttons) await click(item);
    const [inbox, digest, stretch, endOfDay] = picked;
    expect(inbox?.kind === "schedule" ? inbox.schedule.name : undefined).toBe("Сутрешен преглед на пощата");
    expect(inbox?.kind === "schedule" ? inbox.schedule.prompt : "").toMatch(/^Прочети непрочетените ми имейли/);
    expect(digest?.kind === "routine" ? digest.routine.objective : "").toContain("езикови модели");
    expect(stretch?.kind === "reminder" ? stretch.reminder.text : undefined).toBe("Стани и се протегни");
    expect(endOfDay?.kind === "schedule" ? endOfDay.schedule.prompt : "").toMatch(/^Прегледай днешните чатове/);
    for (const template of picked) expect(JSON.stringify(template)).not.toMatch(/Stand up|Read my|Each week|Look over/);
  });
});
