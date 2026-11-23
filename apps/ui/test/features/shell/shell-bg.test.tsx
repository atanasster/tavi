// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { Bar } from "../../../src/features/shell/Bar.js";
import { KeySheet } from "../../../src/features/shell/KeySheet.js";
import { mount } from "../../support/dom.js";
import { InWorkspace } from "../../support/workspace.js";
import { inBulgarian } from "../../support/bulgarian.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The shell in Bulgarian: the header's routes, its count of chats that need you, and the keyboard sheet. */

inBulgarian();

const noop = () => undefined;

describe("the shell in Bulgarian", () => {
  it("names the header's routes and counts the chats that need you", async () => {
    const page = await mount(
      <InWorkspace>
        <Bar state={{ connection: "ready", runs: [] }} route="chat" onRoute={noop} needs={3} ideas />
      </InWorkspace>,
    );
    const text = page.textContent ?? "";
    expect(text).toContain("Чат");
    expect(text).toContain("Настройки");
    const labels = [...page.querySelectorAll("[aria-label],[title]")].map(
      (element) => `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""}`,
    );
    expect(text).toContain("3 чата те чакат в работното пространство „default“");
    expect(labels.join(" | ")).toContain("Tavi: има връзка");
    for (const word of ["Chat", "Settings", "Ideas", "need you", "Keyboard shortcuts", "connected"]) {
      expect(text).not.toContain(word);
      expect(labels.join(" | ")).not.toContain(word);
    }
  });

  it("lists the keyboard's shortcuts", async () => {
    const page = await mount(<KeySheet onClose={noop} onAction={{}} />);
    const text = page.textContent ?? "";
    expect(text).toContain("Клавиатура");
    expect(text).toContain("Търси в чатовете");
    expect(text).toContain("Спри текущия ход");
    expect(text).toContain("Покажи този списък");
    for (const word of ["Keyboard", "Search chats", "Stop the running turn", "Show this sheet", "Deny the waiting round"])
      expect(text).not.toContain(word);
  });
});
