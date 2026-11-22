// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { QuestionCard, QuestionReceipt, type QuestionNeed } from "../../../src/features/needs/NeedCard.js";
import { NotifyOffer } from "../../../src/features/needs/NeedNotify.js";
import { setLocale } from "../../../src/lib/i18n.js";
import { mount, unmountAll } from "../../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A question card, its receipt and the notification offer in Bulgarian. */

beforeEach(async () => {
  await setLocale("bg");
});

afterEach(async () => {
  unmountAll();
  await setLocale("en");
});

const NOW = Date.parse("2026-10-02T14:00:00.000Z");
const need: QuestionNeed = {
  question: "Ship to production?",
  choices: {
    header: "Deploy",
    options: [{ label: "Ship it" }, { label: "Wait for a re-run" }, { label: "Cancel" }],
    multiSelect: false,
    allowOther: true,
    recommended: 1,
    defaultOption: 2,
  },
  context: "Two tests are flaky.",
  deadlineAt: "2026-10-02T14:30:00.000Z",
  askedBy: "Daily release",
  channels: ["Telegram"],
};

describe("needs in Bulgarian", () => {
  it("frames the question card's why, deadline, default and other chats", async () => {
    const page = await mount(<QuestionCard timeZone="UTC" need={need} onAnswer={() => {}} now={() => NOW} />);
    const text = page.textContent ?? "";
    expect(page.querySelector(".need-context")?.textContent).toBe("Защо: Two tests are flaky.");
    expect(text).toContain("Отговори до 14:30");
    expect(text).toContain("Ако никой не отговори: Wait for a re-run");
    expect(text).toContain("Питам и в Telegram");
    expect(text).toContain("Препоръчано");
    for (const word of ["Why:", "Answer by", "If nobody answers", "Also asked in", "Recommended", "Your answer", "In your own words"])
      expect(text).not.toContain(word);
  });

  it("says who answered, and what the chat went with", async () => {
    const at = "2026-10-02T14:02:00.000Z";
    const here = await mount(
      <QuestionReceipt
        timeZone="UTC"
        receipt={{ waitId: "w", outcome: "answered", replyText: "Monday", decidedBy: "operator", via: "bridge", at }}
      />,
    );
    expect(here.textContent).toContain("Ти отговори Monday");
    const defaulted = await mount(
      <QuestionReceipt timeZone="UTC" receipt={{ waitId: "w", outcome: "wait-timeout", answers: ["Wait for a re-run"], at }} />,
    );
    expect(defaulted.textContent).toContain("чатът продължи с Wait for a re-run");
    for (const text of [here.textContent ?? "", defaulted.textContent ?? ""])
      for (const word of ["You answered", "No answer by", "the chat went"]) expect(text).not.toContain(word);
  });

  it("offers browser notifications", async () => {
    const page = await mount(<NotifyOffer onAccept={() => undefined} onDecline={() => undefined} />);
    expect(page.textContent).toContain("Да ти пращам ли известие в браузъра следващия път?");
    expect(page.textContent).toContain("Включи");
    expect(page.textContent).toContain("Не сега");
    for (const word of ["Turn on", "Not now", "Get a browser notification"]) expect(page.textContent).not.toContain(word);
  });
});
