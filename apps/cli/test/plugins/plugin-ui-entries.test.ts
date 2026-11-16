import type { PluginView } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { pluginUiEntries, runPluginAction } from "../../src/features/plugins/actions.js";

/** What `plugins ui` answers: only what may run in the canvas now. */
const ui = {
  abi: "tavi.ui/1" as const,
  contributions: [{ id: "live", title: "Browser", document: "live.html", channels: [], placements: [{ slot: "chat.panel.tab" as const }] }],
};
const hash = (digit: string) => digit.repeat(64);
const version = (name: string, reviewState: "proposed" | "approved" | "rejected", withUi = true) => ({
  version: name,
  reviewState,
  contentHash: hash(name.slice(0, 1)),
  installedAt: "2026-10-03T00:00:00.000Z",
  runsOwnerCode: true,
  tools: [],
  configFields: {},
  ...(withUi ? { ui } : {}),
});
const view = (overrides: Partial<PluginView>): PluginView => ({
  id: "acme.view",
  kind: "external",
  runsOwnerCode: true,
  name: "Acme",
  description: "",
  enabled: true,
  core: false,
  versions: [],
  tools: [],
  configFields: {},
  config: {},
  ...overrides,
});

describe("pluginUiEntries", () => {
  it("lists an enabled built-in with its build hash, and only the active approved version of an enabled external plugin", () => {
    const entries = pluginUiEntries([
      view({ id: "tavi.browserview", kind: "builtin", runsOwnerCode: true, ui, uiContentHash: hash("b") }),
      view({ id: "tavi.nohash", kind: "builtin", runsOwnerCode: true, ui }),
      view({ id: "acme.running", activeVersion: "2.0.0", versions: [version("1.0.0", "approved"), version("2.0.0", "approved")] }),
      view({ id: "acme.off", enabled: false, activeVersion: "1.0.0", versions: [version("1.0.0", "approved")] }),
      view({ id: "acme.revoked", activeVersion: "1.0.0", versions: [version("1.0.0", "rejected")] }),
      view({ id: "acme.proposed", activeVersion: "1.0.0", versions: [version("1.0.0", "proposed")] }),
      view({ id: "acme.code", activeVersion: "1.0.0", versions: [version("1.0.0", "approved", false)] }),
    ]);
    expect(entries.map((entry) => [entry.pluginId, entry.kind, entry.version, entry.contentHash])).toEqual([
      ["tavi.browserview", "builtin", undefined, hash("b")],
      ["acme.running", "external", "2.0.0", hash("2")],
    ]);
  });

  it("answers plugins ui for one plugin at one hash only while that exact one may load", async () => {
    const plugin = view({ id: "acme.running", activeVersion: "2.0.0", versions: [version("2.0.0", "approved")] });
    const registry = { list: async () => [plugin] } as unknown as Parameters<typeof runPluginAction>[0];
    const answer = (payload: { pluginId?: string; contentHash?: string }) =>
      runPluginAction(registry, { action: "ui", ...payload }, "operator");
    expect(await answer({ pluginId: "acme.running", contentHash: hash("2") })).toMatchObject({ entries: [{ pluginId: "acme.running" }] });
    expect(await answer({ pluginId: "acme.running", contentHash: hash("1") })).toEqual({ entries: [] });
    expect(await answer({ pluginId: "acme.other" })).toEqual({ entries: [] });
  });
});
