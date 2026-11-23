import { coreEnglish } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";

import { needLine } from "../../src/features/approvals/inbox.js";
import { doctorSummary } from "../../src/features/doctor/client.js";
import type { DoctorDocument } from "../../src/features/doctor/reports.js";
import { heartbeatResultText, heartbeatStatusText } from "../../src/features/heartbeat/text.js";
import { checklistCount, stepLine } from "../../src/features/onboard/flow.js";
import { reportListText } from "../../src/features/reports/client.js";
import { taskListText } from "../../src/features/tasks/client.js";
import { alignedColumns, paddedCell } from "../../src/shared/terminal-text.js";
import { localeOfSettingsAnswer, wordsIn, yesNoHint, yesNoOf } from "../../src/shared/terminal-words.js";
import { commandHelp } from "../../src/tui/commands.js";
import { chatsPane } from "../../src/tui/panes.js";

/**
 * The terminal in the workspace's language: what `tavi tasks`, `tavi reports`, `tavi heartbeat`, `tavi doctor`,
 * `tavi onboard status` and `tavi needs` print in Bulgarian, the yes-or-no every prompt reads in both languages, and
 * columns that stay aligned when a cell is Cyrillic or wide.
 */

const bg = coreIn("bg");

describe("the terminal's language", () => {
  it("is the workspace's effective locale, else its stored one, else English", () => {
    expect(localeOfSettingsAnswer({ settings: {}, effective: { locale: "bg" } })).toBe("bg");
    expect(localeOfSettingsAnswer({ settings: { locale: "bg" }, effective: {} })).toBe("bg");
    expect(localeOfSettingsAnswer({ settings: { locale: "xx" } })).toBe("en");
    expect(localeOfSettingsAnswer(undefined)).toBe("en");
    // English is the shared default translator, so an English terminal prints exactly what it always has.
    expect(wordsIn("en")).toBe(coreEnglish);
  });

  it.each([
    ["y", true],
    ["YES", true],
    [" д ", true],
    ["Да", true],
    ["n", false],
    ["no", false],
    ["Н", false],
    ["не", false],
    ["", undefined],
    ["yeah", undefined],
    ["дa", undefined],
  ] as const)("reads %j as %s in either language", (typed, answer) => {
    expect(yesNoOf(typed)).toBe(answer);
  });

  it("hints the default in the workspace's letters", () => {
    expect([yesNoHint(true), yesNoHint(false)]).toEqual(["[Y/n]", "[y/N]"]);
    expect([yesNoHint(true, bg), yesNoHint(false, bg)]).toEqual(["[Д/н]", "[д/Н]"]);
  });
});

describe("columns", () => {
  it("pad by terminal columns: a Cyrillic letter is one, a wide character two", () => {
    expect(paddedCell("abc", 6)).toBe("abc   ");
    expect(paddedCell("абв", 6)).toBe("абв   ");
    expect(paddedCell("漢字", 6)).toBe("漢字  ");
    expect(paddedCell("toolong", 3)).toBe("toolong");
    const lines = alignedColumns([
      ["ПЕРИОД", "РАЗМЕР", "x"],
      ["2026-11", "漢字", "y"],
      ["a", "b", "z"],
    ]);
    // Every last column starts at the same terminal column.
    const starts = lines.map((line) => stringWidth(line.slice(0, line.lastIndexOf(" ") + 1)));
    expect(new Set(starts).size).toBe(1);
  });

  it("size /help from its longest translated label, and every description starts in one column", () => {
    for (const t of [coreEnglish, bg]) {
      // A command short enough for the column: its description starts where every other such one does.
      const rows = commandHelp(true, 200, t).filter((row) => /^ {2}\/\S+ {2,}\S/u.test(row));
      expect(rows.length).toBeGreaterThan(5);
      const starts = rows.map((row) => stringWidth(/^ {2}\/\S+ {2,}/u.exec(row)?.[0] ?? ""));
      expect(new Set(starts).size).toBe(1);
    }
    expect(commandHelp(true, 200, bg).join("\n")).toContain("всичко, което чака теб");
  });

  it("size /chats' kind column to the widest kind in the language", () => {
    const row = (taskId: string, chatKind: string, principalId = "operator") =>
      ({ taskId, status: "completed", chatKind, principalId, title: `${taskId} title` }) as never;
    const lines = chatsPane(
      { rows: [row("task-h", "home"), row("task-c", "chat")], truncated: false } as never,
      "default",
      {
        principalId: "operator",
        homeOn: true,
      },
      bg,
    );
    expect(lines[0]).toContain("чатове (работно пространство default)");
    const home = lines.find((line) => line.includes("task-h")) ?? "";
    const chat = lines.find((line) => line.includes("task-c")) ?? "";
    expect(home).toContain("„Начало“");
    expect(stringWidth(home.slice(0, home.indexOf("completed")))).toBe(stringWidth(chat.slice(0, chat.indexOf("completed"))));
  });
});

