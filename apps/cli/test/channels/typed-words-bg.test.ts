import { HEARTBEAT_PRODUCTION_OPTIONS, defaultHeartbeatConfig, ideaCategoryLabel, type IdeaDraft, type ModEnvelope } from "@tavi/contracts";
import { SUPPORTED_LOCALES } from "@tavi/contracts/i18n";
import { coreEnglish } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { afterEach, describe, expect, it } from "vitest";

import {
  SCOPES,
  TYPED_SCOPES,
  TYPED_VERBS,
  approvalWords,
  parseApprovalCommand,
  renderRoundText,
} from "../../src/features/approvals/channel-approval-text.js";
import {
  HEARTBEAT_WORDS,
  IDEAS_WORDS,
  MEMORY_WORDS,
  joinedAmounts,
  otherLanguageDuration,
  typedWord,
  typedWords,
} from "../../src/features/channels/typed-words.js";
import { heartbeatSlashCommand } from "../../src/features/heartbeat/slash.js";
import { parseHeartbeatDuration } from "../../src/features/heartbeat/parse.js";
import { ideasSlashCommand } from "../../src/features/ideas/slash.js";
import { SqliteStore } from "../support/database-fixture.js";

/**
 * What a person types is taken in every language Tavi speaks (I18N-PLAN Tier 3
 * step 5): approval verbs and scopes, the slash commands' sub-words and their
 * durations, in Bulgarian as in English, whatever the workspace's language;
 * help lists the workspace language's words, and English reads as before.
 */

const bg = coreIn("bg");
const AT = "2026-10-11T09:00:00.000Z";

const stores: SqliteStore[] = [];
afterEach(async () => {
  while (stores.length > 0) await stores.pop()?.close();
});

async function repositoriesIn(locale: "en" | "bg") {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  const repositories = store.asPort().repositories;
  if (locale === "bg")
    await repositories.workspaceSettings.set({
      workspaceId: "default",
      settings: { locale: "bg", timezone: "Europe/Sofia" },
      expectedRevision: (await repositories.workspaceSettings.get("default")).revision,
      actor: "operator",
      now: AT,
    });
  return repositories;
}

