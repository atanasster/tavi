// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Loading a language's catalogue: a choice made while an earlier one is still
 * loading wins, and a catalogue that fails to load changes nothing. Each test
 * imports the store afresh, with the Bulgarian chunk replaced.
 */

afterEach(() => {
  vi.doUnmock("../../src/locales/bg.js");
  vi.resetModules();
  window.localStorage.clear();
  document.documentElement.lang = "";
});

describe("loading a language's catalogue", () => {
  it("keeps the newer choice when an older one's catalogue lands after it", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    vi.doMock("../../src/locales/bg.js", async () => {
      await gate;
      return { bg: { "settings.language.label": "Език", "settings.language.hint": "" } };
    });
    const store = await import("../../src/lib/i18n.js");
    const slow = store.setLocale("bg");
    await store.setLocale("en");
    release();
    await slow;
    expect(store.currentLocale()).toBe("en");
    expect(store.translateNow("settings.language.label")).toBe("Language");
    expect(document.documentElement.lang).toBe("en");
    expect(store.storedLocale()).toBe("en");
  });

  it("changes nothing when the catalogue does not load", async () => {
    vi.doMock("../../src/locales/bg.js", () => {
      throw new Error("chunk failed");
    });
    const store = await import("../../src/lib/i18n.js");
    await store.setLocale("bg");
    expect(store.currentLocale()).toBe("en");
    expect(store.translateNow("settings.language.label")).toBe("Language");
    expect(window.localStorage.getItem(store.LOCALE_STORAGE_KEY)).toBeNull();
  });
});
