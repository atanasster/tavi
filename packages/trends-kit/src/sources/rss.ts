import { childrenOf, parseXml, textOf, type XmlElement } from "@tavi/domain-kit";

import type { RawItem, TrendsSourceRecord } from "../contracts.js";
import { RSS_AMERICAS, RSS_EUROPE, RSS_FEEDS } from "../records.js";
import { about, countInto, drift, failureOf, isoOf, objectOf, plainText, stringOf } from "./common.js";
import type { ReadOutcome, SourceCall, SourceRequest, SourceResponse, TrendsAdapter } from "./types.js";

/**
 * Public broadcasters' feeds: RSS 2.0, Atom, or tagesschau's
 * JSON. A feed holds its newest stories only, so a count reaches back as far
 * as its oldest item; older buckets are missing, never quiet.
 */
type Group = keyof typeof RSS_FEEDS;
/** How far back a feed's items show its reach; older ones are pinned stories, not coverage. */
const COVERAGE_MAX_DAYS = 30;

/** A feed's items: RSS `item`s, Atom `entry`s, or tagesschau's `news`. */
export function feedItems(body: unknown, language: string): RawItem[] | undefined {
  if (typeof body !== "string") {
    // tagesschau's API: `news` with title, firstSentence, date and shareURL.
    const news = objectOf(body)?.["news"];
    if (!Array.isArray(news)) return undefined;
    return news.flatMap((entry): RawItem[] => {
      const item = objectOf(entry);
      const url = stringOf(item?.["shareURL"]) ?? stringOf(item?.["detailsweb"]);
      const title = stringOf(item?.["title"]);
      if (url === undefined || title === undefined) return [];
      const publishedAt = isoOf(item?.["date"]);
      const text = stringOf(item?.["firstSentence"]);
      return [
        { ref: url, url, title, ...(text === undefined ? {} : { text }), ...(publishedAt === undefined ? {} : { publishedAt }), language },
      ];
    });
  }
  let document: XmlElement;
  try {
    document = parseXml(body);
  } catch {
    return undefined;
  }
  const rss = childrenOf(document, "rss")
    .flatMap((element) => childrenOf(element, "channel"))
    .flatMap((channel) => childrenOf(channel, "item"));
  const atom = childrenOf(document, "feed").flatMap((feed) => childrenOf(feed, "entry"));
  if (rss.length === 0 && atom.length === 0 && childrenOf(document, "rss").length === 0 && childrenOf(document, "feed").length === 0)
    return undefined;
  return [...rss, ...atom].flatMap((entry): RawItem[] => {
    const link =
      textOf(entry, "link") ??
      childrenOf(entry, "link")
        .map((element) => element.attributes["href"])
        .find((href) => href !== undefined);
    const title = textOf(entry, "title");
    if (link === undefined || title === undefined || !/^https?:\/\//.test(link)) return [];
    const publishedAt = isoOf(textOf(entry, "pubDate") ?? textOf(entry, "published") ?? textOf(entry, "updated") ?? textOf(entry, "date"));
    const description = textOf(entry, "description") ?? textOf(entry, "summary");
    return [
      {
        ref: textOf(entry, "guid") ?? textOf(entry, "id") ?? link,
        url: link,
        title: plainText(title),
        ...(description === undefined ? {} : { text: plainText(description) }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
        language,
      },
    ];
  });
}

function rssAdapter(record: TrendsSourceRecord, group: Group): TrendsAdapter {
  const feeds = RSS_FEEDS[group];
  const requests = (): SourceRequest[] =>
    feeds.map((feed, index) => ({ url: feed.url, expect: feed.url.includes("/api2u/") ? "json" : "text", tag: String(index) }));
  const read = (response: SourceResponse, request: SourceRequest, call: SourceCall): ReadOutcome<readonly RawItem[]> => {
    const failed = failureOf(response, call.now);
    if (failed !== undefined) return failed;
    const feed = feeds[Number(request.tag)];
    const items = feedItems(response.body, feed?.language ?? "en");
    return items === undefined ? drift("not a feed") : { kind: "ok", value: items };
  };
  return {
    record,
    counts: {
      request: requests,
      parse: (response, request, { topic, window }, call) => {
        const items = read(response, request, call);
        if (items.kind !== "ok") return items;
        // A feed pins an evergreen story now and then; its reach is its recent items'.
        const recent = new Date(Date.parse(call.now) - COVERAGE_MAX_DAYS * 86_400_000).toISOString();
        const times = items.value.flatMap((item) => item.publishedAt ?? []).filter((time) => time >= recent);
        const oldest = times.reduce<string | undefined>((min, time) => (min === undefined || time < min ? time : min), undefined);
        const matching = items.value
          .filter((item) => about(`${item.title} ${item.text ?? ""}`, topic.terms, topic.exclude))
          .flatMap((item) => item.publishedAt ?? []);
        // An empty feed reaches back nowhere: every bucket is missing.
        return { kind: "ok", value: [{ metric: "stories", points: countInto(window, matching, "approximate", oldest ?? window.to) }] };
      },
    },
    sample: {
      request: requests,
      parse: (response, request, { topic, window }, call) => {
        const items = read(response, request, call);
        if (items.kind !== "ok") return items;
        return {
          kind: "ok",
          value: items.value.filter(
            (item) =>
              about(`${item.title} ${item.text ?? ""}`, topic.terms, topic.exclude) &&
              (item.publishedAt === undefined || (item.publishedAt >= window.from && item.publishedAt < window.to)),
          ),
        };
      },
    },
  };
}

export const rssEurope = rssAdapter(RSS_EUROPE, "rss-europe");
export const rssAmericas = rssAdapter(RSS_AMERICAS, "rss-americas");
