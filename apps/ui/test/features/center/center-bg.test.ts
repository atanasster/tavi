// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SCOPE_BUTTONS } from "../../../src/features/center/inbox-model.js";
import { KIND_LABELS, MEMORY_GROUPS, layerDetail, layerLabel, layerSource, usageLine } from "../../../src/features/center/memory-model.js";
import { transitionSaid } from "../../../src/features/center/reminder-model.js";
import { heartbeatSuggestions } from "../../../src/features/center/heartbeat-options.js";
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

  it("names the prompt's layers in Bulgarian, and keeps a label it does not know as the owner wrote it", () => {
    const shipped = {
      kind: "base",
      source: "shipped",
      label: "Shipped default (tavi-default-5)",
      length: 2818,
      generated: false,
      active: false,
      templateVersion: "tavi-default-5",
      detail: "Replaced by the workspace prompt",
    } as const;
    expect(layerLabel(shipped)).toBe("Вградените инструкции (tavi-default-5)");
    expect(layerSource(shipped)).toBe("Заменени от инструкциите на работното пространство");
    expect(
      layerLabel({
        kind: "base",
        source: "workspace",
        label: "Workspace prompt (revision 7)",
        revision: 7,
        generated: false,
        active: true,
      }),
    ).toBe("Инструкции на работното пространство (версия 7)");
    expect(layerLabel({ kind: "persona", label: "Persona: Khan", name: "Khan", generated: false, active: true })).toBe("Характер: Khan");
    expect(layerLabel({ kind: "chat", label: "This chat's instructions (revision 3)", revision: 3, generated: false, active: true })).toBe(
      "Инструкциите на този чат (версия 3)",
    );
    expect(layerLabel({ kind: "facts", label: "Runtime facts", generated: true, active: true })).toBe("Данни за хода");
    const context = {
      kind: "context",
      label: "Memory and skills context",
      generated: true,
      active: true,
      detail: "Chosen per call by a newer owner.",
    } as const;
    expect(layerLabel(context)).toBe("Памет и умения");
    // A detail this page does not know is shown as it came.
    expect(layerDetail(context)).toBe("Chosen per call by a newer owner.");
    expect(layerLabel({ kind: "base", source: "workspace", label: "Base prompt", generated: false, active: true })).toBe("Base prompt");
  });

  it("offers the heartbeat's suggested lines in Bulgarian, as the person would write them", () => {
    expect(heartbeatSuggestions()).toEqual([
      "Одобрения или въпроси, чакащи над час",
      "Напомняния и събития през следващите 2\u00a0часа",
      "Пускания по график, които се провалят",
      "Канали, които искат нов вход",
    ]);
  });
});
