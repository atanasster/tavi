// @vitest-environment jsdom
import type { MemoryItem, SystemPromptPreview } from "@tavi/contracts";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { Instructions } from "../../../src/features/chat-panel/Instructions.js";
import { Memory } from "../../../src/features/chat-panel/Memory.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { InWorkspace } from "../../support/workspace.js";
import { mountSettled as mount } from "../../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const record = (recordId: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({
  recordId,
  kind: "fact",
  scope: { kind: "personal", principalId: "operator" },
  scopeKey: "personal|p=operator",
  currentRevisionId: `${recordId}-rev1`,
  status: "approved",
  sensitivity: "normal",
  revocationGeneration: 0,
  recordedAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
  target: "personal",
  title: null,
  body: `Body of ${recordId}\nmore`,
  redacted: false,
  truncated: false,
  sourceCount: 0,
  ...extra,
});

const preview: SystemPromptPreview = {
  workspaceId: "default",
  layers: [
    { kind: "base", source: "workspace", label: "Base prompt", length: 4, generated: false, active: true },
    { kind: "facts", label: "Runtime facts", generated: true, active: true, detail: "Step 1 of 40.", sample: true },
  ],
  shippedLength: 4812,
  overridden: true,
  baseText: "Mine.",
};

describe("the chat panel's Memory tab, read-only", () => {
  it("folds the workspace's memory away under its count, and says how many proposals wait", async () => {
    const client: SettingsClient = {
      request: async (_command, payload) => {
        expect((payload as { statuses: string[] }).statuses).toEqual(["approved"]);
        return {
          ok: true,
          result: {
            records: [
              record("r1", { title: "Prefers metric units", kind: "preference" }),
              record("r2"),
              record("r3", { redacted: true, title: null, body: null, target: "shared" }),
            ],
            nextCursor: "next",
            otherPeople: [],
          },
        };
      },
    };
    const onCenter = vi.fn();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Memory proposals={1} onCenter={onCenter} />
      </InWorkspace>,
    );
    expect(page.querySelector(".chat-panel-inherited summary")?.textContent).toBe("Global memory (3+)");
    expect((page.querySelector(".chat-panel-inherited") as HTMLDetailsElement).open).toBe(false);
    expect([...page.querySelectorAll(".chat-panel-records .chat-panel-item-title")].map((node) => node.textContent)).toEqual([
      "Prefers metric units",
      "Body of r2",
      "Sensitive record",
    ]);
    expect(page.querySelector(".chat-panel-records .chat-panel-item-detail")?.textContent).toBe("Preference · Personal");
    expect(page.textContent).toContain("1 proposal waits for review in the Command Center.");
    await act(async () => (page.querySelector(".chat-panel-center") as HTMLButtonElement).click());
    expect(onCenter).toHaveBeenCalledOnce();
  });

  it("says when the memory could not be read", async () => {
    const page = await mount(
      <InWorkspace
        client={{ request: async () => ({ ok: false, error: { code: "UNAVAILABLE", message: "memory is unavailable" } }) }}
        workspaceId="default"
      >
        <Memory />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("memory is unavailable");
    expect(page.querySelector(".chat-panel-center")).toBeNull();
    expect(page.textContent).not.toContain("for review");
  });
});

describe("the chat panel's Instructions tab, read-only", () => {
  it("shows the layers a new chat is given, and sends each edit where it lives", async () => {
    const sent: unknown[] = [];
    const client: SettingsClient = {
      request: async (command, payload) => {
        sent.push([command, payload]);
        return { ok: true, result: preview };
      },
    };
    const onSettings = vi.fn();
    const onSoul = vi.fn();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Instructions editable={false} onSettings={onSettings} onSoul={onSoul} />
      </InWorkspace>,
    );
    expect(sent).toEqual([["system-prompt", { action: "preview", workspaceId: "default" }]]);
    expect(page.textContent).toContain("a new chat is given now");
    expect([...page.querySelectorAll(".soul-layer-label")].map((node) => node.textContent)).toEqual(["Base prompt", "Runtime facts"]);
    const [settings, soul] = [...page.querySelectorAll("p > button")] as HTMLButtonElement[];
    await act(async () => settings?.click());
    await act(async () => soul?.click());
    expect(onSettings).toHaveBeenCalledOnce();
    expect(onSoul).toHaveBeenCalledOnce();
  });
});
