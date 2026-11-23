import { describe, expect, it } from "vitest";

import { guardCheck, GUARD_MODS } from "../src/index.js";
import { check, next } from "./support/check.js";
import { guardMods } from "../src/manifest.js";

/** `tavi.guard` in a Bulgarian workspace: the person's approval card speaks Bulgarian; the model's refusal stays English. */

describe("guardCheck in Bulgarian", () => {
  it("asks in the workspace's language, with the paths it would touch", async () => {
    expect(await guardCheck(check({ command: "git clean -fdx" }, { locale: "bg" }), next)).toEqual({
      decision: "ask",
      reason: "Тази команда изтрива файловете, които git не следи.",
    });
    expect(await guardCheck(check({ command: "truncate -s 0 /tmp/tavi-guard-notes.md" }, { locale: "bg" }), next)).toEqual({
      decision: "ask",
      reason: "Тази команда скъсява файлове: /tmp/tavi-guard-notes.md.",
    });
  });

  it("asks in English byte for byte when the workspace is English or names no language", async () => {
    for (const locale of [undefined, "en"] as const)
      expect(await guardCheck(check({ command: "git reset --hard" }, locale === undefined ? {} : { locale }), next)).toEqual({
        decision: "ask",
        reason: "This command discards uncommitted work.",
      });
  });

  it("refuses in English where nobody can approve: the model reads it", async () => {
    expect(await guardCheck(check({ command: "git reset --hard" }, { locale: "bg", attended: false }), next)).toEqual({
      decision: "deny",
      reason: "This command discards uncommitted work. Nobody can approve it in this run, so the tavi.guard plugin refused it.",
    });
  });

  it("discloses its hook in Bulgarian, and in English as declared", async () => {
    const { coreIn } = await import("@tavi/contracts/locales/core-server");
    expect(guardMods(coreIn("bg")).hooks[0]?.disclosure).toBe(
      "Пита преди команда в терминала, която изтрива или презаписва файлове, и казва какво ще засегне.",
    );
    expect(guardMods()).toEqual(GUARD_MODS);
    expect(GUARD_MODS.hooks[0]?.disclosure).toBe(
      "Asks before a shell command that deletes or overwrites files, and says what it would touch.",
    );
  });
});