describe("command output in Bulgarian", () => {
  it("tavi tasks", () => {
    const text = taskListText(
      {
        tasks: [{ taskId: "task-1", status: "completed", updatedAt: "2026-11-15T08:00:00.000Z", title: "Отчет" }],
        pendingApprovals: [{}, {}],
        unresolvedEffects: [{}],
      },
      bg,
    );
    expect(text.split("\n")).toEqual([
      "completed  2026-11-15 08:00  task-1  Отчет",
      "",
      "Още: 2 чакащи одобрения, 1 действие с неизвестен изход.",
      "",
      "Цяла задача: tavi tasks <task-id>. Всичко като JSON: tavi tasks --format json.",
      "",
    ]);
    expect(taskListText({ tasks: [] }, bg)).toMatch(/^Още няма задачи\./u);
  });

  it("tavi reports list, its columns as wide as the Bulgarian headers", () => {
    const rows = [
      {
        periodStart: "2026-11-01",
        periodEnd: "2026-11-07",
        generatedAt: "2026-11-08T06:00:00.000Z",
        artifactId: "art-1",
        bytes: 2048,
        projects: 1,
        metrics: 3,
      },
    ];
    expect(reportListText(rows, bg).split("\n")).toEqual([
      "ПЕРИОД                  ГЕНЕРИРАН (UTC)   РАЗМЕР  СЪДЪРЖАНИЕ",
      "2026-11-01..2026-11-07  2026-11-08 06:00  2048 B  1 проект, 3 показателя",
      "  art-1",
      "",
    ]);
    expect(reportListText(rows).split("\n")[0]).toBe("PERIOD                  GENERATED (UTC)   SIZE    CONTENTS");
  });

  it("tavi heartbeat status, log, run-now and forget", () => {
    const answer = {
      config: {
        enabled: true,
        everyMs: 30 * 60_000,
        deepCheckEveryMs: 4 * 60 * 60_000,
        activeHours: { start: "08:00", end: "20:00" },
        daysOfWeek: [1, 2],
        tellMe: "urgent-now",
        maxNowPerHour: 2,
        targets: [],
        providerId: "builtin",
        budget: { modelTicksPerDay: 24, tokensPerDay: 50_000 },
        extraTools: [],
        fetchHosts: ["example.com"],
        disabledSources: [],
        instructions: "one\ntwo\n",
        mutes: [],
        providerEgress: {},
      },
      providers: [],
      providerDetails: [],
      timezone: "Europe/Sofia",
      hostRunning: false,
      revision: 3,
    } as never;
    const text = heartbeatStatusText(answer, bg).split("\n");
    expect(text).toEqual([
      "Пулс: включен (никога не е запазван; това са стойностите по подразбиране)",
      "Проверява на всеки 30 мин, 08:00–20:00 Europe/Sofia, пн,вт; поглежда по-дълбоко на всеки 4 ч",
      "Казва ти: спешното веднага, останалото в обобщение, когато се отвори следващият прозорец; най-много 2 спешни на час",
      "Получатели: само „Начало“",
      "Доставчик: builtin",
      "Модел: бързият модел на работното пространство; персона: няма",
      "Лимити: 24 проверки, 50000 токена на ден",
      "Допълнителни инструменти: няма",
      "Сайтове, които може да чете: example.com",
      "Изключени източници: няма",
      "Бележки на доставчика: няма",
      "Инструкции: 2 реда",
      "Заглушени: няма",
      "Следваща проверка: няма насрочена; последна проверка: никога",
      "Изпълнител: не работи тук (работи в tavi serve)",
      "Ревизия: 3",
    ]);
    // English as it always was.
    expect(heartbeatStatusText(answer).split("\n").slice(0, 2)).toEqual([
      "Heartbeat: on (never saved; these are the defaults)",
      "Checks every 30m, 08:00–20:00 Europe/Sofia, mon,tue; looks deeper every 4h",
    ]);
    expect(heartbeatResultText({ action: "log" }, { ticks: [] }, bg)).toBe("Още няма проверки.");
    expect(heartbeatResultText({ action: "run-now" }, { status: "started" }, bg)).toBe("Проверявам сега.");
    expect(heartbeatResultText({ action: "forget" }, { removed: { ticks: 2, items: 1, tasks: 0 } }, bg)).toBe(
      "Забравени са редове в дневника: 2, елементи: 1 и задачи: 0. Настройките остават.",
    );
  });

  it("tavi doctor", () => {
    const text = doctorSummary(
      {
        buildId: "dev",
        node: { ok: true, version: "24.1.0", required: ">=24" },
        integrity: { checked: true, ok: true, mode: "quick", problems: [] },
        migrations: { unknown: [], latest: "0042" },
        modelConfiguration: { connections: [{}, {}], workspaceDefault: { target: { connectionId: "openai", model: "gpt-5" } } },
        onboarding: { complete: false },
        sandbox: { tier: "full", mechanism: "bubblewrap" },
        video: { enabled: false },
        disk: { freeBytes: 40 * 1024 ** 3 },
      } as unknown as DoctorDocument,
      false,
      bg,
    ).split("\n");
    expect(text).toEqual([
      "Tavi dev",
      "✓ Node 24.1.0 (нужна е >=24)",
      "✓ База данни: проверка quick, без проблеми",
      "✓ Миграции до 0042",
      "– Сървърът на Tavi не работи (tavi serve)",
      "✓ Модели: 2 връзки, по подразбиране openai/gpt-5",
      "✗ Настройка: моделът не е настроен (tavi onboard)",
      "✓ Изолация: full (bubblewrap)",
      "– Видео: изключено",
      "✓ Диск: 40 GiB свободни",
      "",
      "Целият отчет: tavi doctor --format json",
      "",
    ]);
  });

  it("tavi needs", () => {
    expect(
      needLine(
        {
          kind: "review",
          needId: "review:task-3",
          taskId: "task-3",
          askedAt: "2026-10-02T10:00:00.000Z",
          deadlineAt: "2026-10-02T11:00:00.000Z",
          review: { taskId: "task-3", taskTitle: "Отчет", artifactCount: 2, askedAt: "2026-10-02T10:00:00.000Z" },
        } as never,
        bg,
      ),
    ).toBe(
      "◆ 2 резултата за преглед\n    Отчет (task-3) · до 2026-10-02 11:00Z\n    решение: tavi artifacts list, после approve или reject",
    );
  });

  it("tavi onboard status", () => {
    const status = {
      steps: [
        { kind: "model", state: "done", detail: "openai/gpt-5" },
        { kind: "about", state: "skipped", detail: "" },
        { kind: "search", state: "blocked", detail: "" },
        { kind: "apps", state: "unavailable", detail: "" },
      ],
    } as never;
    expect(checklistCount(status, bg)).toBe("готови 1 от 3");
    expect(checklistCount(status)).toBe("1 of 3 done");
    expect(stepLine({ kind: "about", state: "skipped", detail: "" } as never, bg)).toContain("За теб — пропусната");
    expect(stepLine({ kind: "search", state: "blocked", detail: "" } as never, bg)).toContain("Търсене в мрежата — след модела");
    expect(stepLine({ kind: "search", state: "blocked", detail: "" } as never)).toContain("Web search — after the model");
  });
});
