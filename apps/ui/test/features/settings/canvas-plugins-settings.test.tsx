// @vitest-environment jsdom
import type { PluginUiEntry } from "@tavi/contracts";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { reportFlood } from "../../../src/features/plugin-host/floods.js";
import { CanvasPluginsSettings } from "../../../src/features/settings/CanvasPluginsSettings.js";
import { close, offeredWords, open, pick as choose, selected } from "../../pick.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { InWorkspace } from "../../support/workspace.js";
import { flush, mountSettled } from "../../support/dom.js";

/**
 * Settings → Plugins → Canvas: the Browser
 * view picker, its disclosure confirmation, the fallback warning and
 * placement overrides, all written to the workspace's settings document.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settle = (): Promise<void> => flush(6, 1);

const contribution = (pluginId: string) => ({
  id: "live",
  role: "browser-view" as const,
  title: pluginId === "tavi.browserview" ? "Browser" : "Acme browser",
  document: "live.html",
  channels: ["browser.live" as const],
  placements: [{ slot: "chat.panel.top" as const, show: "while-active" as const, height: { min: 140, default: 220, max: 480 } }],
  disclosure: pluginId === "tavi.browserview" ? "Built in." : "Sees every page the agent opens.",
});
const entry = (pluginId: string): PluginUiEntry => ({
  pluginId,
  kind: pluginId.startsWith("tavi.") ? "builtin" : "external",
  contentHash: "a".repeat(64),
  ui: { abi: "tavi.ui/1", contributions: [contribution(pluginId)] },
});

function fakeOwner(entries: PluginUiEntry[], settings: Record<string, unknown> = {}) {
  const state = { settings, revision: 1, conflictNext: false, reads: 0 };
  const writes: Record<string, unknown>[] = [];
  const client: SettingsClient = {
    request: async (command, payload) => {
      const body = payload as Record<string, unknown>;
      if (command === "plugins") return { ok: true, result: { entries } };
      if (body["action"] === "get") state.reads += 1;
      if ((body["action"] === "set" || body["action"] === "unset") && state.conflictNext) {
        state.conflictNext = false;
        state.revision += 1;
        return { ok: false, error: { code: "CONFLICT", message: "stale revision" } };
      }
      if (body["action"] === "set" || body["action"] === "unset") {
        writes.push(body);
        const key = body["key"] as string;
        const next = { ...state.settings };
        if (body["action"] === "set") next[key] = JSON.parse(body["value"] as string);
        else delete next[key];
        state.settings = next;
        state.revision += 1;
      }
      return {
        ok: true,
        result: {
          workspaceId: "default",
          revision: state.revision,
          settings: state.settings,
          effective: { timezone: "UTC" },
          hostTimezone: "UTC",
        },
      };
    },
  };
  return { client, writes, state };
}

/** The canvas plugin settings, read through `client`, and their first reads answered. */
const settings = (client: SettingsClient): Promise<HTMLElement> =>
  mountSettled(
    <InWorkspace client={client}>
      <CanvasPluginsSettings workspaceId="default" />
    </InWorkspace>,
    settle,
  );

const pick = async (select: Element | null, value: string): Promise<void> => {
  await choose(select, value);
  await settle();
};

const ROLE = '[aria-label="Browser view"]';

