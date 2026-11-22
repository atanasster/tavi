import { describe, expect, it } from "vitest";

import { DESKTOP_HOST_PREFIX } from "../src/content-label.js";
import { createTranslator } from "../src/i18n.js";
import { CORE_BG } from "../src/locales/core-bg.js";
import { CORE_EN } from "../src/locales/core-en.js";
import {
  GATE_REASON_WORDS,
  SOURCE_WORDS,
  TAINT_DETAIL_NOTES,
  approvalProvenanceLine,
  argOriginWords,
  gateReasonWords,
  provenanceChips,
  provenanceSourcesPhrase,
  refEstablished,
  sourceWords,
  taintChipText,
  taintDetailLines,
  taintedCallWords,
  whyAskedText,
} from "../src/provenance-display.js";
import { skillCeilingWords, skillToolsEscalationText } from "../src/skill-ceiling.js";
import {
  skillActivationHistoryText,
  skillProposalNoticeLine,
  skillProposalUntrustedLine,
  skillTraceLine,
  skillUsageText,
} from "../src/skills.js";
import type { SourceKind } from "../src/content-label.js";
import { memoryProvenanceLine } from "../src/memory.js";
import { routineProvenanceLine } from "../src/routines.js";
import { toolGroupScopeNote, type GateReason } from "../src/tool-policy.js";

const bg = createTranslator({ en: CORE_EN, bg: CORE_BG }, "bg");

describe("the safety part in Bulgarian", () => {
  it("names every source kind and gate reason, and English stays the table it was", () => {
    for (const source of Object.keys(SOURCE_WORDS) as SourceKind[]) {
      expect(sourceWords(source)).toBe(SOURCE_WORDS[source]);
      expect(sourceWords(source, bg)).not.toBe(SOURCE_WORDS[source]);
    }
    for (const reason of Object.keys(GATE_REASON_WORDS) as GateReason[]) {
      expect(gateReasonWords(reason, bg)).toMatch(/[а-я]/);
      expect(whyAskedText(reason, true, undefined, undefined, bg)).toBe(gateReasonWords(reason, bg));
    }
    expect(sourceWords("web", bg)).toBe("уеб страница");
    expect(whyAskedText(undefined, true, undefined, undefined, bg)).toBe(taintedCallWords(bg));
    expect(whyAskedText("tainted-persist", true, undefined, "desktop.click", bg)).toMatch(/^Този чат прочете .*щраква/);
  });

  it("says what Tavi established first, and a page's claim after it", () => {
    expect(refEstablished({ source: "email", host: "x.example" }, bg)).toBe("поща, която препрати или цитира (през x.example)");
    expect(refEstablished({ source: "web", host: `${DESKTOP_HOST_PREFIX}Notes` }, bg)).toBe("екран на настолно приложение (Notes)");
    expect(refEstablished({ source: "download", host: "files.example" }, bg)).toBe("изтеглен файл (files.example)");
    const chips = provenanceChips(
      {
        sources: ["web", "attachment"],
        refs: [{ source: "web", ref: "r1", host: "example.com", title: "Начало", at: "2026-11-22T10:00:00.000Z" }],
      },
      bg,
    );
    expect(chips).toEqual([
      { established: "example.com", claim: "страницата се представя като „Начало“" },
      { established: "прикачен файл" },
    ]);
  });

  it("lists the sources in one line, with the rest counted", () => {
    const four = {
      sources: [] as SourceKind[],
      refs: ["a.example", "b.example", "c.example", "d.example"].map((host, at) => ({
        source: "web" as const,
        ref: `r${at}`,
        host,
        at: "2026-11-22T10:00:00.000Z",
      })),
    };
    expect(provenanceSourcesPhrase(four, undefined, bg)).toBe("a.example, b.example, c.example и още 1");
    expect(provenanceSourcesPhrase({ sources: ["web", "email"], refs: [] }, undefined, bg)).toBe("уеб страница и имейл");
    expect(provenanceSourcesPhrase({ sources: [], refs: [] }, undefined, bg)).toBe("непроверено съдържание");
    expect(approvalProvenanceLine({ sources: ["email"], refs: [] }, true, bg)).toBe("⚠ след четене на имейл — само веднъж");
    expect(taintChipText({ sources: ["search"], refs: [] }, bg)).toBe("Прочетено: резултати от търсене");
  });

  it("says where a call's value appears, and what a tainted chat changes", () => {
    expect(argOriginWords({ path: "to", value: "a@b.example", from: "person" }, bg)).toBe("от твоето съобщение");
    expect(argOriginWords({ path: "to", value: "x", from: "content", toolId: "mail.read" }, bg)).toBe("среща се в резултата на mail.read");
    const lines = taintDetailLines({ sources: [], refs: [] }, bg);
    expect(lines[0]).toBe("Този чат прочете съдържание, на което Tavi не вярва:");
    expect(lines[1]).toBe("  непроверено съдържание");
    expect(lines).toHaveLength(2 + TAINT_DETAIL_NOTES.length);
  });

  it("names a skill ceiling's skills and what it declared", () => {
    expect(skillCeilingWords({ skillIds: ["pdf-forms"], declared: [], unenforceable: [] }, bg)).toMatch(
      /^Този чат зареди умението „pdf-forms“, .*\(allowed-tools: няма инструменти\)/,
    );
    expect(skillCeilingWords({ skillIds: ["a", "b"], declared: ["Read", "Foo"], unenforceable: ["Foo"] }, bg)).toMatch(
      /^Този чат зареди уменията „a“, „b“, .*\(allowed-tools: Read, Foo\).* Изброени, но тук не могат да се наложат: Foo\.$/,
    );
    expect(skillToolsEscalationText(["Read"], ["Read", "Bash"], bg)).toBe("Разширяване: тази версия добавя към allowed-tools Bash");
  });

  it("words a skill's history, uses and trace", () => {
    expect(skillActivationHistoryText({ reason: "rollback", newVersion: "1.0.0", previousVersion: "2.0.0" }, bg)).toBe(
      "Връщане към 1.0.0 (преди: 2.0.0)",
    );
    expect(skillActivationHistoryText({ reason: "disable", previousVersion: "1.0.0" }, bg)).toBe("Изключване (преди: 1.0.0)");
    expect(skillUsageText({ uses: 0 }, bg)).toBe("не е използвано");
    expect(skillUsageText({ uses: 1, lastUsedAt: "2026-10-20T08:00:00.000Z" }, bg)).toBe("1 използване, последно 2026-10-20");
    expect(skillUsageText({ uses: 1200, lastUsedAt: "2026-10-20T08:00:00.000Z" })).toBe("1200 uses, last 2026-10-20");
    expect(skillTraceLine({ toolName: "web_fetch", input: "", status: "failed" }, bg)).toBe("web_fetch — неуспешно");
    expect(skillProposalNoticeLine("s1", "1.0.0", bg)).toBe("Умение чака преглед от теб: tavi skills show s1 --body --version 1.0.0");
  });
});

