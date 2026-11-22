import { describe, expect, it } from "vitest";

import { englishOf, IpcResponseSchema, keyedError, renderTextRef, TaviError, TaviErrorSchema, textRef } from "../src/index.js";
import { createTranslator } from "../src/i18n.js";
import { CORE_BG } from "../src/locales/core-bg.js";
import { CORE_EN } from "../src/locales/core-en.js";

const bg = createTranslator({ en: CORE_EN, bg: CORE_BG }, "bg");

/** Errors a person reads, by key: English exactly as before, Bulgarian in the canvas. */
describe("keyed errors", () => {
  it("keeps the owner's English messages byte for byte", () => {
    expect(keyedError("NOT_FOUND", "error.task.notFound", { taskId: "task-1" }).message).toBe("Task task-1 does not exist");
    expect(keyedError("UNAVAILABLE", "error.owner.shuttingDown").message).toBe("the owner is shutting down");
    expect(keyedError("NOT_FOUND", "error.plugin.noCommand", { name: "weather" }).message).toBe("no plugin adds /weather");
    expect(keyedError("CONFLICT", "error.task.homeNeverCancelled").message).toBe(
      "Home is never cancelled: stop its current turn instead, or erase its history with `tavi tasks history <id> forget --before <time>`",
    );
  });

  it("says the owner's errors in Bulgarian", () => {
    expect(renderTextRef(textRef("error.task.notFound", { taskId: "task-1" }), bg)).toBe("Чатът task-1 не съществува");
    expect(renderTextRef(textRef("error.owner.shuttingDown"), bg)).toBe("Сървърът на Tavi спира");
  });
});

describe("errors on the wire", () => {
  it("carries the key through toData and the IPC response", () => {
    const error = keyedError("NOT_FOUND", "error.task.notFound", { taskId: "task-1" });
    expect(error.toData()).toEqual({
      code: "NOT_FOUND",
      message: "Task task-1 does not exist",
      i18n: { key: "error.task.notFound", params: { taskId: "task-1" } },
    });
    expect(TaviErrorSchema.parse(error.toData()).i18n).toEqual({ key: "error.task.notFound", params: { taskId: "task-1" } });
    const frame = { type: "response", requestId: "r1", ok: false, error: { code: "NOT_FOUND", message: error.message, i18n: error.i18n } };
    expect(IpcResponseSchema.parse(frame).error?.i18n).toEqual({ key: "error.task.notFound", params: { taskId: "task-1" } });
  });

  it("parses an older error with no key, and keeps an unkeyed error's data as it was", () => {
    const older = { type: "response", requestId: "r1", ok: false, error: { code: "INTERNAL", message: "boom", details: { a: 1 } } };
    expect(IpcResponseSchema.parse(older).error).toEqual({ code: "INTERNAL", message: "boom", details: { a: 1 } });
    expect(new TaviError("INTERNAL", "boom").toData()).toEqual({ code: "INTERNAL", message: "boom" });
    expect(TaviErrorSchema.parse({ code: "INTERNAL", message: "boom" })).toEqual({ code: "INTERNAL", message: "boom" });
  });

  it("drops a key that breaks its bounds rather than the frame it rides on", () => {
    let deep: { key: string; params?: Record<string, unknown> } = { key: "error.task.notFound" };
    for (let depth = 0; depth < 12; depth += 1) deep = { key: "error.task.notFound", params: { taskId: deep } };
    const tooLong = { key: "error.task.notFound", params: { taskId: "x".repeat(5_000) } };
    for (const i18n of [deep, tooLong, { key: "" }, "error.task.notFound"]) {
      const parsed = IpcResponseSchema.parse({
        type: "response",
        requestId: "r1",
        ok: false,
        error: { code: "NOT_FOUND", message: "m", i18n },
      });
      expect(parsed.error).toEqual({ code: "NOT_FOUND", message: "m" });
      expect(TaviErrorSchema.parse({ code: "NOT_FOUND", message: "m", i18n })).toEqual({ code: "NOT_FOUND", message: "m" });
    }
  });

  it("falls back to the English message for a key this build does not know", () => {
    expect(renderTextRef({ key: "error.from.a.newer.owner" }, bg)).toBeUndefined();
  });
});

