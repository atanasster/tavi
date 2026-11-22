// @vitest-environment jsdom
import { NOTICE_TITLE_MAX, type ChatNotice } from "@tavi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { outcomeSentence } from "../../../src/features/center/schedule-model.js";
import { NoticeCards, noticeTitle } from "../../../src/features/chat/Notices.js";
import { setLocale } from "../../../src/lib/i18n.js";
import { mount, unmountAll } from "../../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Stored notices said in the reader's language by their keys; one stored before keys shows the English it was written in. */

beforeEach(async () => {
  await setLocale("bg");
});

afterEach(async () => {
  unmountAll();
  await setLocale("en");
});

const AT = "2026-11-22T08:00:00.000Z";

const keyed: ChatNotice = {
  noticeId: "n1",
  taskId: "home-1",
  kind: "run-settled",
  title: "Routine “News” paused",
  summary: "Routine “News” paused after 3 failed runs in a row; its run history says why.",
  titleRef: { key: "notice.routine.paused.title", params: { name: "News" } },
  summaryRef: {
    key: "notice.routine.failures.text",
    params: {
      name: "News",
      n: "3",
      resume: {
        key: "notice.routine.resumeHint",
        params: { path: { key: "nav.path.two", params: { first: { key: "nav.route.center" }, second: { key: "nav.center.schedule" } } } },
      },
    },
  },
  afterSeq: 0,
  createdAt: AT,
};

const older: ChatNotice = {
  noticeId: "n2",
  taskId: "home-1",
  kind: "run-settled",
  title: "Scheduled work",
  summary: "Your schedules and routines have used 900,000 tokens for 2026-11.",
  afterSeq: 0,
  createdAt: AT,
};

describe("stored notices in Bulgarian", () => {
  it("says a notice with keys in Bulgarian, and one stored before keys in its English", async () => {
    const page = await mount(<NoticeCards notices={[keyed, older]} connected />);
    const text = page.textContent ?? "";
    expect(text).toContain("Рутината „News“ е на пауза");
    expect(text).toContain("Пусни я отново от Център → График");
    expect(text).not.toContain("Routine “News” paused");
    expect(text).toContain("Scheduled work");
    expect(text).toContain("Your schedules and routines have used 900,000 tokens for 2026-11.");
  });

  it("keeps a title said from its key on one line and within a title's bound, as the English is stored", () => {
    const name = `Long\n${"word ".repeat(60)}`;
    const title = noticeTitle({ title: "Scheduled run", titleRef: { key: "notice.schedule.result.title", params: { name } } });
    expect(title).not.toContain("\n");
    expect(title.length).toBeLessThanOrEqual(NOTICE_TITLE_MAX);
    expect(title.startsWith("Пускане по график „Long word")).toBe(true);
  });

  it("shows a notice's English when its key is one this build does not know", async () => {
    const page = await mount(<NoticeCards notices={[{ ...keyed, titleRef: { key: "notice.fromLater" } }]} connected />);
    expect(page.textContent).toContain("Routine “News” paused");
  });

  it("says a fire's outcome the scheduler stored by key, after what asked for its run", () => {
    expect(
      outcomeSentence("webhook refused 2 calls this hour (2 auth)", "UTC", {
        key: "schedule.outcome.webhookRefused",
        params: { count: 2, n: "2", causes: "2 auth" },
      }),
    ).toBe("Уебхукът отказа 2 извиквания този час (2 auth).");
    const said = outcomeSentence("manual run: completed, but its result was not posted: posting it into Home failed", "UTC", {
      key: "schedule.outcome.labelled",
      params: { label: { key: "schedule.outcome.label.manual" }, said: { key: "schedule.outcome.notPosted.failed" } },
    });
    expect(said).toContain("резултатът не е публикуван");
    expect(said).not.toContain("posting it into Home");
    // An outcome with no key is said as it came.
    expect(outcomeSentence("webhook refused 2 calls this hour (2 auth)", "UTC")).toBe("Webhook refused 2 calls this hour (2 auth).");
  });
});
