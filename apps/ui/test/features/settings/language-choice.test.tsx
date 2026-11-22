// @vitest-environment jsdom
import type { WorkspaceSettingsAnswer } from "@tavi/contracts";
import type { Locale } from "@tavi/contracts/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserLocale, LanguageChoice } from "../../../src/features/settings/LanguageChoice.js";
import { currentLocale, setLocale } from "../../../src/lib/i18n.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { mountSettled as mount, settle, unmountAll } from "../../support/dom.js";
import { offeredWords, open, pick, selected } from "../../pick.js";

/**
 * The language picker: every language pack named in its own language, a pick
 * saved to `workspace.locale` and the page switched at once; Welcome's sets a
 * workspace with no language yet to the browser's, when Tavi speaks it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * An owner's workspace settings: `older` names no language in effect and
 * refuses the key, as an owner from before languages does; a write whose
 * revision is not the current one is refused, as the settings store does.
 */
function owner(stored?: Locale, { older = false }: { readonly older?: boolean } = {}) {
  let answer: WorkspaceSettingsAnswer = {
    workspaceId: "default",
    revision: 1,
    settings: stored === undefined ? {} : { locale: stored },
    effective: older ? { timezone: "UTC" } : { timezone: "UTC", locale: stored ?? "en" },
    hostTimezone: "UTC",
  };
  const writes: Record<string, unknown>[] = [];
  const client: SettingsClient = {
    request: (_command, payload) => {
      const body = payload as Record<string, unknown>;
      if (body["action"] === "set" && body["key"] === "locale") {
        writes.push(body);
        if (older || body["expectedRevision"] !== answer.revision) {
          return Promise.resolve({ ok: false, error: { code: "CONFLICT", message: "stale revision" } } as never);
        }
        const locale = body["value"] as Locale;
        answer = {
          ...answer,
          revision: answer.revision + 1,
          settings: { ...answer.settings, locale },
          effective: { ...answer.effective, locale },
        };
      }
      return Promise.resolve({ ok: true, result: answer } as never);
    },
  };
  /** Another save on the page (a timezone, Welcome's Tasks step) moves the revision on. */
  const elsewhere = (): void => {
    answer = { ...answer, revision: answer.revision + 1 };
  };
  return { client, writes, elsewhere };
}

/** What the owner answers for the workspace's settings now. */
async function settingsOf(client: SettingsClient): Promise<WorkspaceSettingsAnswer> {
  return ((await client.request("workspace-settings", { action: "get", workspaceId: "default" })) as { result: WorkspaceSettingsAnswer })
    .result;
}

afterEach(async () => {
  unmountAll();
  vi.unstubAllGlobals();
  await setLocale("en");
});

describe("the language picker", () => {
  it("names each language in its own words and shows the workspace's", async () => {
    const { client } = owner();
    const page = await mount(<LanguageChoice client={client} workspaceId="default" />);
    expect(page.querySelector("h2")?.textContent).toBe("Language");
    const trigger = page.querySelector('[aria-label="Language"]');
    expect(selected(trigger)).toBe("en");
    await open(trigger);
    expect(offeredWords()).toEqual(["English", "Български"]);
  });

  it("saves a pick to workspace.locale and switches the page", async () => {
    const { client, writes } = owner();
    const page = await mount(<LanguageChoice client={client} workspaceId="default" />);
    await pick(page.querySelector('[aria-label="Language"]'), "bg");
    expect(writes).toEqual([{ action: "set", workspaceId: "default", key: "locale", value: "bg", expectedRevision: 1 }]);
    await vi.waitFor(() => expect(currentLocale()).toBe("bg"));
  });

  it("in Welcome, sets a workspace with no language to the browser's Bulgarian", async () => {
    vi.stubGlobal("navigator", { languages: ["bg-BG", "en"] });
    const { client, writes } = owner();
    await mount(<LanguageChoice client={client} workspaceId="default" compact suggest />);
    await vi.waitFor(() => expect(currentLocale()).toBe("bg"));
    expect(writes.map((write) => write["value"])).toEqual(["bg"]);
  });

  it("leaves a language already chosen as it is, whatever the browser asks for", async () => {
    vi.stubGlobal("navigator", { languages: ["bg-BG"] });
    const { client, writes } = owner("en");
    await mount(<LanguageChoice client={client} workspaceId="default" compact suggest />);
    await settle();
    expect(writes).toEqual([]);
  });

  it("saves with the latest revision after another save on the page moved it on", async () => {
    const { client, writes, elsewhere } = owner();
    const page = await mount(<LanguageChoice client={client} workspaceId="default" compact />);
    elsewhere();
    await pick(page.querySelector('[aria-label="Language"]'), "bg");
    await vi.waitFor(() => expect(currentLocale()).toBe("bg"));
    expect(writes.map((write) => write["expectedRevision"])).toEqual([2]);
  });

  it("says why a refused pick was not saved and stays in its language", async () => {
    const { client } = owner();
    const settings = { answer: { ...(await settingsOf(client)), revision: 0 }, reload: vi.fn() };
    const page = await mount(<LanguageChoice client={client} workspaceId="default" settings={settings} />);
    await pick(page.querySelector('[aria-label="Language"]'), "bg");
    await settle();
    expect(page.textContent).toContain("stale revision");
    expect(settings.reload).toHaveBeenCalled();
    expect(currentLocale()).toBe("en");
  });

  it("offers nothing, and suggests nothing, on an owner from before languages", async () => {
    vi.stubGlobal("navigator", { languages: ["bg-BG"] });
    const { client, writes } = owner(undefined, { older: true });
    const page = await mount(<LanguageChoice client={client} workspaceId="default" compact suggest />);
    await settle();
    expect(page.querySelector('[aria-label="Language"]')).toBeNull();
    expect(writes).toEqual([]);
  });

  it("reads the browser's language down to the ones Tavi speaks", () => {
    expect(browserLocale(["bg-BG"])).toBe("bg");
    expect(browserLocale(["de-DE", "BG"])).toBe("bg");
    expect(browserLocale(["en-GB"])).toBe("en");
    expect(browserLocale(["de"])).toBeUndefined();
  });
});