/** Channel errors by key: the English the terminal always read, Bulgarian in the canvas. */
describe("channel errors", () => {
  it("keeps the English byte for byte", () => {
    expect(keyedError("NOT_FOUND", "error.channels.noConnection").message).toBe("No such connection in this workspace");
    expect(keyedError("NOT_FOUND", "error.channels.notInstalled", { providerId: "telegram" }).message).toBe(
      "No channel telegram is installed",
    );
    expect(
      keyedError("INVALID_INPUT", "error.channels.enterBeforeEnabling", { fields: "Bot token and Chat id", channel: "Telegram" }).message,
    ).toBe("Enter Bot token and Chat id before enabling Telegram.");
    expect(keyedError("NOT_FOUND", "error.channels.notARoom", { scopeId: "-100", connectionId: "tg-1" }).message).toBe(
      "-100 is not a room of tg-1: `tavi channels rooms tg-1` lists them",
    );
    expect(keyedError("NOT_CONFIGURED", "error.channels.notListeningWhy", { channel: "Telegram", why: "401 Unauthorized" }).message).toBe(
      "Telegram isn't running: 401 Unauthorized. Fix it in Settings → Channels (or `tavi channels list`) first: a code sent to it could not arrive.",
    );
    expect(
      keyedError("INVALID_INPUT", "error.channels.fieldChoice", { channel: "Email", field: "Mode", choices: "imap, pop" }).message,
    ).toBe("Email's Mode must be one of imap, pop");
    expect(keyedError("UNAVAILABLE", "error.channels.roomNotOpen.add", { connectionId: "tg-1" }).message).toBe(
      "Connection tg-1 is not open: start it to add a room",
    );
    expect(keyedError("INVALID_INPUT", "error.channels.triggerNone", { channel: "Discord", unreported: "reply" }).message).toBe(
      "Discord does not report reply; its rooms can be triggered by nothing",
    );
    expect(keyedError("CONFLICT", "error.channels.codeNotSent").message).toBe("No one has sent this pairing's code yet.");
    expect(keyedError("NOT_FOUND", "error.channels.grantNotOfConnection", { connectionId: "tg-1" }).message).toBe(
      "That grant is not a grant of tg-1",
    );
  });

  it("says them in Bulgarian, with names left as they are", () => {
    expect(renderTextRef(textRef("error.channels.noConnection"), bg)).toBe("В това работно пространство няма такава връзка");
    expect(renderTextRef(textRef("error.channels.notInstalled", { providerId: "telegram" }), bg)).toBe("Няма инсталиран канал telegram");
    expect(renderTextRef(textRef("error.channels.enterField", { field: "Bot token", channel: "Telegram" }), bg)).toBe(
      "Въведи Bot token за Telegram.",
    );
    expect(renderTextRef(textRef("error.channels.roomNotOpen.add", { connectionId: "tg-1" }), bg)).toBe(
      "Връзката tg-1 не е отворена: пусни я, за да добавиш стая",
    );
    expect(renderTextRef(textRef("error.channels.senderElsewhere"), bg)).toBe("Този подател е от друго работно пространство.");
  });
});

