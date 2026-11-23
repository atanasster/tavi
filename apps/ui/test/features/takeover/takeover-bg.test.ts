import { BROWSER_LIVE_UPLOAD_MAX_BYTES, type IdeaRun } from "@tavi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lastLooked, runNote } from "../../../src/features/ideas/ideas-api.js";
import { stopLabel, stopTakenOverTask } from "../../../src/features/takeover/context.js";
import { uploadRefusal } from "../../../src/features/takeover/input.js";
import { setLocale } from "../../../src/lib/i18n.js";

/**
 * The takeover's and the ideas' helpers translate when they are called: each
 * says its words in the language chosen at that moment, not the one the module
 * was loaded in.
 */

beforeEach(async () => {
  await setLocale("bg");
});

afterEach(async () => {
  await setLocale("en");
});

const run: IdeaRun = {
  id: "run-1",
  workspaceId: "default",
  trigger: "schedule",
  startedAt: "2026-11-22T09:00:00.000Z",
  outcome: "generated",
  generated: 1,
  dropped: 0,
  tokens: 0,
  usd: 0,
};

describe("takeover and ideas helpers in Bulgarian", () => {
  it("label Stop for the chat that runs", () => {
    expect(stopLabel("worker", true)).toBe("Спри работата");
    expect(stopLabel("run", true)).toBe("Спри изпълнението");
    expect(stopLabel("chat", true)).toBe("Спри чата");
  });

  it("refuse an upload in Bulgarian, with a no-break space before the unit", () => {
    expect(uploadRefusal([], false)).toBe("Не е избран файл.");
    const megabytes = BROWSER_LIVE_UPLOAD_MAX_BYTES / (1024 * 1024);
    expect(uploadRefusal([{ size: BROWSER_LIVE_UPLOAD_MAX_BYTES + 1 }], false)).toBe(`Общо най-много ${megabytes} МБ.`);
  });

  it("say when ideas were last looked for", () => {
    expect(lastLooked(undefined, "UTC")).toBe("Още няма търсене.");
    expect(runNote(run)).toBe("Има нови идеи.");
  });

  it("switch back to English when the language changes", async () => {
    await setLocale("en");
    expect(stopLabel("worker", true)).not.toBe("Спри работата");
    expect(lastLooked(undefined, "UTC")).not.toBe("Още няма търсене.");
  });

  it("stores the person's reason for stopping a chat in their language", async () => {
    const asked: Record<string, unknown>[] = [];
    await stopTakenOverTask(
      async (command, payload) => {
        asked.push({ command, ...payload });
        return command === "abort" ? { ok: false, error: { code: "NOT_RUNNING", message: "idle" } } : { ok: true };
      },
      { taskId: "task-1", workspaceId: "default", isHome: false },
    );
    expect(asked).toContainEqual({ command: "cancel", taskId: "task-1", reason: "Спряно, докато ти управляваше браузъра" });
  });
});
