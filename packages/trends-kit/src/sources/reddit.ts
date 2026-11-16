import type { RawItem } from "../contracts.js";
import { REDDIT } from "../records.js";
import { drift, excluded, failureOf, isoOf, numberOf, objectOf, plainText, postPageCounts, query, stringOf } from "./common.js";
import type { AdapterTopic, SourceCall, SourceRequest, TrendsAdapter, Window } from "./types.js";

/**
 * Reddit, with the operator's approved OAuth client only,
 * until its public API ends (`sunset`, 2027-03-01): an app-only token from
 * the client's id and secret (HTTP Basic, which the worker encodes, so both
 * are `rawSecrets`), then a search's newest page of 100 posts, as posts and
 * distinct authors an hour. Never RSS, never unauthenticated JSON.
 */
const TOKEN = "https://www.reddit.com/api/v1/access_token";
const API = "https://oauth.reddit.com";
const PAGE = 100;

const span = (window: Window): string => {
  const days = (Date.parse(window.to) - Date.parse(window.from)) / 86_400_000;
  return days <= 1 ? "day" : days <= 7 ? "week" : "month";
};

const searchRequest = (topic: AdapterTopic, window: Window, call: SourceCall, limit: number): SourceRequest[] =>
  topic.terms.slice(0, 1).map((term) => ({
    url: `${API}/search?${query({ q: term, sort: "new", t: span(window), limit, type: "link", raw_json: 1 })}`,
    headers: { Authorization: `Bearer ${call.token ?? ""}` },
    expect: "json",
  }));

function postsOf(body: unknown): RawItem[] | undefined {
  const children = objectOf(objectOf(body)?.["data"])?.["children"];
  if (!Array.isArray(children)) return undefined;
  return children.flatMap((entry): RawItem[] => {
    const post = objectOf(objectOf(entry)?.["data"]);
    const id = stringOf(post?.["id"]);
    const title = stringOf(post?.["title"]);
    const permalink = stringOf(post?.["permalink"]);
    if (id === undefined || title === undefined || permalink === undefined || !permalink.startsWith("/r/")) return [];
    const text = stringOf(post?.["selftext"]);
    const publishedAt = isoOf(numberOf(post?.["created_utc"]));
    const author = stringOf(post?.["author"]);
    const score = numberOf(post?.["score"]);
    const comments = numberOf(post?.["num_comments"]);
    return [
      {
        ref: id,
        url: `https://www.reddit.com${permalink}`,
        title: plainText(title),
        ...(text === undefined ? {} : { text: plainText(text) }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
        ...(author === undefined || author === "[deleted]" ? {} : { author }),
        metrics: { ...(score === undefined ? {} : { score }), ...(comments === undefined ? {} : { comments }) },
      },
    ];
  });
}

export const reddit: TrendsAdapter = {
  record: REDDIT,
  authorize: {
    request: (_input, call) => [
      {
        url: TOKEN,
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${call.credential("redditClientId") ?? ""}:${call.credential("redditSecret") ?? ""}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        expect: "json",
      },
    ],
    parse: (response, _request, _input, call) => {
      const failed = failureOf(response, call.now);
      if (failed !== undefined) return failed;
      const token = stringOf(objectOf(response.body)?.["access_token"]);
      const seconds = numberOf(objectOf(response.body)?.["expires_in"]);
      return token === undefined ? drift("no access_token") : { kind: "ok", value: { token, expiresInMs: (seconds ?? 3_600) * 1_000 } };
    },
  },
  counts: {
    request: ({ topic, window }, call) => searchRequest(topic, window, call, PAGE),
    parse: (response, _request, { topic, window }, call) => {
      const failed = failureOf(response, call.now);
      if (failed !== undefined) return failed;
      const posts = postsOf(response.body);
      if (posts === undefined) return drift("no children");
      return {
        kind: "ok",
        value: postPageCounts(
          posts.filter((post) => !excluded(`${post.title} ${post.text ?? ""}`, topic.exclude)),
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
        ? drift("no children")
        : { kind: "ok", value: posts.filter((post) => !excluded(`${post.title} ${post.text ?? ""}`, topic.exclude)) };
    },
  },
};
