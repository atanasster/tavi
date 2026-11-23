import { IdeaDraftSchema } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { catalogueIdea, IDEA_CATALOGUE, ideaWordsIn, triggerScore, type IdeaTemplate } from "../../src/ideas/catalogue.js";
import { ideas as IDEAS_BG, ideaTriggers } from "../../src/ideas/locales/bg.js";
import { ideas as IDEAS_EN } from "../../src/ideas/locales/en.js";

/** The idea catalogue in Bulgarian: every idea's words, and the Bulgarian words that make it likelier. */

const FIELDS = ["title", "label", "pitch", "prompt"] as const;
/** Names a Bulgarian sentence keeps in Latin letters. */
const NAMES: ReadonlySet<string> = new Set(["EXIF", "Anki", "Home", "Assistant", "GEDCOM"]);
const template = (key: string): IdeaTemplate => IDEA_CATALOGUE.find((candidate) => candidate.key === key)!;
const placeholders = (text: string): number => text.match(/\[[^\]]+\]/gu)?.length ?? 0;

describe("the idea catalogue in Bulgarian", () => {
  it("gives every idea every field in Bulgarian, with no English left", () => {
    expect(Object.keys(IDEAS_BG).sort()).toEqual(Object.keys(IDEAS_EN).sort());
    for (const { key } of IDEA_CATALOGUE)
      for (const field of FIELDS) {
        const words = IDEAS_BG[`ideas.${key}.${field}` as keyof typeof IDEAS_BG];
        expect(words, `${key}.${field}`).toMatch(/\p{Script=Cyrillic}/u);
        expect(words).not.toBe(IDEAS_EN[`ideas.${key}.${field}` as keyof typeof IDEAS_EN]);
        for (const latin of words.match(/\p{Script=Latin}+/gu) ?? []) expect(NAMES, `${key}.${field}: ${latin}`).toContain(latin);
      }
  });

  it("keeps each prompt's blanks for the person to fill in", () => {
    for (const { key, prompt } of IDEA_CATALOGUE)
      expect(placeholders(IDEAS_BG[`ideas.${key}.prompt` as keyof typeof IDEAS_BG]), key).toBe(placeholders(prompt));
  });

  it("makes every idea a valid idea in Bulgarian, the same idea as in English", () => {
    for (const each of IDEA_CATALOGUE) {
      const english = catalogueIdea(each);
      const bulgarian = catalogueIdea(each, "bg");
      const parsed = IdeaDraftSchema.safeParse(bulgarian);
      expect(parsed.success, `${each.key}: ${parsed.error?.message}`).toBe(true);
      const { title, label, pitch, prompt, ...rest } = bulgarian;
      expect(rest).toEqual((({ title: _t, label: _l, pitch: _p, prompt: _q, ...same }) => same)(english));
      expect({ title, label, pitch, prompt }).toEqual(
        Object.fromEntries(FIELDS.map((field) => [field, IDEAS_BG[`ideas.${each.key}.${field}` as keyof typeof IDEAS_BG]])),
      );
    }
  });

  it("says the catalogue's English byte for byte in English or with no language named", () => {
    for (const each of IDEA_CATALOGUE) {
      expect(catalogueIdea(each, "en")).toEqual(catalogueIdea(each));
      for (const field of FIELDS) expect(catalogueIdea(each)[field]).toBe(IDEAS_EN[`ideas.${each.key}.${field}` as keyof typeof IDEAS_EN]);
    }
  });

  it("leaves a template whose words are not the catalogue's as written", () => {
    const fares = template("travel.fare-watch");
    const own = { ...fares, title: "I can watch Lisbon fares for May" };
    expect(ideaWordsIn(own, "bg")).toEqual({ title: own.title, label: own.label, pitch: own.pitch, prompt: own.prompt });
    // Only the prompt changed, by so much as a space, is still not the catalogue's English: all four stay as written.
    const promptOnly = { ...fares, prompt: `${fares.prompt} ` };
    expect(ideaWordsIn(promptOnly, "bg")).toEqual({
      title: fares.title,
      label: fares.label,
      pitch: fares.pitch,
      prompt: promptOnly.prompt,
    });
    const unknown = { ...fares, key: "travel.somewhere-else" };
    expect(ideaWordsIn(unknown, "bg").prompt).toBe(fares.prompt);
    expect(ideaWordsIn(fares, "bg").prompt).toBe(IDEAS_BG["ideas.travel.fare-watch.prompt"]);
  });

  it("gives every idea Bulgarian triggers, each found as a word of its own", () => {
    for (const { key, triggers } of IDEA_CATALOGUE) {
      const bulgarian = ideaTriggers[key as keyof typeof ideaTriggers];
      expect(bulgarian.length, key).toBeGreaterThan(0);
      expect(new Set(bulgarian).size, key).toBe(bulgarian.length);
      for (const trigger of bulgarian) {
        expect(trigger).toBe(trigger.toLowerCase());
        expect(trigger, key).toMatch(/^[\p{Script=Cyrillic}][\p{Script=Cyrillic} -]*$/u);
        expect(triggers).toContain(trigger);
        expect(triggerScore({ ...template(key), triggers: [trigger] }, `… ${trigger.toUpperCase()}, …`), `${key}: ${trigger}`).toBe(1);
      }
      // A phrase is never listed beside its own last words, so one mention counts once — but car rental, which English
      // counts twice too ("car rental", "rental").
      const doubled = bulgarian.flatMap((phrase) =>
        bulgarian.filter((word) => word !== phrase && ` ${phrase}`.endsWith(` ${word}`)).map((word) => `${phrase} ⊃ ${word}`),
      );
      expect(doubled, key).toEqual(key === "travel.car-or-rail" ? ["кола под наем ⊃ под наем"] : []);
    }
  });

  it("brings up the idea a Bulgarian note is about first, as the provider ranks by words alone", () => {
    // The provider's order without a model: most triggers mentioned first, then catalogue order.
    const ranked = (note: string): readonly string[] =>
      IDEA_CATALOGUE.map((each, order) => ({ key: each.key, hits: triggerScore(each, note), order }))
        .filter((entry) => entry.hits > 0)
        .sort((a, b) => b.hits - a.hits || a.order - b.order)
        .map((entry) => entry.key);
    const cases: readonly (readonly [note: string, first: string])[] = [
      ["Искам кола под наем за уикенда", "travel.car-or-rail"],
      ["Търсим апартамент под наем в Лозенец", "health-home.rental-watch"],
      ["Кучето ми се изгуби вчера в парка", "health-home.lost-pet"],
      ["Кучето ще остане в хотел за животни, докато пътувам", "health-home.pet-vaccines"],
      ["Котката има нужда от ваксина преди пансиона", "health-home.pet-vaccines"],
      ["Планирам пътуване до Лисабон и търся евтини полети", "travel.fare-watch"],
      ["Подготвям се за изпита за сертификат по облачни технологии", "learning.exam-prep"],
      ["Взимам детето от тренировка заедно с другите родители", "people.carpool"],
      ["Какво да облека утре според прогнозата за времето", "shopping.outfit"],
      ["Отглеждам домати и разсад на балкона", "learning.garden-plan"],
      ["Абонаментите ми излизат скъпо, искам да прекратя някои", "productivity.subscriptions"],
      ["Пощата ми е пълна с непрочетени имейли", "productivity.inbox-triage"],
    ];
    for (const [note, first] of cases) expect(ranked(note)[0], note).toBe(first);
    // A car to rent is not a flat to rent: the rental listings do not come up for it at all.
    expect(ranked("Искам кола под наем за уикенда")).not.toContain("health-home.rental-watch");
    // Everyday words with another meaning bring up nothing of their own.
    expect(ranked("Времето лети")).not.toContain("shopping.outfit");
    expect(ranked("Боли ме шия")).not.toContain("shopping.mending");
    expect(ranked("Даде ми разрешение за достъп")).not.toContain("health-home.school-forms");
    expect(ranked("Каква е темата на срещата")).not.toContain("work.trend-radar");
    expect(ranked("Имам малко свободно време")).not.toContain("learning.language");
    expect(ranked("Отивам на пазар за зеленчуци")).not.toContain("work.trend-radar");
  });

  it("scores Bulgarian words as whole words, in any case, inflected as a person writes them", () => {
    const fares = template("travel.fare-watch");
    expect(triggerScore(fares, "Планирам ПЪТУВАНЕ до Лисабон; трябват ми полети.")).toBe(2);
    expect(triggerScore(fares, "Полетите до Лисабон поскъпнаха")).toBe(1);
    expect(triggerScore(fares, "самолетоносач и прелетите птици")).toBe(0);
    const rental = template("health-home.rental-watch");
    expect(triggerScore(rental, "Търсим квартира в София")).toBe(1);
    expect(triggerScore(rental, "Търсим апартамент под наем")).toBe(2);
    // A Bulgarian note and an English one count alike: a person may write both.
    expect(triggerScore(fares, "Trip to Lisbon — пътуване през май")).toBe(2);
  });
});