describe("a typed approval", () => {
  it("parses English exactly as before", () => {
    const table: readonly [string, ReturnType<typeof parseApprovalCommand>][] = [
      ["approve", { approved: true }],
      ["Approve", { approved: true }],
      ["allow k3f9abcd session", { approved: true, target: "k3f9abcd", scope: "session" }],
      ["approve always", { approved: true, scope: "always" }],
      ["approve task-1 once", { approved: true, target: "task-1", scope: "once" }],
      ["reject", { approved: false }],
      ["deny k3f9abcd too risky", { approved: false, target: "k3f9abcd", note: "too risky" }],
      ["reject not now", { approved: false, target: "not", note: "now" }],
      ["approve this plan please", null],
      ["approve k3f9abcd session extra", null],
      ["approved", null],
      ["hello", null],
      ["", null],
    ];
    for (const [text, parsed] of table) expect(parseApprovalCommand(text), text).toEqual(parsed);
  });

  it("parses Bulgarian verbs and scopes, with the forms a person types, case aside", () => {
    const table: readonly [string, ReturnType<typeof parseApprovalCommand>][] = [
      ["одобри", { approved: true }],
      ["Одобри", { approved: true }],
      ["ОДОБРЯВАМ", { approved: true }],
      ["разреши", { approved: true }],
      ["Разрешавам k3f9abcd", { approved: true, target: "k3f9abcd" }],
      ["одобри k3f9abcd веднъж", { approved: true, target: "k3f9abcd", scope: "once" }],
      ["одобри k3f9abcd чат", { approved: true, target: "k3f9abcd", scope: "session" }],
      ["одобри сесия", { approved: true, scope: "session" }],
      ["одобри Сесията", { approved: true, scope: "session" }],
      ["разреши task-1 винаги", { approved: true, target: "task-1", scope: "always" }],
      ["откажи", { approved: false }],
      ["Отхвърли k3f9abcd твърде рисково", { approved: false, target: "k3f9abcd", note: "твърде рисково" }],
      ["отказвам не сега", { approved: false, note: "не сега" }],
      ["одобрявам идеята ти", null],
      ["одобри k3f9abcd винаги моля", null],
      ["одобрение", null],
      // Look-alikes of an approval: a participle, a perfective form, a question, a negation, a verb in a sentence.
      ["Одобрено", null],
      ["разрешено", null],
      ["одобря", null],
      ["разреша", null],
      ["одобрено ли е?", null],
      ["не одобрявам", null],
      ["разреши ми да пиша", null],
      ["разрешавам си почивка", null],
      // A Latin "o", and a zero-width space after the verb.
      ["oдобри", null],
      ["одобри\u200b", null],
      // Look-alikes of a rejection: giving up, a noun, participles, other forms.
      ["Откажи се, няма смисъл", null],
      ["Отказвам се да чакам", null],
      ["откажи СЕ", null],
      ["Отказ от отговорност", null],
      ["Отказано", null],
      ["отхвърлено", null],
      ["откажа", null],
      ["отхвърля", null],
    ];
    for (const [text, parsed] of table) expect(parseApprovalCommand(text), text).toEqual(parsed);
  });

  it("takes a mix of the two languages", () => {
    expect(parseApprovalCommand("одобри k3f9abcd always")).toEqual({ approved: true, target: "k3f9abcd", scope: "always" });
    expect(parseApprovalCommand("approve k3f9abcd винаги")).toEqual({ approved: true, target: "k3f9abcd", scope: "always" });
    expect(parseApprovalCommand("reject k3f9abcd твърде рисково")).toEqual({ approved: false, target: "k3f9abcd", note: "твърде рисково" });
    expect(parseApprovalCommand("откажи k3f9abcd too risky")).toEqual({ approved: false, target: "k3f9abcd", note: "too risky" });
  });

  it("takes every language's words as help names them", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const words = approvalWords(coreIn(locale));
      expect(parseApprovalCommand(`${words.approve} k3f9abcd ${words.once}`), locale).toMatchObject({ approved: true, scope: "once" });
      expect(parseApprovalCommand(`${words.approve} k3f9abcd ${words.session}`), locale).toMatchObject({ scope: "session" });
      expect(parseApprovalCommand(`${words.approve} k3f9abcd ${words.always}`), locale).toMatchObject({ scope: "always" });
      expect(parseApprovalCommand(`${words.reject} k3f9abcd`), locale).toEqual({ approved: false, target: "k3f9abcd" });
    }
    expect(approvalWords(bg)).toEqual({
      approve: "одобри",
      reject: "откажи",
      once: "веднъж",
      session: "чат",
      always: "винаги",
      reason: "<причина>",
    });
  });

  it("keeps approve, reject and scope words apart, every language's catalogue words among them", () => {
    const lists = [TYPED_VERBS.approve, TYPED_VERBS.reject, ...SCOPES.map((scope) => TYPED_SCOPES[scope])];
    for (const [index, list] of lists.entries())
      for (const other of lists.slice(index + 1)) expect(list.filter((word) => other.includes(word))).toEqual([]);
    for (const locale of SUPPORTED_LOCALES) {
      const words = approvalWords(coreIn(locale));
      expect(TYPED_VERBS.approve).toContain(words.approve.toLowerCase());
      expect(TYPED_VERBS.reject).toContain(words.reject.toLowerCase());
      for (const scope of SCOPES) expect(TYPED_SCOPES[scope]).toContain(words[scope].toLowerCase());
    }
    // Only the English words could be read as a round token or a task id.
    const english = new Set(["approve", "allow", "reject", "deny", ...SCOPES]);
    for (const word of lists.flat()) if (!english.has(word)) expect(word, word).not.toMatch(/^[A-Za-z0-9._-]{1,128}$/u);
  });

  it("is named in Bulgarian in a Bulgarian round's help, in English in an English one", () => {
    const invocation = { workspaceId: "w", principalId: "p", runId: "t", caller: "c" };
    const round = {
      taskId: "t",
      steps: 1,
      invocation,
      requests: [{ callId: "a", toolName: "files.write", summary: "s", input: {}, allowedScopes: ["once", "session", "always"] as const }],
    };
    const bulgarian = renderRoundText(round, "abcdefgh", undefined, { t: bg });
    expect(bulgarian).toContain("одобри abcdefgh");
    expect(bulgarian).toContain("откажи abcdefgh <причина>");
    expect(bulgarian).not.toMatch(/\b(approve|reject)\b/u);
    expect(renderRoundText(round, "abcdefgh", undefined)).toBe(renderRoundText(round, "abcdefgh", undefined, { t: coreEnglish }));
    expect(renderRoundText(round, "abcdefgh", undefined)).toContain("approve abcdefgh");
  });
});

