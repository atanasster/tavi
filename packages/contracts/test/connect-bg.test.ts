import { describe, expect, it } from "vitest";

import {
  channelDisclosure,
  channelDisclosureOf,
  connectNeedText,
  describeHeartbeatDeclaration,
  describeHeartbeatSignalsDeclaration,
  describeMemoryDeclaration,
  describeOnboardingDeclaration,
  describePluginApps,
  describePluginTool,
  modHookReadsLine,
  describePluginUiContribution,
  describeRouterDeclaration,
  heartbeatHookDecisionText,
  heartbeatTickContext,
  lifecycleWarningText,
  MODEL_PROVIDER_PRESETS,
  memoryPendingProvidersNote,
  memoryTaughtPendingProvidersNote,
  pastChatSearchCitations,
  pastChatSearchSummary,
  pluginSignalSourceLabel,
  presetNote,
  triggerInWords,
  videoDisclosure,
} from "../src/index.js";
import { createTranslator } from "../src/i18n.js";
import { CORE_BG } from "../src/locales/core-bg.js";
import { CORE_EN } from "../src/locales/core-en.js";

const bg = createTranslator({ en: CORE_EN, bg: CORE_BG }, "bg");

/** The apps, channels, models, plugins and heartbeat words in Bulgarian; English is pinned by each module's own tests. */
describe("connect words in Bulgarian", () => {
  it("asks for a sign-in over a channel", () => {
    expect(connectNeedText({ appName: "Gmail" }, bg)).toBe(
      "Gmail иска да влезеш отново. Отвори Tavi на компютъра си → Свързани приложения.",
    );
    expect(connectNeedText({ appName: "Gmail", health: "not-set-up" }, bg)).toBe(
      "В Gmail още няма вход. Отвори Tavi на компютъра си → Свързани приложения.",
    );
  });

  it("says a room's trigger with „или“ before the last", () => {
    expect(triggerInWords(["mention", "reply", "command"], bg)).toBe(
      "при споменаване, при отговор на мое съобщение или при използване на моя команда",
    );
    expect(triggerInWords(["mention"], bg)).toBe("при споменаване");
  });

  it("says each lifecycle warning as a clause", () => {
    expect(lifecycleWarningText({ level: "error", code: "retired", date: "2026-11-19", days: -1 }, bg)).toBe("е спрян на 2026-11-19");
    expect(
      lifecycleWarningText({ level: "warning", code: "redirects_soon", to: "b", via: "router", date: "2026-12-01", days: 9 }, bg),
    ).toBe("ще отговаря и ще се таксува като b (през router) от 2026-12-01");
    expect(lifecycleWarningText({ level: "info", code: "end_claimed", date: "2026-11-01", days: -3 }, bg)).toBe(
      "може да е спрян на 2026-11-01 (доставчикът не го е потвърдил)",
    );
  });

  it("says a preset's note and the video disclosure", () => {
    const ollama = MODEL_PROVIDER_PRESETS.find((preset) => preset.id === "ollama");
    expect(ollama === undefined ? undefined : presetNote(ollama)).toBe(ollama?.note);
    expect(ollama === undefined ? undefined : presetNote(ollama, bg)).toMatch(/^Работи на този компютър/);
    expect(presetNote({ id: "openai" }, bg)).toBeUndefined();
    expect(videoDisclosure("OpenRouter", "qwen/qwen3-vl", bg)).toContain("на OpenRouter за qwen/qwen3-vl");
  });

  it("counts a past-chat search and names an untitled chat", () => {
    expect(pastChatSearchSummary(1, bg)).toBe("Потърсих в по-ранните чатове · намерен 1");
    expect(pastChatSearchSummary(3, bg)).toBe("Потърсих в по-ранните чатове · намерени 3");
    expect(pastChatSearchSummary(1200)).toBe("Searched earlier chats · 1200 found");
    expect(pastChatSearchCitations({ found: 1, matches: [{ taskId: "t1", title: " " }] }, bg)?.chats).toEqual([
      { taskId: "t1", title: "Чат без заглавие" },
    ]);
  });

  it("says what a plugin's canvas parts, tools and router receive", () => {
    expect(channelDisclosure(["browser.live"], undefined, bg)).toBe("Получава browser.live.");
    expect(channelDisclosure(["browser.live", "browser.control"], "Вижда страниците.", bg)).toMatch(/^Вижда страниците\. Иска също/);
    expect(
      describePluginUiContribution({ id: "view", role: "browser-view", placements: [{ slot: "browser.view" }], channels: [] } as never, bg),
    ).toBe("view (роля browser-view) → browser.view; без канали");
    expect(describePluginTool({ id: "acme.weather.forecast", effect: "read-only", output: "trusted", attendedOnly: true }, bg)).toBe(
      "acme.weather.forecast (само за четене, резултат с доверие, човек решава за всяко извикване)",
    );
    expect(describePluginTool({ id: "acme.mail.send", effect: "external" }, bg)).toBe("acme.mail.send (излиза навън)");
    expect(describePluginTool({ id: "acme.notes.add", effect: "mutating" }, bg)).toBe("acme.notes.add (променя данни)");
    expect(describePluginTool({ id: "acme.odd", effect: "sideways" }, bg)).toBe("acme.odd (sideways)");
    expect(modHookReadsLine({ event: "tool.check", match: { tools: ["sandbox.run"] } }, bg)).toBe(
      "Вижда входа на `sandbox.run` и може да откаже извикването. Вижда това във всяко работно пространство.",
    );
    expect(modHookReadsLine({ event: "prompt.submit" }, bg)).toBe(
      "Чете всяка заявка и всяко съобщение, което получаваш, във всеки канал, и може да добави към него или да го изпусне. Вижда това във всяко работно пространство.",
    );
    expect(
      describeRouterDeclaration(
        {
          abi: "tavi.router/1",
          features: ["model", "tools"],
          batch: true,
          pricing: { connectionId: "plugin:acme.router", model: "r" },
        } as never,
        bg,
      ),
    ).toBe(
      "Доставчик за маршрутизиране: получава текста на задачата и описанията на инструментите, когато изходящият трафик към маршрутизатора е разрешен; може да избира между основния и бързия модел. Извикванията са на пакети, на цена като plugin:acme.router / r. Настройките и данните за достъп са общи за всяко работно пространство, което го избере.",
    );
  });

  it("says a channel plugin's disclosure sentence by sentence", () => {
    const disclosed = channelDisclosureOf(
      {
        providerId: "parrot",
        label: "Parrot",
        kind: "messaging",
        auth: { kind: "none" },
        retention: "purge-on-remove",
        app: { mailbox: true },
      } as never,
      bg,
    );
    expect(disclosed.disclosure).toBe(
      "Получава съобщения отвън и може да праща от твое име в Parrot. Премахването на някоя от връзките му изтрива каквото е донесла след 24 часа. Профилите му са пощенски кутии, в които агентът може да търси, да чете и от които да праща, всяка едва след като я включиш",
    );
  });

  it("quotes an app's own words in Bulgarian quotes", () => {
    const lines = describePluginApps(
      { abi: "tavi.apps/1", apps: [{ id: "acme", name: "Acme", category: "work", summary: "", scopes: [], tools: {} }] } as never,
      bg,
    );
    expect(lines).toEqual(["Приложение acme (work), по думите на автора му: име „Acme“"]);
  });

  it("escapes the quote marks an author's text could close the quote with", () => {
    const [line] = describePluginApps(
      {
        abi: "tavi.apps/1",
        apps: [
          {
            id: "acme",
            name: "Acme",
            category: "work",
            summary: "Calendar\u201c; scope calendar.read (read) \u201eonly reads your calendar \u201a\u2018",
            scopes: [],
            tools: {},
          },
        ],
      } as never,
      bg,
    );
    expect(line).toBe(
      "Приложение acme (work), по думите на автора му: име „Acme“; описание „Calendar\\u201c; scope calendar.read (read) \\u201eonly reads your calendar \\u201a\\u2018“",
    );
    expect(line?.match(/[„“]/g)).toEqual(["„", "“", "„", "“"]);
  });

  it("says what an onboarding flow, a memory provider and a heartbeat provider receive", () => {
    expect(describeOnboardingDeclaration({ abi: "tavi.onboarding/1" } as never, bg)).toMatch(
      /^Поток за първи стъпки: .*\(никога подробностите им\)/,
    );
    expect(describeMemoryDeclaration({ capabilities: ["recall"], receives: ["records", "conversation"] } as never, bg)).toMatch(
      /^Доставчик на памет: подрежда какво припомня паметта\. Може да получава одобрените ти спомени .*; и какво казваш/,
    );
    expect(describeHeartbeatDeclaration({ receives: [], usesTurns: false, maxTickSeconds: 30 } as never, bg)).toContain(
      "никакви данни от пулса освен часа на всяка проверка",
    );
    expect(describeHeartbeatDeclaration({ receives: [], usesTurns: false, maxTickSeconds: 30 } as never, bg)).toContain("30 сек.");
    expect(describeHeartbeatSignalsDeclaration({ sources: ["queue"], offers: { queue: "Заседнали задачи" } } as never, bg)).toContain(
      "може да предложи: „Заседнали задачи“.",
    );
    expect(pluginSignalSourceLabel("Feeds", "new_posts", { sources: ["new_posts"] } as never, bg)).toBe("New posts от Feeds");
  });

  it("says a heartbeat log row's context and a mod's decision", () => {
    expect(heartbeatTickContext({ kind: "deep", wakeReason: "manual", inputs: { memory: [1, 2] } }, bg)).toEqual([
      "ти поиска",
      "използва 2 спомена",
    ]);
    expect(heartbeatTickContext({ kind: "deep", wakeReason: "signal", inputs: { memory: [1] } }, bg)).toEqual([
      "събуден от сигнал",
      "използва 1 спомен",
    ]);
    expect(heartbeatHookDecisionText({ key: "k", by: "acme.guard", action: "held back", reason: "Не днес" }, bg)).toBe(
      "acme.guard задържа (Не днес)",
    );
    expect(heartbeatHookDecisionText({ key: "k", by: "acme.guard", action: "made it wait for the summary" })).toBe(
      "acme.guard made it wait for the summary",
    );
  });

  it("names the memory providers a forget waits for", () => {
    expect(memoryPendingProvidersNote(["mem0"], bg)).toBe("mem0 ще го премахне при следващото си пускане.");
    expect(memoryPendingProvidersNote(["a", "b"], bg)).toBe("a, b ще го премахнат, всеки при следващото си пускане.");
    expect(memoryTaughtPendingProvidersNote(["mem0"])).toBe("What it taught will be removed from mem0 when it next runs.");
    expect(memoryPendingProvidersNote([], bg)).toBeUndefined();
  });
});
