import { childrenOf, parseXml, textOf, type XmlElement } from "@tavi/domain-kit";

import type { RawItem } from "../contracts.js";
import { ARXIV } from "../records.js";
import { countInto, excluded, drift, failureOf, isoOf, numberOf, query } from "./common.js";
import type { AdapterTopic, ReadOutcome, SourceCall, SourceResponse, TrendsAdapter, Window } from "./types.js";

/**
 * arXiv's API: papers submitted in a window, their metadata
 * CC0. One request every three seconds on one connection. English, so only a
 * topic's English terms are asked.
 */
const API = "https://export.arxiv.org/api/query";
/** Papers one window read takes. */
const WINDOW_PAPERS = 200;
const stamp = (iso: string): string => iso.slice(0, 16).replace(/[-:T]/g, "");

export function arxivQuery(topic: AdapterTopic, window: Window): string | undefined {
  const terms = (topic.termsByLanguage["en"] ?? []).slice(0, 5).map((term) => `all:"${term.replace(/"/g, "")}"`);
  if (terms.length === 0) return undefined;
  // `TO` is inclusive to the minute; the window's end is not.
  const last = new Date(Date.parse(window.to) - 60_000).toISOString();
  return `(${terms.join(" OR ")}) AND submittedDate:[${stamp(window.from)} TO ${stamp(last)}]`;
}

interface Feed {
  readonly total: number;
  readonly papers: readonly RawItem[];
}

function feedOf(response: SourceResponse, call: SourceCall): ReadOutcome<Feed> {
  const failed = failureOf(response, call.now);
  if (failed !== undefined) return failed;
  if (typeof response.body !== "string") return drift("not text");
  let feed: XmlElement | undefined;
  try {
    feed = childrenOf(parseXml(response.body), "feed")[0];
  } catch {
    return drift("not XML");
  }
  const total = numberOf(textOf(feed, "totalResults"));
  if (feed === undefined || total === undefined) return drift("no feed or totalResults");
  const papers = childrenOf(feed, "entry").flatMap((entry): RawItem[] => {
    const id = textOf(entry, "id");
    const title = textOf(entry, "title");
    if (id === undefined || title === undefined || !id.startsWith("http")) return [];
    const publishedAt = isoOf(textOf(entry, "published"));
    const summary = textOf(entry, "summary");
    return [
      {
        ref: id,
        url: id.replace(/^http:/, "https:"),
        title: title.replace(/\s+/g, " "),
        ...(summary === undefined ? {} : { text: summary.replace(/\s+/g, " ") }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
        language: "en",
      },
    ];
  });
  return { kind: "ok", value: { total, papers } };
}

export const arxiv: TrendsAdapter = {
  record: ARXIV,
  counts: {
    request: ({ topic, window }) => {
      const search = arxivQuery(topic, window);
      return search === undefined
        ? []
        : [
            {
              url: `${API}?${query({ search_query: search, sortBy: "submittedDate", sortOrder: "descending", max_results: WINDOW_PAPERS })}`,
              expect: "text",
            },
          ];
    },
    parse: (response, _request, { topic, window }, call) => {
      const read = feedOf(response, call);
      if (read.kind !== "ok") return read;
      const papers = read.value.papers.filter((paper) => !excluded(`${paper.title} ${paper.text ?? ""}`, topic.exclude));
      const times = papers.flatMap((paper) => paper.publishedAt ?? []);
      // More papers than one page: older buckets than the page reached are missing.
      const capped = read.value.total > read.value.papers.length;
      const oldest = capped
        ? read.value.papers.reduce<string | undefined>(
            (min, paper) => (paper.publishedAt !== undefined && (min === undefined || paper.publishedAt < min) ? paper.publishedAt : min),
            undefined,
          )
        : undefined;
      return { kind: "ok", value: [{ metric: "papers", points: countInto(window, times, capped ? "partial" : "ok", oldest) }] };
    },
  },
  sample: {
    request: ({ topic, window, limit }) => {
      const search = arxivQuery(topic, window);
      return search === undefined
        ? []
        : [
            {
              url: `${API}?${query({ search_query: search, sortBy: "submittedDate", sortOrder: "descending", max_results: Math.min(limit, 50) })}`,
              expect: "text",
            },
          ];
    },
    parse: (response, _request, { topic }, call) => {
      const read = feedOf(response, call);
      return read.kind === "ok"
        ? { kind: "ok", value: read.value.papers.filter((paper) => !excluded(`${paper.title} ${paper.text ?? ""}`, topic.exclude)) }
        : read;
    },
  },
};