describe("Settings → Plugins → Canvas", () => {
  it("asks again, with the disclosure, before another plugin may watch the browser, and writes the role once confirmed", async () => {
    const { client, writes } = fakeOwner([entry("tavi.browserview"), entry("acme.view")]);
    const page = await settings(client);
    await open(page.querySelector(ROLE));
    expect(offeredWords()).toEqual(["Built-in", "acme.view", "Off"]);
    await close();
    await pick(page.querySelector(ROLE), "acme.view");
    expect(writes).toEqual([]);
    expect(page.querySelector('[role="alertdialog"]')?.textContent).toContain("Sees every page the agent opens.");
    await act(async () =>
      ([...page.querySelectorAll("button")].find((button) => button.textContent === "Use acme.view") as HTMLButtonElement).click(),
    );
    await settle();
    expect(writes).toEqual([
      {
        action: "set",
        workspaceId: "default",
        key: "uiRoles",
        value: JSON.stringify({ "browser-view": "acme.view" }),
        expectedRevision: 1,
      },
    ]);
    await pick(page.querySelector(ROLE), "tavi.browserview");
    expect(writes.at(-1)).toEqual({ action: "unset", workspaceId: "default", key: "uiRoles", expectedRevision: 2 });
  });

  it("re-confirms a plugin that asks for browser.control, saying Tavi's own takeover surface is used instead", async () => {
    const controlling: PluginUiEntry = {
      ...entry("acme.view"),
      ui: { abi: "tavi.ui/1", contributions: [{ ...contribution("acme.view"), channels: ["browser.live", "browser.control"] }] },
    };
    const { client, writes } = fakeOwner([entry("tavi.browserview"), controlling]);
    const page = await settings(client);
    await pick(page.querySelector(ROLE), "acme.view");
    expect(writes).toEqual([]);
    expect(page.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "It also asks to see and type into pages you take over, sign-in pages included; Tavi draws its own takeover surface, so it is not given them.",
    );
  });

  it("warns when the chosen plugin can no longer fill the role", async () => {
    const { client } = fakeOwner([entry("tavi.browserview")], { uiRoles: { "browser-view": "acme.view" } });
    const page = await settings(client);
    expect(page.textContent).toContain("acme.view can no longer be the browser view");
    expect(selected(page.querySelector(ROLE))).toBe("acme.view");
  });

  it("says which contribution this page paused for flooding it with messages", async () => {
    const { client } = fakeOwner([entry("tavi.browserview"), entry("acme.view")]);
    const page = await settings(client);
    expect(page.textContent).not.toContain("Paused on this page");
    await act(async () => reportFlood(`acme.view/${contribution("acme.view").id}`));
    const row = [...page.querySelectorAll("li")].find((item) => item.textContent?.includes("acme.view/"));
    expect(row?.textContent).toContain("Paused on this page: it sent more than 200 messages a second.");
  });

  it("places a contribution, keeping its manifest's height, or hides it", async () => {
    const { client, writes } = fakeOwner([entry("tavi.browserview")]);
    const page = await settings(client);
    await pick(page.querySelector('[aria-label^="Where Browser"]'), "both");
    expect(JSON.parse(writes.at(-1)?.["value"] as string)).toEqual({
      "tavi.browserview/live": {
        slots: [{ slot: "chat.panel.top", show: "while-active", height: { min: 140, default: 220, max: 480 } }, { slot: "chat.panel.tab" }],
      },
    });
    await pick(page.querySelector('[aria-label^="Where Browser"]'), "heartbeat");
    expect(JSON.parse(writes.at(-1)?.["value"] as string)).toEqual({ "tavi.browserview/live": { slots: [{ slot: "center.heartbeat" }] } });
    await pick(page.querySelector('[aria-label^="Where Browser"]'), "hidden");
    expect(JSON.parse(writes.at(-1)?.["value"] as string)).toEqual({ "tavi.browserview/live": "hidden" });
    expect(selected(page.querySelector('[aria-label^="Where Browser"]'))).toBe("hidden");
  });

  it("turns the view off, and says so and reads again when the settings changed elsewhere meanwhile", async () => {
    const owner = fakeOwner([entry("tavi.browserview")]);
    const page = await settings(owner.client);
    await pick(page.querySelector(ROLE), "off");
    expect(owner.writes.at(-1)).toMatchObject({ action: "set", key: "uiRoles", value: JSON.stringify({ "browser-view": "off" }) });
    expect(page.textContent).toContain("The browser view is off.");
    owner.state.conflictNext = true;
    const reads = owner.state.reads;
    await pick(page.querySelector(ROLE), "tavi.browserview");
    expect(page.textContent).toContain("changed elsewhere meanwhile");
    expect(owner.state.reads).toBeGreaterThan(reads);
  });

  it("shows a placement set elsewhere as such, and the built-in as unavailable when it is", async () => {
    const owner = fakeOwner([entry("acme.view")], { uiPlacements: { "acme.view/live": { slots: [{ slot: "center.browser" }] } } });
    const page = await settings(owner.client);
    // The Center's Browser is one of the places offered, as are the heartbeat and Welcome.
    expect(selected(page.querySelector('[aria-label^="Where Acme browser"]'))).toBe("browser");
    expect(selected(page.querySelector(ROLE))).toBe("tavi.browserview");
    await open(page.querySelector(ROLE));
    expect(offeredWords()).toContain("Built-in (unavailable)");
  });
});
