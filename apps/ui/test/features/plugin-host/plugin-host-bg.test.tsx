// @vitest-environment jsdom
import type { PluginUiEntry } from "@tavi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChatPanelTop } from "../../../src/features/plugin-host/ChatPanelTop.js";
import { PluginPanelTab } from "../../../src/features/plugin-host/PluginPanelTab.js";
import type { PluginFrameClient } from "../../../src/features/plugin-host/PluginFrame.js";
import { contributionsForSlot, resolveContributions } from "../../../src/features/plugin-host/slots.js";
import { setLocale } from "../../../src/lib/i18n.js";
import { mount, unmountAll } from "../../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The plugin host's own words in Bulgarian: the slot's show, hide and resize, the tab's Expand, and Take control. */

beforeEach(async () => {
  await setLocale("bg");
});

afterEach(async () => {
  unmountAll();
  window.sessionStorage.clear();
  await setLocale("en");
});

const entry: PluginUiEntry = {
  pluginId: "acme.view",
  kind: "external",
  contentHash: "a".repeat(64),
  ui: {
    abi: "tavi.ui/1",
    contributions: [
      {
        id: "live",
        role: "browser-view",
        title: "Browser",
        document: "live.html",
        channels: ["browser.live"],
        disclosure: "Images.",
        placements: [{ slot: "chat.panel.top", show: "always" }, { slot: "chat.panel.tab" }],
      },
    ],
  },
};
const { contributions } = resolveContributions([entry], { uiRoles: { "browser-view": "acme.view" } });
const live: PluginFrameClient = { liveWatch: async () => ({ response: { ok: true } }) };
const labels = (page: HTMLElement): string[] =>
  [...page.querySelectorAll("[aria-label]")].map((element) => element.getAttribute("aria-label") ?? "");

const ENGLISH = ["Hide Browser", "Show Browser", "Resize Browser", "Take control", "Expand the browser view", "Shrink the browser view"];

describe("the plugin host in Bulgarian", () => {
  it("labels the top slot's hide, resize and Take control", async () => {
    const page = await mount(
      <ChatPanelTop
        items={contributionsForSlot(contributions, "chat.panel.top")}
        client={live}
        context={{ workspaceId: "default", taskId: "t1" }}
        active={{ running: true, browser: true }}
        sheet="full"
        onTakeOver={() => undefined}
      />,
    );
    expect(labels(page)).toContain("Скрий „Browser“");
    expect(labels(page)).toContain("Промени височината на „Browser“");
    expect(page.textContent).toContain("Поеми браузъра");
    for (const word of ENGLISH) {
      expect(page.textContent).not.toContain(word);
      expect(labels(page)).not.toContain(word);
    }
  });

  it("labels the browser tab's Expand", async () => {
    const tab = contributionsForSlot(contributions, "chat.panel.tab")[0];
    if (tab === undefined) throw new Error("no tab contribution");
    const page = await mount(
      <PluginPanelTab
        item={tab}
        client={live}
        context={{ workspaceId: "default", taskId: "t1" }}
        visible
        expanded={false}
        onExpanded={() => undefined}
        onTakeOver={() => undefined}
        attention
        onNavigate={() => undefined}
        onShortcut={() => undefined}
        onBadge={() => undefined}
      />,
    );
    expect(labels(page)).toContain("Уголеми изгледа на браузъра");
    expect(page.textContent).toContain("Поеми браузъра");
    for (const word of ENGLISH) {
      expect(page.textContent).not.toContain(word);
      expect(labels(page)).not.toContain(word);
    }
  });
});
