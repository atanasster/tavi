// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Canvas } from "../../../src/features/chat/Canvas.js";
import { MessageActions } from "../../../src/features/chat/MessageActions.js";
import { setLocale } from "../../../src/lib/i18n.js";
import { mount, unmountAll } from "../../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The chat in Bulgarian: an empty chat's composer and its hint, and a response's copy and read-aloud actions. */

beforeEach(async () => {
  await setLocale("bg");
});

afterEach(async () => {
  unmountAll();
  vi.unstubAllGlobals();
  await setLocale("en");
});

const noop = () => {};
const labels = (page: HTMLElement): string[] =>
  [...page.querySelectorAll("[aria-label]")].map((element) => element.getAttribute("aria-label") ?? "");

describe("the chat in Bulgarian", () => {
  it("invites a new chat and names its composer's controls", async () => {
    const page = await mount(
      <Canvas
        state={{ connection: "ready", runs: [] }}
        session={undefined}
        onSubmit={noop}
        onDecide={noop}
        onAbort={noop}
        onExpand={noop}
      />,
    );
    const text = page.textContent ?? "";
    expect(text).toContain("Попитай Tavi нещо, за да започнеш чат.");
    expect(page.querySelector("textarea")?.getAttribute("placeholder")).toBe("Започни нов чат…\nEnter изпраща · Shift+Enter за нов ред");
    expect(labels(page)).toContain("Прикачи PDF, снимка, видео, GIF, аудио, текст или код");
    expect(text).toContain("Изпрати");
    for (const word of ["Ask Tavi something", "New chat", "Configure model", "Send", "Attach PDF"]) expect(text).not.toContain(word);
    for (const word of ["Start a new chat", "Attach PDF, photo, video, GIF, audio, text and code files"])
      expect(labels(page)).not.toContain(word);
  });

  it("labels a response's copy and read-aloud", async () => {
    vi.stubGlobal("SpeechSynthesisUtterance", class {});
    vi.stubGlobal("speechSynthesis", { speak: vi.fn(), cancel: vi.fn() });
    const page = await mount(<MessageActions text="A response" kind="response" readAloud />);
    expect(labels(page)).toContain("Копирай отговора");
    expect(labels(page)).toContain("Прочети на глас");
    for (const word of ["Copy response", "Read aloud", "Copy prompt"]) expect(labels(page)).not.toContain(word);
  });
});