describe("a slash command's sub-words", () => {
  it("map Bulgarian onto English, English exactly as before", () => {
    expect(typedWords(["запази", "всички"], MEMORY_WORDS)).toEqual(["keep", "all"]);
    expect(typedWords(["Запази", "2", "3"], MEMORY_WORDS)).toEqual(["keep", "2", "3"]);
    expect(typedWords(["keep", "всички"], MEMORY_WORDS)).toEqual(["keep", "all"]);
    const memory: readonly [string, string | undefined][] = [
      ["състояние", "status"],
      ["преглед", "review"],
      ["отхвърли", "discard"],
      ["изключи", "off"],
      ["включи", "on"],
      ["пауза", "pause"],
      ["продължи", "resume"],
      ["keep", "keep"],
      ["Keep", undefined],
      ["запазено", undefined],
    ];
    for (const [typed, word] of memory) expect(typedWord(typed, MEMORY_WORDS), typed).toBe(word);
    const heartbeat: readonly [string, string | undefined][] = [
      ["пауза", "pause"],
      ["спри", "pause"],
      ["продължи", "resume"],
      ["пусни", "resume"],
      ["сега", "now"],
      ["Състояние", "status"],
      ["now", "now"],
      ["every", undefined],
    ];
    for (const [typed, word] of heartbeat) expect(typedWord(typed, HEARTBEAT_WORDS), typed).toBe(word);
    expect(typedWord("обнови", IDEAS_WORDS)).toBe("refresh");
    expect(typedWord("refresh", IDEAS_WORDS)).toBe("refresh");
  });

  it("read Bulgarian durations, English left to its own parser", () => {
    const durations: readonly [string, number | undefined][] = [
      ["2ч", 7_200_000],
      ["2Ч", 7_200_000],
      ["30мин", 1_800_000],
      ["30м", 1_800_000],
      ["1д", 86_400_000],
      ["2дни", 172_800_000],
      ["45с", 45_000],
      ["2 часа", 7_200_000],
      ["0ч", undefined],
      ["2h", undefined],
      ["ч", undefined],
      ["2седмици", undefined],
    ];
    for (const [typed, ms] of durations) expect(otherLanguageDuration(typed), typed).toBe(ms);
    expect(parseHeartbeatDuration("2h")).toBe(7_200_000);
    expect(parseHeartbeatDuration("2ч")).toBeUndefined();
    expect(joinedAmounts(["пауза", "2", "часа"])).toEqual(["пауза", "2часа"]);
    expect(joinedAmounts(["pause", "2", "h"])).toEqual(["pause", "2", "h"]);
  });
});

describe("/heartbeat typed in Bulgarian", () => {
  async function command(locale: "en" | "bg") {
    const repositories = await repositoriesIn(locale);
    const run = heartbeatSlashCommand({
      repositories,
      principalOf: () => "operator",
      options: HEARTBEAT_PRODUCTION_OPTIONS,
      providers: () => [],
      host: () => ({ checkNow: async () => ({ status: "started" as const }) }),
      author: "command",
      now: () => new Date(AT),
    });
    const envelope: ModEnvelope = {
      workspaceId: "default",
      principalId: "operator",
      taskId: "t",
      runId: "t",
      source: "messaging",
      attended: true,
    };
    await repositories.heartbeats.save({
      workspaceId: "default",
      principalId: "operator",
      config: { ...defaultHeartbeatConfig(), enabled: true },
      expectedRevision: 0,
      author: "test",
      now: AT,
      nextTickAt: "2026-10-11T09:30:00.000Z",
    });
    return async (args: string) => (await run({ envelope, args, signal: new AbortController().signal })).text ?? "";
  }

  it("pauses, resumes, checks and says its status in a Bulgarian workspace, English words still taken", async () => {
    const run = await command("bg");
    expect(await run("пауза 2ч")).toMatch(/^Пулсът е на пауза от теб до \d\d:\d\d/u);
    expect(await run("продължи")).toMatch(/^Пулсът е включен/u);
    expect(await run("Пауза 2 часа")).toMatch(/^Пулсът е на пауза от теб до \d\d:\d\d/u);
    expect(await run("продължи")).toMatch(/^Пулсът е включен/u);
    expect(await run("pause 30m")).toMatch(/^Пулсът е на пауза от теб до \d\d:\d\d/u);
    expect(await run("resume")).toMatch(/^Пулсът е включен/u);
    expect(await run("състояние")).toMatch(/^Пулсът е включен/u);
    expect(await run("сега")).toBe("Проверявам сега.");
    expect(await run("пауза 8д")).toBe(bg("channel.heartbeat.pauseUsage"));
    expect(await run("пауза 2седмици")).toBe(bg("channel.heartbeat.pauseUsage"));
  });

  it("lists the Bulgarian words in a Bulgarian workspace's help, English as before", async () => {
    const usage = await (await command("bg"))("скачай");
    expect(usage).toMatch(/^Как се ползва: \/heartbeat \[състояние \| пауза \[30мин\|2ч\|1д\] \| продължи \| сега\]\./u);
    expect(bg("channel.heartbeat.pauseUsage")).toContain("30мин, 2ч или 1д (най-много 7д)");
    const english = await command("en");
    expect(await english("jump")).toBe(
      "Usage: /heartbeat [status | pause [30m|2h|1d] | resume | now]. Change its settings in Center → Heartbeat, with tavi heartbeat, or by asking.",
    );
    // An English workspace takes the Bulgarian words too.
    expect(await english("пауза 30мин")).toMatch(/^Heartbeat paused by you until \d\d:\d\d/u);
  });
});

