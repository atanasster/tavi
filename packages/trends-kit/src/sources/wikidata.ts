import { drift, failureOf, objectOf, query, stringOf } from "./common.js";
import type { ReadOutcome, SourceCall, SourceRequest, SourceResponse } from "./types.js";

/**
 * Wikidata: a topic's names in each language and its
 * Wikipedia article in each edition, from one entity. CC0. It never votes on
 * a spike (`kind: reference`); it widens what the other sources are asked.
 */
const API = "https://www.wikidata.org/w/api.php";

/** The entity a term names, in a language: the first match's id. */
export const wikidataSearch = {
  request: (term: string, language: string): SourceRequest => ({
    url: `${API}?${query({ action: "wbsearchentities", search: term, language, limit: 1, format: "json" })}`,
    expect: "json",
  }),
  parse(response: SourceResponse, call: SourceCall): ReadOutcome<string | undefined> {
    const failed = failureOf(response, call.now);
    if (failed !== undefined) return failed;
    const search = objectOf(response.body)?.["search"];
    if (!Array.isArray(search)) return drift("no search");
    const id = stringOf(objectOf(search[0])?.["id"]);
    return { kind: "ok", value: id !== undefined && /^Q\d+$/.test(id) ? id : undefined };
  },
};

/** What an entity gives a topic: its terms by language and its article by edition. */
export interface WikidataExpansion {
  readonly qid: string;
  readonly terms: Readonly<Record<string, readonly string[]>>;
  /** `ja.wikipedia` → `全固体電池`. */
  readonly articles: Readonly<Record<string, string>>;
}

/** Labels and aliases a language at most: a topic keeps 20 terms a language. */
const TERMS_PER_LANGUAGE = 6;

export const wikidataEntity = {
  request: (qid: string, languages: readonly string[]): SourceRequest => ({
    url: `${API}?${query({ action: "wbgetentities", ids: qid, props: "labels|aliases|sitelinks", languages: languages.join("|"), sitefilter: languages.map((language) => `${language.replace(/-/g, "_")}wiki`).join("|"), format: "json" })}`,
    expect: "json",
  }),
  parse(response: SourceResponse, qid: string, call: SourceCall): ReadOutcome<WikidataExpansion> {
    const failed = failureOf(response, call.now);
    if (failed !== undefined) return failed;
    const entity = objectOf(objectOf(objectOf(response.body)?.["entities"])?.[qid]);
    if (entity === undefined) return drift(`no entity ${qid}`);
    const terms: Record<string, string[]> = {};
    const add = (language: string, value: unknown): void => {
      const text = stringOf(value)?.trim();
      if (text === undefined || text.length > 100) return;
      const list = (terms[language] ??= []);
      if (list.length < TERMS_PER_LANGUAGE && !list.some((term) => term.toLowerCase() === text.toLowerCase())) list.push(text);
    };
    for (const [language, label] of Object.entries(objectOf(entity["labels"]) ?? {})) add(language, objectOf(label)?.["value"]);
    for (const [language, aliases] of Object.entries(objectOf(entity["aliases"]) ?? {}))
      if (Array.isArray(aliases)) for (const alias of aliases) add(language, objectOf(alias)?.["value"]);
    const articles: Record<string, string> = {};
    for (const [site, link] of Object.entries(objectOf(entity["sitelinks"]) ?? {})) {
      const title = stringOf(objectOf(link)?.["title"]);
      const edition = /^([a-z_]+)wiki$/.exec(site)?.[1];
      if (title !== undefined && edition !== undefined) articles[`${edition.replace(/_/g, "-")}.wikipedia`] = title;
    }
    return { kind: "ok", value: { qid, terms, articles } };
  },
};
