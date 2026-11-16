// @vitest-environment jsdom
import axe from "axe-core";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QuestionCard,
  QuestionReceipt,
  answerLabels,
  deadlineLabel,
  deliveryName,
  questionNeed,
  type QuestionNeed,
} from "../../../src/features/needs/NeedCard.js";
import { mount, rerender, unmountAll } from "../../support/dom.js";

/** The question card and its receipt. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmountAll();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const NOW = Date.parse("2026-10-02T14:00:00.000Z");
const choices = {
  header: "Deploy",
  options: [{ label: "Ship it", description: "Flaky tests are quarantined." }, { label: "Wait for a re-run" }, { label: "Cancel" }],
  multiSelect: false,
  allowOther: true,
  recommended: 1,
  defaultOption: 2,
};
const need: QuestionNeed = {
  question: "Ship to production?",
  choices,
  context: "Two tests are flaky.",
  deadlineAt: "2026-10-02T14:30:00.000Z",
  askedBy: "Daily release",
  channels: ["Telegram"],
};

describe("deadlineLabel", () => {
  it("reads the time left, turns urgent near the end, and says when it is past", () => {
    expect(deadlineLabel(need.deadlineAt, NOW, "UTC")).toMatchObject({ urgent: false, past: false, text: "Answer by 14:30 · 30 min" });
    expect(deadlineLabel(need.deadlineAt, NOW + 26 * 60_000, "UTC")).toMatchObject({
      urgent: true,
      text: expect.stringMatching(/ · 4 min$/),
    });
    // The last tenth of a long window is urgent too.
    expect(
      deadlineLabel("2026-10-03T14:00:00.000Z", Date.parse("2026-10-03T12:00:00.000Z"), "UTC", "2026-10-02T14:00:00.000Z"),
    ).toMatchObject({ urgent: true, text: expect.stringMatching(/ · 2 h$/) });
    expect(deadlineLabel(need.deadlineAt, NOW + 29 * 60_000 + 30_000, "UTC").text).toMatch(/ · 30 s$/);
    expect(deadlineLabel(need.deadlineAt, NOW + 31 * 60_000, "UTC")).toMatchObject({ past: true, text: "Was due 14:30" });
  });

  it("says the deadline in the workspace zone, with the day when it is not today there", () => {
    // 14:30 UTC is 23:30 in Tokyo, the same day there as 14:00 UTC.
    expect(deadlineLabel(need.deadlineAt, NOW, "Asia/Tokyo")).toMatchObject({
      text: "Answer by 23:30 · 30 min",
      title: "Friday 2 Oct 23:30 (Asia/Tokyo)",
    });
    // 15:30 UTC is past midnight in Tokyo: tomorrow there, though today in UTC.
    expect(deadlineLabel("2026-10-02T15:30:00.000Z", NOW, "Asia/Tokyo").text).toBe("Answer by Sat 3 Oct 00:30 · 1 h 30 min");
    expect(deadlineLabel("2026-10-02T15:30:00.000Z", NOW, "UTC").text).toBe("Answer by 15:30 · 1 h 30 min");
  });
});

describe("answerLabels", () => {
  it("names a multi-select's numbers by their labels, and leaves any other answer alone", () => {
    expect(answerLabels("1, 3", choices)).toBe("Ship it, Cancel");
    expect(answerLabels("9", choices)).toBe("9");
    expect(answerLabels("next week", choices)).toBe("next week");
  });
});

describe("QuestionCard", () => {
  it("shows who asks, why, the recommendation, the default and the chats, before the controls", async () => {
    const page = await mount(<QuestionCard timeZone="UTC" need={need} onAnswer={() => {}} now={() => NOW} />);
    const text = page.textContent ?? "";
    expect(text).toContain("Daily release");
    expect(page.querySelector("h3")?.textContent).toBe("Ship to production?");
    expect(page.querySelector(".need-context")?.textContent).toBe("Why: Two tests are flaky.");
    expect(page.querySelector(".need-option-tag")?.closest("button")?.textContent).toContain("Ship it");
    expect(text).toContain("If nobody answers: Wait for a re-run");
    expect(text).toContain("Also asked in Telegram");
    // Context is read with the group.
    expect(page.querySelector('[role="group"]')?.getAttribute("aria-describedby")).toBe(page.querySelector(".need-context")?.id);
  });

  it("lists the chats a question was also sent to, but never this computer's own connection", () => {
    const row = {
      question: "Italian or Thai?",
      choices,
      askedAt: "2026-10-02T13:00:00.000Z",
      deliveries: [{ connectionId: "local-default" }, { connectionId: "telegram-main", channel: "Telegram" }],
    } as never;
    expect(questionNeed(row, deliveryName).channels).toEqual(["Telegram"]);
  });

  it("sends a keyboard choice at once, and a number key moves to its option", async () => {
    const answers: string[] = [];
    const page = await mount(<QuestionCard timeZone="UTC" need={need} onAnswer={(answer) => answers.push(answer)} now={() => NOW} />);
    const group = page.querySelector<HTMLElement>('[role="group"]')!;
    await act(async () => group.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true })));
    const third = page.querySelectorAll<HTMLButtonElement>("button.need-option")[2]!;
    expect(document.activeElement).toBe(third);
    await act(async () => third.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(answers).toEqual(["Cancel"]);
  });

  it("sends a clicked choice after its undo window, or at once with Send now", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const answers: string[] = [];
    const page = await mount(
      <QuestionCard timeZone="UTC" need={need} onAnswer={(answer) => answers.push(answer)} now={() => NOW} undoMs={1_000} />,
    );
    await act(async () => page.querySelectorAll<HTMLButtonElement>("button.need-option")[0]!.click());
    // The others wait while one is being sent.
    expect(page.querySelectorAll<HTMLButtonElement>("button.need-option")[1]!.disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(999);
    });
    expect(answers).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(answers).toEqual(["Ship it"]);
    await act(async () => page.querySelectorAll<HTMLButtonElement>("button.need-option")[1]!.click());
    await act(async () =>
      [...page.querySelectorAll<HTMLButtonElement>(".need-undo button")].find((button) => button.textContent === "Send now")!.click(),
    );
    expect(answers).toEqual(["Ship it", "Wait for a re-run"]);
  });

  it("reports a pick still in its undo window as not sent when the card goes — and nothing it sent or took back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const dropped: string[] = [];
    const option = (page: HTMLElement, index: number) => page.querySelectorAll<HTMLButtonElement>("button.need-option")[index]!;
    const undoButton = (page: HTMLElement, label: string) =>
      [...page.querySelectorAll<HTMLButtonElement>(".need-undo button")].find((button) => button.textContent === label)!;
    const card = () => (
      <QuestionCard
        timeZone="UTC"
        need={need}
        onAnswer={() => undefined}
        onDropped={(label) => dropped.push(label)}
        now={() => NOW}
        undoMs={1_000}
      />
    );
    // Sent by its timer, sent at once, and taken back: none of them is dropped.
    for (const finish of [
      async () => vi.advanceTimersByTime(1_000),
      async (page: HTMLElement) => undoButton(page, "Send now").click(),
      async (page: HTMLElement) => undoButton(page, "Undo").click(),
    ]) {
      const page = await mount(card());
      await act(async () => option(page, 0).click());
      await act(async () => finish(page));
      unmountAll();
    }
    expect(dropped).toEqual([]);
    // Gone while the pick waits: that pick was never sent.
    const page = await mount(card());
    await act(async () => option(page, 1).click());
    unmountAll();
    expect(dropped).toEqual(["Wait for a re-run"]);
  });

  it("takes a clicked choice back when the card is blocked during its undo window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const answers: string[] = [];
    const card = (blocked?: { reason: string }) => (
      <QuestionCard
        timeZone="UTC"
        need={need}
        blocked={blocked}
        onAnswer={(answer) => answers.push(answer)}
        now={() => NOW}
        undoMs={1_000}
      />
    );
    const host = await mount(card());
    await act(async () => host.querySelectorAll<HTMLButtonElement>("button.need-option")[0]!.click());
    await rerender(card({ reason: "Decide the approval above first." }));
    expect(host.querySelector(".need-undo")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(answers).toEqual([]);
  });

  it("returns focus to the option on Undo, and ticks a multi-select box by its number", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const page = await mount(<QuestionCard timeZone="UTC" need={need} onAnswer={() => {}} now={() => NOW} />);
    const second = page.querySelectorAll<HTMLButtonElement>("button.need-option")[1]!;
    await act(async () => second.click());
    await act(async () =>
      [...page.querySelectorAll<HTMLButtonElement>(".need-undo button")].find((button) => button.textContent === "Undo")!.click(),
    );
    expect(document.activeElement).toBe(second);

    const multi = await mount(
      <QuestionCard timeZone="UTC" need={{ ...need, choices: { ...choices, multiSelect: true } }} onAnswer={() => {}} now={() => NOW} />,
    );
    await act(async () =>
      multi.querySelector<HTMLElement>('[role="group"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true })),
    );
    expect([...multi.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].map((box) => box.checked)).toEqual([false, true, false]);
    expect(multi.querySelector(".need-footer .button-primary")?.textContent).toBe("Send 1 choice");
  });

  it("opens own words on demand, and sends them with Cmd+Enter", async () => {
    const answers: string[] = [];
    const page = await mount(<QuestionCard timeZone="UTC" need={need} onAnswer={(answer) => answers.push(answer)} now={() => NOW} />);
    expect(page.querySelector("textarea")).toBeNull();
    await act(async () =>
      page.querySelector<HTMLElement>('[role="group"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "o", bubbles: true })),
    );
    const area = page.querySelector("textarea")!;
    // Opened from the keyboard, it takes focus.
    expect(document.activeElement).toBe(area);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(area, "  Ship on Monday  ");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })));
    expect(answers).toEqual(["Ship on Monday"]);
  });

  it("says why it is blocked and where to go, offers a retry on failure, and turns into a receipt once recorded", async () => {
    const jumps: string[] = [];
    const answers: string[] = [];
    const page = await mount(
      <QuestionCard
        timeZone="UTC"
        need={need}
        blocked={{ reason: "Decide the approval above first.", jump: () => jumps.push("round") }}
        onAnswer={() => {}}
        now={() => NOW}
      />,
    );
    expect([...page.querySelectorAll<HTMLButtonElement>("button.need-option")].every((button) => button.disabled)).toBe(true);
    await act(async () => page.querySelector<HTMLButtonElement>(".need-blocked button")!.click());
    expect(jumps).toEqual(["round"]);

    const failed = await mount(
      <QuestionCard
        timeZone="UTC"
        need={need}
        answer={{ status: "failed", text: "Cancel", message: "The owner refused it." }}
        onAnswer={(answer) => answers.push(answer)}
        now={() => NOW}
      />,
    );
    expect(failed.querySelector('[role="alert"]')?.textContent).toContain("The owner refused it.");
    await act(async () => failed.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(answers).toEqual(["Cancel"]);

    const recorded = await mount(
      <QuestionCard
        timeZone="UTC"
        need={{ ...need, choices: { ...choices, multiSelect: true } }}
        answer={{ status: "recorded", text: "1, 3" }}
        onAnswer={() => {}}
        now={() => NOW}
      />,
    );
    expect(recorded.querySelector('[role="group"]')).toBeNull();
    expect(recorded.querySelector(".need-receipt")?.textContent).toContain("You answered Ship it, Cancel");
  });
});

describe("QuestionCard's last minutes", () => {
  it("says once, to a screen reader, that five minutes or less are left — and nothing before", async () => {
    const early = await mount(<QuestionCard timeZone="UTC" need={need} announce onAnswer={() => {}} now={() => NOW} />);
    expect(early.querySelector(".visually-hidden[role=status]")?.textContent).toBe("");
    const late = await mount(<QuestionCard timeZone="UTC" need={need} announce onAnswer={() => {}} now={() => NOW + 26 * 60_000} />);
    expect(late.querySelector(".visually-hidden[role=status]")?.textContent).toBe(
      "Five minutes or less left to answer: Ship to production?",
    );
    // Where the page's own announcer speaks (the chat), the card adds no region of its own.
    const quiet = await mount(<QuestionCard timeZone="UTC" need={need} onAnswer={() => {}} now={() => NOW + 26 * 60_000} />);
    expect(quiet.querySelector(".visually-hidden[role=status]")).toBeNull();
  });
});

describe("QuestionReceipt", () => {
  const at = "2026-10-02T14:02:00.000Z";
  it("says who answered what and through what, or what the task went with, or that it was withdrawn", async () => {
    const elsewhere = await mount(
      <QuestionReceipt
        timeZone="UTC"
        receipt={{ waitId: "w", outcome: "answered", answers: ["Ship it"], decidedBy: "Ana", via: "telegram-main", at }}
      />,
    );
    expect(elsewhere.textContent).toMatch(/^ Ana answered Ship it via telegram-main · /);
    const here = await mount(
      <QuestionReceipt
        timeZone="UTC"
        receipt={{ waitId: "w", outcome: "answered", replyText: "Monday", decidedBy: "operator", via: "bridge", at }}
      />,
    );
    expect(here.textContent).toMatch(/^ You answered Monday · /);
    const defaulted = await mount(
      <QuestionReceipt timeZone="UTC" receipt={{ waitId: "w", outcome: "wait-timeout", answers: ["Wait for a re-run"], at }} />,
    );
    expect(defaulted.textContent).toContain("the chat went with Wait for a re-run");
    const expired = await mount(
      <QuestionReceipt timeZone="UTC" receipt={{ waitId: "w", outcome: "wait-timeout", replyText: "nobody", at }} />,
    );
    expect(expired.textContent).toContain("the chat went on without one");
    const withdrawn = await mount(<QuestionReceipt timeZone="UTC" receipt={{ waitId: "w", outcome: "cancelled", at }} />);
    expect(withdrawn.textContent).toContain("Question withdrawn");
    // The time is the workspace zone's: 14:02 UTC is 23:02 in Tokyo.
    expect(elsewhere.textContent).toContain("14:02");
    const tokyo = await mount(<QuestionReceipt timeZone="Asia/Tokyo" receipt={{ waitId: "w", outcome: "cancelled", at }} />);
    expect(tokyo.textContent).toContain("23:02");
  });
});

describe("the card's accessibility", () => {
  const audit = async (host: HTMLElement): Promise<string[]> => {
    // Contrast needs layout jsdom does not have.
    const result = await axe.run(host, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    return result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
  };

  it("has no WCAG 2.1 A/AA violations axe can find, open, multi-select, blocked or as a receipt", async () => {
    expect(
      await audit(await mount(<QuestionCard timeZone="UTC" need={need} answer={undefined} onAnswer={() => undefined} announce />)),
    ).toEqual([]);
    document.body.innerHTML = "";
    expect(
      await audit(
        await mount(
          <QuestionCard
            timeZone="UTC"
            need={{ ...need, choices: { ...choices, multiSelect: true } }}
            answer={undefined}
            onAnswer={() => undefined}
          />,
        ),
      ),
    ).toEqual([]);
    document.body.innerHTML = "";
    expect(
      await audit(
        await mount(
          <QuestionCard
            timeZone="UTC"
            need={need}
            answer={undefined}
            onAnswer={() => undefined}
            blocked={{ reason: "Answer it in Telegram." }}
          />,
        ),
      ),
    ).toEqual([]);
    document.body.innerHTML = "";
    expect(
      await audit(
        await mount(
          <QuestionReceipt
            timeZone="UTC"
            receipt={{
              waitId: "w",
              outcome: "answered",
              answers: ["Ship it"],
              decidedBy: "Ana",
              via: "telegram-main",
              at: "2026-10-02T14:02:00.000Z",
            }}
          />,
        ),
      ),
    ).toEqual([]);
  });
});
