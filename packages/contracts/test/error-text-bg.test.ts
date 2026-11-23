import { describe, expect, it } from "vitest";

import { errorTextIn, keyedError, TaviError, taviErrorOf } from "../src/index.js";
import { createTranslator } from "../src/i18n.js";
import { CORE_BG } from "../src/locales/core-bg.js";
import { CORE_EN } from "../src/locales/core-en.js";

const bg = createTranslator({ en: CORE_EN, bg: CORE_BG }, "bg");

/** An error as a person reads it: by its key in their language, an unkeyed one framed so it reads as theirs. */
describe("errorTextIn", () => {
  it("says a keyed error in the reader's language", () => {
    const error = keyedError("NOT_FOUND", "error.task.notFound", { taskId: "task-1" });
    expect(errorTextIn(error, bg)).toBe("Чатът task-1 не съществува");
    // An error's data off the wire, which is no Error, keeps its key.
    expect(errorTextIn(error.toData(), bg)).toBe("Чатът task-1 не съществува");
  });

  it("frames an unkeyed error's English in the reader's language", () => {
    expect(errorTextIn(new Error("disk full"), bg)).toBe("Нещо се обърка: disk full");
    expect(errorTextIn({ code: "INTERNAL", message: "disk full" }, bg)).toBe("Нещо се обърка: disk full");
  });

  it("is the message, byte for byte, in English", () => {
    expect(errorTextIn(new Error("disk full"))).toBe("disk full");
    expect(errorTextIn(keyedError("NOT_FOUND", "error.task.notFound", { taskId: "task-1" }))).toBe("Task task-1 does not exist");
  });

  it("falls back to the English message, unframed, for a key it does not know", () => {
    const error = new TaviError("INTERNAL", "an older owner's words", { i18n: { key: "error.gone.fromCatalogue" } as never });
    expect(errorTextIn(error, bg)).toBe("an older owner's words");
  });

  it("carries the key through a re-throw of an answer's error", () => {
    const answer = keyedError("NOT_FOUND", "error.task.notFound", { taskId: "task-1" }).toData();
    const rethrown = taviErrorOf(answer);
    expect(rethrown).toBeInstanceOf(TaviError);
    expect(rethrown.message).toBe("Task task-1 does not exist");
    expect(errorTextIn(rethrown, bg)).toBe("Чатът task-1 не съществува");
    expect(taviErrorOf({ code: "INTERNAL", message: "plain" }).i18n).toBeUndefined();
  });
});
