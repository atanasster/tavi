import { initialRunState, type RunState } from "@tavi/client/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { waitingOf } from "../../../src/features/chat-panel/Activity.js";
import { usage } from "../../../src/features/chat-panel/Details.js";
import { CHAT_PANEL_LABELS } from "../../../src/features/chat-panel/tabs.js";
import { said, spoken } from "../../../src/features/chat/store/said.js";
import { answerOutcome, deadlineLabel, lastMinutesSentence } from "../../../src/features/needs/NeedCard.js";
import { needHeadline } from "../../../src/features/needs/NeedNotify.js";
import { groupHeading } from "../../../src/features/sessions/sessions.js";
import type { Session } from "../../../src/features/shell/shell.js";
import { formatControlled } from "../../../src/features/takeover/input.js";
import { videoPreviewsOf } from "../../../src/features/transcript/VideoFrames.js";
import { formatCount, listed } from "../../../src/lib/format.js";
import { setLocale, translateNow } from "../../../src/lib/i18n.js";

/**
 * The chat panel's, the needs', the sessions' and the transcript's helpers
 * translate when they are called: each says its words in the language chosen
 * at that moment, not the one the module was loaded in.
 */

beforeEach(async () => {
  await setLocale("bg");
});

afterEach(async () => {
  await setLocale("en");
});

const session = (state: Partial<RunState> = {}): Session => ({
  key: "task-1",
  taskId: "task-1",
  title: "t",
  status: "completed",
  runs: [
    {
      id: "ui-1",
      prompt: "p",
      run: { ...initialRunState(), taskId: "task-1", status: "completed", ...state },
      roundCalls: {},
      deciding: undefined,
      aborting: false,
    },
  ],
});

describe("chat helpers in Bulgarian", () => {
  it("name the panel's tabs and the sidebar's groups", () => {
    expect(CHAT_PANEL_LABELS.activity).toBe("Дейност");
    expect(groupHeading("Needs you")).toBe("Чака теб");
    expect(groupHeading("Stopped · 2026-11-22")).toBe("Спрени · 2026-11-22");
    expect(groupHeading("Completed · 2026-11-22")).toBe("Завършени · 2026-11-22");
  });

  it("list items with „и“ before the last", () => {
    expect(listed([])).toBe("");
    expect(listed(["А"])).toBe("А");
    expect(listed(["А", "Б", "В"])).toBe("А, Б и В");
  });

  it("say a question's deadline, its last minutes and its notification", () => {
    const now = Date.parse("2026-11-22T10:00:00.000Z");
    expect(deadlineLabel("2026-11-22T10:25:00.000Z", now, "UTC").text).toMatch(/^Отговори до .+ · 25 мин$/);
    expect(deadlineLabel("2026-11-22T09:00:00.000Z", now, "UTC").text).toMatch(/^Срокът беше /);
    expect(lastMinutesSentence("Кой сайт?")).toBe("Остават пет минути или по-малко за отговор: Кой сайт?");
    expect(
      needHeadline({
        kind: "review",
        review: { taskTitle: undefined, artifactCount: 2 },
      } as Parameters<typeof needHeadline>[0]),
    ).toEqual({ title: "Един чат има резултати за преглед", body: "2 резултата" });
  });

  it("say what waits, the usage and a refused answer", () => {
    const pending = session({
      pending: [
        {
          taskId: "task-1",
          steps: 2,
          requests: [
            { toolName: "browser.click", callId: "c1", input: {} },
            { toolName: "browser.type", callId: "c2", input: {} },
            { toolName: "files.write", callId: "c3", input: {} },
          ],
        },
      ] as unknown as RunState["pending"],
    });
    expect(waitingOf(pending).map((item) => item.title)).toEqual(["Одобри browser.click, browser.type и files.write"]);
    expect(usage(session({ metrics: { models: ["m"], totalTokens: 12_345, partial: true } }))).toEqual({
      scope: "последното изпълнение",
      models: ["m"],
      tokens: `поне ${formatCount(12_345)} (непълно)`,
    });
    const refused = answerOutcome("1", { ok: false, code: "CONFLICT", message: "x" });
    expect(refused.message === undefined ? undefined : spoken(refused.message, translateNow)).toBe(
      "Отговорено е другаде или въпросът се затвори, преди отговорът ти да стигне до него.",
    );
    expect(spoken(said("chat.store.answerNotRecorded"), translateNow)).toBe("Отговорът не е записан.");
  });

  it("caption a video's frames and say how long a person had the browser", () => {
    expect(videoPreviewsOf({ sheet: { artifactId: "s" }, frames: [{ artifactId: "f", timeSec: 1.5 }] })).toEqual([
      { artifactId: "s", caption: "Всички кадри", wide: true },
      { artifactId: "f", caption: "Кадър на 1,5 сек", wide: false },
    ]);
    expect(formatControlled(72_400)).toBe("1 мин 12 сек");
    expect(formatControlled(45_000)).toBe("45 сек");
  });

  it("speak English again once the language is switched back", async () => {
    await setLocale("en");
    expect(CHAT_PANEL_LABELS.activity).toBe("Activity");
    expect(groupHeading("Stopped · 2026-11-22")).toBe("Stopped · 2026-11-22");
    expect(listed(["a", "b", "c"])).toBe("a, b, c");
    expect(formatControlled(72_400)).toBe("1 m 12 s");
    expect(spoken(said("chat.store.answerNotRecorded"), translateNow)).toBe("The answer was not recorded.");
  });
});
