import { afterEach, describe, expect, it } from "vitest";

import { CORE_BG } from "@tavi/contracts/locales/core-bg";
import { strayMenuPaths } from "@tavi/contracts/locales/core";
import { CORE_EN } from "@tavi/contracts/locales/core-en";

import { CENTER_SECTIONS, ROUTES, SETTINGS_VIEWS } from "../../../src/features/shell/route.js";
import { setLocale, translateCore } from "../../../src/lib/i18n.js";
import { bg } from "../../../src/locales/bg.js";
import { en } from "../../../src/locales/en.js";

/**
 * The canvas's places are labelled by the `core` nav keys, the ones the owner's messages build their menu paths
 * from ("Settings → Models"), so the nav and a path in a message cannot say different things.
 */

/** Another product's menu, not Tavi's: the ChatGPT sign-in note. */
const NOT_OURS = ["ChatGPT Settings → Usage"];

afterEach(async () => {
  await setLocale("en");
});

describe("the nav's labels", () => {
  it("reads the routes, Settings views and Center sections from the core nav keys", async () => {
    for (const locale of ["en", "bg"] as const) {
      await setLocale(locale);
      const core = locale === "en" ? CORE_EN : CORE_BG;
      expect(ROUTES.map((route) => route.label)).toEqual([
        core["nav.route.chat"],
        core["nav.route.ideas"],
        core["nav.route.center"],
        core["nav.route.settings"],
      ]);
      expect(SETTINGS_VIEWS.find((view) => view.value === "messaging")?.label).toBe(core["nav.settings.channels"]);
      expect(CENTER_SECTIONS.find((section) => section.value === "identity")?.label).toBe(core["nav.center.identity"]);
      expect(translateCore("nav.center.heartbeat")).toBe(core["nav.center.heartbeat"]);
    }
  });

  it("keeps no copy of them in the canvas's own catalogue", () => {
    const copies = Object.keys(en).filter(
      (key) =>
        /^shell\.route\.((chat|ideas|center|settings)$|settingsView\.|centerSection\.)/.test(key) ||
        key === "shell.sidebar.center.title" ||
        key === "center.rail.waitingOnYou" ||
        key === "center.rail.servers",
    );
    expect(copies).toEqual([]);
  });

  it("writes no menu path in the canvas's words that the nav does not have", () => {
    for (const { words, core } of [
      { words: en, core: CORE_EN },
      { words: bg, core: CORE_BG },
    ]) {
      const stray = Object.entries(words as Readonly<Record<string, string | Readonly<Record<string, string>>>>).flatMap(([key, message]) =>
        (typeof message === "string" ? [message] : Object.values(message)).flatMap((form) =>
          strayMenuPaths(form, core, NOT_OURS).map((path) => `${key}: ${path}`),
        ),
      );
      expect(stray).toEqual([]);
    }
  });
});
