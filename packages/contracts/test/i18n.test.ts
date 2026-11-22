import { describe, expect, it } from "vitest";
import {
  type CatalogFor,
  createTranslator,
  formatMessage,
  formatNumber,
  isLocale,
  PSEUDO_CLOSE,
  PSEUDO_OPEN,
  pluralCategory,
  pseudoLocalize,
} from "../src/i18n.js";

const en = {
  save: "Save",
  greet: "Hello, {name}",
  tasks: { one: "{count} task", other: "{count} tasks" },
  "only.english": "Only in English",
} as const;

const bg = {
  save: "Запази",
  greet: "Здравей, {name}",
  tasks: { one: "{count} задача", other: "{count} задачи" },
  "only.english": "Само на английски",
} as const satisfies CatalogFor<typeof en>;

describe("i18n", () => {
  it("knows the languages it speaks", () => {
    expect(isLocale("bg")).toBe(true);
    expect(isLocale("de")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it("says a key in the chosen language, with parameters", () => {
    const t = createTranslator({ en, bg }, "bg");
    expect(t("save")).toBe("Запази");
    expect(t("greet", { name: "Ана" })).toBe("Здравей, Ана");
  });

  it("chooses the plural form by the language's rules and writes the count for it", () => {
    const t = createTranslator({ en, bg }, "bg");
    expect(t("tasks", { count: 1 })).toBe("1 задача");
    expect(t("tasks", { count: 3 })).toBe("3 задачи");
    expect(t("tasks", { count: 20_000 })).toBe("20\u00a0000 задачи");
    expect(createTranslator({ en, bg }, "en")("tasks", { count: 20_000 })).toBe("20,000 tasks");
    expect(pluralCategory("bg", 0)).toBe("other");
  });

  it("falls back to English for a catalogue not loaded yet, and to the key for a key English lacks", () => {
    const t = createTranslator({ en }, "bg");
    expect(t("save")).toBe("Save");
    // English's plural rules pick the form, the reader's language writes the number.
    expect(t("tasks", { count: 1500 })).toBe("1500 tasks");
    expect((t as (key: string) => string)("missing.key")).toBe("missing.key");
  });

  it("falls back to the other form when a plural lacks the category", () => {
    expect(formatMessage({ other: "{count} items" }, "en", { count: 1 })).toBe("1 items");
    expect(formatMessage({ one: "one item", other: "{count} items" }, "en")).toBe("{count} items");
  });

  it("finds only a catalogue's own keys and a template's own parameters", () => {
    const t = createTranslator({ en, bg }, "bg") as (key: string, params?: Record<string, string>) => string;
    expect(t("toString")).toBe("toString");
    expect(t("constructor", { name: "x" })).toBe("constructor");
    expect(formatMessage("{constructor} and {toString}", "en", {})).toBe("{constructor} and {toString}");
  });

  it("leaves a parameter it was not given in place", () => {
    expect(formatMessage("Hello, {name}", "en", {})).toBe("Hello, {name}");
    expect(formatMessage("Hello, {name}", "en")).toBe("Hello, {name}");
  });

  it("writes numbers the way each language does", () => {
    expect(formatNumber(1.5, "bg")).toBe("1,5");
    expect(formatNumber(20_000, "en")).toBe("20,000");
    // Bulgarian groups digits only from five up: "1000", "10 000".
    expect(formatNumber(1000, "bg")).toBe("1000");
  });

  it("stretches and marks a pseudo-localised string", () => {
    const text = pseudoLocalize("Save the changes");
    expect(text.startsWith(PSEUDO_OPEN) && text.endsWith(PSEUDO_CLOSE)).toBe(true);
    expect(text.length).toBeGreaterThanOrEqual(Math.ceil("Save the changes".length * 1.35));
    expect(createTranslator({ en, bg }, "bg", { pseudo: true })("save").startsWith(`${PSEUDO_OPEN}Запази`)).toBe(true);
  });

  it("refuses a key the namespace does not have, at compile time", () => {
    const t = createTranslator({ en, bg }, "en");
    // @ts-expect-error: not a key of the catalogue.
    expect(t("nope")).toBe("nope");
    // @ts-expect-error: a Bulgarian catalogue missing a key does not satisfy English's shape.
    const partial: CatalogFor<typeof en> = { save: "Запази" };
    expect(partial.save).toBe("Запази");
  });
});
