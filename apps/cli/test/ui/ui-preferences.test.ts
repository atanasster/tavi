import { readdirSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { readSessionPreferences, uiPreferencesCommand } from "../../src/features/ui/preferences.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

describe("ui-preferences", () => {
  it("answers empty preferences for a workspace never written, and keeps what a page sets", () => {
    const directory = directories.create("tavi-ui-preferences-");
    expect(uiPreferencesCommand(directory, { action: "get", workspaceId: "default" })).toEqual({
      ok: true,
      result: { preferences: { pins: [], archived: [], seen: {} } },
    });
    const preferences = { pins: ["task-1"], archived: ["task-2"], seen: { "task-1": "2026-09-21T00:00:00Z" } };
    expect(uiPreferencesCommand(directory, { action: "set", workspaceId: "default", preferences })).toEqual({
      ok: true,
      result: { preferences },
    });
    expect(readSessionPreferences(directory, "default")).toEqual(preferences);
    // Another workspace's panel is its own; the write left no temporary file behind.
    expect(readSessionPreferences(directory, "other")).toEqual({ pins: [], archived: [], seen: {} });
    expect(readdirSync(join(directory, "ui")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