describe("/ideas in Bulgarian", () => {
  const NOW = new Date("2026-10-19T10:00:00.000Z");
  const draft = (key: string): IdeaDraft => ({
    key,
    category: "travel",
    icon: "✈️",
    title: "Планирай пътуване",
    pitch: "Защо.",
    label: "Пробвай",
    prompt: "Помогни ми с пътуването.",
    basis: [{ kind: "general", ref: "general" }],
    uses: [{ capability: "web", approval: false }],
  });

  async function fixture(locale: "en" | "bg") {
    const repositories = await repositoriesIn(locale);
    let refreshed = 0;
    const run = ideasSlashCommand({
      repositories,
      principalOf: () => "operator",
      now: () => NOW,
      refresh: async () => (refreshed++, "started"),
    });
    const envelope: ModEnvelope = {
      workspaceId: "default",
      principalId: "operator",
      taskId: "t",
      runId: "r",
      source: "web",
      attended: true,
    };
    const say = async (args: string, principalId = "operator") =>
      (await run({ envelope: { ...envelope, principalId }, args, signal: new AbortController().signal })).text ?? "";
    return { repositories, say, refreshes: () => refreshed };
  }

  it("lists, refreshes and explains itself in Bulgarian", async () => {
    const { repositories, say, refreshes } = await fixture("bg");
    expect(await say("")).toBe("Още няма идеи. /ideas обнови търси нови.");
    expect(await say("обнови")).toBe("Търся нови идеи; /ideas ще ги покаже след малко.");
    expect(await say("refresh")).toBe("Търся нови идеи; /ideas ще ги покаже след малко.");
    expect(refreshes()).toBe(2);
    expect(await say("закачи 3")).toBe("Как се ползва: /ideas [обнови]. Насочвай ги в раздела „Идеи“ или с tavi ideas.");
    expect(await say("", "someone-else")).toBe("/ideas е само за собственика на работното пространство.");
    await repositories.ideas.startRun({ runId: "run-a", workspaceId: "default", trigger: "schedule", now: NOW.toISOString() });
    await repositories.ideas.store({
      workspaceId: "default",
      runId: "run-a",
      providerId: "tavi.ideasagent",
      now: NOW.toISOString(),
      ideas: [{ id: "travel.a", score: 0.9, draft: draft("travel.a") }],
    });
    expect((await say("")).split("\n")).toEqual([
      "Идеи за теб:",
      `1. Планирай пътуване (${ideaCategoryLabel("travel", bg)})`,
      "   Пробвай: Помогни ми с пътуването.",
      "Още в раздела „Идеи“.",
    ]);
    await repositories.ideas.saveSettings({ workspaceId: "default", patch: { enabled: false }, now: NOW.toISOString() });
    expect(await say("")).toBe("Идеите са изключени. Включи ги в Настройки → Идеи или с tavi ideas on.");
  });

  it("takes the Bulgarian word in an English workspace, and answers in English", async () => {
    const { say, refreshes } = await fixture("en");
    expect(await say("обнови")).toBe("Looking for new ideas; /ideas shows them in a moment.");
    expect(refreshes()).toBe(1);
    expect(await say("pin 3")).toBe("Usage: /ideas [refresh]. Steer them in the Ideas tab or with tavi ideas.");
  });
});
