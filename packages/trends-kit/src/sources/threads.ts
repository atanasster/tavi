import type { RawItem } from "../contracts.js";
import { THREADS } from "../records.js";
import { drift, excluded, failureOf, isoOf, objectOf, postPageCounts, query, stringOf } from "./common.js";
import type { AdapterTopic, SourceCall, SourceRequest, TrendsAdapter, Window } from "./types.js";

/**
 * Threads keyword search: the newest page of up to 100 posts
 * in a window, as posts and distinct authors an hour. Only with
 * `threads_keyword_search` approved does it read beyond the operator's own
 * posts. The token is a header credential the worker's proxy puts in place.
 */
const API = "https://graph.threads.net/v1.0/keyword_search";
const PAGE = 100;
const seconds = (iso: string): number => Math.floor(Date.parse(iso) / 1_000);

const searchRequest = (topic: AdapterTopic, window: Window, call: SourceCall, limit: number): SourceRequest[] =>
  topic.terms.slice(0, 1).map((term) => ({
    url: `${API}?${query({ q: term, search_type: "RECENT", since: seconds(window.from), until: Math.min(seconds(window.to), seconds(call.now)), limit, fields: "id,text,timestamp,permalink,username" })}`,
    headers: { Authorization: `Bearer ${call.credential("threadsToken") ?? ""}` },
    expect: "json",
  }));

function postsOf(body: unknown): RawItem[] | undefined {
  const data = objectOf(body)?.["data"];
  if (!Array.isArray(data)) return undefined;
  return data.flatMap((entry): RawItem[] => {
    const post = objectOf(entry);
    const id = stringOf(post?.["id"]);
    const permalink = stringOf(post?.["permalink"]);
    const text = stringOf(post?.["text"]) ?? "";
    if (id === undefined || permalink === undefined || !/^https:\/\/www\.threads\.(net|com)\//.test(permalink)) return [];
    const publishedAt = isoOf(post?.["timestamp"]);
    const author = stringOf(post?.["username"]);
    return [
      {
        ref: id,
        url: permalink,
        title: text.length > 120 ? `${text.slice(0, 119)}…` : text || "(no text)",
        text,
        ...(publishedAt === undefined ? {} : { publishedAt }),
        ...(author === undefined ? {} : { author }),
        metrics: {},
      },
    ];
  });
}

export const threads: TrendsAdapter = {
  record: THREADS,
  counts: {
    request: ({ topic, window }, call) => searchRequest(topic, window, call, PAGE),
    parse: (response, _request, { topic, window }, call) => {
      const failed = failureOf(response, call.now);
      if (failed !== undefined) return failed;
      const posts = postsOf(response.body);
      if (posts === undefined) return drift("no data");
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
    request: ({ topic, window, limit }, call) => searchRequest(topic, window, call, Math.min(PAGE, limit)),
    parse: (response, _request, { topic }, call) => {
      const failed = failureOf(response, call.now);
      if (failed !== undefined) return failed;
      const posts = postsOf(response.body);
      return posts === undefined
        ? drift("no data")
        : { kind: "ok", value: posts.filter((post) => !excluded(post.text ?? "", topic.exclude)) };
    },
  },
};
