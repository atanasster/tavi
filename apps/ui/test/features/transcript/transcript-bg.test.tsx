// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Transcript } from "../../../src/features/transcript/Transcript.js";
import { EntryBoundary } from "../../../src/features/transcript/ToolCards.js";
import { setLocale } from "../../../src/lib/i18n.js";
import { mount, unmountAll } from "../../support/dom.js";
import { textEntry as text, toolCard as card } from "../../support/rows.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The transcript in Bulgarian: a tool card's status and its parts, a past-chat search's list, and an entry that cannot be drawn. */

beforeEach(async () => {
  await setLocale("bg");
});

afterEach(async () => {
  unmountAll();
  vi.restoreAllMocks();
  await setLocale("en");
});

describe("the transcript in Bulgarian", () => {
  it("says a tool card's status and what it was given", async () => {
    const page = await mount(
      <Transcript
        entries={[
          text("t1", "an answer"),
          card("c1", { input: { code: "1+1" }, output: { result: 2 } }),
          card("c2", { status: "failed", message: "boom" }),
        ]}
      />,
    );
    const shown = page.textContent ?? "";
    const regions = [...page.querySelectorAll(".tool-payload")].map((region) => region.getAttribute("aria-label"));
    expect(regions).toEqual(["Какво получи инструментът", "Какво отговори инструментът"]);
    expect(shown).toContain("Работих · 2 стъпки");
    expect(shown).toContain("готово");
    expect(shown).toContain("неуспешно");
    for (const word of ["Worked ·", "assistant:", "tool:", "failed", "done"]) expect(shown).not.toContain(word);
  });

  it("labels the chats a past-chat search found", async () => {
    const page = await mount(
      <Transcript
        entries={[
          card("s1", {
            toolName: "sessions.search",
            input: { query: "ACME" },
            output: { found: 1, matches: [{ taskId: "t-one", title: "ACME call notes", at: "2026-09-01T00:00:00.000Z", excerpt: "…" }] },
          }),
        ]}
      />,
    );
    expect(page.querySelector("ul[aria-label='Намерени по-ранни чатове']")).not.toBeNull();
    expect(page.querySelector("ul[aria-label='Earlier chats found']")).toBeNull();
  });

  it("says an entry that cannot be drawn took only its own row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Boom = (): never => {
      throw new Error("odd payload");
    };
    const page = await mount(
      <EntryBoundary what="toolCall">
        <Boom />
      </EntryBoundary>,
    );
    const shown = page.querySelector(".unrendered")?.textContent ?? "";
    expect(shown).toContain("Това извикване на инструмент не може да се покаже");
    expect(shown).toContain("Останалото в чата не е засегнато.");
    expect(shown).not.toContain("could not be shown");
    expect(shown).not.toContain("The rest of the session is unaffected.");
  });
});
