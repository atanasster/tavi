import type { CountPoint } from "../contracts.js";
import { WIKIPEDIA_PAGEVIEWS } from "../records.js";
import { bucketStart } from "../store/store.js";
import { bucketsOf, drift, failureOf, numberOf, objectOf, stringOf } from "./common.js";
import type { TrendsAdapter } from "./types.js";

/**
 * Wikipedia pageviews: CC0, every language, back to 2015. Per
 * article only daily, a day behind; the top 1,000 a day per edition. Views by
 * people (`agent=user`), not spiders.
 */
const BASE = "https://wikimedia.org/api/rest_v1/metrics/pageviews";
const DAY_MS = 86_400_000;
const compact = (iso: string): string => iso.slice(0, 10).replace(/-/g, "");

/**
 * The edition that speaks for a country's attention: its main language's, or
 * English where readers mostly use it (Hindi Wikipedia ranks
 * about 25th). An edition is a language, not a country.
 */
export const COUNTRY_EDITION: Readonly<Record<string, string>> = {
  JP: "ja",
  DE: "de",
  AT: "de",
  CH: "de",
  FR: "fr",
  BE: "fr",
  IT: "it",
  ES: "es",
  MX: "es",
  AR: "es",
  CO: "es",
  CL: "es",
  PE: "es",
  BR: "pt",
  PT: "pt",
  RU: "ru",
  UA: "uk",
  PL: "pl",
  NL: "nl",
  TR: "tr",
  KR: "ko",
  CN: "zh",
  TW: "zh",
  HK: "zh",
  VN: "vi",
  ID: "id",
  TH: "th",
  IR: "fa",
  SA: "ar",
  EG: "ar",
  AE: "ar",
  IL: "he",
  SE: "sv",
  NO: "no",
  FI: "fi",
  DK: "da",
  CZ: "cs",
  HU: "hu",
  RO: "ro",
  GR: "el",
  BG: "bg",
};

/** Pages that top every day's list and say nothing about a topic: main pages, specials, other namespaces. */
const notAnArticle = (title: string): boolean =>
  title === "-" ||
  title.includes(":") ||
  /^(Main_Page|メインページ|Hauptseite|Wikipédia:Accueil_principal|Pagina_principale|Заглавная_страница)$/.test(title);

export const wikipediaPageviews: TrendsAdapter = {
  record: WIKIPEDIA_PAGEVIEWS,
  counts: {
    // Daily only; an hourly window reads nothing here.
    request: ({ topic, window }) =>
      window.bucket !== "day"
        ? []
        : Object.entries(topic.articles)
            .slice(0, 8)
            .map(([project, article]) => ({
              url: `${BASE}/per-article/${encodeURIComponent(project)}/all-access/user/${encodeURIComponent(article.replace(/ /g, "_"))}/daily/${compact(window.from)}/${compact(new Date(Date.parse(window.to) - DAY_MS).toISOString())}`,
              expect: "json",
              tag: project,
            })),
    parse: (response, _request, { window }, call) => {
      // A day not yet published (today, and yesterday until it lands) is missing; an earlier day it skipped had no views.
      const published = bucketStart(new Date(Date.parse(call.now) - DAY_MS).toISOString(), "day");
      // An article with no views in the window answers 404.
      if (response.status === 404)
        return {
          kind: "ok",
          value: [
            {
              metric: "views",
              points: bucketsOf(window).map(
                (start): CountPoint => (start >= published ? { start, value: 0, quality: "missing" } : { start, value: 0, quality: "ok" }),
              ),
            },
          ],
        };
      const failed = failureOf(response, call.now);
      if (failed !== undefined) return failed;
      const items = objectOf(response.body)?.["items"];
      if (!Array.isArray(items)) return drift("no items");
      const views = new Map<string, number>();
      for (const item of items) {
        const stamp = stringOf(objectOf(item)?.["timestamp"]);
        const count = numberOf(objectOf(item)?.["views"]);
        if (stamp === undefined || count === undefined || !/^\d{10}$/.test(stamp)) continue;
        views.set(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T00:00:00.000Z`, count);
      }
      const points: CountPoint[] = bucketsOf(window).map((start) =>
        start >= published && !views.has(start)
          ? { start, value: 0, quality: "missing" }
          : { start, value: views.get(start) ?? 0, quality: "ok" },
      );
      return { kind: "ok", value: [{ metric: "views", points }] };
    },
  },
  trending: {
    request: ({ country }, call) => {
      const day = new Date(Date.parse(call.now) - DAY_MS).toISOString();
      const project = `${COUNTRY_EDITION[country] ?? "en"}.wikipedia`;
      return [
        {
          url: `${BASE}/top/${project}/all-access/${day.slice(0, 4)}/${day.slice(5, 7)}/${day.slice(8, 10)}`,
          expect: "json",
          tag: project,
        },
      ];
    },
    parse: (response, request, _input, call) => {
      // Yesterday's list lands some hours into the day; before it, there is no list yet, which is not a failure.
      if (response.status === 404) return { kind: "ok", value: [] };
      const failed = failureOf(response, call.now);
      if (failed !== undefined) return failed;
      const items = objectOf(response.body)?.["items"];
      const articles = objectOf(Array.isArray(items) ? items[0] : undefined)?.["articles"];
      if (!Array.isArray(articles)) return drift("no articles");
      const project = request.tag ?? "en.wikipedia";
      const top = articles
        .flatMap((entry) => {
          const title = stringOf(objectOf(entry)?.["article"]);
          const views = numberOf(objectOf(entry)?.["views"]);
          return title === undefined || views === undefined || notAnArticle(title) ? [] : [{ title, views }];
        })
        .slice(0, 25);
      return {
        kind: "ok",
        value: top.map((entry, index) => ({
          title: entry.title.replace(/_/g, " "),
          url: `https://${project.replace(".wikipedia", "")}.wikipedia.org/wiki/${encodeURIComponent(entry.title)}`,
          rank: index + 1,
          volume: entry.views,
          volumeLabel: `${entry.views.toLocaleString("en")} views`,
        })),
      };
    },
  },
};
