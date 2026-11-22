// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { en } from "../../src/locales/en.js";
import { bg } from "../../src/locales/bg.js";
import { currentLocale, LOCALE_STORAGE_KEY, setLocale, storedLocale, translateNow, useLocale, useT } from "../../src/lib/i18n.js";
import { mount } from "../support/dom.js";

/**
 * The canvas's language: English until told otherwise, Bulgarian's catalogue
 * loaded when chosen, every view re-rendered, `<html lang>` and this browser's
 * copy kept in step.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Label() {
  const t = useT();
  const locale = useLocale();
  return (
    <p lang={locale} data-testid="label">
      {t("settings.language.label")}
    </p>
  );
}

afterEach(async () => {
  await act(async () => setLocale("en"));
  window.localStorage.clear();
});

describe("the canvas's language", () => {
  it("speaks English until a language is chosen", () => {
    expect(currentLocale()).toBe("en");
    expect(translateNow("settings.language.label")).toBe("Language");
  });

  it("switches a mounted view to Bulgarian once its catalogue loads, and keeps the choice", async () => {
    const host = await mount(<Label />);
    expect(host.textContent).toBe("Language");
    await act(async () => setLocale("bg"));
    expect(host.textContent).toBe("Език");
    expect(host.querySelector("p")?.lang).toBe("bg");
    expect(document.documentElement.lang).toBe("bg");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("bg");
    expect(storedLocale()).toBe("bg");
    await act(async () => setLocale("en"));
    expect(host.textContent).toBe("Language");
    expect(document.documentElement.lang).toBe("en");
  });

  it("reads English from storage that holds nothing, or a language it does not speak", () => {
    expect(storedLocale()).toBe("en");
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "de");
    expect(storedLocale()).toBe("en");
  });

  it("has a Bulgarian word for every English one", () => {
    expect(Object.keys(bg).sort()).toEqual(Object.keys(en).sort());
  });
});
