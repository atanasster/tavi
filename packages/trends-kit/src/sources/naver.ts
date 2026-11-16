import type { CountPoint } from "../contracts.js";
import { NAVER_DATALAB } from "../records.js";
import { bucketsOf, drift, failureOf, isoOf, numberOf, objectOf } from "./common.js";
import type { SourceCall, TrendsAdapter } from "./types.js";

/**
 * Naver DataLab's search trend: a keyword group's daily
 * search `ratio` in Korea, 100 being the period's highest. A ratio is
 * relative to the period asked, so every read asks the same span, the
 * source's whole backfill to now, and its answer replaces every day it
 * holds: one read's days are on one scale. 1,000 calls a day.
 */
const API = "https://openapi.naver.com/v1/datalab/search";
const DAY_MS = 86_400_000;

const headers = (call: SourceCall): Record<string, string> => ({
  "X-Naver-Client-Id": call.credential("naverClientId") ?? "",
  "X-Naver-Client-Secret": call.credential("naverClientSecret") ?? "",
  "Content-Type": "application/json",
});
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const naverDatalab: TrendsAdapter = {
  record: NAVER_DATALAB,
  counts: {
    request: ({ topic, window }, call) => {
      const keywords = [...(topic.termsByLanguage["ko"] ?? []), ...topic.terms]
        .filter((term, index, all) => all.indexOf(term) === index)
        .slice(0, 20);
      if (window.bucket !== "day" || keywords.length === 0) return [];
      const end = Date.parse(window.to) - DAY_MS;
      return [
        {
          url: API,
          method: "POST",
          headers: headers(call),
          body: JSON.stringify({
            startDate: dayOf(end - (NAVER_DATALAB.trends.backfillDays - 1) * DAY_MS),
            endDate: dayOf(end),
            timeUnit: "date",
            keywordGroups: [{ groupName: topic.label.slice(0, 50), keywords }],
          }),
          expect: "json",
        },
      ];
    },
    parse: (response, request, { window }, call) => {
      const failed = failureOf(response, call.now);
      if (failed !== undefined) return failed;
      const results = objectOf(response.body)?.["results"];
      const data = Array.isArray(results) ? objectOf(results[0])?.["data"] : undefined;
      if (!Array.isArray(data)) return drift("no results");
      const ratios = new Map<string, number>();
      for (const entry of data) {
        const day = isoOf(`${String(objectOf(entry)?.["period"] ?? "")}T00:00:00Z`);
        const ratio = numberOf(objectOf(entry)?.["ratio"]);
        if (day !== undefined && ratio !== undefined) ratios.set(day, ratio);
      }
      const asked = JSON.parse(request.body ?? "{}") as { startDate?: string };
      // Every day asked, not only the window's: the span is one scale. A day Naver leaves out is missing.
      const points = bucketsOf({ from: `${asked.startDate ?? window.from.slice(0, 10)}T00:00:00.000Z`, to: window.to, bucket: "day" }).map(
        (start): CountPoint => {
          const ratio = ratios.get(start);
          return ratio === undefined ? { start, value: 0, quality: "missing" } : { start, value: ratio, quality: "approximate" };
        },
      );
      return { kind: "ok", value: [{ metric: "ratio", points }] };
    },
  },
};
