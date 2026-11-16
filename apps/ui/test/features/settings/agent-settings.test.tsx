// @vitest-environment jsdom
import type { WorkspaceSettingsAnswer } from "@tavi/contracts";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { GeneralSettings } from "../../../src/features/settings/GeneralSettings.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { InWorkspace } from "../../support/workspace.js";
import { mountSettled as mount, settle, unmountAll } from "../../support/dom.js";
import { offeredWords, close, open, pick, selected } from "../../pick.js";

/**
 * Settings → General's skill suggestions, rarely used tools and to-do list:
 * each writes its workspace setting with the revision the page read, and the
 * default clears the key.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => unmountAll());

const effectiveOf = (settings: WorkspaceSettingsAnswer["settings"]): WorkspaceSettingsAnswer["effective"] => ({
  timezone: "UTC",
  skillSuggestions: settings.skillSuggestions !== false,
  toolDeferral: settings.toolDeferral ?? "auto",
  tasksHome: settings.tasksHome ?? "tavi",
});

const SERVERS = [
  { pluginId: "mcp.todoist", name: "Todoist", enabled: true, allowed: true },
  // Not allowed in this workspace, or not enabled: not offered.
  { pluginId: "mcp.linear", name: "Linear", enabled: true, allowed: false },
  { pluginId: "mcp.notion", name: "Notion", enabled: false, allowed: true },
].map((server) => ({
  ...server,
  state: "running",
  transport: "http",
  exposure: "auto",
  pendingVersions: [],
  waitingTools: 0,
  people: false,
  openNotices: [],
}));

function owner(initial: WorkspaceSettingsAnswer["settings"]) {
  let answer: WorkspaceSettingsAnswer = {
    workspaceId: "default",
    revision: 1,
    settings: initial,
    effective: effectiveOf(initial),
    hostTimezone: "UTC",
  };
  const writes: Record<string, unknown>[] = [];
  const client: SettingsClient = {
    request: (command, payload) => {
      const body = payload as Record<string, unknown>;
      if (command === "workspace-settings") {
        if (body["action"] !== "get") {
          writes.push(body);
          const settings: Record<string, unknown> = { ...answer.settings };
          const key = String(body["key"]);
          if (body["action"] === "unset") delete settings[key];
          else settings[key] = key === "skillSuggestions" ? body["value"] !== "off" : body["value"];
          const next = settings as WorkspaceSettingsAnswer["settings"];
          answer = { ...answer, revision: answer.revision + 1, settings: next, effective: effectiveOf(next) };
        }
        return Promise.resolve({ ok: true, result: answer } as never);
      }
      if (command === "mcp" && body["action"] === "list")
        return Promise.resolve({ ok: true, result: { servers: { enabled: true, workspaceId: "default", servers: SERVERS } } } as never);
      return new Promise<never>(() => undefined);
    },
  };
  return { client, writes };
}

const page = async (client: SettingsClient) =>
  await mount(
    <InWorkspace client={client} workspaceId="default">
      <GeneralSettings />
    </InWorkspace>,
  );

describe("skill suggestions in Settings → General", () => {
  it("are on by default, turn off with the switch, and back on by clearing the key", async () => {
    const { client, writes } = owner({});
    const view = await page(client);
    const toggle = () => view.querySelector('input[aria-label="suggest saving procedures as skills"]') as HTMLInputElement;
    expect(view.textContent).toContain("Suggest saving procedures as skills");
    expect(toggle().checked).toBe(true);
    await act(async () => toggle().click());
    await settle();
    expect(writes).toEqual([{ action: "set", workspaceId: "default", key: "skillSuggestions", value: "off", expectedRevision: 1 }]);
    expect(toggle().checked).toBe(false);
    expect(view.textContent).toContain("only when you ask for one");
    await act(async () => toggle().click());
    await settle();
    expect(writes[1]).toEqual({ action: "unset", workspaceId: "default", key: "skillSuggestions", expectedRevision: 2 });
  });
});

describe("rarely used tools in Settings → General", () => {
  it("shows auto by default, sets on or off, and clears the key for auto", async () => {
    const { client, writes } = owner({});
    const view = await page(client);
    const trigger = () => view.querySelector('[aria-label="tool deferral"]');
    expect(selected(trigger())).toBe("auto");
    await pick(trigger(), "off");
    expect(writes).toEqual([{ action: "set", workspaceId: "default", key: "toolDeferral", value: "off", expectedRevision: 1 }]);
    expect(selected(trigger())).toBe("off");
    expect(view.textContent).toContain("the whole tool list");
    await pick(trigger(), "auto");
    expect(writes[1]).toEqual({ action: "unset", workspaceId: "default", key: "toolDeferral", expectedRevision: 2 });
  });
});

describe("the to-do list in Settings → General", () => {
  it("offers Tavi and the MCP servers this workspace allows and has enabled", async () => {
    const { client, writes } = owner({});
    const view = await page(client);
    const trigger = () => view.querySelector('[aria-label="to-do list"]');
    expect(selected(trigger())).toBe("tavi");
    await open(trigger());
    expect(offeredWords()).toEqual(["Tavi", "Todoist"]);
    await close();
    await pick(trigger(), "mcp:todoist");
    expect(writes).toEqual([{ action: "set", workspaceId: "default", key: "tasksHome", value: "mcp:todoist", expectedRevision: 1 }]);
    expect(view.textContent).toContain("To-dos go to todoist");
    await pick(trigger(), "tavi");
    expect(writes[1]).toEqual({ action: "unset", workspaceId: "default", key: "tasksHome", expectedRevision: 2 });
  });

  it("keeps a saved server selectable when it is no longer listed", async () => {
    const { client } = owner({ tasksHome: "mcp:things" });
    const view = await page(client);
    const trigger = view.querySelector('[aria-label="to-do list"]');
    expect(selected(trigger)).toBe("mcp:things");
    await open(trigger);
    expect(offeredWords()).toEqual(["Tavi", "things", "Todoist"]);
    await close();
  });
});
