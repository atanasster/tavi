import type { CountPoint, RawItem } from "../contracts.js";
import { GDELT_DOC } from "../records.js";
import { bucketStart } from "../store/store.js";
import { bucketsOf, drift, failureOf, isoOf, numberOf, objectOf, query, rebucket, retryAfterMs, stringOf } from "./common.js";
import type { AdapterTopic, ReadOutcome, SourceResponse, TrendsAdapter, Window } from "./types.js";

/**
 * GDELT's DOC 2.0 API: article counts over time with the total
 * it monitored (`norm`), and article lists, across 65 machine-translated
 * languages. One request every 5 seconds per IP; answers 10–36 s and hours
 * behind. Citation and a link to GDELT are required.
 */
const API = "https://api.gdeltproject.org/api/v2/doc/doc";
const stamp = (iso: string): string => iso.slice(0, 19).replace(/[-:T]/g, "");
const phrase = (term: string): string => `"${term.replace(/"/g, "")}"`;

/** The topic as a GDELT query: its terms OR'ed, its exclusions negated. */
export function gdeltQuery(topic: AdapterTopic): string | undefined {
  const terms = topic.terms.filter((term) => term.length >= 3).slice(0, 10);
  if (terms.length === 0) return undefined;
  const any = terms.length === 1 ? phrase(terms[0] ?? "") : `(${terms.map(phrase).join(" OR ")})`;
  return [any, ...topic.exclude.slice(0, 5).map((term) => `-${phrase(term)}`)].join(" ");
}

/** GDELT asks for a pause in a 200 or 429 whose body is its plea, not data. */
function throttled(response: SourceResponse, now: string): ReadOutcome<never> | undefined {
  const plea = typeof response.body === "string" && /^\s*Please limit requests/i.test(response.body);
  if (response.status === 429 || plea)
    return { kind: "rate-limited", retryAfterMs: Math.max(5_000, retryAfterMs(response.retryAfter, now)) };
  return undefined;
}

/** GDELT spaces a title's punctuation out ("Up 85 . 7 %"); put back as written. */
const tidyTitle = (title: string): string =>
  title
    .replace(/(\d)\s*([.,])\s*(\d)/g, "$1$2$3")
    .replace(/\s+([,.:;!?%)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+/g, " ")
    .trim();

/** GDELT names an article's language in English; the store keeps a code. */
const LANGUAGE_CODES: Readonly<Record<string, string>> = {
  English: "en",
  German: "de",
  French: "fr",
  Spanish: "es",
  Italian: "it",
  Portuguese: "pt",
  Dutch: "nl",
  Russian: "ru",
  Ukrainian: "uk",
  Polish: "pl",
  Turkish: "tr",
  Japanese: "ja",
  Korean: "ko",
  Chinese: "zh",
  Arabic: "ar",
  Persian: "fa",
  Hindi: "hi",
  Indonesian: "id",
  Vietnamese: "vi",
  Thai: "th",
  Hebrew: "he",
  Swedish: "sv",
};

/** GDELT answers hourly only up to a week: an hourly window reads its last 7 days, the rest of it is missing. */
const HOURLY_REACH_MS = 7 * 86_400_000;
const readFrom = (window: Window): string =>
  window.bucket === "hour"
    ? new Date(Math.max(Date.parse(window.from), Date.parse(window.to) - HOURLY_REACH_MS)).toISOString()
    : window.from;
const windowParameters = (window: Window) => ({ STARTDATETIME: stamp(readFrom(window)), ENDDATETIME: stamp(window.to) });

export const gdeltDoc: TrendsAdapter = {
  record: GDELT_DOC,
  counts: {
    request: ({ topic, window }) => {
      const text = gdeltQuery(topic);
      return text === undefined
        ? []
        : [
            {
              url: `${API}?${query({ query: text, mode: "timelinevolraw", format: "json", ...windowParameters(window) })}`,
              expect: "json",
            },
          ];
    },
    parse: (response, _request, { window }, call) => {
      const wait = throttled(response, call.now);
      if (wait !== undefined) return wait;
      const failed = failureOf(response, call.now);
      if (failed !== undefined) return failed;
      const timeline = objectOf(response.body)?.["timeline"];
      const data = Array.isArray(timeline) ? objectOf(timeline[0])?.["data"] : undefined;
      if (!Array.isArray(data)) return drift("no timeline data");
      const read: CountPoint[] = data.flatMap((entry) => {
        const start = isoOf(objectOf(entry)?.["date"]);
        const value = numberOf(objectOf(entry)?.["value"]);
        const norm = numberOf(objectOf(entry)?.["norm"]);
        return start === undefined || value === undefined
          ? []
          : [{ start, value, quality: "ok" as const, ...(norm === undefined ? {} : { norm }) }];
      });
      // GDELT answers in 15-minute, hourly or daily steps by the window's length: brought to the window's buckets.
      const byStart = new Map(rebucket(read, window.bucket).map((point) => [point.start, point]));
      // Past its newest step GDELT has not caught up: those buckets are missing, not quiet.
      const newest = read.reduce<string | undefined>(
        (latest, point) => (latest === undefined || point.start > latest ? point.start : latest),
        undefined,
      );
      const caughtUp = newest === undefined ? undefined : bucketStart(newest, window.bucket);
      const asked = bucketStart(readFrom(window), window.bucket);
      const points = bucketsOf(window).map(
        (start): CountPoint =>
          byStart.get(start) ??
          (start >= asked && caughtUp !== undefined && start <= caughtUp
            ? { start, value: 0, quality: "ok" }
            : { start, value: 0, quality: "missing" }),
      );
      return { kind: "ok", value: [{ metric: "articles", points }] };
    },
  },
  sample: {
    request: ({ topic, window, limit }) => {
      const text = gdeltQuery(topic);
      return text === undefined
        ? []
        : [
            {
              url: `${API}?${query({ query: text, mode: "artlist", format: "json", maxrecords: Math.min(limit, 75), sort: "datedesc", ...windowParameters(window) })}`,
              expect: "json",
            },
          ];
    },
    parse: (response, _request, _input, call) => {
      const wait = throttled(response, call.now);
      if (wait !== undefined) return wait;
      const failed = failureOf(response, call.now);
      if (failed !== undefined) return failed;
      const body = objectOf(response.body);
      // An empty answer is `{}`: no articles in the window.
      if (body === undefined) return drift("not an object");
      const articles = body["articles"] ?? [];
      if (!Array.isArray(articles)) return drift("articles is not a list");
      const items: RawItem[] = articles.flatMap((entry) => {
        const article = objectOf(entry);
        const url = stringOf(article?.["url"]);
        const title = stringOf(article?.["title"]);
        if (url === undefined || title === undefined) return [];
        const publishedAt = isoOf(article?.["seendate"]);
        const language = LANGUAGE_CODES[stringOf(article?.["language"]) ?? ""];
        return [
          {
            ref: url,
            url,
            title: tidyTitle(title),
            ...(publishedAt === undefined ? {} : { publishedAt }),
            ...(language === undefined ? {} : { language }),
          },
        ];
      });
      return { kind: "ok", value: items };
    },
  },
};