/** Folders, video and audio, tool rules and answers: English as the owner always said it, Bulgarian in the canvas. */
describe("folder, media, permission and approval errors", () => {
  it("keeps the English byte for byte", () => {
    expect(keyedError("NOT_FOUND", "error.folders.noLongerOffered").message).toBe(
      "That folder is no longer offered here: browse the folders again",
    );
    expect(keyedError("CONFLICT", "error.folders.overlapsAttached", { path: "/home/a/code", label: "code" }).message).toBe(
      '/home/a/code overlaps the attached folder "code"; detach it first',
    );
    expect(keyedError("INVALID_INPUT", "error.folders.attachLimitOne", { max: "8", count: "8" }).message).toBe(
      "A chat attaches at most 8 folders; this one has 8: detach one first",
    );
    expect(keyedError("INVALID_INPUT", "error.folders.attachLimit", { max: "8", count: "10", over: "3" }).message).toBe(
      "A chat attaches at most 8 folders; this one has 10: detach 3 first",
    );
    expect(
      keyedError("UNAVAILABLE", "error.folders.unavailable", {
        what: textRef("error.folders.what.attached", { label: "site" }),
        path: "/home/a/site",
        why: textRef("error.folders.why.gone"),
        command: "/folder reset",
      }).message,
    ).toBe(
      "This chat's attached folder \"site\" /home/a/site no longer exists. Run /folder reset to go back to the chat's own folder, or choose another.",
    );
    expect(
      keyedError("NOT_AUTHORIZED", "error.folders.protected", {
        path: "/home/a/.ssh",
        why: textRef("error.folders.why.credentialDirectory"),
        never: textRef("error.folders.never.folder"),
      }).message,
    ).toBe("/home/a/.ssh is a credential directory; a chat never uses it as its folder");
    expect(keyedError("UNSUPPORTED", "error.folders.overDownloadLimit", { path: "big.iso", size: "50" }).message).toBe(
      "big.iso is over the 50 MiB download limit",
    );
    expect(keyedError("INVALID_INPUT", "error.video.tooManyPixels", { side: "4096" }).message).toBe(
      "the video's frames are larger than 4096×4096 pixels",
    );
    expect(keyedError("NOT_AUTHORIZED", "error.video.notApproved", { artifactId: "art-1", state: "pending" }).message).toBe(
      "artifact art-1 is pending, not approved for release",
    );
    expect(keyedError("INVALID_INPUT", "error.permissions.ruleShipped", { ruleId: "r1" }).message).toBe(
      "rule r1 is shipped with tavi; override it with a deny or ask rule",
    );
    expect(keyedError("CONFLICT", "error.approvals.questionClosed").message).toBe("This question was already answered, or has closed.");
  });

  it("says them in Bulgarian", () => {
    expect(renderTextRef(textRef("error.folders.overlapsAttached", { path: "/home/a/code", label: "code" }), bg)).toBe(
      "/home/a/code се застъпва с прикачената папка „code“. Първо я откачи",
    );
    expect(
      renderTextRef(
        textRef("error.folders.unavailable", {
          what: textRef("error.folders.what.primary"),
          path: "/home/a/site",
          why: textRef("error.folders.why.notAllowed"),
          command: "/folder reset",
        }),
        bg,
      ),
    ).toBe(
      "Този чат не може да използва основната си папка /home/a/site: тя вече не е разрешена. Изпълни /folder reset, за да се върнеш към собствената папка на чата, или избери друга.",
    );
    expect(renderTextRef(textRef("error.video.tooLarge", { size: "2048" }), bg)).toBe("Видеото е по-голямо от 2048 МБ");
    expect(renderTextRef(textRef("error.audio.noSound"), bg)).toBe("Файлът няма звук");
    expect(renderTextRef(textRef("error.permissions.noRule", { ruleId: "r1", workspaceId: "default" }), bg)).toBe(
      "В работното пространство default няма правило r1",
    );
    expect(renderTextRef(textRef("error.approvals.questionClosed"), bg)).toBe("На този въпрос вече е отговорено или е затворен.");
  });
});

/** Memory, reminders, ideas, the heartbeat and schedules: English as before, Bulgarian in the canvas. */
describe("keyed memory, reminder, idea, heartbeat and schedule errors", () => {
  it("keeps their English byte for byte", () => {
    expect(keyedError("NOT_FOUND", "error.workspace.notConfigured", { workspaceId: "w1" }).message).toBe(
      "workspace w1 is not configured on this owner",
    );
    expect(keyedError("REVISION_CONFLICT", "error.memory.recordChanged").message).toBe("The record changed since it was read");
    expect(keyedError("NOT_FOUND", "error.memory.noTurn", { taskId: "t1", seq: String(3) }).message).toBe("Chat t1 has no turn 3");
    expect(
      keyedError("CONFLICT", "error.memory.notWaitingUpdate", { recordId: "r1", status: textRef("error.memory.status.approved") }).message,
    ).toBe("Memory record r1 is approved; only a waiting update is replaced");
    expect(keyedError("NOT_FOUND", "error.reminder.notFound", { reminderId: "rem-1" }).message).toBe("Reminder rem-1 does not exist");
    expect(keyedError("CONFLICT", "error.idea.wrongStatus", { ideaId: "i1", status: textRef("error.idea.status.dismissed") }).message).toBe(
      "Idea i1 is dismissed",
    );
    expect(keyedError("CONFLICT", "error.heartbeat.revisionConflict", { expected: "2", current: "3" }).message).toBe(
      "The heartbeat changed since revision 2 (it is at 3); read it again and retry",
    );
    expect(keyedError("INVALID_INPUT", "error.heartbeat.tokenLimitTooLow", { min: 80_000 }).message).toBe(
      "The daily token limit must be at least 80,000: each check reserves its worst case before it runs",
    );
    expect(keyedError("INVALID_INPUT", "error.heartbeat.providerNotInstalled", { providerId: "x", installed: "a, b" }).message).toBe(
      "No heartbeat provider x is installed here (a, b, or off)",
    );
    expect(
      keyedError("NOT_FOUND", "error.schedule.notFoundIn", { scheduleId: JSON.stringify("brief"), workspaceId: "default" }).message,
    ).toBe('no schedule "brief" exists in workspace default');
    expect(keyedError("INVALID_INPUT", "error.schedule.nameFixed").message).toBe(
      "Schedule names cannot be changed; create a new schedule instead.",
    );
    expect(keyedError("UNAVAILABLE", "error.routine.taskUnreadable", { taskId: "t1" }).message).toBe(
      "Tavi could not read what task t1 read; try again",
    );
  });

  it("says them in Bulgarian, with names and ids left as they are", () => {
    expect(renderTextRef(textRef("error.memory.recordChanged"), bg)).toBe("Записът се промени, откакто го прочете");
    expect(renderTextRef(textRef("error.reminder.notFound", { reminderId: "rem-1" }), bg)).toBe("Напомнянето rem-1 не съществува");
    expect(renderTextRef(textRef("error.heartbeat.revisionConflict", { expected: "2", current: "3" }), bg)).toBe(
      "Пулсът се промени след версия 2 (сега е 3); прочети го отново и опитай пак",
    );
    expect(renderTextRef(textRef("error.schedule.finished", { name: "Morning brief", spec: "daily at 08:00" }), bg)).toMatch(
      /^„Morning brief“ \(daily at 08:00\) приключи и няма оставащи пускания;/,
    );
    expect(renderTextRef(textRef("error.heartbeat.tokenLimitTooLow", { min: 80_000 }), bg)).toMatch(
      /^Дневният лимит на токени трябва да е поне 80\s000:/,
    );
    expect(
      renderTextRef(textRef("error.memory.notWaitingUpdate", { recordId: "r1", status: textRef("error.memory.status.approved") }), bg),
    ).toBe("Записът в паметта r1 е одобрен; заменя се само чакаща промяна");
    expect(renderTextRef(textRef("error.idea.wrongStatus", { ideaId: "i1", status: textRef("error.idea.status.dismissed") }), bg)).toBe(
      "Идеята i1 е отхвърлена",
    );
    expect(renderTextRef(textRef("error.idea.notFound", { ideaId: "i1" }), bg)).toBe("Идеята i1 не съществува");
    expect(renderTextRef(textRef("error.heartbeat.notYet"), bg)).toBe("Още няма пулс; първо го включи (tavi heartbeat on)");
    expect(renderTextRef(textRef("error.todo.notFound", { todoId: "td-1" }), bg)).toBe("Задачата td-1 не съществува");
    expect(renderTextRef(textRef("error.memory.sharedByShare"), bg)).toBe(
      "Общата памет на работното пространство се променя само с изрично споделяне, не оттук",
    );
  });
});

