import { arxiv } from "./arxiv.js";
import { blueskySearch, blueskyTrends } from "./bluesky.js";
import { gdeltDoc } from "./gdelt.js";
import { gtrendsApi } from "./gtrends-api.js";
import { gtrendsRss } from "./gtrends-rss.js";
import { hnAlgolia } from "./hn.js";
import { mastodonTrends } from "./mastodon.js";
import { naverDatalab } from "./naver.js";
import { reddit } from "./reddit.js";
import { rssAmericas, rssEurope } from "./rss.js";
import { threads } from "./threads.js";
import type { TrendsAdapter } from "./types.js";
import { wikipediaPageviews } from "./wikipedia.js";
import { youtube } from "./youtube.js";

export { arxiv, arxivQuery } from "./arxiv.js";
export { blueskySearch, blueskyTrends, postUrl } from "./bluesky.js";
export {
  about,
  bucketsOf,
  countInto,
  failureOf,
  isoOf,
  mentions,
  mergeSeries,
  plainText,
  postPageCounts,
  rebucket,
  retryAfterMs,
} from "./common.js";
export { gdeltDoc, gdeltQuery } from "./gdelt.js";
export { approxTraffic, gtrendsRss } from "./gtrends-rss.js";
export { hnAlgolia } from "./hn.js";
export { hashtagOf, instancesOf, mastodonTrends } from "./mastodon.js";
export { feedItems, rssAmericas, rssEurope } from "./rss.js";
export type {
  AccessToken,
  AdapterTopic,
  CountSeries,
  Operation,
  ReadOutcome,
  SourceCall,
  SourceRequest,
  SourceResponse,
  TrendsAdapter,
  Window,
} from "./types.js";
export { wikidataEntity, wikidataSearch, type WikidataExpansion } from "./wikidata.js";
export { COUNTRY_EDITION, wikipediaPageviews } from "./wikipedia.js";

/** The adapters that need no key, in the order a sweep reads them. Wikidata is not here: it expands topics, it is never swept. */
export const TR1_ADAPTERS: readonly TrendsAdapter[] = [
  hnAlgolia,
  wikipediaPageviews,
  gdeltDoc,
  gtrendsRss,
  blueskyTrends,
  blueskySearch,
  mastodonTrends,
  arxiv,
  rssEurope,
  rssAmericas,
];
export { gtrendsApi } from "./gtrends-api.js";
export { naverDatalab } from "./naver.js";
export { reddit } from "./reddit.js";
export { threads } from "./threads.js";
export { youtube } from "./youtube.js";

/** The adapters that need a key, each off until keyed; none paid. */
export const TR2_ADAPTERS: readonly TrendsAdapter[] = [youtube, naverDatalab, gtrendsApi, reddit, threads];
export { ListSpecSchema, jsonAt, listAdapter, listUrl, refusesAiInput, robotsAllows, robotsContentSignal, type ListSpec } from "./list.js";
