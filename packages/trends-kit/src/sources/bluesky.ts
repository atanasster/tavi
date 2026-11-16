import { definedOnly } from "@tavi/contracts/util";

import type { CountPoint, RawItem, TrendEntry } from "../contracts.js";
import { BLUESKY_SEARCH, BLUESKY_TRENDS } from "../records.js";
import { bucketStart } from "../store/store.js";
import { about, bucketsOf, drift, excluded, failureOf, isoOf, numberOf, objectOf, postPageCounts, query, stringOf } from "./common.js";
import type { AdapterTopic, ReadOutcome, SourceCall, SourceResponse, TrendsAdapter, Window } from "./types.js";

/**
 * Bluesky. `searchPosts` answers its first page without a
 * session, and a cursor is refused, so a window is read as one page of up to
 * 100 posts, newest first; buckets older than its oldest post are missing.
 * `getTrends` is unspecced (off by default). Post text is kept a day, so a
 * post its author deleted leaves with it.
 */
const SEARCH = "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts";
const TRENDS = "https://public.api.bsky.app/xrpc/app.bsky.unspecced.getTrends";
const PAGE = 100;

/** `at://did/app.bsky.feed.post/rkey` as the post's public page. */
export function postUrl(uri: string): string | undefined {
  const match = /^at:\/\/(did:[a-z]+:[A-Za-z0-9._:%-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._~-]+)$/.exec(uri);
  return match === null ? undefined : `https://bsky.app/profile/${match[1] ?? ""}/post/${match[2] ?? ""}`;
}

function postsOf(body: unknown): RawItem[] | undefined {
  const posts = objectOf(body)?.["posts"];
  if (!Array.isArray(posts)) return undefined;
  return posts.flatMap((entry): RawItem[] => {
    const post = objectOf(entry);
    const uri = stringOf(post?.["uri"]);
    const url = uri === undefined ? undefined : postUrl(uri);
    const record = objectOf(post?.["record"]);
    const text = stringOf(record?.["text"]);
    if (uri === undefined || url === undefined || text === undefined) return [];
    const publishedAt = isoOf(record?.["createdAt"]) ?? isoOf(post?.["indexedAt"]);
    const langs = record?.["langs"];
    const language = Array.isArray(langs) ? stringOf(langs[0]) : undefined;
    // The author's DID is stable; the store keeps only its hash for the day, and its handle's, so a topic can never be the person.
    const author = stringOf(objectOf(post?.["author"])?.["did"]);
    const handle = stringOf(objectOf(post?.["author"])?.["handle"]);
    const metrics = Object.fromEntries(
      ["likeCount", "repostCount", "replyCount", "quoteCount"].flatMap((key) => {
        const value = numberOf(post?.[key]);
        return value === undefined ? [] : [[key.replace("Count", "s"), value]];
      }),
    );
    return [
      {
        ref: uri,
        url,
        title: text.length > 120 ? `${text.slice(0, 119)}…` : text,
        text,
        ...definedOnly({ publishedAt, language, author }),
        ...(handle === undefined ? {} : { authorNames: [handle] }),
        metrics,
      },
    ];
  });
}

const searchRequest = (topic: AdapterTopic, window: Window, limit: number) =>
  topic.terms.slice(0, 1).map((term) => ({
    url: `${SEARCH}?${query({ q: term, sort: "latest", since: window.from, until: window.to, limit })}`,
    expect: "json" as const,
  }));

export const blueskySearch: TrendsAdapter = {
  record: BLUESKY_SEARCH,
  counts: {
    // The first term only: a post matching two terms read twice would be counted twice.
    request: ({ topic, window }) => searchRequest(topic, window, PAGE),
    parse: (response, _request, { topic, window }, call) => {
      const failed = failureOf(response, call.now);
      if (failed !== undefined) return failed;
      const posts = postsOf(response.body);
      if (posts === undefined) return drift("no posts");
      // The page's own length says whether it was cut; Bluesky matched the query, so only exclusions are dropped.
      return {
        kind: "ok",
        value: postPageCounts(
          posts.filter((post) => !excluded(post.text ?? "", topic.exclude)),
          window,
          posts.length >= PAGE,
        ),
      };
    },
  },
  sample: {
    request: ({ topic, window, limit }) => searchRequest(topic, window, Math.min(limit, PAGE)),
    parse: (response, _request, { topic }, call) => {
      const failed = failureOf(response, call.now);
      if (failed !== undefined) return failed;
      const posts = postsOf(response.body);
      return posts === undefined
        ? drift("no posts")
        : { kind: "ok", value: posts.filter((post) => !excluded(post.text ?? "", topic.exclude)) };
    },
  },
};

function trendsOf(response: SourceResponse, call: SourceCall): ReadOutcome<readonly (TrendEntry & { readonly text: string })[]> {
  const failed = failureOf(response, call.now);
  if (failed !== undefined) return failed;
  const trends = objectOf(response.body)?.["trends"];
  if (!Array.isArray(trends)) return drift("no trends");
  return {
    kind: "ok",
    value: trends.flatMap((entry, index) => {
      const trend = objectOf(entry);
      const title = stringOf(trend?.["displayName"]) ?? stringOf(trend?.["topic"]);
      if (title === undefined) return [];
      const link = stringOf(trend?.["link"]);
      const posts = numberOf(trend?.["postCount"]);
      return [
        {
          title,
          rank: index + 1,
          ...(link?.startsWith("/") === true ? { url: `https://bsky.app${link}` } : {}),
          ...(posts === undefined ? {} : { volume: posts, volumeLabel: `${String(posts)} posts` }),
          text: `${title} ${stringOf(trend?.["description"]) ?? ""}`,
        },
      ];
    }),
  };
}

export const blueskyTrends: TrendsAdapter = {
  record: BLUESKY_TRENDS,
  counts: {
    request: () => [{ url: TRENDS, expect: "json" }],
    parse: (response, _request, { topic, window }, call) => {
      const read = trendsOf(response, call);
      if (read.kind !== "ok") return read;
      const posts = read.value
        .filter((trend) => about(trend.text, topic.terms, topic.exclude))
        .reduce((sum, trend) => sum + (trend.volume ?? 0), 0);
      const current = bucketStart(call.now, window.bucket);
      return {
        kind: "ok",
        value: [
          {
            metric: "trend-posts",
            points: bucketsOf(window).map(
              (start): CountPoint =>
                start === current ? { start, value: posts, quality: "approximate" } : { start, value: 0, quality: "missing" },
            ),
          },
        ],
      };
    },
  },
  trending: {
    // Bluesky's trends are network-wide, whatever the country.
    request: () => [{ url: TRENDS, expect: "json" }],
    parse: (response, _request, _input, call) => {
      const read = trendsOf(response, call);
      return read.kind === "ok" ? { kind: "ok", value: read.value.map(({ text: _text, ...entry }) => entry) } : read;
    },
  },
};
