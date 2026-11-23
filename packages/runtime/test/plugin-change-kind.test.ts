import { describe, expect, it } from "vitest";

import { SqliteStore } from "../src/persistence/store.js";

/**
 * The Command Center's `plugin` change kind: a plugin's settings or versions change
 * every workspace's feed — plugins are the owner's — and a workspace's UI
 * roles or placements change only its own, and only when they change.
 */
describe("the plugin change kind", () => {
  function fixture() {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    const { center, plugins, workspaceSettings } = store.asPort().repositories;
    let cursors: Record<string, string | undefined> = {};
    /** What changed for `workspaceId` since the last call for it. */
    const changed = (workspaceId: string): readonly string[] => {
      const answer = center.changes({
        workspaceId,
        principalId: "operator",
        ...(cursors[workspaceId] === undefined ? {} : { cursor: cursors[workspaceId] }),
      });
      cursors = { ...cursors, [workspaceId]: answer.cursor };
      return answer.changed;
    };
    return { store, plugins, workspaceSettings, changed };
  }

  it("bumps every workspace for a plugin setting, and one workspace for its own UI keys only", () => {
    const { store, plugins, workspaceSettings, changed } = fixture();
    try {
      changed("a");
      changed("b");
      plugins.putSetting({
        pluginId: "acme.browserview",
        enabled: true,
        config: {},
        updatedBy: "operator",
        updatedAt: "2026-10-03T00:00:00.000Z",
      });
      expect(changed("a")).toContain("plugin");
      expect(changed("b")).toContain("plugin");

      const write = (workspaceId: string, settings: Record<string, unknown>, expectedRevision: number) =>
        workspaceSettings.set({ workspaceId, settings, expectedRevision, actor: "operator", now: "2026-10-03T00:00:00.000Z" });
      write("a", { timezone: "UTC" }, 0);
      expect(changed("a")).not.toContain("plugin");
      write("a", { timezone: "UTC", uiRoles: { "browser-view": "off" } }, 1);
      expect(changed("a")).toContain("plugin");
      expect(changed("b")).not.toContain("plugin");
      write("a", { timezone: "Europe/Berlin", uiRoles: { "browser-view": "off" } }, 2);
      expect(changed("a")).not.toContain("plugin");
      write("a", { uiPlacements: { "acme.browserview/live": "hidden" } }, 3);
      expect(changed("a")).toContain("plugin");
      write("b", { uiPlacements: { "acme.browserview/live": "hidden" } }, 0);
      expect(changed("b")).toContain("plugin");
    } finally {
      store.close();
    }
  });

  it("bumps one workspace's settings kind on every write of its settings, so an open page re-reads its language", () => {
    const { store, workspaceSettings, changed } = fixture();
    try {
      changed("a");
      changed("b");
      const write = (workspaceId: string, settings: Record<string, unknown>, expectedRevision: number) =>
        workspaceSettings.set({ workspaceId, settings, expectedRevision, actor: "operator", now: "2026-10-03T00:00:00.000Z" });
      write("a", { locale: "bg" }, 0);
      expect(changed("a")).toContain("settings");
      expect(changed("b")).not.toContain("settings");
      write("a", { locale: "en" }, 1);
      expect(changed("a")).toEqual(["settings"]);
      expect(changed("a")).toEqual([]);
    } finally {
      store.close();
    }
  });
});
