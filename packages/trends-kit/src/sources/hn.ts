import type { RawItem } from "../contracts.js";
import { HN_ALGOLIA } from "../records.js";
import { countInto, excluded, drift, failureOf, isoOf, numberOf, objectOf, plainText, query, stringOf } from "./common.js";
import type { AdapterTopic, TrendsAdapter } from "./types.js";

/**
 * Hacker News through Algolia: counts by reading a window's
 * story times and bucketing them, a dated sample, and the front page. HN is
 * English, so only a topic's English terms are asked.
 */
const BASE = "https://hn.algolia.com/api/v1";
/** Stories one window read takes: Algolia's page limit. */
const WINDOW_HITS = 1_000;
const englishTerms = (topic: AdapterTopic): readonly string[] => topic.termsByLanguage["en"] ?? [];
const seconds = (iso: string): number => Math.floor(Date.parse(iso) / 1_000);

/** A story's discussion page: where its points and comments are. */
const discussion = (id: string): string => `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}`;

function storyOf(hit: Record<string, unknown>): RawItem | undefined {
  const id = stringOf(hit["objectID"]);
  const title = stringOf(hit["title"]);
  if (id === undefined || title === undefined) return undefined;
  const points = numberOf(hit["points"]);
  const comments = numberOf(hit["num_comments"]);
  const publishedAt = isoOf(hit["created_at"]) ?? isoOf(numberOf(hit["created_at_i"]));
  const text = stringOf(hit["story_text"]);
  const author = stringOf(hit["author"]);
  return {
    ref: id,
    url: stringOf(hit["url"]) ?? discussion(id),
    title: plainText(title),
    ...(text === undefined ? {} : { text: plainText(text) }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    language: "en",
    ...(author === undefined ? {} : { author }),
    metrics: { ...(points === undefined ? {} : { points }), ...(comments === undefined ? {} : { comments }) },
  };
}

const hitsOf = (body: unknown): Record<string, unknown>[] | undefined => {
  const hits = objectOf(body)?.["hits"];
  return Array.isArray(hits) ? hits.flatMap((hit) => (objectOf(hit) === undefined ? [] : [hit as Record<string, unknown>])) : undefined;
};

export const hnAlgolia: TrendsAdapter = {
  record: HN_ALGOLIA,
  counts: {
    // The first English term only: a story matching two terms read twice would be counted twice.
    request: ({ topic, window }) =>
      englishTerms(topic)
        .slice(0, 1)
        .map((term) => ({
          url: `${BASE}/search_by_date?${query({ query: term, tags: "story", numericFilters: `created_at_i>=${String(seconds(window.from))},created_at_i<${String(seconds(window.to))}`, hitsPerPage: WINDOW_HITS, attributesToRetrieve: "created_at_i,title,story_text" })}`,
          expect: "json",
          tag: term,
        })),
    parse: (response, _request, { topic, window }, call) => {
      const failed = failureOf(response, call.now);
      if (failed !== undefined) return failed;
      const hits = hitsOf(response.body);
      const total = numberOf(objectOf(response.body)?.["nbHits"]);
      if (hits === undefined || total === undefined) return drift("no hits or nbHits");
      // Algolia matched the query; only an excluded sense of the word is dropped.
      const times = hits
        .filter((hit) => !excluded(`${String(hit["title"] ?? "")} ${String(hit["story_text"] ?? "")}`, topic.exclude))
        .flatMap((hit) => isoOf(numberOf(hit["created_at_i"])) ?? []);
      // More stories than one page holds: the buckets are an undercount. Algolia's own count is approximate.
      const exhaustive = objectOf(response.body)?.["exhaustiveNbHits"] === true;
      // Past the page's oldest story, older buckets were never read: missing, not quiet.
      const truncated = total > hits.length;
      const oldest = truncated
        ? hits.reduce<number | undefined>((min, hit) => {
            const at = numberOf(hit["created_at_i"]);
            return at !== undefined && (min === undefined || at < min) ? at : min;
          }, undefined)
        : undefined;
      return {
        kind: "ok",
        value: [
          {
            metric: "stories",
            points: countInto(
              window,
              times,
              truncated ? "partial" : exhaustive ? "ok" : "approximate",
              oldest === undefined ? undefined : isoOf(oldest),
            ),
          },
        ],
      };
    },
  },
  sample: {
    request: ({ topic, window, limit }) =>
      englishTerms(topic)
        .slice(0, 1)
        .map((term) => ({
          url: `${BASE}/search_by_date?${query({ query: term, tags: "story", numericFilters: `created_at_i>=${String(seconds(window.from))},created_at_i<${String(seconds(window.to))}`, hitsPerPage: Math.min(limit, 50) })}`,
          expect: "json",
        })),
    parse: (response, _request, { topic }, call) => {
      const failed = failureOf(response, call.now);
      if (failed !== undefined) return failed;
      const hits = hitsOf(response.body);
      if (hits === undefined) return drift("no hits");
      return {
        kind: "ok",
        value: hits.flatMap((hit) => storyOf(hit) ?? []).filter((item) => !excluded(`${item.title} ${item.text ?? ""}`, topic.exclude)),
      };
    },
  },
  trending: {
    // HN has one front page, whatever the country.
    request: () => [{ url: `${BASE}/search?${query({ tags: "front_page", hitsPerPage: 30 })}`, expect: "json" }],
    parse: (response, _request, _input, call) => {
      const failed = failureOf(response, call.now);
      if (failed !== undefined) return failed;
      const hits = hitsOf(response.body);
      if (hits === undefined) return drift("no hits");
      const stories = hits.flatMap((hit) => storyOf(hit) ?? []).sort((a, b) => (b.metrics?.["points"] ?? 0) - (a.metrics?.["points"] ?? 0));
      return {
        kind: "ok",
        value: stories.map((story, index) => ({
          title: story.title,
          url: discussion(story.ref),
          rank: index + 1,
          ...(story.metrics?.["points"] === undefined
            ? {}
            : { volume: story.metrics["points"], volumeLabel: `${String(story.metrics["points"])} points` }),
        })),
      };
    },
  },
};