/** Connected apps, MCP servers and sign-ins: English exactly as the owner wrote it, Bulgarian in the canvas. */
describe("connected apps' errors", () => {
  it("keeps the English byte for byte", () => {
    expect(keyedError("NOT_FOUND", "error.apps.notFound", { appId: "gmail" }).message).toBe("no app gmail");
    expect(keyedError("UNSUPPORTED", "error.apps.configureInChannels", { app: "Gmail" }).message).toBe(
      "configure Gmail in Settings → Channels",
    );
    expect(keyedError("UNSUPPORTED", "error.apps.connectInChannels", { app: "Gmail" }).message).toBe(
      "connect Gmail in Settings → Channels (`tavi channels connect`)",
    );
    expect(keyedError("INVALID_INPUT", "error.apps.toolLeftOut", { tool: "Send mail" }).message).toBe(
      "Send mail is left out by its review; change that in the review",
    );
    expect(keyedError("INVALID_INPUT", "error.apps.clientFile.notJson").message).toBe(
      "that client file is not JSON: download it again from the client's dialog",
    );
    expect(keyedError("NOT_FOUND", "error.apps.noAccountYet", { app: "Todoist", accountId: "mcp.todo2" }).message).toBe(
      "Todoist has no account mcp.todo2, nor any yet",
    );
    expect(keyedError("NOT_CONFIGURED", "error.mcp.settingFirst", { pluginId: "mcp.docs", setting: "token" }).message).toBe(
      "mcp.docs needs its token setting first: `tavi plugins config mcp.docs --set token=…`",
    );
    expect(keyedError("UNSUPPORTED", "error.mcp.tooManyTools", { pluginId: "mcp.docs", count: "1200", max: "128" }).message).toBe(
      "mcp.docs offers 1200 tools; a server may offer at most 128",
    );
    expect(keyedError("CONFLICT", "error.oauth.otherAccount", { named: "a@x.org", previous: "b@x.org" }).message).toBe(
      "You signed in as a@x.org, but this connection is b@x.org. Add it as another account instead, or disconnect this one first.",
    );
    expect(keyedError("NOT_CONFIGURED", "error.oauth.revoked", { channel: "Gmail" }).message).toBe(
      "Gmail's sign-in was revoked or expired: reconnect it in Settings → Channels",
    );
  });

  it("keeps an overlap warning's English, its family said by key", () => {
    const params = { family: textRef("error.mcp.family.schedule"), members: "schedules.create" };
    expect(englishOf(textRef("error.mcp.overlap.server", params))).toBe(
      "its tools overlap Tavi's built-in schedule and reminder tools (schedules.create): the model may pick either",
    );
    expect(englishOf(textRef("error.mcp.overlap.many", { ...params, which: "cron, remind" }))).toBe(
      "cron, remind overlap Tavi's built-in schedule and reminder tools (schedules.create): the model may pick either",
    );
    expect(englishOf(textRef("error.mcp.shadowing.both", { tool: "find", names: "web_search" }))).toBe(
      "find's description and schema name other tools (web_search): it may steer the model toward or away from them (shadowing)",
    );
  });

  it("says them in Bulgarian", () => {
    expect(renderTextRef(textRef("error.apps.configureInChannels", { app: "Gmail" }), bg)).toBe(
      "Настройките на Gmail са в Настройки → Канали",
    );
    expect(renderTextRef(textRef("error.apps.toolUnreviewed", { tool: "Send mail" }), bg)).toBe(
      "„Send mail“ чака преглед: първо го прегледай",
    );
    expect(renderTextRef(textRef("error.oauth.tooManyFlows"), bg)).toBe("Твърде много влизания чакат: довърши или затвори някое");
    expect(renderTextRef(textRef("error.mcp.noOAuth", { pluginId: "mcp.docs" }), bg)).toBe("mcp.docs не влиза с OAuth");
    expect(
      renderTextRef(textRef("error.mcp.overlap.server", { family: textRef("error.mcp.family.mail"), members: "gmail.me.read" }), bg),
    ).toBe("Инструментите му се застъпват с вградените инструменти на Tavi за поща (gmail.me.read): моделът може да избере всеки от тях");
  });
});

