import { renderTextRef, textRef } from "@tavi/contracts";
import { coreEnglish } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { describe, expect, it } from "vitest";

import { roomContextIntroduction, roomIntroduction } from "../../src/features/channels/rooms.js";

/** What Tavi says in a chat app, in the workspace's language; English byte for byte as before. */

const bg = coreIn("bg");

describe("a room's introductions in Bulgarian", () => {
  it("introduces Tavi to a room in the workspace's words", () => {
    expect(roomIntroduction("Ада", { trigger: ["mention"], members: "operator-only" }, bg)).toBe(
      "Здравейте, аз съм Tavi, асистентът на Ада. Тук отговарям само на Ада при споменаване.\n" +
        "Никога не уча от съобщенията тук за личната употреба на Ада и никога не чета съобщения от хора, които Tavi не познава.\n" +
        "Ако не искате да участвате, кажете на Ада.",
    );
    expect(roomContextIntroduction("Ада", { members: "bound" }, bg)).toBe(
      "Отсега нататък, при съобщение към мен тук от някого, когото познавам от Ада, чета и до 20 от предишните съобщения тук, за контекст.\n" +
        "Съобщенията от хора, които Tavi не познава, остават настрана и нищо прочетено тук не се пази за личната употреба на Ада.",
    );
  });

  it("is English with no words given", () => {
    expect(roomIntroduction("Ada", { trigger: ["mention"], members: "operator-only" })).toBe(
      roomIntroduction("Ada", { trigger: ["mention"], members: "operator-only" }, coreEnglish),
    );
    expect(roomIntroduction("Ada", { trigger: ["mention"], members: "operator-only" })).toMatch(/^Hi, I'm Tavi/);
  });
});

describe("other chat-app messages in Bulgarian", () => {
  it("says a test message and an unverified mail's reply in the workspace's words, English as it was", () => {
    expect(coreEnglish("channel.test.message")).toBe("This is a test message from Tavi: the connection works.");
    expect(bg("channel.test.message")).toBe("Това е пробно съобщение от Tavi: връзката работи.");
    expect(coreEnglish("channel.mail.unverified")).toBe(
      "Your message arrived, but it could not be verified as coming from you (its sender authentication did not pass), so it was not acted on. If your mail provider is set up correctly this was not you; otherwise ask the operator to trust your unverified mail in Allowed people.",
    );
    expect(bg("channel.mail.unverified")).toMatch(/^Съобщението ти пристигна, но не можах да проверя/);
  });

  it("says a withdrawn round's stored notice in the language of its workspace when it is tried again", () => {
    const stored = textRef("channel.approval.reset");
    expect(renderTextRef(stored, coreEnglish)).toBe("This conversation was reset, so this round was withdrawn.");
    expect(renderTextRef(stored, bg)).not.toBe(renderTextRef(stored, coreEnglish));
  });
});
