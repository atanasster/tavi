import type { RawItem } from "../contracts.js";
import { YOUTUBE } from "../records.js";
import { drift, excluded, failureOf, isoOf, numberOf, objectOf, plainText, postPageCounts, query, stringOf } from "./common.js";
import type { AdapterTopic, ReadOutcome, SourceCall, SourceResponse, TrendsAdapter, Window } from "./types.js";

/**
 * YouTube Data API v3: videos a query's search finds in a
 * window, newest first, one page of 50 (`search.list` has 100 calls a day of
 * its own); a dated sample; and a region's most popular chart. Its key goes
 * in the query, so the worker holds it raw (`rawSecrets`). Its statistics
 * are kept 30 days at most, and velocity is Tavi's, never YouTube's.
 */
const API = "https://www.googleapis.com/youtube/v3";
const PAGE = 50;

const key = (call: SourceCall): string => call.credential("youtubeKey") ?? "";

/** YouTube's quota errors are 403s: a spent quota is `quota`, until the day's reset, not a block. */
function failed(response: SourceResponse, now: string): ReadOutcome<never> | undefined {
  if (response.status === 403) {
    const errors = objectOf(objectOf(response.body)?.["error"])?.["errors"];
    const reason = Array.isArray(errors) ? stringOf(objectOf(errors[0])?.["reason"]) : undefined;
    if (reason === "quotaExceeded" || reason === "rateLimitExceeded" || reason === "dailyLimitExceeded")
      return { kind: "failed", class: "quota", status: 403, detail: reason };
  }
  return failureOf(response, now);
}

const searchUrl = (topic: AdapterTopic, window: Window, call: SourceCall, limit: number): string =>
  `${API}/search?${query({ part: "snippet", type: "video", order: "date", q: topic.terms.slice(0, 3).join("|"), publishedAfter: window.from, publishedBefore: window.to, maxResults: Math.min(PAGE, limit), key: key(call) })}`;

function videosOf(body: unknown): { readonly videos: RawItem[]; readonly more: boolean } | undefined {
  const items = objectOf(body)?.["items"];
  if (!Array.isArray(items)) return undefined;
  const videos = items.flatMap((entry): RawItem[] => {
    const item = objectOf(entry);
    const id = objectOf(item?.["id"]);
    const videoId = stringOf(id?.["videoId"]) ?? stringOf(item?.["id"]);
    const snippet = objectOf(item?.["snippet"]);
    const title = stringOf(snippet?.["title"]);
    if (videoId === undefined || !/^[A-Za-z0-9_-]{6,20}$/.test(videoId) || title === undefined) return [];
    const publishedAt = isoOf(snippet?.["publishedAt"]);
    const description = stringOf(snippet?.["description"]);
    const channel = stringOf(snippet?.["channelId"]);
    const statistics = objectOf(item?.["statistics"]) ?? {};
    const views = numberOf(statistics["viewCount"]);
    return [
      {
        ref: videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: plainText(title),
        ...(description === undefined ? {} : { text: plainText(description) }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
        ...(channel === undefined ? {} : { author: channel }),
        metrics: views === undefined ? {} : { views },
      },
    ];
  });
  return { videos, more: stringOf(objectOf(body)?.["nextPageToken"]) !== undefined };
}

export const youtube: TrendsAdapter = {
  record: YOUTUBE,
  counts: {
    request: ({ topic, window }, call) => [{ url: searchUrl(topic, window, call, PAGE), expect: "json" }],
    parse: (response, _request, { topic, window }, call) => {
      const refused = failed(response, call.now);
      if (refused !== undefined) return refused;
      const read = videosOf(response.body);
      if (read === undefined) return drift("no items");
      // Channels count as authors; past the page's oldest video, missing.
      const [videos, channels] = postPageCounts(
        read.videos.filter((video) => !excluded(`${video.title} ${video.text ?? ""}`, topic.exclude)),
        window,
        read.more,
      );
      return {
        kind: "ok",
        value: [
          { metric: "videos", points: videos?.points ?? [] },
          { metric: "channels", points: channels?.points ?? [] },
        ],
      };
    },
  },
  sample: {
    request: ({ topic, window, limit }, call) => [{ url: searchUrl(topic, window, call, limit), expect: "json" }],
    parse: (response, _request, { topic }, call) => {
      const refused = failed(response, call.now);
      if (refused !== undefined) return refused;
      const read = videosOf(response.body);
      return read === undefined
        ? drift("no items")
        : { kind: "ok", value: read.videos.filter((video) => !excluded(`${video.title} ${video.text ?? ""}`, topic.exclude)) };
    },
  },
  trending: {
    request: ({ country }, call) => [
      {
        url: `${API}/videos?${query({ part: "snippet,statistics", chart: "mostPopular", regionCode: country, maxResults: 25, key: key(call) })}`,
        expect: "json",
      },
    ],
    parse: (response, _request, _input, call) => {
      const refused = failed(response, call.now);
      if (refused !== undefined) return refused;
      const read = videosOf(response.body);
      if (read === undefined) return drift("no items");
      return {
        kind: "ok",
        value: read.videos.map((video, index) => ({
          title: video.title,
          url: video.url,
          rank: index + 1,
          ...(video.metrics?.["views"] === undefined
            ? {}
            : { volume: video.metrics["views"], volumeLabel: `${video.metrics["views"].toLocaleString("en")} views` }),
        })),
      };
    },
  },
};
