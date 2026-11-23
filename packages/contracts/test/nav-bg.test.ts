import { describe, expect, it } from "vitest";

import { englishOf, keyedError, MEMORY_CARD_OPEN_HINT, navPath, renderTextRef, textRef, type NavKey } from "../src/index.js";
import { CORE_BG } from "../src/locales/core-bg.js";
import { navPathIn, strayMenuPaths } from "../src/locales/core.js";
import { CORE_EN } from "../src/locales/core-en.js";
import { coreIn } from "../src/locales/core-server.js";
import { nav } from "../src/locales/en/nav.js";

/**
 * Menu paths in messages ("Settings → Models") come from the nav's own labels, the keys the canvas's routes,
 * Settings views and Command Center sections read, so a path cannot name a place the nav calls something else.
 */

const bg = coreIn("bg");

/** The canvas's places: the English nav catalogue's keys, less its path templates. */
const NAV_KEYS = Object.keys(nav).filter((key) => !key.startsWith("nav.path.")) as NavKey[];

function forms(message: string | { readonly [form: string]: string | undefined }): readonly string[] {
  return typeof message === "string" ? [message] : Object.values(message).filter((form): form is string => form !== undefined);
}

describe("menu paths from the nav's labels", () => {
  it("has a key for each of the canvas's places, its English the canvas's label", () => {
    const navKeys = Object.keys(CORE_EN).filter((key) => key.startsWith("nav.") && !key.startsWith("nav.path."));
    expect(navKeys.sort()).toEqual([...NAV_KEYS].sort());
    for (const key of NAV_KEYS) expect(CORE_EN[key], key).toBe(nav[key]);
    expect([CORE_EN["nav.route.settings"], CORE_EN["nav.settings.models"], CORE_EN["nav.center.heartbeat"]]).toEqual([
      "Settings",
      "Models",
      "Heartbeat",
    ]);
    expect(CORE_EN["nav.route.commandCenter"]).toBe("Command Center");
    expect(CORE_EN["nav.center.waitingOnYou"]).toBe("Waiting on you");
  });

  it("keeps the canvas's Bulgarian labels", () => {
    expect([CORE_BG["nav.route.settings"], CORE_BG["nav.settings.models"], CORE_BG["nav.center.heartbeat"]]).toEqual([
      "Настройки",
      "Модели",
      "Пулс",
    ]);
    expect(CORE_BG["nav.route.commandCenter"]).toBe("Команден център");
    expect(CORE_BG["nav.center.waitingOnYou"]).toBe("Чака теб");
  });

  it("says a path by reference in the reader's language, and the same words as a catalogue writes it", () => {
    const models = navPath("nav.route.settings", "nav.settings.models");
    expect(englishOf(models)).toBe("Settings → Models");
    expect(renderTextRef(models, bg)).toBe("Настройки → Модели");
    const servers = navPath("nav.route.center", "nav.center.waitingOnYou", "nav.center.servers");
    expect(englishOf(servers)).toBe("Center → Waiting on you → Servers");
    expect(renderTextRef(servers, bg)).toBe("Център → Чака теб → Сървъри");
    expect(navPathIn(CORE_EN, "nav.route.settings", "nav.settings.models")).toBe(englishOf(models));
    expect(navPathIn(CORE_BG, "nav.route.center", "nav.center.waitingOnYou", "nav.center.servers")).toBe(renderTextRef(servers, bg));
  });

  it("leaves the English of messages that name a place as it was", () => {
    expect(keyedError("NOT_CONFIGURED", "error.channels.connectFromPage", { channel: "Gmail" }).message).toBe(
      "Gmail signs in through this page: connect it from Settings → Channels in `tavi ui`",
    );
    expect(keyedError("NOT_AUTHORIZED", "error.routine.ownerRevoked", { owner: "sam", action: "run" }).message).toBe(
      "sam is no longer allowed in this workspace: their routine can be viewed or archived, not run. Allow them again in Settings → Allowed people to use it.",
    );
    expect(englishOf(textRef("error.channels.signInNeedsEncryption", { channel: "Gmail" }))).toBe(
      "Connecting Gmail keeps a sign-in token: turn on credential encryption first (`tavi credentials encrypt`, or Encrypt credentials in Settings → Channels)",
    );
    expect(englishOf(textRef("app.connect.need.notSetUp", { app: "Maps" }))).toBe(
      "Maps isn't signed in yet. Open Tavi on your computer → Connected apps.",
    );
    expect(MEMORY_CARD_OPEN_HINT).toBe("Open Tavi to review: Center → Soul & memory.");
  });

  it("says a keyed error's path in Bulgarian", () => {
    expect(renderTextRef(textRef("error.apps.configureInChannels", { app: "Gmail" }), bg)).toBe(
      "Настройките на Gmail са в Настройки → Канали",
    );
    expect(renderTextRef(textRef("app.connect.need.signInAgain", { app: "Maps" }), bg)).toBe(
      "Maps иска да влезеш отново. Отвори Tavi на компютъра си → Свързани приложения.",
    );
  });

  it("writes no path in a core message that the nav does not have", () => {
    // Another product's menus, named as that product shows them: not Tavi's nav.
    const elsewhere = ["ChatGPT Settings → Usage", "Settings → Integrations → Developer"];
    for (const words of [CORE_EN, CORE_BG]) {
      const stray = Object.entries(words as Readonly<Record<string, string | Readonly<Record<string, string>>>>)
        .filter(([key]) => !key.startsWith("nav."))
        .flatMap(([key, message]) =>
          forms(message).flatMap((form) => strayMenuPaths(form, words, elsewhere).map((path) => `${key}: ${path}`)),
        );
      expect(stray).toEqual([]);
    }
  });

  it("finds a path the nav does not have, at any hop, a label matched whole", () => {
    expect(strayMenuPaths("Open Settings → Models.", CORE_EN)).toEqual([]);
    expect(strayMenuPaths("Open Center → Waiting on you → Servers", CORE_EN)).toEqual([]);
    expect(strayMenuPaths("Open Command Center → Soul & memory.", CORE_EN)).toEqual([]);
    expect(strayMenuPaths("Отвори Команден център → Душа и памет.", CORE_BG)).toEqual([]);
    expect(strayMenuPaths("Open Settings → Search.", CORE_EN)).toHaveLength(1);
    expect(strayMenuPaths("Open Settings → Heartbeat.", CORE_EN)).toHaveLength(1);
    expect(strayMenuPaths("Open Center → Models.", CORE_EN)).toHaveLength(1);
    expect(strayMenuPaths("Open Settings → Modelsets.", CORE_EN)).toHaveLength(1);
    expect(strayMenuPaths("Open Center → Waiting on you → Models.", CORE_EN)).toHaveLength(1);
    expect(strayMenuPaths("Open Settings → General → Flight search.", CORE_EN)).toHaveLength(1);
    expect(strayMenuPaths("Отвори Команден център → Модели.", CORE_BG)).toHaveLength(1);
    expect(strayMenuPaths("ChatGPT Settings → Usage shows it.", CORE_EN, ["ChatGPT Settings → Usage"])).toEqual([]);
  });
});