/** Tavi's own words inside a keyed error are keys too, so a Bulgarian sentence holds no English but names and ids. */
describe("Tavi's own words inside keyed errors", () => {
  const joined = textRef("error.channels.fieldsJoined", {
    first: textRef("error.channels.fieldsJoined", { first: "Bot token", last: "Chat id" }),
    last: "Webhook",
  });

  it("joins a field list each language's way, the English as it always was", () => {
    expect(keyedError("INVALID_INPUT", "error.channels.enterBeforeEnabling", { fields: joined, channel: "Telegram" }).message).toBe(
      "Enter Bot token and Chat id and Webhook before enabling Telegram.",
    );
    expect(renderTextRef(textRef("error.channels.enterBeforeEnabling", { fields: joined, channel: "Telegram" }), bg)).toBe(
      "Въведи Bot token и Chat id и Webhook, преди да включиш Telegram.",
    );
  });

  it("says fallbacks, field types and an unnamed task by key", () => {
    expect(keyedError("INVALID_INPUT", "error.channels.notASenderAny", { scopeId: "x", channel: "acme" }).message).toBe(
      "x is not a sender on acme",
    );
    expect(keyedError("INVALID_INPUT", "error.channels.notATargetAny", { to: "x", channel: "acme" }).message).toBe(
      "x is not a target on acme",
    );
    const typed = { channel: "Telegram", field: "Port", type: textRef("error.channels.type.number") };
    expect(keyedError("INVALID_INPUT", "error.channels.fieldType", typed).message).toBe("Telegram's Port must be a number");
    expect(renderTextRef(textRef("error.channels.fieldType", typed), bg)).toBe("Port на Telegram трябва да е число");
    expect(keyedError("NOT_FOUND", "error.task.notInWorkspaceUnnamed").message).toBe("No task (none named) in this workspace");
    expect(renderTextRef(textRef("error.task.notInWorkspaceUnnamed"), bg)).toBe("В това работно пространство не е посочен чат");
  });

  it("quotes a command's own word it cannot say in Bulgarian", () => {
    const revoked = { owner: "person-1", action: "run" };
    expect(keyedError("NOT_AUTHORIZED", "error.routine.ownerRevoked", revoked).message).toContain("viewed or archived, not run.");
    expect(renderTextRef(textRef("error.routine.ownerRevoked", revoked), bg)).toContain("но не и „run“.");
  });

  it("puts a no-break space between a number and its unit", () => {
    expect(renderTextRef(textRef("error.video.tooManyPixels", { side: "4096" }), bg)).toBe(
      "Кадрите на видеото са по-големи от 4096×4096 пиксела",
    );
    expect(renderTextRef(textRef("error.permissions.noGrant", { workspaceId: "default", grantId: "g1" }), bg)).toBe(
      "В работното пространство default няма разрешение g1 за чат",
    );
  });
});