describe("provenance lines in Bulgarian", () => {
  const read = {
    integrity: "untrusted" as const,
    sources: ["web" as const, "search" as const],
    refs: [
      { source: "web" as const, ref: "c1", host: "a.example", title: "Новини", at: "2026-10-13T00:00:01.000Z" },
      { source: "web" as const, ref: "c2", host: "b.example", at: "2026-10-13T00:00:02.000Z" },
      { source: "web" as const, ref: "c3", host: "c.example", at: "2026-10-13T00:00:03.000Z" },
      { source: "web" as const, ref: "c4", host: "d.example", at: "2026-10-13T00:00:04.000Z" },
    ],
  };

  it("says what a chat read as a whole sentence", () => {
    expect(memoryProvenanceLine(read, {}, bg)).toBe(
      "Предложено, след като този чат прочете уеб страница и резултати от търсене (a.example, b.example, c.example и още 1) — страницата се представя като „Новини“",
    );
    expect(memoryProvenanceLine(read, { tidyUp: true }, bg)).toMatch(
      /^Обединява спомени, предложени, след като един чат прочете уеб страница/,
    );
    expect(routineProvenanceLine(read, bg)).toMatch(/^Променено от Tavi, след като чатът му прочете уеб страница/);
    expect(routineProvenanceLine(read)).toMatch(
      /^Changed by Tavi after its chat read a web page and search results \(a\.example, b\.example, c\.example and 1 more\)/,
    );
    expect(skillProposalUntrustedLine({ manifest: { proposal: { untrusted: read } } } as never, bg)).toMatch(
      /^Предложено, след като този чат прочете уеб страница/,
    );
    expect(memoryProvenanceLine({ integrity: "untrusted", sources: [], refs: [] }, {}, bg)).toBe(
      "Предложено, след като този чат прочете непроверено съдържание",
    );
  });

  it("says a browser group's scope note", () => {
    expect(toolGroupScopeNote("browser.*", bg)).toBe(
      "Отварянето на друг сайт пита отново и никое одобрение не отваря този компютър или адрес в частна мрежа.",
    );
    expect(toolGroupScopeNote("browser.*")).toBe(
      "Opening another site asks again, and no approval opens this machine or a private network address.",
    );
  });
});
