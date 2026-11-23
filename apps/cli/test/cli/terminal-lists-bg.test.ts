import { coreEnglish } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { ideasResultText } from "../../src/features/ideas/text.js";
import { pluginDetail } from "../../src/features/plugins/client.js";
import { remindersResultText } from "../../src/features/reminders/text.js";
import { taskListText } from "../../src/features/tasks/client.js";
import { capture } from "../support/attached-owner.js";

/**
 * The text of `tavi tasks`, `tavi reminders`, `tavi ideas`, `tavi plugins show` and `tavi schedules` in a Bulgarian
 * workspace: statuses, headings and answers in Bulgarian, English as it always printed. JSON and `--help` are not
 * text and stay English.
 */

const bg = coreIn("bg");
const dirs = temporaryDirectories();
afterEach(() => dirs.cleanup());

describe("tavi tasks in Bulgarian", () => {
  const document = {
    tasks: [
      { status: "completed", updatedAt: "2026-11-23T09:00:00.000Z", taskId: "task-1", title: "План" },
      { status: "waiting", updatedAt: "2026-11-23T10:00:00.000Z", taskId: "task-2" },
      { status: "someday", updatedAt: "2026-11-23T11:00:00.000Z", taskId: "task-3" },
    ],
  };

  it("says each status in Bulgarian and keeps one it does not know as the owner sent it", () => {
    const text = taskListText(document, bg);
    expect(text).toContain("завършена");
    expect(text).toContain("чака");
    expect(text).toContain("someday");
    expect(text).not.toContain("completed");
  });

  it("prints English statuses as the owner stores them", () => {
    const text = taskListText(document, coreEnglish);
    expect(text).toMatch(/^completed {2}2026-11-23 09:00 {2}task-1 {2}План/m);
    expect(text).toMatch(/^waiting {4}2026-11-23 10:00 {2}task-2/m);
  });
});

describe("tavi reminders in Bulgarian", () => {
  const reminder = {
    reminderId: "rem-1",
    status: "active",
    text: "Обади се на зъболекаря",
    timezone: "Europe/Sofia",
    when: { kind: "repeat", times: ["09:00"], daysOfWeek: [1, 3] },
    nextFireAt: "2026-11-25T07:00:00.000Z",
  };
  const options = { action: "list", workspaceId: "default" } as never;

  it("heads the list and its columns in Bulgarian, with Bulgarian weekdays", () => {
    const text = remindersResultText(
      options,
      { timezone: "Europe/Sofia", reminders: [reminder] },
      new Date("2026-11-23T08:00:00Z"),
      120,
      bg,
    );
    expect(text).toContain("Напомняния (Europe/Sofia)");
    expect(text).toContain("НАПОМНЯНЕ");
    expect(text).toContain("активно");
    expect(text).not.toMatch(/\bMon\b|\bactive\b|REMINDER/);
    expect(remindersResultText(options, { timezone: "UTC", reminders: [] }, new Date(), 80, bg)).toBe("Няма напомняния (UTC)");
  });

  it("prints English as it always did", () => {
    const text = remindersResultText(options, { timezone: "Europe/Sofia", reminders: [reminder] }, new Date("2026-11-23T08:00:00Z"), 120);
    expect(text).toContain("Reminders (Europe/Sofia)");
    expect(text).toContain("REMINDER");
    expect(text).toContain("Mon,Wed 09:00");
  });
});

describe("tavi ideas in Bulgarian", () => {
  it("answers its settings and counts in Bulgarian, with the count's own form", () => {
    expect(ideasResultText({ action: "on" } as never, { settings: { enabled: true } }, 80, bg)).toBe("Идеите са включени");
    expect(ideasResultText({ action: "reset", reset: "sections" } as never, { cleared: 1 }, 80, bg)).toBe("Включих отново 1 раздел");
    expect(ideasResultText({ action: "budget" } as never, { settings: { dailyTokens: 2000 } }, 80, bg)).toBe(
      "Моделът може да харчи до 2000 токена на ден за идеите",
    );
    expect(ideasResultText({ action: "digest" } as never, { settings: { digest: { channel: "telegram", weekday: 1 } } }, 80, bg)).toContain(
      "веднъж седмично (понеделник)",
    );
  });

  it("prints English as it always did", () => {
    expect(ideasResultText({ action: "reset", reset: "other" } as never, { cleared: 1 }, 80)).toBe(
      "Forgot 1 dismissal, snooze and exclusion",
    );
    expect(ideasResultText({ action: "reset", reset: "sections" } as never, { cleared: 2 }, 80)).toBe("Unmuted 2 sections");
    expect(ideasResultText({ action: "digest" } as never, { settings: { digest: { channel: "telegram", weekday: 1 } } }, 80)).toBe(
      "The ideas digest goes to your chat on telegram each Monday, inside your ideas hours",
    );
  });
});

