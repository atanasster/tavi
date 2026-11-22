// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SCOPE_BUTTONS } from "../../../src/features/center/inbox-model.js";
import { KIND_LABELS, MEMORY_GROUPS, usageLine } from "../../../src/features/center/memory-model.js";
import { transitionSaid } from "../../../src/features/center/reminder-model.js";
import { setLocale } from "../../../src/lib/i18n.js";

/**
 * The center's tables are getters: read after a change of language, each says
 * its words in the new one. A table snapshotted into a constant would keep the
 * English, and the approvals' keyboard shortcuts, which compare a button's text
 * with `SCOPE_BUTTONS`, would stop working in Bulgarian.
 */

beforeAll(async () => {
  await setLocale("bg");
});

afterAll(async () => {
  await setLocale("en");
});

describe("the center in Bulgarian", () => {
  it("reads its tables in the language now chosen", async () => {
    expect(SCOPE_BUTTONS.once).toBe("Разреши веднъж");
    expect(MEMORY_GROUPS[0]?.label).toBe("Факти");
    expect(KIND_LABELS.fact).toBe("Факт");
    expect(transitionSaid("pause")).toBe("Напомнянето е на пауза.");
    expect(transitionSaid("pause", "Изпий хапчетата")).toBe("Напомнянето „Изпий хапчетата“ е на пауза.");

    await setLocale("en");
    expect(SCOPE_BUTTONS.once).toBe("Allow once");
    expect(MEMORY_GROUPS[0]?.label).not.toBe("Факти");
    await setLocale("bg");
  });

  it("writes a size with the decimal comma and a no-break space before its unit", () => {
    const quota = { maxRecords: 10_000, maxBytes: 32 * 1024 * 1024, records: 11, bytes: 3174 };
    const line = usageLine({ records: 40, bytes: 90_000, quota });
    expect(line).toContain("32 МБ");
    expect(line).toContain("3,1 КБ");
  });
});
