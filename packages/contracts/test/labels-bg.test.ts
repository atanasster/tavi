import { describe, expect, it } from "vitest";

import { approvalChannelLabel } from "../src/approval-inbox.js";
import { turnStoppedMessage } from "../src/errors.js";
import { managedFolderLabel } from "../src/folder-ipc.js";
import { createTranslator } from "../src/i18n.js";
import { IDEA_CAPABILITIES, IDEA_CATEGORIES, describeIdeasDeclaration, ideaCapabilityLabel, ideaCategoryLabel } from "../src/ideas.js";
import { CORE_BG } from "../src/locales/core-bg.js";
import { CORE_EN } from "../src/locales/core-en.js";
import { toolCallTitle } from "../src/tool-headline.js";
import { STALE_WEB_PATTERN_MESSAGE, staleWebPatternMessage, toolGroupLabel } from "../src/tool-policy.js";

const bg = createTranslator({ en: CORE_EN, bg: CORE_BG }, "bg");

describe("the labels part in Bulgarian", () => {
  it("titles a call with its verb, and keeps a tool id with no verb as it is", () => {
    expect(toolCallTitle("fs.write", "notes.txt", bg)).toBe("Запис в notes.txt");
    expect(toolCallTitle("web_search", "влакове", bg)).toBe("Търсене в мрежата за влакове");
    expect(toolCallTitle("agents.list", "a1", bg)).toBe("agents.list a1");
    expect(toolCallTitle("fs.write", undefined, bg)).toBe("fs.write");
    // A headline is filled once: braces in it are not read as a parameter.
    expect(toolCallTitle("fs.read", "{subject}.txt", bg)).toBe("Четене на {subject}.txt");
  });

  it("names every idea section and capability", () => {
    expect(ideaCategoryLabel("travel", bg)).toBe("Пътувания и задачи");
    expect(ideaCapabilityLabel("home", bg)).toBe("Умен дом");
    for (const category of IDEA_CATEGORIES) expect(ideaCategoryLabel(category, bg)).not.toBe(ideaCategoryLabel(category));
    for (const capability of IDEA_CAPABILITIES) expect(ideaCapabilityLabel(capability, bg)).not.toBe(ideaCapabilityLabel(capability));
  });

  it("describes an ideas provider in whole sentences", () => {
    expect(describeIdeasDeclaration({ abi: "tavi.ideas/1", receives: [], usesTurns: true, disclosure: "Hi." }, bg)).toBe(
      "Доставчик на идеи: не получава нищо твое, а само знае какво може Tavi тук. Само предлага идеи; Tavi проверява всяка и никога не му позволява да изпраща или изпълнява нещо. Може да пита бързия ти модел в рамките на дневния бюджет за идеи. Той казва: Hi.",
    );
    expect(describeIdeasDeclaration({ abi: "tavi.ideas/1", receives: ["brief", "ledger"] }, bg)).toContain(
      "насоките за идеи, които пишеш (докато това е включено); кои идеи отхвърляш",
    );
  });

  it("names approval channels and tool groups", () => {
    expect(approvalChannelLabel("cli", undefined, bg)).toBe("терминала");
    expect(approvalChannelLabel("bridge", undefined, bg)).toBe("уеб интерфейса");
    expect(approvalChannelLabel("telegram-main", () => "Telegram", bg)).toBe("Telegram");
    expect(toolGroupLabel("browser.*", [], bg)).toBe("браузъра");
    expect(toolGroupLabel("browser.*", ["example.com", "example.com", "docs.example"], bg)).toBe("браузъра за example.com, docs.example");
    expect(toolGroupLabel("stripe.*", [], bg)).toBe("инструментите stripe.*");
  });

  it("says the shared one-line labels, and keeps the English constants English", () => {
    expect(turnStoppedMessage(bg)).toBe("Спря това.");
    expect(managedFolderLabel(bg)).toBe("Файлове на чата");
    expect(staleWebPatternMessage(bg)).toContain("„web.“");
    expect(STALE_WEB_PATTERN_MESSAGE).toBe('dotted "web." patterns match no tool: use web_search, web_fetch, or web_* for both');
  });
});
