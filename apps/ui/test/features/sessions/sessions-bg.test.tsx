// @vitest-environment jsdom
import type { TaskListRow } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { SessionDirectory } from "../../../src/features/sessions/SessionDirectory.js";
import type { CanvasState, CanvasStore } from "../../../src/features/chat/store/types.js";
import { mount } from "../../support/dom.js";
import { InWorkspace } from "../../support/workspace.js";
import { inBulgarian } from "../../support/bulgarian.js";
import { taskRow as row } from "../../support/rows.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The sidebar's chat list in Bulgarian: its group headings, its search and its marks. */

inBulgarian();

const noop = () => undefined;

async function directory(homeChat: boolean, rows: readonly TaskListRow[]): Promise<HTMLElement> {
  const state: CanvasState = { connection: "ready", runs: [], directory: { rows, needs: [], needsTruncated: false, loading: false } };
  const store = { loadSessions: async () => undefined, openTask: async () => undefined } as unknown as CanvasStore;
  return mount(
    <InWorkspace client={{ request: () => new Promise<never>(() => undefined) }} workspaceId="default" timeZone="UTC">
      <SessionDirectory
        state={state}
        store={store}
        homeChat={homeChat}
        principal="operator"
        selected={undefined}
        onSelect={noop}
        onNew={noop}
        onHome={noop}
      />
    </InWorkspace>,
  );
}

const headings = (page: HTMLElement): string[] => [...page.querySelectorAll("h3")].map((heading) => heading.textContent ?? "");

describe("the chat list in Bulgarian", () => {
  it("heads its groups, names the workspace and offers its search in Bulgarian", async () => {
    const page = await directory(true, [
      row("home-1", "Home", { chatKind: "home", status: "working", principalId: "operator" }),
      row("chat-1", "Book the room", { status: "input-required", needs: ["question"] }),
      row("done-1", "Old one"),
      row("run-1", "Morning digest", { chatKind: "run" }),
      row("conv-1", "Family group", { origin: "messaging", conversationHome: { kind: "group", epoch: 0 } }),
    ]);
    const shown = headings(page);
    expect(shown).toContain("Начало");
    expect(shown).toContain("Чака теб");
    expect(shown).toContain("Разговори");
    expect(shown).toContain("Дейност");
    expect(shown).toContain("Завършени · 2026-10-04");
    expect(page.textContent).toContain("Работно пространство");
    expect(page.querySelector("input")?.getAttribute("placeholder")).toBe("Търси в чатовете…");
    expect(page.textContent).toContain("група");
    expect(page.querySelector('[aria-label="Закачи Book the room"]')).not.toBeNull();
    for (const word of ["Needs you", "Conversations", "Activity", "Completed ·", "Workspace", "Search chats…"]) {
      expect(page.textContent).not.toContain(word);
    }
    expect(shown).not.toContain("Home");
  });

  it("says an empty list is empty", async () => {
    const page = await directory(false, []);
    expect(page.textContent).toContain("Още няма чатове.");
    expect(page.textContent).not.toContain("No chats yet.");
  });
});
