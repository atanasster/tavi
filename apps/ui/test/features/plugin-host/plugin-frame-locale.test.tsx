// @vitest-environment jsdom
import type { PluginUiEntry } from "@tavi/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PluginFrame } from "../../../src/features/plugin-host/PluginFrame.js";
import { usePluginContributions } from "../../../src/features/plugin-host/contributions.js";
import type { ResolvedContribution } from "../../../src/features/plugin-host/slots.js";
import { setLocale } from "../../../src/lib/i18n.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { mount, rerender, settle, unmountAll } from "../../support/dom.js";

/**
 * The host's side of a plugin's language over `tavi.ui/1`: `init` carries the
 * canvas's language and the plugin's own words in it, and a change is told as `locale`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  unmountAll();
  await setLocale("en");
});

const abi = "tavi.ui/1";
const contribution: PluginUiEntry["ui"]["contributions"][number] = {
  id: "notes",
  title: "Notes",
  document: "notes.html",
  channels: [],
  placements: [{ slot: "chat.panel.tab" }],
};
const resolvedWith = (language: Partial<Pick<ResolvedContribution, "locale" | "messages">> = {}): ResolvedContribution => ({
  pluginId: "acme.notes",
  contentHash: "a".repeat(64),
  builtin: false,
  contribution,
  placements: contribution.placements,
  ...language,
});
const BG = { locale: "bg" as const, messages: { hello: "Здравей" } };

async function frameWith(resolved: ResolvedContribution) {
  const element = (current: ResolvedContribution) => (
    <PluginFrame resolved={current} slot="chat.panel.tab" context={{ workspaceId: "default" }} client={{}} visible />
  );
  const page = await mount(element(resolved));
  const iframe = page.querySelector("iframe");
  if (iframe === null || iframe.contentWindow === null) throw new Error("no frame");
  const posted: Record<string, unknown>[] = [];
  vi.spyOn(iframe.contentWindow, "postMessage").mockImplementation(
    (message: unknown) => void posted.push(message as Record<string, unknown>),
  );
  const ready = async (): Promise<void> => {
    await act(async () =>
      window.dispatchEvent(new MessageEvent("message", { data: { abi, type: "ready" }, source: iframe.contentWindow })),
    );
    await settle();
  };
  const redraw = async (next: ResolvedContribution): Promise<void> => {
    await rerender(element(next));
    await settle();
  };
  const locales = () => posted.filter((message) => message["type"] === "locale");
  return { posted, ready, redraw, locales };
}

describe("a plugin frame's language", () => {
  it("tells an English canvas's plugin its language and no words, as an older plugin can ignore", async () => {
    const { posted, ready } = await frameWith(resolvedWith());
    await ready();
    expect(posted[0]).toMatchObject({ abi, type: "init", locale: "en" });
    expect(posted[0]).not.toHaveProperty("messages");
  });

  it("gives init the plugin's words in the canvas's language, only when its entry was served in that one", async () => {
    await setLocale("bg");
    const { posted, ready } = await frameWith(resolvedWith(BG));
    await ready();
    expect(posted[0]).toMatchObject({ type: "init", locale: "bg", messages: { hello: "Здравей" } });
    unmountAll();
    await setLocale("en");
    // An entry read before the canvas switched: its Bulgarian words are not given to an English canvas.
    const stale = await frameWith(resolvedWith(BG));
    await stale.ready();
    expect(stale.posted[0]).toMatchObject({ type: "init", locale: "en" });
    expect(stale.posted[0]).not.toHaveProperty("messages");
  });

  it("tells a change of language as `locale`, once, and nothing for the same words read again", async () => {
    const { ready, redraw, locales } = await frameWith(resolvedWith());
    // Before the plugin is ready, nothing is told: its init will say it.
    await act(async () => setLocale("bg"));
    await settle();
    expect(locales()).toEqual([]);
    await ready();
    await redraw(resolvedWith(BG));
    expect(locales()).toEqual([{ abi, type: "locale", locale: "bg", messages: { hello: "Здравей" } }]);
    // The list read again: equal words in new objects.
    await redraw(resolvedWith({ locale: "bg", messages: { hello: "Здравей" } }));
    expect(locales()).toHaveLength(1);
    await act(async () => setLocale("en"));
    await settle();
    expect(locales().at(-1)).toEqual({ abi, type: "locale", locale: "en" });
  });
});

describe("the contributions' language", () => {
  it("reads the owner's list again when the canvas's language changes, with titles and words in it", async () => {
    let served: PluginUiEntry = {
      pluginId: "acme.notes",
      kind: "external",
      version: "1.0.0",
      contentHash: "a".repeat(64),
      ui: { abi, contributions: [contribution] },
    };
    let reads = 0;
    const client: SettingsClient = {
      request: async (command) => {
        if (command !== "plugins")
          return {
            ok: true,
            result: { workspaceId: "default", revision: 1, settings: {}, effective: { timezone: "UTC" }, hostTimezone: "UTC" },
          };
        reads += 1;
        return { ok: true, result: { entries: [served] } };
      },
    };
    const seen: (readonly [string, string | undefined, unknown])[] = [];
    function Probe() {
      const { contributions } = usePluginContributions(client, "default", true, 0);
      const [first] = contributions;
      if (first !== undefined) seen.push([first.contribution.title, first.locale, first.messages]);
      return null;
    }
    await mount(<Probe />);
    await settle();
    expect(reads).toBe(1);
    expect(seen.at(-1)).toEqual(["Notes", undefined, undefined]);
    served = { ...served, ui: { abi, contributions: [{ ...contribution, title: "Бележки" }] }, ...BG };
    await act(async () => setLocale("bg"));
    await settle();
    expect(reads).toBe(2);
    expect(seen.at(-1)).toEqual(["Бележки", "bg", { hello: "Здравей" }]);
  });
});
