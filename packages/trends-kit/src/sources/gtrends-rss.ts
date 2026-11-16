import { definedOnly } from "@tavi/contracts/util";
import { childrenOf, parseXml, textOf, type XmlElement } from "@tavi/domain-kit";

import type { CountPoint, TrendEntry } from "../contracts.js";
import { GTRENDS_RSS } from "../records.js";
import { bucketStart } from "../store/store.js";
import { about, bucketsOf, drift, failureOf, query } from "./common.js";
import type { ReadOutcome, SourceCall, SourceResponse, TrendsAdapter } from "./types.js";

/**
 * Google Trends' "Trending now" feed: about ten searches
 * surging now in a country, each with a traffic bucket ("1000+") and news
 * links. Its robots.txt disallows Explore, not this feed. It is a presence
 * signal: what is surging, never a count for an arbitrary topic.
 */
const FEED = "https://trends.google.com/trending/rss";

/** "1000+", "2K+", "1M+" as a number. */
export function approxTraffic(label: string | undefined): number | undefined {
  const match = /^([\d.,]+)\s*([KMB])?\+?$/i.exec(label?.trim() ?? "");
  if (match === null) return undefined;
  const base = Number((match[1] ?? "").replace(/,/g, ""));
  const scale = { K: 1e3, M: 1e6, B: 1e9 }[(match[2] ?? "").toUpperCase() as "K" | "M" | "B"] ?? 1;
  return Number.isFinite(base) ? Math.round(base * scale) : undefined;
}

interface Trend {
  readonly entry: TrendEntry;
  /** The trend's title and its news headlines: what a topic is matched against. */
  readonly text: string;
}

function trendsOf(response: SourceResponse, call: SourceCall): ReadOutcome<readonly Trend[]> {
  const failed = failureOf(response, call.now);
  if (failed !== undefined) return failed;
  if (typeof response.body !== "string") return drift("not text");
  let channel: XmlElement | undefined;
  try {
    channel = childrenOf(parseXml(response.body), "rss").flatMap((rss) => childrenOf(rss, "channel"))[0];
  } catch {
    return drift("not XML");
  }
  if (channel === undefined) return drift("no channel");
  const trends = childrenOf(channel, "item").flatMap((item, index): Trend[] => {
    const title = textOf(item, "title");
    if (title === undefined) return [];
    const label = textOf(item, "approx_traffic");
    const volume = approxTraffic(label);
    const news = childrenOf(item, "news_item");
    const url = news.map((entry) => textOf(entry, "news_item_url")).find((link) => link?.startsWith("https://") === true);
    return [
      {
        entry: { title, rank: index + 1, ...definedOnly({ url, volume, volumeLabel: label }) },
        text: [title, ...news.map((entry) => textOf(entry, "news_item_title") ?? "")].join(" "),
      },
    ];
  });
  return { kind: "ok", value: trends };
}

const feed = (country: string) => ({ url: `${FEED}?${query({ geo: country })}`, expect: "text" as const, tag: country });

export const gtrendsRss: TrendsAdapter = {
  record: GTRENDS_RSS,
  counts: {
    // What is surging now: the topic's countries, the US when it names none.
    request: ({ topic }) => (topic.countries.length === 0 ? ["US"] : topic.countries.slice(0, 5)).map(feed),
    parse: (response, _request, { topic, window }, call) => {
      const read = trendsOf(response, call);
      if (read.kind !== "ok") return read;
      const matching = read.value.filter((trend) => about(trend.text, topic.terms, topic.exclude));
      const traffic = matching.reduce((sum, trend) => sum + (trend.entry.volume ?? 0), 0);
      // A snapshot of now: the bucket holding now has it, every other bucket was not seen.
      const current = bucketStart(call.now, window.bucket);
      const points: CountPoint[] = bucketsOf(window).map((start) =>
        start === current ? { start, value: traffic, quality: "approximate" } : { start, value: 0, quality: "missing" },
      );
      return { kind: "ok", value: [{ metric: "traffic", points }] };
    },
  },
  trending: {
    request: ({ country }) => [feed(country)],
    parse: (response, _request, _input, call) => {
      const read = trendsOf(response, call);
      return read.kind === "ok" ? { kind: "ok", value: read.value.map((trend) => trend.entry) } : read;
    },
  },
};