describe("tavi reminders show in Bulgarian", () => {
  const reminder = {
    reminderId: "rem-2",
    status: "active",
    text: "Среща",
    timezone: "Europe/Berlin",
    when: { kind: "once", at: "2026-10-02T07:00:00.000Z" },
    deliverTo: { kind: "app" },
    createdBy: "owner",
    upcoming: [],
  };
  const now = new Date("2026-10-01T10:00:00.000Z");
  const show = { action: "show", workspaceId: "default" } as never;

  it("reads the reminder back in Bulgarian; English reads it back as the agent does", () => {
    expect(remindersResultText(show, { reminder, fires: [] }, now, 120, bg)).toContain(
      "пт, 2 окт в 09:00 Europe/Berlin; ще ти напомня тогава",
    );
    expect(remindersResultText(show, { reminder, fires: [] }, now, 120)).toContain("Fri 2 Oct 09:00 Europe/Berlin; I'll remind you then");
  });
});

describe("tavi plugins show in Bulgarian", () => {
  const plugin = {
    id: "acme.guard",
    kind: "external",
    name: "Guard",
    description: "",
    enabled: false,
    core: false,
    directory: "/data/plugins/acme.guard",
    runsOwnerCode: true,
    versions: [
      {
        version: "0.1.0",
        reviewState: "proposed",
        contentHash: "a".repeat(64),
        installedAt: "2026-11-03T16:25:10.917Z",
        runsOwnerCode: true,
        tools: [],
        configFields: {},
      },
    ],
    tools: [],
    configFields: {},
    config: {},
    phase: "not_composed",
    mods: [],
    hookLatency: [{ event: "tool.check", medianMs: 5, worstMs: 9, samples: 1 }],
    hookActivity: { decisions: 1, failures: 3, recent: [] },
  } as never;

  it("says its state, versions, lists and counts in Bulgarian", () => {
    const text = pluginDetail(plugin, 120, bg);
    expect(text).toContain("вид: външен\n");
    expect(text).toContain("състояние: изключен, не е зареден в работещия сървър на Tavi\n");
    expect(text).toContain("файлове: /data/plugins/acme.guard/<версия>\nверсии:\n  0.1.0\tпредложен\t");
    expect(text).toContain("инсталиран 2026-11-03 16:25 UTC");
    expect(text).toContain("инструменти: няма\n");
    expect(text).toContain("настройки: няма\n");
    expect(text).toContain("tool.check: медиана 5 мс, най-лошо 9 мс при последното извикване");
    expect(text).toContain("дейност на куките: 1 решение, 3 грешки");
    expect(text).not.toMatch(/\bstate:|\bversions:|\bnone\b/);
  });

  it("prints English as it always did", () => {
    const text = pluginDetail(plugin, 120);
    expect(text).toContain("state: disabled, not loaded in the running owner\n");
    expect(text).toContain("tool.check: median 5 ms, worst 9 ms over its last call");
    expect(text).toContain("hook activity: 1 decision, 3 failures");
  });
});

describe("tavi schedules in a Bulgarian workspace", () => {
  it("shows, lists and removes a schedule in Bulgarian; --format json stays as it was", async () => {
    const directory = dirs.create("tavi-schedules-bg-");
    const run = async (argv: readonly string[]) => {
      const out = capture();
      const code = await main([...argv, "--data-dir", directory], { io: out.io });
      return { code, stdout: out.stdout(), stderr: out.stderr() };
    };
    expect((await run(["config", "set", "workspace.locale", "bg"])).code).toBe(EXIT.ok);
    const added = await run(["schedules", "add", "--name", "сутрин", "--at", "07:00", "--timezone", "Europe/Sofia", "--prompt", "go"]);
    expect(added.code).toBe(EXIT.ok);
    expect(added.stdout).toContain("\tвключен\tследващо: ");
    expect(added.stderr).toContain("бележка: „сутрин“ няма къде да праща сигнали");

    const shown = await run(["schedules", "show", "сутрин"]);
    expect(shown.code).toBe(EXIT.ok);
    expect(shown.stdout).toMatch(/^график \S+ \(сутрин\)$/m);
    expect(shown.stdout).toMatch(/^ {2}състояние {6}включен$/m);
    expect(shown.stdout).toMatch(/^ {2}последно {7}никога$/m);
    expect(shown.stdout).toContain("30 минути работа (по подразбиране), после спира");
    expect(shown.stdout).toContain("  разрешено без надзор:\n    (нищо: всяко извикване, което иска разрешение, се отказва)");
    // The history is listed in the workspace's zone, the host's here: UTC on CI.
    expect(shown.stdout).toMatch(/^ {2}последни пускания \([^)]+\):\n {4}\(няма записани\)$/m);
    expect(shown.stdout).not.toMatch(/next fire|never|run limit/);

    const listed = await run(["schedules", "list"]);
    expect(listed.stdout).toContain("\tвключен\tследващо: ");
    expect(listed.stdout).toContain("\tнеуспехи: 0\tпоследно: никога\n");

    const json = await run(["schedules", "list", "--format", "json"]);
    expect(JSON.parse(json.stdout)[0]).toMatchObject({ name: "сутрин", enabled: true });

    const removed = await run(["schedules", "remove", "сутрин"]);
    expect(removed.stdout).toMatch(/^премахнат: \S+\n$/);
  });
});
